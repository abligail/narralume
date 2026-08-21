import type { AssistantConversationDto } from "@narralume/contracts";
import type { SqliteAssignmentRepository } from "@narralume/persistence";
import {
  type SqliteDocumentRepository,
  type SqliteModelRepository,
  type SqliteProjectRepository,
  type SqliteProviderRepository,
  type SqliteStoryRepository,
} from "@narralume/persistence";

import { ServiceError } from "./service-error.js";

export class AssistantServiceError extends ServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "AssistantServiceError";
  }
}

export interface AssistantContextShape {
  surface: string;
  documentId: string | null;
  outlineNodeId?: string | null;
  selection?: { start: number; end: number } | null;
}

/** 助手消息上下文的存在性与选区方向校验。 */
export function validateAssistantContext(
  projectId: string,
  context: AssistantContextShape,
  documents: SqliteDocumentRepository,
  story: SqliteStoryRepository,
): void {
  if (context.documentId && !documents.get(projectId, context.documentId)) {
    throw new AssistantServiceError(
      "assistant.context.document_not_found",
      "The document does not exist in this project",
      422,
    );
  }
  if (
    context.outlineNodeId &&
    !story.getOutlineNode(projectId, context.outlineNodeId)
  ) {
    throw new AssistantServiceError(
      "assistant.context.outline_not_found",
      "The outline node does not exist in this project",
      422,
    );
  }
  if (context.selection && context.selection.end < context.selection.start) {
    throw new AssistantServiceError(
      "assistant.context.selection_invalid",
      "The selection end must not be before the selection start",
      422,
    );
  }
}

export function requireProject(
  projects: SqliteProjectRepository,
  projectId: string,
) {
  const project = projects.get(projectId);
  if (!project) {
    throw new AssistantServiceError(
      "project.not_found",
      "Project not found",
      404,
    );
  }
  return project;
}

interface AssistantModelDeps {
  models: SqliteModelRepository;
  providers: SqliteProviderRepository;
}

/** 对话指定的模型必须存在且启用（模型或 provider 停用都算失效）。 */
export function requireAliveAssistantModel(
  modelId: string,
  deps: AssistantModelDeps,
): void {
  const model = deps.models.get(modelId);
  const provider = model ? deps.providers.get(model.providerId) : null;
  if (!model?.enabled || !provider?.enabled) {
    throw new AssistantServiceError(
      "assistant.model.not_available",
      "The conversation's model does not exist or has been disabled; re-select a model in the assistant sidebar",
      422,
    );
  }
}

/**
 * 对话内换模型只允许在当前生效模型（对话覆盖 ?? 全局 writing 分配）的
 * 同协议家族内进行：跨协议模型在设置页改默认分配后再用。
 */
export function requireSwitchableAssistantModel(
  conversation: Pick<AssistantConversationDto, "settings">,
  modelId: string,
  deps: AssistantModelDeps & {
    assignments: SqliteAssignmentRepository;
  },
): void {
  requireAliveAssistantModel(modelId, deps);
  const target = deps.models.get(modelId)!;
  const targetProvider = deps.providers.get(target.providerId)!;

  let anchorProvider = null;
  const override = conversation.settings.modelId
    ? deps.models.get(conversation.settings.modelId)
    : null;
  if (override) {
    anchorProvider = deps.providers.get(override.providerId) ?? null;
  }
  if (!anchorProvider?.enabled) {
    const writing = deps.assignments.resolve("writing");
    anchorProvider = writing ? writing.provider : null;
  }
  if (!anchorProvider) {
    throw new AssistantServiceError(
      "assistant.model.anchor_unavailable",
      "No default generation model is configured yet; configure one on the settings page first",
      422,
    );
  }
  if (targetProvider.wireApi !== anchorProvider.wireApi) {
    throw new AssistantServiceError(
      "assistant.model.protocol_mismatch",
      `You can only switch to another ${anchorProvider.wireApi} model within a conversation; for a different protocol, change the default generation model on the settings page`,
      422,
    );
  }
}
