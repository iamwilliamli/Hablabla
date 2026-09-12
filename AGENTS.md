# Notes for coding agents

**Documentation language:** Write all repository documentation in English, including headings, tables, captions, and explanatory comments in documentation examples. Keep API identifiers and protocol values unchanged. Apply this rule to new documents and documentation updates.

**User ownership boundary:** William does not own the frontend. Do not modify frontend pages, components, styles, browser agents, or provider wiring in his tasks unless he explicitly changes this instruction. Work on his assigned backend scope and hand frontend integration off to its owners. Preserve teammates' frontend changes.

Read the implementation status and ownership table in [TECH_STACK.md](TECH_STACK.md) and the assignments in [TEAM_ARCHITECTURE.md](TEAM_ARCHITECTURE.md) before editing. The native speech worker and computer companion are separate components. The meeting UI is implemented; live local-AI generation verification is deferred by the user. Do not restart that verification unless asked. The user explicitly assigned the Mac companion: its Terminal prototype is now in `apps/companion/`. Read its README and PROTOCOL.md before edits. Its native app bundle uses `com.hablabla.companion`; preserve its fixed identity/install path and Terminal approval flow. The setup window checks actual Screen Recording/Accessibility access in the GUI process and offers explicit request controls. Packaging does not grant permissions. The native GUI now implements local one-shot display/window capture with an in-memory preview; preserve explicit source selection and clearing on close. The user subsequently authorized same-Mac dashboard integration: `/devices` and its separate `/api/devices` broker now receive one snapshot only after explicit Share with Dashboard in the GUI. Read `apps/companion/LOCAL_DASHBOARD.md` before editing that contract. No off-Mac/model uploads are implemented. The user also authorized Accessibility controls: local protocol v2 adds selected window catalogs and separately approved window switching, pointer gestures, scrolling, text, and shortcuts. Preserve the one-time execution claim, target/focus checks, honest dispatched/unknown statuses, and native approval. Continuous streaming, internet control, and runner-to-GUI communication remain unimplemented. Ad-hoc rebuilds can invalidate TCC grants despite an enabled Settings row; see the companion README recovery steps. Do not infer companion permissions from Codex or Terminal. The same-Mac device UI and future production relay remain separate boundaries in sections 19–23. Do not implement or overwrite those components from an unrelated frontend task. Preserve the meeting workspace at `/`; coordinate shared configuration and protocol changes with the relevant owner.

Read [hackathon-overview.md](hackathon-overview.md), [hackathon-rules.md](hackathon-rules.md), and [using-sponsor-tools.md](using-sponsor-tools.md), then the chosen app README in `apps/channel`, `apps/web`, or `apps/mobile`. Build the team's own workflow; the incident app is infrastructure reference code.

CopilotKit powers the Slack and web templates. The mobile starting point in `apps/mobile` has its own install and environment; follow its README for setup and checks.

For setup, follow [CopilotKit onboarding](README.md#copilotkit-onboarding) after choosing an app. For Slack, run `npm run channel:setup -- --no-clipboard` and continue with the emitted prompt and installed `channels-setup` skill. For web/mobile, explain the model-only and Intelligence options before starting the official `onboard start` workflow. Preserve the chosen app and its working behavior; do not scaffold over this checkout or provision every template. Use current CLI instructions instead of copying authentication and provisioning steps from memory.

Read `.agents/skills/build-channels-agent/SKILL.md` before touching anything in
`apps/channel/`. It carries the verified API surface; the most common
failure mode in this codebase is inventing a plausible-looking Channels API.

Hard-won rules that are easy to get wrong here:

- **`@ag-ui/client` must stay deduped.** The root `package.json` pins it via
  `overrides` to the exact version `@copilotkit/runtime` declares. Two copies
  produce two `AbstractAgent` types and every `createChannel({ agent })` fails
  on a private `_debug` property. If you bump `@copilotkit/runtime`, re-check
  `npm ls @ag-ui/client` and update the override.
- **`@copilotkit/channels` and `@copilotkit/runtime` are a tested pair.** Bump
  together, keep them exact.
- **Files containing JSX must be `.tsx`**, and the tsconfig must set
  `jsxImportSource: "@copilotkit/channels"`. This is not React.
- **`maxSteps` defaults to 1** on `BuiltInAgent`. Any agent with tools needs more,
  or it calls one tool and stops before seeing the result.
- **Do not add `identifyUser` to `CopilotRuntime`.** It belongs on
  `createChannel`, and must be absent on a Channels-only runtime.
- **Handlers return `void`.** `thread.post()` returns a `MessageRef`, so a
  concise arrow body fails under `strict`. Use a block body and `await`.
- **Never invent a component or prop.** The vocabulary is fixed — see
  `references/ui-components.md` in the skill.
- Run `npm run typecheck` before claiming anything works.
