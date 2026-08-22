import "./shelf/shelf.css";

/* 在线体验站（VITE_TRIAL_MODE）声明数据本机边界（M5）。 */
const trialMode = import.meta.env.VITE_TRIAL_MODE === "1";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AUTOMATION_DEFAULTS } from "@narralume/contracts";
import Lenis from "lenis";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Ellipsis,
  Image as ImageIcon,
  LayoutGrid,
  PenLine,
  Plus,
  Radar,
  RotateCcw,
  Rows3,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { motion, useReducedMotion, type MotionStyle } from "motion/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router";

import { useFocusTrap } from "../app/focus-trap";
import { Empty } from "../components/empty";
import { ErrorNote } from "../components/error-note";
import { IconButton } from "../components/icon-button";
import { Skeleton } from "../components/skeleton";
import {
  LOCALES,
  LOCALE_LABELS,
  getLocale,
  translate,
  useI18n,
} from "../i18n";
import {
  applyStoryImport,
  createProject,
  createProjectWithFoundation,
  deleteProject,
  duplicateProject,
  getProjects,
  getProjectsIncludingArchived,
  getRecycledProjects,
  projectCoverBlob,
  projectCoverUrl,
  purgeRecycledProject,
  restoreRecycledProject,
  updateProject,
  uploadStoryFile,
  type ImportBatchDetail,
  type ImportFormat,
  type Project,
  type ProjectCoverMutation,
  type ProjectLanguage,
  type RecycledProject,
} from "../lib/api";
import { coverHue, formatRelativeDate, shortId } from "../lib/fmt";
import { importCandidateKindLabel, projectPhaseLabel } from "../lib/labels";
import { projectWorkspacePath } from "../lib/project-route";
import { rememberTask } from "../lib/task-ledger";

/* ==========================================================================
   藏书室：作品编目与建书入口。本页是唯一允许挂 Lenis 平滑滚动的工作区。
   ========================================================================== */

function importFormatFor(filename: string): ImportFormat {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "txt" || ext === "text") return "text";
  if (ext === "docx") return "docx";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "epub") return "epub";
  if (ext === "json") return "narrative-bundle";
  return "markdown";
}

function chapterCount(project: Project): number {
  return project.committedChapters ?? project.totalChapters ?? 0;
}

export function ShelfWorkspace() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const { t } = useI18n();

  /* Lenis 只上书架；reduced-motion 时不启。层内滚动由 data-lenis-prevent 豁免。 */
  const lenisReady = reduceMotion !== true;
  useEffect(() => {
    if (!lenisReady) return;
    const lenis = new Lenis({ lerp: 0.11 });
    let frame = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [lenisReady]);

  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [view, setView] = useState<"covers" | "list">(() =>
    window.localStorage.getItem("shelf:view") === "list" ? "list" : "covers",
  );
  const [createMode, setCreateMode] = useState<"blank" | "ai" | null>(null);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [importBatch, setImportBatch] = useState<ImportBatchDetail | null>(
    null,
  );
  const [actionError, setActionError] = useState<unknown>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectsQuery = useQuery({
    queryKey: ["projects", { archived: includeArchived }],
    queryFn: ({ signal }) =>
      includeArchived
        ? getProjectsIncludingArchived(signal)
        : getProjects(signal),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["projects"] });

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source = projectsQuery.data ?? [];
    return source
      .filter(
        (project) =>
          !needle ||
          project.title.toLowerCase().includes(needle) ||
          (project.premise ?? "").toLowerCase().includes(needle) ||
          project.id.toLowerCase().startsWith(needle),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projectsQuery.data, query]);

  const openProject = (project: Project) => {
    setMenuFor(null);
    navigate(projectWorkspacePath(project.id, "overview"));
  };

  const archiveMutation = useMutation({
    mutationFn: (project: Project) =>
      updateProject(project.id, {
        title: project.title,
        subtitle: project.subtitle,
        premise: project.premise,
        archived: !project.archivedAt,
        expectedUpdatedAt: project.updatedAt,
      }),
    onSuccess: () => {
      setMenuFor(null);
      setActionError(null);
      void refresh();
    },
    onError: (error) => {
      setMenuFor(null);
      setActionError(error);
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (project: Project) => duplicateProject(project.id),
    onSuccess: () => {
      setMenuFor(null);
      setActionError(null);
      void refresh();
    },
    onError: (error) => {
      setMenuFor(null);
      setActionError(error);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      uploadStoryFile(file, null, importFormatFor(file.name)),
    onSuccess: (detail) => {
      setActionError(null);
      setImportBatch(detail);
    },
    onError: (error) => setActionError(error),
  });

  const isEmpty = !projectsQuery.isPending && rows.length === 0 && !query;

  const selectView = (next: "covers" | "list") => {
    setMenuFor(null);
    setView(next);
    window.localStorage.setItem("shelf:view", next);
  };

  return (
    <div className="shelf">
      <div className="shelf__cta" role="group" aria-label={t("shelf.create.ariaLabel")}>
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => setCreateMode("blank")}
        >
          <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.create.blank")}
        </button>
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => setCreateMode("ai")}
        >
          <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.create.ai")}
        </button>
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          <Upload size={14} strokeWidth={1.5} aria-hidden="true" />
          {uploadMutation.isPending ? t("shelf.upload.importing") : t("shelf.upload.import")}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,.text,.docx,.html,.htm,.epub,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) uploadMutation.mutate(file);
            event.target.value = "";
          }}
        />
      </div>

      <header className="shelf__masthead">
        <p className="shelf__ghost" aria-hidden="true">
          {t("shelf.ghost")}
        </p>
        <h1 className="shelf__title">{t("shelf.title")}</h1>
        <p className="shelf__kicker mono">01 · Stacks</p>
        {trialMode ? (
          <p className="shelf__kicker" role="note">
            {t("shelf.trialNote")}
          </p>
        ) : null}
      </header>

      <div className="shelf__toolbar">
        <label className="shelf__search">
          <Search size={14} strokeWidth={1.5} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("shelf.toolbar.searchLabel")}
            placeholder={t("shelf.toolbar.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="shelf__archive-toggle"
          aria-pressed={includeArchived}
          onClick={() => setIncludeArchived((value) => !value)}
        >
          <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.toolbar.includeArchived")}
        </button>
        <button
          type="button"
          className="shelf__archive-toggle"
          onClick={() => setRecycleOpen(true)}
        >
          <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.recycle.title")}
        </button>
        <div className="shelf__view-switch" role="group" aria-label={t("shelf.toolbar.viewLabel")}>
          <button
            type="button"
            aria-pressed={view === "covers"}
            onClick={() => selectView("covers")}
          >
            <LayoutGrid size={13} strokeWidth={1.5} aria-hidden="true" />
            {t("shelf.toolbar.viewCovers")}
          </button>
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => selectView("list")}
          >
            <Rows3 size={13} strokeWidth={1.5} aria-hidden="true" />
            {t("shelf.toolbar.viewList")}
          </button>
        </div>
      </div>

      {actionError !== null ? (
        <div style={{ marginTop: "1rem" }}>
          <ErrorNote error={actionError} title={t("shelf.error.action")} />
        </div>
      ) : null}

      {projectsQuery.isPending ? (
        <div className="shelf__catalog" aria-busy="true">
          <Skeleton lines={5} />
        </div>
      ) : projectsQuery.isError ? (
        <div style={{ marginTop: "2rem" }}>
          <ErrorNote error={projectsQuery.error} title={t("shelf.error.load")} />
        </div>
      ) : isEmpty ? (
        <div className="shelf__empty">
          <p className="shelf__empty-line">{t("shelf.empty.title")}</p>
          <p className="shelf__empty-sub">
            {t("shelf.empty.sub")}
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setCreateMode("blank")}
          >
            <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
            {t("shelf.empty.cta")}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="shelf__catalog">
          <Empty
            title={t("shelf.noMatch.title")}
            description={t("shelf.noMatch.description")}
          />
        </div>
      ) : (
        <div className="shelf__catalog">
          <div className="shelf__catalog-head">
            <span className="mono">{t("shelf.catalog.worksCount", { count: rows.length })}</span>
            <span className="shelf__catalog-rule" aria-hidden="true" />
            <span className="mono">{t("shelf.catalog.latestUpdate", { date: formatRelativeDate(rows[0]!.updatedAt) })}</span>
          </div>
          {view === "covers" ? <div className="shelf__bookshelf">
          {rows.map((project) => (
            <motion.article
              key={project.id}
              className="shelf-book"
              data-archived={project.archivedAt ? "true" : "false"}
              data-menu-open={menuFor === project.id ? "true" : "false"}
              {...(reduceMotion
                ? {}
                : {
                    whileHover: "shelf-book-hover",
                    variants: { "shelf-book-hover": { y: -5 } },
                    transition: { type: "spring", stiffness: 360, damping: 28 },
              })}
              style={{ "--book-hue": coverHue(project.id) } as unknown as MotionStyle}
            >
              <button
                type="button"
                className="shelf-book__open"
                aria-label={t("shelf.book.open", { name: project.title })}
                onClick={() => openProject(project)}
              />
              <div className="shelf-book__cover-wrap">
                <BookCover project={project} />
              </div>
              <div className="shelf-book__info">
                <div className="shelf-book__title-row">
                  <h2 className="shelf-book__title">{project.title}</h2>
                  {project.archivedAt ? <span className="shelf-book__archived-tag mono">{t("shelf.book.archived")}</span> : null}
                </div>
                <p className="shelf-book__subtitle">{project.subtitle ?? projectPhaseLabel(project.phase)}</p>
                <p className="shelf-book__premise" data-empty={project.premise ? "false" : "true"}>
                  {project.premise ?? t("shelf.book.noPremise")}
                </p>
                <div className="shelf-book__meta mono">
                  <span>{t("shelf.book.chapters", { count: chapterCount(project) })}</span>
                  <span>{t("common.state.characters", { count: project.wordCount ?? 0 })}</span>
                  <span>{formatRelativeDate(project.updatedAt)}</span>
                </div>
              </div>
              <ProjectActions
                project={project}
                className="shelf-book"
                open={menuFor === project.id}
                onToggle={() => setMenuFor((value) => value === project.id ? null : project.id)}
                onClose={() => setMenuFor(null)}
                onAutopilot={() => navigate(projectWorkspacePath(project.id, "autopilot"))}
                onEdit={() => setEditTarget(project)}
                onDuplicate={() => duplicateMutation.mutate(project)}
                onArchive={() => archiveMutation.mutate(project)}
                onDelete={() => setDeleteTarget(project)}
              />
            </motion.article>
          ))}
          </div> : (
            <div className="shelf__list">
              <div className="shelf-list__head" aria-hidden="true">
                <span className="mono">{t("shelf.catalog.headNo")}</span>
                <span className="mono">{t("shelf.catalog.headTitle")}</span>
                <span className="mono">{t("shelf.catalog.headMeta")}</span>
                <span />
                <span />
              </div>
              {rows.map((project, index) => (
                <motion.article
                  key={project.id}
                  className="shelf-row"
                  data-archived={project.archivedAt ? "true" : "false"}
                  data-menu-open={menuFor === project.id ? "true" : "false"}
                  {...(reduceMotion ? {} : {
                    whileHover: "shelf-row-hover",
                    variants: { "shelf-row-hover": { x: 4 } },
                    transition: { type: "spring", stiffness: 420, damping: 30 },
                  })}
                  style={{ transformStyle: "preserve-3d" }}
                >
                  <button type="button" className="shelf-row__open" aria-label={t("shelf.book.open", { name: project.title })} onClick={() => openProject(project)} />
                  <span className="shelf-row__no">
                    <span className="mono">NO.{String(index + 1).padStart(2, "0")}</span>
                    <span className="shelf-row__id mono">{shortId(project.id)}</span>
                  </span>
                  <span className="shelf-row__body">
                    <span className="shelf-row__title">{project.title}</span>
                    <span className="shelf-row__premise" data-empty={project.premise ? "false" : "true"}>{project.premise ?? t("shelf.book.noPremiseRow")}</span>
                  </span>
                  <span className="shelf-row__meta mono">
                    {project.archivedAt ? <span className="shelf-row__archived-tag mono">{t("shelf.book.archived")}</span> : null}
                    <span>{t("shelf.book.chapters", { count: chapterCount(project) })}</span>
                    <span className="shelf-row__phase">{projectPhaseLabel(project.phase)}</span>
                    <span>{formatRelativeDate(project.updatedAt)}</span>
                  </span>
                  <ProjectActions
                    project={project}
                    className="shelf-row"
                    open={menuFor === project.id}
                    onToggle={() => setMenuFor((value) => value === project.id ? null : project.id)}
                    onClose={() => setMenuFor(null)}
                    onAutopilot={() => navigate(projectWorkspacePath(project.id, "autopilot"))}
                    onEdit={() => setEditTarget(project)}
                    onDuplicate={() => duplicateMutation.mutate(project)}
                    onArchive={() => archiveMutation.mutate(project)}
                    onDelete={() => setDeleteTarget(project)}
                  />
                  <motion.span
                    className="shelf-spine"
                    aria-hidden="true"
                    style={{ "--spine-hue": coverHue(project.id) } as MotionStyle}
                    {...(reduceMotion ? {} : {
                      variants: { "shelf-row-hover": { y: -2, rotateY: 8, rotate: -2, transformPerspective: 180 } },
                      transition: { type: "spring", stiffness: 420, damping: 24 },
                    })}
                    initial={{ rotate: -2 }}
                  >
                    <span className="shelf-spine__cap" />
                    <span className="shelf-spine__band" />
                    <span className="shelf-spine__cloth">
                      <span className="shelf-spine__emboss" />
                      <span className="shelf-spine__emboss shelf-spine__emboss--second" />
                    </span>
                  </motion.span>
                </motion.article>
              ))}
            </div>
          )}
        </div>
      )}

      {createMode ? (
        <CreateDialog
          mode={createMode}
          onClose={() => setCreateMode(null)}
          onCreated={(project) => {
            setCreateMode(null);
            void refresh();
            navigate(projectWorkspacePath(project.id, "overview"));
          }}
        />
      ) : null}
      {editTarget ? (
        <BookEditDialog
          project={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void refresh();
          }}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteDialog
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            void refresh();
          }}
        />
      ) : null}
      {recycleOpen ? (
        <RecycleBinDialog
          onClose={() => setRecycleOpen(false)}
          onChanged={() => void refresh()}
        />
      ) : null}
      {importBatch ? (
        <ImportDialog
          detail={importBatch}
          onClose={() => setImportBatch(null)}
          onApplied={(projectId) => {
            setImportBatch(null);
            void refresh();
            navigate(projectWorkspacePath(projectId, "overview"));
          }}
        />
      ) : null}
    </div>
  );
}

function ProjectActions({
  project,
  className,
  open,
  onToggle,
  onClose,
  onAutopilot,
  onEdit,
  onDuplicate,
  onArchive,
  onDelete,
}: {
  project: Project;
  className: "shelf-book" | "shelf-row";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAutopilot: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const closeAndRestoreFocus = () => {
    onClose();
    rootRef.current?.querySelector<HTMLButtonElement>(`.${className}__menu-btn`)?.focus();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
      : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <span
      ref={rootRef}
      className={`${className}__menu`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <IconButton
        icon={Ellipsis}
        label={t("shelf.book.moreActions", { name: project.title })}
        className={`${className}__menu-btn`}
        aria-expanded={open}
        onClick={onToggle}
      />
      {open ? (
        <>
          <div className="shelf-menu-backdrop" onMouseDown={onClose} />
          <div ref={menuRef} className="shelf-menu" role="menu" data-lenis-prevent onKeyDown={handleMenuKeyDown}>
            <button type="button" role="menuitem" className="shelf-menu__item" onClick={() => { onClose(); onAutopilot(); }}>
              <Radar size={13} strokeWidth={1.5} aria-hidden="true" /> {t("shelf.menu.autopilot")}
            </button>
            <button type="button" role="menuitem" className="shelf-menu__item" onClick={() => { onClose(); onEdit(); }}>
              <PenLine size={13} strokeWidth={1.5} aria-hidden="true" /> {t("shelf.menu.edit")}
            </button>
            <button type="button" role="menuitem" className="shelf-menu__item" onClick={() => { onClose(); onDuplicate(); }}>
              <Copy size={13} strokeWidth={1.5} aria-hidden="true" /> {t("common.action.copy")}
            </button>
            <button type="button" role="menuitem" className="shelf-menu__item" onClick={() => { onClose(); onArchive(); }}>
              {project.archivedAt ? <ArchiveRestore size={13} strokeWidth={1.5} aria-hidden="true" /> : <Archive size={13} strokeWidth={1.5} aria-hidden="true" />}
              {project.archivedAt ? t("shelf.menu.restore") : t("shelf.menu.archive")}
            </button>
            <div className="shelf-menu__divider" />
            <button type="button" role="menuitem" className="shelf-menu__item shelf-menu__item--danger" onClick={() => { onClose(); onDelete(); }}>
              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" /> {t("shelf.menu.recycle")}
            </button>
          </div>
        </>
      ) : null}
    </span>
  );
}

/* --- 对话框骨架 --------------------------------------------------------- */

interface ShelfDialogProps {
  eyebrow: string;
  title: string;
  note?: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

function ShelfDialog({
  eyebrow,
  title,
  note,
  className,
  onClose,
  children,
}: ShelfDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(onClose);
  return (
    <div
      className="shelf-dialog-backdrop"
      data-lenis-prevent
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className={`shelf-dialog${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-lenis-prevent
      >
        <p className="shelf-dialog__eyebrow mono">{eyebrow}</p>
        <h2 className="shelf-dialog__title">{title}</h2>
        {note ? <p className="shelf-dialog__note">{note}</p> : null}
        {children}
      </div>
    </div>
  );
}

/* --- 建书（空白 / AI 引导） --------------------------------------------- */

function CreateDialog({
  mode,
  onClose,
  onCreated,
}: {
  mode: "blank" | "ai";
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [language, setLanguage] = useState<ProjectLanguage>("zh-CN");
  const aiRequestRef = useRef<{ identity: string; requestId: string } | null>(null);
  const blankRequestRef = useRef<{ identity: string; requestId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: {
      title: string;
      premise: string | null;
      language: ProjectLanguage;
    }) => {
      /* 空白建书走纯项目创建（无模型也可用）；AI 引导建书一次立项并发起
         foundation 后台任务，requestId 即本次提交的幂等键。 */
      if (mode === "ai" && input.premise) {
        const request = {
          title: input.title,
          premise: input.premise,
          language: input.language,
          braindump: input.premise,
          preferences: {
            genre: null,
            audience: null,
            tone: null,
            ...AUTOMATION_DEFAULTS,
          },
          policy: { qualityPreset: "standard" as const },
        };
        const identity = JSON.stringify(request);
        if (aiRequestRef.current?.identity !== identity) {
          aiRequestRef.current = {
            identity,
            requestId: crypto.randomUUID(),
          };
        }
        const created = await createProjectWithFoundation({
          ...request,
          requestId: aiRequestRef.current.requestId,
        });
        rememberTask({
          projectId: created.project.id,
          kind: "foundation",
          taskId: created.task.run.id,
          label: t("shelf.create.taskLabel", { name: created.project.title }),
          createdAt: new Date().toISOString(),
          origin: { surface: "autopilot" },
        });
        return created.project;
      }
      const identity = JSON.stringify(input);
      if (blankRequestRef.current?.identity !== identity) {
        blankRequestRef.current = {
          identity,
          requestId: crypto.randomUUID(),
        };
      }
      return createProject({
        ...input,
        requestId: blankRequestRef.current.requestId,
      });
    },
    onSuccess: (project) => {
      aiRequestRef.current = null;
      blankRequestRef.current = null;
      onCreated(project);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || (mode === "ai" && !premise.trim())) return;
    mutation.mutate({
      title: trimmed,
      premise: premise.trim() ? premise.trim() : null,
      language,
    });
  };

  return (
    <ShelfDialog
      eyebrow="NEW VOLUME"
      title={mode === "blank" ? t("shelf.create.blank") : t("shelf.create.ai")}
      note={
        mode === "blank"
          ? t("shelf.create.noteBlank")
          : t("shelf.create.noteAi")
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="create-title">
            {t("shelf.create.titleLabel")}
          </label>
          <input
            id="create-title"
            className="shelf-dialog__input"
            placeholder={t("shelf.create.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </div>
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="create-language">
            {t("shelf.create.languageLabel")}
          </label>
          <select
            id="create-language"
            className="shelf-dialog__input"
            value={language}
            onChange={(event) => setLanguage(event.target.value as ProjectLanguage)}
          >
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {LOCALE_LABELS[locale]}
              </option>
            ))}
          </select>
        </div>
        <div className="shelf-dialog__field">
          <label
            className="shelf-dialog__label mono"
            htmlFor="create-premise"
          >
            {mode === "blank" ? t("shelf.create.premiseLabelBlank") : t("shelf.create.premiseLabelAi")}
          </label>
          {mode === "blank" ? (
            <input
              id="create-premise"
              className="shelf-dialog__input"
              placeholder={t("shelf.create.premisePlaceholderBlank")}
              value={premise}
              onChange={(event) => setPremise(event.target.value)}
            />
          ) : (
            <textarea
              id="create-premise"
              className="shelf-dialog__textarea"
              rows={4}
              placeholder={t("shelf.create.premisePlaceholderAi")}
              value={premise}
              onChange={(event) => setPremise(event.target.value)}
            />
          )}
        </div>
        {mutation.isError ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={mutation.error} title={t("shelf.create.error")} />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("common.action.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              mutation.isPending ||
              !title.trim() ||
              (mode === "ai" && !premise.trim())
            }
          >
            {mutation.isPending
              ? t("shelf.create.submitting")
              : mode === "blank"
                ? t("shelf.create.submitBlank")
                : t("shelf.create.submitAi")}
          </button>
        </div>
      </form>
    </ShelfDialog>
  );
}

/* --- 封面取景弹窗 ----------------------------------------------------------
   基于 react-easy-crop：固定 3:4 竖版取景框，拖图 + 滚轮/滑杆缩放底图。
   确认时用 canvas 按像素框裁出最终封面（所见即所得），调用方把它作为
   prepared 上传、crop 归中 {0.5, 0.5, 1}，既有渲染契约不变。 */

import Cropper, { type Area, type Point } from "react-easy-crop";

function CoverCropDialog({
  prepared,
  onConfirm,
  onClose,
}: {
  prepared: PreparedCover;
  onConfirm: (cropped: PreparedCover) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const trapRef = useFocusTrap<HTMLDivElement>(onClose);
  const [point, setPoint] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [cutting, setCutting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* 按像素框裁出最终封面：croppedAreaPixels 相对原图坐标，直接 drawImage。 */
  const confirm = async () => {
    if (!area || cutting) return;
    setCutting(true);
    setError(null);
    try {
      const cropped = await cropPreparedCover(prepared, area);
      onConfirm(cropped);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("shelf.crop.fallback"));
      setCutting(false);
    }
  };

  return (
    <div
      className="shelf-dialog-backdrop"
      data-lenis-prevent
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="shelf-dialog shelf-dialog--crop"
        role="dialog"
        aria-modal="true"
        aria-label={t("shelf.crop.title")}
        data-lenis-prevent
      >
        <p className="shelf-dialog__eyebrow mono">COVER CROP</p>
        <h2 className="shelf-dialog__title">{t("shelf.crop.title")}</h2>
        <p className="shelf-dialog__note">
          {t("shelf.crop.note")}
        </p>
        <div className="cover-cropper__stage cover-cropper__stage--dialog">
          <Cropper
            image={prepared.dataUrl}
            crop={point}
            zoom={zoom}
            aspect={3 / 4}
            minZoom={1}
            maxZoom={3}
            cropShape="rect"
            showGrid
            onCropChange={setPoint}
            onZoomChange={setZoom}
            onCropComplete={(_percent, pixels) => setArea(pixels)}
          />
        </div>
        {error ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={error} title={t("shelf.crop.error")} />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("common.action.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!area || cutting}
            onClick={() => void confirm()}
          >
            {cutting ? t("shelf.crop.cutting") : t("shelf.crop.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* 把原图按像素框裁成 3:4 封面，走与 readCoverFile 相同的 webp 输出。 */
function cropPreparedCover(
  source: PreparedCover,
  area: Area,
): Promise<PreparedCover> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error(translate(getLocale(), "shelf.coverFile.cropRead")));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(area.width));
      canvas.height = Math.max(1, Math.round(area.height));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error(translate(getLocale(), "shelf.coverFile.unsupported")));
        return;
      }
      context.drawImage(
        image,
        area.x,
        area.y,
        area.width,
        area.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error(translate(getLocale(), "shelf.coverFile.cropFail")));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error(translate(getLocale(), "shelf.coverFile.encode")));
          reader.onload = () => {
            const dataUrl = String(reader.result ?? "");
            const comma = dataUrl.indexOf(",");
            if (comma < 0) {
              reject(new Error(translate(getLocale(), "shelf.coverFile.encodeInvalid")));
              return;
            }
            resolve({
              mediaType: "image/webp",
              imageBase64: dataUrl.slice(comma + 1),
              width: canvas.width,
              height: canvas.height,
              dataUrl,
            });
          };
          reader.readAsDataURL(blob);
        },
        "image/webp",
        0.9,
      );
    };
    image.src = source.dataUrl;
  });
}

function BookCover({ project }: { project: Project }) {
  const { t } = useI18n();
  const imageUrl = projectCoverUrl(project);
  const [localUrl, setLocalUrl] = useState<string | null>(
    imageUrl && imageUrl.startsWith("blob:") ? imageUrl : null,
  );
  useEffect(() => {
    // local 驱动下封面无 HTTP URL，改取内核 bytes 缓存为 Blob URL。
    if (!project.cover || imageUrl) return;
    let cancelled = false;
    void projectCoverBlob(project)
      .then((url) => {
        if (!cancelled && url) setLocalUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, imageUrl]);
  const crop = project.cover?.crop;
  const src = imageUrl ?? localUrl;
  return (
    <div
      className="book-cover"
      style={{ "--book-hue": coverHue(project.id) } as CSSProperties}
    >
      {src ? (
        <img
          className="book-cover__image"
          src={src}
          alt={t("shelf.book.customCover", { name: project.title })}
          style={{
            objectPosition: `${(crop?.x ?? 0.5) * 100}% ${(crop?.y ?? 0.5) * 100}%`,
            transform: `scale(${crop?.zoom ?? 1})`,
            transformOrigin: `${(crop?.x ?? 0.5) * 100}% ${(crop?.y ?? 0.5) * 100}%`,
          }}
        />
      ) : (
        <div className="book-cover__default" role="img" aria-label={t("shelf.book.defaultCover", { name: project.title })}>
          <span className="book-cover__mark mono">NL · {project.phase.slice(0, 1).toUpperCase()}</span>
          <strong>{project.title}</strong>
          <span>{project.subtitle ?? t("shelf.book.unfinished")}</span>
          <i aria-hidden="true" />
        </div>
      )}
      <span className="book-cover__edge" aria-hidden="true" />
    </div>
  );
}

interface PreparedCover {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  imageBase64: string;
  width: number;
  height: number;
  dataUrl: string;
}

function readCoverFile(file: File): Promise<PreparedCover> {
  const mediaType = file.type as PreparedCover["mediaType"];
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
    return Promise.reject(new Error(translate(getLocale(), "shelf.coverFile.type")));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(translate(getLocale(), "shelf.coverFile.read")));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const image = new Image();
      image.onerror = () => reject(new Error(translate(getLocale(), "shelf.coverFile.identify")));
      image.onload = () => {
        const maxEdge = 2400;
        const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error(translate(getLocale(), "shelf.coverFile.unsupported")));
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error(translate(getLocale(), "shelf.coverFile.compress")));
              return;
            }
            if (blob.size > 8 * 1024 * 1024) {
              reject(new Error(translate(getLocale(), "shelf.coverFile.tooLarge")));
              return;
            }
            const outputReader = new FileReader();
            outputReader.onerror = () => reject(new Error(translate(getLocale(), "shelf.coverFile.process")));
            outputReader.onload = () => {
              const outputUrl = String(outputReader.result ?? "");
              const comma = outputUrl.indexOf(",");
              if (comma < 0) {
                reject(new Error(translate(getLocale(), "shelf.coverFile.encodeInvalid")));
                return;
              }
              resolve({
                mediaType: "image/webp",
                imageBase64: outputUrl.slice(comma + 1),
                width,
                height,
                dataUrl: outputUrl,
              });
            };
            outputReader.readAsDataURL(blob);
          },
          "image/webp",
          0.9,
        );
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function BookEditDialog({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(project.title);
  const [subtitle, setSubtitle] = useState(project.subtitle ?? "");
  const [premise, setPremise] = useState(project.premise ?? "");
  const [language, setLanguage] = useState<ProjectLanguage>(project.language);
  const [prepared, setPrepared] = useState<PreparedCover | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [cropSource, setCropSource] = useState<PreparedCover | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      // 资料与封面在同一个请求里提交，服务端事务保证要么全部生效要么全部回滚。
      // 封面取景已在上传前裁好，crop 恒为居中。
      const cover: ProjectCoverMutation | undefined = removeCover
        ? { action: "remove" }
        : prepared
          ? {
              action: "put",
              mediaType: prepared.mediaType,
              imageBase64: prepared.imageBase64,
              width: prepared.width,
              height: prepared.height,
              crop: { x: 0.5, y: 0.5, zoom: 1 },
            }
          : undefined;
      await updateProject(project.id, {
        title: title.trim(),
        subtitle: subtitle.trim() || null,
        premise: premise.trim() || null,
        language,
        archived: project.archivedAt !== null,
        expectedUpdatedAt: project.updatedAt,
        ...(cover ? { cover } : {}),
      });
    },
    onSuccess: () => onSaved(),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    mutation.mutate();
  };

  return (
    <ShelfDialog
      eyebrow="EDIT BOOK"
      title={t("shelf.edit.title")}
      note={t("shelf.edit.note")}
      className="shelf-dialog--book-edit"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="book-edit__layout">
          <div className="book-edit__preview">
            {prepared ? (
              <div className="book-cover book-cover--editing">
                <img
                  className="book-cover__image"
                  src={prepared.dataUrl}
                  alt={t("shelf.edit.previewAlt")}
                />
              </div>
            ) : removeCover ? (
              <div className="book-cover book-cover--editing"><div className="book-cover__default"><strong>{title}</strong><span>{t("shelf.edit.restoreDefault")}</span><i aria-hidden="true" /></div></div>
            ) : (
              <BookCover project={{ ...project, title, subtitle: subtitle || null }} />
            )}
            <label className="btn btn--outline book-edit__upload">
              <ImageIcon size={14} strokeWidth={1.5} aria-hidden="true" />
              {readingFile ? t("shelf.edit.reading") : t("shelf.edit.choose")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setReadingFile(true);
                  setFileError(null);
                  void readCoverFile(file)
                    .then((value) => {
                      setRemoveCover(false);
                      /* 读入后立刻弹取景窗：裁好的图才进 prepared。 */
                      setCropSource(value);
                    })
                    .catch((error: unknown) => setFileError(error instanceof Error ? error.message : t("shelf.edit.readError")))
                    .finally(() => setReadingFile(false));
                }}
              />
            </label>
            <button type="button" className="book-edit__reset" onClick={() => { setPrepared(null); setRemoveCover(true); }}>
              <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
              {t("shelf.edit.reset")}
            </button>
          </div>
          <div className="book-edit__fields">
            <div className="shelf-dialog__field">
              <label className="shelf-dialog__label mono" htmlFor="edit-title">{t("shelf.edit.titleLabel")}</label>
              <input id="edit-title" className="shelf-dialog__input" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
            </div>
            <div className="shelf-dialog__field">
              <label className="shelf-dialog__label mono" htmlFor="edit-subtitle">{t("shelf.edit.subtitleLabel")}</label>
              <input id="edit-subtitle" className="shelf-dialog__input" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder={t("shelf.edit.subtitlePlaceholder")} />
            </div>
            <div className="shelf-dialog__field">
              <label className="shelf-dialog__label mono" htmlFor="edit-premise">{t("shelf.edit.premiseLabel")}</label>
              <textarea id="edit-premise" className="shelf-dialog__textarea" rows={4} value={premise} onChange={(event) => setPremise(event.target.value)} placeholder={t("shelf.edit.premisePlaceholder")} />
            </div>
            <div className="shelf-dialog__field">
              <label className="shelf-dialog__label mono" htmlFor="edit-language">{t("shelf.edit.languageLabel")}</label>
              <select
                id="edit-language"
                className="shelf-dialog__input"
                value={language}
                onChange={(event) => setLanguage(event.target.value as ProjectLanguage)}
              >
                {LOCALES.map((locale) => (
                  <option key={locale} value={locale}>
                    {LOCALE_LABELS[locale]}
                  </option>
                ))}
              </select>
            </div>
            <p className="book-edit__hint">{t("shelf.edit.hint")}</p>
          </div>
        </div>
        {fileError ? <div className="shelf-dialog__error"><ErrorNote error={fileError} title={t("shelf.edit.fileError")} /></div> : null}
        {mutation.isError ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={mutation.error} title={t("shelf.edit.saveError")} />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("common.action.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={mutation.isPending || readingFile || !title.trim()}
          >
            {mutation.isPending ? t("shelf.edit.saving") : t("shelf.edit.submit")}
          </button>
        </div>
      </form>
      {cropSource ? (
        <CoverCropDialog
          prepared={cropSource}
          onClose={() => setCropSource(null)}
          onConfirm={(cropped) => {
            setPrepared(cropped);
            setCropSource(null);
          }}
        />
      ) : null}
    </ShelfDialog>
  );
}

/* --- 移入回收站（输入书名确认） ----------------------------------------- */

function DeleteDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      deleteProject({
        id: project.id,
        title: project.title,
        updatedAt: project.updatedAt,
      }),
    onSuccess: () => onDeleted(),
  });

  return (
    <ShelfDialog
      eyebrow="DESTROY"
      title={t("shelf.deleteBook.title")}
      note={t("shelf.deleteBook.note", { name: project.title })}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmation === project.title) mutation.mutate();
        }}
      >
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="delete-confirm">
            {t("shelf.deleteBook.confirmLabel")}
          </label>
          <input
            id="delete-confirm"
            className="shelf-dialog__input"
            placeholder={project.title}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoFocus
          />
        </div>
        {mutation.isError ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={mutation.error} title={t("shelf.deleteBook.error")} />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("shelf.deleteBook.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={mutation.isPending || confirmation !== project.title}
          >
            {mutation.isPending ? t("shelf.deleteBook.submitting") : t("shelf.deleteBook.submit")}
          </button>
        </div>
      </form>
    </ShelfDialog>
  );
}

function RecycleBinDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [purgeTarget, setPurgeTarget] = useState<RecycledProject | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const projectsQuery = useQuery({
    queryKey: ["projects", "recycle-bin"],
    queryFn: ({ signal }) => getRecycledProjects(signal),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["projects", "recycle-bin"] });
    onChanged();
  };
  const restoreMutation = useMutation({
    mutationFn: restoreRecycledProject,
    onSuccess: refresh,
  });
  const purgeMutation = useMutation({
    mutationFn: purgeRecycledProject,
    onSuccess: () => {
      setPurgeTarget(null);
      setConfirmation("");
      refresh();
    },
  });
  return (
    <ShelfDialog
      eyebrow="RECYCLE"
      title={t("shelf.recycle.title")}
      note={t("shelf.recycle.note")}
      onClose={onClose}
    >
      {projectsQuery.isPending ? <Skeleton lines={4} /> : projectsQuery.isError ? <ErrorNote error={projectsQuery.error} title={t("shelf.recycle.loadError")} /> : projectsQuery.data?.length ? (
        <div className="shelf-recycle">
          {projectsQuery.data.map((project) => (
            <article key={project.id} className="shelf-recycle__item">
              <div><strong>{project.title}</strong><p>{t("shelf.recycle.autoClean", { date: new Date(project.deleteAfter).toLocaleDateString(getLocale()) })}</p></div>
              <div className="shelf-recycle__actions">
                <button type="button" className="btn btn--outline" disabled={restoreMutation.isPending || purgeMutation.isPending} onClick={() => restoreMutation.mutate(project)}>{t("shelf.recycle.restore")}</button>
                <button type="button" className="btn btn--outline" disabled={restoreMutation.isPending || purgeMutation.isPending} onClick={() => { setPurgeTarget(project); setConfirmation(""); }}>{t("shelf.recycle.purge")}</button>
              </div>
            </article>
          ))}
        </div>
      ) : <Empty title={t("shelf.recycle.empty")} description={t("shelf.recycle.emptyHint")} />}
      {purgeTarget ? (
        <div className="shelf-recycle__confirm">
          <p>{t("shelf.recycle.purgeNote", { name: purgeTarget.title })}</p>
          <input aria-label={t("shelf.recycle.purgeConfirmLabel")} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          <div className="shelf-dialog__actions">
            <button type="button" className="btn btn--outline" onClick={() => setPurgeTarget(null)}>{t("common.action.cancel")}</button>
            <button type="button" className="btn btn--primary" disabled={confirmation !== purgeTarget.title || purgeMutation.isPending} onClick={() => purgeMutation.mutate(purgeTarget)}>{t("shelf.recycle.purge")}</button>
          </div>
        </div>
      ) : null}
      {restoreMutation.isError ? <ErrorNote error={restoreMutation.error} title={t("shelf.recycle.restoreError")} /> : null}
      {purgeMutation.isError ? <ErrorNote error={purgeMutation.error} title={t("shelf.recycle.purgeError")} /> : null}
    </ShelfDialog>
  );
}

/* --- 导入旧稿（预览候选 → 勾选 → 应用） ---------------------------------- */

function ImportDialog({
  detail,
  onClose,
  onApplied,
}: {
  detail: ImportBatchDetail;
  onClose: () => void;
  onApplied: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>(() =>
    detail.candidates.map((candidate) => candidate.id),
  );
  const mutation = useMutation({
    mutationFn: (ids: string[]) => applyStoryImport(detail.batch.id, ids),
    onSuccess: ({ projectId }) => onApplied(projectId),
  });

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );

  return (
    <ShelfDialog
      eyebrow="FICHE"
      title={t("shelf.import.title", { name: detail.batch.filename })}
      note={t("shelf.import.note", { count: detail.candidates.length })}
      onClose={onClose}
    >
      <div className="shelf-dialog__candidates">
        {detail.candidates.map((candidate) => (
          <label key={candidate.id} className="shelf-candidate">
            <input
              type="checkbox"
              checked={selected.includes(candidate.id)}
              onChange={() => toggle(candidate.id)}
            />
            <span className="shelf-candidate__kind mono">
              {importCandidateKindLabel(candidate.kind)}
            </span>
            <span className="shelf-candidate__title">{candidate.title}</span>
          </label>
        ))}
      </div>
      {mutation.isError ? (
        <div className="shelf-dialog__error">
          <ErrorNote error={mutation.error} title={t("shelf.import.error")} />
        </div>
      ) : null}
      <div className="shelf-dialog__actions">
        <button type="button" className="btn btn--outline" onClick={onClose}>
          {t("shelf.import.cancel")}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={mutation.isPending || selected.length === 0}
          onClick={() => mutation.mutate(selected)}
        >
          {mutation.isPending ? t("shelf.import.submitting") : t("shelf.import.submit", { count: selected.length })}
        </button>
      </div>
    </ShelfDialog>
  );
}
