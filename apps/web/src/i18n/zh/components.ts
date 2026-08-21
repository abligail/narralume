/* 通用组件（确认框 / 空态 / 错误注记 / 朱印）与浏览器内核错误消息。
   zh 逐字保留原 UI 文案。 */
export const components = {
  confirmDialog: {
    pending: "处理中…",
  },
  empty: {
    sealLabel: "页面印记「{char}」",
  },
  errorNote: {
    defaultTitle: "出了点问题",
  },
  projectRequired: {
    backToShelf: "返回藏书室",
  },
  seal: {
    label: "朱印「{char}」",
  },
  kernel: {
    lockBusy: "本地内核已被另一个标签页占用，请关闭其他叙灯页面后重试",
    deserializeFailed: "内核消息反序列化失败",
    workerTerminated: "内核 Worker 已终止",
    bootTimeout: "内核启动超时（Worker 可能加载失败或被其他标签页占用）",
    workerBootFailed: "内核 Worker 启动失败",
    pageClosed: "页面已关闭，内核已停止",
    requestFailed: "内核请求失败",
    exportUnsupported: "当前驱动不支持库导出",
    trialChapterLimit:
      "内置体验模型每次最多连续创作 3 章；如需更多，请在设置中添加自己的模型渠道并设为默认生成模型。",
  },
};
