import type { AssistantActivity } from "@narralume/persistence";
import type { AssistantActivityTextDto } from "@narralume/contracts";

/** 展示文案描述符构造器：key 由前端标签表渲染，服务端不产出自然语言。 */
export function activityText(
  key: string,
  params: Record<string, string | number> = {},
): AssistantActivityTextDto {
  return { key, params };
}

export function activityProgress(completed: number, target: number): string {
  return `${completed}/${target}`;
}

/** 工具活动 goal 的插值参数，从落库的 tool input 提取。 */
export function toolGoalParams(
  activity: AssistantActivity,
): Record<string, string | number> {
  const input = activity.input;
  const params: Record<string, string | number> = {};
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.targetChapters === "number")
      params.count = record.targetChapters;
    if (typeof record.spread === "string") params.spread = record.spread;
    if (typeof record.action === "string") params.action = record.action;
  }
  return params;
}

/** 工具活动卡片的阶段行（按 status / executionMode 取机码）。 */
export function toolStage(
  activity: AssistantActivity,
): AssistantActivityTextDto {
  if (activity.status === "proposed")
    return activityText("activity.stage.toolProposed");
  if (activity.status === "running") {
    if (activity.executionMode === "auto")
      return activityText("activity.stage.toolRunningDelegated");
    return activityText("activity.stage.toolRunning");
  }
  if (activity.status === "completed") {
    return activity.executionMode === "auto"
      ? activityText("activity.stage.toolCompletedDelegated")
      : activityText("activity.stage.toolCompleted");
  }
  if (activity.status === "rejected")
    return activityText("activity.stage.toolRejected");
  if (activity.status === "cancelled")
    return activityText("activity.stage.toolCancelled");
  return activityText("activity.stage.toolFailed");
}

/** 工具活动完成/拒绝后的摘要行。 */
export function toolResultSummary(
  activity: AssistantActivity,
): AssistantActivityTextDto | null {
  if (activity.status === "completed") {
    return activity.executionMode === "auto"
      ? activityText("activity.summary.toolDelegated")
      : activityText("activity.summary.toolCreated");
  }
  if (activity.status === "rejected")
    return activityText("activity.summary.toolRejected");
  return null;
}
