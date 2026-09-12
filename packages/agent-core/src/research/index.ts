/**
 * Server surface of the research agent. Browser code should import the
 * contract from `agent-core/research-contract` instead.
 */
export * from "./contract";
export { ResearchError, SearchProviderError } from "./errors";
export { ResearchService, type ResearchServiceOptions } from "./service";
export { executeResearch } from "./pipeline";
export { buildPlan, buildQueries, hashPlan, privacyFlags, DEFAULT_BUDGET } from "./planner";
export { createExaSearchProvider, resolveSearchType, RESEARCH_SEARCH_TYPES } from "./exa-provider";
export { createOpenAISynthesisProvider } from "./openai-synthesis";
export {
  FakeSearchProvider,
  FakeSynthesisProvider,
  type SearchProvider,
  type SynthesisProvider,
  type SynthesisInput,
  type RawSearchResult,
} from "./providers";
export { synthesisOutputSchema, validateCitation, validateFindings } from "./citations";
export { assembleSources, canonicalUrl, classifySourceType, relevanceScore } from "./evidence";
export {
  createOpenAIDetector,
  detectMedicalContent,
  FakeDetector,
  DetectionFailure,
  DEFAULT_DETECTOR_MODEL,
  DETECTOR_MAX_TRANSCRIPT_CHARACTERS,
  type DetectorProvider,
} from "./detector";
