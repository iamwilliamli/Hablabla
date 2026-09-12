# Submission checklist

Choose your city on the [global event page](https://aitinkerers.org/hackathons/global/agents-everywhere). Use that city's participant portal for the submission deadline and published judging criteria, and its handbook for eligibility and required deliverables. See [hackathon-rules.md](hackathon-rules.md) for the agent-readable summary.

## Build eligibility

- [ ] Our submitted project is a net-new build created during the official hackathon period
- [ ] Its core functionality was built during the event; we are not resubmitting or extending a pre-existing project and entering it as new
- [ ] We identify inherited templates, libraries, prompts, components, and starter code separately from our event work

**What we inherited**

- The Agents, Everywhere starter repository, its Next.js monorepo setup, and the
  web template's CopilotKit React/provider wiring.
- The reference incident workflow at `/reference`, optional `/voice` example,
  shared approval pattern, and Ambiguous AI adapter.
- Third-party libraries including CopilotKit, WebLLM, Next.js, React, and Zod.

**What we built during the hackathon**

- A new doctor–patient conversation workspace at `/`, with accessible desktop
  and mobile navigation, recording library, visit transcript editor, dark/light
  themes, adjustable text size, and reviewable visit-note drafts.
- A native Apple Silicon speech worker and authenticated speech gateway for
  Parakeet live transcription and queued MOSS file transcription with speaker
  segments.
- Server-only `/api/speech/*` routes that keep the partner API key out of the
  browser while supporting readiness, one-time WebSocket tickets, uploads,
  polling, errors, retries, and cancellation.
- A browser capture flow that waits for Parakeet readiness, streams framed 16
  kHz PCM, replaces stale transcript revisions, and waits for a final result.
- Clinical guardrails in the local agent prompt: generic speakers remain
  unidentified, generated notes must stay grounded in the transcript, and the
  clinician reviews the draft before using or saving follow-ups.
- A **Research** tab and `/api/research` backend: on an explicit click, a small
  OpenAI model scans the visit transcript for medical topics (each with a
  verbatim quote) and suggests population-level questions; the clinician
  reviews the exact Exa queries and approves or declines before any search;
  the evidence brief labels source types and access limits and verifies every
  citation against retrieved passages. See `dev-docs/research-agent.md`.

## Title and description

**What you built**

Hablabla turns a doctor–patient conversation into an editable, speaker-labeled
transcript and a clinician-reviewed visit-note draft. A clinician can upload a
recording or start live captions, see backend progress and errors, correct the
transcript, run the private in-browser agent, inspect transcript evidence, and
download the result or explicitly approve a follow-up task.

**Who it is for**

A clinician who wants to capture a patient visit and review useful notes without
manually reconstructing the conversation afterward.

**Why the context matters**

The agent receives the currently selected visit transcript from the workspace,
so the clinician does not paste sensitive context into a separate chat. Its
structured draft links decisions and follow-ups to transcript evidence. It does
not infer which generic speaker is the doctor or patient and does not invent an
unstated diagnosis, treatment, or instruction.

**Sponsor technologies used**

- **CopilotKit React** supplies the in-app agent lifecycle, selected-visit
  context, streaming conversation, and UI integration.
- **Ambiguous AI** is an optional persistence destination for a follow-up after
  the clinician reviews the exact fields and explicitly approves the write.
- **Exa** performs the approved public-web evidence search in the Research tab
  (`EXA_API_KEY`, server-side only).
- **OpenAI** runs the explicit transcript scan (`gpt-5.4-mini`) and, only when
  `RESEARCH_SYNTHESIS_PROVIDER=openai` is set, drafts citation-checked findings.

The primary visit analysis uses WebLLM in the browser. The transcription backend
uses Parakeet and MOSS locally; these are project infrastructure rather than
sponsor integrations. OpenRouter, Auth0, and CopilotKit Intelligence are not
required by this submitted workflow; the Research tab is optional and degrades
to an unavailable state without its keys.

## Evidence for the judging criteria

Judges score each of the four official criteria from 1–5. This checklist helps you gather evidence; it does not guarantee a score. A working starter is a foundation for your own project.

| Official criterion | Show in your project and demo |
|---|---|
| Core Requirements & Functionality | Run one complete workflow in the intended environment, from user request through tools to a verified result. Repeat it with live integrations; offline tests alone do not prove the deployed flow. |
| Innovation & Theme Alignment | Show the surrounding context before the prompt and explain the original interaction it enables. Compare with the context removed: what value would a standalone chatbox lose? |
| Technical Execution & Integration | Show how tools, data, and the environment connect. Demonstrate a relevant failure or cancellation path and explain recovery, state persistence, and integration limits. |
| Usefulness & Agentic Experience | Identify the user and problem, show a meaningful action in the surface, and demonstrate clear feedback and appropriate user control. Explain what work the agent saves. |

- [ ] We can point to visible evidence for every criterion
- [ ] We distinguish live services, sample data, session-only state, and standalone recipes
- [ ] Sponsor technologies contribute to the workflow; their count is not a judging criterion

## Public repository

- [ ] A new participant can run the quickstart from a clean clone
- [ ] The README lists the credentials and separate processes required
- [ ] `npm run verify` passes; optional recipe checks pass if used
- [ ] `.env`, tokens, generated traces with sensitive data, and account secrets are excluded
- [ ] Sample data, session-only state, and unimplemented integrations are clearly labeled

## Two-minute demo video

- [ ] Show the surface and existing context before the prompt
- [ ] Demonstrate one complete interaction
- [ ] Show a visible result: an actual record, local state change, or research source links
- [ ] If showing an approval, distinguish the decision from execution and demonstrate the resulting behavior
- [ ] State which sponsor technologies made the interaction possible
- [ ] Keep the video within the event's limit and check audio

See [demo prompts](dev-docs/demo-prompts.md) for a reproducible incident workflow.

## Social post and final submission

- [ ] Follow the organizer's posting and sponsor-tagging instructions
- [ ] Link the public repository and video
- [ ] Credit the sponsors you used and applicable local partners
- [ ] Check the live integration once more before recording or submitting
- [ ] Inspect the repository, video and screenshots for secrets

Prepare the post and submission for a human to publish; running the starter kit
does not publish either automatically.
