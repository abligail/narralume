import type { shell as shellZh } from "../zh/shell";

export const shell: typeof shellZh = {
  nav: {
    shelf: "Shelf",
    shelfBlurb: "Catalog, search, and create books",
    overview: "Overview",
    overviewBlurb: "Current progress, active tasks, and next steps",
    bible: "Story",
    bibleBlurb: "Intent, characters, outline, and story facts",
    studio: "Writing",
    studioBlurb: "Manuscript, versions, drafts, and review",
    delivery: "Delivery",
    deliveryBlurb: "Quality gates, press export, and backups",
    autopilot: "AI Quick Create",
    autopilotBlurb: "Finishes multiple chapters along the default pipeline; the author can step in anytime",
    runs: "Runs",
    runsBlurb: "Issue archive of every run",
    lab: "Narrative Lab",
    labBlurb: "Plot prediction, story memory, and change-impact rehearsal",
    settings: "Settings",
    settingsBlurb: "Default generation model and role inheritance (providers, models, and role assignment)",
    goTo: "Go to {label}",
    aria: "Main navigation",
  },
  groups: {
    quick: "AI Create",
    advanced: "Advanced tools",
  },
  status: {
    connecting: "Connecting to the local kernel",
    online: "Kernel online",
    offline: "Kernel offline",
  },
  repository: {
    viewSource: "View source on GitHub",
  },
  seal: {
    current: "Current workspace seal “{seal}”",
  },
  rail: {
    expand: "Expand navigation",
    collapse: "Collapse navigation",
  },
  loading: {
    workspace: "Unfolding the workspace…",
  },
  theme: {
    followSystem: "Follow system theme again",
    toDark: "Switch to night light",
    toLight: "Switch to daylight",
  },
  language: {
    switch: "Switch interface language (中文)",
  },
  palette: {
    button: "Command palette (⌘K)",
    title: "Command palette",
    search: "Search commands",
    placeholder: "Type a command or workspace…",
    close: "Close command palette",
    noResults: "No matching commands",
    footerSelect: "Select",
    footerRun: "Run",
    hintAdvanced: "Advanced",
  },
  trial: {
    title: "Enter the online trial",
    configMissing: "The trial site has not finished verification setup.",
    checking: "Confirming your session…",
    challenge: "Please complete the human verification.",
    timeout: "The verification service timed out. Reload the verification.",
    rejected: "Verification failed. Please try again.",
    unavailable: "The verification widget is temporarily unavailable. Reload the verification.",
    loadFailed: "The verification widget failed to load. Check your network or content-blocking settings and try again.",
    reload: "Reload verification",
  },
};
