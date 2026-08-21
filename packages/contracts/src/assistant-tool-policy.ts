import type { AssistantToolName } from "./assistant.js";

export type AssistantToolAccess = "read" | "auto" | "confirm";

export interface AssistantToolPolicy {
  readonly name: AssistantToolName;
  readonly access: AssistantToolAccess;
}

/**
 * Server-owned execution policy for assistant tools. The narrative package
 * (assistant stage worker) cannot import the app-level registry, so the
 * access grading is declared here and shared by both:
 * - read：只读查询，材料已在助手上下文中，stage 直接落盘完成，不产生活动卡片。
 * - auto：候选生成或任务控制，用户明确要求后直接执行，不再追加确认。
 * - confirm：推进作品正式状态或消耗大额写作预算，先进入待确认卡片。
 */
export const ASSISTANT_TOOL_POLICIES: readonly AssistantToolPolicy[] = [
  { name: "story.inspect", access: "read" },
  { name: "review.inspect", access: "read" },
  { name: "foundation.start", access: "confirm" },
  { name: "chapter.start", access: "confirm" },
  { name: "autopilot.start", access: "confirm" },
  { name: "outline.plan.start", access: "auto" },
  { name: "canon.candidate.start", access: "auto" },
  { name: "selection.edit.start", access: "auto" },
  { name: "long_goal.start", access: "confirm" },
  { name: "task.control", access: "auto" },
];

export function assistantToolAccess(
  name: AssistantToolName,
): AssistantToolAccess {
  const policy = ASSISTANT_TOOL_POLICIES.find((entry) => entry.name === name);
  if (!policy) throw new Error(`Unknown assistant tool: ${name}`);
  return policy.access;
}
