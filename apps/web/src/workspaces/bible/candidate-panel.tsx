import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { ErrorNote } from "../../components/error-note";
import { getLocale, translate, useI18n, type MessageKey } from "../../i18n";
import {
  decideCanonCandidateItem,
  getCanonCandidates,
  getProjectRuns,
  getRunDetail,
  startCanonCandidate,
  type CanonCandidateSetDto,
  type CanonSpread,
  type NarrativeRun,
} from "../../lib/api";
import { projectWorkspacePath } from "../../lib/project-route";
import { useServerEvents } from "../../lib/sse";

interface CanonCandidatePanelProps {
  projectId: string;
  spread: CanonSpread;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function CanonCandidatePanel(props: CanonCandidatePanelProps) {
  /* 指示文本与 startedRunId 绑定 Spread 身份：切换页签时重挂载，避免串页。 */
  return <CanonCandidatePanelView key={props.spread} {...props} />;
}

function CanonCandidatePanelView({
  projectId,
  spread,
}: CanonCandidatePanelProps) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const createRequestRef = useRef<{
    identity: string;
    requestId: string;
  } | null>(null);
  const candidatesQuery = useQuery({
    queryKey: ["project", projectId, "canon-candidates", spread],
    queryFn: ({ signal }) => getCanonCandidates(projectId, spread, signal),
  });
  const runsQuery = useQuery({
    queryKey: ["project", projectId, "runs"],
    queryFn: ({ signal }) => getProjectRuns(projectId, signal),
  });
  const relevantRuns = useMemo(
    () =>
      (runsQuery.data ?? []).filter(
        (run) =>
          run.recipe === "canon-spread-candidate" &&
          run.policy.canonSpread === spread,
      ),
    [runsQuery.data, spread],
  );
  const activeRun = latestRun(
    relevantRuns.filter((run) => !TERMINAL.has(run.status)),
  );
  const watchedRunId = activeRun?.id ?? startedRunId;
  const runQuery = useQuery({
    queryKey: ["run", watchedRunId],
    queryFn: ({ signal }) => getRunDetail(projectId, watchedRunId!, signal),
    enabled: Boolean(watchedRunId),
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.run.status)
        ? false
        : 1_500,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["project", projectId, "runs"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["project", projectId, "canon-candidates", spread],
    });
  };
  useServerEvents({
    onRunStatus: (runId) => {
      if (runId === watchedRunId) refresh();
    },
    onRunEvent: (runId) => {
      if (runId === watchedRunId) refresh();
    },
  });
  useEffect(() => {
    const detail = runQuery.data;
    if (!detail || !TERMINAL.has(detail.run.status)) return;
    refresh();
  }, [runQuery.data?.run.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMutation = useMutation({
    mutationFn: (text: string) => {
      const identity = JSON.stringify({ spread, instruction: text });
      if (createRequestRef.current?.identity !== identity) {
        createRequestRef.current = {
          identity,
          requestId: crypto.randomUUID(),
        };
      }
      return startCanonCandidate(projectId, spread, {
        requestId: createRequestRef.current.requestId,
        instruction: text,
      });
    },
    onSuccess: (accepted) => {
      createRequestRef.current = null;
      setInstruction("");
      setStartedRunId(accepted.runId);
      refresh();
    },
  });
  const visibleSets = useMemo(() => {
    const sets = candidatesQuery.data ?? [];
    const pending = sets.filter((item) =>
      ["candidate", "partially_applied"].includes(item.status),
    );
    const history = sets.filter((item) => !pending.includes(item)).slice(0, 3);
    return [...pending, ...history];
  }, [candidatesQuery.data]);
  const liveRun = runQuery.data?.run;

  return (
    <section className="bible-ai" aria-label={t("bible.candidates.ariaLabel")}>
      <header className="bible-ai__head">
        <span className="bible-ai__seal" aria-hidden="true">
          <Sparkles size={15} strokeWidth={1.45} />
        </span>
        <div>
          <p className="bible-ai__eyebrow mono">AI · CANDIDATE DESK</p>
          <h3>{t("bible.candidates.title")}</h3>
        </div>
      </header>
      <p className="bible-ai__intro">{t("bible.candidates.intro")}</p>

      {activeRun || (liveRun && !TERMINAL.has(liveRun.status)) ? (
        <RunNotice projectId={projectId} run={liveRun ?? activeRun!} />
      ) : (
        <div className="bible-ai__composer">
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={spreadPrompt(spread)}
            aria-label={t("bible.candidates.instructionLabel")}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={!instruction.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate(instruction.trim())}
          >
            {createMutation.isPending ? (
              <LoaderCircle className="bible-ai__spin" size={13} />
            ) : (
              <Sparkles size={13} />
            )}
            {createMutation.isPending
              ? t("bible.candidates.generating")
              : t("bible.candidates.generate")}
          </button>
        </div>
      )}

      {createMutation.isError ? (
        <ErrorNote
          error={createMutation.error}
          title={t("bible.candidates.startError")}
        />
      ) : null}
      {runQuery.data &&
      ["failed", "cancelled"].includes(runQuery.data.run.status) ? (
        <ErrorNote
          error={new Error(t("bible.candidates.runFailedBody"))}
          title={t("bible.candidates.runFailedTitle")}
        />
      ) : null}
      {candidatesQuery.isError ? (
        <ErrorNote
          error={candidatesQuery.error}
          title={t("bible.candidates.loadError")}
        />
      ) : null}

      <div className="bible-ai__sets">
        {visibleSets.map((set) => (
          <CandidateSet key={set.id} projectId={projectId} value={set} />
        ))}
      </div>
    </section>
  );
}

function RunNotice({
  projectId,
  run,
}: {
  projectId: string;
  run: NarrativeRun;
}) {
  const { t } = useI18n();
  return (
    <div className="bible-ai__running" role="status">
      <LoaderCircle className="bible-ai__spin" size={16} aria-hidden="true" />
      <div>
        <strong>{t("bible.candidates.running")}</strong>
        <span>{runStage(run)}</span>
      </div>
      <Link
        to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(run.id)}`}
        aria-label={t("bible.candidates.viewProgress")}
      >
        <ArrowUpRight size={14} />
      </Link>
    </div>
  );
}

function CandidateSet({
  projectId,
  value,
}: {
  projectId: string;
  value: CanonCandidateSetDto;
}) {
  const { t } = useI18n();
  return (
    <article className="bible-ai__set" data-status={value.status}>
      <header>
        <div>
          <span className="mono">
            {t("bible.candidates.setLabel", {
              status: candidateStatus(value.status),
            })}
          </span>
          <h4>{value.summary}</h4>
        </div>
        <Link
          to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(value.runId)}`}
          aria-label={t("bible.candidates.viewRecord")}
        >
          <ArrowUpRight size={14} />
        </Link>
      </header>
      {value.stale && value.items.some((item) => !item.decision) ? (
        <p className="bible-ai__stale">
          <CircleAlert size={13} aria-hidden="true" />
          {t("bible.candidates.stale")}
        </p>
      ) : null}
      <p className="bible-ai__instruction">“{value.instruction}”</p>
      <div className="bible-ai__items">
        {value.items.map((item) => (
          <CandidateItem
            key={item.id}
            projectId={projectId}
            set={value}
            item={item}
          />
        ))}
      </div>
    </article>
  );
}

function CandidateItem({
  projectId,
  set,
  item,
}: {
  projectId: string;
  set: CanonCandidateSetDto;
  item: CanonCandidateSetDto["items"][number];
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [confirmLocked, setConfirmLocked] = useState(false);
  const decisionMutation = useMutation({
    mutationFn: (input: { action: "apply" | "reject"; confirmLocked?: boolean }) =>
      decideCanonCandidateItem(projectId, set.id, item.id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "canon-candidates", set.spread],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "bible"],
      });
    },
  });
  const apply = () => {
    if (item.requiresLockedConfirmation && !confirmLocked) {
      setConfirmLocked(true);
      return;
    }
    decisionMutation.mutate({ action: "apply", confirmLocked });
  };

  return (
    <section className="bible-ai__item" data-decided={item.decision ? "true" : undefined}>
      <div className="bible-ai__item-title">
        <span className="mono">{operationLabel(item.operation)}</span>
        <h5>{item.title}</h5>
      </div>
      <p>{item.rationale}</p>
      {item.diff.length ? (
        <dl className="bible-ai__diff">
          {item.diff.map((field) => (
            <div key={field.field}>
              <dt>{fieldLabel(field.field)}</dt>
              <dd>
                <del>{printValue(field.before)}</del>
                <span aria-hidden="true">→</span>
                <ins>{printValue(field.after)}</ins>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {item.impact.length ? (
        <ul className="bible-ai__impact">
          {item.impact.map((impact) => (
            <li key={impact}>{impact}</li>
          ))}
        </ul>
      ) : null}
      {item.decision ? (
        <p className="bible-ai__decision" data-action={item.decision.action}>
          {item.decision.action === "apply" ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <X size={13} aria-hidden="true" />
          )}
          {item.decision.action === "apply"
            ? t("bible.candidates.applied")
            : t("bible.candidates.rejected")}
        </p>
      ) : (
        <div className="bible-ai__actions">
          <button
            type="button"
            className="btn"
            disabled={decisionMutation.isPending}
            onClick={() => decisionMutation.mutate({ action: "reject" })}
          >
            <X size={12} />
            {t("bible.candidates.reject")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={decisionMutation.isPending}
            onClick={apply}
          >
            <Check size={12} />
            {confirmLocked
              ? t("bible.candidates.confirmLocked")
              : t("bible.candidates.apply")}
          </button>
        </div>
      )}
      {confirmLocked && !item.decision ? (
        <p className="bible-ai__locked-note">
          {t("bible.candidates.lockedNote")}
        </p>
      ) : null}
      {decisionMutation.isError ? (
        <ErrorNote
          error={decisionMutation.error}
          title={t("bible.candidates.decisionError")}
        />
      ) : null}
    </section>
  );
}

function latestRun(runs: NarrativeRun[]): NarrativeRun | null {
  return [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function runStage(run: NarrativeRun): string {
  if (run.status === "pending")
    return translate(getLocale(), "bible.candidates.stage.pending");
  if (run.status === "paused")
    return translate(getLocale(), "bible.candidates.stage.paused");
  if (run.status === "failed_recoverable")
    return translate(getLocale(), "bible.candidates.stage.failedRecoverable");
  return translate(getLocale(), "bible.candidates.stage.default");
}

function spreadPrompt(spread: CanonSpread): string {
  const prompts: Record<CanonSpread, MessageKey> = {
    intent: "bible.candidates.prompt.intent",
    outline: "bible.candidates.prompt.outline",
    entities: "bible.candidates.prompt.entities",
    facts: "bible.candidates.prompt.facts",
    relations: "bible.candidates.prompt.relations",
    timeline: "bible.candidates.prompt.timeline",
    foreshadows: "bible.candidates.prompt.foreshadows",
  };
  return translate(getLocale(), prompts[spread]);
}

function candidateStatus(status: CanonCandidateSetDto["status"]): string {
  const keys: Record<CanonCandidateSetDto["status"], MessageKey> = {
    candidate: "bible.candidates.status.candidate",
    partially_applied: "bible.candidates.status.partiallyApplied",
    applied: "bible.candidates.status.applied",
    rejected: "bible.candidates.status.rejected",
  };
  return translate(getLocale(), keys[status]);
}

function operationLabel(operation: "create" | "update" | "withdraw") {
  const keys: Record<"create" | "update" | "withdraw", MessageKey> = {
    create: "bible.candidates.operation.create",
    update: "bible.candidates.operation.update",
    withdraw: "bible.candidates.operation.withdraw",
  };
  return translate(getLocale(), keys[operation]);
}

function fieldLabel(field: string): string {
  const keys: Record<string, MessageKey> = {
    promise: "bible.fields.promise",
    themes: "bible.fields.themes",
    audience: "bible.fields.audience",
    tone: "bible.fields.tone",
    boundaries: "bible.fields.boundaries",
    endingDirection: "bible.fields.endingDirection",
    currentFocus: "bible.fields.currentFocus",
    description: "bible.fields.description",
    title: "bible.fields.title",
    summary: "bible.fields.summary",
    goal: "bible.fields.goal",
    conflict: "bible.fields.conflict",
    outcome: "bible.fields.outcome",
    "$item": "bible.fields.wholeItem",
  };
  const key = keys[field];
  return key ? translate(getLocale(), key) : field;
}

function printValue(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return translate(getLocale(), "bible.candidates.unfilled");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return translate(getLocale(), "bible.candidates.complexValue");
  }
}
