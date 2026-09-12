import Foundation
import CoreML
import FluidAudio

private struct NemotronReady: Encodable {
    let type = "ready"
    let model = "nemotron-multilingual"
    let sampleRateHz = 16000
    let hotwordCount: Int
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
    await manager.setLanguage(try arguments.require("language"))
    try await emitter.write(NemotronReady(hotwordCount: words.count))
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
        let text = try await manager.process(samples: samples)
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
