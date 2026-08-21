import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Check, ExternalLink, Pause, Play, RefreshCcw, Sparkles, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import { Link, Navigate } from "react-router";

import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import {
  controlRun,
  getRunDetail,
  type RunActionRequest,
} from "../../lib/api";
import { getLocale, translate, useI18n, type MessageKey } from "../../i18n";
import { runStatusShortLabel, taskActionLabel } from "../../lib/labels";
import { projectWorkspacePath } from "../../lib/project-route";
import { rememberTask } from "../../lib/task-ledger";

const TERMINAL_STATUSES = new Set(["failed", "cancelled", "completed"]);

interface WritingTaskPanelProps {
  projectId: string;
  runId: string;
  onRunChange: (runId: string) => void;
  onDismiss: () => void;
  onAccepted: () => void;
  onRefreshDocument: () => void;
}

export function WritingTaskPanel({ projectId, runId, onRunChange, onDismiss, onAccepted, onRefreshDocument }: WritingTaskPanelProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [confirmAction, setConfirmAction] = useState<"cancel" | "discard_manuscript" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const revisionRequestIdRef = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ["run", runId],
    queryFn: ({ signal }) => getRunDetail(projectId, runId, signal),
    refetchInterval: (state) => state.state.data && !TERMINAL_STATUSES.has(state.state.data.run.status) ? 1_500 : false,
  });
  const mutation = useMutation({
    mutationFn: (request: RunActionRequest) => controlRun(projectId, runId, request),
    onSuccess: (value, request) => {
      if (request.action === "request_revision") {
        revisionRequestIdRef.current = null;
        setRevisionInstruction("");
        setRevisionOpen(false);
      }
      setConfirmAction(null);
      setNotice(actionNotice(request.action));
      const nextRunId = nestedRunId(value);
      if (nextRunId && nextRunId !== runId) onRunChange(nextRunId);
      if (request.action === "accept_manuscript") onAccepted();
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "overview"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "runs"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "review"] });
      onRefreshDocument();
    },
  });
  const retryMutation = useMutation({
    mutationFn: () =>
      controlRun(projectId, runId, {
        action: "retry_chapter",
        requestId: crypto.randomUUID(),
      }),
    onSuccess: (created) => {
      const nextRunId = nestedRunId(created);
      if (!nextRunId) return;
      rememberTask({
        projectId,
        kind: "chapter",
        taskId: nextRunId,
        label: t("studio.task.retryLabel"),
        createdAt: new Date().toISOString(),
        origin: { surface: "writing" },
      });
      onRunChange(nextRunId);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "runs"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "overview"] });
      onRefreshDocument();
    },
  });

  if (query.isPending) return <section className="studio__task" aria-label={t("studio.task.aria")}><Skeleton lines={5} /></section>;
  if (query.isError) return <section className="studio__task" aria-label={t("studio.task.aria")}><ErrorNote error={query.error} title={t("studio.errors.taskLoad")} /><Link className="studio__task-evidence" to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(runId)}`}>{t("studio.task.detailLink")} <ExternalLink size={12} /></Link></section>;
  if (!query.data) return null;

  const detail = query.data;
  if (detail.run.recipe === "book-foundation") {
    return <Navigate replace to={`${projectWorkspacePath(projectId, "autopilot")}?foundation=${encodeURIComponent(runId)}`} />;
  }
  if (detail.run.recipe !== "chapter-production") {
    return <Navigate replace to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(runId)}`} />;
  }
  const actions = new Set(detail.availableActions);
  const manuscript = stringValue(detail.result.manuscriptCandidate, "content");
  const planGoal = stringValue(detail.result.planCandidate, "chapterGoal");
  const reviewSummary = stringValue(detail.result.reviewSummary, "summary");
  const reviewVerdict = stringValue(detail.result.reviewSummary, "verdict");
  const issues = recordArray(detail.result.reviewSummary, "issues");
  const waitingForRetry = detail.run.status === "failed_recoverable";
  const failed = detail.run.status === "failed";
  const failedStep = [...(detail.steps ?? [])].reverse().find((step) => step.status === "failed");
  const failedMessage = failedStep?.error
    ? `${failedStep.error.code} · ${failedStep.error.message}`
    : null;
  const canRetry = actions.has("retry_chapter") && detail.parentTask === null;
  const showProgress = !manuscript && !planGoal && !waitingForRetry && !TERMINAL_STATUSES.has(detail.run.status);
  const submitRevision = () => mutation.mutate({
    action: "request_revision",
    requestId: revisionRequestIdRef.current ??= crypto.randomUUID(),
    instruction: revisionInstruction.trim() || t("studio.task.revisionDefault"),
  });

  return <section className="studio__task" aria-label={t("studio.task.aria")} id="writing-task">
    <header className="studio__task-head">
      <div><p className="mono">{t("studio.task.candidateTag")}</p><h2>{runStatusShortLabel(detail.run.status)}</h2></div>
      <button type="button" className="studio__task-close" aria-label={t("studio.task.collapseAria")} onClick={onDismiss}><X size={15} /></button>
    </header>

    {waitingForRetry ? <div className="studio__task-progress"><Sparkles size={16} /><div><strong>{t("studio.task.waitingRetryTitle")}</strong><p>{t("studio.task.waitingRetryBody")}</p></div></div> : null}
    {showProgress ? <div className="studio__task-progress"><Sparkles size={16} /><div><strong>{t("studio.task.progressTitle")}</strong><p>{t("studio.task.progressBody")}</p></div></div> : null}
    {failed ? (
      <div className="studio__task-progress" data-tone="failed">
        <CircleAlert size={16} />
        <div>
          <strong>{t("studio.task.failedTitle")}</strong>
          <p>{failedMessage ?? t("studio.task.failedFallback")}</p>
          <div className="studio__task-retry">
            {canRetry ? <button type="button" className="btn btn--primary" disabled={retryMutation.isPending} onClick={() => retryMutation.mutate()}><RefreshCcw size={13} />{retryMutation.isPending ? t("studio.task.retrying") : t("studio.task.retry")}</button> : detail.parentTask?.kind === "autopilot" ? <Link className="btn btn--primary" to={`${projectWorkspacePath(projectId, "autopilot")}?session=${encodeURIComponent(detail.parentTask.id)}`}>{t("studio.task.backToAutopilot")}</Link> : null}
          </div>
          {retryMutation.isError ? <ErrorNote error={retryMutation.error} title={t("studio.errors.retryFailed")} /> : null}
        </div>
      </div>
    ) : null}

    {planGoal ? <article className="studio__task-note"><span className="mono">{t("studio.task.planLabel")}</span><p>{planGoal}</p></article> : null}

    {manuscript ? <article className="studio__candidate" aria-label={t("studio.task.candidateAria")}>
      <header><span className="mono">{t("studio.task.candidateLabel")}</span><strong>{t("common.state.characters", { count: [...manuscript].length })}</strong></header>
      <div className="studio__candidate-body">{manuscript}</div>
    </article> : null}

    {reviewSummary ? <article className="studio__task-review" aria-label={t("studio.task.reviewAria")}>
      <header><span className="mono">{t("studio.task.reviewLabel")}</span>{reviewVerdict ? <strong>{reviewVerdictLabel(reviewVerdict)}</strong> : null}</header>
      <p>{reviewSummary}</p>
      {issues.length > 0 ? <ul>{issues.map((issue, index) => <li key={stringValue(issue, "id") ?? index}><strong>{stringValue(issue, "message") ?? t("studio.task.issueFallback")}</strong>{stringValue(issue, "suggestedDirection") ? <span>{stringValue(issue, "suggestedDirection")}</span> : null}</li>)}</ul> : null}
    </article> : null}

    {detail.result.settlementCandidate ? <p className="studio__task-settlement">{t("studio.task.settlementNote")}</p> : null}

    <div className="studio__task-actions">
      {actions.has("accept_plan") ? <button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "accept_plan" })}><Check size={13} />{taskActionLabel("accept_plan")}</button> : null}
      {actions.has("accept_manuscript") ? <button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "accept_manuscript" })}><Check size={13} />{t("studio.task.accept")}</button> : null}
      {actions.has("request_revision") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => setRevisionOpen((value) => !value)}><RefreshCcw size={13} />{t("studio.task.requestRevision")}</button> : null}
      {actions.has("switch_to_manual") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "switch_to_manual" })}>{taskActionLabel("switch_to_manual")}</button> : null}
      {actions.has("pause") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "pause" })}><Pause size={13} />{t("studio.task.pause")}</button> : null}
      {actions.has("resume") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "resume" })}><Play size={13} />{t("studio.task.resume")}</button> : null}
      {actions.has("discard_manuscript") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => setConfirmAction("discard_manuscript")}>{t("studio.task.discard")}</button> : null}
      {actions.has("cancel") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => setConfirmAction("cancel")}><Square size={13} />{t("studio.task.cancel")}</button> : null}
    </div>

    {revisionOpen ? <div className="studio__task-revision"><label>{t("studio.task.revisionLabel")}<textarea rows={3} value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value)} placeholder={t("studio.task.revisionPlaceholder")} /></label><button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={submitRevision}>{t("studio.task.revisionSubmit")}</button></div> : null}
    {detail.result.partialRecovery ? <p className="studio__task-settlement">{t("studio.task.partialRecovery", { count: detail.result.partialRecovery.characters })}</p> : null}
    {mutation.isError ? <ErrorNote error={mutation.error} title={t("studio.errors.taskActionFailed")} /> : null}
    {notice ? <p className="studio__saved-note" role="status">{notice}</p> : null}
    <Link className="studio__task-evidence" to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(runId)}`}>{t("studio.task.detailLink")} <ExternalLink size={12} /></Link>

    {confirmAction ? <ConfirmDialog title={confirmAction === "cancel" ? t("studio.task.confirmCancelTitle") : t("studio.task.confirmDiscardTitle")} confirmLabel={confirmAction === "cancel" ? t("studio.task.confirmCancelLabel") : t("studio.task.confirmDiscardLabel")} danger pending={mutation.isPending} onCancel={() => setConfirmAction(null)} onConfirm={() => mutation.mutate({ action: confirmAction })}><p>{confirmAction === "cancel" ? t("studio.task.confirmCancelBody") : t("studio.task.confirmDiscardBody")}</p></ConfirmDialog> : null}
  </section>;
}

function nestedRunId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.run)) return null;
  return typeof value.run.id === "string" ? value.run.id : null;
}

function stringValue(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function reviewVerdictLabel(verdict: string): string {
  const keys: Record<string, MessageKey> = {
    pass: "studio.task.verdict.pass",
    revise: "studio.task.verdict.revise",
    block: "studio.task.verdict.block",
  };
  const key = keys[verdict];
  return key ? translate(getLocale(), key) : verdict;
}

function actionNotice(action: RunActionRequest["action"]): string {
  const keys: Record<string, MessageKey> = {
    accept_plan: "studio.task.notice.acceptPlan",
    accept_manuscript: "studio.task.notice.acceptManuscript",
    request_revision: "studio.task.notice.requestRevision",
    discard_manuscript: "studio.task.notice.discardManuscript",
    switch_to_manual: "studio.task.notice.switchToManual",
    pause: "studio.task.notice.pause",
    resume: "studio.task.notice.resume",
    cancel: "studio.task.notice.cancel",
  };
  return translate(getLocale(), keys[action] ?? "studio.task.notice.fallback");
}
