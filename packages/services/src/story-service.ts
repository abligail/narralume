import type { ProjectCoverMutation } from "@narralume/contracts";
import { createCanonFact, type CanonAuthority } from "@narralume/domain";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteProjectCoverRepository,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { randomUuid } from "./internal/crypto.js";
import { ServiceError } from "./service-error.js";
import { startManualSettlementRun } from "./manual-settlement.js";

export class StoryServiceError extends ServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "StoryServiceError";
  }
}

/**
 * 作品软删除的业务规则：必须已归档、乐观锁前提、确认标题；删除必须
 * 真正阻止后续写入——活动 Run 直接置 cancelled（终态路由是 no-op，
 * 残留租约不会再推进），活动自动驾驶会话一并取消。返回需 interrupt
 * 的 run id 列表。
 */
export function softDeleteProject(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    expectedUpdatedAt: string;
    confirmationTitle: string;
    now: string;
  },
): {
  recycled: ReturnType<SqliteProjectRepository["softDelete"]>;
  activeRunIds: string[];
} {
  const projects = new SqliteProjectRepository(database);
  const runs = new SqliteRunRepository(database);
  const automation = new SqliteAutomationRepository(database);
  const project = projects.get(input.projectId);
  if (!project)
    throw new StoryServiceError("project.not_found", "Project not found", 404);
  if (!project.archivedAt)
    throw new StoryServiceError(
      "project.delete.archive_required",
      "Archive the project before moving it to the recycle bin",
      409,
    );
  if (project.updatedAt !== input.expectedUpdatedAt)
    throw new StoryServiceError(
      "project.version.conflict",
      "The project was updated; refresh and try again",
      409,
    );
  if (project.title !== input.confirmationTitle)
    throw new StoryServiceError(
      "project.delete.confirmation_mismatch",
      "The confirmation title does not match the project title",
      422,
    );
  const activeRuns = runs.listActiveRuns(input.projectId);
  const activeSessions = automation
    .listSessions(input.projectId)
    .filter((session) => !["completed", "cancelled"].includes(session.status));
  const recycled = database.transaction(() => {
    for (const run of activeRuns)
      runs.setRunStatus(run.id, "cancelled", input.now, "project_deleted");
    for (const session of activeSessions)
      automation.setSessionStatus(session.id, "cancelled", input.now);
    return projects.softDelete(
      input.projectId,
      input.expectedUpdatedAt,
      input.now,
    );
  });
  return { recycled, activeRunIds: activeRuns.map((run) => run.id) };
}

/** 事实仍为当前生效正典（未被修订/撤回替代）——修订与提升权威的共同前提。 */
function requireEffectiveFact(
  canon: SqliteCanonRepository,
  projectId: string,
  factId: string,
  code: string,
  message: string,
) {
  const isEffective = canon
    .listEffectiveFacts(projectId, { includeCandidates: true })
    .some((fact) => fact.id === factId);
  if (!isEffective) throw new StoryServiceError(code, message, 409);
}

/**
 * 事实修订：真实并发前提是事实仍为当前生效正典，否则两个修订会在同
 * 一 supersedesFactId 下分叉；locked 事实需要显式确认。返回新事实与
 * 冲突列表。
 */
export function reviseCanonFact(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    factId: string;
    subjectId: string;
    predicate: string;
    objectEntityId: string | null;
    value: unknown;
    validFromNodeId: string | null;
    validToNodeId: string | null;
    knowledgeScope: "omniscient" | "reader" | "character" | "author_secret";
    knowledgeSubjectId: string | null;
    authority: CanonAuthority;
    confidence: number;
    confirmLockedRevision: boolean;
  },
) {
  const canon = new SqliteCanonRepository(database);
  canon.requireFact(input.projectId, input.factId);
  requireEffectiveFact(
    canon,
    input.projectId,
    input.factId,
    "canon.fact.superseded",
    "The fact was superseded by a newer revision or withdrawal; refresh before editing",
  );
  const current = canon.requireFact(input.projectId, input.factId);
  if (current.authority === "locked" && !input.confirmLockedRevision) {
    throw new StoryServiceError(
      "canon.fact.locked",
      "Revising a locked fact requires explicit confirmation",
      409,
    );
  }
  const revised = createCanonFact({
    id: randomUuid(),
    projectId: input.projectId,
    now: new Date().toISOString(),
    subjectId: input.subjectId,
    predicate: input.predicate,
    objectEntityId: input.objectEntityId,
    ...(input.objectEntityId ? {} : { value: input.value }),
    validFromNodeId: input.validFromNodeId,
    validToNodeId: input.validToNodeId,
    knowledgeScope: input.knowledgeScope,
    knowledgeSubjectId: input.knowledgeSubjectId,
    authority: input.authority,
    confidence: input.confidence,
    sourceType: "manual-revision",
    sourceId: input.factId,
    supersedesFactId: input.factId,
  });
  const conflicts = canon.findConflicts(revised);
  canon.insertFact(revised);
  return { revised, conflicts };
}

/** 事实撤回：只有当前生效的事实可以撤回；locked 需要显式确认。 */
export function withdrawCanonFact(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    factId: string;
    reason: string;
    confirmLockedWithdrawal: boolean;
  },
) {
  const canon = new SqliteCanonRepository(database);
  const current = canon.requireFact(input.projectId, input.factId);
  requireEffectiveFact(
    canon,
    input.projectId,
    input.factId,
    "canon.fact.not_effective",
    "Only the currently effective fact can be withdrawn",
  );
  if (current.authority === "locked" && !input.confirmLockedWithdrawal) {
    throw new StoryServiceError(
      "canon.fact.locked",
      "Withdrawing a locked fact requires explicit confirmation",
      409,
    );
  }
  return canon.withdrawFact({
    factId: input.factId,
    projectId: input.projectId,
    reason: input.reason,
    withdrawnAt: new Date().toISOString(),
  });
}

/** 事实提升权威：已被替代的事实不允许提升。 */
export function promoteCanonFact(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    factId: string;
    authority: Exclude<CanonAuthority, "candidate">;
  },
) {
  const canon = new SqliteCanonRepository(database);
  canon.requireFact(input.projectId, input.factId);
  requireEffectiveFact(
    canon,
    input.projectId,
    input.factId,
    "canon.fact.superseded",
    "The fact was revised or withdrawn; refresh before promoting its authority",
  );
  return canon.promoteFact(
    input.projectId,
    input.factId,
    randomUuid(),
    input.authority,
    new Date().toISOString(),
  );
}

/**
 * 正文正式提交的副作用链：追加版本 → 删草稿 → 检索段更新 → 大纲置
 * committed →（可选）自动开手动结算。restore 走同一条链。
 */
export function commitDocumentVersion(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    documentId: string;
    content: string;
    source: string;
    expectedCurrentVersionId?: string | null | undefined;
    triggerSettlement: boolean;
    environment: Readonly<Record<string, string | undefined>>;
    coordinatorWake: () => void;
  },
) {
  const documents = new SqliteDocumentRepository(database);
  const retrieval = new SqliteRetrievalRepository(database);
  const story = new SqliteStoryRepository(database);
  const document = documents.get(input.projectId, input.documentId);
  if (!document)
    throw new StoryServiceError(
      "document.not_found",
      "Manuscript document not found",
      404,
    );
  const now = new Date().toISOString();
  const version = documents.appendVersion(input.projectId, input.documentId, {
    id: randomUuid(),
    content: input.content,
    source: input.source,
    now,
    ...(input.expectedCurrentVersionId === undefined
      ? {}
      : { expectedCurrentVersionId: input.expectedCurrentVersionId }),
  });
  documents.deleteDraft(input.projectId, input.documentId, input.content);
  if (document.outlineNodeId) {
    retrieval.upsertSegment({
      id: `document:${document.id}:current`,
      projectId: input.projectId,
      sourceType: "document_current",
      sourceId: document.id,
      title: document.title,
      content: version.content,
      authority: "confirmed",
      metadata: {
        documentId: document.id,
        documentVersionId: version.id,
        outlineNodeId: document.outlineNodeId,
        source: input.source,
      },
      entityIds: [],
      createdAt: now,
      updatedAt: now,
    });
    story.updateOutlineStatus(
      input.projectId,
      document.outlineNodeId,
      "committed",
      now,
    );
  }
  /* 正式提交（source=manual）自动开手动结算；批注存档点、选区基线等
     隐式版本不触发。 */
  if (input.triggerSettlement) {
    startManualSettlementRun({
      database,
      environment: input.environment,
      coordinatorWake: input.coordinatorWake,
      projectId: input.projectId,
      document,
      versionId: version.id,
    });
  }
  return version;
}

export const MAX_COVER_BYTES = 8 * 1024 * 1024;

/**
 * 在作品更新事务内应用封面变更；校验失败会回滚资料修改。base64 解码
 * 用纯实现（浏览器/Node 通用），magic bytes 校验媒体类型一致性。
 */
export function applyCoverMutation(
  database: NarrativeDatabase,
  projectId: string,
  mutation: ProjectCoverMutation,
  now: string,
): void {
  const covers = new SqliteProjectCoverRepository(database);
  if (mutation.action === "remove") {
    covers.delete(projectId);
    return;
  }
  if (mutation.action === "crop") {
    if (!covers.get(projectId))
      throw new StoryServiceError(
        "project.cover.not_found",
        "This book does not have a custom cover yet",
        404,
      );
    const current = covers.get(projectId)!;
    covers.upsert({
      projectId,
      mediaType: current.mediaType,
      data: current.data,
      width: current.width,
      height: current.height,
      crop: mutation.crop,
      now,
    });
    return;
  }
  const data = decodeCover(mutation.imageBase64);
  if (data.byteLength > MAX_COVER_BYTES)
    throw new StoryServiceError(
      "project.cover.too_large",
      "The cover must not exceed 8 MB after processing",
      413,
    );
  if (!matchesCoverMediaType(data, mutation.mediaType))
    throw new StoryServiceError(
      "project.cover.media_mismatch",
      "The cover content does not match the declared image type",
      422,
    );
  covers.upsert({
    projectId,
    mediaType: mutation.mediaType,
    data,
    width: mutation.width,
    height: mutation.height,
    crop: mutation.crop,
    now,
  });
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 纯 base64 解码（Uint8Array 输出），避免 Node Buffer 依赖。 */
function decodeBase64(source: string): Uint8Array {
  const clean = source.replace(/=+$/u, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) throw new Error("invalid base64 character");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

function decodeCover(source: string): Uint8Array {
  if (source.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(source))
    throw new StoryServiceError(
      "project.cover.invalid_base64",
      "The cover image encoding is invalid",
      400,
    );
  let data: Uint8Array;
  try {
    data = decodeBase64(source);
  } catch {
    throw new StoryServiceError(
      "project.cover.invalid_base64",
      "The cover image encoding is invalid",
      400,
    );
  }
  if (data.byteLength === 0)
    throw new StoryServiceError(
      "project.cover.empty",
      "The cover image must not be empty",
      400,
    );
  return data;
}

type CoverMediaType = Extract<
  ProjectCoverMutation,
  { action: "put" }
>["mediaType"];

function matchesCoverMediaType(
  data: Uint8Array,
  mediaType: CoverMediaType,
): boolean {
  if (mediaType === "image/png")
    return (
      data.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => data[index] === value,
      )
    );
  if (mediaType === "image/jpeg")
    return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return (
    data.length >= 12 &&
    String.fromCharCode(...data.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.slice(8, 12)) === "WEBP"
  );
}
