import "../styles/studio.css";
import "../styles/review.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Check,
  MessageSquarePlus,
  Plus,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { ConfirmDialog } from "../components/confirm-dialog";
import { publishAssistantContext } from "../app/assistant-page-context";
import { Empty } from "../components/empty";
import { ErrorNote } from "../components/error-note";
import { PageBand } from "../components/page-band";
import { ProjectRequiredState } from "../components/project-required-state";
import { Skeleton } from "../components/skeleton";
import {
  appendDocumentVersion,
  ApiError,
  createChapterRun,
  createDocumentReview,
  createDocumentComment,
  createSelectionEdit,
  createStoryDocument,
  decideCanonChangeSet,
  decideEditProposal,
  decideReviewIssue,
  decideRevisionProposal,
  getCanonChangeSets,
  getProjectOverview,
  getProjectRuns,
  getRunDetail,
  getReviewWorkspace,
  getStoryBible,
  getStudioDocument,
  getStudioDocuments,
  restoreDocumentVersion,
  saveDocumentDraft,
  setStoryDocumentArchived,
  setDocumentCommentStatus,
  type CanonChangeSetView,
  type DocumentComment,
  type DocumentDraft,
  type DocumentVersion,
  type EditProposal,
  type OutlineNode,
  type ReviewRevisionProposal,
  type ReviewWorkspace,
  type ReviewWorkspaceIssue,
  type ReviewWorkspaceReport,
  type StoryDocument,
  type StudioDocumentDetail,
} from "../lib/api";
import { formatRelativeDate } from "../lib/fmt";
import { getLocale, translate, useI18n, type MessageKey } from "../i18n";
import {
  documentKindLabel,
  reviewCategoryLabel,
  reviewIssueActionLabel,
  reviewIssueStatusLabel,
  reviewVerdictLabel,
} from "../lib/labels";
import { projectWorkspacePath, useProjectId } from "../lib/project-route";
import { useServerEvents } from "../lib/sse";
import { rememberTask, rememberedTasks } from "../lib/task-ledger";
import { CoCreateWorkspace } from "./studio/cocreate";
import { WritingTaskPanel } from "./studio/task-panel";

type CreateDocumentInput = {
  kind: StoryDocument["kind"];
  title: string;
  outlineNodeId: string | null;
};

type FlushDraft = () => Promise<boolean>;

type StudioTool =
  | "review"
  | "revisions"
  | "canon"
  | "comments"
  | "versions"
  | "selection";

const STUDIO_TOOLS: Array<{ id: StudioTool; labelKey: MessageKey }> = [
  { id: "review", labelKey: "studio.tools.review" },
  { id: "revisions", labelKey: "studio.tools.revisions" },
  { id: "canon", labelKey: "studio.tools.canon" },
  { id: "comments", labelKey: "studio.tools.comments" },
  { id: "versions", labelKey: "studio.tools.versions" },
  { id: "selection", labelKey: "studio.tools.selection" },
];

function studioToolFromFocus(value: string | null): StudioTool {
  if (value === "canon") return "canon";
  if (value === "revisions") return "revisions";
  if (value === "comments") return "comments";
  if (value === "versions") return "versions";
  if (value === "selection") return "selection";
  return "review";
}

export function StudioWorkspace() {
  const { t } = useI18n();
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [showRecycle, setShowRecycle] = useState(false);
  const mode = searchParams.get("mode") === "cocreate" ? "cocreate" : "manual";
  const requestedSessionId = searchParams.get("session");
  const flushDraftRef = useRef<FlushDraft | null>(null);
  const createRequestRef = useRef<{ identity: string; requestId: string } | null>(null);
  useServerEvents({
    onRunStatus: (_runId, status) => {
      if (status !== "completed" || !projectId) return;
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "studio"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "review"],
      });
    },
  }, Boolean(projectId));
  const documentsQuery = useQuery({
    queryKey: ["project", projectId, "studio", "documents"],
    queryFn: ({ signal }) => getStudioDocuments(projectId!, signal),
    enabled: Boolean(projectId),
  });
  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);
  const recycledDocumentsQuery = useQuery({
    queryKey: ["project", projectId, "studio", "documents", "recycle"],
    queryFn: ({ signal }) => getStudioDocuments(projectId!, signal, true),
    enabled: Boolean(projectId && showRecycle),
  });
  const listedDocuments = useMemo(
    () => showRecycle
      ? (recycledDocumentsQuery.data ?? []).filter((document) => Boolean(document.archivedAt))
      : documents,
    [documents, recycledDocumentsQuery.data, showRecycle],
  );
  const reviewQuery = useQuery({
    queryKey: ["project", projectId, "review"],
    queryFn: ({ signal }) => getReviewWorkspace(projectId!, signal),
    enabled: Boolean(projectId),
  });
  const documentQuality = useMemo(
    () => currentDocumentQuality(documents, reviewQuery.data?.reports ?? []),
    [documents, reviewQuery.data?.reports],
  );
  const overviewQuery = useQuery({
    queryKey: ["project", projectId, "overview"],
    queryFn: ({ signal }) => getProjectOverview(projectId!, signal),
    enabled: Boolean(projectId),
    refetchInterval: (query) => query.state.data?.activeTask ? 3_000 : false,
  });
  const requestedDocumentId = searchParams.get("document");
  const requestedOutlineId = searchParams.get("outline");
  const selectedRunId = searchParams.get("run");
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const focusTarget = searchParams.get("focus");
  const requestedDocument = requestedDocumentId
    ? listedDocuments.find((document) => document.id === requestedDocumentId)
    : undefined;
  const outlineDocument = requestedOutlineId
    ? listedDocuments.find((document) => document.outlineNodeId === requestedOutlineId)
    : undefined;
  const requestedTargetDocumentId = requestedDocument?.id ?? outlineDocument?.id ?? null;
  const rememberedChapterTasks = useMemo(() => {
    if (!projectId) return [];
    const documentIds = new Set(documents.map((document) => document.id));
    return rememberedTasks(projectId).filter(
      (task) =>
        task.kind === "chapter" &&
        Boolean(task.documentId && documentIds.has(task.documentId)),
    );
  }, [documents, projectId]);
  const overviewTask = overviewQuery.data?.activeTask?.kind === "chapter"
    ? overviewQuery.data.activeTask
    : null;
  const overviewTaskDocumentId = overviewTask?.targetChapter?.documentId ??
    rememberedChapterTasks.find((task) => task.taskId === overviewTask?.id)?.documentId ??
    null;
  const restoreTask = selectedRunId
    ? null
    : requestedTargetDocumentId
      ? overviewTask && overviewTaskDocumentId === requestedTargetDocumentId
        ? { taskId: overviewTask.id, documentId: requestedTargetDocumentId }
        : rememberedChapterTasks.find(
            (task) => task.documentId === requestedTargetDocumentId,
          ) ?? null
      : overviewTask && overviewTaskDocumentId
        ? { taskId: overviewTask.id, documentId: overviewTaskDocumentId }
        : rememberedChapterTasks[0] ?? null;
  const restoreCandidateRunId = restoreTask?.taskId ?? null;
  const restoreRunQuery = useQuery({
    queryKey: ["project", projectId, "studio", "restore-run", restoreCandidateRunId],
    queryFn: ({ signal }) => getRunDetail(projectId!, restoreCandidateRunId!, signal),
    enabled: Boolean(projectId && restoreCandidateRunId),
    retry: false,
  });
  const canRestoreRun = restoreRunQuery.data?.run.recipe === "chapter-production" &&
    !["completed", "cancelled"].includes(restoreRunQuery.data.run.status);
  const activeDocumentId = requestedTargetDocumentId ??
    (showRecycle ? listedDocuments[0]?.id ?? null :
    (canRestoreRun ? restoreTask?.documentId : null) ??
    listedDocuments[0]?.id ??
    null);
  const restoredRunId = restoreCandidateRunId !== dismissedRunId &&
    restoreTask?.documentId === activeDocumentId &&
    canRestoreRun
    ? restoreCandidateRunId
    : null;
  const effectiveRunId = selectedRunId ?? restoredRunId;
  const updateWorkspaceParams = useCallback((updates: { document?: string | null; outline?: string | null; run?: string | null; mode?: string | null; session?: string | null }) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: false });
  }, [setSearchParams]);
  useEffect(() => {
    if (requestedOutlineId && !documentsQuery.isPending && !outlineDocument) {
      queueMicrotask(() => setCreating(true));
    }
  }, [documentsQuery.isPending, outlineDocument, requestedOutlineId]);
  const storyQuery = useQuery({
    queryKey: ["project", projectId, "story-bible"],
    queryFn: ({ signal }) => getStoryBible(projectId!, signal),
    enabled: Boolean(projectId && creating),
  });
  const availableOutlineNodes = useMemo(() => {
    const used = new Set(storyQuery.data?.occupiedOutlineNodeIds ?? []);
    return (storyQuery.data?.outline ?? []).filter(
      (node) =>
        (node.kind === "chapter" || node.kind === "scene") &&
        !used.has(node.id),
    );
  }, [storyQuery.data]);
  const detailQuery = useQuery({
    queryKey: ["project", projectId, "studio", "document", activeDocumentId],
    queryFn: ({ signal }) => getStudioDocument(projectId!, activeDocumentId!, signal),
    enabled: Boolean(projectId && activeDocumentId && !showRecycle),
  });
  const archiveMutation = useMutation({
    mutationFn: ({ document, archived }: { document: StoryDocument; archived: boolean }) =>
      setStoryDocumentArchived(document, archived),
    onSuccess: () => {
      updateWorkspaceParams({ document: null, outline: null, run: null });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "studio", "documents"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "studio", "document"] });
    },
  });
  const createMutation = useMutation({
    mutationFn: async (input: CreateDocumentInput) => {
      const ready = await flushDraftRef.current?.();
      if (ready === false) throw new Error(translate(getLocale(), "studio.errors.draftNotSynced"));
      const identity = JSON.stringify(input);
      if (createRequestRef.current?.identity !== identity) {
        createRequestRef.current = {
          identity,
          requestId: crypto.randomUUID(),
        };
      }
      return createStoryDocument(projectId!, {
        ...input,
        requestId: createRequestRef.current.requestId,
      });
    },
    onSuccess: (document) => {
      createRequestRef.current = null;
      setCreating(false);
      updateWorkspaceParams({ document: document.id, outline: null, run: null });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "studio", "documents"] });
    },
  });
  const registerFlush = useCallback((flush: FlushDraft | null) => {
    flushDraftRef.current = flush;
  }, []);
  if (!projectId) {
    return (
      <div className="studio">
        <ProjectRequiredState
          seal={t("studio.required.seal")}
          title={t("studio.required.title")}
          description={t("studio.required.description")}
        />
      </div>
    );
  }
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["project", projectId, "studio", "documents"] });
    void queryClient.invalidateQueries({ queryKey: ["project", projectId, "studio", "document", activeDocumentId] });
  };
  const selectDocument = async (nextDocumentId: string) => {
    if (nextDocumentId === activeDocumentId) return;
    const ready = await flushDraftRef.current?.();
    if (ready !== false) {
      setDismissedRunId(null);
      updateWorkspaceParams({ document: nextDocumentId, outline: null, run: null });
    }
  };
  const selectMode = async (nextMode: "manual" | "cocreate") => {
    if (nextMode === mode) return;
    if (mode === "manual") {
      const ready = await flushDraftRef.current?.();
      if (ready === false) return;
    }
    updateWorkspaceParams({
      mode: nextMode === "cocreate" ? "cocreate" : null,
      session: nextMode === "manual" ? null : requestedSessionId,
    });
  };
  return <div className="studio">
    <PageBand
      index="DESK · 04"
      title={t("studio.header.title")}
      meta={
        <div className="studio__mode-switch" role="group" aria-label={t("studio.header.modeSwitchAria")}>
          <button type="button" aria-pressed={mode === "manual"} onClick={() => void selectMode("manual")}>{t("studio.header.manual")}</button>
          <button type="button" aria-pressed={mode === "cocreate"} onClick={() => void selectMode("cocreate")}>{t("studio.header.cocreate")}</button>
        </div>
      }
    />
    {mode === "cocreate" ? <CoCreateWorkspace projectId={projectId} requestedSessionId={requestedSessionId} onSessionChange={(sessionId) => updateWorkspaceParams({ mode: "cocreate", session: sessionId })} /> : documentsQuery.isPending ? <StudioLoading /> : documentsQuery.isError ? <ErrorNote error={documentsQuery.error} title={t("studio.errors.documentsLoad")} /> : <div className="studio__layout">
      <aside className="studio__docs"><header className="studio__docs-head"><p className="studio__docs-title">{showRecycle ? t("studio.docs.recycle") : t("studio.docs.list")}</p><div><button type="button" className="studio__text-button" onClick={() => { setShowRecycle((value) => !value); setCreating(false); }}>{showRecycle ? t("studio.docs.backToList") : t("studio.docs.recycle")}</button>{!showRecycle ? <button type="button" className="studio__text-button" onClick={() => setCreating((value) => !value)}><Plus size={12} />{t("studio.docs.new")}</button> : null}</div></header>
        {creating ? <CreateDocumentForm initialOutlineNodeId={requestedOutlineId} outlineNodes={availableOutlineNodes} outlinePending={storyQuery.isPending} pending={createMutation.isPending} error={createMutation.error ?? storyQuery.error} onCancel={() => setCreating(false)} onOpenRecycle={() => { setCreating(false); setShowRecycle(true); }} onSubmit={(input) => createMutation.mutate(input)} /> : null}
        <div className="studio__docs-list">{listedDocuments.map((document) => {
          const quality = documentQuality.get(document.id);
          return <button key={document.id} type="button" className="studio__doc-link" data-active={document.id === activeDocumentId} onClick={() => void selectDocument(document.id)}><span className="studio__doc-link-title">{document.title}</span><span className="studio__doc-link-meta">{documentKindLabel(document.kind)} · {formatRelativeDate(document.updatedAt)}{quality ? <span className="studio__quality-mark" data-quality={quality}>{quality === "pass" ? t("studio.quality.pass") : quality === "revise" ? t("studio.quality.revise") : t("studio.quality.block")}</span> : null}</span></button>;
        })}</div>
        {listedDocuments.length === 0 && !creating ? <p className="studio__empty-note">{showRecycle ? t("studio.docs.recycleEmpty") : t("studio.docs.listEmpty")}</p> : null}
      </aside>
      {showRecycle ? <RecycleDesk document={listedDocuments.find((document) => document.id === activeDocumentId)} pending={archiveMutation.isPending} error={archiveMutation.error} onRestore={(document) => { setShowRecycle(false); updateWorkspaceParams({ document: null, outline: null, run: null }); archiveMutation.mutate({ document, archived: false }); }} /> : <StudioDesk key={detailQuery.data?.document.id ?? "pending"} projectId={projectId} detail={detailQuery.data} pending={Boolean(activeDocumentId) && detailQuery.isPending} error={detailQuery.error ?? archiveMutation.error} review={reviewQuery.data} reviewPending={reviewQuery.isPending} reviewError={reviewQuery.error} focusTarget={focusTarget} runId={effectiveRunId} onRunChange={(runId) => { setDismissedRunId(null); updateWorkspaceParams({ document: activeDocumentId, outline: null, run: runId }); }} onDismissRun={() => { if (effectiveRunId) setDismissedRunId(effectiveRunId); updateWorkspaceParams({ run: null }); }} onCreateDocument={() => setCreating(true)} onArchive={async (document) => { const ready = await flushDraftRef.current?.(); if (ready !== false) archiveMutation.mutate({ document, archived: true }); }} onRefresh={refresh} onFlushReady={registerFlush} />}
    </div>}
  </div>;
}

function StudioLoading() {
  const { t } = useI18n();
  return <div className="studio__layout studio__loading" aria-busy="true" aria-label={t("studio.loading.aria")}>
    <aside className="studio__loading-docs"><span /><span /><span /><span /></aside>
    <main className="studio__loading-paper"><div className="studio__loading-title" /><div className="studio__loading-lines">{Array.from({ length: 9 }, (_, index) => <span key={index} />)}</div></main>
    <aside className="studio__loading-tools"><span /><span /><span /></aside>
  </div>;
}

function CreateDocumentForm({ initialOutlineNodeId, outlineNodes, outlinePending, pending, error, onCancel, onOpenRecycle, onSubmit }: { initialOutlineNodeId: string | null; outlineNodes: OutlineNode[]; outlinePending: boolean; pending: boolean; error: unknown; onCancel: () => void; onOpenRecycle: () => void; onSubmit: (input: CreateDocumentInput) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<StoryDocument["kind"]>("chapter");
  const [outlineNodeId, setOutlineNodeId] = useState(initialOutlineNodeId ?? "");
  const requiresOutline = kind === "chapter" || kind === "scene";
  const matchingNodes = outlineNodes.filter((node) => node.kind === kind);
  const selectedNode = matchingNodes.find((node) => node.id === outlineNodeId) ?? matchingNodes[0] ?? null;
  const resolvedTitle = title.trim() || selectedNode?.title || "";
  return <form className="studio__inline-form" onSubmit={(event) => { event.preventDefault(); if (!resolvedTitle || (requiresOutline && !selectedNode)) return; onSubmit({ kind, title: resolvedTitle, outlineNodeId: requiresOutline ? selectedNode!.id : null }); }}><label>{t("studio.create.kindLabel")}<select value={kind} onChange={(event) => { setKind(event.target.value as StoryDocument["kind"]); setOutlineNodeId(""); }}><option value="chapter">{t("studio.create.kindChapter")}</option><option value="scene">{t("studio.create.kindScene")}</option><option value="outline">{t("studio.create.kindOutline")}</option><option value="synopsis">{t("studio.create.kindSynopsis")}</option><option value="note">{t("studio.create.kindNote")}</option><option value="style-sample">{t("studio.create.kindStyleSample")}</option></select></label>{requiresOutline ? <label>{t("studio.create.outlineLabel")}<select aria-label={t("studio.create.outlineNodeAria")} value={selectedNode?.id ?? ""} disabled={outlinePending || matchingNodes.length === 0} onChange={(event) => setOutlineNodeId(event.target.value)}>{outlinePending ? <option value="">{t("studio.create.outlineLoading")}</option> : matchingNodes.length === 0 ? <option value="">{t("studio.create.noBindable", { kind: kind === "chapter" ? t("studio.create.nodeKindChapter") : t("studio.create.nodeKindScene") })}</option> : matchingNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label> : null}<label>{t("studio.create.titleLabel")}<input value={title} placeholder={selectedNode?.title ?? t("studio.create.titlePlaceholder")} onChange={(event) => setTitle(event.target.value)} /></label>{requiresOutline && !outlinePending && matchingNodes.length === 0 ? <div className="studio__form-note"><p>{t("studio.create.outlineMissingNote")}</p><button type="button" className="btn" onClick={onOpenRecycle}>{t("studio.create.openRecycle")}</button></div> : null}{error ? <ErrorNote error={error} title={t("studio.errors.createFailed")} /> : null}<div className="studio__inline-form-actions"><button type="button" className="btn" onClick={onCancel}>{t("common.action.cancel")}</button><button type="submit" className="btn btn--primary" disabled={pending || outlinePending || !resolvedTitle || (requiresOutline && !selectedNode)}>{t("common.action.create")}</button></div></form>;
}

function RecycleDesk({ document, pending, error, onRestore }: { document: StoryDocument | undefined; pending: boolean; error: unknown; onRestore: (document: StoryDocument) => void }) {
  const { t } = useI18n();
  if (!document) return <main className="studio__desk studio__desk--empty"><Empty title={t("studio.recycle.emptyTitle")} description={t("studio.recycle.emptyDescription")} /></main>;
  return <main className="studio__desk studio__desk--empty"><div className="studio__recycle-card"><span className="mono">RECYCLE BIN</span><h2>{document.title}</h2><p>{documentKindLabel(document.kind)} · {t("studio.recycle.archivedAt", { time: document.archivedAt?.slice(0, 16) ?? "—" })}</p><p>{t("studio.recycle.note")}</p><button type="button" className="btn btn--primary" disabled={pending} onClick={() => onRestore(document)}><ArchiveRestore size={13} />{pending ? t("studio.recycle.restoring") : t("studio.recycle.restore")}</button>{error ? <ErrorNote error={error} title={t("studio.errors.restoreFailed")} /> : null}</div></main>;
}

function StudioDesk({ projectId, detail, pending, error, review, reviewPending, reviewError, focusTarget, runId, onRunChange, onDismissRun, onCreateDocument, onArchive, onRefresh, onFlushReady }: { projectId: string; detail: StudioDocumentDetail | undefined; pending: boolean; error: unknown; review: ReviewWorkspace | undefined; reviewPending: boolean; reviewError: unknown; focusTarget: string | null; runId: string | null; onRunChange: (runId: string) => void; onDismissRun: () => void; onCreateDocument: () => void; onArchive: (document: StoryDocument) => void | Promise<void>; onRefresh: () => void; onFlushReady: (flush: FlushDraft | null) => void }) {
  const { t } = useI18n();
  const initialContent = detail?.draft?.content ?? detail?.currentVersion?.content ?? "";
  const [content, setContent] = useState(initialContent);
  const [draftSavedContent, setDraftSavedContent] = useState(initialContent);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [commentBody, setCommentBody] = useState("");
  const [editInstruction, setEditInstruction] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<DocumentVersion | null>(null);
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [toolSelection, setToolSelection] = useState(() => ({
    focusTarget,
    tool: studioToolFromFocus(focusTarget),
  }));
  const activeTool = toolSelection.focusTarget === focusTarget
    ? toolSelection.tool
    : studioToolFromFocus(focusTarget);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const contentRef = useRef(content);
  const savedContentRef = useRef(draftSavedContent);
  const latestDraftRef = useRef<DocumentDraft | null>(detail?.draft ?? null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimerRef = useRef<number | null>(null);
  const aiRequestRef = useRef<{ identity: string; requestId: string } | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const selected =
      selection.end > selection.start
        ? content.slice(selection.start, selection.end).slice(0, 40_000)
        : null;
    publishAssistantContext({
      documentId: detail?.document.id ?? null,
      outlineNodeId: detail?.document.outlineNodeId ?? null,
      selection: selected
        ? { start: selection.start, end: selection.end, text: selected }
        : null,
    });
  }, [content, detail?.document.id, detail?.document.outlineNodeId, selection]);

  const draftMutation = useMutation({
    mutationFn: (value: string) => saveDocumentDraft(projectId, detail!.document.id, { content: value, baseVersionId: detail!.document.currentVersionId, expectedDraftUpdatedAt: latestDraftRef.current?.updatedAt ?? null }),
    onSuccess: (draft, value) => {
      latestDraftRef.current = draft;
      savedContentRef.current = value;
      setDraftSavedContent(value);
      if (detail) {
        queryClient.setQueryData<StudioDocumentDetail>(
          ["project", projectId, "studio", "document", detail.document.id],
          (current) => current ? { ...current, draft } : current,
        );
      }
    },
  });
  const mutateDraft = draftMutation.mutateAsync;
  const persistDraft = useCallback((value: string): Promise<DocumentDraft | null> => {
    const perform = () => mutateDraft(value);
    const queued = saveQueueRef.current.then(perform, perform);
    saveQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [mutateDraft]);
  const cancelScheduledAutosave = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);
  const flushDraft = useCallback(async (): Promise<boolean> => {
    if (!detail) return true;
    cancelScheduledAutosave();
    await saveQueueRef.current;
    const value = contentRef.current;
    if (value === savedContentRef.current) return true;
    try {
      await persistDraft(value);
      return true;
    } catch {
      return false;
    }
  }, [cancelScheduledAutosave, detail, persistDraft]);
  useEffect(() => {
    if (!detail || content === draftSavedContent) return;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void persistDraft(content).catch(() => undefined);
    }, 700);
    return cancelScheduledAutosave;
  }, [cancelScheduledAutosave, content, detail, draftSavedContent, persistDraft]);
  // 正式版本身份或服务端草稿变化（历史恢复、AI 候选采纳、其他标签页写入）时，
  // 编辑器必须重新装载新正文；本地有未保存编辑时不覆盖，留待草稿保存冲突显式暴露。
  const detailContentIdentity = detail
    ? `${detail.document.id}·${detail.document.currentVersionId ?? "none"}·${detail.draft?.contentHash ?? "none"}·${detail.draft?.updatedAt ?? "none"}`
    : null;
  const syncedIdentityRef = useRef(detailContentIdentity);
  useEffect(() => {
    if (!detail || detailContentIdentity === null) return;
    if (detailContentIdentity === syncedIdentityRef.current) return;
    syncedIdentityRef.current = detailContentIdentity;
    latestDraftRef.current = detail.draft;
    if (contentRef.current !== savedContentRef.current) return;
    cancelScheduledAutosave();
    const next = detail.draft?.content ?? detail.currentVersion?.content ?? "";
    contentRef.current = next;
    savedContentRef.current = next;
    setContent(next);
    setDraftSavedContent(next);
  }, [cancelScheduledAutosave, detail, detailContentIdentity]);
  useEffect(() => {
    onFlushReady(flushDraft);
    return () => onFlushReady(null);
  }, [flushDraft, onFlushReady]);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (content !== draftSavedContent || draftMutation.isPending || draftMutation.isError) event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [content, draftSavedContent, draftMutation.isPending, draftMutation.isError]);
  const versionMutation = useMutation({
    mutationFn: async () => {
      cancelScheduledAutosave();
      await saveQueueRef.current;
      return appendDocumentVersion(projectId, detail!.document.id, { content, source: "manual", expectedCurrentVersionId: detail!.document.currentVersionId });
    },
    onSuccess: () => {
      latestDraftRef.current = null;
      savedContentRef.current = content;
      setDraftSavedContent(content);
      onRefresh();
    },
  });
  const restoreMutation = useMutation({
    mutationFn: (version: DocumentVersion) => restoreDocumentVersion(projectId, detail!.document.id, version.id, detail!.document.currentVersionId),
    onSuccess: () => { setRestoreTarget(null); onRefresh(); },
  });
  const commentMutation = useMutation({
    mutationFn: async () => {
      cancelScheduledAutosave();
      await saveQueueRef.current;
      const selectedContent = content;
      let version = detail!.currentVersion;
      if (!version || version.content !== selectedContent) {
        version = await appendDocumentVersion(projectId, detail!.document.id, {
          content: selectedContent,
          source: "manual:comment-checkpoint",
          expectedCurrentVersionId: detail!.document.currentVersionId,
        });
        latestDraftRef.current = null;
        savedContentRef.current = selectedContent;
        setDraftSavedContent(selectedContent);
      }
      return createDocumentComment(projectId, detail!.document.id, { versionId: version.id, startOffset: selection.start, endOffset: selection.end, quote: selectedContent.slice(selection.start, selection.end), body: commentBody.trim() });
    },
    onSuccess: () => { setCommentBody(""); onRefresh(); },
  });
  const statusMutation = useMutation({ mutationFn: (comment: DocumentComment) => setDocumentCommentStatus(comment.id, comment.status === "open" ? "resolved" : "open"), onSuccess: onRefresh });
  const editMutation = useMutation({
    mutationFn: async () => {
      cancelScheduledAutosave();
      await saveQueueRef.current;
      let baseVersionId = detail!.currentVersion?.id ?? null;
      let draftContentHash: string | null = null;
      if (!baseVersionId) {
        const version = await appendDocumentVersion(projectId, detail!.document.id, {
          content,
          source: "manual:selection-baseline",
          expectedCurrentVersionId: null,
        });
        baseVersionId = version.id;
        latestDraftRef.current = null;
        savedContentRef.current = content;
        setDraftSavedContent(content);
      } else {
        const syncedDraft = content === savedContentRef.current
          ? latestDraftRef.current
          : await persistDraft(content);
        draftContentHash = syncedDraft?.contentHash ?? null;
      }
      return createSelectionEdit(projectId, detail!.document.id, { baseVersionId, draftContentHash, selectionStart: selection.start, selectionEnd: selection.end, instruction: editInstruction.trim() });
    },
    onSuccess: () => {
      latestDraftRef.current = null;
      savedContentRef.current = content;
      setDraftSavedContent(content);
      setEditInstruction("");
      onRefresh();
    },
  });

  const proposalMutation = useMutation({ mutationFn: (input: { proposal: EditProposal; action: "accept" | "reject" }) => decideEditProposal(input.proposal.id, input.action), onSuccess: onRefresh });

  /* 单章「交给 AI」：区别于多章 AI 快速创作（自动驾驶航次）；发起一个 chapter run。 */
  const aiMutation = useMutation({
    mutationFn: () => {
      const input = {
        targetOutlineNodeId: detail!.document.outlineNodeId!,
        planningMode: "auto" as const,
        origin: {
          surface: "writing" as const,
          documentId: detail!.document.id,
        },
        maxRevisionCycles: 2,
      };
      const identity = JSON.stringify(input);
      if (aiRequestRef.current?.identity !== identity) {
        aiRequestRef.current = {
          identity,
          requestId: crypto.randomUUID(),
        };
      }
      return createChapterRun(projectId, {
        ...input,
        requestId: aiRequestRef.current.requestId,
      });
    },
    onSuccess: (created) => {
      aiRequestRef.current = null;
      rememberTask({
        projectId,
        kind: "chapter",
        taskId: created.run.id,
        label: t("studio.ai.taskLabel", { name: detail!.document.title }),
        createdAt: new Date().toISOString(),
        origin: { surface: "writing", documentId: detail!.document.id },
        documentId: detail!.document.id,
      });
      onRunChange(created.run.id);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "runs"] });
    },
  });

  if (pending) return <main className="studio__desk"><Skeleton lines={8} /></main>;
  if (error) return <main className="studio__desk"><ErrorNote error={error} title={t("studio.errors.detailLoad")} /></main>;
  if (!detail) return <main className="studio__desk studio__desk--empty"><Empty title={t("studio.empty.title")} description={t("studio.empty.description")} action={<div className="studio__empty-actions"><button type="button" className="btn btn--primary" onClick={onCreateDocument}><Plus size={13} />{t("studio.empty.create")}</button><Link to={projectWorkspacePath(projectId, "bible")}>{t("studio.empty.planLink")}</Link></div>} /></main>;
  const hasSelection = selection.end > selection.start;
  const selectionNeedsCheckpoint = detail.currentVersion?.content !== content;
  const aiReady =
    detail.document.kind === "chapter" &&
    detail.document.outlineNodeId !== null;
  const anyError = versionMutation.error ?? draftMutation.error ?? commentMutation.error ?? editMutation.error ?? proposalMutation.error ?? statusMutation.error ?? aiMutation.error;
  const activeToolLabel = t(
    STUDIO_TOOLS.find((tool) => tool.id === activeTool)?.labelKey ??
      "studio.tools.fallback",
  );
  const toolCount = (tool: StudioTool): number | null => {
    if (tool === "comments") return detail.comments.length;
    if (tool === "versions") return detail.versions.length;
    if (tool === "selection") return detail.proposals.length;
    return null;
  };
  return <>
    <main className="studio__desk">
      <header className="studio__desk-head"><p className="studio__desk-title">{detail.document.title}</p><span className="studio__desk-tag">{t("studio.desk.versionCount", { count: detail.versions.length })}</span><span className="studio__desk-meta mono">{content === draftSavedContent && !draftMutation.isPending ? t("studio.desk.draftSynced") : draftMutation.isPending ? t("studio.desk.draftSyncing") : t("studio.desk.draftUnsynced")}</span><button type="button" className="studio__text-button" onClick={() => setArchiveOpen(true)}><Archive size={12} />{t("studio.desk.archive")}</button></header>
      {runId ? <WritingTaskPanel projectId={projectId} runId={runId} onRunChange={onRunChange} onDismiss={onDismissRun} onAccepted={() => { setTaskNotice(t("studio.task.acceptedNotice")); onDismissRun(); }} onRefreshDocument={onRefresh} /> : null}
      {taskNotice ? <p className="studio__task-accepted" role="status"><Check size={13} aria-hidden="true" />{taskNotice}<button type="button" aria-label={t("studio.task.dismissNoticeAria")} onClick={() => setTaskNotice(null)}>×</button></p> : null}
      <div className="studio__desk-editor">{content.length === 0 ? <div className="studio__blank-page-note"><span className="mono">{t("studio.desk.blankTagline")}</span><strong>{t("studio.desk.blankHeading")}</strong><p>{aiReady ? t("studio.desk.blankHintAi") : t("studio.desk.blankHintPlain")}</p></div> : null}<textarea ref={textareaRef} className="studio__desk-textarea" aria-label={t("studio.desk.editorAria")} value={content} onChange={(event) => { contentRef.current = event.currentTarget.value; setContent(event.currentTarget.value); }} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} placeholder={t("studio.desk.editorPlaceholder")} />
        {anyError ? <ErrorNote error={anyError} title={t("studio.desk.operationErrorTitle")} /> : null}
        {versionMutation.isSuccess ? <p className="studio__saved-note" role="status">{t("studio.desk.versionSaved")}</p> : null}
        <div className="studio__desk-foot"><span className="studio__desk-stat">{t("studio.desk.stats", { count: content.length, selected: selection.end - selection.start })}</span><div className="studio__desk-actions">{aiReady ? <button type="button" className="studio__save-btn studio__save-btn--ai" disabled={aiMutation.isPending} title={t("studio.ai.buttonTitle")} onClick={() => aiMutation.mutate()}><Sparkles size={13} />{aiMutation.isPending ? t("studio.ai.submitting") : t("studio.ai.button")}</button> : detail.document.kind === "manuscript" ? <span className="studio__desk-hint">{t("studio.hint.manuscriptPrefix")}<Link to={projectWorkspacePath(projectId, "bible")}>{t("studio.hint.manuscriptLinkChapters")}</Link>{t("studio.hint.manuscriptMiddle")}<Link to={projectWorkspacePath(projectId, "autopilot")}>{t("studio.hint.manuscriptLinkAutopilot")}</Link></span> : detail.document.kind === "scene" ? <span className="studio__desk-hint">{t("studio.hint.scene")}</span> : <span className="studio__desk-hint">{t("studio.hint.unboundPrefix")}<Link to={projectWorkspacePath(projectId, "bible")}>{t("studio.hint.unboundLink")}</Link></span>}<button type="button" className="studio__save-btn" disabled={versionMutation.isPending || !content.trim()} onClick={() => versionMutation.mutate()}><Save size={13} />{versionMutation.isPending ? t("studio.desk.savingVersion") : t("studio.desk.saveVersion")}</button></div></div>
      </div>
    </main>
    <aside className="studio__side" aria-label={t("studio.tools.dockAria")}>
      <nav className="studio__tool-nav" role="tablist" aria-label={t("studio.tools.navAria")}>
        {STUDIO_TOOLS.map((tool) => {
          const count = toolCount(tool.id);
          return (
            <button
              key={tool.id}
              type="button"
              role="tab"
              aria-selected={activeTool === tool.id}
              aria-controls="studio-tool-panel"
              onClick={() => setToolSelection({ focusTarget, tool: tool.id })}
            >
              <StudioToolIcon tool={tool.id} />
              <span>{t(tool.labelKey)}</span>
              {count !== null ? <small>{count}</small> : null}
            </button>
          );
        })}
      </nav>
      <section
        className="studio__tool-panel"
        id="studio-tool-panel"
        role="tabpanel"
        aria-label={t("studio.tools.panelAria", { label: activeToolLabel })}
      >
        {activeTool === "review" ? <ReviewPanel projectId={projectId} document={detail.document} workspace={review} pending={reviewPending} error={reviewError} /> : null}
        {activeTool === "revisions" ? <RevisionProposalPanel projectId={projectId} activeDocumentId={detail.document.id} /> : null}
        {activeTool === "canon" ? <CanonChangesPanel projectId={projectId} document={detail.document} versions={detail.versions} /> : null}
        {activeTool === "comments" ? <CommentPanel comments={detail.comments} pending={statusMutation.isPending} onToggle={(comment) => statusMutation.mutate(comment)} /> : null}
        {activeTool === "versions" ? <VersionPanel versions={detail.versions} currentVersionId={detail.document.currentVersionId} pending={restoreMutation.isPending} onRestore={setRestoreTarget} /> : null}
        {activeTool === "selection" ? <>
          <section className="studio__selection-tools" aria-label={t("studio.selection.aria")}><h3>{t("studio.selection.title")}</h3><blockquote>{hasSelection ? content.slice(selection.start, selection.end) : t("studio.selection.emptyQuote")}</blockquote><div className="studio__selection-grid"><div className="studio__selection-cell"><label>{t("studio.selection.commentLabel")}<textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} /></label><button type="button" className="btn" disabled={!hasSelection || !commentBody.trim() || commentMutation.isPending} onClick={() => commentMutation.mutate()}><MessageSquarePlus size={12} />{selectionNeedsCheckpoint ? t("studio.selection.commentCheckpoint") : t("studio.selection.commentCreate")}</button></div><div className="studio__selection-cell"><label>{t("studio.selection.editLabel")}<textarea value={editInstruction} onChange={(event) => setEditInstruction(event.target.value)} /></label><button type="button" className="btn btn--primary" disabled={!hasSelection || !editInstruction.trim() || editMutation.isPending} onClick={() => editMutation.mutate()}><Sparkles size={12} />{editMutation.isPending ? t("studio.selection.editPending") : t("studio.selection.editSubmit")}</button>{editMutation.data ? <p className="studio__saved-note" role="status">{t("studio.selection.editStarted")} <Link to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(editMutation.data.run.id)}`}>{t("studio.selection.editProgressLink")}</Link></p> : null}</div></div></section>
          <ProposalPanel proposals={detail.proposals} pending={proposalMutation.isPending} onDecide={(proposal, action) => proposalMutation.mutate({ proposal, action })} />
        </> : null}
      </section>
    </aside>
    {restoreTarget ? <ConfirmDialog title={t("studio.confirm.restoreTitle")} confirmLabel={t("studio.confirm.restoreLabel")} pending={restoreMutation.isPending} onCancel={() => setRestoreTarget(null)} onConfirm={() => restoreMutation.mutate(restoreTarget)}><p>{t("studio.confirm.restoreBody")}</p>{restoreMutation.isError ? <ErrorNote error={restoreMutation.error} title={t("studio.errors.restoreVersionFailed")} /> : null}</ConfirmDialog> : null}
    {archiveOpen ? <ConfirmDialog title={t("studio.desk.archive")} confirmLabel={t("studio.desk.archive")} danger onCancel={() => setArchiveOpen(false)} onConfirm={() => { setArchiveOpen(false); if (detail) void onArchive(detail.document); }}><p>{t("studio.confirm.archiveBody")}</p></ConfirmDialog> : null}
  </>;
}

function StudioToolIcon({ tool }: { tool: StudioTool }) {
  const props = { size: 15, strokeWidth: 1.6, "aria-hidden": true } as const;
  switch (tool) {
    case "review":
      return <Check {...props} />;
    case "revisions":
      return <Undo2 {...props} />;
    case "canon":
      return <BookOpen {...props} />;
    case "comments":
      return <MessageSquarePlus {...props} />;
    case "versions":
      return <Save {...props} />;
    case "selection":
      return <Sparkles {...props} />;
  }
}

/* ---- 审稿（完整展开）：现状文档的最新报告 + verdict + issue 裁定 ------------ */

function ReviewPanel({ projectId, document, workspace, pending, error }: { projectId: string; document: StoryDocument; workspace: ReviewWorkspace | undefined; pending: boolean; error: unknown }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);
  const reviewRequestRef = useRef<{ versionId: string; requestId: string } | null>(null);
  const decideMutation = useMutation({
    mutationFn: (input: { issue: ReviewWorkspaceIssue; action: "accept" | "reject" | "false_positive" | "intentional_keep" }) =>
      decideReviewIssue(projectId, input.issue.id, { action: input.action, note: null, expectedStatus: input.issue.status }),
    onSuccess: (_data, input) => {
      setFlash(t("studio.review.decisionFlash", { action: reviewIssueActionLabel(input.action) }));
      window.setTimeout(() => setFlash(null), 2200);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "review"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "studio"] });
    },
  });
  const reviewMutation = useMutation({
    mutationFn: () => {
      if (!document.currentVersionId) {
        throw new Error(t("studio.review.errorNoVersion"));
      }
      if (reviewRequestRef.current?.versionId !== document.currentVersionId) {
        reviewRequestRef.current = {
          versionId: document.currentVersionId,
          requestId: crypto.randomUUID(),
        };
      }
      return createDocumentReview(projectId, document.id, {
        requestId: reviewRequestRef.current.requestId,
        documentVersionId: document.currentVersionId,
        origin: { surface: "writing", documentId: document.id },
      });
    },
    onSuccess: (created) => {
      reviewRequestRef.current = null;
      setFlash(t("studio.review.submittedFlash"));
      rememberTask({
        projectId,
        kind: "chapter",
        taskId: created.run.id,
        label: t("studio.task.reviewTaskLabel", { name: document.title }),
        createdAt: new Date().toISOString(),
        origin: { surface: "writing", documentId: document.id },
        documentId: document.id,
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "runs"],
      });
    },
  });
  const reports = (workspace?.reports ?? [])
    .filter((report) => report.documentId === document.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const currentReports = reports.filter(
    (report) => report.documentVersionId === document.currentVersionId,
  );
  const latest: ReviewWorkspaceReport | null = currentReports[0] ?? null;
  if (error) return <Panel title={t("studio.tools.review")} count={0}><ErrorNote error={error} title={t("studio.errors.reviewLoad")} /></Panel>;
  if (pending) return <Panel title={t("studio.tools.review")} count={0}><Skeleton lines={3} /></Panel>;
  const canReview =
    document.kind === "chapter" &&
    document.outlineNodeId !== null &&
    document.currentVersionId !== null;
  const visibleReports = reports.filter(
    (report) =>
      report.id === latest?.id ||
      report.issues.some((issue) => issue.status === "open"),
  );
  const openCount = visibleReports.flatMap((report) => report.issues).filter((issue) => issue.status === "open").length;
  return <Panel title={t("studio.tools.review")} count={openCount}>
    <div className="studio__review-command">
      <p className="studio__section-intro">{latest ? t("studio.review.introCurrent") : document.kind === "manuscript" ? t("studio.review.introManuscript") : t("studio.review.introNone")}</p>
      {canReview ? <button type="button" className="btn" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate()}><Check size={12} aria-hidden="true" />{reviewMutation.isPending ? t("studio.review.submitting") : latest ? t("studio.review.rereview") : t("studio.review.reviewCurrent")}</button> : null}
    </div>
    {reviewMutation.isError ? <ErrorNote error={reviewMutation.error} title={t("studio.errors.reviewSubmitFailed")} /> : null}
    {!latest && visibleReports.length > 0 ? <p className="studio__review-stale">{t("studio.review.staleNote")}</p> : null}
    {!latest && visibleReports.length === 0 ? <p className="studio__panel-empty">{t("studio.review.emptyNote")}</p> : null}
    {visibleReports.map((report, index) => {
      const reportOpenIssues = report.issues.filter((issue) => issue.status === "open");
      return <details key={report.id} className="studio__review-report" open={index === 0 || reportOpenIssues.length > 0}>
        <summary><strong>{report.id === latest?.id ? t("studio.review.reportCurrent") : t("studio.review.reportPast")}</strong><span>{t("studio.review.reportMeta", { verdict: reviewVerdictLabel(report.verdict), count: reportOpenIssues.length, time: report.createdAt.slice(0, 16) })}</span></summary>
        <div className="studio__review-report-body">
          <div className="review__report" aria-label={t("studio.review.reportAria")}>
            <div className="review__report-head"><p className="review__report-verdict" data-v={report.verdict}>{reviewVerdictLabel(report.verdict)}</p><p className="review__report-summary">{report.summary}</p></div>
            <div className="review__report-scores" aria-label={t("studio.review.scoresAria")}>{Object.entries(report.scores).map(([key, value]) => <span key={key}>{reviewScoreLabel(key)} · {value}</span>)}</div>
          </div>
          {report.reviewedContent ? <details className="studio__reviewed-copy"><summary>{t("studio.review.reviewedCopySummary", { count: report.reviewedContent.length })}</summary><div className="review__doc-body review__doc-body--desk" aria-label={t("studio.review.reviewedCopyAria")}>{markQuotes(report.reviewedContent, report.issues.flatMap((issue) => issue.evidence.map((entry) => entry.quote)).filter(Boolean))}</div></details> : null}
          {report.issues.length === 0 ? <div className="review__empty"><strong>{t("studio.review.cleanTitle")}</strong>{t("studio.review.cleanBody")}</div> : <div className="review__issues">{report.issues.map((issue) => <IssueCard key={issue.id} issue={issue} pending={decideMutation.isPending} onDecide={(action) => decideMutation.mutate({ issue, action })} />)}</div>}
          {reportOpenIssues.length === 0 && report.issues.length > 0 ? <p className="studio__panel-empty">{t("studio.review.allDecided", { count: report.issues.length })}</p> : null}
        </div>
      </details>;
    })}
    {flash ? <p className="review__flash" role="status"><Check size={13} aria-hidden="true" />{flash}</p> : null}
  </Panel>;
}

function currentDocumentQuality(
  documents: StoryDocument[],
  reports: ReviewWorkspaceReport[],
): Map<string, ReviewWorkspaceReport["verdict"]> {
  const currentVersions = new Map(
    documents.flatMap((document) =>
      document.currentVersionId
        ? [[document.currentVersionId, document.id] as const]
        : [],
    ),
  );
  const quality = new Map<string, ReviewWorkspaceReport["verdict"]>();
  for (const report of [...reports].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )) {
    const documentId = report.documentVersionId
      ? currentVersions.get(report.documentVersionId)
      : undefined;
    if (documentId && !quality.has(documentId)) {
      quality.set(documentId, report.verdict);
    }
  }
  return quality;
}

function IssueCard({ issue, pending, onDecide }: { issue: ReviewWorkspaceIssue; pending: boolean; onDecide: (action: "accept" | "reject" | "false_positive" | "intentional_keep") => void }) {
  const { t } = useI18n();
  const decided = issue.decision !== null;
  return (
    <article className="review__issue" data-decided={decided}>
      <div className="review__issue-head">
        <span className="review__issue-badge" data-s={issue.severity}>{reviewSeverityLabel(issue.severity)}</span>
        <span className="review__issue-cat">{reviewCategoryLabel(issue.category)}</span>
        <span className="review__decision-chip" data-d={issue.decision?.action}>{decided ? reviewIssueActionLabel(issue.decision!.action) : reviewIssueStatusLabel(issue)}</span>
      </div>
      <p className="review__issue-message">{issue.message}</p>
      {issue.evidence.length > 0 ? (
        <div className="review__issue-evidence">
          {issue.evidence.map((entry, index) => (
            <span key={index}>
              「{entry.quote}」{index < issue.evidence.length - 1 ? " · " : ""}
            </span>
          ))}
        </div>
      ) : null}
      {issue.suggestedDirection ? <p className="review__issue-suggest">{issue.suggestedDirection}</p> : null}
      {!decided ? (
        <div className="review__decider" role="group" aria-label={t("studio.review.deciderAria")}>
          <button type="button" className="review__decider-btn" disabled={pending} onClick={() => onDecide("accept")}><Check size={11} strokeWidth={2} aria-hidden="true" />{t("studio.decide.accept")}</button>
          <button type="button" className="review__decider-btn" disabled={pending} onClick={() => onDecide("reject")}>{t("studio.decide.reject")}</button>
          <button type="button" className="review__decider-btn" disabled={pending} onClick={() => onDecide("false_positive")}>{t("studio.review.falsePositive")}</button>
          <button type="button" className="review__decider-btn" disabled={pending} onClick={() => onDecide("intentional_keep")}>{t("studio.review.intentionalKeep")}</button>
        </div>
      ) : null}
    </article>
  );
}

/* ---- 修订提案：base 对照 + revised 全文 + apply/reject --------------------- */

function RevisionProposalPanel({ projectId, activeDocumentId }: { projectId: string; activeDocumentId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["project", projectId, "review"],
    queryFn: ({ signal }) => getReviewWorkspace(projectId, signal),
  });
  const mutation = useMutation({
    mutationFn: (input: { proposal: ReviewRevisionProposal; action: "apply" | "reject" }) =>
      decideRevisionProposal(projectId, input.proposal.id, input.action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "review"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "studio"] });
    },
  });
  const proposals = (query.data?.proposals ?? []).filter(
    (proposal) => proposal.documentId === activeDocumentId,
  );
  if (query.isPending) return null;
  return <Panel title={t("studio.revisions.title")} count={proposals.length}>
    {query.isError ? <ErrorNote error={query.error} title={t("studio.errors.revisionsLoad")} /> : proposals.length === 0 ? (
      <p className="studio__panel-empty">{t("studio.revisions.empty")}</p>
    ) : proposals.map((proposal) => (
      <article key={proposal.id} className="studio__proposal" data-status={proposal.status}>
        <strong>{t("studio.revisions.itemTitle", { status: proposalStatusLabel(proposal.status) })}</strong>
        {proposal.baseContent ? (
          <details className="studio__proposal-base"><summary>{t("studio.revisions.baseSummary", { count: proposal.baseContent.length })}</summary><pre>{proposal.baseContent}</pre></details>
        ) : null}
        {/* 修改差异完整展开：revised 正文一字不省。 */}
        <div className="review__doc-body review__doc-body--desk" aria-label={t("studio.revisions.revisedAria", { count: proposal.revisedContent.length })}>{proposal.revisedContent}</div>
        {proposal.diff && Object.keys(proposal.diff).length > 0 ? (
          <details className="studio__proposal-base"><summary>{t("studio.revisions.diffSummary")}</summary><pre className="review__proposal-diff">{JSON.stringify(proposal.diff, null, 2)}</pre></details>
        ) : null}
        {proposal.addressedIssueIds.length > 0 ? <small>{t("studio.revisions.addressedIssues", { count: proposal.addressedIssueIds.length })}</small> : null}
        {proposal.status === "proposed" ? (
          <div className="studio__proposal-actions">
            <button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ proposal, action: "apply" })}>{t("studio.revisions.apply")}</button>
            <button type="button" className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate({ proposal, action: "reject" })}>{t("studio.decide.reject")}</button>
          </div>
        ) : <small>{proposalStatusLabel(proposal.status)}{proposal.decidedAt ? ` · ${proposal.decidedAt.slice(0, 16)}` : ""}</small>}
        {mutation.isError ? <ErrorNote error={mutation.error} title={t("studio.errors.proposalDecideFailed")} /> : null}
      </article>
    ))}
  </Panel>;
}

/* ---- 故事变化裁定（canon change set） -------------------------------------- */

function CanonChangesPanel({ projectId, document, versions }: { projectId: string; document: StoryDocument; versions: DocumentVersion[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [forceTarget, setForceTarget] = useState<CanonChangeSetView | null>(null);
  const query = useQuery({
    queryKey: ["project", projectId, "canon-change-sets"],
    queryFn: ({ signal }) => getCanonChangeSets(projectId, signal),
  });
  const runsQuery = useQuery({
    queryKey: ["project", projectId, "runs"],
    queryFn: ({ signal }) => getProjectRuns(projectId, signal),
  });
  const storyQuery = useQuery({
    queryKey: ["project", projectId, "story-bible"],
    queryFn: ({ signal }) => getStoryBible(projectId, signal),
  });
  const mutation = useMutation({
    mutationFn: (input: { set: CanonChangeSetView; action: "apply" | "reject"; conflictPolicy?: "reject" | "force" }) =>
      decideCanonChangeSet(projectId, input.set.id, {
        action: input.action,
        expectedStatus: "candidate",
        conflictPolicy: input.conflictPolicy ?? "reject",
      }),
    onSuccess: () => {
      setForceTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "canon-change-sets"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "runs"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "overview"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "autopilot"] });
    },
  });
  const relatedRunIds = new Set((runsQuery.data ?? [])
    .filter((run) => document.outlineNodeId && run.targetOutlineNodeId === document.outlineNodeId)
    .map((run) => run.id));
  const versionIds = new Set(versions.map((version) => version.id));
  const sets = (query.data ?? []).filter((set) =>
    set.status === "candidate" &&
    (relatedRunIds.has(set.runId) || changeSetTouchesVersions(set.changes, versionIds)));
  const entityNames = new Map((storyQuery.data?.entities ?? []).map((entity) => [entity.id, entity.name]));
  /* 手动提交版本自动开出的结算 Run：targetOutlineNodeId 为 null，只能按
     policy.origin.documentId 认领，用来显示运行中/失败状态。 */
  const settlementRuns = (runsQuery.data ?? []).filter((run) =>
    run.recipe === "manual-settlement" && runOriginDocumentId(run.policy) === document.id);
  const activeSettlement = settlementRuns.find((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  const failedSettlement = [...settlementRuns].reverse().find((run) => run.status === "failed");
  const conflict = settlementConflictDetails(mutation.error);
  if (query.isPending || runsQuery.isPending) return <Panel title={t("studio.canon.title")} count={0}><Skeleton lines={2} /></Panel>;
  return <Panel title={t("studio.canon.title")} count={sets.length}>
    {query.isError || runsQuery.isError ? <ErrorNote error={query.error ?? runsQuery.error} title={t("studio.errors.canonLoad")} /> : <>
        {activeSettlement ? <p className="studio__settlement-status" role="status">{t("studio.canon.settlementRunning")}</p>
          : failedSettlement ? <p className="studio__settlement-status" data-tone="failed">{t("studio.canon.settlementFailedPrefix")}<Link to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(failedSettlement.id)}`}>{t("studio.task.detailLink")}</Link>{t("studio.canon.settlementFailedSuffix")}</p> : null}
        {sets.length === 0 && !activeSettlement ? (
          <p className="studio__panel-empty">{t("studio.canon.empty")}</p>
        ) : sets.length > 0 ? <>
        <p className="studio__section-intro">{t("studio.canon.intro")}</p>
        {sets.map((set) => {
          const items = canonChangeItems(set.changes, entityNames);
          return (
          <article key={set.id} className="studio__proposal" data-status={set.status}>
            <strong>{canonSummary(set.changes) ?? t("studio.canon.fallbackSummary")}</strong>
            {items.length > 0 ? <ul className="studio__canon-items">{items.map((item, index) => <li key={`${item.label}-${index}`}><span>{item.label}</span><p>{item.text}</p></li>)}</ul> : <p className="studio__panel-empty">{t("studio.canon.noItems")}</p>}
            <small>{set.createdAt.slice(0, 16)}</small>
            {set.status === "candidate" ? (
              <div className="studio__proposal-actions">
                <button type="button" className="btn btn--primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ set, action: "apply" })}>{t("studio.canon.apply")}</button>
                {conflict?.forceAllowed && mutation.variables?.set.id === set.id ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => setForceTarget(set)}>{t("studio.canon.forceApply")}</button> : null}
                <button type="button" className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate({ set, action: "reject" })}>{t("studio.canon.defer")}</button>
              </div>
            ) : null}
          </article>
        );})}
        {mutation.isError ? conflict ? <div className="studio__settlement-status" data-tone="failed" role="alert"><strong>{t("studio.canon.conflictTitle")}</strong><ul>{conflict.conflicts.map((item, index) => <li key={`${item.path}-${index}`}>{settlementConflictLabel(item.reason)} · {item.path}{item.existingIds.length > 0 ? ` · ${t("studio.canon.conflictRecords", { ids: item.existingIds.join(", ") })}` : ""}</li>)}</ul>{conflict.forceAllowed ? <p>{t("studio.canon.conflictForceable")}</p> : <p>{t("studio.canon.conflictNotForceable")}</p>}</div> : <ErrorNote error={mutation.error} title={t("studio.errors.canonDecideFailed")} /> : null}
      </> : null}
      </>}
    {forceTarget ? <ConfirmDialog title={t("studio.canon.forceTitle")} confirmLabel={t("studio.canon.forceConfirm")} danger pending={mutation.isPending} onCancel={() => setForceTarget(null)} onConfirm={() => mutation.mutate({ set: forceTarget, action: "apply", conflictPolicy: "force" })}><p>{t("studio.canon.forceBody")}</p></ConfirmDialog> : null}
  </Panel>;
}

interface SettlementConflictDetails {
  conflicts: Array<{ path: string; existingIds: string[]; reason: string }>;
  forceAllowed: boolean;
}

function settlementConflictDetails(error: unknown): SettlementConflictDetails | null {
  if (!(error instanceof ApiError) || error.code !== "settlement.conflict") return null;
  const details = error.details;
  if (!isUnknownRecord(details) || !Array.isArray(details.conflicts) || typeof details.forceAllowed !== "boolean") return null;
  const conflicts = details.conflicts.filter(isUnknownRecord).flatMap((item) =>
    typeof item.path === "string" && typeof item.reason === "string" && Array.isArray(item.existingIds)
      ? [{ path: item.path, reason: item.reason, existingIds: item.existingIds.filter((id): id is string => typeof id === "string") }]
      : [],
  );
  return { conflicts, forceAllowed: details.forceAllowed };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function settlementConflictLabel(reason: string): string {
  const keys: Record<string, MessageKey> = {
    target_locked: "studio.canon.reason.targetLocked",
    status_changed: "studio.canon.reason.statusChanged",
    target_not_current: "studio.canon.reason.targetNotCurrent",
    target_slot_mismatch: "studio.canon.reason.targetSlotMismatch",
    target_not_found: "studio.canon.reason.targetNotFound",
    target_pair_mismatch: "studio.canon.reason.targetPairMismatch",
  };
  const messageKey = keys[reason];
  return messageKey ? translate(getLocale(), messageKey) : reason;
}

function CommentPanel({ comments, pending, onToggle }: { comments: DocumentComment[]; pending: boolean; onToggle: (comment: DocumentComment) => void }) { const { t } = useI18n(); return <Panel title={t("studio.comments.title")} count={comments.length}>{comments.length === 0 ? <p className="studio__panel-empty">{t("studio.comments.empty")}</p> : comments.map((comment) => <article key={comment.id} className="studio__pin"><span className="studio__pin-state" data-s={comment.status}>{comment.status === "open" ? t("studio.comments.open") : t("studio.comments.resolved")}</span><blockquote>{comment.quote}</blockquote><p>{comment.body}</p><small>{t("studio.comments.position", { start: comment.startOffset, end: comment.endOffset })}</small><button type="button" className="btn" disabled={pending} onClick={() => onToggle(comment)}>{comment.status === "open" ? t("studio.comments.markResolved") : t("studio.comments.reopen")}</button></article>)}</Panel>; }
function VersionPanel({ versions, currentVersionId, pending, onRestore }: { versions: DocumentVersion[]; currentVersionId: string | null; pending: boolean; onRestore: (version: DocumentVersion) => void }) { const { t } = useI18n(); return <Panel title={t("studio.versions.title")} count={versions.length}>{versions.map((version, index) => <article key={version.id} className="studio__version" data-current={version.id === currentVersionId}><span className="studio__version-no mono">v{versions.length - index}</span><span className="studio__version-meta">{t("studio.versions.meta", { source: versionSourceLabel(version.source), count: version.content.length, time: version.createdAt.slice(0, 16) })}</span>{version.id !== currentVersionId ? <button type="button" className="btn" disabled={pending} onClick={() => onRestore(version)}><Undo2 size={11} />{t("studio.versions.restore")}</button> : null}</article>)}</Panel>; }
function ProposalPanel({ proposals, pending, onDecide }: { proposals: EditProposal[]; pending: boolean; onDecide: (proposal: EditProposal, action: "accept" | "reject") => void }) { const { t } = useI18n(); return <Panel title={t("studio.proposals.title")} count={proposals.length}>{proposals.length === 0 ? <p className="studio__panel-empty">{t("studio.proposals.empty")}</p> : proposals.map((proposal) => <article key={proposal.id} className="studio__proposal" data-status={proposal.status}><strong>{proposal.instruction}</strong><del>{proposal.originalText}</del><ins>{proposal.replacementText}</ins>{proposal.status === "proposed" ? <div className="studio__proposal-actions"><button type="button" className="btn btn--primary" disabled={pending} onClick={() => onDecide(proposal, "accept")}>{t("studio.decide.accept")}</button><button type="button" className="btn" disabled={pending} onClick={() => onDecide(proposal, "reject")}>{t("studio.decide.reject")}</button></div> : <small>{proposalStatusLabel(proposal.status)}</small>}</article>)}</Panel>; }
function Panel({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const head = <><p className="studio__panel-title">{title}</p><span className="studio__panel-count">{count}</span></>;
  return <section className="studio__panel"><header className="studio__panel-head">{head}</header><div className="studio__panel-body">{children}</div></section>;
}

function reviewScoreLabel(key: string): string {
  const keys: Record<string, MessageKey> = {
    continuity: "studio.review.score.continuity",
    pacing: "studio.review.score.pacing",
    character: "studio.review.score.character",
    prose: "studio.review.score.prose",
    goal: "studio.review.score.goal",
    pov: "studio.review.score.pov",
  };
  const messageKey = keys[key];
  return messageKey ? translate(getLocale(), messageKey) : key;
}

function reviewSeverityLabel(value: ReviewWorkspaceIssue["severity"]): string {
  const keys: Record<ReviewWorkspaceIssue["severity"], MessageKey> = {
    info: "studio.review.severity.info",
    minor: "studio.review.severity.minor",
    major: "studio.review.severity.major",
    critical: "studio.review.severity.critical",
  };
  return translate(getLocale(), keys[value]);
}

function proposalStatusLabel(value: ReviewRevisionProposal["status"] | EditProposal["status"]): string {
  const keys: Record<string, MessageKey> = {
    proposed: "studio.status.proposed",
    accepted: "studio.status.accepted",
    rejected: "studio.status.rejected",
    superseded: "studio.status.superseded",
  };
  const messageKey = keys[value];
  return messageKey ? translate(getLocale(), messageKey) : value;
}

function versionSourceLabel(source: string): string {
  if (source === "manual") return translate(getLocale(), "studio.versionSource.manual");
  if (source === "manual:comment-checkpoint") return translate(getLocale(), "studio.versionSource.commentCheckpoint");
  if (source === "manual:selection-baseline") return translate(getLocale(), "studio.versionSource.selectionBaseline");
  if (source.startsWith("run:")) return translate(getLocale(), "studio.versionSource.aiContent");
  if (source.startsWith("revision:")) return translate(getLocale(), "studio.versionSource.aiRevision");
  if (source.startsWith("restore:")) return translate(getLocale(), "studio.versionSource.restored");
  return translate(getLocale(), "studio.versionSource.fallback");
}

function changeSetTouchesVersions(value: unknown, versionIds: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => changeSetTouchesVersions(item, versionIds));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.documentVersionId === "string" && versionIds.has(record.documentVersionId)) return true;
  return Object.values(record).some((item) => changeSetTouchesVersions(item, versionIds));
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** 手动结算 Run 的 policy.origin 里记录的发起文档。 */
function runOriginDocumentId(policy: unknown): string | null {
  if (!policy || typeof policy !== "object") return null;
  const origin = (policy as Record<string, unknown>).origin;
  if (!origin || typeof origin !== "object") return null;
  const documentId = (origin as Record<string, unknown>).documentId;
  return typeof documentId === "string" ? documentId : null;
}

function canonSummary(changes: Record<string, unknown>): string | null {
  return typeof changes.summary === "string" && changes.summary.trim() ? changes.summary : null;
}

function canonChangeItems(
  changes: Record<string, unknown>,
  entityNames: Map<string, string>,
): Array<{ label: string; text: string }> {
  const locale = getLocale();
  const rows: Array<{ label: string; text: string }> = [];
  const records = (key: string) => Array.isArray(changes[key])
    ? (changes[key] as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const text = (record: Record<string, unknown>, key: string) => typeof record[key] === "string" ? record[key] : "";
  const entity = (id: string) => entityNames.get(id) ?? translate(locale, "studio.canon.unknownEntity");
  for (const item of records("stateDelta")) {
    rows.push({ label: translate(locale, "studio.canon.itemLabel.stateDelta"), text: translate(locale, "studio.canon.stateDeltaText", { key: text(item, "key"), before: text(item, "before") || translate(locale, "studio.canon.noPriorRecord"), after: text(item, "after") }) });
  }
  for (const item of records("factCandidates")) {
    const value = item.value === null || item.value === undefined ? translate(locale, "studio.canon.factNoLongerHolds") : String(item.value);
    rows.push({ label: translate(locale, "studio.canon.itemLabel.fact"), text: translate(locale, "studio.canon.factText", { entity: entity(text(item, "subjectId")), predicate: text(item, "predicate"), value }) });
  }
  for (const item of records("timelineCandidates")) {
    rows.push({ label: translate(locale, "studio.canon.itemLabel.timeline"), text: [text(item, "title"), text(item, "storyTime"), text(item, "description")].filter(Boolean).join(" · ") });
  }
  for (const item of records("relationshipCandidates")) {
    rows.push({ label: translate(locale, "studio.canon.itemLabel.relationship"), text: translate(locale, "studio.canon.relationshipText", { from: entity(text(item, "fromEntityId")), to: entity(text(item, "toEntityId")), relation: text(item, "relation"), change: text(item, "change") }) });
  }
  for (const item of records("foreshadowCandidates")) {
    const actionKeys: Record<string, MessageKey> = {
      plant: "studio.canon.foreshadowAction.plant",
      develop: "studio.canon.foreshadowAction.develop",
      resolve: "studio.canon.foreshadowAction.resolve",
    };
    const action = translate(locale, actionKeys[text(item, "action")] ?? "studio.canon.foreshadowAction.fallback");
    rows.push({ label: translate(locale, "studio.canon.itemLabel.foreshadow"), text: translate(locale, "studio.canon.foreshadowText", { action, title: text(item, "title") }) });
  }
  return rows.filter((row) => row.text.replace(/[：:；；·「」]/g, "").trim());
}

/* ---- 高亮：把正文中的证据句提警出框（与旧审稿室同一手势） --------------------- */

function markQuotes(content: string, quotes: string[]) {
  if (!quotes.length) return content;
  const pieces: Array<{ text: string; hot: boolean }> = [
    { text: content, hot: false },
  ];
  for (const quote of quotes) {
    const pattern = escapeRegExp(quote);
    const next: typeof pieces = [];
    for (const piece of pieces) {
      if (piece.hot) {
        next.push(piece);
        continue;
      }
      const text = piece.text;
      const regex = new RegExp(pattern, "g");
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        if (m.index > lastIndex)
          next.push({ text: text.slice(lastIndex, m.index), hot: false });
        next.push({ text: m[0], hot: true });
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < text.length)
        next.push({ text: text.slice(lastIndex), hot: false });
    }
    pieces.splice(0, pieces.length, ...next);
  }
  return pieces.map((piece, index) =>
    piece.hot ? (
      <mark key={index}>{piece.text}</mark>
    ) : (
      <span key={index}>{piece.text}</span>
    ),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
