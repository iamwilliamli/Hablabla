# Medical hotwords

A local, dependency-free vocabulary helper for the existing Nemotron and MOSS
`hotwords` fields. Import `getMedicalHotwords` from `src/medical-hotwords.ts`;
no server configuration or native rebuild is needed to use the helper in a
request builder. It does not automatically enable hotwords for existing requests.

## Backend usage

From another TypeScript module in `apps/speech-gateway/src/`:

```ts
import { getMedicalHotwords } from "./medical-hotwords.js";

const hotwords = getMedicalHotwords(); // English general medicine, ready to send.

const cardiologyHotwords = getMedicalHotwords({
  language: "en", // "zh" selects Simplified Chinese; default is "en".
  specialties: ["cardiology"],
  customTerms: ["ECG", "HbA1c"],
  limit: 64,
});
```

For Nemotron, include the returned array in the existing
`POST /v1/nemotron/sessions` JSON body:

```ts
const body = {
  origin: "http://localhost:3100", // Use the actual allowed browser origin.
  language: "en",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
  hotwords: cardiologyHotwords,
};
```

For MOSS, serialize the array into the existing multipart upload:

```ts
form.set("hotwords", JSON.stringify(cardiologyHotwords));
```

Keep the endpoint's other required fields and authentication as described in
[the speech API contract](../../dev-docs/speech-api-frontend.md). Parakeet does
not implement this hotword contract. The word-list language does not configure
the recognition model: set the request's `language` separately.

Export a plain JSON array from the repository root for any backend language:

```bash
node --import tsx --input-type=module -e 'import { getMedicalHotwords } from "./apps/speech-gateway/src/medical-hotwords.ts"; console.log(JSON.stringify(getMedicalHotwords({language:"en",specialties:["cardiology"]}), null, 2))' > medical-hotwords.en.json
```

The full editable catalog is [data/medical-hotwords.json](data/medical-hotwords.json).
Each `languages[language][category]` value is also a plain string array suitable
for direct loading in Python, Swift, or Node. Include this data file alongside
the helper when copying or packaging the module; its location is resolved
relative to the module, not the working directory.

## Selection and limits

Available specialties: `cardiology`, `respiratory`, `endocrinology`, `neurology`,
`gastroenterology`, `renal`, `musculoskeletal`, and `mental_health`.
The `general` vocabulary is appended automatically, including common symptoms,
tests, and generic medication names. No specialty means general vocabulary only.

Custom terms take precedence, followed by interleaved specialty terms in the
requested specialty order, then general terms. Duplicate specialties are ignored.
Terms are trimmed, NFC-normalized, and deduplicated without case sensitivity.
The result is a fresh array of at most `limit` terms (default 64), each within
the gateway's 80-character limit. Built-in overflow is intentionally omitted;
select fewer specialties for more complete coverage. Custom arrays over 64,
empty/oversized custom terms, unsupported options, and custom terms exceeding
the selected budget produce errors. Custom terms are never silently truncated.

## Scope and verification

This is an original, manually curated starter vocabulary, version 1.0.0. It is
not imported from SNOMED CT, UMLS, or a drug database, and is not an exhaustive
or clinically validated terminology set. English and Chinese lists are
independent spelling hints, not aligned translations. Abbreviations and regional
spellings can be added per session through `customTerms`.

The helper only selects hints; it never rewrites recognized words, expands
ambiguous abbreviations, or changes dosages or negation. Nemotron requires
logits-capable decoder assets for biasing; MOSS receives hints through its prompt.
Recognition improvement must be measured on representative audio with and
without the same selected list. Automated tests establish list validity,
selection behavior, and request-limit compatibility, not clinical accuracy.

Run `npm test --workspace speech-gateway` and `npm run typecheck` from the root.
