import Testing
@testable import MLXAudioSTT

struct MossTranscribeDiarizeParsingTests {
    @Test
    func timestampAndSpeakerOnlyOutputProducesNoSegments() {
        let text = "[0.00][S01][0.28][0.28][S02][0.46][0.46][S03][0.64]"

        let segments = MossTranscribeDiarizeModel.parseSegments(
            text: text,
            fallbackEnd: 0.64
        )

        #expect(segments.isEmpty)
    }

    @Test
    func taggedOutputKeepsOnlySegmentsWithSpokenText() {
        let text = "[0.00][S01][0.28][0.28][S02]Hello[0.46]"

        let segments = MossTranscribeDiarizeModel.parseSegments(
            text: text,
            fallbackEnd: 0.46
        )

        #expect(segments.count == 1)
        #expect(segments[0]["text"] as? String == "[S02] Hello")
    }

    @Test
    func untaggedOutputRetainsFallbackText() {
        let segments = MossTranscribeDiarizeModel.parseSegments(
            text: "Hello",
            fallbackEnd: 1.25,
            offsetSeconds: 2
        )

        #expect(segments.count == 1)
        #expect(segments[0]["text"] as? String == "Hello")
        #expect(segments[0]["start"] as? Double == 2)
        #expect(segments[0]["end"] as? Double == 3.25)
    }
}
