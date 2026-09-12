# Research Agent (Exa) — API Contract and Integration Handoff

Updated: September 12, 2026. Backend research module for clinician evidence review. This document is the integration contract for frontend owners; the module owner does not modify meeting pages, styles, provider wiring, speech services, or the companion.

**What it is:** an approval-gated, bounded public-web research pipeline with an optional transcript scan in front of it. On an explicit click, a small OpenAI model (`gpt-5.4-mini` by default) reads the meeting transcript and reports whether medical topics were discussed, each with a verbatim quote, plus population-level research questions. The clinician picks or edits a question; the server prepares an exact plan (the verbatim outbound queries and every disclosure); a human approves that plan; only then does the server search Exa, de-duplicate and label sources, optionally synthesize findings, and validate every citation against retrieved passages.

**What it is not:** a systematic review, a diagnostic tool, a patient-messaging channel, or a general search proxy. The transcript goes only to the scan model, only when the user clicks, and never to Exa. Audio, snapshots, and records are never accepted. Instructions found inside transcripts or retrieved pages are never followed.

**UI:** the visit workspace at `/` (upstream `ff5bae2` clinical transcription workflow: upload / live captions → editable transcript) has a **Research** tab (`apps/web/src/components/research-panel.tsx`) implementing scan → question → plan approval → brief. A fictional consultation sample meeting (`MTG-consult`) is included for demonstration.

## 1. Endpoint summary

Route: `/api/research` on the local web server (`http://127.0.0.1:3100`). Same guard model as `/api/followups`: loopback Host only; POST requires an exactly matching same-origin `Origin`, `Content-Type: application/json`, and the `web-research-session` HttpOnly cookie that an initial GET sets (`Path=/api/research`, `SameSite=Strict`, 24 h). All responses are `Cache-Control: no-store`. This is a separate authorization boundary from the inherited `/api/search` voice proxy, which is unchanged.

| Method | Parameters | Result |
| --- | --- | --- |
| GET | none | `{status:"ready", search:{provider,searchType,configured}, synthesis:{provider,model?,configured}, budget, searchBudget:{maxSearches,windowMs,remaining}}` and sets the session cookie on first contact. No external call. |
| GET | `?requestId=<uuid>` | `ResearchRecordView` for a request owned by this session; 404 for unknown IDs **and** for other sessions' IDs (indistinguishable by design). |
| POST | `{operation:"prepare", input:{question, jurisdiction?, dateRange?}}` | `{plan: ResearchPlan}`; status `awaiting_approval`. No external call. |
| POST | `{operation:"approve", requestId, planHash}` | `202` with `ResearchRecordView` (`status:"running"`). Starts research in the background. |
| POST | `{operation:"decline", requestId}` | `ResearchRecordView` with `status:"declined"`. Nothing is sent. |
| POST | `{operation:"cancel", requestId}` | Aborts a running request and returns the `cancelled` view once it settles. |
| POST | `{operation:"detect", input:{meetingId, transcript}}` | `{detection: MedicalDetection}`. **Sends the transcript (first 16 000 characters) to OpenAI.** Synchronous; 30 s deadline; nothing stored server-side. Only the UI's explicit "Scan transcript" button calls it. |

Errors use `{error: string, code: string}` with browser-safe text; provider messages are never forwarded.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Body/field validation failed (question 12–600 chars after trim, jurisdiction 2–80, `YYYY-MM-DD` dates with `from <= to`; extra fields rejected). Nothing was sent. |
| 403 | — | Non-loopback host, cross-origin/non-JSON POST, or missing session cookie. |
| 404 | `not_found` | Unknown request ID or a different session's request. |
| 409 | `plan_mismatch` | `planHash` does not equal the stored plan's hash. Re-read the plan or prepare a new one. |
| 409 | `already_decided` | Approval/decline replayed, or the request already ran. |
| 409 | `not_running` | Cancel on a request that is not running. |
| 410 | `expired` | Plan was not approved within `RESEARCH_PLAN_TTL` (10 min). |
| 413 | — | Body over 120 000 bytes (transcripts are capped at 50 000 characters by the contract). |
| 429 | `budget_exhausted` / `too_many_requests` | Rolling server search budget (60/h) or scan budget (30/h) spent, or too many open requests in this session (5) / process (200). |
| 503 | `search_unconfigured` | No `EXA_API_KEY`; approval refused, nothing sent. |
| 503 | `detection_unconfigured` | No `OPENAI_API_KEY`; scan refused, nothing sent. |
| 502 | `detection_failed` | Scan model error, malformed output, or deadline. Nothing kept. |
| 500 | `internal` | Unexpected failure; no detail exposed. |

## 2. Lifecycle

```text
prepare ──▶ awaiting_approval ──decline──▶ declined
                 │  └──(10 min)──▶ expired
              approve (same session, same planHash, once)
                 ▼
              running ──cancel / deadline──▶ cancelled (brief.error.code = cancelled | timeout)
                 │
                 ├──▶ completed     findings verified against passages
                 ├──▶ sources_only  no synthesis configured, no citable content, malformed/failed synthesis, or no relevant sources
                 └──▶ failed        provider unconfigured / unauthorized / credits / rate limit before any result
```

Poll `GET ?requestId=` about once per second while `running`. Views of finished requests remain readable for 30 minutes (`RESEARCH_RESULT_TTL`), then disappear (404). All state is in process memory; a server restart forgets plans and briefs.

## 3. Contract types

Import browser-safe Zod schemas and types from `agent-core/research-contract` (no Node imports). Server code imports the service from `agent-core/research`.

### `ResearchQuestionInput`

```ts
{ question: string; jurisdiction?: string; dateRange?: { from?: "YYYY-MM-DD"; to?: "YYYY-MM-DD" } }
```

Jurisdictions `UK`, `United Kingdom`, `England`, `US`, `USA`, `United States`, `Canada`, `Australia`, `EU`, `Europe` add jurisdiction-specific guideline domains to query 2; any other string is included as text only.

### `ResearchPlan` (returned by `prepare`)

| Field | Content |
| --- | --- |
| `requestId`, `status`, `createdAt`, `expiresAt` | UUID; always `awaiting_approval`; approval window. |
| `question`, `jurisdiction?`, `dateRange?` | Echo of the reviewed input. |
| `queries[]` | Exactly what will be sent: `{id, text, purpose, includeDomains?, startPublishedDate?, endPublishedDate?}`. Default three: unrestricted; guideline bodies (WHO, NICE, CDC, NIH, Cochrane + jurisdiction); indexed journals (PubMed/NCBI, Cochrane Library, Lancet, NEJM, BMJ, JAMA). Up to five with `RESEARCH_MAX_QUERIES`. |
| `budget` | `{maxQueries, maxResultsPerQuery, maxSources, maxPassageCharacters, deadlineMs}`. |
| `searchProvider` | `{provider:"exa", searchType, configured}`. Deep Exa profiles are refused (they run Exa's own synthesis). |
| `synthesis` | `{provider:"none"|"openai", model?, dataSent[], configured}` — the only synthesis provider that can run, disclosed before approval. |
| `disclosures[]` | Plain-language statements the reviewer must read (what is sent, where, what is not, no diagnosis, untrusted pages). |
| `privacyReview` | `{requiresHumanReview:true, flags[]}`. Flags are heuristics (ages, dates, long numbers, "my patient", titles+names, links, long questions). **No flags does not mean anonymous**; the reviewer decides. |
| `planHash` | SHA-256 over request ID, question, jurisdiction, date range, queries, budget, and provider disclosures. Approval must echo it; any change needs a new `prepare`. |

**UI requirement:** show `queries[].text` and `disclosures` verbatim before the approve control. Do not auto-approve.

### `EvidenceBrief` (in `ResearchRecordView.brief` once settled)

| Field | Content |
| --- | --- |
| `requestId`, `status`, `question`, `jurisdiction?`, `dateRange?`, `researchedAt` | Identity and timestamp of the run. |
| `executedQueries[]` | `{queryId, text, provider, status: ok|failed|skipped, resultCount, errorCode?, providerRequestId?}`. |
| `scope` | `{description, isSystematicReview:false, searchProvider, budget, discardedLowRelevance, duplicatesMerged}`. |
| `sources[]` | See below. Ordered by relevance. |
| `findings[]` | `{id, kind: retrieved_fact|interpretation, claim, citations[{sourceId, passageId, quote}], confidence}`. Every citation was verified: IDs exist, `quote` is a verbatim span of that passage, and the claim shares content terms with the quote. Findings that failed are dropped and counted in `synthesis.rejectedFindings`. |
| `conflictingFindings[]` | `{description, sourceIds[]}` from synthesis, filtered to known source IDs. |
| `unansweredQuestions[]`, `uncertainties[]` | From synthesis (`uncertainties` are the model's stated limitations). |
| `limitations[]` | Always includes: bounded search is not a systematic review; source types are heuristic; passages are excerpts. Adds abstract-only, missing content, unknown dates, preprints, and synthesis-unavailable notes when applicable. |
| `synthesis` | `{provider, model?, status: completed|unavailable|failed|rejected, note, rejectedFindings}`. |
| `warnings[]` | Partial retrieval, early stop, rejected findings. |
| `error?` | `{code, message}` on `failed`/`cancelled`. |

### `MedicalDetection` (returned by `detect`)

| Field | Content |
| --- | --- |
| `meetingId`, `detectedAt`, `detector:{provider,model}` | Identity of the scan. |
| `scannedCharacters`, `truncated` | How much of the transcript was sent (cap 16 000 characters). |
| `medicalContentDetected`, `confidence`, `summary` | Verdict. A positive verdict with no verifiable evidence is reported as `false` with a warning. |
| `topics[]` | `{topic, category: symptom|condition|medication|treatment|test|lifestyle|other, evidence}`; `evidence` was verified as a verbatim transcript span. Unverifiable topics are dropped and counted in `rejectedTopics`. |
| `suggestedQuestions[]` | `{question, rationale, privacyFlags[]}` — population-level questions that fit the research input contract; flagged when they look person-specific. |
| `warnings[]` | Dropped topics, truncation, flagged questions. |

### `EvidenceSource`

| Field | Content |
| --- | --- |
| `id`, `url`, `duplicateUrls[]`, `title`, `domain` | Canonical URL (tracking params, fragments, `www.`, trailing slash removed); merged variants listed. |
| `publishedDate`, `publishedDateBasis` | Provider metadata or `null` + `"unknown"`. Never inferred. |
| `retrievedAt` | Run timestamp. |
| `sourceType`, `sourceTypeBasis:"heuristic"` | `guideline`, `systematic_review`, `randomized_trial`, `observational_study`, `preprint`, `commentary`, `other`, `unknown` from title/URL/text patterns. A guideline-body domain alone does not upgrade a blog post; commentary patterns win over domain. |
| `publicationStatus` | `unverified` or `preprint_unverified`. Peer-review status is never claimed. |
| `access` | `{contentKind: text_excerpt|abstract|highlights_only|none, characters, limitation}`. PubMed pages and short texts are labelled `abstract`. |
| `relevance` | `{score 0–1, basis:"question_term_overlap", queryIds[]}`; sources under 0.1 are discarded and counted. |
| `passages[]` | `{id, kind: highlight|text_excerpt, text}` — up to three provider highlights plus one bounded text excerpt. These are the only material findings may cite. |
| `warnings[]` | Set when the page contains instruction-like text (prompt injection). The text was treated as data; nothing was executed. |

**UI requirement:** render `sourceType` with "heuristic" wording, show `access.limitation`, show "date unknown" when `publishedDate` is null, and keep `kind: interpretation` visually distinct from `retrieved_fact`.

## 4. Configuration (server `.env`, never in the browser)

| Variable | Default | Notes |
| --- | --- | --- |
| `EXA_API_KEY` | — | Required for approval; `prepare` works without it and reports `searchProvider.configured:false`. |
| `RESEARCH_EXA_SEARCH_TYPE` | `auto` | One of `instant`, `fast`, `auto`, `keyword`, `neural`, `hybrid`. Deep profiles fall back to `auto`. Independent of the voice proxy's `EXA_SEARCH_TYPE`. |
| `RESEARCH_SYNTHESIS_PROVIDER` | unset (= none) | Set `openai` to enable findings. Requires `OPENAI_API_KEY`. There is no automatic fallback in either direction. |
| `RESEARCH_OPENAI_MODEL` | `OPENAI_MODEL` or `gpt-5.6-sol` | Synthesis model. Requests use the Responses API with a strict JSON schema and `store:false`. |
| `RESEARCH_MAX_QUERIES` | 3 (1–5) | Planned queries per request. |
| `RESEARCH_MAX_RESULTS_PER_QUERY` | 5 (1–10) | Exa `numResults`. |
| `RESEARCH_MAX_SOURCES` | 8 (1–20) | Sources kept after de-duplication and ranking. |
| `RESEARCH_MAX_PASSAGE_CHARACTERS` | 2000 (200–4000) | Exa `text.maxCharacters` and the text-excerpt passage bound. |
| `RESEARCH_DEADLINE_MS` | 45000 (1000–120000) | Whole-run deadline; exceeding it yields `cancelled` with `error.code:"timeout"`. Each query additionally has a 20 s bound; a query that exceeds it is marked `failed (query_timeout)` and the remaining queries still run. |
| `RESEARCH_MAX_SEARCHES_PER_HOUR` | 60 | Rolling process-wide search budget; approvals that cannot afford their queries get 429. |
| `OPENAI_API_KEY` | — | Enables the transcript scan (`detect`). Without it the Research tab shows the scan as unavailable. |
| `RESEARCH_DETECT_MODEL` | `gpt-5.4-mini` | Small model for the transcript scan. Responses API, strict JSON schema, `store:false`. |
| `RESEARCH_MAX_SCANS_PER_HOUR` | 30 | Rolling process-wide scan budget. |

## 5. Frontend integration

The Research tab in `apps/web/src/components/research-panel.tsx` (client in `apps/web/src/lib/research-client.ts`) is the reference implementation of this flow: `capabilities` → optional `detect` on click → `prepare` → show plan → `approve`/`decline` → poll `status` → render brief, with cancel. Minimal flow from a page on the same origin:

```ts
import type { ResearchPlan, ResearchRecordView } from "agent-core/research-contract";

const api = "/api/research";
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

await fetch(api);                                                   // 1. establish the session cookie (once per page load)
const { plan } = (await (await fetch(api, json({ operation: "prepare", input: { question, jurisdiction } }))).json()) as { plan: ResearchPlan };
// 2. Render plan.queries[].text, plan.disclosures, plan.privacyReview.flags. Wait for an explicit click.
// 3a. Decline:
await fetch(api, json({ operation: "decline", requestId: plan.requestId }));
// 3b. Approve exactly this plan:
await fetch(api, json({ operation: "approve", requestId: plan.requestId, planHash: plan.planHash }));
// 4. Poll until status !== "running"; offer a Cancel button that posts { operation: "cancel", requestId }.
let view: ResearchRecordView;
do {
  await new Promise((r) => setTimeout(r, 1000));
  view = await (await fetch(`${api}?requestId=${plan.requestId}`)).json();
} while (view.status === "running");
// 5. Render view.brief: sources with labels, findings with citations, limitations, conflicts, unanswered questions.
```

Rules for the integrating UI:

- The question text must be typed or edited by the clinician in a visible field. Do not pre-fill it from a transcript, snapshot, or record without the clinician editing and confirming it; never post transcript text as the question.
- Show the plan before approval. Treat `planHash` as opaque; if the user edits anything, call `prepare` again.
- Handle every status in section 2, including `sources_only` (show sources, say no findings were generated and why via `synthesis.note`) and `failed` (show `error.message`).
- Present findings as evidence for review, not as advice. Link each citation to its source and show the quoted passage.
- Do not register this endpoint as a tool for the browser meeting agent or any model-callable tool; approval is a human action.

## 6. File ownership

| Path | Role |
| --- | --- |
| `packages/agent-core/src/research/contract.ts` | Isomorphic Zod contract (`agent-core/research-contract`). |
| `packages/agent-core/src/research/planner.ts` | Query generation, privacy flags, plan hash. |
| `packages/agent-core/src/research/evidence.ts` | Canonical URLs, de-duplication, relevance, source typing, access labels, passages, injection warnings. |
| `packages/agent-core/src/research/citations.ts` | Synthesis output schema and citation/claim validation. |
| `packages/agent-core/src/research/pipeline.ts` | Approved-plan execution and brief assembly. |
| `packages/agent-core/src/research/service.ts` | Session-bound plan store, approval/decline/cancel, expiry, search budget. |
| `packages/agent-core/src/research/exa-provider.ts`, `openai-synthesis.ts`, `providers.ts` | Exa adapter, OpenAI adapter, interfaces and deterministic fakes. |
| `packages/agent-core/src/research/detector.ts` | Transcript medical-content scan: OpenAI adapter, evidence verification, question privacy flags, fake. |
| `packages/agent-core/src/research/*.test.ts` | 50 unit tests. |
| `apps/web/src/lib/server/research-http.ts`, `research-config.ts` | HTTP guard and env wiring; 7 tests in `research-http.test.ts`. |
| `apps/web/src/app/api/research/route.ts` | Next.js route holding one in-memory service. |
| `apps/web/src/components/research-panel.tsx`, `research-panel.css`, `apps/web/src/lib/research-client.ts` | Research tab UI and browser client; 3 render tests in `research-panel.test.ts`. |
| `apps/web/src/app/page.tsx` (tab entry + CSS import), `apps/web/src/lib/meetings.ts` (`MTG-consult` sample) | Minimal meeting-workspace wiring, authorized by the frontend owner. |
| `apps/web/scripts/research-smoke.ts` | `npm run check:research -- "question" [--approve]` live smoke check. |

Unchanged: `packages/agent-core/src/capabilities/search.ts`, `apps/web/src/app/api/search/route.ts`, the meeting styles/provider wiring/local-AI code, and every devices, speech, and companion file.

## 7. Verified and unverified behaviour

Verified on September 12, 2026:

- `npm run typecheck` and `npm test` pass across all workspaces (agent-core 88 tests including 51 research tests; web 87 after merging upstream `ff5bae2`, including 7 research HTTP tests and 3 panel render tests). `npm run build --workspace web` passes with `/api/research` present.
- Automated tests cover: approve/decline, zero provider calls before approval, session isolation, replay, hash tampering, expiry, cancellation, deadline, malformed synthesis output, fabricated source/passage IDs, non-verbatim quotes, unsupported claims, prompt-injection flagging, empty results, partial retrieval after rate limiting, exhausted credits, missing credentials, transient provider errors, and HTTP host/origin/session/body guards.
- Live Exa run (generic question about early mobilisation after elective knee replacement, jurisdiction UK): 3 queries, 15 hits, 3 duplicates merged, 8 sources labelled, `sources_only` in ~5 s with no synthesis configured.
- Live run with `RESEARCH_SYNTHESIS_PROVIDER=openai` (`gpt-5.6-sol`): `completed` in ~28 s with 7 verified findings, 2 conflicts, 5 unanswered questions, and 1 finding rejected by citation validation.
- Live HTTP checks against the route: cookie issuance, cross-origin 403, hash mismatch 409, replay 409, cross-session 404, polling to `sources_only`, cancel-after-finish 409.
- Live transcript scan with `gpt-5.4-mini`: the fictional consultation returned `detected=true, high` with 4–6 verbatim-evidenced topics and 4 population-level questions (one model topic dropped for non-verbatim evidence); the non-medical launch meeting returned `detected=false, high`. A full scan → suggested question → plan → approve → `sources_only` brief (8 sources) ran through the live route.

Not verified / known limits:

- Exa `RATE_LIMIT_EXCEEDED`, `NO_MORE_CREDITS`, and 402 paths were exercised only with fakes and constructed `ExaError`s, not against the live API.
- The exa-js 2.19 SDK does not accept an `AbortSignal`; cancellation and the deadline discard the response, but an in-flight Exa HTTP request is not torn down.
- Source-type labels are regex heuristics; the same paper on two domains (e.g. PubMed and the publisher) can appear as two sources.
- Relevance is term overlap, not semantic ranking. Synthesis quality depends on the configured OpenAI model and was sampled once.
- There is no user authentication; the session cookie only isolates browser sessions on the loopback demo. Deployment needs real users and a trusted-origin allowlist.
- The Research tab was verified by render tests, typecheck, and the production build, not by a scripted browser click-through; open `/`, choose "Blood pressure review (fictional consultation)", and use the Research tab to exercise it.
- The scan model's verdict is a small-model classification; false negatives on subtle medical content are possible and the summary/topics should be read as suggestions.
- No clinical validation was performed. Results are reference material; the clinician decides.
