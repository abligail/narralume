export const overview = {
  requiredState: {
    seal: "览",
    title: "项目概览",
    description: "选定作品后，在这里查看创作进度、进行中的任务和下一步安排。",
  },
  loadError: "概览暂时无法加载",
  masthead: {
    emptyPremise: "卷首尚待题。",
    progress: "{committed} 已定稿 · 共 {total} 章节 · {words} 字",
    lastWriting: "最后动笔 {time}",
    neverWriting: "尚未动笔",
  },
  currentChapter: {
    head: "当前章节",
    continue: "续写本章",
    continueAria: "在写作台续写此章",
    viewStory: "查看故事",
  },
  completed: {
    noChapters: "还没有章节；下一步：先搭故事大纲。",
    reviewFoundation: "没有正在撰写的章节；下一步：确认作品方向。",
    resolveStoryChanges:
      "章节正文已定稿；下一步：确认正文带来的故事变化。",
    reviewWriting: "章节正文已定稿；下一步：处理审稿与修订。",
    buildOutline: "还没有可写章节；下一步：先搭故事大纲。",
    complete: "所有章节已定稿；下一步：检查并交付。",
    fallback: "没有正在撰写的章节；下一步：{action}。",
  },
  entries: {
    ariaLabel: "下一步入口",
    organizeStory: {
      label: "整理故事",
      blurb: "补齐人物、大纲和故事事实",
    },
    autopilot: {
      label: "AI 快速创作",
      blurb: "按默认链路连续完成多章，作者可随时介入",
    },
  },
  nextAction: {
    continueTask: {
      label: "继续当前任务",
      blurb: "回到发起位置，处理候选稿或继续创作",
    },
    backToStudio: {
      label: "回到写作台",
      blurb: "继续当前正文",
    },
    reviewFoundation: {
      label: "确认作品方向",
      blurb: "从建书候选中确定故事指南针",
    },
    resolveStoryChanges: {
      label: "确认故事变化",
      blurb: "裁定正文带来的人物、时间线与伏笔变化",
    },
    reviewWriting: {
      label: "处理审稿与修订",
      blurb: "在正文旁完成问题和修改建议的裁定",
    },
    writeChapter: {
      label: "续写本章",
      blurb: "手动写作，或把本章交给 AI 生成待采纳正文",
    },
    buildOutline: {
      label: "先搭故事大纲",
      blurb: "确定人物、章节与故事推进方向",
    },
    complete: {
      label: "检查并交付",
      blurb: "检查质量后导出或备份作品",
    },
  },
  activeTask: {
    aria: "活动任务",
    head: "活动任务 · {kind}",
    fallbackTitle: "后台任务",
    backAria: "回到任务现场",
    backLabel: "回到任务现场",
    decideLabel: "处理候选与裁定",
    error: "任务操作没有完成",
  },
  cancelDialog: {
    title: "取消当前任务",
    confirm: "确认取消",
    body: "任务会在安全边界停止；已经保存的正文和版本不会被删除。",
  },
  pending: {
    aria: "待办",
    foundation: "建书候选",
    issues: "审稿问题",
    proposals: "修订提案",
    canon: "故事变化",
    resume: "最近的 AI 任务 · {label}",
  },
};
