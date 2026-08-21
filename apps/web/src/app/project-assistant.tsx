import "./project-assistant.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  ArrowUp,
  Archive,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock3,
  Cpu,
  ExternalLink,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { ErrorNote } from "../components/error-note";
import {
  getLocale,
  translate,
  useI18n,
  type MessageKey,
} from "../i18n";
import {
  archiveAssistantConversation,
  configureAssistantConversation,
  controlAutopilotSession,
  controlRun,
  createAssistantConversation,
  decideAssistantActivity,
  getAssistantConversation,
  getAssistantConversations,
  listAssignments,
  listModels,
  listProviders,
  renameAssistantConversation,
  sendAssistantMessage,
  type AssistantActivityDto,
  type AssistantContext,
  type AssistantConversationDetailDto,
  type AssistantConversationDto,
  type AssistantMessageDto,
} from "../lib/api";
import { formatRelativeDate } from "../lib/fmt";
import { stopReasonLabel } from "../lib/labels";
import { projectWorkspacePath } from "../lib/project-route";
import { useServerEvents } from "../lib/sse";

const CONVERSATION_KEY_PREFIX = "narralume:assistant-conversation:";
const PROJECT_CONTEXT: AssistantContext = {
  surface: "project",
  documentId: null,
  outlineNodeId: null,
  canonSpread: null,
  selection: null,
};

interface ProjectAssistantProps {
  projectId: string;
  context: AssistantContext;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

type TimelineEntry =
  | { type: "message"; at: string; id: string; message: AssistantMessageDto }
  | {
      type: "activity";
      at: string;
      id: string;
      activity: AssistantActivityDto;
    };

interface PendingAssistantSend {
  identity: string;
  conversationRequestId: string;
  messageRequestId: string;
  targetConversationId: string | null;
}

export function ProjectAssistant({
  projectId,
  context,
  open,
  onOpen,
  onClose,
}: ProjectAssistantProps) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [usePageContext, setUsePageContext] = useState(true);
  const [conversationId, setConversationId] = useState<string | null>(() =>
    rememberedConversation(projectId),
  );
  const messageContext = usePageContext ? context : PROJECT_CONTEXT;
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(open);
  const pendingSendRef = useRef<PendingAssistantSend | null>(null);
  const defaultConversationRequestedRef = useRef(false);
  const conversationsQuery = useQuery({
    queryKey: ["assistant", projectId, "conversations"],
    queryFn: ({ signal }) => getAssistantConversations(projectId, signal),
  });

  useEffect(() => {
    const conversations = conversationsQuery.data;
    if (!conversations) return;
    const selected = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (selected) return;
    const next = conversations.find(
      (conversation) => conversation.status === "active",
    );
    selectConversation(projectId, next?.id ?? null, setConversationId);
  }, [conversationId, conversationsQuery.data, projectId]);

  const detailQuery = useQuery({
    queryKey: ["assistant", projectId, "conversation", conversationId],
    queryFn: ({ signal }) => getAssistantConversation(conversationId!, signal),
    enabled: Boolean(conversationId),
    refetchInterval: (query) =>
      hasLiveActivity(query.state.data) ? 1_500 : false,
  });
  const relatedRunIds = useMemo(
    () => assistantRunIds(detailQuery.data),
    [detailQuery.data],
  );
  useServerEvents({
    onRunStatus: (runId) => {
      if (relatedRunIds.has(runId))
        void invalidateAssistantDetail(queryClient, projectId, conversationId);
    },
    onRunEvent: (runId) => {
      if (relatedRunIds.has(runId))
        void invalidateAssistantDetail(queryClient, projectId, conversationId);
    },
  }, open && Boolean(conversationId));

  const createMutation = useMutation({
    mutationFn: (title?: string) =>
      createAssistantConversation(projectId, {
        requestId: createRequestId(),
        title: title ?? translate(getLocale(), "assistant.conversation.defaultTitle"),
      }),
    onSuccess: (conversation) => {
      pendingSendRef.current = null;
      queryClient.setQueryData<AssistantConversationDto[]>(
        ["assistant", projectId, "conversations"],
        (current = []) => [
          conversation,
          ...current.filter((candidate) => candidate.id !== conversation.id),
        ],
      );
      selectConversation(projectId, conversation.id, setConversationId);
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
    onError: () => {
      defaultConversationRequestedRef.current = false;
    },
  });
  useEffect(() => {
    const conversations = conversationsQuery.data;
    if (
      !conversations ||
      conversations.some((conversation) => conversation.status === "active") ||
      defaultConversationRequestedRef.current
    ) {
      return;
    }
    defaultConversationRequestedRef.current = true;
    createMutation.mutate(undefined);
  }, [conversationsQuery.data, createMutation]);

  const archiveMutation = useMutation({
    mutationFn: (targetConversationId: string) =>
      archiveAssistantConversation(targetConversationId),
    onSuccess: (conversation) => {
      const next = conversationsQuery.data?.find(
        (candidate) =>
          candidate.id !== conversation.id && candidate.status === "active",
      );
      selectConversation(projectId, next?.id ?? null, setConversationId);
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
  });
  const [renamingConversation, setRenamingConversation] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      renameAssistantConversation(input.conversationId, input.title),
    onSuccess: () => {
      setRenamingConversation(false);
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
  });
  const configureMutation = useMutation({
    mutationFn: (input: {
      conversationId: string;
      modelId?: string | null;
      reasoningEffort?: string | null;
    }) =>
      configureAssistantConversation(input.conversationId, {
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: input.reasoningEffort }),
      }),
    onSuccess: (conversation) => {
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversation", conversation.id],
      });
    },
  });
  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      const contextSnapshot = messageContext;
      const identity = JSON.stringify({ content, context: contextSnapshot });
      if (pendingSendRef.current?.identity !== identity) {
        pendingSendRef.current = {
          identity,
          conversationRequestId: createRequestId(),
          messageRequestId: createRequestId(),
          targetConversationId: conversationId,
        };
      }
      const pending = pendingSendRef.current;
      let targetConversationId = pending.targetConversationId;
      if (!targetConversationId) {
        const conversation = await createAssistantConversation(projectId, {
          requestId: pending.conversationRequestId,
          title: translate(getLocale(), "assistant.conversation.defaultTitle"),
        });
        targetConversationId = conversation.id;
        pending.targetConversationId = conversation.id;
        selectConversation(projectId, conversation.id, setConversationId);
      }
      return {
        conversationId: targetConversationId,
        accepted: await sendAssistantMessage(targetConversationId, {
          requestId: pending.messageRequestId,
          content,
          context: contextSnapshot,
        }),
      };
    },
    onSuccess: ({ conversationId: targetConversationId }) => {
      pendingSendRef.current = null;
      setDraft("");
      void queryClient.invalidateQueries({
        queryKey: [
          "assistant",
          projectId,
          "conversation",
          targetConversationId,
        ],
      });
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
  });
  const activityMutation = useMutation({
    mutationFn: (input: {
      activityId: string;
      action: "confirm" | "reject" | "retry" | "resume" | "cancel";
    }) => decideAssistantActivity(input.activityId, input.action),
    onSettled: () =>
      invalidateAssistant(queryClient, projectId, conversationId),
  });
  /* 侧栏的低风险直连动作：run/autopilot 卡的取消直接走各自控制端点，
   *  不经 assistant activity 通道（那套只服务工具提案/长期目标）。
   *  失败章节卡的重试同理——与运行中心「重试本章」同一动作。 */
  const taskControlMutation = useMutation({
    mutationFn: async ({
      activity,
      action,
    }: {
      activity: AssistantActivityDto;
      action: "cancel" | "retry_chapter";
    }): Promise<unknown> => {
      // 返回结构随来源不同（RunSnapshot vs 会话详情），这里只关心成功与否。
      if (action === "retry_chapter") {
        return controlRun(projectId, activity.sourceId, {
          action: "retry_chapter",
          requestId: crypto.randomUUID(),
        });
      }
      if (activity.sourceType === "autopilot") {
        await controlAutopilotSession(activity.sourceId, {
          action: "cancel",
        });
        return null;
      }
      return controlRun(projectId, activity.sourceId, { action: "cancel" });
    },
    onSettled: () =>
      invalidateAssistant(queryClient, projectId, conversationId),
  });

  const entries = useMemo(
    () => timelineEntries(detailQuery.data),
    [detailQuery.data],
  );
  const activeCount =
    detailQuery.data?.activities.filter((activity) =>
      ["queued", "running", "waiting", "proposed"].includes(activity.status),
    ).length ?? 0;
  const currentConversation = conversationsQuery.data?.find(
    (conversation) => conversation.id === conversationId,
  );
  const conversationArchived = currentConversation?.status === "archived";
  const submitRename = () => {
    const title = renameDraft.trim();
    if (!conversationId || !title || title === currentConversation?.title) {
      setRenamingConversation(false);
      return;
    }
    renameMutation.mutate({ conversationId, title });
  };

  useEffect(() => {
    if (!open) return;
    const frame = timelineRef.current;
    if (!frame) return;
    frame.scrollTo({ top: frame.scrollHeight, behavior: "smooth" });
  }, [entries.length, open]);

  useEffect(() => {
    if (wasOpenRef.current && !open) triggerRef.current?.focus();
    wasOpenRef.current = open;
  }, [open]);

  const submit = (content = draft) => {
    const value = content.trim();
    if (!value || sendMutation.isPending) return;
    sendMutation.mutate(value);
  };

  return (
    <>
      {!open ? (
        <button
          ref={triggerRef}
          type="button"
          className="assistant-trigger"
          onClick={onOpen}
          aria-label={t("assistant.trigger.open")}
          title={t("assistant.trigger.title")}
        >
          <MessageSquareText size={17} strokeWidth={1.5} aria-hidden="true" />
          <span>{t("assistant.trigger.label")}</span>
          {activeCount > 0 ? (
            <span className="assistant-trigger__count mono">{activeCount}</span>
          ) : null}
        </button>
      ) : null}
      {open ? (
        <div
          className="assistant-backdrop"
          aria-hidden="true"
          onClick={onClose}
        />
      ) : null}
      {open ? (
        <aside
          className="assistant-panel"
          data-open="true"
          aria-label={t("assistant.panel.label")}
        >
        <header className="assistant-panel__head">
          <div className="assistant-panel__identity">
            <p className="assistant-panel__eyebrow mono">PROJECT ASSISTANT</p>
            {renamingConversation ? (
              <form className="assistant-conv__rename" onSubmit={(event) => { event.preventDefault(); submitRename(); }}>
                <input
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRenamingConversation(false);
                  }}
                  autoFocus
                  maxLength={200}
                  aria-label={t("assistant.conversation.renameLabel")}
                  placeholder={t("assistant.conversation.renamePlaceholder")}
                />
                <button
                  type="submit"
                  className="assistant-conv__rename-save"
                  disabled={renameMutation.isPending || !renameDraft.trim()}
                >
                  {renameMutation.isPending ? t("common.state.saving") : t("common.action.save")}
                </button>
              </form>
            ) : (
              <ConversationPicker
                conversations={conversationsQuery.data ?? []}
                loading={conversationsQuery.isPending}
                value={conversationId}
                onSelect={(next) =>
                  selectConversation(projectId, next, setConversationId)
                }
              />
            )}
          </div>
          <div className="assistant-panel__head-actions">
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.conversation.renameAction")}
              title={t("assistant.conversation.renameAction")}
              disabled={!conversationId}
              onClick={() => {
                setRenameDraft(currentConversation?.title ?? "");
                setRenamingConversation(true);
              }}
            >
              <Pencil size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.conversation.archiveAction")}
              title={t("assistant.conversation.archiveAction")}
              disabled={
                !conversationId || conversationArchived || archiveMutation.isPending
              }
              onClick={() => conversationId && archiveMutation.mutate(conversationId)}
            >
              <Archive size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.conversation.createAction")}
              title={t("assistant.conversation.createAction")}
              disabled={createMutation.isPending}
              onClick={() =>
                createMutation.mutate(
                  t("assistant.conversation.newTitle", {
                    count: (conversationsQuery.data?.length ?? 0) + 1,
                  }),
                )
              }
            >
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.panel.close")}
              onClick={onClose}
            >
              <X size={17} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        </header>

        <ContextRibbon
          context={messageContext}
          usingPageContext={usePageContext}
          onToggleScope={() => setUsePageContext((current) => !current)}
        />

        <div className="assistant-panel__timeline" ref={timelineRef}>
          {conversationsQuery.isError ? (
            <ErrorNote
              error={conversationsQuery.error}
              title={t("assistant.errors.loadConversations")}
            />
          ) : detailQuery.isError ? (
            <ErrorNote error={detailQuery.error} title={t("assistant.errors.loadDetail")} />
          ) : entries.length > 0 ? (
            <ol className="assistant-timeline" aria-live="polite">
              {entries.map((entry) => (
                <li key={`${entry.type}:${entry.id}`}>
                  {entry.type === "message" ? (
                    <MessageEntry message={entry.message} />
                  ) : (
                    <ActivityEntry
                      projectId={projectId}
                      activity={entry.activity}
                      pending={
                        activityMutation.isPending &&
                        activityMutation.variables?.activityId ===
                          activityActionId(entry.activity)
                      }
                      onDecision={(action) => {
                        const activityId = activityActionId(entry.activity);
                        if (activityId) {
                          activityMutation.mutate({ activityId, action });
                        }
                      }}
                      onCancelTask={
                        entry.activity.availableActions.includes("cancel") &&
                        (entry.activity.sourceType === "run" ||
                          entry.activity.sourceType === "autopilot")
                          ? () =>
                              taskControlMutation.mutate({
                                activity: entry.activity,
                                action: "cancel",
                              })
                          : null
                      }
                      onRetryChapter={
                        entry.activity.availableActions.includes(
                          "retry_chapter",
                        ) && entry.activity.sourceType === "run"
                          ? () =>
                              taskControlMutation.mutate({
                                activity: entry.activity,
                                action: "retry_chapter",
                              })
                          : null
                      }
                    />
                  )}
                </li>
              ))}
            </ol>
          ) :
              conversationsQuery.isPending ||
                (Boolean(conversationId) && detailQuery.isPending) ? (
            <div className="assistant-panel__loading" role="status">
              <CircleDashed size={18} strokeWidth={1.4} aria-hidden="true" />
              {t("assistant.loading")}
            </div>
          ) : (
            <AssistantWelcome onPrompt={submit} />
          )}
        </div>

        <footer className="assistant-composer">
          {sendMutation.isError ? (
            <ErrorNote error={sendMutation.error} title={t("assistant.errors.sendMessage")} />
          ) : null}
          {activityMutation.isError ? (
            <ErrorNote
              error={activityMutation.error}
              title={t("assistant.errors.decideActivity")}
            />
          ) : null}
          {archiveMutation.isError ? (
            <ErrorNote error={archiveMutation.error} title={t("assistant.errors.archive")} />
          ) : null}
          {renameMutation.isError ? (
            <ErrorNote error={renameMutation.error} title={t("assistant.errors.rename")} />
          ) : null}
          {configureMutation.isError ? (
            <ErrorNote
              error={configureMutation.error}
              title={t("assistant.errors.configure")}
            />
          ) : null}
          <AssistantModelControls
            conversation={currentConversation ?? null}
            disabled={!conversationId || conversationArchived}
            pending={configureMutation.isPending}
            onConfigure={(input) =>
              conversationId &&
              configureMutation.mutate({ conversationId, ...input })
            }
          />
          <label className="assistant-composer__field">
            <span className="sr-only">{t("assistant.composer.messageLabel")}</span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("assistant.composer.placeholder")}
              rows={3}
              maxLength={100_000}
              disabled={conversationArchived}
            />
            <button
              type="button"
              className="assistant-composer__send"
              aria-label={t("assistant.composer.send")}
              disabled={
                conversationArchived || !draft.trim() || sendMutation.isPending
              }
              onClick={() => submit()}
            >
              {sendMutation.isPending ? (
                <LoaderCircle
                  className="assistant-spin"
                  size={17}
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
              ) : (
                <ArrowUp size={17} strokeWidth={1.7} aria-hidden="true" />
              )}
            </button>
          </label>
          <p className="assistant-composer__note">
            {conversationArchived ? (
              <span>{t("assistant.conversation.archivedNote")}</span>
            ) : (
              <>
                <span>{t("assistant.composer.sendHint")}</span>
                <span>{t("assistant.composer.persistHint")}</span>
              </>
            )}
          </p>
        </footer>
        </aside>
      ) : null}
    </>
  );
}

function ConversationPicker({
  conversations,
  loading,
  value,
  onSelect,
}: {
  conversations: { id: string; title: string; status: string }[];
  loading: boolean;
  value: string | null;
  onSelect: (conversationId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const active = conversations.filter((c) => c.status !== "archived");
  const archived = conversations.filter((c) => c.status === "archived");
  const current = conversations.find((c) => c.id === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (id: string | null) => {
    setOpen(false);
    onSelect(id);
  };

  return (
    <span ref={rootRef} className="assistant-conv">
      <button
        type="button"
        className="assistant-conv__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={loading}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="assistant-conv__label">
          {current ? current.title : t("assistant.conversation.defaultTitle")}
        </span>
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open ? (
        <div className="assistant-conv__menu" role="listbox" aria-label={t("assistant.conversation.pickerLabel")}>
          {active.length === 0 && archived.length === 0 ? (
            <p className="assistant-conv__empty">{t("assistant.conversation.empty")}</p>
          ) : null}
          {active.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              role="option"
              aria-selected={conversation.id === value}
              className="assistant-conv__item"
              onClick={() => choose(conversation.id)}
            >
              {conversation.title}
            </button>
          ))}
          {archived.length > 0 ? (
            <div className="assistant-conv__archived">
              <button
                type="button"
                className="assistant-conv__archived-toggle"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
              >
                {t("assistant.conversation.archivedGroup", { count: archived.length })}
                <ChevronDown
                  size={13}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  style={{ transform: showArchived ? "rotate(180deg)" : undefined }}
                />
              </button>
              {showArchived
                ? archived.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      role="option"
                      aria-selected={conversation.id === value}
                      className="assistant-conv__item assistant-conv__item--archived"
                      onClick={() => choose(conversation.id)}
                    >
                      {conversation.title}
                    </button>
                  ))
                : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

const ASSISTANT_EFFORT_LEVELS = ["off", "low", "medium", "high"] as const;

type AssistantEffortLevel = (typeof ASSISTANT_EFFORT_LEVELS)[number];

const ASSISTANT_EFFORT_LABEL_KEYS: Record<AssistantEffortLevel, MessageKey> = {
  off: "assistant.effort.off",
  low: "assistant.effort.low",
  medium: "assistant.effort.medium",
  high: "assistant.effort.high",
};

/** composer 上方的模型胶囊：同协议换模型 + 对话级思考档。 */
function AssistantModelControls({
  conversation,
  disabled,
  pending,
  onConfigure,
}: {
  conversation: AssistantConversationDto | null;
  disabled: boolean;
  pending: boolean;
  onConfigure: (input: {
    modelId?: string | null;
    reasoningEffort?: string | null;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { t } = useI18n();
  /* 胶囊在关闭状态也要显示当前生效模型名，清单常驻拉取（staleTime 抑制重复）。 */
  const providersQuery = useQuery({
    queryKey: ["assistant-models", "providers"],
    queryFn: ({ signal }) => listProviders(signal),
    staleTime: 30_000,
  });
  const modelsQuery = useQuery({
    queryKey: ["assistant-models", "models"],
    queryFn: ({ signal }) => listModels(undefined, signal),
    staleTime: 30_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ["assistant-models", "assignments"],
    queryFn: ({ signal }) => listAssignments(signal),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const providers = useMemo(
    () => providersQuery.data ?? [],
    [providersQuery.data],
  );
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const modelById = useMemo(
    () => new Map(models.map((model) => [model.id, model])),
    [models],
  );
  const settings = conversation?.settings ?? {
    modelId: null,
    reasoningEffort: null,
  };
  const overrideModel = settings.modelId
    ? (modelById.get(settings.modelId) ?? null)
    : null;
  const writingAssignment = (assignmentsQuery.data ?? []).find(
    (assignment) => assignment.role === "writing",
  );
  const defaultModel = writingAssignment
    ? (modelById.get(writingAssignment.modelId) ?? null)
    : null;
  const effectiveModel = overrideModel ?? defaultModel;
  const effectiveProvider = effectiveModel
    ? (providerById.get(effectiveModel.providerId) ?? null)
    : null;
  /* 对话内只出现同协议模型：跨协议家族去设置页改默认生成模型。 */
  const candidates = useMemo(
    () =>
      effectiveProvider
        ? models.filter((model) => {
            const provider = providerById.get(model.providerId);
            return (
              model.enabled &&
              model.taskType === "writing" &&
              provider?.enabled &&
              provider.wireApi === effectiveProvider.wireApi
            );
          })
        : [],
    [models, providerById, effectiveProvider],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof candidates>();
    for (const model of candidates) {
      const key = providerById.get(model.providerId)?.name ?? model.providerId;
      groups.set(key, [...(groups.get(key) ?? []), model]);
    }
    return [...groups.entries()];
  }, [candidates, providerById]);
  const effort = settings.reasoningEffort ?? "low";

  return (
    <div ref={rootRef} className="assistant-model">
      <button
        type="button"
        className="assistant-model__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("assistant.model.label")}
        disabled={disabled || pending}
        onClick={() => setOpen((value) => !value)}
      >
        <Cpu size={13} strokeWidth={1.6} aria-hidden="true" />
        <span className="assistant-model__name">
          {effectiveModel
            ? effectiveModel.modelId
            : t("assistant.model.unconfiguredDefault")}
        </span>
        {overrideModel ? null : (
          <span className="assistant-model__default mono">{t("assistant.model.defaultBadge")}</span>
        )}
        <span className="assistant-model__effort mono">
          {t("assistant.model.effortTag", { effort: t(ASSISTANT_EFFORT_LABEL_KEYS[effort]) })}
        </span>
        <ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="assistant-model__menu"
          role="dialog"
          aria-label={t("assistant.model.label")}
        >
          <p className="assistant-model__section mono">{t("assistant.model.sectionModel")}</p>
          <div role="listbox" aria-label={t("assistant.model.listboxLabel")}>
            <button
              type="button"
              role="option"
              aria-selected={!settings.modelId}
              className="assistant-model__item"
              onClick={() => {
                setOpen(false);
                onConfigure({ modelId: null });
              }}
            >
              {t("assistant.model.followDefault")}
              {defaultModel ? ` · ${defaultModel.modelId}` : t("assistant.model.noDefault")}
            </button>
            {grouped.map(([providerName, groupModels]) => (
              <div
                key={providerName}
                className="assistant-model__group"
                role="group"
                aria-label={providerName}
              >
                <p className="assistant-model__provider mono">{providerName}</p>
                {groupModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={settings.modelId === model.id}
                    className="assistant-model__item"
                    onClick={() => {
                      setOpen(false);
                      onConfigure({ modelId: model.id });
                    }}
                  >
                    {model.modelId}
                  </button>
                ))}
              </div>
            ))}
            {open && (providersQuery.isPending || modelsQuery.isPending) ? (
              <p className="assistant-conv__empty">{t("assistant.model.loadingModels")}</p>
            ) : candidates.length === 0 ? (
              <p className="assistant-conv__empty">
                {t("assistant.model.noSameProtocol")}
              </p>
            ) : null}
          </div>
          <p className="assistant-model__section mono">{t("assistant.model.sectionEffort")}</p>
          <div className="assistant-model__efforts">
            {ASSISTANT_EFFORT_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={effort === level}
                className="assistant-model__effort-option"
                onClick={() =>
                  onConfigure({ reasoningEffort: level as string })
                }
              >
                {effort === level ? (
                  <Check size={12} strokeWidth={1.8} aria-hidden="true" />
                ) : null}
                {t(ASSISTANT_EFFORT_LABEL_KEYS[level])}
              </button>
            ))}
          </div>
          <p className="assistant-model__note">
            {t("assistant.model.note", { api: effectiveProvider?.wireApi ?? "—" })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ContextRibbon({
  context,
  usingPageContext,
  onToggleScope,
}: {
  context: AssistantContext;
  usingPageContext: boolean;
  onToggleScope: () => void;
}) {
  const { t } = useI18n();
  const details = contextDetails(context);
  return (
    <div className="assistant-context" aria-label={t("assistant.context.label")}>
      <span className="assistant-context__mark" aria-hidden="true" />
      <span>{surfaceLabel(context.surface)}</span>
      {details.map((detail) => (
        <span key={detail} className="assistant-context__detail">
          {detail}
        </span>
      ))}
      <button
        type="button"
        className="assistant-context__scope"
        title={usingPageContext ? t("assistant.context.projectOnlyTitle") : t("assistant.context.followPageTitle")}
        onClick={onToggleScope}
      >
        {usingPageContext ? t("assistant.context.projectOnly") : t("assistant.context.followPage")}
      </button>
    </div>
  );
}

function AssistantWelcome({ onPrompt }: { onPrompt: (text: string) => void }) {
  const { t } = useI18n();
  const prompts = [
    t("assistant.welcome.promptStatus"),
    t("assistant.welcome.promptConsistency"),
    t("assistant.welcome.promptTasks"),
  ];
  return (
    <section className="assistant-welcome">
      <div className="assistant-welcome__seal" aria-hidden="true">
        <Sparkles size={19} strokeWidth={1.35} />
      </div>
      <p className="assistant-welcome__eyebrow mono">CONTEXT IN HAND</p>
      <h3>{t("assistant.welcome.title")}</h3>
      <p>
        {t("assistant.welcome.body")}
      </p>
      <div className="assistant-welcome__prompts">
        {prompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>
            <span>{prompt}</span>
            <ArrowUp size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

function MessageEntry({ message }: { message: AssistantMessageDto }) {
  const { t } = useI18n();
  const isAssistant = message.role !== "user";
  return (
    <article
      className="assistant-message"
      data-role={message.role}
      aria-label={isAssistant ? t("assistant.message.assistantLabel") : t("assistant.message.authorLabel")}
    >
      <header>
        <span className="mono">
          {isAssistant ? "ASSISTANT" : "AUTHOR"}
        </span>
        <time dateTime={message.createdAt}>
          {formatRelativeDate(message.createdAt)}
        </time>
      </header>
      {isAssistant ? (
        <div
          className="assistant-message__body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
      ) : (
        <p>{message.content}</p>
      )}
    </article>
  );
}

/* 助手回复走受限 Markdown：marked 解析 + DOMPurify 消毒，防 XSS。 */
function renderMarkdown(content: string): string {
  const raw = marked.parse(content, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "b", "i", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "a", "hr", "del", "span",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel"],
  });
}

function ActivityEntry({
  projectId,
  activity,
  pending,
  onDecision,
  onCancelTask,
  onRetryChapter,
}: {
  projectId: string;
  activity: AssistantActivityDto;
  pending: boolean;
  onDecision: (
    action: "confirm" | "reject" | "retry" | "resume" | "cancel",
  ) => void;
  onCancelTask: (() => void) | null;
  onRetryChapter: (() => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const href = activityHref(projectId, activity);
  const proposal = activity.availableActions.includes("confirm");
  const retryable = activity.availableActions.includes("retry");
  const resumable = activity.availableActions.includes("resume");
  const cancellable = activity.availableActions.includes("cancel");
  const hasDetail =
    activity.phaseKey !== null ||
    activity.artifacts.length > 0 ||
    activity.lastError !== null ||
    activity.linkedSources.length > 0 ||
    (activity.result !== null && Object.keys(activity.result).length > 0);
  return (
    <article
      className="assistant-activity"
      data-status={activity.status}
      data-kind={activity.kind}
    >
      <div className="assistant-activity__rail" aria-hidden="true">
        <ActivityStatusIcon status={activity.status} />
      </div>
      <div className="assistant-activity__body">
        <header>
          <span className="mono">{activityKindLabel(activity.kind)}</span>
          {activity.skillLabel ? (
            <span className="assistant-activity__skill">{activity.skillLabel}</span>
          ) : null}
          <time dateTime={activity.updatedAt}>
            {formatRelativeDate(activity.updatedAt)}
          </time>
        </header>
        <h3>{activity.goal}</h3>
        <p className="assistant-activity__stage">{activity.stage}</p>
        {activity.summary ? (
          <p className="assistant-activity__summary">{activity.summary}</p>
        ) : null}
        {activity.waitingReason ? (
          <p className="assistant-activity__reason">
            <CircleAlert size={13} strokeWidth={1.5} aria-hidden="true" />
            {stopReasonLabel(activity.waitingReason)}
          </p>
        ) : null}
        {proposal ? (
          <div className="assistant-activity__decisions">
            <button
              type="button"
              className="assistant-activity__confirm"
              disabled={pending}
              onClick={() => onDecision("confirm")}
            >
              <Check size={13} strokeWidth={1.7} aria-hidden="true" />
              {pending ? t("assistant.decision.confirming") : t("assistant.decision.confirm")}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onDecision("reject")}
            >
              {t("assistant.decision.reject")}
            </button>
          </div>
        ) : retryable ? (
          <div className="assistant-activity__decisions">
            <button
              type="button"
              className="assistant-activity__confirm"
              disabled={pending}
              onClick={() => onDecision("retry")}
            >
              {pending ? t("assistant.decision.retrying") : t("assistant.decision.retry")}
            </button>
          </div>
        ) : resumable ? (
          <div className="assistant-activity__decisions">
            <button
              type="button"
              className="assistant-activity__confirm"
              disabled={pending}
              onClick={() => onDecision("resume")}
            >
              {pending ? t("assistant.decision.resuming") : t("assistant.decision.resume")}
            </button>
            {cancellable ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onDecision("cancel")}
              >
                {t("assistant.activity.cancelTask")}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="assistant-activity__actions">
          {href ? (
            <Link className="assistant-activity__link" to={href}>
              {activity.status === "waiting" ? t("assistant.activity.openWaiting") : t("assistant.activity.openRun")}
              <ExternalLink size={12} strokeWidth={1.5} aria-hidden="true" />
            </Link>
          ) : null}
          {cancellable && onCancelTask ? (
            <button
              type="button"
              disabled={pending}
              onClick={onCancelTask}
              title={t("assistant.activity.cancelTaskTitle")}
            >
              {t("assistant.activity.cancelTask")}
            </button>
          ) : null}
          {onRetryChapter ? (
            <button
              type="button"
              disabled={pending}
              onClick={onRetryChapter}
              title={t("assistant.activity.retryChapterTitle")}
            >
              {t("assistant.activity.retryChapter")}
            </button>
          ) : null}
          {hasDetail ? (
            <button
              type="button"
              className="assistant-activity__toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? t("assistant.activity.collapseTrace") : t("assistant.activity.expandTrace")}
            </button>
          ) : null}
        </div>
        {expanded ? (
          <ActivityTrace projectId={projectId} activity={activity} />
        ) : null}
      </div>
    </article>
  );
}

function ActivityTrace({
  projectId,
  activity,
}: {
  projectId: string;
  activity: AssistantActivityDto;
}) {
  const { t } = useI18n();
  return (
    <div className="assistant-trace">
      {activity.phaseKey ? (
        <p className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.phase")}</span>
          <span>{phaseLabel(activity.phaseKey)}</span>
        </p>
      ) : null}
      {activity.lastError ? (
        <p className="assistant-trace__row assistant-trace__row--error">
          <span className="assistant-trace__label">{t("assistant.trace.lastError")}</span>
          <span>
            {activity.lastError.message}
            <span className="mono"> · {activity.lastError.code}</span>
          </span>
        </p>
      ) : null}
      {activity.artifacts.length > 0 ? (
        <div className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.artifacts")}</span>
          <ul className="assistant-trace__artifacts">
            {activity.artifacts.map((artifact) => (
              <li key={`${artifact.kind}:${artifact.id}`}>
                <Link to={artifactHref(projectId, artifact)}>
                  {artifact.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {activity.linkedSources.length > 0 ? (
        <p className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.linked")}</span>
          <span className="mono">
            {activity.linkedSources
              .map((source) => `${source.type === "run" ? t("assistant.trace.sourceRun") : t("assistant.trace.sourceSession")} ${shortId(source.id)}`)
              .join(" · ")}
          </span>
        </p>
      ) : null}
      {activity.toolCall ? (
        <p className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.toolCall")}</span>
          <span>{toolCallLabel(activity.toolCall)}</span>
        </p>
      ) : null}
    </div>
  );
}

const PHASE_LABEL_KEYS: Record<string, MessageKey> = {
  queued: "assistant.phase.queued",
  preparing: "assistant.phase.preparing",
  planning: "assistant.phase.planning",
  paused: "assistant.phase.paused",
  awaiting_author: "assistant.phase.awaitingAuthor",
  completed: "assistant.phase.completed",
  cancelled: "assistant.phase.cancelled",
  failed: "assistant.phase.failed",
  chapter: "assistant.phase.chapter",
  "assistant.context": "assistant.phase.assistantContext",
  "assistant.respond": "assistant.phase.assistantRespond",
  "assistant.stage": "assistant.phase.assistantStage",
  "canon.context": "assistant.phase.canonContext",
  "canon.candidate": "assistant.phase.canonCandidate",
  "canon.stage": "assistant.phase.canonStage",
  "foundation.generate": "assistant.phase.foundationGenerate",
  "outline.generate": "assistant.phase.outlineGenerate",
  foundation: "assistant.phase.foundation",
  outline: "assistant.phase.outline",
  writing: "assistant.phase.writing",
  done: "assistant.phase.done",
  paused_baseline: "assistant.phase.pausedBaseline",
  "context.compile": "assistant.phase.contextCompile",
  "scene.plan": "assistant.phase.scenePlan",
  "draft.generate": "assistant.phase.draftGenerate",
  "deterministic.check": "assistant.phase.deterministicCheck",
  "semantic.review": "assistant.phase.semanticReview",
  "revision.generate": "assistant.phase.revisionGenerate",
  "chapter.settle": "assistant.phase.chapterSettle",
  "chapter.commit": "assistant.phase.chapterCommit",
};

function phaseLabel(phaseKey: string): string {
  const key = PHASE_LABEL_KEYS[phaseKey];
  return key ? translate(getLocale(), key) : phaseKey;
}

const TOOL_CALL_LABEL_KEYS: Record<string, MessageKey> = {
  "story.inspect": "assistant.toolCall.storyInspect",
  "review.inspect": "assistant.toolCall.reviewInspect",
  "foundation.start": "assistant.toolCall.foundationStart",
  "chapter.start": "assistant.toolCall.chapterStart",
  "autopilot.start": "assistant.toolCall.autopilotStart",
  "outline.plan.start": "assistant.toolCall.outlinePlanStart",
  "canon.candidate.start": "assistant.toolCall.canonCandidateStart",
  "selection.edit.start": "assistant.toolCall.selectionEditStart",
  "long_goal.start": "assistant.toolCall.longGoalStart",
  "task.control": "assistant.toolCall.taskControl",
};

function toolCallLabel(toolCall: NonNullable<AssistantActivityDto["toolCall"]>) {
  const key = TOOL_CALL_LABEL_KEYS[toolCall.name];
  return key ? translate(getLocale(), key) : toolCall.name;
}

function artifactHref(
  projectId: string,
  artifact: AssistantActivityDto["artifacts"][number],
): string {
  if (artifact.kind === "canon_change_set") {
    return `${projectWorkspacePath(projectId, "bible")}?focus=${encodeURIComponent(artifact.id)}`;
  }
  if (
    artifact.kind === "edit_proposal" ||
    artifact.kind === "document_version" ||
    artifact.kind === "revision_proposal"
  ) {
    return `${projectWorkspacePath(projectId, "studio")}?focus=${encodeURIComponent(artifact.id)}`;
  }
  if (artifact.kind === "foundation_candidate_set") {
    return projectWorkspacePath(projectId, "overview");
  }
  return projectWorkspacePath(projectId, "runs");
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function timelineEntries(
  detail: AssistantConversationDetailDto | undefined,
): TimelineEntry[] {
  if (!detail) return [];
  const completedReplies = new Set(
    detail.messages.flatMap((message) =>
      message.role === "assistant" && message.sourceRunId
        ? [message.sourceRunId]
        : [],
    ),
  );
  const entries: TimelineEntry[] = [
    ...detail.messages.map(
      (message): TimelineEntry => ({
        type: "message",
        at: message.createdAt,
        id: message.id,
        message,
      }),
    ),
    ...detail.activities
      .filter(
        (activity) =>
          activity.kind !== "assistant_response" ||
          activity.status !== "completed" ||
          !completedReplies.has(activity.sourceId),
      )
      .map(
        (activity): TimelineEntry => ({
          type: "activity",
          at: activity.createdAt,
          id: activity.id,
          activity,
        }),
      ),
  ];
  return entries
    .sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        Number(left.type === "activity") - Number(right.type === "activity") ||
        left.id.localeCompare(right.id),
    )
    .slice(-60);
}

function hasLiveActivity(detail: AssistantConversationDetailDto | undefined) {
  return Boolean(
    detail?.activities.some((activity) =>
      ["queued", "running"].includes(activity.status),
    ),
  );
}

function activityActionId(activity: AssistantActivityDto): string | null {
  return activity.kind === "tool" && activity.sourceType === "assistant_tool"
    ? activity.sourceId
    : null;
}

/* 产品决策动作出现在哪，任务现场就在哪：这类 run 卡回写作台处理候选，
   与 taskHref「现场由产品来源推导」同一套取向；没有决策动作的才退回运行中心。 */
const PRODUCT_DECISION_ACTIONS = new Set([
  "accept_plan",
  "accept_manuscript",
  "request_revision",
  "discard_manuscript",
]);

function activityHref(
  projectId: string,
  activity: AssistantActivityDto,
): string | null {
  if (activity.sourceType === "run") {
    if (
      activity.availableActions.some((action) =>
        PRODUCT_DECISION_ACTIONS.has(action),
      )
    ) {
      const params = new URLSearchParams({ run: activity.sourceId });
      const origin = activity.origin;
      if (origin?.documentId) params.set("document", origin.documentId);
      else if (origin?.outlineNodeId)
        params.set("outline", origin.outlineNodeId);
      return `${projectWorkspacePath(projectId, "studio")}?${params.toString()}`;
    }
    return `${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(activity.sourceId)}`;
  }
  if (activity.sourceType === "autopilot") {
    return `${projectWorkspacePath(projectId, "autopilot")}?session=${encodeURIComponent(activity.sourceId)}`;
  }
  return null;
}

function ActivityStatusIcon({
  status,
}: {
  status: AssistantActivityDto["status"];
}) {
  const props = { size: 15, strokeWidth: 1.6, "aria-hidden": true } as const;
  if (status === "completed") return <CircleCheck {...props} />;
  if (status === "failed" || status === "cancelled") {
    return <CircleAlert {...props} />;
  }
  if (status === "waiting" || status === "proposed") {
    return <Clock3 {...props} />;
  }
  if (status === "rejected") return <X {...props} />;
  return <LoaderCircle className="assistant-spin" {...props} />;
}

function activityKindLabel(kind: AssistantActivityDto["kind"]): string {
  if (kind === "tool") return translate(getLocale(), "assistant.activity.kind.tool");
  if (kind === "long_goal")
    return translate(getLocale(), "assistant.activity.kind.longGoal");
  if (kind === "assistant_response")
    return translate(getLocale(), "assistant.activity.kind.assistantResponse");
  return translate(getLocale(), "assistant.activity.kind.task");
}

function contextDetails(context: AssistantContext): string[] {
  const details: string[] = [];
  if (context.canonSpread) details.push(canonSpreadLabel(context.canonSpread));
  if (context.outlineNodeId)
    details.push(translate(getLocale(), "assistant.context.outlineNode"));
  if (context.documentId)
    details.push(translate(getLocale(), "assistant.context.document"));
  if (context.selection && context.selection.end > context.selection.start) {
    details.push(
      translate(getLocale(), "assistant.context.selection", {
        count: context.selection.end - context.selection.start,
      }),
    );
  }
  return details;
}

const SURFACE_LABEL_KEYS: Record<string, MessageKey> = {
  overview: "assistant.surface.overview",
  bible: "assistant.surface.bible",
  studio: "assistant.surface.studio",
  autopilot: "assistant.surface.autopilot",
  runs: "assistant.surface.runs",
  lab: "assistant.surface.lab",
  delivery: "assistant.surface.delivery",
};

function surfaceLabel(surface: string): string {
  return translate(
    getLocale(),
    SURFACE_LABEL_KEYS[surface] ?? "assistant.surface.global",
  );
}

const CANON_SPREAD_LABEL_KEYS: Record<
  NonNullable<AssistantContext["canonSpread"]>,
  MessageKey
> = {
  intent: "assistant.canonSpread.intent",
  outline: "assistant.canonSpread.outline",
  entities: "assistant.canonSpread.entities",
  facts: "assistant.canonSpread.facts",
  relations: "assistant.canonSpread.relations",
  timeline: "assistant.canonSpread.timeline",
  foreshadows: "assistant.canonSpread.foreshadows",
};

function canonSpreadLabel(spread: NonNullable<AssistantContext["canonSpread"]>) {
  return translate(getLocale(), CANON_SPREAD_LABEL_KEYS[spread]);
}

function rememberedConversation(projectId: string): string | null {
  try {
    return window.localStorage.getItem(`${CONVERSATION_KEY_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

function selectConversation(
  projectId: string,
  conversationId: string | null,
  setConversationId: (value: string | null) => void,
): void {
  setConversationId(conversationId);
  try {
    const key = `${CONVERSATION_KEY_PREFIX}${projectId}`;
    if (conversationId) window.localStorage.setItem(key, conversationId);
    else window.localStorage.removeItem(key);
  } catch {
    /* 私密模式下只保持当前会话状态 */
  }
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function invalidateAssistant(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  conversationId: string | null,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ["assistant", projectId, "conversations"],
    }),
    conversationId
      ? queryClient.invalidateQueries({
          queryKey: [
            "assistant",
            projectId,
            "conversation",
            conversationId,
          ],
        })
      : Promise.resolve(),
  ]);
}

async function invalidateAssistantDetail(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  conversationId: string | null,
): Promise<void> {
  if (!conversationId) return;
  await queryClient.invalidateQueries({
    queryKey: ["assistant", projectId, "conversation", conversationId],
  });
}

function assistantRunIds(
  detail: AssistantConversationDetailDto | undefined,
): ReadonlySet<string> {
  const runIds = new Set<string>();
  for (const message of detail?.messages ?? []) {
    if (message.sourceRunId) runIds.add(message.sourceRunId);
  }
  for (const activity of detail?.activities ?? []) {
    if (activity.sourceType === "run") runIds.add(activity.sourceId);
    const currentRunId = activity.result?.currentRunId;
    if (typeof currentRunId === "string") runIds.add(currentRunId);
  }
  return runIds;
}
