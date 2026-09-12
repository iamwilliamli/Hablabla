import { speechHealth } from "@/lib/server/speech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return speechHealth();
}
