// Sees the iPhone over the USB cable, for phone-usb.mjs. Nothing here synthesizes input, and nothing
// here touches the Mac's windows, pointer or focus. The phone is a capture device, not a window.
//
// A plugged-in, trusted, unlocked iPhone shows up as an AVFoundation capture device once screen
// capture devices are allowed (kCMIOHardwarePropertyAllowScreenCaptureDevices), which is the same
// path QuickTime's "Movie Recording from iPhone" uses.
//
// The phone's sound comes over the same cable, and is played on this Mac's current audio output,
// so a screen recording that takes the Mac's audio has TikTok's. While the Mac captures it, iOS
// sends its sound here rather than out of its own speaker. --no-audio leaves it unplayed.
//
// stdout, one JSON object per line:
//   {"type":"device","device":{"name","w","h"}}          attached; null when unplugged
//   {"type":"frame","t","motion","center","grid","brightness","audioDb"}   up to 20 a second;
//                                                        audioDb is the phone's sound level, dBFS
//   {"type":"screen","w","h"}                            the phone's video size, once per attach
//   {"type":"error","message"}
// File descriptor 3, when open: the phone's screen as JPEGs, each a 4-byte big-endian length then
// the JPEG.
//
// It reads nothing from stdin: swiping is phone-usb.mjs's job, over WebDriverAgent.

import AVFoundation
import AppKit
import CoreImage
import CoreMedia
import CoreMediaIO
import CoreVideo
import Foundation
import ImageIO

let gridColumns = 6
let gridRows = 12
let motionWidth = 48      // the frame is scaled to this before motion is measured
let videoHeight = 1400    // sharp at full height on a Retina screen
// Where its output goes: the pipes a child gets, or, started by LaunchServices (--socket, below),
// two connections to the bridge's socket.
var inFD: Int32 = 0       // the bridge's end closing ends this process
var outFD: Int32 = 1      // JSON lines
var videoFD: Int32 = 3    // JPEGs, each behind a 4-byte big-endian length
let framesPerSecond = 20.0

// All of `data` to `fd`, or false when the other end is gone.
@discardableResult
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
  data.withUnsafeBytes { raw -> Bool in
    var offset = 0
    while offset < raw.count {
      let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
      if n <= 0 { return false }
      offset += n
    }
    return true
  }
}

let stdoutQueue = DispatchQueue(label: "stdout")
func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
  data.append(0x0A)
  stdoutQueue.async { if !writeAll(outFD, data) { exit(0) } } // the bridge is gone
}

func uptimeMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

// iOS devices are hidden from AVFoundation until this is switched on, once per process.
func allowPhoneCapture() {
  var address = CMIOObjectPropertyAddress(
    mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
    mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
    mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var allow: UInt32 = 1
  CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil,
                            UInt32(MemoryLayout<UInt32>.size), &allow)
}

// macOS treats the phone's screen as a camera: without permission the session runs and delivers
// nothing, silently. This asks once. Where the prompt shows up and what it names depends on what
// launched the bridge; a refusal is undone in System Settings → Privacy & Security → Camera.
enum Camera {
  private static var asked = false
  private static var refusedSaid = false
  static func allowed() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      return true
    case .notDetermined:
      if !asked {
        asked = true
        emit(["type": "error", "message": "the Mac is asking for camera permission (the phone's screen counts as one): allow it"])
        AVCaptureDevice.requestAccess(for: .video) { _ in }
      }
    default:
      if !refusedSaid {
        refusedSaid = true
        emit(["type": "error", "message": "camera access is off, so the phone's screen can't be read: System Settings → Privacy & Security → Camera"])
      }
    }
    return false
  }
}

// Sound from a capture device needs the microphone permission, even when it's a phone's. Asked
// once; without it the picture still works and the sound is silent.
enum Microphone {
  private static var asked = false
  static func allowed() -> Bool {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    if status == .notDetermined && !asked {
      asked = true
      emit(["type": "error", "message": "the Mac is asking for microphone permission, for the phone's sound: allow it"])
      AVCaptureDevice.requestAccess(for: .audio) { _ in }
    }
    return status == .authorized
  }
}
let playsAudio = !CommandLine.arguments.contains("--no-audio")

// The phone, if one is plugged in. Its video is "muxed" because the cable carries sound with it.
func findPhone() -> AVCaptureDevice? {
  let types: [AVCaptureDevice.DeviceType] = [.external]
  return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .muxed, position: .unspecified)
    .devices.first
}

// Turns each frame into the motion numbers the brain eats, and a JPEG for the page.
final class Screen: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private let context = CIContext()
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  private let options: [CIImageRepresentationOption: Any] = [
    CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.75,
  ]
  private var previous: [Float] = []
  private var brightness: Float = 0
  private var lastMotionAt: Double = 0
  private let videoOpen = fcntl(videoFD, F_GETFD) != -1
  var size = (0, 0) // the phone's format says nothing about size; its first frame does
  var sound: AVCaptureConnection? // the audio's connection, for its level

  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
    let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer)
    if (w, h) != size {
      size = (w, h)
      emit(["type": "screen", "w": w, "h": h])
    }
    let image = CIImage(cvPixelBuffer: buffer)
    if videoOpen { writeJPEG(image) }
    let now = uptimeMs()
    if now - lastMotionAt >= 1000 / framesPerSecond {
      lastMotionAt = now
      measure(image)
    }
  }

  // Scaled right down: motion is about where things move, not detail.
  private func measure(_ image: CIImage) {
    let extent = image.extent
    guard extent.width > 0 else { return }
    let scale = Double(motionWidth) / Double(extent.width)
    let small = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let w = Int(small.extent.width), h = Int(small.extent.height)
    guard w > 0, h > 0 else { return }
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    pixels.withUnsafeMutableBytes { raw in
      context.render(small, toBitmap: raw.baseAddress!, rowBytes: w * 4,
                     bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .BGRA8, colorSpace: colorSpace)
    }

    var lum = [Float](repeating: 0, count: w * h)
    var total: Float = 0
    for i in 0..<(w * h) {
      let p = i * 4 // BGRA
      let v = (0.114 * Float(pixels[p]) + 0.587 * Float(pixels[p + 1]) + 0.299 * Float(pixels[p + 2])) / 255
      lum[i] = v
      total += v
    }
    brightness = total / Float(w * h)

    var motion: Float = 0
    var center: Float = 0
    var centerCount = 0
    var grid = [Float](repeating: 0, count: gridColumns * gridRows)
    var gridCount = [Int](repeating: 0, count: gridColumns * gridRows)
    if previous.count == lum.count {
      for y in 0..<h {
        let middleRow = y >= h / 4 && y < h * 3 / 4
        let cellRow = min(gridRows - 1, y * gridRows / h) * gridColumns
        for x in 0..<w {
          let d = abs(lum[y * w + x] - previous[y * w + x])
          motion += d
          if middleRow && x >= w / 4 && x < w * 3 / 4 {
            center += d
            centerCount += 1
          }
          let cell = cellRow + min(gridColumns - 1, x * gridColumns / w)
          grid[cell] += d
          gridCount[cell] += 1
        }
      }
      motion /= Float(w * h)
      if centerCount > 0 { center /= Float(centerCount) }
      for k in grid.indices where gridCount[k] > 0 { grid[k] /= Float(gridCount[k]) }
    }
    previous = lum
    var frame: [String: Any] = ["type": "frame", "t": uptimeMs(), "motion": Double(motion), "center": Double(center),
                                "grid": grid.map { Double($0) }, "brightness": Double(brightness)]
    if let channels = sound?.audioChannels, !channels.isEmpty {
      frame["audioDb"] = Double(channels.map(\.averagePowerLevel).max() ?? -160)
    }
    emit(frame)
  }

  private func writeJPEG(_ image: CIImage) {
    let extent = image.extent
    guard extent.height > 0 else { return }
    let scale = Double(videoHeight) / Double(extent.height)
    let sized = scale < 1 ? image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) : image
    guard let jpeg = context.jpegRepresentation(of: sized, colorSpace: colorSpace, options: options) else { return }
    var packet = withUnsafeBytes(of: UInt32(jpeg.count).bigEndian) { Data($0) }
    packet.append(jpeg)
    writeAll(videoFD, packet) // when the bridge is gone, its closed connection ends this process
  }
}

// Runs a capture session for as long as a phone is plugged in, and says so when one isn't.
final class Cable {
  private var session: AVCaptureSession?
  private let screen = Screen()
  private let queue = DispatchQueue(label: "frames")
  private var attached = false
  private var soundAllowedAtStart = false

  func check() {
    if let device = findPhone() {
      // Microphone permission given after the session started only reaches a new session.
      if attached && playsAudio && !soundAllowedAtStart && Microphone.allowed() { stop() }
      if !attached && Camera.allowed() { start(device) }
    } else if attached {
      stop()
    }
  }

  private func start(_ device: AVCaptureDevice) {
    let session = AVCaptureSession()
    session.sessionPreset = .high
    guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
      emit(["type": "error", "message": "the phone is plugged in but won't open: unlock it and trust this Mac"])
      return
    }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(screen, queue: queue)
    guard session.canAddOutput(output) else {
      emit(["type": "error", "message": "the phone's video can't be read"])
      return
    }
    session.addOutput(output)
    if playsAudio {
      soundAllowedAtStart = Microphone.allowed()
      let speaker = AVCaptureAudioPreviewOutput() // the Mac's current output device
      speaker.volume = 1
      if session.canAddOutput(speaker) {
        session.addOutput(speaker)
        screen.sound = speaker.connections.first
      } else {
        emit(["type": "error", "message": "the phone's sound can't be played on this Mac"])
      }
    }
    session.startRunning()
    self.session = session
    attached = true
    emit(["type": "device", "device": ["name": device.localizedName]]) // its size comes with the first frame
  }

  private func stop() {
    session?.stopRunning()
    session = nil
    attached = false
    screen.size = (0, 0)
    screen.sound = nil
    emit(["type": "device", "device": NSNull()])
  }
}

// --socket PATH: the bridge started this through LaunchServices (open -a) rather than as a child,
// because macOS grants the camera to an app it launched itself, and judges a child by whatever
// started its parent. With no pipes, the helper calls the bridge back: two connections, each
// announcing itself with one byte, "j" for JSON lines and "v" for JPEGs.
func connectToBridge(_ path: String) -> (json: Int32, video: Int32)? {
  func dial(_ tag: UInt8) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { close(fd); return nil }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in _ = memcpy(raw.baseAddress!, bytes, bytes.count) }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    var byte = tag
    guard connected == 0, write(fd, &byte, 1) == 1 else { close(fd); return nil }
    return fd
  }
  guard let json = dial(UInt8(ascii: "j")) else { return nil }
  guard let video = dial(UInt8(ascii: "v")) else { close(json); return nil }
  return (json, video)
}

signal(SIGPIPE, SIG_IGN) // a write to a gone bridge fails instead of killing this process
if let at = CommandLine.arguments.firstIndex(of: "--socket"), at + 1 < CommandLine.arguments.count {
  guard let (json, video) = connectToBridge(CommandLine.arguments[at + 1]) else {
    FileHandle.standardError.write("no bridge at \(CommandLine.arguments[at + 1])\n".data(using: .utf8)!)
    exit(2)
  }
  inFD = json
  outFD = json
  videoFD = video
}

allowPhoneCapture()
let cable = Cable()
emit(["type": "device", "device": NSNull()]) // until one turns up
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in cable.check() }
cable.check()

// Ends when the bridge closes its end.
DispatchQueue.global().async {
  var scratch = [UInt8](repeating: 0, count: 64)
  while read(inFD, &scratch, scratch.count) > 0 {}
  exit(0)
}
RunLoop.main.run()
