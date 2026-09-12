import assert from "node:assert/strict";
import test from "node:test";
import { ExaError } from "exa-js";
import { classifyExaError, createExaSearchProvider, resolveSearchType } from "./exa-provider";
import { SearchProviderError } from "./errors";

const query = { id: "q1", text: "knee replacement early mobilisation", purpose: "p", includeDomains: ["nice.org.uk"], startPublishedDate: "2020-01-01T00:00:00.000Z" };
const options = { numResults: 4, maxCharacters: 1500, highlightQuery: "knee", signal: new AbortController().signal };

test("unconfigured provider reports itself and throws a controlled error", async () => {
  const provider = createExaSearchProvider({ apiKey: "" });
  assert.equal(provider.configured, false);
  await assert.rejects(provider.search(query, options), (error: unknown) => error instanceof SearchProviderError && error.code === "unconfigured");
});

test("search maps plan fields onto the SDK call and results back to the neutral shape", async () => {
  let received: unknown[] = [];
  const client = {
    async search(...args: unknown[]) {
      received = args;
      return {
        requestId: "req-1",
        results: [{ id: "doc", url: "https://nice.org.uk/x", title: "T", publishedDate: "2024-01-01T00:00:00.000Z", text: "body", highlights: ["h1"] }],
      };
    },
  };
  const provider = createExaSearchProvider({ apiKey: "k", searchType: "fast", client: client as never });
  const execution = await provider.search(query, options);
  assert.equal(received[0], query.text);
  assert.deepEqual(received[1], {
    type: "fast",
    numResults: 4,
    includeDomains: ["nice.org.uk"],
    startPublishedDate: "2020-01-01T00:00:00.000Z",
    contents: { text: { maxCharacters: 1500 }, highlights: { query: "knee", maxCharacters: 600 }, filterEmptyResults: false },
  });
  assert.equal(execution.providerRequestId, "req-1");
  assert.deepEqual(execution.results, [{ url: "https://nice.org.uk/x", title: "T", publishedDate: "2024-01-01T00:00:00.000Z", author: undefined, text: "body", highlights: ["h1"], providerId: "doc" }]);
});

test("deep search profiles are refused in favour of a non-synthesising type", () => {
  assert.equal(resolveSearchType("deep-reasoning"), "auto");
  assert.equal(resolveSearchType("fast"), "fast");
  assert.equal(resolveSearchType(undefined), "auto");
});

test("Exa errors are classified without leaking provider text", () => {
  const cases: [ExaError, string][] = [
    [new ExaError("secret detail", 429), "rate_limited"],
    [new ExaError("x", 400, undefined, undefined, { code: "RATE_LIMIT_EXCEEDED" }), "rate_limited"],
    [new ExaError("x", 402), "credits_exhausted"],
    [new ExaError("x", 400, undefined, undefined, { code: "NO_MORE_CREDITS" }), "credits_exhausted"],
    [new ExaError("x", 400, undefined, undefined, { code: "TEAM_BUDGET_EXCEEDED" }), "credits_exhausted"],
    [new ExaError("x", 401), "unauthorized"],
    [new ExaError("x", 500), "provider_error"],
  ];
  for (const [error, code] of cases) {
    const classified = classifyExaError(error);
    assert.equal(classified.code, code);
    assert.doesNotMatch(classified.message, /secret detail/);
  }
  assert.equal(classifyExaError(new TypeError("fetch failed")).code, "provider_error");
});

test("an aborted signal wins the race against a slow SDK call", async () => {
  const client = { search: () => new Promise(() => {}) };
  const provider = createExaSearchProvider({ apiKey: "k", client: client as never });
  const controller = new AbortController();
  const pending = provider.search(query, { ...options, signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(pending, (error: unknown) => error instanceof SearchProviderError && error.code === "cancelled");
});
