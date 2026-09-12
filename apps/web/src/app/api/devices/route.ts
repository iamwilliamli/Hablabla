import { LocalDevices } from "@/lib/server/local-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Preserve one broker across dev route recompilation; never persist secrets/images.
const local = globalThis as typeof globalThis & { hablablaDevices?: LocalDevices };
if (!local.hablablaDevices) {
  local.hablablaDevices = new LocalDevices();
  setInterval(() => local.hablablaDevices?.sweep(), 5000).unref();
}
export const GET = (request: Request) => local.hablablaDevices!.handle(request);
export const POST = GET;
