/**
 * HTTP boundary for the research agent at /api/research.
 *
 * Mirrors the follow-up approval guard: loopback Host only, exact same-origin
 * Origin plus JSON content type on POST, and an HttpOnly session cookie that
 * binds plans to the browser session that prepared them. This route is a
 * separate authorization boundary from the inherited /api/search proxy.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  ResearchError,
  researchCommandSchema,
  type ResearchErrorCode,
  type ResearchService,
} from "agent-core/research";

const cookieName = "web-research-session";
// Large enough for a `detect` transcript (≤ 50 000 chars) plus JSON overhead.
const MAX_BODY_BYTES = 120_000;

const STATUS_BY_CODE: Record<ResearchErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  plan_mismatch: 409,
  already_decided: 409,
  expired: 410,
  not_running: 409,
  search_unconfigured: 503,
  budget_exhausted: 429,
  too_many_requests: 429,
  detection_unconfigured: 503,
  detection_failed: 502,
};

export function createResearchHandler(options: { service: ResearchService }) {
  const { service } = options;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Next may normalize request.url to localhost. Compare Origin with the actual HTTP Host.
    const expectedOrigin = new URL(url);
    expectedOrigin.host = request.headers.get("host") || url.host;
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const hasSession = !!cookie && /^[a-f0-9]{64}$/.test(cookie);
    const session = hasSession ? cookie : randomBytes(32).toString("hex");
    const reply = (value: unknown, status = 200) =>
      Response.json(value, {
        status,
        headers: {
          "Cache-Control": "no-store",
          ...(!hasSession
            ? {
                "Set-Cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/api/research; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}`,
              }
            : {}),
        },
      });
    // A matching arbitrary Host/Origin can be DNS rebinding against a local credential.
    // Deployment must add authenticated users and a deliberate trusted-origin allowlist.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(expectedOrigin.hostname))
      return Response.json({ error: "This demo accepts loopback hosts only." }, { status: 403 });
    if (request.method !== "GET" && request.method !== "POST")
      return reply({ error: "Method not allowed." }, 405);
    if (
      request.method === "POST" &&
      (request.headers.get("origin") !== expectedOrigin.origin ||
        !request.headers.get("content-type")?.startsWith("application/json"))
    )
      return reply({ error: "Use the research controls from this app's own page." }, 403);
    if (request.method === "POST" && !hasSession)
      return reply({ error: "Reload the page to start a browser session before preparing research." }, 403);

    try {
      if (request.method === "GET") {
        const requestId = url.searchParams.get("requestId");
        if (requestId) {
          if (!hasSession) return reply({ error: "No research session." }, 404);
          const parsed = z.uuid().safeParse(requestId);
          if (!parsed.success) return reply({ error: "Invalid request ID." }, 400);
          return reply(service.view(session, parsed.data));
        }
        return reply({ status: "ready", ...service.capabilities() });
      }
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return reply({ error: "The request is too large." }, 413);
      const command = researchCommandSchema.parse(JSON.parse(text));
      switch (command.operation) {
        case "prepare":
          return reply({ plan: service.prepare(session, command.input) });
        case "approve":
          return reply(service.approve(session, command.requestId, command.planHash), 202);
        case "decline":
          return reply(service.decline(session, command.requestId));
        case "cancel":
          return reply(await service.cancel(session, command.requestId));
        case "detect":
          return reply({ detection: await service.detect(session, command.input) });
      }
    } catch (error) {
      if (error instanceof ResearchError)
        return reply({ error: error.message, code: error.code }, STATUS_BY_CODE[error.code]);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply(
          {
            error:
              "Invalid research request. Send a question of 12–600 characters (optional jurisdiction and YYYY-MM-DD date range), or a transcript of at most 50,000 characters to scan. Nothing was sent externally.",
            code: "invalid_request",
          },
          400,
        );
      // Never forward provider or internal error text to the browser.
      return reply({ error: "The research service failed unexpectedly.", code: "internal" }, 500);
    }
  };
}
