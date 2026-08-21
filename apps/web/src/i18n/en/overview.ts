import type { overview as overviewZh } from "../zh/overview";

export const overview: typeof overviewZh = {
  requiredState: {
    seal: "览",
    title: "Project overview",
    description:
      "Select a work to see writing progress, running tasks, and the next step here.",
  },
  loadError: "Overview is temporarily unavailable",
  masthead: {
    emptyPremise: "The opening page is still unwritten.",
    progress: "{committed} committed · {total} chapters · {words} characters",
    lastWriting: "Last writing {time}",
    neverWriting: "No writing yet",
  },
  currentChapter: {
    head: "Current chapter",
    continue: "Continue writing",
    continueAria: "Continue this chapter in the writing desk",
    viewStory: "View story",
  },
  completed: {
    noChapters: "No chapters yet; next step: build the story outline.",
    reviewFoundation:
      "No chapter is being written; next step: confirm the story direction.",
    resolveStoryChanges:
      "Chapters are committed; next step: confirm the story changes brought by the manuscript.",
    reviewWriting:
      "Chapters are committed; next step: handle review and revisions.",
    buildOutline: "No writable chapters yet; next step: build the story outline.",
    complete: "All chapters are committed; next step: check and deliver.",
    fallback: "No chapter is being written; next step: {action}.",
  },
  entries: {
    ariaLabel: "Next-step entries",
    organizeStory: {
      label: "Organize the story",
      blurb: "Fill in characters, outline, and story facts",
    },
    autopilot: {
      label: "AI quick creation",
      blurb: "Complete multiple chapters on the default pipeline; the author can step in anytime",
    },
  },
  nextAction: {
    continueTask: {
      label: "Continue the current task",
      blurb: "Return to where it started to handle candidate drafts or keep writing",
    },
    backToStudio: {
      label: "Back to the writing desk",
      blurb: "Continue the current manuscript",
    },
    reviewFoundation: {
      label: "Confirm the story direction",
      blurb: "Pick the story compass from the foundation candidates",
    },
    resolveStoryChanges: {
      label: "Confirm story changes",
      blurb: "Adjudicate character, timeline, and foreshadow changes brought by the manuscript",
    },
    reviewWriting: {
      label: "Handle review and revisions",
      blurb: "Adjudicate issues and suggestions next to the manuscript",
    },
    writeChapter: {
      label: "Continue writing this chapter",
      blurb: "Write by hand, or hand the chapter to AI for an adoptable manuscript",
    },
    buildOutline: {
      label: "Build the story outline first",
      blurb: "Decide characters, chapters, and the story's direction",
    },
    complete: {
      label: "Check and deliver",
      blurb: "Export or back up the work after quality checks",
    },
  },
  activeTask: {
    aria: "Active task",
    head: "Active task · {kind}",
    fallbackTitle: "Background task",
    backAria: "Return to the task",
    backLabel: "Return to the task",
    decideLabel: "Handle candidates and rulings",
    error: "The task action did not complete",
  },
  cancelDialog: {
    title: "Cancel the current task",
    confirm: "Confirm cancel",
    body: "The task stops at a safe boundary; saved manuscript and versions are not deleted.",
  },
  pending: {
    aria: "To-dos",
    foundation: "Foundation candidates",
    issues: "Review issues",
    proposals: "Revision proposals",
    canon: "Story changes",
    resume: "Latest AI task · {label}",
  },
};
