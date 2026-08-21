import "../styles/runs.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Pause, Play, RotateCcw, Square } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { ConfirmDialog } from "../components/confirm-dialog";
import { Empty } from "../components/empty";
import { ErrorNote } from "../components/error-note";
import { PageBand } from "../components/page-band";
import { ProjectRequiredState } from "../components/project-required-state";
import { Skeleton } from "../components/skeleton";
import { useI18n } from "../i18n";
import {
  MIN_VIABLE_PARTIAL_CHARACTERS,
  adoptRunStream,
  continueRunStream,
  controlRun,
  discardRunStream,
  getProjectRuns,
  getRunDetail,
  regenerateRunStream,
  type NarrativeRun,
  type RunDetail,
} from "../lib/api";
import { runStatusShortLabel, taskActionLabel } from "../lib/labels";
import { projectWorkspacePath, useProjectId } from "../lib/project-route";
import { useRunLiveText, useServerEvents } from "../lib/sse";

const TERMINAL = new Set(["failed", "cancelled", "completed"]);

export function RunsWorkspace() {
  const { t } = useI18n();
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRunId = searchParams.get("run");
  const runsQuery = useQuery({
    queryKey: ["project", projectId, "runs"],
    queryFn: ({ signal }) => getProjectRuns(projectId!, signal),
    enabled: Boolean(projectId),
    refetchInterval: (query) => query.state.data?.some((run) => !TERMINAL.has(run.status)) ? 1_250 : false,
  });
  const detailQuery = useQuery({
    queryKey: ["run", selectedRunId],
    queryFn: ({ signal }) => getRunDetail(projectId!, selectedRunId!, signal),
    enabled: Boolean(projectId && selectedRunId),
    refetchInterval: (query) => query.state.data && !TERMINAL.has(query.state.data.run.status) ? 1_500 : false,
  });
  const persistedStreamSignal = detailQuery.data?.streams.length
    ? detailQuery.data.streams
        .map((stream) => `${stream.stepId}:${stream.attempt}:${stream.updatedAt}`)
        .join("|")
    : detailQuery.data && TERMINAL.has(detailQuery.data.run.status)
      ? `terminal:${detailQuery.data.run.status}:${detailQuery.data.run.updatedAt}`
      : null;
  const liveText = useRunLiveText(selectedRunId, persistedStreamSignal);
  useServerEvents({
    onRunStatus: (runId) => {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "runs"] });
      if (runId === selectedRunId) void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    },
    onRunEvent: (runId) => {
      if (runId === selectedRunId) void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    },
  });

  const grouped = useMemo(() => {
    const groups = new Map<string, NarrativeRun[]>();
    for (const run of runsQuery.data ?? []) {
      const key = run.createdAt.slice(0, 7);
      groups.set(key, [...(groups.get(key) ?? []), run]);
    }
    for (const list of groups.values()) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [runsQuery.data]);
  const [requestedIssue, setSelectedIssue] = useState<string | null>(null);
  const selectedIssue = grouped.some(([issue]) => issue === requestedIssue)
    ? requestedIssue
    : grouped[0]?.[0] ?? null;

  if (!projectId) return <MissingProject />;
  const current = grouped.find(([issue]) => issue === selectedIssue) ?? null;
  const selectRun = (runId: string) => setSearchParams({ run: runId }, { replace: false });

  return <div className="runs">
    <PageBand index="LEDGER · L1" title={t("runs.title")} meta={<span className="mono">{t("runs.volumeMeta", { runs: runsQuery.data?.length ?? 0, issues: grouped.length })}</span>} />
    <div className="runs__layout">
      <aside className="runs__volumes" aria-label={t("runs.issueArchiveLabel")}><header className="runs__volumes-head"><p className="runs__volumes-title">{t("runs.catalog.title")}</p><span className="runs__volumes-count">{t("runs.catalog.count", { count: grouped.length })}</span></header><div className="runs__volumes-list">
        {grouped.length === 0 ? <p className="runs__empty-guide">{t("runs.emptyGuide")}</p> : grouped.map(([issue, list]) => <button key={issue} type="button" className="runs__volume" data-active={issue === selectedIssue} onClick={() => setSelectedIssue(issue)}><span className="runs__volume-no mono">ISSUE NO. {issue.replace("-", "")}</span><span className="runs__volume-title">{t("runs.issueTitle", { issue, count: list.length })}</span><span className="runs__volume-sub">{list[0]!.createdAt.slice(0, 16)}</span></button>)}
      </div></aside>
      <article className="runs__sheet" aria-label={t("runs.currentIssueLabel")}>
        {runsQuery.isPending ? <div className="runs__pad"><Skeleton lines={8} /></div> : runsQuery.isError ? <div className="runs__pad"><ErrorNote error={runsQuery.error} title={t("runs.error.loadList")} /></div> : !current ? <Empty title={t("runs.emptyArchive")} /> : <>
          <header className="runs__sheet-head"><span className="runs__sheet-kicker mono">{t("runs.volumePrefix", { issue: current[0] })}</span><h2 className="runs__sheet-title">ISSUE NO.{current[0].replace("-", "")}</h2><span className="runs__sheet-sub mono">{t("runs.sheetCount", { count: current[1].length })}</span></header>
          <div className="runs__sheet-meta"><span>{t("runs.sheetMeta", { completed: countStatus(current[1], "completed"), failed: countStatus(current[1], "failed"), retry: countStatus(current[1], "failed_recoverable"), running: countStatus(current[1], "running") })}</span></div>
          <div className="runs__rows">{current[1].map((run, index) => <button key={run.id} type="button" className="runs__row runs__row--button" data-active={run.id === selectedRunId} onClick={() => selectRun(run.id)}><span className="runs__row-seq mono">{String(index + 1).padStart(2, "0")}</span><span className="runs__row-title">{run.recipe}<small>{t("runs.revisionCycles", { count: run.revisionCycle })}</small></span><span className="runs__row-status" data-s={run.status}>{runStatusShortLabel(run.status)}</span><span className="runs__row-budget mono" title={t("runs.retryIncluded")}>{t("runs.modelCallsWithId", { count: run.budgetUsage.calls, id: run.id.slice(0, 6) })}</span><ChevronRight size={14} /></button>)}</div>
        </>}
      </article>
    </div>
    {selectedRunId ? <RunDetailPanel projectId={projectId} detail={detailQuery.data} liveText={liveText} pending={detailQuery.isPending} error={detailQuery.error} onSelectRun={selectRun} /> : <p className="runs__select-hint">{t("runs.selectHint")}</p>}
  </div>;
}

function RunDetailPanel({ projectId, detail, liveText, pending, error, onSelectRun }: { projectId: string; detail: RunDetail | undefined; liveText: string; pending: boolean; error: unknown; onSelectRun: (id: string) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (work: () => Promise<unknown>) => work(),
    onSuccess: (value) => {
      setConfirmCancel(false);
      setNotice(t("runs.actionSubmitted"));
      if (value && typeof value === "object" && "run" in value) {
        const run = (value as { run?: { id?: string } }).run;
        if (run?.id && run.id !== detail?.run.id) onSelectRun(run.id);
      }
      void queryClient.invalidateQueries({ queryKey: ["run", detail?.run.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "runs"] });
    },
  });
  if (pending) return <section className="run-detail"><Skeleton lines={10} /></section>;
  if (error) return <section className="run-detail"><ErrorNote error={error} title={t("runs.error.loadDetail")} /></section>;
  if (!detail) return null;
  const { run } = detail;
  const completedSteps = detail.steps.filter((step) => ["succeeded", "skipped"].includes(step.status)).length;
  const act = (work: () => Promise<unknown>) => { setNotice(null); mutation.mutate(work); };
  /* 按钮完全由服务端 availableActions 驱动；未知动作不再猜测。 */
  const can = new Set(detail.availableActions);
  /* 与 harness 路由同式：有效尝试上限 = min(配方 maxAttempts, 策略 maxRetries + 1)。 */
  const policyMaxRetries = detail.effectivePolicy?.maxRetries ?? policyRetryNumber(run.policy.maxRetries);
  const attemptCap = (step: RunDetail["steps"][number]) =>
    policyMaxRetries === null ? step.maxAttempts : Math.min(step.maxAttempts, policyMaxRetries + 1);
  return <section className="run-detail" aria-label={t("runs.detailLabel", { id: run.id })}>
    <header className="run-detail__head"><div><p className="mono">RUN {run.id}</p><h2>{run.recipe}</h2></div><span className="runs__row-status" data-s={run.status}>{runStatusShortLabel(run.status)}</span></header>
    <div className="run-detail__controls">
      {can.has("pause") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => act(() => controlRun(projectId, run.id, { action: "pause" }))}><Pause size={13} />{taskActionLabel("pause")}</button> : null}
      {can.has("resume") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => act(() => controlRun(projectId, run.id, { action: "resume" }))}><Play size={13} />{taskActionLabel("resume")}</button> : null}
      {can.has("accept_plan") ? <button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={() => act(() => controlRun(projectId, run.id, { action: "accept_plan" }))}>{taskActionLabel("accept_plan")}</button> : null}
      {can.has("accept_manuscript") ? <button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={() => act(() => controlRun(projectId, run.id, { action: "accept_manuscript" }))}>{taskActionLabel("accept_manuscript")}</button> : null}
      {can.has("discard_manuscript") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => act(() => controlRun(projectId, run.id, { action: "discard_manuscript" }))}>{taskActionLabel("discard_manuscript")}</button> : null}
      {run.status === "awaiting_user" && detail.result.canonChangeSetId ? <Link className="btn btn--primary" to={projectWorkspacePath(projectId, "studio")}>{t("runs.handleCanonChange")}</Link> : null}
      {can.has("switch_to_manual") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => act(() => controlRun(projectId, run.id, { action: "switch_to_manual" }))}>{taskActionLabel("switch_to_manual")}</button> : null}
      {can.has("retry_chapter") ? <button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={() => act(() => controlRun(projectId, run.id, { action: "retry_chapter", requestId: crypto.randomUUID() }))}><RotateCcw size={13} />{taskActionLabel("retry_chapter")}</button> : null}
      {detail.parentTask?.kind === "autopilot" ? <Link className="btn btn--primary" to={`${projectWorkspacePath(projectId, "autopilot")}?session=${encodeURIComponent(detail.parentTask.id)}`}>{t("runs.backToAutopilot")}</Link> : null}
      {can.has("cancel") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => setConfirmCancel(true)}><Square size={13} />{taskActionLabel("cancel")}</button> : null}
    </div>
    {can.has("request_revision") ? <RevisionRequest pending={mutation.isPending} onSubmit={(requestId, instruction) => act(() => controlRun(projectId, run.id, { action: "request_revision", requestId, instruction }))} /> : null}
    {mutation.isError ? <ErrorNote error={mutation.error} title={t("runs.error.action")} /> : null}{notice ? <p className="run-detail__notice" role="status">{notice}</p> : null}
    <div className="run-detail__summary"><span>{t("runs.flowProgress", { done: completedSteps, total: detail.steps.length })}</span><span title={t("runs.retryIncluded")}>{t("runs.modelCallsCount", { count: run.budgetUsage.calls })}</span><span>{t("runs.inputTokens", { count: run.budgetUsage.inputTokens })}</span><span>{t("runs.outputTokens", { count: run.budgetUsage.outputTokens })}</span><span>{t("runs.wallTime", { seconds: Math.round(run.budgetUsage.wallTimeMs / 1000) })}</span></div>
    <DetailBlock title={t("runs.blocks.streams")}><div className="run-detail__streams">{detail.streams.length === 0 && !liveText ? <p>{t("runs.blocks.noStreams")}</p> : detail.streams.map((stream) => <StreamCard key={`${stream.stepId}:${stream.attempt}`} projectId={projectId} runId={run.id} stream={stream} pending={mutation.isPending} can={can} onAction={act} />)}{liveText ? <article className="run-detail__stream" data-status="streaming"><header>{t("runs.blocks.liveIncrement")}</header><pre>{liveText}</pre></article> : null}</div></DetailBlock>
    <DetailBlock title={t("runs.blocks.steps")}><div className="run-detail__timeline">{detail.steps.map((step) => <article key={step.id}><strong>{step.ordinal + 1}. {step.kind}</strong><span>{step.status} · {t("runs.attempt", { attempt: step.attempt, max: attemptCap(step) })}</span>{step.error ? <p>{step.error.code} · {step.error.message}</p> : null}</article>)}</div></DetailBlock>
    <DetailBlock title={t("runs.blocks.events")}><JsonView value={{ events: detail.events, latestCheckpoint: detail.latestCheckpoint, reviews: detail.reviews }} /></DetailBlock>
    <DetailBlock title={t("runs.blocks.policy")}><JsonView value={detail.effectivePolicy ?? run.policy} /></DetailBlock>
    <DetailBlock title={t("runs.blocks.receipts", { count: detail.contextReceipts.length })}><JsonView value={detail.contextReceipts} /></DetailBlock>
    <DetailBlock title={t("runs.blocks.snapshots", { count: detail.modelSnapshots.length })}><JsonView value={detail.modelSnapshots} /></DetailBlock>
    <DetailBlock title={t("runs.blocks.calls", { count: detail.llmCalls.length })}><div className="run-detail__calls">{detail.llmCalls.length === 0 ? <p>{t("runs.blocks.noCalls")}</p> : detail.llmCalls.map((call) => <article key={call.id}><strong>{call.purpose} · {call.model}</strong><span>{call.protocol} · {call.status} · {call.finishReason ?? "—"}</span><span>{t("runs.blocks.callMetrics", { ttft: call.ttftMs ?? "—", duration: call.durationMs ?? "—", tokens: call.usage?.totalTokens ?? "—" })}</span>{call.error ? <JsonView value={call.error} /> : null}</article>)}</div></DetailBlock>
    {confirmCancel ? <ConfirmDialog title={t("runs.confirmCancel.title")} confirmLabel={t("runs.confirmCancel.confirm")} danger pending={mutation.isPending} onCancel={() => setConfirmCancel(false)} onConfirm={() => act(() => controlRun(projectId, run.id, { action: "cancel" }))}><p>{t("runs.confirmCancel.body")}</p></ConfirmDialog> : null}
  </section>;
}

/** 请求修订：带修订指示提交。每次点提交生成一个新 requestId（= 一次新提交）；
 *  同一 requestId 的网络重试由服务端幂等去重。 */
function RevisionRequest({ pending, onSubmit }: { pending: boolean; onSubmit: (requestId: string, instruction: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const requestIdRef = useRef<string | null>(null);
  if (!open) {
    return <div className="run-detail__controls"><button type="button" className="btn" disabled={pending} onClick={() => setOpen(true)}>{taskActionLabel("request_revision")}</button></div>;
  }
  return (
    <div className="run-detail__revision">
      <textarea
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={t("runs.revision.placeholder")}
        aria-label={t("runs.revision.ariaLabel")}
        rows={3}
      />
      <div className="run-detail__controls">
        <button type="button" className="btn btn--primary" disabled={pending} onClick={() => onSubmit(requestIdRef.current ??= crypto.randomUUID(), instruction.trim() || t("runs.revision.defaultInstruction"))}>{taskActionLabel("request_revision")}</button>
        <button type="button" className="btn" disabled={pending} onClick={() => setOpen(false)}>{t("common.action.collapse")}</button>
      </div>
    </div>
  );
}

function StreamCard({ projectId, runId, stream, pending, can, onAction }: { projectId: string; runId: string; stream: RunDetail["streams"][number]; pending: boolean; can: Set<string>; onAction: (work: () => Promise<unknown>) => void }) {
  const { t } = useI18n();
  const viable = stream.content.length >= MIN_VIABLE_PARTIAL_CHARACTERS;
  return <article className="run-detail__stream" data-status={stream.status}><header><span>{stream.status} · {t("runs.stream.attemptOnly", { attempt: stream.attempt })}</span><span>{t("common.state.characters", { count: stream.content.length })}</span></header><pre>{stream.content}</pre>{stream.status === "interrupted" ? <div className="run-detail__stream-actions"><button type="button" className="btn" disabled={pending || !viable} title={!viable ? t("runs.stream.tooShortTitle", { count: MIN_VIABLE_PARTIAL_CHARACTERS }) : undefined} onClick={() => onAction(() => continueRunStream(projectId, runId, { stepId: stream.stepId, attempt: stream.attempt }))}>{t("runs.stream.continue")}</button><button type="button" className="btn btn--primary" disabled={pending || !viable || !can.has("use_partial")} onClick={() => onAction(() => adoptRunStream(projectId, runId, { stepId: stream.stepId, attempt: stream.attempt }))}>{taskActionLabel("use_partial")}</button><button type="button" className="btn" disabled={pending || !can.has("regenerate")} onClick={() => onAction(() => regenerateRunStream(projectId, runId, { stepId: stream.stepId, attempt: stream.attempt }))}><RotateCcw size={11} />{taskActionLabel("regenerate")}</button><button type="button" className="btn" disabled={pending} onClick={() => onAction(() => discardRunStream(projectId, runId, stream.stepId, stream.attempt))}>{t("runs.stream.discard")}</button></div> : null}{!viable && stream.status === "interrupted" ? <p className="run-detail__warning">{t("runs.stream.tooShortWarning", { count: MIN_VIABLE_PARTIAL_CHARACTERS })}</p> : null}</article>;
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) { return <details className="run-detail__block" open><summary>{title}</summary><div>{children}</div></details>; }
function JsonView({ value }: { value: unknown }) { return <pre className="run-detail__json">{JSON.stringify(value, null, 2)}</pre>; }
function policyRetryNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
function MissingProject() {
  const { t } = useI18n();
  return (
    <div className="runs">
      <ProjectRequiredState
        seal={t("runs.missing.seal")}
        title={t("runs.title")}
        description={t("runs.missing.description")}
      />
    </div>
  );
}
function countStatus(runs: NarrativeRun[], status: string) { return runs.filter((run) => run.status === status).length; }
