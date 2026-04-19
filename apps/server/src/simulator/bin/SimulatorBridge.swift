import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import VideoToolbox

enum BridgeError: Error {
    case usage(String)
    case simulatorUnavailable(String)
    case deviceNotFound(String)
    case deviceNotBooted(String)
    case deviceIONotReady(String)
    case invalidNumber(String)
    case unsupportedKey(String)
    case hidUnavailable(String)
    case sendFailed(String)
    case invalidRequest(String)
}

struct InteractiveRequest: Codable {
    let id: Int
    let kind: String
    let phase: String?
    let x: Double?
    let y: Double?
    let fromX: Double?
    let fromY: Double?
    let toX: Double?
    let toY: Double?
    let text: String?
    let key: String?
}

struct InteractiveResponse: Codable {
    let id: Int?
    let type: String
    let ok: Bool
    let error: String?
}

final class InteractiveSession {
    let device: AnyObject
    let surface: IOSurfaceRef
    let hidClient: AnyObject

    init(device: AnyObject, surface: IOSurfaceRef, hidClient: AnyObject) {
        self.device = device
        self.surface = surface
        self.hidClient = hidClient
    }
}

/// Streams the booted simulator's IOSurface framebuffer as H.264 Annex-B
/// access units over stdout. Each access unit is framed as
/// `[4 bytes big-endian length][Annex-B NAL units…]` so the server can pass
/// bytes through without re-parsing, and the browser can feed each length-
/// delimited chunk directly into a WebCodecs `VideoDecoder`.
///
/// Hardware H.264 encoding via VideoToolbox is ~1–2 orders of magnitude
/// cheaper (CPU and bandwidth) than the previous per-frame JPEG pipeline,
/// which forced a GPU→CPU readback (`CIContext.createCGImage`) plus a
/// software JPEG encode for every frame.
final class DeviceStreamer {
    private let surface: IOSurfaceRef
    private let targetFps: Int
    private let pollFps: Int
    private let captureQueue = DispatchQueue(label: "t3code.simulator.capture", qos: .userInteractive)
    private let writeQueue = DispatchQueue(label: "t3code.simulator.write", qos: .userInteractive)

    private var compressionSession: VTCompressionSession?
    private var timer: DispatchSourceTimer?
    private var lastSeed: UInt32?
    private var lastEncodeAt: CFAbsoluteTime = 0
    // Emit a keepalive frame this often when the simulator screen is static.
    // Keeps the encoded stream flowing so the Node-side stall watchdog
    // doesn't tear the session down while the user is idle.
    private let keepaliveInterval: CFAbsoluteTime = 2.0
    private var frameIndex: Int64 = 0
    private var scratchPacket = Data(capacity: 256 * 1024)

    // Stdout is a blocking pipe with a ~64 KB kernel buffer. When the Node
    // reader stalls for a tick, `FileHandle.standardOutput.write` blocks
    // and encoded frames queue up on `writeQueue` — every frame the
    // browser sees is then permanently late. The lock below guards the
    // small amount of state we need to skip non-keyframes under pressure
    // and request a fresh IDR so the decoder can resync cleanly.
    private let writeStateLock = NSLock()
    private var pendingWriteBytes = 0
    private var needsKeyframe = false
    // ~48 KB ≈ 50 ms of encoded video at 6 Mbps. Past this point dropping
    // costs the viewer nothing (the frame is already stale by the time
    // it leaves the pipe) and frees the writer to catch up.
    private let maxPendingWriteBytes = 48 * 1024

    init(surface: IOSurfaceRef, fps: Int) {
        let clamped = max(1, min(fps, 120))
        self.surface = surface
        self.targetFps = clamped
        // Poll at up to 2× the target FPS so any IOSurface seed change shows
        // up within half a frame. The seed check is cheap — skipped ticks
        // are ~free.
        self.pollFps = min(120, clamped * 2)
    }

    func start() throws {
        try createCompressionSession()

        // Emit an initial keyframe synchronously so the browser has frames
        // to decode before the simulator animates anything.
        captureQueue.async { [weak self] in
            self?.tick(force: true)
        }

        let interval = 1.0 / Double(pollFps)
        let timer = DispatchSource.makeTimerSource(queue: captureQueue)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in
            self?.tick(force: false)
        }
        self.timer = timer
        timer.resume()
    }

    // MARK: - VTCompressionSession

    private func createCompressionSession() throws {
        let width = Int32(IOSurfaceGetWidth(surface))
        let height = Int32(IOSurfaceGetHeight(surface))
        guard width > 0, height > 0 else {
            throw BridgeError.deviceIONotReady("Simulator framebuffer has zero dimensions.")
        }

        var session: VTCompressionSession?
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        // Opt into Apple's low-latency encoder (WWDC 2021, macOS 11.3+).
        // This swaps the default rate controller for one tuned for
        // real-time applications (faster rate adaptation, tighter frame-
        // time targets, no look-ahead). Combined with `RealTime = true`
        // below it is the single biggest latency lever VideoToolbox
        // exposes.
        let encoderSpecification: CFDictionary = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue
        ] as CFDictionary
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: encoderSpecification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: DeviceStreamer.encoderCallback,
            refcon: refcon,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw BridgeError.sendFailed(
                "Failed to create H.264 compression session (status \(status))."
            )
        }

        // Low-latency realtime encode, constant frame rate target, reasonable
        // bandwidth ceiling. No B-frames so each output frame is immediately
        // decodable.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_Baseline_AutoLevel
        )
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ExpectedFrameRate,
            value: targetFps as CFNumber
        )
        // ~6 Mbit/s is plenty for a phone-sized framebuffer at 60fps and
        // gives headroom for scroll-heavy screens. The browser decodes
        // entirely in hardware, so bandwidth — not quality — is the limit.
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_AverageBitRate,
            value: NSNumber(value: 6_000_000)
        )
        // Cap burst bitrate so a sudden scene change doesn't blow the pipe.
        let dataRateLimits: [NSNumber] = [NSNumber(value: 9_000_000 / 8), NSNumber(value: 1)]
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_DataRateLimits,
            value: dataRateLimits as CFArray
        )
        // Keyframe every ~2 seconds, with a hard time bound so slow-moving
        // scenes still recover from packet loss or late joiners.
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
            value: NSNumber(value: targetFps * 2)
        )
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
            value: NSNumber(value: 2.0)
        )
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.compressionSession = session
    }

    private func tick(force: Bool) {
        guard let session = compressionSession else {
            return
        }

        let currentSeed = IOSurfaceGetSeed(surface)
        let now = CFAbsoluteTimeGetCurrent()
        let seedChanged = currentSeed != lastSeed
        let keepalive = !seedChanged && now - lastEncodeAt >= keepaliveInterval
        if !force && !seedChanged && !keepalive {
            return
        }
        lastSeed = currentSeed
        lastEncodeAt = now

        var unmanagedPixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault,
            surface,
            nil,
            &unmanagedPixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer = unmanagedPixelBuffer?.takeRetainedValue()
        else {
            return
        }

        let pts = CMTime(value: frameIndex, timescale: Int32(targetFps))
        frameIndex += 1

        // Tell the encoder to emit a fresh keyframe for the forced first
        // frame, keepalive ticks, or when a previous tick dropped a delta
        // under backpressure — so the client can configure or resync its
        // decoder immediately.
        let forceKeyframe = force || keepalive || takeNeedsKeyframe()
        var frameProperties: CFDictionary?
        if forceKeyframe {
            frameProperties = [
                kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue
            ] as CFDictionary
        }

        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: frameProperties,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
    }

    // MARK: - Annex-B output

    private static let encoderCallback: VTCompressionOutputCallback = {
        outputCallbackRefCon, _, status, _, sampleBuffer in
        guard status == noErr, let sampleBuffer, let outputCallbackRefCon else {
            return
        }
        let streamer = Unmanaged<DeviceStreamer>.fromOpaque(outputCallbackRefCon).takeUnretainedValue()
        streamer.handleEncoded(sampleBuffer: sampleBuffer)
    }

    private func handleEncoded(sampleBuffer: CMSampleBuffer) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            return
        }

        let isKeyframe = Self.isKeyframe(sampleBuffer)

        // If the writer is backed up, drop delta frames on the floor rather
        // than letting them queue. Keyframes always go through — they're
        // the only thing the decoder can use to recover, and they're rare
        // enough that their size doesn't dominate.
        if !isKeyframe && isWriterBackedUp() {
            requestKeyframe()
            return
        }

        scratchPacket.removeAll(keepingCapacity: true)

        // Prepend SPS + PPS (Annex-B) on every keyframe so a mid-stream
        // subscriber can start decoding from any keyframe without needing
        // an out-of-band codec config.
        if isKeyframe,
            let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
        {
            appendParameterSets(from: formatDescription, into: &scratchPacket)
        }

        var totalLength = 0
        var rawPointer: UnsafeMutablePointer<Int8>?
        let getStatus = CMBlockBufferGetDataPointer(
            dataBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &rawPointer
        )
        guard getStatus == kCMBlockBufferNoErr, let rawPointer else {
            return
        }

        // AVCC → Annex-B conversion. AVCC uses [u32 length][NALU…] per unit;
        // Annex-B uses a 4-byte start code 0x00000001.
        let basePointer = UnsafeRawPointer(rawPointer)
        var offset = 0
        while offset + 4 <= totalLength {
            let lengthBytes = basePointer.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
            let nalLength = Int(UInt32(bigEndian: lengthBytes))
            offset += 4
            if nalLength <= 0 || offset + nalLength > totalLength {
                return
            }
            scratchPacket.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            scratchPacket.append(
                UnsafeBufferPointer<UInt8>(
                    start: basePointer.advanced(by: offset).assumingMemoryBound(to: UInt8.self),
                    count: nalLength
                )
            )
            offset += nalLength
        }

        writePacket(scratchPacket)
    }

    private func appendParameterSets(
        from formatDescription: CMFormatDescription,
        into packet: inout Data
    ) {
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            formatDescription,
            parameterSetIndex: 0,
            parameterSetPointerOut: nil,
            parameterSetSizeOut: nil,
            parameterSetCountOut: &count,
            nalUnitHeaderLengthOut: nil
        )
        for index in 0..<count {
            var parameterSetPointer: UnsafePointer<UInt8>?
            var parameterSetSize = 0
            let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: index,
                parameterSetPointerOut: &parameterSetPointer,
                parameterSetSizeOut: &parameterSetSize,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            )
            guard status == noErr, let parameterSetPointer, parameterSetSize > 0 else {
                continue
            }
            packet.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            packet.append(UnsafeBufferPointer(start: parameterSetPointer, count: parameterSetSize))
        }
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ),
            CFArrayGetCount(attachmentsArray) > 0
        else {
            return true
        }
        let dict = unsafeBitCast(
            CFArrayGetValueAtIndex(attachmentsArray, 0),
            to: CFDictionary.self
        )
        let notSync = CFDictionaryGetValue(
            dict,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
        )
        // Missing key or false → sync (keyframe).
        return notSync == nil || CFBooleanGetValue(unsafeBitCast(notSync, to: CFBoolean.self)) == false
    }

    private func writePacket(_ packet: Data) {
        if packet.isEmpty {
            return
        }
        let packetCopy = Data(packet)
        let frameBytes = packetCopy.count + 4
        addPendingWriteBytes(frameBytes)
        writeQueue.async { [weak self] in
            var length = UInt32(packetCopy.count).bigEndian
            let header = withUnsafeBytes(of: &length) { Data($0) }
            FileHandle.standardOutput.write(header)
            FileHandle.standardOutput.write(packetCopy)
            self?.addPendingWriteBytes(-frameBytes)
        }
    }

    // MARK: - Writer backpressure

    private func isWriterBackedUp() -> Bool {
        writeStateLock.lock()
        defer { writeStateLock.unlock() }
        return pendingWriteBytes > maxPendingWriteBytes
    }

    private func requestKeyframe() {
        writeStateLock.lock()
        needsKeyframe = true
        writeStateLock.unlock()
    }

    private func takeNeedsKeyframe() -> Bool {
        writeStateLock.lock()
        defer { writeStateLock.unlock() }
        let requested = needsKeyframe
        needsKeyframe = false
        return requested
    }

    private func addPendingWriteBytes(_ delta: Int) {
        writeStateLock.lock()
        pendingWriteBytes += delta
        writeStateLock.unlock()
    }
}

final class SimulatorBridge {
    static let shared = SimulatorBridge()
    private let hidCompletionQueue = DispatchQueue(label: "t3code.simulator.hid-completion")

    private typealias KeyboardFn = @convention(c) (UInt32, Int32) -> UnsafeMutableRawPointer?
    private typealias MouseFn = @convention(c) (
        UnsafeMutablePointer<CGPoint>,
        UnsafeMutablePointer<CGPoint>?,
        Int32,
        Int32,
        CGSize,
        Int32
    ) -> UnsafeMutableRawPointer?
    private typealias HardwareButtonFn = @convention(c) (Int32, Int32, Int32) -> UnsafeMutableRawPointer?

    private let coreSimulatorHandle: UnsafeMutableRawPointer?
    private let simulatorKitHandle: UnsafeMutableRawPointer?
    private let hidClientClass: AnyClass?
    private let keyboardFn: KeyboardFn?
    private let mouseFn: MouseFn?
    private let hardwareButtonFn: HardwareButtonFn?

    private init() {
        let coreSimulatorPath = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
        self.coreSimulatorHandle = dlopen(coreSimulatorPath, RTLD_NOW)

        let simulatorKitPath = "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
        self.simulatorKitHandle = dlopen(simulatorKitPath, RTLD_NOW)
        Bundle(path: "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework")?.load()

        self.hidClientClass = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient")

        if let handle = simulatorKitHandle, let ptr = dlsym(handle, "IndigoHIDMessageForKeyboardArbitrary") {
            self.keyboardFn = unsafeBitCast(ptr, to: KeyboardFn.self)
        } else {
            self.keyboardFn = nil
        }

        if let handle = simulatorKitHandle, let ptr = dlsym(handle, "IndigoHIDMessageForMouseNSEvent") {
            self.mouseFn = unsafeBitCast(ptr, to: MouseFn.self)
        } else {
            self.mouseFn = nil
        }

        if let handle = simulatorKitHandle, let ptr = dlsym(handle, "IndigoHIDMessageForButton") {
            self.hardwareButtonFn = unsafeBitCast(ptr, to: HardwareButtonFn.self)
        } else {
            self.hardwareButtonFn = nil
        }
    }

    func streamDevice(_ udid: String, fps: Int) throws {
        let session = try createInteractiveSession(udid: udid)
        let streamer = DeviceStreamer(surface: session.surface, fps: fps)
        try streamer.start()
        RunLoop.main.run()
    }

    func tap(udid: String, x: Double, y: Double) throws {
        let session = try createInteractiveSession(udid: udid)
        try tap(session: session, x: x, y: y)
    }

    func tap(session: InteractiveSession, x: Double, y: Double) throws {
        try sendTouch(session: session, x: x, y: y, phase: "began")
        usleep(16_000)
        try sendTouch(session: session, x: x, y: y, phase: "ended")
    }

    func drag(udid: String, fromX: Double, fromY: Double, toX: Double, toY: Double) throws {
        let session = try createInteractiveSession(udid: udid)
        try drag(session: session, fromX: fromX, fromY: fromY, toX: toX, toY: toY)
    }

    func drag(session: InteractiveSession, fromX: Double, fromY: Double, toX: Double, toY: Double) throws {
        try sendTouch(session: session, x: fromX, y: fromY, phase: "began")
        let steps = 10
        for step in 1 ..< steps {
            let progress = Double(step) / Double(steps)
            let x = fromX + ((toX - fromX) * progress)
            let y = fromY + ((toY - fromY) * progress)
            try sendTouch(session: session, x: x, y: y, phase: "moved")
            usleep(12_000)
        }
        try sendTouch(session: session, x: toX, y: toY, phase: "ended")
    }

    func type(udid: String, text: String) throws {
        let session = try createInteractiveSession(udid: udid)
        try type(session: session, udid: udid, text: text)
    }

    func type(session: InteractiveSession, udid: String, text: String) throws {
        try copyToSimulatorPasteboard(udid: udid, text: text)
        try sendKey(session: session, key: "Meta", isDown: true)
        try sendKey(session: session, key: "V", isDown: true)
        usleep(16_000)
        try sendKey(session: session, key: "V", isDown: false)
        try sendKey(session: session, key: "Meta", isDown: false)
    }

    func press(udid: String, key: String) throws {
        let session = try createInteractiveSession(udid: udid)
        try press(session: session, key: key)
    }

    func press(session: InteractiveSession, key: String) throws {
        try sendKey(session: session, key: key, isDown: true)
        usleep(16_000)
        try sendKey(session: session, key: key, isDown: false)
    }

    func home(udid: String) throws {
        let session = try createInteractiveSession(udid: udid)
        try home(session: session)
    }

    func home(session: InteractiveSession) throws {
        // Hardware home-button press via the same private Indigo pipeline
        // `sendKey`/`sendTouch` already use. On modern iPhone simulators
        // without a physical home button, CoreSimulator still accepts this
        // event and routes it through to SpringBoard as the Home gesture.
        // Constants mirror facebook/idb's `Indigo.h`:
        //   ButtonEventSourceHomeButton = 0x0
        //   ButtonEventTargetHardware   = 0x33
        try sendHardwareButton(session: session, keyCode: 0x0, target: 0x33)
    }

    func appSwitcher(udid: String) throws {
        let session = try createInteractiveSession(udid: udid)
        try appSwitcher(session: session)
    }

    func appSwitcher(session: InteractiveSession) throws {
        // Two home-button presses in quick succession. iOS's accessibility
        // layer recognises this as "open App Switcher" on every simulator,
        // Face-ID or Home-button, regardless of the device's physical
        // layout — the same behaviour the Simulator app exposes when the
        // user hits ⌘⇧H twice. Reliable HID call-sequencing beats trying
        // to replay the swipe-up-and-hold gesture, whose recognition
        // heuristics shift between iOS versions.
        try home(session: session)
        usleep(120_000)
        try home(session: session)
    }

    func serve(udid: String) throws {
        let session = try createInteractiveSession(udid: udid)
        try writeResponse(InteractiveResponse(id: nil, type: "ready", ok: true, error: nil))

        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                continue
            }

            do {
                let requestData = Data(line.utf8)
                let request = try JSONDecoder().decode(InteractiveRequest.self, from: requestData)
                try handle(request: request, session: session, udid: udid)
            } catch {
                let message: String
                if let bridgeError = error as? BridgeError {
                    message = describe(error: bridgeError)
                } else {
                    message = String(describing: error)
                }
                let fallbackId = (try? JSONDecoder().decode(InteractiveRequest.self, from: Data(line.utf8)).id)
                try writeResponse(InteractiveResponse(id: fallbackId, type: "response", ok: false, error: message))
            }
        }
    }

    private func createInteractiveSession(udid: String) throws -> InteractiveSession {
        let device = try bootedDevice(udid: udid)
        let surface = try waitForIOSurface(device: device)
        let hidClient = try createHIDClient(device: device)
        return InteractiveSession(device: device, surface: surface, hidClient: hidClient)
    }

    private func handle(request: InteractiveRequest, session: InteractiveSession, udid: String) throws {
        switch request.kind {
        case "tap":
            guard let x = request.x, let y = request.y else {
                throw BridgeError.invalidRequest("tap requires x and y")
            }
            try tap(session: session, x: x, y: y)
        case "drag":
            guard let fromX = request.fromX,
                  let fromY = request.fromY,
                  let toX = request.toX,
                  let toY = request.toY
            else {
                throw BridgeError.invalidRequest("drag requires fromX, fromY, toX, and toY")
            }
            try drag(session: session, fromX: fromX, fromY: fromY, toX: toX, toY: toY)
        case "pointer":
            guard let x = request.x, let y = request.y, let phase = request.phase else {
                throw BridgeError.invalidRequest("pointer requires x, y, and phase")
            }
            // Only wait for HID ack on gesture boundaries. Intermediate moves
            // are fired async so the serve loop can drain stdin at native rate.
            try sendTouch(session: session, x: x, y: y, phase: phase, awaitCompletion: phase != "moved")
        case "type":
            guard let text = request.text else {
                throw BridgeError.invalidRequest("type requires text")
            }
            try type(session: session, udid: udid, text: text)
        case "press":
            guard let key = request.key else {
                throw BridgeError.invalidRequest("press requires key")
            }
            try press(session: session, key: key)
        case "home":
            try home(session: session)
        case "appSwitcher":
            try appSwitcher(session: session)
        default:
            throw BridgeError.invalidRequest("unknown request kind \(request.kind)")
        }

        try writeResponse(InteractiveResponse(id: request.id, type: "response", ok: true, error: nil))
    }

    private func writeResponse(_ response: InteractiveResponse) throws {
        let data = try JSONEncoder().encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    private func bootedDevice(udid: String) throws -> AnyObject {
        guard coreSimulatorHandle != nil else {
            throw BridgeError.simulatorUnavailable("CoreSimulator.framework is unavailable.")
        }
        guard let deviceSet = getDefaultDeviceSet() else {
            throw BridgeError.simulatorUnavailable("Failed to access the default CoreSimulator device set.")
        }
        let devices = deviceSet.value(forKeyPath: "devices") as? [AnyObject] ?? []
        guard let device = devices.first(where: { ($0.value(forKey: "UDID") as? UUID)?.uuidString == udid }) else {
            throw BridgeError.deviceNotFound("Device not found: \(udid)")
        }
        let state = (device.value(forKey: "state") as? Int) ?? 0
        guard state == 3 else {
            throw BridgeError.deviceNotBooted("Device is not booted: \(udid)")
        }
        return device
    }

    private func getDefaultDeviceSet() -> AnyObject? {
        guard let simServiceContextClass = NSClassFromString("SimServiceContext") else {
            return nil
        }

        let sharedSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard simServiceContextClass.responds(to: sharedSel) else {
            return nil
        }

        let developerDir = "/Applications/Xcode.app/Contents/Developer"
        var error: NSError?

        typealias SharedFn = @convention(c) (AnyClass, Selector, NSString, UnsafeMutablePointer<NSError?>) -> AnyObject?
        let sharedMethod = simServiceContextClass.method(for: sharedSel)
        let sharedFn = unsafeBitCast(sharedMethod, to: SharedFn.self)
        guard let serviceContext = sharedFn(simServiceContextClass, sharedSel, developerDir as NSString, &error) else {
            return nil
        }

        let deviceSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard serviceContext.responds(to: deviceSetSel) else {
            return nil
        }

        typealias DeviceSetFn = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>) -> AnyObject?
        let deviceSetMethod = serviceContext.method(for: deviceSetSel)
        let deviceSetFn = unsafeBitCast(deviceSetMethod, to: DeviceSetFn.self)
        var deviceSetError: NSError?
        return deviceSetFn(serviceContext, deviceSetSel, &deviceSetError)
    }

    private func waitForIOSurface(device: AnyObject, timeout: TimeInterval = 10) throws -> IOSurfaceRef {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let surface = getIOSurface(for: device) {
                return surface
            }
            usleep(100_000)
        }
        throw BridgeError.deviceIONotReady("Simulator display surface is not ready yet.")
    }

    private func getIOSurface(for device: AnyObject) -> IOSurfaceRef? {
        guard let io = device.value(forKey: "io") as? AnyObject else {
            return nil
        }
        let ports = io.value(forKey: "ioPorts") as? [AnyObject] ?? []
        for port in ports {
            let descriptorSelector = NSSelectorFromString("descriptor")
            guard port.responds(to: descriptorSelector),
                  let descriptor = port.perform(descriptorSelector)?.takeUnretainedValue()
            else {
                continue
            }

            let className = String(describing: Swift.type(of: descriptor))
            guard className.contains("SimDisplayIOSurfaceRenderable") else {
                continue
            }

            let framebufferSelector = NSSelectorFromString("framebufferSurface")
            guard descriptor.responds(to: framebufferSelector),
                  let surfaceResult = descriptor.perform(framebufferSelector)
            else {
                continue
            }

            let surfaceObject = surfaceResult.takeUnretainedValue()
            let surface = unsafeBitCast(surfaceObject, to: IOSurfaceRef.self)
            if IOSurfaceGetWidth(surface) > 0 && IOSurfaceGetHeight(surface) > 0 {
                return surface
            }
        }
        return nil
    }

    private func createHIDClient(device: AnyObject) throws -> AnyObject {
        guard let hidClientClass else {
            throw BridgeError.hidUnavailable("SimDeviceLegacyHIDClient is unavailable.")
        }
        let initSelector = NSSelectorFromString("initWithDevice:error:")
        guard hidClientClass.instancesRespond(to: initSelector) else {
            throw BridgeError.hidUnavailable("SimDeviceLegacyHIDClient cannot be initialized on this Xcode version.")
        }

        let allocated = hidClientClass.alloc()
        typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>) -> AnyObject?
        let initMethod = (allocated as AnyObject).method(for: initSelector)
        let initFn = unsafeBitCast(initMethod, to: InitFn.self)
        var error: NSError?
        guard let client = initFn(allocated, initSelector, device, &error) else {
            throw BridgeError.hidUnavailable(
                "Failed to create HID client: \(error?.localizedDescription ?? "unknown error")"
            )
        }
        return client
    }

    private func sendTouch(session: InteractiveSession, x: Double, y: Double, phase: String, awaitCompletion: Bool = true) throws {
        guard let mouseFn else {
            throw BridgeError.hidUnavailable("Indigo touch injection is unavailable.")
        }
        let eventType: Int32
        switch phase {
        case "began":
            eventType = 1
        case "moved":
            eventType = 1
        case "ended":
            eventType = 2
        default:
            throw BridgeError.usage("unsupported touch phase \(phase)")
        }

        let size = CGSize(width: IOSurfaceGetWidth(session.surface), height: IOSurfaceGetHeight(session.surface))
        var point = CGPoint(x: x * size.width, y: y * size.height)
        guard let message = mouseFn(&point, nil, 0x32, eventType, size, 0) else {
            throw BridgeError.sendFailed("Failed to build a touch message for the simulator.")
        }
        try sendIndigoMessage(client: session.hidClient, message: message, awaitCompletion: awaitCompletion)
    }

    private func sendKey(udid: String, key: String, isDown: Bool) throws {
        let session = try createInteractiveSession(udid: udid)
        try sendKey(session: session, key: key, isDown: isDown)
    }

    private func sendKey(session: InteractiveSession, key: String, isDown: Bool) throws {
        guard let keyboardFn else {
            throw BridgeError.hidUnavailable("Indigo keyboard injection is unavailable.")
        }
        let keyCode = try hidUsageForKey(key)
        let op: Int32 = isDown ? 1 : 2
        guard let message = keyboardFn(keyCode, op) else {
            throw BridgeError.sendFailed("Failed to build a keyboard message for key \(key).")
        }
        try sendIndigoMessage(client: session.hidClient, message: message)
    }

    private func sendHardwareButton(session: InteractiveSession, keyCode: Int32, target: Int32) throws {
        guard let hardwareButtonFn else {
            throw BridgeError.hidUnavailable("Indigo hardware-button injection is unavailable.")
        }
        // Direction constants from facebook/idb's `Indigo.h`:
        //   ButtonEventTypeDown = 0x1, ButtonEventTypeUp = 0x2
        guard let downMessage = hardwareButtonFn(keyCode, 0x1, target) else {
            throw BridgeError.sendFailed("Failed to build a hardware-button down message.")
        }
        try sendIndigoMessage(client: session.hidClient, message: downMessage)
        usleep(50_000)
        guard let upMessage = hardwareButtonFn(keyCode, 0x2, target) else {
            throw BridgeError.sendFailed("Failed to build a hardware-button up message.")
        }
        try sendIndigoMessage(client: session.hidClient, message: upMessage)
    }

    private func sendIndigoMessage(client: AnyObject, message: UnsafeMutableRawPointer, awaitCompletion: Bool = true) throws {
        let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard client.responds(to: sendSelector) else {
            throw BridgeError.hidUnavailable("HID client cannot send Indigo messages on this Xcode version.")
        }

        typealias SendFn = @convention(c) (
            AnyObject,
            Selector,
            UnsafeMutableRawPointer,
            Bool,
            DispatchQueue,
            Any
        ) -> Void
        let method = client.method(for: sendSelector)
        let sendFn = unsafeBitCast(method, to: SendFn.self)

        // Fire-and-forget path for streaming pointer-moved samples. Awaiting
        // the HID ack on every sample caps the serve loop at the HID-ack rate,
        // which starves iOS of touch samples during a drag — iOS then reads
        // the sparse samples as high finger velocity and applies a long fling
        // momentum after the user has already released.
        if !awaitCompletion {
            let callback: @convention(block) (NSError?) -> Void = { _ in }
            sendFn(client, sendSelector, message, true, hidCompletionQueue, callback as Any)
            return
        }

        let group = DispatchGroup()
        var completionError: NSError?
        group.enter()
        let callback: @convention(block) (NSError?) -> Void = { error in
            completionError = error
            group.leave()
        }
        sendFn(client, sendSelector, message, true, hidCompletionQueue, callback as Any)

        let waitResult = group.wait(timeout: .now() + 2)
        if waitResult == .timedOut {
            throw BridgeError.sendFailed("Timed out waiting for the simulator to accept HID input.")
        }
        if let completionError {
            throw BridgeError.sendFailed(completionError.localizedDescription)
        }
    }

    private func copyToSimulatorPasteboard(udid: String, text: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl", "pbcopy", udid]
        let stdinPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardError = stderrPipe
        process.standardOutput = Pipe()

        try process.run()
        stdinPipe.fileHandleForWriting.write(Data(text.utf8))
        stdinPipe.fileHandleForWriting.closeFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw BridgeError.sendFailed(stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func hidUsageForKey(_ key: String) throws -> UInt32 {
        switch key {
        case "Meta":
            return 0xE3
        case "V":
            return 0x19
        case "Enter":
            return 0x28
        case "Tab":
            return 0x2B
        case "Backspace":
            return 0x2A
        case "Escape":
            return 0x29
        case "Delete":
            return 0x4C
        case "ArrowLeft":
            return 0x50
        case "ArrowRight":
            return 0x4F
        case "ArrowDown":
            return 0x51
        case "ArrowUp":
            return 0x52
        case "Home":
            return 0x4A
        case "End":
            return 0x4D
        default:
            throw BridgeError.unsupportedKey(key)
        }
    }
}

func parseDouble(_ value: String) throws -> Double {
    guard let parsed = Double(value) else {
        throw BridgeError.invalidNumber(value)
    }
    return parsed
}

func parseInt(_ value: String) throws -> Int {
    guard let parsed = Int(value) else {
        throw BridgeError.invalidNumber(value)
    }
    return parsed
}

func run() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let command = args.first else {
        throw BridgeError.usage("missing command")
    }

    switch command {
        case "stream-device":
            guard args.count >= 2 else {
                throw BridgeError.usage("stream-device requires udid [fps]")
        }
        let udid = args[1]
        let fps = args.count >= 3 ? try parseInt(args[2]) : 30
        try SimulatorBridge.shared.streamDevice(udid, fps: fps)
    case "tap":
        guard args.count == 4 else {
            throw BridgeError.usage("tap requires udid x y")
        }
        try SimulatorBridge.shared.tap(
            udid: args[1],
            x: parseDouble(args[2]),
            y: parseDouble(args[3])
        )
    case "drag":
        guard args.count == 6 else {
            throw BridgeError.usage("drag requires udid fromX fromY toX toY")
        }
        try SimulatorBridge.shared.drag(
            udid: args[1],
            fromX: parseDouble(args[2]),
            fromY: parseDouble(args[3]),
            toX: parseDouble(args[4]),
            toY: parseDouble(args[5])
        )
    case "type":
        guard args.count >= 3 else {
            throw BridgeError.usage("type requires udid text")
        }
        try SimulatorBridge.shared.type(udid: args[1], text: args.dropFirst(2).joined(separator: " "))
        case "press":
            guard args.count == 3 else {
                throw BridgeError.usage("press requires udid key")
            }
            try SimulatorBridge.shared.press(udid: args[1], key: args[2])
        case "home":
            guard args.count == 2 else {
                throw BridgeError.usage("home requires udid")
            }
            try SimulatorBridge.shared.home(udid: args[1])
        case "app-switcher":
            guard args.count == 2 else {
                throw BridgeError.usage("app-switcher requires udid")
            }
            try SimulatorBridge.shared.appSwitcher(udid: args[1])
        case "serve":
            guard args.count == 2 else {
                throw BridgeError.usage("serve requires udid")
            }
            try SimulatorBridge.shared.serve(udid: args[1])
        default:
            throw BridgeError.usage("unknown command \(command)")
        }
    }

do {
    try run()
    exit(0)
} catch {
    let message: String
    switch error {
    case BridgeError.usage(let detail):
        message = detail
    case BridgeError.simulatorUnavailable(let detail),
         BridgeError.deviceNotFound(let detail),
         BridgeError.deviceNotBooted(let detail),
         BridgeError.deviceIONotReady(let detail),
         BridgeError.hidUnavailable(let detail),
         BridgeError.sendFailed(let detail),
         BridgeError.invalidRequest(let detail):
        message = detail
    case BridgeError.invalidNumber(let raw):
        message = "invalid number \(raw)"
    case BridgeError.unsupportedKey(let key):
        message = "unsupported key \(key)"
    default:
        message = String(describing: error)
    }
    FileHandle.standardError.write(Data(message.utf8))
    FileHandle.standardError.write(Data("\n".utf8))
    exit(1)
}

func describe(error: BridgeError) -> String {
    switch error {
    case .usage(let detail),
         .simulatorUnavailable(let detail),
         .deviceNotFound(let detail),
         .deviceNotBooted(let detail),
         .deviceIONotReady(let detail),
         .hidUnavailable(let detail),
         .sendFailed(let detail),
         .invalidRequest(let detail):
        return detail
    case .invalidNumber(let raw):
        return "invalid number \(raw)"
    case .unsupportedKey(let key):
        return "unsupported key \(key)"
    }
}
