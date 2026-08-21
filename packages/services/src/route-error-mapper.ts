import { ZodError } from "zod";

import {
  POLICY_UNKNOWN_FIELD,
  extractPolicyUnknownFields,
} from "@narralume/contracts";
import { ContextCompileError } from "@narralume/context";
import { DomainError } from "@narralume/domain";
import {
  AssignmentPersistenceError,
  AssistantPersistenceError,
  AutomationPersistenceError,
  ConfigurationVersionConflictError,
  CreativePersistenceError,
  DeliveryPersistenceError,
  DeliveryVersionConflictError,
  DocumentVersionConflictError,
  ImportedAgentSkillVersionConflictError,
  LongNovelPersistenceError,
  NarrativeStateError,
  PersistenceNotFoundError,
  RunPersistenceError,
  TemplatePersistenceError,
} from "@narralume/persistence";
import { RecipeTemplateError } from "@narralume/harness";
import {
  AgentSkillImportError,
  AssistantRouteError,
  AssistantToolExecutionError,
  AutomationRouteError,
  CanonCandidateRouteError,
  DeliveryRouteError,
  DeliveryServiceError,
  LongGoalError,
  ProviderRouteError,
  ReviewRouteError,
  RunRouteError,
  ServiceError,
  StoryRouteError,
  StudioRouteError,
  deliveryErrorStatus,
} from "./index.js";

/** ApiError 形状的错误响应（HTTP 宿主与内核宿主共用）。 */
export interface ApiErrorPayload {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  fields?: readonly string[];
}

/**
 * 与原 app.ts setErrorHandler 同一优先级的错误映射。Fastify 宿主把结果
 * 写进 reply；内核宿主把它作为 RPC 错误响应。requestId 由调用方注入。
 */
export function mapRouteError(
  error: unknown,
  log: (payload: unknown, message: string) => void = () => {},
): ApiErrorPayload {
  if (error instanceof Error && error.message.includes("project.not_found")) {
    return {
      status: 404,
      code: "project.not_found",
      message: "The project does not exist or has been deleted",
    };
  }
  if (error instanceof ZodError) {
    // Unknown keys under a policy object (policy, chapterPolicy, …) are
    // almost always typos of supported fields, so they get a dedicated
    // 422 instead of the generic 400.
    const policyIssues = error.issues.filter(
      (issue) => issue.code === "unrecognized_keys" && isPolicyPath(issue.path),
    );
    if (policyIssues.length > 0) {
      const fields = extractPolicyUnknownFields(new ZodError(policyIssues));
      return {
        status: 422,
        code: POLICY_UNKNOWN_FIELD,
        message: `Policy contains unknown fields: ${fields.join(", ")}`,
        fields,
      };
    }
    const unknownIssues = error.issues.filter(
      (issue) => issue.code === "unrecognized_keys",
    );
    if (unknownIssues.length > 0) {
      const fields = [
        ...new Set(
          unknownIssues.flatMap((issue) =>
            issue.code === "unrecognized_keys" ? issue.keys : [],
          ),
        ),
      ].sort();
      return {
        status: 422,
        code: "request.unknown_field",
        message: `Request contains unknown fields: ${fields.join(", ")}`,
        fields,
      };
    }
    return {
      status: 400,
      code: "request.invalid",
      message: requestValidationMessage(error),
      details: error.issues,
    };
  }
  if (error instanceof AssignmentPersistenceError) {
    return { status: 422, code: error.code, message: error.message };
  }
  if (
    error instanceof ProviderRouteError ||
    error instanceof AssistantRouteError ||
    error instanceof AssistantToolExecutionError ||
    error instanceof LongGoalError ||
    error instanceof CanonCandidateRouteError ||
    error instanceof AssistantPersistenceError ||
    error instanceof StoryRouteError ||
    error instanceof ServiceError || // 覆盖 RouteError 与 *ServiceError 两层
    error instanceof ReviewRouteError ||
    error instanceof RunRouteError ||
    error instanceof StudioRouteError ||
    error instanceof AutomationRouteError ||
    error instanceof DeliveryRouteError
  ) {
    const shaped = error as {
      statusCode: number;
      code: string;
      message: string;
      details?: unknown;
    };
    return {
      status: shaped.statusCode,
      code: shaped.code,
      message: shaped.message,
      ...(shaped.details === undefined ? {} : { details: shaped.details }),
    };
  }
  // narrative 层的 CanonCandidateError 与 services 无依赖环，按同构形状识别。
  if (isStatusCodeError(error)) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof ConfigurationVersionConflictError) {
    return {
      status: 409,
      code: `${error.entity}.version.conflict`,
      message: error.message,
    };
  }
  if (error instanceof ImportedAgentSkillVersionConflictError) {
    return {
      status: 409,
      code: "imported_agent_skill.version.conflict",
      message: error.message,
    };
  }
  if (error instanceof NarrativeStateError) {
    return { status: 422, code: error.code, message: error.message };
  }
  if (
    error instanceof AutomationPersistenceError ||
    error instanceof CreativePersistenceError ||
    error instanceof LongNovelPersistenceError ||
    error instanceof DeliveryVersionConflictError ||
    error instanceof DeliveryPersistenceError ||
    error instanceof RunPersistenceError ||
    error instanceof TemplatePersistenceError
  ) {
    const shaped = error as { code: string; message: string };
    return { status: 409, code: shaped.code, message: shaped.message };
  }
  if (error instanceof AgentSkillImportError) {
    const status = error.code === "agent_skill.not_found" ? 404 : 422;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof DeliveryServiceError) {
    return {
      status: deliveryErrorStatus(error),
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof PersistenceNotFoundError) {
    return {
      status: 404,
      code: `${error.entity}.not_found`,
      message: error.message,
    };
  }
  if (error instanceof DocumentVersionConflictError) {
    return {
      status: 409,
      code: "document.version.conflict",
      message: error.message,
      details: { expected: error.expected, actual: error.actual },
    };
  }
  if (error instanceof DomainError || error instanceof ContextCompileError) {
    return { status: 422, code: error.code, message: error.message };
  }
  if (error instanceof RecipeTemplateError) {
    return { status: 422, code: error.code, message: error.message };
  }
  log(error, "request failed");
  return { status: 500, code: "internal", message: "Internal server error" };
}

/** True when a zod issue path points inside a policy object. */
function isPolicyPath(path: readonly PropertyKey[]): boolean {
  const head = path[0];
  return (
    typeof head === "string" && (head === "policy" || head.endsWith("Policy"))
  );
}

interface StatusCodeError {
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
}

function isStatusCodeError(error: unknown): error is StatusCodeError {
  if (!(error instanceof Error)) return false;
  const shaped = error as unknown as StatusCodeError;
  return (
    typeof shaped.code === "string" && typeof shaped.statusCode === "number"
  );
}

const REQUEST_FIELD_LABELS: Readonly<Record<string, string>> = {
  braindump: "Premise and braindump",
  title: "Title",
  premise: "Premise",
  requestId: "Request ID",
  targetChapters: "Target chapter count",
  wordsPerChapter: "Words per chapter",
  volumes: "Volume count",
};

function requestValidationMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The submitted content is malformed";
  const tail = issue.path.at(-1);
  const field =
    typeof tail === "string" ? (REQUEST_FIELD_LABELS[tail] ?? tail) : "content";
  const detail = issue as unknown as Record<string, unknown>;

  if (issue.code === "too_small" && typeof detail.minimum === "number") {
    if (detail.origin === "string") {
      return detail.minimum === 1
        ? `${field} must not be empty`
        : `${field} must be at least ${detail.minimum} characters`;
    }
    if (detail.origin === "array") {
      return `${field} must contain at least ${detail.minimum} item(s)`;
    }
    return `${field} must be at least ${detail.minimum}`;
  }
  if (issue.code === "too_big" && typeof detail.maximum === "number") {
    if (detail.origin === "string") {
      return `${field} must not exceed ${detail.maximum} characters`;
    }
    if (detail.origin === "array") {
      return `${field} must not contain more than ${detail.maximum} item(s)`;
    }
    return `${field} must not be greater than ${detail.maximum}`;
  }
  if (issue.code === "invalid_type") {
    return `${field} has an invalid type`;
  }
  if (issue.message && !issue.message.startsWith("Invalid input")) {
    return issue.path.length > 0 ? `${field}: ${issue.message}` : issue.message;
  }
  return `${field} is malformed`;
}
