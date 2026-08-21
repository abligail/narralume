import { describe, expect, it } from "vitest";

import {
  activityGoalLabel,
  activityStageLabel,
  activitySummaryLabel,
  artifactKindLabel,
  assistantSkillLabel,
  stopReasonLabel,
} from "../src/lib/labels";
import { setLocale } from "../src/i18n";

describe("assistant activity label formatters", () => {
  it("renders machine-key goals through the dictionary with params", () => {
    setLocale("zh-CN");
    expect(
      activityGoalLabel({ key: "activity.goal.sessionChapters", params: { count: 5 } }),
    ).toBe("AI 快速创作 5 章");
    expect(
      activityGoalLabel({
        key: "activity.goal.chapterTitle",
        params: { title: "雨夜" },
      }),
    ).toBe("完成《雨夜》");
  });

  it("passes raw-string goals through verbatim (user-authored titles)", () => {
    setLocale("zh-CN");
    expect(activityGoalLabel("我的复合任务")).toBe("我的复合任务");
  });

  it("falls back to the raw key for unknown machine keys", () => {
    setLocale("zh-CN");
    expect(activityGoalLabel({ key: "activity.goal.unknown", params: {} })).toBe(
      "activity.goal.unknown",
    );
  });

  it("renders stage steps and interpolates progress", () => {
    setLocale("zh-CN");
    expect(
      activityStageLabel({
        key: "activity.stage.sessionWritingTitle",
        params: { title: "雾都", progress: "2/5" },
      }),
    ).toBe("正在创作《雾都》 · 2/5 章");
    expect(activityStageLabel({ key: "activity.step.draftGenerate", params: {} })).toBe(
      "正在写作正文",
    );
  });

  it("renders summaries and null safety", () => {
    setLocale("zh-CN");
    expect(
      activitySummaryLabel({ key: "activity.summary.longGoalCompleted", params: {} }),
    ).toBe("长期任务已完成");
    expect(activitySummaryLabel(null)).toBeNull();
  });

  it("maps artifact kinds and keeps unknown labels verbatim", () => {
    setLocale("zh-CN");
    expect(artifactKindLabel("document_version", "document_version")).toBe("正文版本");
    expect(artifactKindLabel("custom_kind", "自定义保留")).toBe("自定义保留");
  });

  it("renders skill labels by id", () => {
    setLocale("zh-CN");
    expect(assistantSkillLabel("compose.serial")).toBe("复合创作任务");
    expect(assistantSkillLabel("unknown.skill")).toBe("unknown.skill");
  });

  it("localizes the long-goal baseline pause reason code", () => {
    setLocale("zh-CN");
    expect(stopReasonLabel("long_goal.paused_baseline")).toBe(
      "基线已变化，等待你继续或取消",
    );
  });

  it("switches to English with the locale", () => {
    setLocale("en");
    expect(
      activityGoalLabel({ key: "activity.goal.sessionChapters", params: { count: 3 } }),
    ).toBe("AI quick-write 3 chapters");
    expect(activityStageLabel({ key: "activity.step.draftGenerate", params: {} })).toBe(
      "Writing the prose",
    );
    setLocale("zh-CN");
  });
});
