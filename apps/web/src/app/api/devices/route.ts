import { LocalDevices } from "@/lib/server/local-devices";
import { createOpenAIComputerPlanner } from "@/lib/server/openai-computer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Preserve one broker across dev route recompilation; never persist secrets/images.
const local = globalThis as typeof globalThis & { hablablaDevicesOpenAI?: LocalDevices };
if (!local.hablablaDevicesOpenAI) {
  local.hablablaDevicesOpenAI = new LocalDevices(Date.now, createOpenAIComputerPlanner());
  setInterval(() => local.hablablaDevicesOpenAI?.sweep(), 5000).unref();
}
export const GET = (request: Request) => local.hablablaDevicesOpenAI!.handle(request);
export const POST = GET;
