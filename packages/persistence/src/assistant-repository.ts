import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export type AssistantConversationStatus = "active" | "archived";
export type AssistantMessageRole = "user" | "assistant" | "system";
export type AssistantToolName =
  | "story.inspect"
  | "review.inspect"
  | "foundation.start"
  | "chapter.start"
  | "autopilot.start"
  | "outline.plan.start"
  | "canon.candidate.start"
  | "selection.edit.start"
  | "long_goal.start"
  | "task.control";
export type AssistantActivityStatus =
  "proposed" | "running" | "completed" | "failed" | "cancelled" | "rejected";

export interface StoredAssistantContext {
  surface: string;
  documentId: string | null;
  outlineNodeId: string | null;
  canonSpread: string | null;
  selection: {
    start: number;
    end: number;
    text: string | null;
  } | null;
}

export interface AssistantConversationSettings {
  modelId: string | null;
  reasoningEffort: "off" | "low" | "medium" | "high" | null;
}

export interface AssistantConversation {
  id: string;
  projectId: string;
  title: string;
  status: AssistantConversationStatus;
  settings: AssistantConversationSettings;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantMessage {
  id: string;
  conversationId: string;
  role: AssistantMessageRole;
  content: string;
  context: StoredAssistantContext | null;
  sourceRunId: string | null;
  replyToMessageId: string | null;
  createdAt: string;
}

export interface AssistantActivityArtifact {
  kind: string;
  id: string;
  label: string;
}

export interface AssistantActivity {
  id: string;
  conversationId: string;
  messageId: string | null;
  kind: "tool_proposal" | "tool_execution" | "long_goal";
  toolName: AssistantToolName;
  status: AssistantActivityStatus;
  goal: string;
  input: Readonly<Record<string, unknown>>;
  result: Readonly<Record<string, unknown>> | null;
  error: Readonly<Record<string, unknown>> | null;
  sourceType: "run" | "autopilot" | "long_goal" | null;
  sourceId: string | null;
  origin: StoredAssistantContext | null;
  executionMode: "auto" | "confirm" | null;
  skillId: string | null;
  phaseKey: string | null;
  artifacts: readonly AssistantActivityArtifact[] | null;
  createdAt: string;
  updatedAt: string;
}

export class SqliteAssistantRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertConversation(input: AssistantConversation): AssistantConversation {
    this.database.raw
      .prepare(
        `INSERT INTO assistant_conversations(
          id, project_id, title, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.id,
        input.projectId,
        input.title,
        input.status,
        input.createdAt,
        input.updatedAt,
      );
    return this.requireConversation(input.id);
  }

  getConversation(id: string): AssistantConversation | null {
    const row = this.database.raw
      .prepare("SELECT * FROM assistant_conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? mapConversation(row) : null;
  }

  requireConversation(id: string): AssistantConversation {
    const conversation = this.getConversation(id);
    if (!conversation) {
      throw new PersistenceNotFoundError("assistant_conversation", id);
    }
    return conversation;
  }

  listConversations(projectId: string): AssistantConversation[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM assistant_conversations
         WHERE project_id = ?
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(projectId) as unknown as ConversationRow[];
    return rows.map(mapConversation);
  }

  archiveConversation(id: string, now: string): AssistantConversation {
    const result = this.database.raw
      .prepare(
        `UPDATE assistant_conversations
         SET status = 'archived', updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(now, id);
    if (result.changes !== 1) this.requireConversation(id);
    return this.requireConversation(id);
  }

  renameConversation(
    id: string,
    title: string,
    now: string,
  ): AssistantConversation {
    this.database.raw
      .prepare(
        `UPDATE assistant_conversations
         SET title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title, now, id);
    return this.requireConversation(id);
  }

  /** 合并式更新对话设置；未提供的字段保持原值。 */
  configureConversation(
    id: string,
    patch: {
      modelId?: string | null;
      reasoningEffort?: "off" | "low" | "medium" | "high" | null;
    },
    now: string,
  ): AssistantConversation {
    const current = this.requireConversation(id).settings;
    const next = {
      modelId: patch.modelId !== undefined ? patch.modelId : current.modelId,
      reasoningEffort:
        patch.reasoningEffort !== undefined
          ? patch.reasoningEffort
          : current.reasoningEffort,
    };
    const hasOverride = next.modelId !== null || next.reasoningEffort !== null;
    this.database.raw
      .prepare(
        `UPDATE assistant_conversations
         SET settings_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(hasOverride ? JSON.stringify(next) : null, now, id);
    return this.requireConversation(id);
  }

  insertMessage(input: AssistantMessage): AssistantMessage {
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO assistant_messages(
            id, conversation_id, role, content, context_json,
            source_run_id, reply_to_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          input.id,
          input.conversationId,
          input.role,
          input.content,
          input.context ? JSON.stringify(input.context) : null,
          input.sourceRunId,
          input.replyToMessageId,
          input.createdAt,
        );
      this.database.raw
        .prepare(
          `UPDATE assistant_conversations
           SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
           WHERE id = ?`,
        )
        .run(input.createdAt, input.createdAt, input.conversationId);
    });
    return this.requireMessage(input.id);
  }

  getMessage(id: string): AssistantMessage | null {
    const row = this.database.raw
      .prepare("SELECT * FROM assistant_messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
    return row ? mapMessage(row) : null;
  }

  requireMessage(id: string): AssistantMessage {
    const message = this.getMessage(id);
    if (!message) throw new PersistenceNotFoundError("assistant_message", id);
    return message;
  }

  listMessages(conversationId: string): AssistantMessage[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM assistant_messages
         WHERE conversation_id = ?
         ORDER BY created_at, id`,
      )
      .all(conversationId) as unknown as MessageRow[];
    return rows.map(mapMessage);
  }

  insertActivity(input: AssistantActivity): AssistantActivity {
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO assistant_activities(
            id, conversation_id, message_id, kind, tool_name, status, goal,
            input_json, result_json, error_json, source_type, source_id,
            origin_json, execution_mode, skill_id, phase_key, artifacts_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          input.id,
          input.conversationId,
          input.messageId,
          input.kind,
          input.toolName,
          input.status,
          input.goal,
          JSON.stringify(input.input),
          input.result ? JSON.stringify(input.result) : null,
          input.error ? JSON.stringify(input.error) : null,
          input.sourceType,
          input.sourceId,
          input.origin ? JSON.stringify(input.origin) : null,
          input.executionMode,
          input.skillId,
          input.phaseKey,
          input.artifacts ? JSON.stringify(input.artifacts) : null,
          input.createdAt,
          input.updatedAt,
        );
      this.touchConversation(input.conversationId, input.updatedAt);
    });
    return this.requireActivity(input.id);
  }

  getActivity(id: string): AssistantActivity | null {
    const row = this.database.raw
      .prepare("SELECT * FROM assistant_activities WHERE id = ?")
      .get(id) as ActivityRow | undefined;
    return row ? mapActivity(row) : null;
  }

  requireActivity(id: string): AssistantActivity {
    const activity = this.getActivity(id);
    if (!activity) {
      throw new PersistenceNotFoundError("assistant_activity", id);
    }
    return activity;
  }

  listActivities(conversationId: string): AssistantActivity[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM assistant_activities
         WHERE conversation_id = ?
         ORDER BY created_at, id`,
      )
      .all(conversationId) as unknown as ActivityRow[];
    return rows.map(mapActivity);
  }

  transitionActivity(
    id: string,
    expectedStatus: AssistantActivityStatus,
    next: {
      status: AssistantActivityStatus;
      result?: Readonly<Record<string, unknown>> | null;
      error?: Readonly<Record<string, unknown>> | null;
      sourceType?: "run" | "autopilot" | "long_goal" | null;
      sourceId?: string | null;
      phaseKey?: string | null;
      artifacts?: readonly AssistantActivityArtifact[] | null;
      now: string;
    },
  ): AssistantActivity {
    const activity = this.requireActivity(id);
    const sourceType = next.sourceType ?? activity.sourceType;
    const sourceId = next.sourceId ?? activity.sourceId;
    const phaseKey =
      next.phaseKey === undefined ? activity.phaseKey : next.phaseKey;
    const artifacts =
      next.artifacts === undefined ? activity.artifacts : next.artifacts;
    const result = this.database.raw
      .prepare(
        `UPDATE assistant_activities
         SET status = ?, result_json = ?, error_json = ?,
             source_type = ?, source_id = ?, phase_key = ?, artifacts_json = ?,
             updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        next.status,
        next.result ? JSON.stringify(next.result) : null,
        next.error ? JSON.stringify(next.error) : null,
        sourceType,
        sourceId,
        phaseKey,
        artifacts ? JSON.stringify(artifacts) : null,
        next.now,
        id,
        expectedStatus,
      );
    if (result.changes !== 1) {
      const current = this.requireActivity(id);
      throw new AssistantPersistenceError(
        "assistant.activity.conflict",
        `Activity status changed from ${expectedStatus} to ${current.status}`,
      );
    }
    this.touchConversation(activity.conversationId, next.now);
    return this.requireActivity(id);
  }

  listProjectActivities(projectId: string): AssistantActivity[] {
    const rows = this.database.raw
      .prepare(
        `SELECT a.* FROM assistant_activities a
         JOIN assistant_conversations c ON c.id = a.conversation_id
         WHERE c.project_id = ?
         ORDER BY a.created_at, a.id`,
      )
      .all(projectId) as unknown as ActivityRow[];
    return rows.map(mapActivity);
  }

  private touchConversation(id: string, now: string): void {
    this.database.raw
      .prepare(
        `UPDATE assistant_conversations
         SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
         WHERE id = ?`,
      )
      .run(now, now, id);
  }
}

export class AssistantPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssistantPersistenceError";
  }
}

interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  status: AssistantConversationStatus;
  settings_json: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: AssistantMessageRole;
  content: string;
  context_json: string | null;
  source_run_id: string | null;
  reply_to_message_id: string | null;
  created_at: string;
}

interface ActivityRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  kind: "tool_proposal" | "tool_execution" | "long_goal";
  tool_name: AssistantToolName;
  status: AssistantActivityStatus;
  goal: string;
  input_json: string;
  result_json: string | null;
  error_json: string | null;
  source_type: "run" | "autopilot" | "long_goal" | null;
  source_id: string | null;
  origin_json: string | null;
  execution_mode: "auto" | "confirm" | null;
  skill_id: string | null;
  phase_key: string | null;
  artifacts_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapConversation(row: ConversationRow): AssistantConversation {
  const stored = parseJson<{
    modelId?: unknown;
    reasoningEffort?: unknown;
  }>(row.settings_json);
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    settings: {
      modelId:
        stored && typeof stored.modelId === "string" ? stored.modelId : null,
      reasoningEffort:
        stored &&
        (stored.reasoningEffort === "off" ||
          stored.reasoningEffort === "low" ||
          stored.reasoningEffort === "medium" ||
          stored.reasoningEffort === "high")
          ? stored.reasoningEffort
          : null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): AssistantMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    context: parseJson<StoredAssistantContext>(row.context_json),
    sourceRunId: row.source_run_id,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
  };
}

function mapActivity(row: ActivityRow): AssistantActivity {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: row.kind,
    toolName: row.tool_name,
    status: row.status,
    goal: row.goal,
    input: parseJson<Record<string, unknown>>(row.input_json) ?? {},
    result: parseJson<Record<string, unknown>>(row.result_json),
    error: parseJson<Record<string, unknown>>(row.error_json),
    sourceType: row.source_type,
    sourceId: row.source_id,
    origin: parseJson<StoredAssistantContext>(row.origin_json),
    executionMode: row.execution_mode,
    skillId: row.skill_id,
    phaseKey: row.phase_key,
    artifacts: parseJson<AssistantActivityArtifact[]>(row.artifacts_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value) as T;
}
