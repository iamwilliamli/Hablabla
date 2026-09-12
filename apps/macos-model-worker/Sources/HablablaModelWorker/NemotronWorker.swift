import Foundation
import CoreML
import FluidAudio

private struct NemotronReady: Encodable {
    let type = "ready"
    let model = "nemotron-3.5-asr-streaming-multilingual-0.6b"
    let sampleRateHz = 16000
    let chunkMs: Int
    let hotwordCount: Int
}

private struct NemotronModelMetadata: Decodable {
    let model: String
    let vocab_size: Int
    let chunk_mel_frames: Int
    let sample_rate: Int
}

private struct NemotronLoadProgress: Encodable {
    let type = "progress"
    let progress = 0.01
    let stage = "loading-nemotron-3.5-model"
}

private struct NemotronInputError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func runNemotron(arguments: Arguments, emitter: JSONLineEmitter) async throws {
    guard try arguments.require("sample-rate") == "16000",
          try arguments.require("encoding") == "pcm_s16le" else {
        throw WorkerError.unsupportedStreamFormat
    }
    let directory = URL(fileURLWithPath: try arguments.require("model-directory"))
    let metadata = try JSONDecoder().decode(NemotronModelMetadata.self,
        from: Data(contentsOf: directory.appendingPathComponent("metadata.json")))
    guard metadata.model == "nvidia/nemotron-3.5-asr-streaming-0.6b",
          metadata.vocab_size == 13087, metadata.sample_rate == 16000 else {
        throw NemotronInputError(message: "Use Nemotron 3.5 ASR with the full multilingual vocabulary; English-only and Latin-pruned assets are not accepted.")
    }
    try await emitter.write(NemotronLoadProgress())
    let words = try JSONDecoder().decode(
        [String].self, from: Data(try arguments.require("hotwords-json").utf8)
    )
    guard words.count <= 64, words.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 80 }) else {
        throw NemotronInputError(message: "Invalid hotwords: maximum 64 non-empty terms of 80 characters.")
    }
    // Validate a usable logits path before advertising readiness: upstream logs
    // and disables biasing if only an argmax decoder is present.
    if !words.isEmpty {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        func load(_ name: String) async throws -> MLModel? {
            let compiled = directory.appendingPathComponent("\(name).mlmodelc")
            let package = directory.appendingPathComponent("\(name).mlpackage")
            let url: URL
            if FileManager.default.fileExists(atPath: compiled.path) { url = compiled }
            else if FileManager.default.fileExists(atPath: package.path) {
                url = try await MLModel.compileModel(at: package)
            } else { return nil }
            return try await MLModel.load(contentsOf: url, configuration: configuration)
        }
        let fused = try await load("decoder_joint")
        if fused == nil {
            // A bare decoder/joint pair also exposes logits. Require this
            // conservative path when B1 is absent instead of accepting B2-only.
            let decoder = try await load("decoder")
            let joint = try await load("joint")
            guard decoder != nil && joint != nil else {
                throw NemotronInputError(message: "Hotwords require decoder_joint or a decoder/joint pair; argmax-only assets cannot apply biasing.")
            }
        }
    }
    let manager = StreamingNemotronMultilingualAsrManager()
    await manager.setCustomVocabulary(words.map { CustomVocabularyTerm(text: $0) })
    try await manager.loadModels(from: directory)
    let language = try arguments.require("language")
    let languageAliases = ["zh": "zh-CN", "ja": "ja-JP", "en": "en-US", "es": "es-ES", "fr": "fr-FR", "de": "de-DE"]
    await manager.setLanguage(languageAliases[language] ?? language)
    try await emitter.write(NemotronReady(chunkMs: metadata.chunk_mel_frames * 10, hotwordCount: words.count))
    var pending = Data()
    var totalSamples = 0
    var revision = 0
    var lastText = ""
    while true {
        let bytes = FileHandle.standardInput.availableData
        if bytes.isEmpty { break }
        pending.append(bytes)
        let count = pending.count / 2
        if count == 0 { continue }
        let samples: [Float] = (0..<count).map { index in
            let offset = pending.startIndex + index * 2
            let bits = UInt16(pending[offset]) | (UInt16(pending[offset + 1]) << 8)
            return Float(Int16(bitPattern: bits)) / 32768
        }
        pending.removeFirst(count * 2)
        totalSamples += count
        // FluidAudio delivers partial text separately; process(samples:) returns "".
        _ = try await manager.process(samples: samples)
        let text = await manager.getPartialTranscript()
        if text != lastText {
            revision += 1
            lastText = text
            try await emitter.write(StreamTranscriptEvent(
                revision: revision, confirmedText: "", volatileText: text,
                audioEndMs: totalSamples * 1000 / 16000, isFinal: false
            ))
        }
    }
    guard pending.isEmpty else { throw WorkerError.oddPCMByteCount }
    let final = try await manager.finish()
    revision += 1
    try await emitter.write(StreamTranscriptEvent(
        revision: revision, confirmedText: final, volatileText: "",
        audioEndMs: totalSamples * 1000 / 16000, isFinal: true
    ))
}
