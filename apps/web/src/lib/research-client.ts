/**
 * Browser client for /api/research. One cookie handshake per page, then
 * same-origin JSON commands. Every operation is user-initiated; there are no
 * automatic calls.
 */
import type {
  MedicalDetection,
  ResearchPlan,
  ResearchQuestionInput,
  ResearchRecordView,
} from "agent-core/research-contract";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type ResearchCapabilities = {
  status: "ready";
  search: { provider: string; searchType: string; configured: boolean };
  synthesis: { provider: string; model?: string; configured: boolean };
  detection: {
    provider: string;
    model?: string;
    configured: boolean;
    maxTranscriptCharacters: number;
  };
  budget: { maxQueries: number; maxResultsPerQuery: number; maxSources: number };
};

export class ResearchRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ResearchRequestError";
  }
}

export function createResearchClient(fetcher: Fetcher) {
  let session: Promise<ResearchCapabilities> | undefined;
  const capabilities = () =>
    (session ??= (async () => {
      const response = await fetcher("/api/research", { cache: "no-store" });
      if (!response.ok)
        throw new Error("Unable to start the research session. Reload the page.");
      return (await response.json()) as ResearchCapabilities;
    })().catch((error) => {
      session = undefined;
      throw error;
    }));
  const command = async <T>(body: unknown): Promise<T> => {
    await capabilities();
    const response = await fetcher("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as T & { error?: string; code?: string };
    if (!response.ok)
      throw new ResearchRequestError(
        result.error || `Request failed: HTTP ${response.status}`,
        result.code || "http_error",
        response.status,
      );
    return result;
  };
  return {
    capabilities,
    detect: (input: { meetingId: string; transcript: string }) =>
      command<{ detection: MedicalDetection }>({ operation: "detect", input }).then(
        (r) => r.detection,
      ),
    prepare: (input: ResearchQuestionInput) =>
      command<{ plan: ResearchPlan }>({ operation: "prepare", input }).then((r) => r.plan),
    approve: (requestId: string, planHash: string) =>
      command<ResearchRecordView>({ operation: "approve", requestId, planHash }),
    decline: (requestId: string) =>
      command<ResearchRecordView>({ operation: "decline", requestId }),
    cancel: (requestId: string) =>
      command<ResearchRecordView>({ operation: "cancel", requestId }),
    status: async (requestId: string) => {
      await capabilities();
      const response = await fetcher(`/api/research?requestId=${requestId}`, {
        cache: "no-store",
      });
      const result = (await response.json()) as ResearchRecordView & { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    },
  };
}

export const researchClient = createResearchClient((url, init) => fetch(url, init));
