# User Guide

This guide introduces NarraLume 叙灯 in the order of the writing process. You do not have to read it end to end: start from the Shelf, and read each page as you reach it. Button names in the interface appear in quotes throughout.

## Three things to know first

### Writing works without a model

A model is only needed for AI generation, review, story organization, and semantic search. Without one, you can still:

- create, import, and manage works;
- organize story intent, outline, characters, facts, timeline, and foreshadowing;
- write prose by hand at the writing desk, and save versions and comments;
- export works, create content snapshots, and download full-library backups.

### AI proposes, the author decides

AI-generated prose, edit suggestions, and story-setting changes always appear as candidates first. A candidate never overwrites the current prose, nor does it change story settings directly. You can adopt, reject, or keep each item; only adopted content becomes the official version.

### Data depends on how you run it

The hosted demo uses a local database scoped to the current browser and site; the Windows, macOS, and Linux launchers and source mode use the local Server; Docker uses its own data volume. They do not synchronize automatically just because they share the same browser or project name. See [Data, privacy, and backup](data-and-backup.md) for migration and recovery.

## Getting to know the interface

The left navigation divides features into three groups: Shelf, Overview, Story, Writing, and Delivery form the daily mainline; "AI Quick Create" sits alone in the AI Create group; Runs, Narrative Lab, and Settings sit in the Advanced tools group. Once you enter a work, the left entries always point at the current work — no need to go back to the Shelf to pick it again.

Common global entries:

- Click the collapse button in the lower-left corner to leave more horizontal room for prose; navigation collapses automatically on narrow screens.
- Click the sun or moon icon to switch between light, dark, and system-following themes.
- Press `Ctrl+K` (`Command+K` on macOS) to open the command palette and jump to a workspace by name.
- Inside a work, press `Ctrl+J` (`Command+J` on macOS) to open or close the project Co-work sidebar.

"Kernel online" in the lower-left corner means the current data driver can respond to requests; it does not guarantee that a model provider is usable. Model connections are probed separately from the provider cards in "Settings".

The interface supports both Chinese and English; switch it under "Interface language" in "Settings". The quoted names in this guide follow the English UI.

## Shelf: manage works

The Shelf is the entry point for all works. Each book shows its cover, title, synopsis, chapter count, word count, and last-updated time.

![Shelf, book creation entries, and a custom cover](../assets/narralume-shelf-1920x1080.png)

The search box matches titles, subtitles, and premises at once. The upper-right corner switches between cover view and list view; "Incl. archived" only decides whether archived works are shown — it does not change any work's state.

### Create a work

Click "Blank book", fill in the title and premise, then click "Create and shelve". The premise can be left empty and filled in later from the Shelf's edit window.

If you only have an idea, click "AI-guided book" and enter the genre, characters, conflict, or ending direction. The AI organizes it into direction candidates first; you enter the project after confirming. This entry requires an assigned default generation model.

### Import an existing manuscript

Click "Import manuscript" and choose Markdown, plain text, DOCX, HTML, EPUB, or a NarraLume project bundle. Importing first produces a batch with a candidate list; it does not rewrite the story immediately.

1. Wait for the file analysis to complete.
2. Review each candidate's type, title, and status, and deselect items you do not need.
3. Click "Apply" to write the selected content into the project, or click "Discard batch".
4. The analysis run behind an import can be reviewed later in the Run Center.

A project bundle suits migrating a work already organized in NarraLume; Markdown, plain text, DOCX, and EPUB suit importing prose or older drafts. Imports never carry model keys.

### Covers, duplication, and archive

From a work's more-actions menu you can edit the title, subtitle, premise, and cover. Covers support JPG, PNG, and WebP, and can be adjusted in a 3:4 portrait frame after upload.

"Copy" creates an independent work, good for experimental versions or handing to a collaborator. "Archive" only hides a work from the default Shelf without deleting content; turn on "Incl. archived" to see it again.

### Recycle bin

"Move to recycle bin" keeps a work for 30 days. Works in the recycle bin can be restored; "Delete permanently" cannot be undone and falls outside the ordinary backup-recovery flow. Confirm you have a readable backup before deleting.

## Project overview: know what to do next

After entering a work, you land on the "Project overview". It concentrates:

- completed chapters, total word count, and the most recent writing time;
- currently running AI tasks;
- pending review issues and story changes;
- next-step entries such as "Continue the current task", "Organize the story", and "AI quick creation".

You can leave the page while a task keeps running in the background. When you return, re-enter the original processing point from the overview or the task card — do not submit the same piece of work twice.

![Project overview, active tasks, and next-step entries](../assets/narralume-overview-1920x1080.png)

## Story: maintain story material

The "Story" page is also called the "Story Bible". It keeps material that affects later chapters in seven sections, which you can switch quickly with the section tabs on the left.

### Author intent

Record the core reading experience this book promises, plus themes, audience, tone, ending direction, current focus, and boundaries it will not write. It is an important reference for AI planning and review, and your own basis for judging whether a candidate draft has drifted off course.

### Outline

Build the hierarchy of volumes, chapters, and scenes, with titles, summaries, and chapter goals. Chapter prose can bind to an outline node; nodes already bound or archived do not reappear in the new-chapter list.

The outline is the writing plan, not the prose. Editing the outline does not automatically rewrite chapters that are already saved.

### Entities, canon facts, and relations

- "Entities" holds people, places, organizations, items, and similar objects.
- "Canon facts" holds confirmed content such as character states, abilities, and setting limits.
- "Relations" records how relationships between people or entities change, and when.

You can edit these by hand or generate AI candidates in the corresponding section. The candidate panel shows an itemized diff; a locked fact must have its conflict handled first and cannot be silently overwritten by an ordinary candidate.

### Timeline and foreshadows

The timeline records events in the story world, with times and notes. Foreshadows track clues that are planted, developing, resolved, or temporarily kept. An unresolved foreshadow is not automatically an error; its state changes only when you decide to resolve it.

### Story candidates

In "Candidate changes", write down what you want to add or adjust — for example, "make the character's motivation more concrete, but do not change the locked ending". After generation, review the diff item by item, then choose "Adopt" or "Reject". Nothing is written into the story material until adoption.

![The seven sections of the Story Bible and the candidate-changes area](../assets/narralume-bible-1920x1080.png)

## Writing: from draft to official version

### Create a manuscript

On the "Writing" page, click "New" and choose:

- Chapter prose: binds to an outline chapter;
- Scene prose: writes a local scene without carrying a full chapter settlement;
- Outline draft, synopsis, writing notes, and style sample: supporting material.

Chapter prose is best bound to an outline node. If no matching outline exists, go back to "Story" and create the chapter first.

### Write by hand and save versions

The prose editor uses Markdown. Type or paste text directly, then click "Save new version" when done. A saved version keeps the current prose and its point in time; you can later review it in the "Versions" panel and restore a historical version.

Restoring a historical version does not erase other versions; the restored content must be saved again before it becomes the current official version.

### Manuscript recycle bin

"Move to recycle bin" on the right side of the writing desk hides the current manuscript while keeping its prose, versions, comments, and review records. Manuscripts in the recycle bin take no part in new writing, review, or export tasks; to keep using one, open "Recycle bin" from the top of the draft list and restore it.

The manuscript recycle bin and the Shelf recycle bin are not the same level. The former handles manuscripts within one work, the latter handles whole works; restoring a manuscript does not change the work's archive state.

### Selections, comments, and local edits

Select text in the prose first, then open the "Selection" tools:

- Record issues worth revisiting in "Comment". The first time you comment on a passage, the system also saves a version anchor.
- Describe the goal in "AI edit instruction" — for example, "reduce repetitive action description while keeping the tension". After clicking "Generate edit proposal", the candidate returns to the writing desk.
- After reviewing the diff, you can adopt, reject, or keep refining the instruction. A candidate never replaces the prose directly.

### Hand a chapter to AI

With chapter prose selected, click "Hand to AI". The AI generates a chapter candidate from the current story material and outline, then runs lightweight checks and a review. When it finishes, enter the candidate panel from the AI writing task to review the prose, the review result, and the story changes.

Adopting the candidate creates an official prose version; if the task fails, fix the model or network first, then retry or recover from the task scene. Any partial prose already saved stays in the task details.

### Review and revisions

The "Review" panel shows the review conclusion for the current version, the scoring breakdown, and issues awaiting a ruling. Issues are usually categorized as character, continuity, pacing, prose, chapter goal, and the like.

Every issue carries evidence excerpts and a suggested action. You can accept, reject, mark a false positive, or intentionally keep an issue. When a change is needed, generate a candidate in the "Revision proposals" panel, adopt it, then save a new version.

Review is an auxiliary check, not a publication license. Whether a passage stays is always the author's decision.

### Story changes

After a chapter is saved or an AI candidate adopted, the system organizes the character states, facts, relations, timeline events, and foreshadows this chapter may have changed. Changes appear in the "Story changes" panel and are not written into the story material until adopted.

If a change conflicts with a locked fact, the panel pauses in an awaiting-ruling state. Resolve the conflict first, then continue with later tasks.

### Co-create sandbox

Switch to the "Co-create sandbox" to build a story room, with participants, a speaker policy, and a director's note. Co-creation turns are saved as independent records, good for brainstorming, character dialogue, and scene trials. Co-created content does not enter chapter prose automatically until adopted or saved.

![Draft list, prose, review, and version tools at the writing desk](../assets/narralume-studio-1920x1080.png)

## AI quick creation: produce multiple chapters in one run

"AI quick creation" fits when the direction is already clear and you want several chapters to move forward at once. It shares the same chapter-production pipeline as "Hand to AI", but at a larger scope.

### Three steps

1. **Prepare the story direction**: fill in the idea directly, or let the AI organize candidates from brainstorming.
2. **Confirm the story direction**: fill in the core promise, ending direction, thematic questions, non-negotiable requirements, target chapter count, reference words per chapter, and volume count.
3. **Start serial creation**: choose serial creation or per-chapter confirmation, then set the planning mode and generation quality.

Without chapter-level outlines, you can choose "Run automatically" and let the task build a lightweight plan internally; choose "Confirm each chapter plan first" if you want to see the plan beforehand.

### How to step in during a run

The task card shows the current chapter, stage, waiting reason, and next action. During a run you can add direction, pause, resume, retry, or cancel.

- Requirements that only affect the current chapter or later plans take effect at the next safe boundary.
- Requirements that touch prose or story settings first become revision candidates or story-change candidates.
- After a candidate is adopted, subsequent chapters continue from the new state.
- When the task finds a locked-fact conflict or a critical review issue, it stops and waits for you to handle it.

The hosted demo's built-in model allows at most 3 chapters per quick creation; with your own provider, your configured model and resources set the limit.

![Direction, confirmation, execution, and intervention areas of AI quick creation](../assets/narralume-autopilot-1920x1080.png)

## Project assistant: find the entry point in one sentence

Inside a project, click "Co-work" on the right to ask the assistant questions or describe a goal directly. By default the assistant reads the context of the current page — the selected chapter, the prose selection, or a story section; the toggle on the context strip switches later messages to project-global material only. `Ctrl+J` or `Command+J` also opens and closes the sidebar.

Things well suited to saying directly:

- "Show me the unresolved review issues in this chapter."
- "Plan three possible conflicts for the next chapter."
- "Make this passage more restrained; give me candidates first."
- "Pause the current quick creation and keep the finished chapters."

Each project can hold multiple collaboration conversations. The top menu switches, creates, renames, and archives conversations; an archived conversation is read-only, while its history, task activity, and key artifacts remain. At the bottom of the sidebar you can switch the model and thinking level for the current conversation within the same protocol; switching across protocols means going back to "Settings" to change the default generation model.

The assistant answers analytical questions directly; when writing or task control is involved, it proposes pending actions first. Prose adoption, story-setting adoption, and permanent deletion are still completed on their own pages, to avoid mistakes inside a chat.

### Writing Skill and Agent Skill

- A Writing Skill is a package of writing prompts and reference material, enabled per scope: all, chapter, co-create, edit, or review. You can create and edit them in the interface, or import, validate, and export `.skill.zip` bundles.
- An Agent Skill is a constrained assistant task package that declares its trigger description, instructions, and a capability whitelist. It is currently imported from a ZIP bundle; it can be enabled, disabled, or deleted, but not created or exported in the interface.

An imported Agent Skill can only use the read-only or candidate-form capabilities the system allows; it cannot run arbitrary scripts, make arbitrary network requests, or write the database directly. Adopting official prose and confirmed settings still follows the product's built-in confirmation boundaries.

![The AI assistant sidebar in the project overview](../assets/narralume-assistant-1920x1080.png)

## Advanced tools

### Run Center

The Run Center organizes every AI task by month, showing status, revision rounds, and model call counts. Opening a run reveals its text streams, steps and errors, checkpoints, reviews, effective execution policy, context receipts, model snapshots, and call ledger.

The page only shows operations the current state allows — pause, resume, adopt plan, adopt or discard manuscript, request revision, retry chapter, switch to manual, and cancel. When streaming generation is interrupted, persisted partial prose of a usable minimum length can be continued, adopted, regenerated, or discarded; do not start an identical new run just to recover a task.

When ordinary creation fails, prefer handling it from the writing desk or the quick-creation task card; enter the Run Center when you need to verify the failure reason, model usage, or partial prose.

![Tasks, steps, and recovery information in the Run Center](../assets/narralume-runs-1920x1080.png)

### Narrative Lab

The Narrative Lab offers four kinds of operations: search story memory in natural language; generate plot predictions by direction, prediction span, and candidate count; rebuild or consolidate memory; and rehearse which material a setting change would affect before making the change for real.

Prediction results can be adopted as later reference or set aside; when the underlying story material changes, old predictions are marked stale. Memory maintenance and impact preview are analysis tools — they never rewrite prose, confirmed settings, or the timeline automatically.

![Predictions, memory, search, and impact preview in the Narrative Lab](../assets/narralume-lab-1920x1080.png)

### Settings

Settings contains four groups:

- **Default generation model and role inheritance**: choose the default generation model, override the planning and review models as needed, and configure the embedding model separately. Provider management creates, edits, disables, and probes providers and models.
- **Production assets**: pick the project the assets belong to first, then maintain styles, Writing Skills, Agent Skills, and historical import batches. Styles record positive rules, banned rules, and examples; import management continues analysis, filters, applies, or discards old-manuscript candidates.
- **Run driver**: switch between auto-detect, the browser local kernel, and the local Server. Browser mode also shows storage usage, persistent-storage authorization, and the last full-library download time.
- **System backup archives**: create full SQLite backups for the local Server, preview hash, integrity, and foreign-key checks, then restore to a new directory different from the current data directory.

The browser kernel uses "Download my library" to obtain the complete SQLite file; the local Server uses system backup archives or the backup scripts. Switching the run driver does not migrate data; seeing a different library after a refresh is normal.

![Model providers, data driver, and advanced asset settings](../assets/narralume-settings-1920x1080.png)

## Delivery: export and preserve

### Quality checks

The Delivery page checks for missing prose, chapter titles, empty drafts, unfinished tasks, and similar conditions. Quality checks only remind; they never block export, and they do not decide for the author whether the content qualifies.

### Export formats

- Markdown: good for further editing and version control;
- Plain text: good when only the prose content is needed;
- DOCX: good for handing to Word users for further layout;
- EPUB: good for e-book preview;
- Story bundle: one work's author-visible material, good for migrating to another NarraLume environment.

### Project content snapshots

In "Delivery", fill in a label and click "Create content snapshot". A snapshot covers work material, story structure, prose versions, comments, reviews, co-creation, and assistant history — but no model keys. Clicking "Restore content copy" creates a new project without overwriting the original.

After restoring, check the outline, the most recent prose versions, comments, story changes, and run records before deciding whether to continue writing.

### Full-library backups

In browser mode, use "Download my library" in Settings; with the local Server, use `scripts/backup.ps1` on Windows or `scripts/backup.sh` on macOS/Linux; with Docker, use `scripts/docker-backup.ps1`. A full SQLite backup may contain provider credentials, so keep it in a controlled directory like the manuscript itself. Never copy the main database file directly while the service is running.

![Quality reminders, export formats, and project content snapshots](../assets/narralume-delivery-1920x1080.png)

## Mobile and desktop

On mobile, navigation folds into a top button and workspaces become a single-column layout. Browsing, reviewing story material, handling candidates, and light editing work fine on mobile; long-form prose editing, serial creation, and large imports are better done in a desktop browser.

## Related documents

- [Quick start](quick-start.md): starting the hosted demo, Windows, macOS/Linux, and development environments.
- [Configuration](configuration.md): provider protocols, environment variables, Docker, and Bridge/Relay.
- [Data, privacy, and backup](data-and-backup.md): storage locations, project bundles, project snapshots, and full-library recovery.
- [Docker Compose](docker.md): self-hosted running, updating, stopping, and backup.
- [Cloudflare deployment](deploy-cloud.md): deployment boundaries for the public Web, Relay, and Bridge.
