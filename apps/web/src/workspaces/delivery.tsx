/* 交付：印务校样。质量门（装印规格）+ 五格式出厂 + 创作内容快照。
   系统备份档、生产资产与供给管理已迁入设置。 */

import "../styles/delivery.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CheckCircle2,
  Download,
  Loader2,
  Plus,
  Truck,
  XCircle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { ConfirmDialog } from "../components/confirm-dialog";
import { ErrorNote } from "../components/error-note";
import { PageBand } from "../components/page-band";
import { ProjectRequiredState } from "../components/project-required-state";
import { Skeleton } from "../components/skeleton";
import {
  getLocale,
  translate,
  useI18n,
  type MessageKey,
} from "../i18n";
import {
  createProjectBackup,
  getProjectBackups,
  getProjectExport,
  getProjectQuality,
  restoreProjectBackup,
  type BundleCounts,
  type ExportFormat,
  type ProjectQualityReport,
  type ProjectBackup,
} from "../lib/api";
import { formatBytes, formatRelativeDate, shortHash } from "../lib/fmt";
import { exportFormatLabel } from "../lib/labels";
import { useProjectId } from "../lib/project-route";
import { projectWorkspacePath } from "../lib/project-route";

/* 五格式按「成书近 → 数据远」的顺序排 */
const EXPORT_FORMATS: ExportFormat[] = [
  "markdown",
  "text",
  "docx",
  "epub",
  "narrative-bundle",
];

const READINESS_KEY: Record<ProjectQualityReport["readiness"], MessageKey> = {
  ready: "delivery.readiness.ready",
  needs_attention: "delivery.readiness.needsAttention",
  blocked: "delivery.readiness.blocked",
};

const QUALITY_METRIC_KEY: Record<string, MessageKey> = {
  outlineNodes: "delivery.metrics.outlineNodes",
  chapters: "delivery.metrics.chapters",
  committedChapters: "delivery.metrics.committedChapters",
  documents: "delivery.metrics.documents",
  versions: "delivery.metrics.versions",
  manuscriptCharacters: "delivery.metrics.manuscriptCharacters",
  entities: "delivery.metrics.entities",
  facts: "delivery.metrics.facts",
  candidateFacts: "delivery.metrics.candidateFacts",
  unresolvedForeshadows: "delivery.metrics.unresolvedForeshadows",
  openComments: "delivery.metrics.openComments",
  activeStyleProfiles: "delivery.metrics.activeStyleProfiles",
  enabledSkills: "delivery.metrics.enabledSkills",
};

const ISSUE_CATEGORY_KEY: Record<
  ProjectQualityReport["issues"][number]["category"],
  MessageKey
> = {
  structure: "delivery.issueCategory.structure",
  manuscript: "delivery.issueCategory.manuscript",
  canon: "delivery.issueCategory.canon",
  continuity: "delivery.issueCategory.continuity",
  workflow: "delivery.issueCategory.workflow",
};

const ISSUE_SEVERITY_KEY: Record<
  ProjectQualityReport["issues"][number]["severity"],
  MessageKey
> = {
  info: "delivery.issueSeverity.info",
  warning: "delivery.issueSeverity.warning",
  error: "delivery.issueSeverity.error",
};

export function DeliveryWorkspace() {
  const { t } = useI18n();
  const projectId = useProjectId();
  const queryClient = useQueryClient();

  const qualityQuery = useQuery({
    queryKey: ["project", projectId, "quality"],
    queryFn: ({ signal }) => getProjectQuality(projectId!, signal),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });

  const projectBackupsQuery = useQuery({
    queryKey: ["project", projectId, "backups"],
    queryFn: ({ signal }) => getProjectBackups(projectId!, signal),
    enabled: Boolean(projectId),
  });


  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(
    null,
  );
  const [projectBackupLabel, setProjectBackupLabel] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<ProjectBackup | null>(null);
  const [restoredProjectId, setRestoredProjectId] = useState<string | null>(null);
  const restoreRequestRef = useRef<{ backupId: string; requestId: string } | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);

  const projectBackupCreateMutation = useMutation({
    mutationFn: (label: string) => createProjectBackup(projectId!, label),
    onSuccess: () => {
      setProjectBackupLabel("");
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "backups"] });
    },
  });
  const projectRestoreMutation = useMutation({
    mutationFn: (backup: ProjectBackup) => {
      if (restoreRequestRef.current?.backupId !== backup.id) {
        restoreRequestRef.current = {
          backupId: backup.id,
          requestId: crypto.randomUUID(),
        };
      }
      return restoreProjectBackup(backup.id, restoreRequestRef.current.requestId);
    },
    onSuccess: (result) => {
      restoreRequestRef.current = null;
      setRestoreTarget(null);
      setRestoredProjectId(result.projectId);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "backups"] });
    },
  });
  const quality = qualityQuery.data ?? null;
  const gatesPassed = useMemo(
    () => quality?.gates.filter((g) => g.passed).length ?? 0,
    [quality?.gates],
  );

  if (!projectId) {
    return (
      <div className="delivery">
        <ProjectRequiredState
          seal={t("delivery.requiredState.seal")}
          title={t("delivery.requiredState.title")}
          description={t("delivery.requiredState.description")}
        />
      </div>
    );
  }

  const handleExport = async (format: ExportFormat) => {
    setExportingFormat(format);
    setExportError(null);
    try {
      const { blob, filename } = await getProjectExport(projectId, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error);
    } finally {
      setExportingFormat(null);
    }
  };

  return (
    <div className="delivery">
      <PageBand
        index="PRESS · 05"
        title={t("delivery.requiredState.title")}
        meta={
          <span className="mono">
            {t("delivery.pageBand.meta", { count: EXPORT_FORMATS.length })}
          </span>
        }
      />

      <div className="delivery__spread">
        {/* 左：装印规格（质量门）与五格式出厂 */}
        <section className="delivery__ledger">
          <div className="delivery__section delivery__section--gates">
            <header className="delivery__section-head">
              <p className="delivery__section-title">
                <CheckCircle2 size={13} strokeWidth={2} aria-hidden="true" />
                {t("delivery.gates.title")}
              </p>
              {quality ? (
                <span
                  className="delivery__readiness mono"
                  data-r={quality.readiness}
                >
                  {t(READINESS_KEY[quality.readiness])} ·{" "}
                  {gatesPassed}/{quality.gates.length}
                </span>
              ) : null}
            </header>
            {quality ? <p className="delivery__quality-note">{t("delivery.gates.note")}</p> : null}
            {qualityQuery.isPending ? (
              <Skeleton lines={5} />
            ) : qualityQuery.isError ? (
              <ErrorNote error={qualityQuery.error} title={t("delivery.gates.loadError")} />
            ) : quality ? (
              <div className="delivery__gates">
                {quality.gates.map((gate) => (
                  <div
                    key={gate.id}
                    className="delivery__gate"
                    data-pass={gate.passed}
                  >
                    <span className="delivery__gate-icon" aria-hidden="true">
                      {gate.passed ? (
                        <CheckCircle2 size={14} strokeWidth={2} />
                      ) : (
                        <XCircle size={14} strokeWidth={2} />
                      )}
                    </span>
                    <span className="delivery__gate-label">{gate.label}</span>
                    <span className="delivery__gate-message">
                      {gate.message}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {quality && quality.issues.length > 0 ? (
              <div className="delivery__issues">
                <p className="delivery__issues-head mono">
                  {t("delivery.gates.issuesHead", { count: quality.issues.length })}
                </p>
                {quality.issues.map((issue) => (
                  <div
                    key={issue.id}
                    className="delivery__issue"
                    data-s={issue.severity}
                  >
                    <span className="delivery__issue-cat mono">
                      {t(ISSUE_CATEGORY_KEY[issue.category])}
                    </span>
                    <span className="delivery__issue-severity mono">
                      {t(ISSUE_SEVERITY_KEY[issue.severity])}
                    </span>
                    <p className="delivery__issue-message">{issue.message}</p>
                    {issue.suggestion ? (
                      <p className="delivery__issue-hint">{issue.suggestion}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="delivery__section delivery__section--exports">
            <header className="delivery__section-head">
              <p className="delivery__section-title">
                <Truck size={13} strokeWidth={2} aria-hidden="true" />
                {t("delivery.exports.title")}
              </p>
              <span className="delivery__section-meta mono">
                {t("delivery.exports.meta")}
              </span>
            </header>
            <ol className="delivery__exports">
              {EXPORT_FORMATS.map((format) => (
                <li key={format} className="delivery__export">
                  <span className="delivery__export-format mono">
                    {format}
                  </span>
                  <span className="delivery__export-label">
                    {exportFormatLabel(format)}
                  </span>
                  <button
                    type="button"
                    className="delivery__export-btn"
                    onClick={() => void handleExport(format)}
                    disabled={exportingFormat !== null}
                    aria-label={t("delivery.exports.buttonAria", { format: exportFormatLabel(format) })}
                  >
                    {exportingFormat === format ? (
                      <Loader2
                        size={12}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="delivery__export-spin"
                      />
                    ) : (
                      <Download size={12} strokeWidth={2} aria-hidden="true" />
                    )}
                    {t("common.action.download")}
                  </button>
                </li>
              ))}
            </ol>
            {quality?.metrics ? (
              <p className="delivery__metrics mono">
                {Object.entries(quality.metrics)
                  .map(([key, value]) => {
                    const labelKey = QUALITY_METRIC_KEY[key];
                    return `${labelKey ? t(labelKey) : key} ${value.toLocaleString(getLocale())}`;
                  })
                  .join(" · ")}
              </p>
            ) : null}
            {exportError ? <ErrorNote error={exportError} title={t("delivery.exports.error")} /> : null}
          </div>
        </section>

        {/* 右：备份档 */}
        <section className="delivery__rights">
          <div className="delivery__section delivery__section--backups">
            <header className="delivery__section-head">
              <p className="delivery__section-title">
                <Archive size={13} />
                {t("delivery.snapshots.title")}
              </p>
            </header>
            <p className="delivery__empty">{t("delivery.snapshots.description")}</p>
            <form className="delivery__project-backup-form" onSubmit={(event) => { event.preventDefault(); if (projectBackupLabel.trim()) projectBackupCreateMutation.mutate(projectBackupLabel.trim()); }}>
              <label>
                {t("delivery.snapshots.labelField")}
                <input value={projectBackupLabel} onChange={(event) => setProjectBackupLabel(event.target.value)} placeholder={t("delivery.snapshots.placeholder")} />
              </label>
              <button type="submit" className="btn btn--primary" disabled={projectBackupCreateMutation.isPending || !projectBackupLabel.trim()}><Plus size={12} />{projectBackupCreateMutation.isPending ? t("common.state.creating") : t("delivery.snapshots.submit")}</button>
            </form>
            {projectBackupCreateMutation.isError ? <ErrorNote error={projectBackupCreateMutation.error} title={t("delivery.snapshots.createError")} /> : null}
            {projectBackupsQuery.isPending ? <Skeleton lines={3} /> : projectBackupsQuery.isError ? <ErrorNote error={projectBackupsQuery.error} title={t("delivery.snapshots.loadError")} /> : projectBackupsQuery.data?.length ? <ol className="delivery__backups">{projectBackupsQuery.data.map((backup) => <li key={backup.id} className="delivery__backup-row"><span className="delivery__backup-label">{backup.label}</span><span className="delivery__backup-meta mono">{formatBytes(backup.sizeBytes)} · {formatRelativeDate(backup.createdAt)}</span>{backup.counts ? <span className="delivery__backup-counts mono">{summarizeBackupCounts(backup.counts)}</span> : null}<span className="delivery__backup-hash mono">{shortHash(backup.bundleHash)}</span><button type="button" className="delivery__backup-preview-btn" onClick={() => setRestoreTarget(backup)}>{t("delivery.snapshots.restoreButton")}</button></li>)}</ol> : <p className="delivery__empty">{t("delivery.snapshots.empty")}</p>}
            {restoredProjectId ? <p className="delivery__restore-result" role="status">{t("delivery.snapshots.restored")}<Link to={projectWorkspacePath(restoredProjectId, "bible")}>{t("delivery.snapshots.openRestored")}</Link></p> : null}
          </div>
        </section>
      </div>
      {restoreTarget ? <ConfirmDialog title={t("delivery.restoreDialog.title")} confirmLabel={t("delivery.restoreDialog.confirm")} pending={projectRestoreMutation.isPending} onCancel={() => setRestoreTarget(null)} onConfirm={() => projectRestoreMutation.mutate(restoreTarget)}><p>{t("delivery.restoreDialog.body")}</p>{projectRestoreMutation.isError ? <ErrorNote error={projectRestoreMutation.error} title={t("delivery.restoreDialog.error")} /> : null}</ConfirmDialog> : null}
    </div>
  );
}

/** 备份计数清单的紧凑展示：只列出非零项，保持墨色 mono 风格。 */
function summarizeBackupCounts(counts: BundleCounts) {
  const locale = getLocale();
  const labels: [keyof BundleCounts, MessageKey][] = [
    ["outline", "delivery.backupCounts.outline"],
    ["entities", "delivery.backupCounts.entities"],
    ["facts", "delivery.backupCounts.facts"],
    ["documents", "delivery.backupCounts.documents"],
    ["versions", "delivery.backupCounts.versions"],
    ["drafts", "delivery.backupCounts.drafts"],
    ["annotations", "delivery.backupCounts.annotations"],
    ["cover", "delivery.backupCounts.cover"],
    ["personas", "delivery.backupCounts.personas"],
    ["cocreateSessions", "delivery.backupCounts.cocreateSessions"],
    ["storyTurns", "delivery.backupCounts.storyTurns"],
    ["reviews", "delivery.backupCounts.reviews"],
    ["assistantConversations", "delivery.backupCounts.assistantConversations"],
    ["assistantMessages", "delivery.backupCounts.assistantMessages"],
  ];
  const parts = labels
    .filter(([key]) => (counts[key] ?? 0) > 0)
    .map(([key, labelKey]) => `${translate(locale, labelKey)} ${counts[key]}`);
  return parts.length
    ? parts.join(" · ")
    : translate(locale, "delivery.backupCounts.empty");
}
