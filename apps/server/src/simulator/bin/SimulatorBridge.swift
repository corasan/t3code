import CoreGraphics
import CoreImage
import Foundation
import IOSurface
import ImageIO

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

final class DeviceStreamer {
    private let surface: IOSurfaceRef
    private let fps: Int
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let encodingQueue = DispatchQueue(label: "t3code.simulator.encoding", qos: .userInteractive)
    private let reusableData = NSMutableData(capacity: 256 * 1024) ?? NSMutableData()
    private let jpegQuality: CGFloat = 0.4
    private var timer: DispatchSourceTimer?
    private var lastSeed: UInt32 = 0
    private var isEncoding = false

    init(surface: IOSurfaceRef, fps: Int) {
        self.surface = surface
        self.fps = max(1, fps)
    }

    func start() {
        let interval = 1.0 / Double(fps)
        let timer = DispatchSource.makeTimerSource(queue: encodingQueue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            if self.isEncoding {
                return
            }

            let currentSeed = IOSurfaceGetSeed(self.surface)
            guard currentSeed != self.lastSeed else {
                return
            }
            self.lastSeed = currentSeed
            self.isEncoding = true
            defer { self.isEncoding = false }

            guard let frame = self.encodeFrame() else {
                return
            }
            self.writeFrame(frame)
        }
        self.timer = timer
        timer.resume()
    }

    private func encodeFrame() -> Data? {
        let image = CIImage(ioSurface: surface)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
            return nil
        }

        reusableData.length = 0
        guard let destination = CGImageDestinationCreateWithData(
            reusableData as CFMutableData,
            "public.jpeg" as CFString,
            1,
            nil
        ) else {
            return nil
        }

        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: NSNumber(value: Float(jpegQuality))
        ]
        CGImageDestinationAddImage(destination, cgImage, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }

        return Data(reusableData)
    }

    private func writeFrame(_ data: Data) {
        var length = UInt32(data.count).bigEndian
        let header = withUnsafeBytes(of: &length) { Data($0) }
        FileHandle.standardOutput.write(header)
        FileHandle.standardOutput.write(data)
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

    private let coreSimulatorHandle: UnsafeMutableRawPointer?
    private let simulatorKitHandle: UnsafeMutableRawPointer?
    private let hidClientClass: AnyClass?
    private let keyboardFn: KeyboardFn?
    private let mouseFn: MouseFn?

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
    }

    func streamDevice(_ udid: String, fps: Int) throws {
        let session = try createInteractiveSession(udid: udid)
        let streamer = DeviceStreamer(surface: session.surface, fps: fps)
        streamer.start()
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

    private func sendTouch(session: InteractiveSession, x: Double, y: Double, phase: String) throws {
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
        try sendIndigoMessage(client: session.hidClient, message: message)
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

    private func sendIndigoMessage(client: AnyObject, message: UnsafeMutableRawPointer) throws {
        let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard client.responds(to: sendSelector) else {
            throw BridgeError.hidUnavailable("HID client cannot send Indigo messages on this Xcode version.")
        }

        let group = DispatchGroup()
        var completionError: NSError?
        group.enter()

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
