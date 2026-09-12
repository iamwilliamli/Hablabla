import { LocalDevices } from "@/lib/server/local-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Preserve one broker across dev route recompilation; never persist secrets/images.
const local = globalThis as typeof globalThis & { hablablaDevicesV2?: LocalDevices };
if (!local.hablablaDevicesV2) {
  local.hablablaDevicesV2 = new LocalDevices();
  setInterval(() => local.hablablaDevicesV2?.sweep(), 5000).unref();
}
export const GET = (request: Request) => local.hablablaDevicesV2!.handle(request);
export const POST = GET;
