@preconcurrency import AVFoundation
import Darwin
import FluidAudio
import Foundation
import MLX
import MLXAudioCore
import MLXAudioSTT

private struct Arguments {
    let command: String
    let values: [String: String]

    init(_ raw: [String]) throws {
        guard let command = raw.first else { throw WorkerError.usage }
        self.command = command
        var values: [String: String] = [:]
        var index = 1
        while index < raw.count {
            let key = raw[index]
            guard key.hasPrefix("--"), index + 1 < raw.count else {
                throw WorkerError.usage
            }
            values[String(key.dropFirst(2))] = raw[index + 1]
            index += 2
        }
        self.values = values
    }

    func require(_ key: String) throws -> String {
        guard let value = values[key], !value.isEmpty else {
            throw WorkerError.missingArgument(key)
        }
        return value
    }
}

private enum WorkerError: LocalizedError {
    case usage
    case missingArgument(String)
    case unsupportedStreamFormat
    case oddPCMByteCount
    case emptyAudio
    case missingResult

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Use parakeet-stream or moss-offline with the documented arguments."
        case .missingArgument(let value):
            return "Missing --\(value)."
        case .unsupportedStreamFormat:
            return "Parakeet streaming requires 16000 Hz pcm_s16le audio."
        case .oddPCMByteCount:
            return "The PCM stream ended between Int16 samples."
        case .emptyAudio:
            return "The audio input is empty."
        case .missingResult:
            return "The model completed without a transcription result."
        }
    }
}

private actor JSONLineEmitter {
    private let encoder = JSONEncoder()

    func write<T: Encodable>(_ value: T) throws {
        var data = try encoder.encode(value)
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }
}

private actor RevisionCounter {
    private var value = 0

    func next() -> Int {
        value += 1
        return value
    }
}

private struct ProgressEvent: Encodable {
    let type = "progress"
    let progress: Double
    let stage: String
}

private struct ReadyEvent: Encodable {
    let type = "ready"
    let model = "parakeet-tdt-0.6b-v3"
    let sampleRateHz = 16_000
}

private struct StreamTranscriptEvent: Encodable {
    let type = "transcript"
    let revision: Int
    let confirmedText: String
    let volatileText: String
    let audioEndMs: Int
    let isFinal: Bool
}

private struct OfflineSegment: Encodable {
    let id: String
    let startMs: Int
    let endMs: Int
    let speakerId: String?
    let text: String
}

private struct OfflineResult: Encodable {
    let model: String
    let language: String?
    let durationMs: Int
    let text: String
    let segments: [OfflineSegment]
}

private struct ResultEvent: Encodable {
    let type = "result"
    let result: OfflineResult
}

private func pcmBuffer(fromPCM16LE data: Data) throws -> AVAudioPCMBuffer {
    guard data.count.isMultiple(of: 2) else { throw WorkerError.oddPCMByteCount }
    let sampleCount = data.count / 2
    guard sampleCount > 0,
          let format = AVAudioFormat(
              commonFormat: .pcmFormatFloat32,
              sampleRate: 16_000,
              channels: 1,
              interleaved: false
          ),
          let buffer = AVAudioPCMBuffer(
              pcmFormat: format,
              frameCapacity: AVAudioFrameCount(sampleCount)
          ),
          let destination = buffer.floatChannelData?[0]
    else { throw WorkerError.emptyAudio }

    buffer.frameLength = AVAudioFrameCount(sampleCount)
    data.withUnsafeBytes { bytes in
        for index in 0..<sampleCount {
            let low = UInt16(bytes[index * 2])
            let high = UInt16(bytes[index * 2 + 1]) << 8
            destination[index] = Float(Int16(bitPattern: low | high)) / 32_768
        }
    }
    return buffer
}

private func runParakeet(arguments: Arguments, emitter: JSONLineEmitter) async throws {
    let sampleRate = try Int(arguments.require("sample-rate"))
    let encoding = try arguments.require("encoding")
    let languageCode = try arguments.require("language")
    guard sampleRate == 16_000, encoding == "pcm_s16le" else {
        throw WorkerError.unsupportedStreamFormat
    }

    try await emitter.write(ProgressEvent(progress: 0.01, stage: "loading-model"))
    let language = Language(rawValue: languageCode.split(separator: "-").first.map(String.init) ?? languageCode)
    let manager = SlidingWindowAsrManager(
        config: SlidingWindowAsrConfig.streaming.applying(language: language)
    )
    let models: AsrModels
    if let modelDirectory = arguments.values["model-directory"] {
        models = try await AsrModels.load(
            from: URL(fileURLWithPath: modelDirectory),
            version: .v3
        )
    } else {
        models = try await AsrModels.downloadAndLoad(version: .v3)
    }
    try await manager.loadModels(models)
    try await manager.startStreaming(source: .microphone)
    try await emitter.write(ReadyEvent())

    let revisions = RevisionCounter()
    let updateTask = Task {
        for await update in await manager.transcriptionUpdates {
            if Task.isCancelled { break }
            let revision = await revisions.next()
            let confirmed = await manager.confirmedTranscript
            let volatile = await manager.volatileTranscript
            let audioEnd = Int(
                ((update.tokenTimings.last?.endTime ?? 0) * 1_000).rounded()
            )
            try await emitter.write(
                StreamTranscriptEvent(
                    revision: revision,
                    confirmedText: confirmed,
                    volatileText: volatile,
                    audioEndMs: audioEnd,
                    isFinal: false
                )
            )
        }
    }

    var trailingByte: UInt8?
    var totalSamples = 0
    while true {
        let incoming = FileHandle.standardInput.availableData
        if incoming.isEmpty { break }
        var data = Data()
        if let byte = trailingByte {
            data.append(byte)
            trailingByte = nil
        }
        data.append(incoming)
        if !data.count.isMultiple(of: 2) {
            trailingByte = data.removeLast()
        }
        if !data.isEmpty {
            totalSamples += data.count / 2
            await manager.streamAudio(try pcmBuffer(fromPCM16LE: data))
        }
    }
    guard trailingByte == nil else { throw WorkerError.oddPCMByteCount }
    let finalText = try await manager.finish()
    updateTask.cancel()
    _ = await updateTask.result
    let revision = await revisions.next()
    try await emitter.write(
        StreamTranscriptEvent(
            revision: revision,
            confirmedText: finalText,
            volatileText: "",
            audioEndMs: Int((Double(totalSamples) / 16_000 * 1_000).rounded()),
            isFinal: true
        )
    )
    await manager.cleanup()
}

private func number(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
}

private func stripSpeakerPrefix(_ text: String) -> String {
    text.replacingOccurrences(
        of: #"^\s*\[S\d+\]\s*"#,
        with: "",
        options: [.regularExpression, .caseInsensitive]
    ).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func runMOSS(arguments: Arguments, emitter: JSONLineEmitter) async throws {
    let input = URL(fileURLWithPath: try arguments.require("input"))
    _ = try arguments.require("language")
    let hotwordsData = Data(try arguments.require("hotwords-json").utf8)
    let hotwords = try JSONDecoder().decode([String].self, from: hotwordsData)
    try await emitter.write(ProgressEvent(progress: 0.02, stage: "decoding-audio"))
    let (_, audio) = try loadAudioArray(from: input, sampleRate: 16_000)
    let sampleCount = audio.size
    guard sampleCount > 0 else { throw WorkerError.emptyAudio }

    try await emitter.write(ProgressEvent(progress: 0.08, stage: "loading-model"))
    let model: MossTranscribeDiarizeModel
    if let modelDirectory = arguments.values["model-directory"] {
        model = try await MossTranscribeDiarizeModel.fromModelDirectory(
            URL(fileURLWithPath: modelDirectory)
        )
    } else {
        model = try await MossTranscribeDiarizeModel.fromPretrained(
            "vanch007/mlx-MOSS-Transcribe-Diarize-4bit"
        )
    }
    try await emitter.write(ProgressEvent(progress: 0.20, stage: "transcribing"))
    let prompt = hotwords.isEmpty
        ? nil
        : "Transcribe with timestamps and speaker IDs. Hotwords: " + hotwords.joined(separator: ", ")
    let output = model.generate(
        audio: audio,
        maxTokens: 4_096,
        temperature: 0,
        chunkDuration: 180,
        minChunkDuration: 0,
        repetitionPenalty: 1,
        repetitionContextSize: 100,
        prompt: prompt
    )

    let durationMs = Int((Double(sampleCount) / 16_000 * 1_000).rounded())
    let segments = (output.segments ?? []).enumerated().compactMap { index, item -> OfflineSegment? in
        guard let start = number(item["start"]) else { return nil }
        let end = number(item["end"]) ?? start
        let rawText = item["text"] as? String ?? ""
        let text = stripSpeakerPrefix(rawText)
        guard !text.isEmpty else { return nil }
        return OfflineSegment(
            id: String(format: "segment_%03d", index + 1),
            startMs: max(0, Int((start * 1_000).rounded())),
            endMs: max(0, Int((end * 1_000).rounded())),
            speakerId: item["speaker_id"] as? String,
            text: text
        )
    }
    let plainText = segments.isEmpty
        ? output.text.trimmingCharacters(in: .whitespacesAndNewlines)
        : segments.map(\.text).joined(separator: " ")
    guard !plainText.isEmpty else { throw WorkerError.missingResult }
    try await emitter.write(ProgressEvent(progress: 1, stage: "completed"))
    try await emitter.write(
        ResultEvent(
            result: OfflineResult(
                model: "vanch007/mlx-MOSS-Transcribe-Diarize-4bit",
                language: output.language,
                durationMs: durationMs,
                text: plainText,
                segments: segments
            )
        )
    )
}

@main
private enum HablablaModelWorker {
    static func main() async {
        do {
            let arguments = try Arguments(Array(CommandLine.arguments.dropFirst()))
            let emitter = JSONLineEmitter()
            switch arguments.command {
            case "parakeet-stream":
                try await runParakeet(arguments: arguments, emitter: emitter)
            case "moss-offline":
                try await runMOSS(arguments: arguments, emitter: emitter)
            default:
                throw WorkerError.usage
            }
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
