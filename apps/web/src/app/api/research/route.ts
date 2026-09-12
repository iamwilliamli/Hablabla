import { createResearchHandler } from "@/lib/server/research-http";
import { createResearchServiceFromEnv } from "@/lib/server/research-config";
import type { ResearchService } from "agent-core/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Preserve one service across dev route recompilation; plans and briefs are in-memory only.
const local = globalThis as typeof globalThis & { hablablaResearch?: ResearchService };
if (!local.hablablaResearch) {
  local.hablablaResearch = createResearchServiceFromEnv();
  setInterval(() => local.hablablaResearch?.sweep(), 15_000).unref();
}
const handler = createResearchHandler({ service: local.hablablaResearch });
export const GET = handler;
export const POST = handler;
