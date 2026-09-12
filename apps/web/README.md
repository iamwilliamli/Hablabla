# Hablabla — private visit transcription workspace

The home page is Hablabla's doctor–patient conversation workspace, built with Next.js, React, CopilotKit and a WebLLM worker. Clinicians can upload a visit recording or use live captions, correct the speaker-labeled transcript, and draft grounded visit notes for review. The inherited incident demo remains at `/reference`; the optional voice example remains at `/voice`.

**Handoff status:** UI implementation, all 138 repository tests, and the production build are complete. The speech proxy and browser upload flow were exercised against a contract-compatible backend; real native model inference still requires the Apple Silicon demo host. Live local-AI generation verification is deferred at the user's request after an interrupted browser run. Ambiguous live writes remain unverified. The separate Mac companion now has a Terminal prototype in `apps/companion/`; the same-Mac snapshot dashboard is available at `/devices`, while the production relay remains planned; see [TECH_STACK.md](../../TECH_STACK.md) for completed work, file ownership, and the proposed integration protocol. Do not replace the meeting UI or resume GPU testing as part of companion work.

## Local device dashboard

Open **http://127.0.0.1:3100/devices** while this server runs. Pair it with the installed Hablabla Companion through the app’s **Local Dashboard…** window. Request a snapshot, choose/capture its source in the Mac app, then approve **Share with Dashboard**. Images remain on this Mac and expire after a minute. This route bypasses the meeting agent; it does not start a local or remote model. See the [local protocol and walkthrough](../companion/LOCAL_DASHBOARD.md). Keep the exact loopback bind/host; this is not an internet deployment.
## Run locally

Use Node.js 22+ and run from the repository root:

```bash
npm ci
npm run dev:web
```

Open http://127.0.0.1:3100 in a current Chrome browser with WebGPU support. The home page requires **no model API key**. Click **Load local model** in the assistant panel to download and initialize Llama 3.2 3B. The first download can take several minutes. The smaller 1B model is offered after a load failure. There is no cloud inference fallback.

Choose a sample meeting or use **Add meeting** to paste a transcript. The first sample includes an explicitly labeled, authored example recap. **Analyze locally** replaces it with validated model output. Chat uses the currently selected transcript; questions are independent and do not include earlier chat turns. To keep within the model context window, requests contain a bounded UTF-8 excerpt. Long meetings should be shortened before analysis; the app does not claim to summarize unseen content.

### Connect the speech backend

Start the native model worker and speech gateway as described in
[`apps/speech-gateway/README.md`](../speech-gateway/README.md). Add the matching
server-only values to root `.env`, then restart the web app:

```dotenv
HABLABLA_SPEECH_URL=http://127.0.0.1:8765
HABLABLA_SPEECH_API_KEY=the-same-partner-key-configured-for-the-gateway
```

The browser calls only `/api/speech/*`. Next.js adds the partner bearer key when
it creates a one-time Parakeet WebSocket ticket or proxies a MOSS upload, poll,
or cancellation request. The key is never placed in browser JavaScript. The add
visit dialog reports whether speech is connected and shows queued, processing,
completed, failed, and cancelled states. MOSS speaker IDs remain generic until
a clinician corrects them; the app does not infer who is the doctor or patient.

Imported meetings, recaps and chat are kept in memory for this session. Download the recap before refreshing. No transcript is persisted by the backend. Model artifacts are cached by WebLLM in the browser.

## Review and save

Set `AMBIGUOUS_API_KEY` in root `.env` and restart the app to enable optional persistent tasks. `WEB_APPROVAL_DIR` can select the approval metadata directory (default `.data/web-approvals`).

A generated suggestion is local. **Continue to approval** explicitly sends only the task title, description, owner and due date to the backend. The source quote and transcript are excluded. The next view shows the exact server-held fields and workspace; **Approve & save** executes the write. **Decline** creates nothing. Saved status requires the provider's real ID and matching read-back. The existing session binding, expiry, identity checks, decision records and idempotency guard apply to meeting IDs as well as the inherited incident IDs.

## Accessibility and checks

The workspace has native buttons and dialogs, labeled inputs, keyboard-operated tabs (arrows, Home and End), a skip link, visible focus indicators, status announcements, reduced-motion support and responsive layouts. Dialogs use the browser's focus trap and return focus to the invoking control.

```bash
npm run verify
npm run build --workspace web
```

Unit tests cover UTF-8 context bounds, schema and evidence rejection, AG-UI streaming, meeting association, and meeting approval/idempotency. Actual GPU model loading, response quality and Ambiguous connectivity require verification on the demo hardware and account; automated tests use a fake provider and do not write external tasks.

The pinned CopilotKit release exposes `selfManagedAgents` for this local hackathon integration and emits a licensing notice. Check CopilotKit's production licensing before deployment. This does not add a hosted inference dependency or require sending meeting content to Intelligence.

Implementation references: [WebLLM worker API](https://github.com/mlc-ai/web-llm), [CopilotKit custom agents](https://docs.copilotkit.ai/ag-ui/concepts/agents), and the root [technology stack](../../TECH_STACK.md).

---

The following is the preserved setup guide for the inherited reference app at `/reference`.

# An agent inside your web app

**OpenAI + CopilotKit React + Ambiguous AI**

Build an agent that sees the selected record or page, helps the user act on it, and creates a workplace record that remains after a refresh. Try a customer workspace, project review page, or personal planning app. Replace the sample incident domain with your own project.

[![Web app agent demo](../../assets/demos/web.gif)](../../assets/demos/web.mp4)

_Ask for a follow-up, approve it, and reload to find the saved task in Ambiguous. Preview at 3× speed; click for the full MP4._

## Get started

Complete the [root clone/install steps](../../README.md#get-started). Configure `.env` with [OpenAI](../../using-sponsor-tools.md#openai) and [Ambiguous AI](../../using-sponsor-tools.md#ambiguous-ai):

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-key
MODEL=gpt-5.6-sol
AMBIGUOUS_API_KEY=your-workspace-key
```

Choose an OpenAI model your account can use. Use a demo workspace you control for the first write. This web template needs no managed Channel or Intelligence account.

To add managed conversation persistence, use the [official Intelligence onboarding prompt](../../README.md#copilotkit-onboarding) with `apps/web` as the selected app. It connects this existing Next.js/CopilotKit app; keep the Ambiguous record workflow and page approval. Saving a task in Ambiguous and persisting a conversation in Intelligence are separate capabilities.

To use OpenRouter, follow the [shared provider settings](../../using-sponsor-tools.md#openrouter): set `MODEL_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and a `MODEL` slug with tool support. Keep the Ambiguous workspace key; an OpenAI key is not required for OpenRouter chat.

```bash
npm run dev:web
```

Open `http://127.0.0.1:3100` or `http://localhost:3100` and select an incident. The dev and start scripts bind the credential-backed approval server to loopback by default; keep that boundary unless you add your own authentication and trusted-origin policy.

## Try the flow

1. Ask: “What's happening here?” Check the answer against the incident currently selected.
2. Ask: “Create a follow-up for this incident.”
3. Review the page proposal. Click **Approve & save to Ambiguous** only if the fields are correct. The app should return the actual record ID and any provider link.
4. Refresh the browser. Ask the agent to retrieve the saved task by its ID from Ambiguous, or click **Refresh from Ambiguous**. Check the same record returns without creating a duplicate.
5. Repeat with **Decline** and confirm no task is created.

The result should be a retrievable Ambiguous record with the same ID after refresh. An assistant message saying it saved something is not sufficient.

## Customize these files

| Piece | File |
| --- | --- |
| App and selected record | [src/app/page.tsx](src/app/page.tsx) and [src/lib/incidents.ts](src/lib/incidents.ts) |
| Context and frontend tools | [src/components/app-control.tsx](src/components/app-control.tsx): `useAgentContext`, `select_incident`, `propose_followup`, `retrieve_followup`, and `refresh_followups` |
| Approval UI and provider reads | [src/components/workplace-followups.tsx](src/components/workplace-followups.tsx) and [src/lib/use-workplace.ts](src/lib/use-workplace.ts) |
| Server approval boundary | [src/app/api/followups/route.ts](src/app/api/followups/route.ts) and [src/lib/server/followups.ts](src/lib/server/followups.ts) |
| Ambiguous MCP adapter | [src/lib/server/workplace.ts](src/lib/server/workplace.ts), reads workspace context and saves approved tasks |
| CopilotKit React UI | [src/components/generative-ui.tsx](src/components/generative-ui.tsx) and [src/components/providers.tsx](src/components/providers.tsx) |
| Agent endpoint | [src/app/api/copilotkit/[[...path]]/route.ts](src/app/api/copilotkit/[[...path]]/route.ts), configured without raw workplace write tools |

The web chat does not receive raw Ambiguous write tools. It can propose a task and read or refresh existing records through frontend tools; the server writes only after the user clicks **Approve & save to Ambiguous**. Tool schemas come from the MCP server at write time, and returned links must come from Ambiguous rather than being invented.

## Give this to your coding agent

```text
Read the root hackathon overview, rules, sponsor guide, and AGENTS.md.
Explain the model-only and Intelligence options in README.md's CopilotKit
onboarding section. If I choose Intelligence, follow its official onboarding
prompt for apps/web before customizing; preserve this existing integration.
Adapt apps/web to our user and workflow. Keep CopilotKit React for page context,
frontend tools, agent-rendered UI, and page approval. Use Ambiguous AI for
persistent records. Do not expose raw write tools to the web chat when the page
approval path is required. Return the real record ID/link and verify read-back
after refresh. Keep credentials server-side and enforce authorization at the
write boundary. Run npm run verify and npm run build --workspace web, then
document the live record create/read/decline checks.
```

## Verify and limits

Run `npm run verify` and `npm run build --workspace web` for local checks. Then try the create/read/decline flow with your own workspace. Offline tests cover the approval boundary and error handling; they do not make live provider calls.

[CopilotKit docs](https://docs.copilotkit.ai/) · [Sponsor authentication and first calls](../../using-sponsor-tools.md) · [Demo prompts](../../dev-docs/demo-prompts.md)
