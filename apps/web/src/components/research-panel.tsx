"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EvidenceBrief,
  EvidenceSource,
  MedicalDetection,
  ResearchPlan,
  ResearchRecordView,
} from "agent-core/research-contract";
import { Icon } from "@/components/icons";
import type { Meeting } from "@/lib/meetings";
import {
  researchClient,
  ResearchRequestError,
  type ResearchCapabilities,
} from "@/lib/research-client";

type ScanState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; detection: MedicalDetection }
  | { phase: "error"; message: string };

type RunState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "awaiting"; plan: ResearchPlan }
  | { phase: "declined"; plan: ResearchPlan }
  | { phase: "running"; plan: ResearchPlan; cancelling: boolean }
  | { phase: "settled"; view: ResearchRecordView }
  | { phase: "error"; message: string; plan?: ResearchPlan };

const sourceTypeLabels: Record<EvidenceSource["sourceType"], string> = {
  guideline: "Guideline",
  systematic_review: "Systematic review",
  randomized_trial: "Randomised trial",
  observational_study: "Observational study",
  preprint: "Preprint (not peer reviewed)",
  commentary: "Commentary",
  other: "Other page",
  unknown: "Unknown type",
};

const accessLabels: Record<EvidenceSource["access"]["contentKind"], string> = {
  text_excerpt: "Text excerpt",
  abstract: "Abstract only",
  highlights_only: "Highlights only",
  none: "No content retrieved",
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatDate(value: string | null) {
  if (!value) return "Date unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unknown"
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ResearchPanel({ meeting }: { meeting: Meeting }) {
  const [capabilities, setCapabilities] = useState<ResearchCapabilities>();
  const [capabilityError, setCapabilityError] = useState("");
  const [scan, setScan] = useState<ScanState>({ phase: "idle" });
  const [question, setQuestion] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const meetingRef = useRef(meeting.id);
  const questionField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    researchClient
      .capabilities()
      .then((value) => active && setCapabilities(value))
      .catch((error) => active && setCapabilityError(messageOf(error)));
    return () => {
      active = false;
    };
  }, []);

  // A different meeting means a different transcript: forget scan and run state.
  useEffect(() => {
    if (meetingRef.current === meeting.id) return;
    meetingRef.current = meeting.id;
    setScan({ phase: "idle" });
    setRun({ phase: "idle" });
    setQuestion("");
  }, [meeting.id]);

  // Poll a running request about once per second until it settles.
  useEffect(() => {
    if (run.phase !== "running") return;
    const requestId = run.plan.requestId;
    let active = true;
    const tick = async () => {
      try {
        const view = await researchClient.status(requestId);
        if (!active) return;
        if (view.status !== "running") setRun({ phase: "settled", view });
      } catch (error) {
        if (active) setRun({ phase: "error", message: messageOf(error), plan: run.plan });
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    void tick();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [run]);

  const scanTranscript = useCallback(async () => {
    setScan({ phase: "running" });
    try {
      const detection = await researchClient.detect({
        meetingId: meeting.id,
        transcript: meeting.transcript,
      });
      setScan({ phase: "done", detection });
    } catch (error) {
      setScan({ phase: "error", message: messageOf(error) });
    }
  }, [meeting.id, meeting.transcript]);

  const prepare = useCallback(async () => {
    const text = question.trim();
    if (text.length < 12) {
      setRun({ phase: "error", message: "Write a research question of at least 12 characters." });
      return;
    }
    setRun({ phase: "preparing" });
    try {
      const plan = await researchClient.prepare({
        question: text,
        ...(jurisdiction.trim() ? { jurisdiction: jurisdiction.trim() } : {}),
      });
      setRun({ phase: "awaiting", plan });
    } catch (error) {
      setRun({ phase: "error", message: messageOf(error) });
    }
  }, [question, jurisdiction]);

  const approve = useCallback(async (plan: ResearchPlan) => {
    try {
      await researchClient.approve(plan.requestId, plan.planHash);
      setRun({ phase: "running", plan, cancelling: false });
    } catch (error) {
      const message =
        error instanceof ResearchRequestError && error.code === "expired"
          ? "This plan expired before approval. Prepare it again."
          : messageOf(error);
      setRun({ phase: "error", message, plan });
    }
  }, []);

  const decline = useCallback(async (plan: ResearchPlan) => {
    try {
      await researchClient.decline(plan.requestId);
    } catch {
      // Declining a plan that already expired is still a decline from the user's view.
    }
    setRun({ phase: "declined", plan });
  }, []);

  const cancel = useCallback(async (plan: ResearchPlan) => {
    setRun({ phase: "running", plan, cancelling: true });
    try {
      const view = await researchClient.cancel(plan.requestId);
      setRun({ phase: "settled", view });
    } catch (error) {
      setRun({ phase: "error", message: messageOf(error), plan });
    }
  }, []);

  const useQuestion = (text: string) => {
    setQuestion(text);
    setRun({ phase: "idle" });
    questionField.current?.focus();
  };

  const detection = scan.phase === "done" ? scan.detection : undefined;
  const detectorReady = capabilities?.detection.configured ?? false;
  const searchReady = capabilities?.search.configured ?? false;
  const synthesisLabel =
    capabilities?.synthesis.provider === "none"
      ? "Findings are off (no synthesis provider configured); results list sources and passages."
      : `Findings drafted by ${capabilities?.synthesis.provider ?? "the synthesis provider"}${capabilities?.synthesis.model ? ` (${capabilities.synthesis.model})` : ""} and verified against passages.`;

  return (
    <div className="research-panel">
      <div className="section-heading">
        <div>
          <h2>Research</h2>
          <p>
            Scan this transcript for medical topics, then research a reviewed question on the
            public web. Results are reference material for clinician review, not advice.
          </p>
        </div>
      </div>
      {capabilityError && (
        <p className="rp-alert" role="alert">
          {capabilityError}
        </p>
      )}

      <section className="rp-card" aria-labelledby="rp-scan-title">
        <div className="rp-step">
          <span className="rp-step-number">1</span>
          <div>
            <h3 id="rp-scan-title">Detect medical content</h3>
            <p>
              {detectorReady
                ? `Sends this transcript (up to ${capabilities?.detection.maxTranscriptCharacters.toLocaleString() ?? "16,000"} characters) to OpenAI ${capabilities?.detection.model ?? ""} to find medical topics and suggest research questions. Nothing is sent until you click.`
                : "Transcript scanning needs a server-side OPENAI_API_KEY. Nothing is sent."}
            </p>
          </div>
        </div>
        <div className="rp-actions">
          <button
            className="button compact"
            disabled={!detectorReady || scan.phase === "running"}
            onClick={() => void scanTranscript()}
          >
            <Icon name="search" size={15} />
            {scan.phase === "running"
              ? "Scanning…"
              : scan.phase === "done"
                ? "Scan again"
                : "Scan transcript with OpenAI"}
          </button>
          {meeting.sample && <span className="rp-muted">Fictional sample transcript</span>}
        </div>
        {scan.phase === "error" && (
          <p className="rp-alert" role="alert">
            {scan.message}
          </p>
        )}
        {detection && (
          <div className="rp-detection" aria-live="polite">
            <p className={`rp-verdict ${detection.medicalContentDetected ? "yes" : "no"}`}>
              <Icon name={detection.medicalContentDetected ? "spark" : "help"} size={15} />
              {detection.medicalContentDetected
                ? `Medical content detected · ${detection.confidence} confidence`
                : `No medical content detected · ${detection.confidence} confidence`}
              <span className="rp-muted">
                {" "}
                · {detection.detector.model} · {detection.scannedCharacters.toLocaleString()} characters scanned
                {detection.truncated ? " (truncated)" : ""}
              </span>
            </p>
            {detection.summary && <p className="rp-summary">{detection.summary}</p>}
            {detection.topics.length > 0 && (
              <ul className="rp-topics">
                {detection.topics.map((topic, index) => (
                  <li key={index}>
                    <span className="rp-chip">{topic.category}</span>
                    <strong>{topic.topic}</strong>
                    <blockquote>“{topic.evidence}”</blockquote>
                  </li>
                ))}
              </ul>
            )}
            {detection.suggestedQuestions.length > 0 && (
              <div className="rp-suggestions">
                <h4>Suggested research questions</h4>
                <ul>
                  {detection.suggestedQuestions.map((item, index) => (
                    <li key={index}>
                      <div>
                        <p>{item.question}</p>
                        <span className="rp-muted">{item.rationale}</span>
                        {item.privacyFlags.length > 0 && (
                          <ul className="rp-flags">
                            {item.privacyFlags.map((flag) => (
                              <li key={flag}>{flag}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <button className="button compact" onClick={() => useQuestion(item.question)}>
                        Use question
                        <Icon name="arrow" size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detection.warnings.map((warning) => (
              <p key={warning} className="rp-note">
                {warning}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="rp-card" aria-labelledby="rp-question-title">
        <div className="rp-step">
          <span className="rp-step-number">2</span>
          <div>
            <h3 id="rp-question-title">Research a reviewed question</h3>
            <p>
              Only this question is sent to the search provider — never the transcript. Remove
              anything that could identify a person; removing a name alone is not enough.
            </p>
          </div>
        </div>
        <label className="rp-label" htmlFor="rp-question">
          Research question
        </label>
        <textarea
          id="rp-question"
          ref={questionField}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="e.g. What is the guideline first-line treatment for uncomplicated hypertension in adults?"
          rows={3}
          maxLength={600}
        />
        <div className="rp-inline">
          <label htmlFor="rp-jurisdiction">Jurisdiction (optional)</label>
          <input
            id="rp-jurisdiction"
            value={jurisdiction}
            onChange={(event) => setJurisdiction(event.target.value)}
            placeholder="UK, US, EU…"
            maxLength={80}
          />
          <button
            className="button compact primary"
            disabled={!searchReady || run.phase === "preparing" || run.phase === "running" || question.trim().length < 12}
            onClick={() => void prepare()}
          >
            {run.phase === "preparing" ? "Preparing…" : "Prepare research plan"}
            <Icon name="arrow" size={13} />
          </button>
        </div>
        {!searchReady && capabilities && (
          <p className="rp-note">Web research needs a server-side EXA_API_KEY. Plans can be prepared but not run.</p>
        )}
        {run.phase === "error" && (
          <p className="rp-alert" role="alert">
            {run.message}
          </p>
        )}
      </section>

      {(run.phase === "awaiting" || run.phase === "declined" || run.phase === "running" || (run.phase === "error" && run.plan)) && (
        <PlanCard
          plan={(run as { plan: ResearchPlan }).plan}
          state={run.phase}
          cancelling={run.phase === "running" && run.cancelling}
          onApprove={approve}
          onDecline={decline}
          onCancel={cancel}
        />
      )}

      {run.phase === "settled" && run.view.brief && (
        <BriefCard brief={run.view.brief} synthesisLabel={synthesisLabel} />
      )}
      {run.phase === "settled" && !run.view.brief && (
        <p className="rp-note">Research ended with status “{run.view.status}” and no brief.</p>
      )}
    </div>
  );
}

export function PlanCard({
  plan,
  state,
  cancelling,
  onApprove,
  onDecline,
  onCancel,
}: {
  plan: ResearchPlan;
  state: RunState["phase"];
  cancelling: boolean;
  onApprove: (plan: ResearchPlan) => void;
  onDecline: (plan: ResearchPlan) => void;
  onCancel: (plan: ResearchPlan) => void;
}) {
  return (
    <section className="rp-card rp-plan" aria-labelledby="rp-plan-title">
      <div className="rp-step">
        <span className="rp-step-number">3</span>
        <div>
          <h3 id="rp-plan-title">
            {state === "running"
              ? "Researching…"
              : state === "declined"
                ? "Plan declined"
                : "Review the exact plan"}
          </h3>
          <p>
            {state === "running"
              ? "Approved. Searching and reading public sources; you can cancel at any time."
              : state === "declined"
                ? "Nothing was sent. Edit the question and prepare a new plan."
                : "These queries will be sent verbatim when you approve. Any change needs a new plan."}
          </p>
        </div>
      </div>
      <ol className="rp-queries">
        {plan.queries.map((query) => (
          <li key={query.id}>
            <code>{query.text}</code>
            <span className="rp-muted">
              {query.purpose}
              {query.includeDomains?.length ? ` · limited to ${query.includeDomains.join(", ")}` : ""}
              {query.startPublishedDate ? ` · from ${query.startPublishedDate.slice(0, 10)}` : ""}
              {query.endPublishedDate ? ` · to ${query.endPublishedDate.slice(0, 10)}` : ""}
            </span>
          </li>
        ))}
      </ol>
      {plan.privacyReview.flags.length > 0 && (
        <div className="rp-flagbox" role="alert">
          <strong>Review before approving</strong>
          <ul className="rp-flags">
            {plan.privacyReview.flags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="rp-disclosures">
        {plan.disclosures.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="rp-actions">
        {state === "awaiting" && (
          <>
            <button className="button compact primary" onClick={() => onApprove(plan)}>
              <Icon name="check" size={14} />
              Approve and research
            </button>
            <button className="button compact" onClick={() => onDecline(plan)}>
              Decline
            </button>
            <span className="rp-muted">Expires {new Date(plan.expiresAt).toLocaleTimeString()}</span>
          </>
        )}
        {state === "running" && (
          <button className="button compact" disabled={cancelling} onClick={() => onCancel(plan)}>
            {cancelling ? "Cancelling…" : "Cancel research"}
          </button>
        )}
      </div>
    </section>
  );
}

export function BriefCard({ brief, synthesisLabel }: { brief: EvidenceBrief; synthesisLabel: string }) {
  const sourceById = new Map(brief.sources.map((source) => [source.id, source]));
  const statusText: Record<EvidenceBrief["status"], string> = {
    completed: "Evidence brief",
    sources_only: "Sources only — no findings generated",
    failed: "Research failed",
    cancelled: brief.error?.code === "timeout" ? "Stopped at the deadline" : "Cancelled",
  };
  return (
    <section className="rp-card rp-brief" aria-labelledby="rp-brief-title" aria-live="polite">
      <div className="rp-step">
        <span className="rp-step-number">4</span>
        <div>
          <h3 id="rp-brief-title">{statusText[brief.status]}</h3>
          <p>
            {brief.scope.description} {brief.scope.duplicatesMerged} duplicates merged,{" "}
            {brief.scope.discardedLowRelevance} low-relevance pages discarded. Not a systematic
            review. Researched {new Date(brief.researchedAt).toLocaleString()}.
          </p>
        </div>
      </div>
      {brief.error && (
        <p className="rp-alert" role="alert">
          {brief.error.message}
        </p>
      )}
      {brief.warnings.map((warning) => (
        <p key={warning} className="rp-note">
          {warning}
        </p>
      ))}
      <p className="rp-note">
        {brief.synthesis.status === "completed" ? synthesisLabel : brief.synthesis.note}
        {brief.synthesis.rejectedFindings > 0 &&
          ` ${brief.synthesis.rejectedFindings} unverifiable finding(s) were removed.`}
      </p>

      {brief.findings.length > 0 && (
        <div className="rp-findings">
          <h4>Findings</h4>
          {brief.findings.map((finding) => (
            <article key={finding.id} className="rp-finding">
              <header>
                <span className={`rp-chip ${finding.kind === "interpretation" ? "interp" : ""}`}>
                  {finding.kind === "interpretation" ? "Agent interpretation" : "Retrieved fact"}
                </span>
                <span className="rp-muted">{finding.confidence} confidence</span>
              </header>
              <p>{finding.claim}</p>
              <details className="evidence">
                <summary>
                  {finding.citations.length} citation{finding.citations.length === 1 ? "" : "s"}{" "}
                  <Icon name="down" size={12} />
                </summary>
                {finding.citations.map((citation, index) => {
                  const source = sourceById.get(citation.sourceId);
                  return (
                    <blockquote key={index}>
                      “{citation.quote}”
                      <footer>
                        {source ? (
                          <a href={source.url} target="_blank" rel="noreferrer noopener">
                            {citation.sourceId} · {source.title}
                          </a>
                        ) : (
                          citation.sourceId
                        )}
                      </footer>
                    </blockquote>
                  );
                })}
              </details>
            </article>
          ))}
        </div>
      )}

      {brief.conflictingFindings.length > 0 && (
        <div className="rp-list">
          <h4>Conflicting evidence</h4>
          <ul>
            {brief.conflictingFindings.map((conflict, index) => (
              <li key={index}>
                {conflict.description}{" "}
                <span className="rp-muted">({conflict.sourceIds.join(", ")})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.unansweredQuestions.length > 0 && (
        <div className="rp-list">
          <h4>Unanswered questions</h4>
          <ul>
            {brief.unansweredQuestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rp-sources">
        <h4>Sources ({brief.sources.length})</h4>
        {brief.sources.length === 0 && <p className="rp-muted">No sources were retrieved.</p>}
        {brief.sources.map((source) => (
          <article key={source.id} className="rp-source">
            <header>
              <span className="rp-source-id">{source.id}</span>
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.title}
              </a>
            </header>
            <div className="rp-source-facts">
              <span className="rp-chip">{sourceTypeLabels[source.sourceType]} · heuristic</span>
              <span className="rp-chip">{accessLabels[source.access.contentKind]}</span>
              <span>{formatDate(source.publishedDate)}</span>
              <span>{source.domain}</span>
              <span>relevance {Math.round(source.relevance.score * 100)}%</span>
            </div>
            <p className="rp-muted">{source.access.limitation}</p>
            {source.warnings.map((warning) => (
              <p key={warning} className="rp-alert">
                {warning}
              </p>
            ))}
            {source.passages.length > 0 && (
              <details className="evidence">
                <summary>
                  {source.passages.length} passage{source.passages.length === 1 ? "" : "s"}{" "}
                  <Icon name="down" size={12} />
                </summary>
                {source.passages.map((passage) => (
                  <blockquote key={passage.id}>
                    <span className="rp-source-id">{passage.id}</span> {passage.text}
                  </blockquote>
                ))}
              </details>
            )}
          </article>
        ))}
      </div>

      <div className="rp-list">
        <h4>Limitations</h4>
        <ul>
          {[...brief.limitations, ...brief.uncertainties].map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
