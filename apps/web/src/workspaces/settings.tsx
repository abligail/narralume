import "../styles/settings.css";
import "../styles/supply.css";
import "../styles/delivery.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, ChevronDown, Edit3, FileCheck2, Network, Plus, Radio, Trash2, Unplug } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

import {
  currentDriverMode,
  onDriverModeChange,
  readDriverOverride,
  resolveDriverMode,
  setDriverOverride,
  type DriverMode,
} from "../kernel/transport";

import { ConfirmDialog } from "../components/confirm-dialog";
import { ErrorNote } from "../components/error-note";
import { PageBand } from "../components/page-band";
import { Skeleton } from "../components/skeleton";
import {
  LOCALES,
  LOCALE_LABELS,
  getLocale,
  translate,
  useI18n,
  type MessageKey,
} from "../i18n";
import {
  downloadLibraryDatabase,
  createModel,
  createProvider,
  createSystemBackup,
  deleteAssignment,
  deleteModel,
  deleteProvider,
  getProjects,
  getSystemBackups,
  listAssignments,
  listModels,
  listProviders,
  previewSystemBackup,
  probeProvider,
  restoreSystemBackup,
  setAssignment,
  updateModel,
  updateProvider,
  type AssignmentRole,
  type ModelConfigDto,
  type ModelTaskType,
  type ProviderProbeResult,
  type PublicProviderDto,
  type SystemBackupPreview,
  type UpsertModelRequest,
  type UpsertProviderRequest,
  type WireApi,
} from "../lib/api";
import { formatBytes, formatRelativeDate, formatTime, shortHash, shortId } from "../lib/fmt";
import {
  assignmentRoleLabel,
  metadataSourceLabel,
  probeStageLabel,
  probeStageStatusLabel,
  wireApiLabel,
} from "../lib/labels";
import { projectWorkspacePath } from "../lib/project-route";
import { ProductionTools } from "./delivery/production-tools";

/* 设置：默认生成模型与岗位继承（写作/规划/审稿在未覆盖时继承默认生成模型）、
   Provider/模型/派岗管理、高级工具（运行中心/长篇推演链接、生产资产、系统备份档）。 */

const PRIMARY_ROLES: AssignmentRole[] = ["writing", "embedding"];
const ADVANCED_ROLES: AssignmentRole[] = ["planning", "review"];
const TASK_TYPES: ModelTaskType[] = [...PRIMARY_ROLES, ...ADVANCED_ROLES];
const WIRE_APIS: WireApi[] = ["openai-chat", "openai-responses", "anthropic-messages"];
const trialMode = import.meta.env.VITE_TRIAL_MODE === "1";

const ROLE_KEYS: Record<AssignmentRole, { name: MessageKey; note: MessageKey }> = {
  writing: { name: "settings.roles.writing.name", note: "settings.roles.writing.note" },
  planning: { name: "settings.roles.planning.name", note: "settings.roles.planning.note" },
  review: { name: "settings.roles.review.name", note: "settings.roles.review.note" },
  embedding: { name: "settings.roles.embedding.name", note: "settings.roles.embedding.note" },
  rerank: { name: "settings.roles.rerank.name", note: "settings.roles.rerank.note" },
};

function roleCopy(role: AssignmentRole): { name: string; note: string } {
  const locale = getLocale();
  return {
    name: translate(locale, ROLE_KEYS[role].name),
    note: translate(locale, ROLE_KEYS[role].note),
  };
}

type DeleteTarget =
  | { kind: "provider"; value: PublicProviderDto }
  | { kind: "model"; value: ModelConfigDto }
  | { kind: "assignment"; value: AssignmentRole };

export function SettingsWorkspace() {
  const queryClient = useQueryClient();
  const { locale, setLocale, t } = useI18n();
  const [searchParams] = useSearchParams();
  const contextProjectId = searchParams.get("project");
  const requestedReturnPath = searchParams.get("return");
  const returnPath = safeProjectReturnPath(contextProjectId, requestedReturnPath);
  const driverMode = useDriverMode();
  const [requestedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<PublicProviderDto | "new" | null>(null);
  const [modelEditor, setModelEditor] = useState<ModelConfigDto | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toolsProjectId, setToolsProjectId] = useState<string | null>(null);

  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: ({ signal }) => listProviders(signal),
    staleTime: 5_000,
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => listModels(undefined, signal),
    staleTime: 5_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ["assignments"],
    queryFn: ({ signal }) => listAssignments(signal),
    staleTime: 5_000,
  });
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => getProjects(signal),
  });

  const providers = useMemo(() => providersQuery.data ?? [], [providersQuery.data]);
  const allModels = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  const assignments = useMemo(() => assignmentsQuery.data ?? [], [assignmentsQuery.data]);
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const preferredProjectId = toolsProjectId ?? contextProjectId;
  const toolsProject = projects.find((project) => project.id === preferredProjectId) ?? projects[0] ?? null;

  const selectedProviderId = providers.some((provider) => provider.id === requestedProviderId)
    ? requestedProviderId
    : providers[0]?.id ?? null;

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const models = allModels.filter((model) => model.providerId === selectedProviderId);
  const currentProviderEditor = providerEditor === "new" || providerEditor === null
    ? providerEditor
    : providers.find((provider) => provider.id === providerEditor.id) ?? providerEditor;
  const currentModelEditor = modelEditor === "new" || modelEditor === null
    ? modelEditor
    : allModels.find((model) => model.id === modelEditor.id) ?? modelEditor;

  const providerMutation = useMutation({
    mutationFn: (input: { current: PublicProviderDto | null; value: UpsertProviderRequest }) =>
      input.current
        ? updateProvider(input.current.id, {
            ...input.value,
            expectedUpdatedAt: input.current.updatedAt,
          })
        : createProvider(input.value),
    onSuccess: (provider) => {
      setProviderEditor(null);
      setSelectedProviderId(provider.id);
      setNotice(t("settings.notices.providerSaved"));
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const modelMutation = useMutation({
    mutationFn: (input: { current: ModelConfigDto | null; value: UpsertModelRequest }) =>
      input.current
        ? updateModel(input.current.id, {
            ...input.value,
            expectedUpdatedAt: input.current.updatedAt,
          })
        : createModel(input.value),
    onSuccess: () => {
      setModelEditor(null);
      setNotice(t("settings.notices.modelSaved"));
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: ["models"] }),
  });
  const assignMutation = useMutation({
    mutationFn: (input: { role: AssignmentRole; modelId: string }) =>
      setAssignment(input.role, input.modelId),
    onSuccess: () => {
      setNotice(t("settings.notices.assignmentSaved"));
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
    },
  });
  const removeMutation = useMutation({
    mutationFn: async (target: DeleteTarget) => {
      if (target.kind === "provider") await deleteProvider(target.value.id);
      if (target.kind === "model") await deleteModel(target.value.id);
      if (target.kind === "assignment") await deleteAssignment(target.value);
      return target;
    },
    onSuccess: (target) => {
      setDeleteTarget(null);
      setNotice(target.kind === "assignment" ? t("settings.notices.assignmentRemoved") : t("settings.notices.recordDeleted"));
      if (target.kind === "provider") {
        setSelectedProviderId(null);
        void queryClient.invalidateQueries({ queryKey: ["providers"] });
      }
      if (target.kind === "model") void queryClient.invalidateQueries({ queryKey: ["models"] });
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
    },
  });
  const probeMutation = useMutation({
    mutationFn: (input: { providerId: string; modelId: string }) => probeProvider(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["models"] }),
  });

  const writingAssignment = assignments.find((entry) => entry.role === "writing");
  const enabledProviderIds = new Set(
    providers.filter((provider) => provider.enabled).map((provider) => provider.id),
  );
  const assignable = (model: ModelConfigDto) => model.enabled && enabledProviderIds.has(model.providerId);
  const generationModels = allModels.filter(
    (model) => assignable(model) && ["writing", "planning", "review"].includes(model.taskType),
  );
  const assignmentSourcesPending =
    providersQuery.isPending || modelsQuery.isPending || assignmentsQuery.isPending;
  const assignmentSourcesError =
    providersQuery.error ?? modelsQuery.error ?? assignmentsQuery.error;
  const renderRole = (role: AssignmentRole) => {
    const assignment = assignments.find((entry) => entry.role === role);
    return (
      <RoleCard
        key={role}
        role={role}
        assignedModel={assignment ? allModels.find((model) => model.id === assignment.modelId) : undefined}
        assignmentModelId={assignment?.modelId}
        inheritedModel={role === "planning" || role === "review" ? allModels.find((model) => model.id === writingAssignment?.modelId) : undefined}
        inherited={role === "planning" || role === "review"}
        providers={providers}
        candidates={role === "embedding"
          ? allModels.filter((model) => assignable(model) && model.taskType === "embedding")
          : generationModels}
        pending={assignMutation.isPending && assignMutation.variables?.role === role}
        error={assignMutation.variables?.role === role ? assignMutation.error : null}
        onAssign={(modelId) => assignMutation.mutate({ role, modelId })}
        onRemove={() => setDeleteTarget({ kind: "assignment", value: role })}
      />
    );
  };

  return (
    <div className="settings">
      <PageBand
        index="SETTINGS · S1"
        title={t("settings.title")}
        meta={
          <span className="settings__band-meta">
            {contextProjectId ? <Link to={returnPath}><ArrowLeft size={12} aria-hidden="true" />{t("settings.backToProject")}</Link> : null}
            <span className="mono">
              {t("settings.band.counts", {
                providers: providers.length,
                models: allModels.length,
                status: writingAssignment ? t("settings.band.defaultSet") : t("settings.band.defaultUnset"),
              })}
            </span>
          </span>
        }
      />
      {notice ? <p className="settings__notice" role="status" aria-live="polite">{notice}</p> : null}

      <section className="settings__section" aria-label={t("settings.uiLanguage.label")}>
        <header className="settings__section-head">
          <div><p className="mono">LANGUAGE</p><h2>{t("settings.uiLanguage.label")}</h2></div>
          <p className="settings__section-note">{t("settings.uiLanguage.hint")}</p>
        </header>
        <div className="settings__language">
          {LOCALES.map((option) => (
            <button
              key={option}
              type="button"
              className="settings__language-option"
              data-active={option === locale ? "true" : "false"}
              aria-pressed={option === locale}
              onClick={() => setLocale(option)}
            >
              {LOCALE_LABELS[option]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section" aria-label={t("settings.generation.label")}>
        <header className="settings__section-head">
          <div><p className="mono">GENERATION</p><h2>{t("settings.generation.label")}</h2></div>
          <p className="settings__section-note">{t("settings.generation.hint")}</p>
        </header>
        <div className="settings__roles">
          {assignmentSourcesPending ? <Skeleton lines={3} /> : assignmentSourcesError ? (
            <ErrorNote error={assignmentSourcesError} title={t("settings.generation.loadError")} />
          ) : PRIMARY_ROLES.map(renderRole)}
        </div>
        {!assignmentSourcesPending && !assignmentSourcesError ? (
          <details className="settings__advanced-roles">
            <summary>{t("settings.generation.advancedSummary")}</summary>
            <p>{t("settings.generation.advancedHint")}</p>
            <div className="settings__roles">{ADVANCED_ROLES.map(renderRole)}</div>
          </details>
        ) : null}
      </section>

      <details className="settings__channel-management" aria-label={t("settings.channels.label")}>
        <summary>
          <span className="settings__channel-summary-copy">
            <span className="mono">CHANNELS</span>
            <strong>{t("settings.channels.label")}</strong>
            <span>{t("settings.channels.summaryHint")}</span>
          </span>
          <span className="settings__channel-summary-meta mono">
            {t("settings.channels.counts", { providers: providers.length, models: allModels.length })}
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <p className="settings__channel-note">{t("settings.channels.note")}</p>
        <div className="supply__layout">
        <section className="supply__column" aria-label={t("settings.channels.providersLabel")}>
          <header className="supply__column-head">
            <span className="supply__column-eyebrow">CHANNEL</span>
            <p className="supply__column-title">{t("settings.channels.providersLabel")}</p>
            <button type="button" className="supply__mini-action" onClick={() => setProviderEditor("new")}>
              <Plus size={12} aria-hidden="true" /> {t("settings.channels.add")}
            </button>
          </header>
          <div className="supply__column-body">
            {currentProviderEditor ? (
              <ProviderForm
                key={currentProviderEditor === "new" ? "new" : currentProviderEditor.id}
                provider={currentProviderEditor === "new" ? null : currentProviderEditor}
                pending={providerMutation.isPending}
                error={providerMutation.error}
                onCancel={() => setProviderEditor(null)}
                onSubmit={(value) => providerMutation.mutate({ current: currentProviderEditor === "new" ? null : currentProviderEditor, value })}
              />
            ) : null}
            {providersQuery.isPending ? <Skeleton lines={4} /> : providersQuery.isError ? (
              <ErrorNote error={providersQuery.error} title={t("settings.channels.providersLoadError")} />
            ) : providers.length === 0 ? (
              <p className="supply__empty">{t("settings.channels.emptyProviders")}</p>
            ) : providers.map((provider) => (
              <div key={provider.id} className="supply__provider-wrap" data-active={provider.id === selectedProviderId}>
                <button type="button" className="supply__provider" onClick={() => setSelectedProviderId(provider.id)}>
                  <span className="supply__provider-name">{provider.name}</span>
                  <span className="supply__provider-kind">{wireApiLabel(provider.wireApi)}</span>
                  <span className="supply__provider-base mono">{provider.baseUrl}</span>
                  <span className="supply__provider-foot">
                    <span className="supply__provider-status" data-on={provider.enabled}>{provider.enabled ? t("settings.state.enabled") : t("settings.state.disabled")}</span>
                    <span>{t("settings.channels.modelCount", { count: allModels.filter((model) => model.providerId === provider.id).length })}</span>
                  </span>
                </button>
                <div className="supply__item-actions">
                  <button type="button" className="supply__icon-action" aria-label={t("settings.channels.editProviderAria", { name: provider.name })} onClick={() => setProviderEditor(provider)}><Edit3 size={13} /></button>
                  <button type="button" className="supply__icon-action" aria-label={t("settings.channels.deleteProviderAria", { name: provider.name })} onClick={() => setDeleteTarget({ kind: "provider", value: provider })}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="supply__column" aria-label={t("settings.channels.modelsLabel")}>
          <header className="supply__column-head">
            <span className="supply__column-eyebrow">Model</span>
            <p className="supply__column-title">{selectedProvider ? t("settings.channels.modelsTitle", { name: selectedProvider.name }) : t("settings.channels.modelsTitleEmpty")}</p>
            <button type="button" className="supply__mini-action" disabled={!selectedProvider} onClick={() => setModelEditor("new")}>
              <Plus size={12} aria-hidden="true" /> {t("settings.channels.add")}
            </button>
          </header>
          <div className="supply__column-body">
            {currentModelEditor && selectedProvider ? (
              <ModelForm
                key={currentModelEditor === "new" ? `new-${selectedProvider.id}` : currentModelEditor.id}
                providerId={selectedProvider.id}
                model={currentModelEditor === "new" ? null : currentModelEditor}
                pending={modelMutation.isPending}
                error={modelMutation.error}
                onCancel={() => setModelEditor(null)}
                onSubmit={(value) => modelMutation.mutate({ current: currentModelEditor === "new" ? null : currentModelEditor, value })}
              />
            ) : null}
            {!selectedProvider ? <p className="supply__empty">{t("settings.channels.emptyPickProvider")}</p> : modelsQuery.isPending ? (
              <Skeleton lines={4} />
            ) : modelsQuery.isError ? <ErrorNote error={modelsQuery.error} title={t("settings.channels.modelsLoadError")} /> : models.length === 0 ? (
              <p className="supply__empty">{t("settings.channels.emptyModels")}</p>
            ) : models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                onEdit={() => setModelEditor(model)}
                onDelete={() => setDeleteTarget({ kind: "model", value: model })}
                onProbe={() => probeMutation.mutate({ providerId: model.providerId, modelId: model.id })}
                probePending={probeMutation.isPending && probeMutation.variables?.modelId === model.id}
                probeData={probeMutation.data?.modelId === model.id ? probeMutation.data : undefined}
                probeError={probeMutation.variables?.modelId === model.id ? probeMutation.error : null}
              />
            ))}
          </div>
        </section>
        </div>
      </details>

      <section className="settings__section" aria-label={t("settings.tools.label")}>
        <header className="settings__section-head">
          <div><p className="mono">ADVANCED</p><h2>{t("settings.tools.label")}</h2></div>
          <p className="settings__section-note">
            {trialMode ? t("settings.tools.hintTrial") : t("settings.tools.hintFull")}
          </p>
        </header>
        <div className="settings__tools-links">
          {projectsQuery.isPending ? (
            <Skeleton lines={2} />
          ) : projectsQuery.isError ? (
            <ErrorNote error={projectsQuery.error} title={t("settings.tools.projectsLoadError")} />
          ) : toolsProject ? (
            <>
              <Link className="settings__tool-link" to={projectWorkspacePath(toolsProject.id, "runs")}>{t("settings.tools.runsLink", { title: toolsProject.title })}</Link>
              <Link className="settings__tool-link" to={projectWorkspacePath(toolsProject.id, "lab")}>{t("settings.tools.labLink", { title: toolsProject.title })}</Link>
            </>
          ) : (
            <p className="supply__empty">{t("settings.tools.emptyProjects")}</p>
          )}
          {!projectsQuery.isPending && !projectsQuery.isError && projects.length > 0 ? (
            <label className="settings__project-pick">
              {t("settings.tools.assetProjectLabel")}
              <select value={toolsProject?.id ?? ""} onChange={(event) => setToolsProjectId(event.target.value || null)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.title}{project.subtitle ? ` · ${project.subtitle}` : ""} · {shortId(project.id)}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {!projectsQuery.isPending && !projectsQuery.isError && toolsProject ? (
          <ProductionTools key={toolsProject.id} projectId={toolsProject.id} />
        ) : null}
      </section>

      <section className="settings__section" aria-label={t("settings.driver.label")}>
        <header className="settings__section-head">
          <div><p className="mono">DRIVER</p><h2>{t("settings.driver.label")}</h2></div>
          <p className="settings__section-note">
            {t("settings.driver.note", {
              mode: driverMode === "local"
                ? t("settings.driver.modeLocal")
                : driverMode === "server"
                  ? t("settings.driver.modeServer")
                  : t("settings.driver.modeProbing"),
            })}
          </p>
        </header>
        <DriverSwitch />
      </section>

      {trialMode ? null : <SystemBackupsSection />}

      {deleteTarget ? (
        <ConfirmDialog
          title={deleteTarget.kind === "assignment" ? t("settings.confirm.unassignTitle") : t("settings.confirm.deleteTitle")}
          confirmLabel={deleteTarget.kind === "assignment" ? t("settings.confirm.unassignAction") : t("common.action.delete")}
          danger
          pending={removeMutation.isPending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => removeMutation.mutate(deleteTarget)}
        >
          <p>{deleteDescription(deleteTarget)}</p>
          {removeMutation.isError ? <ErrorNote error={removeMutation.error} title={t("settings.confirm.errorTitle")} /> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/* ---- 运行驱动（M3：server API / 浏览器本地内核） ----------------------------- */

function useDriverMode(): DriverMode {
  const [mode, setMode] = useState(currentDriverMode());
  useEffect(() => {
    void resolveDriverMode();
    return onDriverModeChange(setMode);
  }, []);
  return mode;
}

function DriverSwitch() {
  const { t } = useI18n();
  const mode = useDriverMode();
  const override = readDriverOverride();
  const [pendingReload, setPendingReload] = useState(false);
  const [storageState, setStorageState] = useState<
    "unknown" | "granted" | "denied"
  >("unknown");
  const [storageEstimate, setStorageEstimate] = useState<{
    usage: number;
    quota: number;
  } | null>(null);
  const [lastExportAt, setLastExportAt] = useState<string | null>(() =>
    window.localStorage.getItem("narralume:local-db-last-export"),
  );
  const effective = override ?? mode;
  useEffect(() => {
    if (effective !== "local" || !navigator.storage) return;
    let active = true;
    void Promise.all([
      navigator.storage.persisted(),
      navigator.storage.estimate(),
    ]).then(([persisted, estimate]) => {
      if (!active) return;
      setStorageState(persisted ? "granted" : "denied");
      if (estimate.usage !== undefined && estimate.quota !== undefined)
        setStorageEstimate({ usage: estimate.usage, quota: estimate.quota });
    });
    return () => {
      active = false;
    };
  }, [effective]);
  const downloadMutation = useMutation({
    mutationFn: async () => {
      // 下载我的库（D6）：local 驱动从内核取 bytes；server 驱动提示用系统备份。
      const { blob, filename } = await downloadLibraryDatabase();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename ?? "narralume.sqlite";
      anchor.click();
      URL.revokeObjectURL(url);
      const exportedAt = new Date().toISOString();
      window.localStorage.setItem("narralume:local-db-last-export", exportedAt);
      setLastExportAt(exportedAt);
    },
  });
  const requestPersistence = async () => {
    if (!navigator.storage?.persist) return;
    const granted = await navigator.storage.persist();
    setStorageState(granted ? "granted" : "denied");
  };
  return (
    <div className="settings__tools-links">
      <label className="settings__project-pick">
        {t("settings.driver.label")}
        <select
          value={override ?? "auto"}
          disabled={pendingReload}
          onChange={(event) => {
            const next = event.target.value;
            setDriverOverride(next === "auto" ? null : (next as "server" | "local"));
            setPendingReload(true);
            window.location.reload();
          }}
        >
          <option value="auto">{t("settings.driver.optionAuto")}</option>
          <option value="server">{t("settings.driver.optionServer")}</option>
          <option value="local">{t("settings.driver.optionLocal")}</option>
        </select>
      </label>
      <button
        type="button"
        className="settings__tool-link"
        disabled={effective !== "local" || downloadMutation.isPending}
        title={effective === "local" ? t("settings.driver.downloadTitleLocal") : t("settings.driver.downloadTitleOther")}
        onClick={() => downloadMutation.mutate()}
      >
        {downloadMutation.isPending ? t("settings.driver.downloading") : t("settings.driver.downloadAction")}
      </button>
      {downloadMutation.isError ? (
        <ErrorNote error={downloadMutation.error} title={t("settings.driver.exportErrorTitle")} />
      ) : null}
      <p className="settings__section-note">
        {t("settings.driver.effectiveLabel", {
          mode: effective === "local"
            ? t("settings.driver.optionLocal")
            : effective === "server"
              ? t("settings.driver.optionServer")
              : t("settings.driver.modeProbing"),
        })}
        {override ? t("settings.driver.sourceManual") : t("settings.driver.sourceAuto")}
      </p>
      {effective === "local" ? (
        <>
          <p className="settings__section-note">{t("settings.driver.opfsNote")}</p>
          <p className="settings__section-note">
            {t("settings.driver.persistenceState", {
              state: storageState === "granted"
                ? t("settings.driver.persistenceGranted")
                : storageState === "denied"
                  ? t("settings.driver.persistenceDenied")
                  : t("settings.driver.persistenceReading"),
            })}
            {storageEstimate
              ? t("settings.driver.storageUsage", {
                  usage: formatBytes(storageEstimate.usage),
                  quota: formatBytes(storageEstimate.quota),
                })
              : ""}
            {lastExportAt
              ? t("settings.driver.lastExport", { date: formatRelativeDate(lastExportAt) })
              : t("settings.driver.noExport")}
          </p>
          <button
            type="button"
            className="settings__tool-link"
            onClick={() => void requestPersistence()}
            disabled={storageState === "granted" || !navigator.storage?.persist}
          >
            {storageState === "granted" ? t("settings.driver.persistGrantedAction") : t("settings.driver.persistRequestAction")}
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ---- 系统备份档（从交付迁入：整库备份、校档与灾备恢复） ---------------------- */

function SystemBackupsSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const systemBackupsQuery = useQuery({
    queryKey: ["system-backups"],
    queryFn: ({ signal }) => getSystemBackups(signal),
    staleTime: 10_000,
  });
  const [previewBackupId, setPreviewBackupId] = useState<string | null>(null);
  const [systemRestoreTarget, setSystemRestoreTarget] = useState<SystemBackupPreview | null>(null);
  const [restoreDirectory, setRestoreDirectory] = useState("");
  const [systemRestoreResult, setSystemRestoreResult] = useState<string | null>(null);

  const backupCreateMutation = useMutation({
    mutationFn: (label: string) => createSystemBackup(label),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["system-backups"] }),
  });
  const backupPreviewMutation = useMutation({
    mutationFn: (backupId: string) => previewSystemBackup(backupId),
    onSuccess: (data) => setPreviewBackupId(data.manifest.id),
  });
  const systemRestoreMutation = useMutation({
    mutationFn: () => restoreSystemBackup(systemRestoreTarget!.manifest.id, restoreDirectory.trim(), false),
    onSuccess: (result) => {
      setSystemRestoreResult(t("settings.backups.restoreResult", { path: result.databasePath, hash: result.sha256 }));
      setSystemRestoreTarget(null);
      setRestoreDirectory("");
    },
  });

  const backups = useMemo(() => systemBackupsQuery.data ?? [], [systemBackupsQuery.data]);

  return (
    <section className="settings__section delivery__section--backups" aria-label={t("settings.backups.label")}>
      <header className="settings__section-head">
        <div>
          <p className="mono">DISASTER</p>
          <h2><Archive size={13} strokeWidth={2} aria-hidden="true" /> {t("settings.backups.label")}</h2>
        </div>
        <button
          type="button"
          className="delivery__backup-new"
          onClick={() => backupCreateMutation.mutate(t("settings.backups.createLabel", { date: new Date().toISOString().slice(0, 16) }))}
          disabled={backupCreateMutation.isPending}
          aria-label={t("settings.backups.createAria")}
        >
          <Plus size={12} strokeWidth={2} aria-hidden="true" />
          {t("settings.backups.createAction")}
        </button>
      </header>
      {systemBackupsQuery.isPending ? (
        <Skeleton lines={3} />
      ) : systemBackupsQuery.isError ? (
        <ErrorNote error={systemBackupsQuery.error} title={t("settings.backups.loadError")} />
      ) : backups.length === 0 ? (
        <p className="delivery__empty">{t("settings.backups.empty")}</p>
      ) : (
        <ol className="delivery__backups">
          {backups.map((backup) => (
            <li key={backup.id} className="delivery__backup-row">
              <span className="delivery__backup-label">{backup.label}</span>
              <span className="delivery__backup-meta mono">
                {t("settings.backups.meta", {
                  size: formatBytes(backup.sizeBytes),
                  pages: backup.pageCount,
                  projects: backup.projectCount,
                  date: formatRelativeDate(backup.createdAt),
                })}
              </span>
              <span className="delivery__backup-hash mono">{shortHash(backup.sha256)}</span>
              <button
                type="button"
                className="delivery__backup-preview-btn"
                onClick={() => backupPreviewMutation.mutate(backup.id)}
                disabled={backupPreviewMutation.isPending}
                aria-label={t("settings.backups.previewAria", { label: backup.label })}
              >
                <FileCheck2 size={12} strokeWidth={2} aria-hidden="true" />
                {t("settings.backups.previewAction")}
              </button>
            </li>
          ))}
        </ol>
      )}
      {previewBackupId ? (
        <BackupPreviewPane
          backupId={previewBackupId}
          preview={backupPreviewMutation.data ?? null}
          onClose={() => setPreviewBackupId(null)}
          onRestore={(preview) => {
            setSystemRestoreTarget(preview);
            setRestoreDirectory("");
          }}
        />
      ) : null}
      {systemRestoreResult ? <p className="delivery__restore-result" role="status">{systemRestoreResult}</p> : null}
      {systemRestoreTarget ? (
        <ConfirmDialog
          title={t("settings.backups.restoreTitle")}
          confirmLabel={t("settings.backups.restoreConfirm")}
          danger
          pending={systemRestoreMutation.isPending}
          confirmDisabled={!restoreDirectory.trim()}
          onCancel={() => setSystemRestoreTarget(null)}
          onConfirm={() => systemRestoreMutation.mutate()}
        >
          <p>{t("settings.backups.verifyHash", { hash: systemRestoreTarget.manifest.sha256 })}</p>
          <p>
            {t("settings.backups.restoreInfo", {
              check: systemRestoreTarget.integrityCheck,
              violations: systemRestoreTarget.foreignKeyViolations,
              projects: systemRestoreTarget.counts.projects,
            })}
          </p>
          <label className="delivery__restore-directory">{t("settings.backups.directoryLabel")}<input value={restoreDirectory} onChange={(event) => setRestoreDirectory(event.target.value)} placeholder="E:\\novel-restored-data" /></label>
          {!restoreDirectory.trim() ? <p className="delivery__restore-warning">{t("settings.backups.directoryWarning")}</p> : null}
          {systemRestoreMutation.isError ? <ErrorNote error={systemRestoreMutation.error} title={t("settings.backups.restoreErrorTitle")} /> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function BackupPreviewPane({
  backupId,
  preview,
  onClose,
  onRestore,
}: {
  backupId: string;
  preview: SystemBackupPreview | null;
  onClose: () => void;
  onRestore: (preview: SystemBackupPreview) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="delivery__backup-preview" role="note">
      <header className="delivery__backup-preview-head">
        <p className="delivery__backup-preview-title mono">
          {t("settings.backups.previewTitle", { id: backupId.slice(0, 8) })}
        </p>
        <button type="button" onClick={onClose} aria-label={t("settings.backups.closeAria")}>
          {t("settings.backups.closeAction")}
        </button>
      </header>
      {!preview ? (
        <Skeleton lines={2} />
      ) : (
        <dl className="delivery__backup-preview-body">
          <div>
            <dt>{t("settings.backups.labelLabel")}</dt>
            <dd className="mono">{preview.manifest.label}</dd>
          </div>
          <div>
            <dt>{t("settings.backups.hashLabel")}</dt>
            <dd className="mono">{shortHash(preview.manifest.sha256)}</dd>
          </div>
          <div>
            <dt>{t("settings.backups.archiveLabel")}</dt>
            <dd>
              {t("settings.backups.archiveInfo", {
                time: formatTime(preview.manifest.createdAt),
                size: formatBytes(preview.manifest.sizeBytes),
                pages: preview.manifest.pageCount,
              })}
            </dd>
          </div>
          <div>
            <dt>{t("settings.backups.hashCheckLabel")}</dt>
            <dd data-ok={preview.hashMatches}>
              {preview.hashMatches ? t("settings.backups.hashOk") : t("settings.backups.hashBad")}
            </dd>
          </div>
          <div>
            <dt>{t("settings.backups.integrityLabel")}</dt>
            <dd>{preview.integrityCheck}</dd>
          </div>
          <div>
            <dt>{t("settings.backups.violationsLabel")}</dt>
            <dd data-ok={preview.foreignKeyViolations === 0}>
              {preview.foreignKeyViolations}
            </dd>
          </div>
          <div>
            <dt>{t("settings.backups.countsLabel")}</dt>
            <dd>
              {t("settings.backups.countsValue", {
                projects: preview.counts.projects,
                documents: preview.counts.documents,
                versions: preview.counts.versions,
                canon: preview.counts.canonFacts,
                runs: preview.counts.runs,
              })}
            </dd>
          </div>
        </dl>
      )}
      {preview?.valid && preview.hashMatches && preview.foreignKeyViolations === 0 ? <button type="button" className="btn btn--primary" onClick={() => onRestore(preview)}>{t("settings.backups.restoreAction")}</button> : null}
    </div>
  );
}

/* ---- Provider / 模型管理（从供给迁入） --------------------------------------- */

function ProviderForm({ provider, pending, error, onCancel, onSubmit }: {
  provider: PublicProviderDto | null;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (value: UpsertProviderRequest) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(provider?.name ?? "");
  const [wireApi, setWireApi] = useState<WireApi>(provider?.wireApi ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [endpoint, setEndpoint] = useState(provider?.endpoint ?? "");
  const [credentialRef, setCredentialRef] = useState("");
  const [anthropicVersion, setAnthropicVersion] = useState(provider?.anthropicVersion ?? "");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!provider && !credentialRef.trim()) {
      setLocalError(t("settings.provider.credentialRequired"));
      return;
    }
    const value: UpsertProviderRequest = {
      name: name.trim(), wireApi, baseUrl: baseUrl.trim(), endpoint: endpoint.trim() || null,
      anthropicVersion: anthropicVersion.trim() || null, headers: provider?.headers ?? {},
      queryParams: provider?.queryParams ?? {}, requestStartTimeoutMs: provider?.requestStartTimeoutMs ?? null,
      streamIdleTimeoutMs: provider?.streamIdleTimeoutMs ?? null, enabled,
      ...(credentialRef.trim() ? { credentialRef: credentialRef.trim() } : {}),
    };
    onSubmit(value);
  };
  return (
    <form className="supply__editor" onSubmit={submit}>
      <h3>{provider ? t("settings.provider.formTitleEdit") : t("settings.provider.formTitleNew")}</h3>
      <label>{t("settings.provider.nameLabel")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("settings.provider.protocolLabel")}<select value={wireApi} onChange={(event) => setWireApi(event.target.value as WireApi)}>{WIRE_APIS.map((value) => <option key={value} value={value}>{wireApiLabel(value)}</option>)}</select></label>
      <label>Base URL<input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label>{t("settings.provider.endpointLabel")}<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
      <label>{provider ? t("settings.provider.credentialLabelEdit") : t("settings.provider.credentialLabelNew")}<input type="password" value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} autoComplete="off" /></label>
      {wireApi === "anthropic-messages" ? <label>Anthropic Version<input value={anthropicVersion} onChange={(event) => setAnthropicVersion(event.target.value)} /></label> : null}
      <label className="supply__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("common.action.enable")}</label>
      {localError ? <p className="supply__local-error" role="alert">{localError}</p> : null}
      {error ? <ErrorNote error={error} title={t("settings.provider.saveErrorTitle")} /> : null}
      <div className="supply__editor-actions"><button type="button" className="btn" onClick={onCancel}>{t("common.action.cancel")}</button><button type="submit" className="btn btn--primary" disabled={pending}>{pending ? t("common.state.saving") : t("common.action.save")}</button></div>
    </form>
  );
}

function ModelForm({ providerId, model, pending, error, onCancel, onSubmit }: {
  providerId: string;
  model: ModelConfigDto | null;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (value: UpsertModelRequest) => void;
}) {
  const { t } = useI18n();
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  const [taskType, setTaskType] = useState<ModelTaskType>(model?.taskType ?? "writing");
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(model?.maxOutputTokens?.toString() ?? "");
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  return (
    <form className="supply__editor" onSubmit={(event) => {
      event.preventDefault();
      onSubmit({
        providerId, modelId: modelId.trim(), taskType,
        contextWindow: contextWindow ? Number(contextWindow) : null,
        maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null,
        sampling: model?.sampling ?? {}, capabilities: model?.capabilities ?? {}, enabled,
      });
    }}>
      <h3>{model ? t("settings.model.formTitleEdit") : t("settings.model.formTitleNew")}</h3>
      <label>{t("settings.model.modelIdLabel")}<input required value={modelId} onChange={(event) => setModelId(event.target.value)} /></label>
      <label>{t("settings.model.taskTypeLabel")}<select value={taskType} onChange={(event) => setTaskType(event.target.value as ModelTaskType)}>{TASK_TYPES.map((value) => <option key={value} value={value}>{assignmentRoleLabel(value)}</option>)}</select><span className="supply__field-hint">{t("settings.model.taskTypeHint")}</span></label>
      <label>{t("settings.model.contextLabel")}<input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder={t("settings.model.limitPlaceholder")} /></label>
      <label>{t("settings.model.outputLabel")}<input type="number" min="1" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder={t("settings.model.limitPlaceholder")} /></label>
      <label className="supply__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("common.action.enable")}</label>
      {error ? <ErrorNote error={error} title={t("settings.model.saveErrorTitle")} /> : null}
      <div className="supply__editor-actions"><button type="button" className="btn" onClick={onCancel}>{t("common.action.cancel")}</button><button type="submit" className="btn btn--primary" disabled={pending}>{pending ? t("common.state.saving") : t("common.action.save")}</button></div>
    </form>
  );
}

function ModelCard({ model, onEdit, onDelete, onProbe, probePending, probeData, probeError }: {
  model: ModelConfigDto;
  onEdit: () => void;
  onDelete: () => void;
  onProbe: () => void;
  probePending: boolean;
  probeData: ProviderProbeResult | undefined;
  probeError: unknown;
}) {
  const { t } = useI18n();
  const lacksLimits = model.contextWindow === null || model.maxOutputTokens === null;
  return (
    <article className="supply__model" data-enabled={model.enabled} aria-label={t("settings.model.cardAria", { id: model.modelId })}>
      <div className="supply__model-head"><span className="supply__model-id">{model.modelId}</span><span className="supply__model-task">{assignmentRoleLabel(model.taskType)}</span></div>
      <div className="supply__model-meta">
        <span><strong>{model.contextWindow === null ? t("common.state.unknown") : model.contextWindow === 0 ? "0" : `${Math.round(model.contextWindow / 1000)}k`}</strong> {t("settings.model.context")}</span>
        <span><strong>{model.maxOutputTokens === null ? t("common.state.unknown") : model.maxOutputTokens === 0 ? "0" : `${Math.round(model.maxOutputTokens / 1000)}k`}</strong> {t("settings.model.output")}</span>
        <span>{model.enabled ? t("settings.state.enabled") : t("settings.state.disabled")}</span><span>{metadataSourceLabel(model.metadataSource)}</span>
        {model.metadataStale ? <span className="supply__warn">{t("settings.model.metadataStale")}</span> : null}
      </div>
      {lacksLimits && ["writing", "planning", "review"].includes(model.taskType) ? <p className="supply__model-missing">{t("settings.model.limitsMissing")}</p> : null}
      <div className="supply__item-actions supply__item-actions--model">
        <button type="button" className="btn" onClick={onProbe} disabled={probePending}><Radio size={12} /> {probePending ? t("settings.model.probing") : t("settings.model.probe")}</button>
        <button type="button" className="btn" onClick={onEdit}><Edit3 size={12} /> {t("common.action.edit")}</button>
        <button type="button" className="btn" onClick={onDelete}><Trash2 size={12} /> {t("common.action.delete")}</button>
      </div>
      {probeError ? <ErrorNote error={probeError} title={t("settings.model.probeErrorTitle")} /> : null}
      {probeData ? <ProbeReport result={probeData} /> : null}
    </article>
  );
}

function ProbeReport({ result }: { result: ProviderProbeResult }) {
  const { t } = useI18n();
  return (
    <div className="supply__probe"><p className="supply__probe-title">{t("settings.model.probeReportTitle")}</p><div className="supply__probe-body">
      {result.stages.map((stage) => <div key={stage.stage} className="supply__probe-row">
        <span className="supply__probe-stage">{probeStageLabel(stage.stage)}</span>
        <span className="supply__probe-status" data-s={stage.status}>{probeStageStatusLabel(stage.status)}</span>
        <span className="supply__probe-latency">{stage.latencyMs} ms</span>
        <span className="supply__probe-detail">{stage.detail}</span>
      </div>)}
    </div></div>
  );
}

/* ---- 岗位卡：含继承语义的生成模型岗 ------------------------------------------- */

function RoleCard({ role, assignedModel, assignmentModelId, inheritedModel, inherited, providers, candidates, pending, error, onAssign, onRemove }: {
  role: AssignmentRole;
  assignedModel: ModelConfigDto | undefined;
  assignmentModelId: string | undefined;
  inheritedModel: ModelConfigDto | undefined;
  inherited: boolean;
  providers: PublicProviderDto[];
  candidates: ModelConfigDto[];
  pending: boolean;
  error: unknown;
  onAssign: (modelId: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const inheritedActive = inherited && !assignmentModelId && inheritedModel;
  return (
    <div className="supply__role" role="group" aria-label={roleCopy(role).name}>
      <div className="supply__role-head">
        <span className="supply__role-name">{roleCopy(role).name}</span>
        <span className="supply__role-status" data-ready={Boolean(assignmentModelId) || Boolean(inheritedActive)}>
          {assignmentModelId ? t("settings.roleCard.statusAssigned") : inheritedActive ? t("settings.roleCard.statusInherited") : t("settings.roleCard.statusPending")}
        </span>
      </div>
      <p className="supply__role-description">{roleCopy(role).note}</p>
      <div className="supply__role-model" data-unset={!assignmentModelId}>
        {assignedModel ? <><strong>{modelDisplayName(assignedModel, providers)}</strong> · {assignedModel.enabled ? t("settings.state.enabled") : t("settings.state.disabled")}</> : assignmentModelId ? <>{t("settings.roleCard.staleConfig")}</> : inheritedActive ? <>{t("settings.roleCard.inheritFrom", { name: modelDisplayName(inheritedModel, providers) })}</> : <>{t("settings.roleCard.notConnected")}</>}
      </div>
      <div className="supply__role-actions">
        {candidates.map((model) => <button key={model.id} type="button" className="supply__role-assign-btn" disabled={pending || model.id === assignmentModelId} onClick={() => onAssign(model.id)}><Network size={12} /> {modelDisplayName(model, providers)}</button>)}
        {assignmentModelId ? <button type="button" className="supply__role-assign-btn" disabled={pending} onClick={onRemove}><Unplug size={12} /> {inherited ? t("settings.roleCard.unassignOverride") : t("settings.roleCard.unassign")}</button> : null}
      </div>
      {candidates.length === 0 ? <p className="supply__role-empty">{t("settings.roleCard.emptyCandidates")}</p> : null}
      {error ? <ErrorNote error={error} title={t("settings.roleCard.assignError")} /> : null}
    </div>
  );
}

function deleteDescription(target: DeleteTarget): string {
  const locale = getLocale();
  if (target.kind === "assignment") {
    const role = roleCopy(target.value).name;
    return target.value === "writing"
      ? translate(locale, "settings.confirm.unassignWriting", { role })
      : translate(locale, "settings.confirm.unassignOther", { role });
  }
  if (target.kind === "provider") {
    return translate(locale, "settings.confirm.deleteProvider", { name: target.value.name });
  }
  return translate(locale, "settings.confirm.deleteModel", { name: target.value.modelId });
}

function modelDisplayName(model: ModelConfigDto | undefined, providers: PublicProviderDto[]): string {
  const locale = getLocale();
  if (!model) return translate(locale, "settings.modelNames.unknownModel");
  const channelName = providers.find((provider) => provider.id === model.providerId)?.name
    ?? translate(locale, "settings.modelNames.unknownChannel");
  return `${channelName} · ${model.modelId}`;
}

function safeProjectReturnPath(projectId: string | null, requestedPath: string | null): string {
  if (!projectId) return "/shelf";
  const projectRoot = `/projects/${encodeURIComponent(projectId)}/`;
  return requestedPath?.startsWith(projectRoot)
    ? requestedPath
    : `${projectRoot}overview`;
}
