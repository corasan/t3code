import AppKit
import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit

struct WindowInfo: Encodable {
    let windowId: Int
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

enum BridgeError: Error {
    case usage(String)
    case simulatorWindowNotFound
    case invalidNumber(String)
    case unsupportedKey(String)
    case invalidWindowId(Int)
}

func activateSimulator() {
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first {
        app.activate(options: [])
    } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.iphonesimulator") {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
    }
    usleep(120_000)
}

func resolveSimulatorWindow() throws -> WindowInfo {
    activateSimulator()
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw BridgeError.simulatorWindowNotFound
    }

    let candidates = windowList.compactMap { entry -> (Int, CGRect)? in
        guard let ownerName = entry[kCGWindowOwnerName as String] as? String, ownerName == "Simulator" else {
            return nil
        }
        guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0 else {
            return nil
        }
        guard let windowId = entry[kCGWindowNumber as String] as? Int else {
            return nil
        }
        guard let boundsObject = entry[kCGWindowBounds as String] else {
            return nil
        }
        let bounds = CGRect(dictionaryRepresentation: boundsObject as! CFDictionary) ?? .zero
        guard bounds.width > 0, bounds.height > 0 else {
            return nil
        }
        return (windowId, bounds)
    }

    func area(for candidate: (Int, CGRect)) -> Double {
        candidate.1.width * candidate.1.height
    }

    guard let selected = candidates.max(by: { area(for: $0) < area(for: $1) }) else {
        throw BridgeError.simulatorWindowNotFound
    }

    return WindowInfo(
        windowId: selected.0,
        x: selected.1.origin.x,
        y: selected.1.origin.y,
        width: selected.1.size.width,
        height: selected.1.size.height
    )
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

func postMouseEvent(type: CGEventType, x: Double, y: Double) {
    if let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) {
        event.post(tap: .cghidEventTap)
    }
}

func click(x: Double, y: Double) {
    activateSimulator()
    postMouseEvent(type: .mouseMoved, x: x, y: y)
    usleep(10_000)
    postMouseEvent(type: .leftMouseDown, x: x, y: y)
    usleep(16_000)
    postMouseEvent(type: .leftMouseUp, x: x, y: y)
}

func drag(fromX: Double, fromY: Double, toX: Double, toY: Double) {
    activateSimulator()
    postMouseEvent(type: .mouseMoved, x: fromX, y: fromY)
    usleep(10_000)
    postMouseEvent(type: .leftMouseDown, x: fromX, y: fromY)
    let steps = 8
    for step in 1 ... steps {
        let progress = Double(step) / Double(steps)
        let x = fromX + ((toX - fromX) * progress)
        let y = fromY + ((toY - fromY) * progress)
        postMouseEvent(type: .leftMouseDragged, x: x, y: y)
        usleep(12_000)
    }
    postMouseEvent(type: .leftMouseUp, x: toX, y: toY)
}

func postUnicodeText(_ text: String) {
    activateSimulator()
    for scalar in text.unicodeScalars {
        var utf16 = Array(String(scalar).utf16)
        if let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
            keyDown.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            keyDown.post(tap: .cghidEventTap)
        }
        if let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
            keyUp.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            keyUp.post(tap: .cghidEventTap)
        }
    }
}

func keyCode(for key: String) throws -> CGKeyCode {
    switch key {
    case "Enter":
        return 36
    case "Tab":
        return 48
    case "Backspace":
        return 51
    case "Escape":
        return 53
    case "Space":
        return 49
    case "ArrowLeft":
        return 123
    case "ArrowRight":
        return 124
    case "ArrowDown":
        return 125
    case "ArrowUp":
        return 126
    case "Delete":
        return 117
    case "Home":
        return 115
    case "End":
        return 119
    default:
        throw BridgeError.unsupportedKey(key)
    }
}

func press(key: String) throws {
    activateSimulator()
    let keyCode = try keyCode(for: key)
    if let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true) {
        keyDown.post(tap: .cghidEventTap)
    }
    if let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) {
        keyUp.post(tap: .cghidEventTap)
    }
}

final class WindowFrameStreamer: NSObject, SCStreamOutput, SCStreamDelegate {
    private let windowId: Int
    private let fps: Int
    private let jpegQuality: CGFloat = 0.55
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let sampleQueue = DispatchQueue(label: "t3code.simulator.samples", qos: .userInteractive)
    private let encodingQueue = DispatchQueue(label: "t3code.simulator.encoding", qos: .userInteractive)
    private var stream: SCStream?
    private var isEncoding = false
    private let reusableData = NSMutableData(capacity: 256 * 1024) ?? NSMutableData()

    init(windowId: Int, fps: Int) {
        self.windowId = windowId
        self.fps = max(1, fps)
    }

    func start() async throws {
        let availableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = availableContent.windows.first(where: { Int($0.windowID) == windowId }) else {
            throw BridgeError.invalidWindowId(windowId)
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(window.frame.width))
        configuration.height = max(1, Int(window.frame.height))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.queueDepth = 2
        configuration.showsCursor = false
        configuration.capturesAudio = false

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("stream stopped: \(error.localizedDescription)\n".utf8))
        exit(1)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen else {
            return
        }
        guard CMSampleBufferIsValid(sampleBuffer) else {
            return
        }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let frameAttachment = attachments.first,
              let rawStatus = frameAttachment[.status] as? Int,
              let frameStatus = SCFrameStatus(rawValue: rawStatus),
              frameStatus == .complete else {
            return
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }
        if isEncoding {
            return
        }
        isEncoding = true

        encodingQueue.async { [weak self] in
            guard let self = self else { return }
            defer { self.isEncoding = false }
            guard let jpegData = self.encodeFrame(pixelBuffer: pixelBuffer) else {
                return
            }
            self.writeFrame(jpegData)
        }
    }

    private func encodeFrame(pixelBuffer: CVPixelBuffer) -> Data? {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
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

var activeStreamer: WindowFrameStreamer?

@MainActor
func runStream(windowId: Int, fps: Int) async throws {
    let streamer = WindowFrameStreamer(windowId: windowId, fps: fps)
    try await streamer.start()
    activeStreamer = streamer
}

func run() async throws -> Bool {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let command = args.first else {
        throw BridgeError.usage("missing command")
    }

    switch command {
    case "window-info":
        let window = try resolveSimulatorWindow()
        let data = try JSONEncoder().encode(window)
        FileHandle.standardOutput.write(data)
        return true
    case "click":
        guard args.count == 3 else {
            throw BridgeError.usage("click requires x and y")
        }
        click(x: try parseDouble(args[1]), y: try parseDouble(args[2]))
        return true
    case "drag":
        guard args.count == 5 else {
            throw BridgeError.usage("drag requires fromX fromY toX toY")
        }
        drag(
            fromX: try parseDouble(args[1]),
            fromY: try parseDouble(args[2]),
            toX: try parseDouble(args[3]),
            toY: try parseDouble(args[4])
        )
        return true
    case "type":
        guard args.count >= 2 else {
            throw BridgeError.usage("type requires text")
        }
        postUnicodeText(args.dropFirst().joined(separator: " "))
        return true
    case "press":
        guard args.count == 2 else {
            throw BridgeError.usage("press requires key")
        }
        try press(key: args[1])
        return true
    case "stream-window":
        guard args.count >= 2 else {
            throw BridgeError.usage("stream-window requires windowId [fps]")
        }
        let windowId = try parseInt(args[1])
        let fps = args.count >= 3 ? try parseInt(args[2]) : 15
        try await runStream(windowId: windowId, fps: fps)
        return false
    default:
        throw BridgeError.usage("unknown command \(command)")
    }
}

Task { @MainActor in
    do {
        let shouldExit = try await run()
        if shouldExit {
            exit(0)
        }
    } catch {
        let message: String
        switch error {
        case BridgeError.usage(let detail):
            message = detail
        case BridgeError.invalidNumber(let raw):
            message = "invalid number \(raw)"
        case BridgeError.unsupportedKey(let key):
            message = "unsupported key \(key)"
        case BridgeError.invalidWindowId(let windowId):
            message = "invalid window id \(windowId)"
        case BridgeError.simulatorWindowNotFound:
            message = "simulator window not found"
        default:
            message = String(describing: error)
        }
        FileHandle.standardError.write(Data(message.utf8))
        FileHandle.standardError.write(Data("\n".utf8))
        exit(1)
    }
}

RunLoop.main.run()
