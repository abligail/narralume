import type { components as componentsZh } from "../zh/components";

export const components: typeof componentsZh = {
  confirmDialog: {
    pending: "Working…",
  },
  empty: {
    sealLabel: "Page seal “{char}”",
  },
  errorNote: {
    defaultTitle: "Something went wrong",
  },
  projectRequired: {
    backToShelf: "Back to the library",
  },
  seal: {
    label: "Seal “{char}”",
  },
  kernel: {
    lockBusy:
      "The local kernel is in use by another tab. Close other Narralume pages and try again.",
    deserializeFailed: "Failed to deserialize a kernel message",
    workerTerminated: "The kernel worker has terminated",
    bootTimeout:
      "Kernel startup timed out (the worker may have failed to load or is held by another tab)",
    workerBootFailed: "The kernel worker failed to start",
    pageClosed: "The page was closed and the kernel has stopped",
    requestFailed: "Kernel request failed",
    exportUnsupported: "The current driver does not support database export",
    trialChapterLimit:
      "The built-in trial model can write at most 3 chapters in a row. To write more, add your own model provider in Settings and set it as the default generation model.",
  },
};
