import { createParakeetSession } from "@/lib/server/speech";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return createParakeetSession(request);
}
