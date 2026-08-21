import type { lab as labZh } from "../zh/lab";

export const lab: typeof labZh = {
  title: "Narrative Lab",
  meta: "Semantic search · Plot predictions · Impact preview · Story memory",
  missing: {
    seal: "演",
    description:
      "Select a project to simulate plot directions, story memory, and the potential impact of setting changes here.",
  },
  authority: {
    reference: "Reference",
    draft: "Draft",
    candidate: "Candidate",
    confirmed: "Confirmed",
    locked: "Locked",
  },
  actions: {
    eyebrow: "Explicit maintenance · ACTIONS",
    title: "Generate predictions & maintain memory",
    directionLabel: "Direction to simulate",
    horizonLabel: "Horizon chapters",
    countLabel: "Candidate count",
    generate: "Generate predictions",
    generating: "Generating…",
    rebuild: "Rebuild all memories",
    consolidate: "Consolidate working memory",
    generateError: "Prediction not generated",
    memoryError: "Memory maintenance did not complete",
  },
  search: {
    eyebrow: "Semantic search · SEARCH-01",
    title: "Search related story memory",
    placeholder:
      "e.g. What signs appeared before the sister vanished in chapter 3?",
    inputLabel: "Search question",
    button: "Search",
    resultsLabel: "Search results",
    error: "Search failed",
    empty: "No related story memory found.",
    hint: "Enter a question and related settings, text, and memories will appear here.",
  },
  predictions: {
    title: "Plot predictions",
    count: "{count} entries",
    loadError: "Predictions cannot be loaded right now",
    empty: "No simulations have become predictions yet.",
    horizon: "+{horizon} chapters later",
    stale: "Stale",
    adopt: "Adopt",
    dismiss: "Dismiss",
    flash: "{status} · “{title}”",
    status: {
      candidate: "Pending",
      adopted: "Adopted",
      dismissed: "Dismissed",
    },
  },
  memories: {
    title: "Story memory · {count}",
    loadError: "Memories cannot be loaded right now",
    empty: "No memories stored yet",
  },
  dryRun: {
    title: "Impact preview",
    intro:
      "Before making a change, check which settings, chapters, and story states it would affect.",
    placeholder: "e.g. Change Lin Zhao into someone who never really existed.",
    inputLabel: "Change to preview",
    submit: "Preview impact",
    error: "Impact preview failed",
    resultLabel: "Impact preview result",
    safe: "Safe to proceed; no conflicting links found",
    unsafe: "Not recommended; the following are not isolated",
    empty: "No impact preview yet.",
  },
};
