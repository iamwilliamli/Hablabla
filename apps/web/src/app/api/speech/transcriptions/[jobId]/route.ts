import { readOrCancelMossTranscription } from "@/lib/server/speech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, { params }: Context) {
  return readOrCancelMossTranscription((await params).jobId, "GET");
}

export async function DELETE(_request: Request, { params }: Context) {
  return readOrCancelMossTranscription((await params).jobId, "DELETE");
}
