# Quick Start

This page does one thing: get NarraLume 叙灯 running, and make sure you know where your data lives. First-time users should start with the hosted demo or the release package for their platform; come back to the development section only if you plan to change code.

## Hosted demo

Open [app.narralume.me](https://app.narralume.me/) and the browser will create a local database for that site. The hosted demo does not require a model configuration up front: works, settings, and the built-in model key are all stored in the current browser's OPFS.

Before using the hosted demo, keep three things in mind:

- Clearing site data, using a private window, or switching browsers can make the original local library inaccessible.
- When the browser calls a model directly, the upstream service must allow CORS from the current site; alternatively, route requests through the local Server.
- Before leaving, click "Download my library" in "Settings" and store the database file somewhere safe.

## Windows

Windows users can use the release package from [GitHub Releases](https://github.com/abligail/narralume/releases) directly; no Node.js installation is required.

1. Download the latest Windows x64 ZIP.
2. Extract it to a writable directory, for example `D:\\NarraLume`.
3. Double-click `Start-NarraLume.bat`.
4. Open the address shown by the launcher in your browser; the default is `http://127.0.0.1:4317`.

If Node.js is missing on first launch, the launcher downloads the runtime the project needs from the network. If Windows SmartScreen reports an unknown publisher, confirm the ZIP came from the Releases page above, then choose "Run anyway".

Data is stored in `data/` beside the release files by default, including `narralume.sqlite` and `backups/`. Never copy a running SQLite file directly to another machine; create a project content snapshot in "Delivery", or download a full-library backup in "Settings".

The release directory contains two more kinds of files: `.runtime/` holds the portable Node.js, dependency markers, and startup logs — it is not work data; `scripts/` provides stop, backup, and start scripts. While the app is running you can execute these in PowerShell:

```powershell
powershell -File scripts/backup.ps1
powershell -File scripts/stop.ps1
```

Environment variables can change the port and data directory:

```powershell
$env:NARRALUME_PORT = "4321"
$env:NARRALUME_DATA_DIR = "D:\\NarraLume-data"
.\\Start-NarraLume.bat
```

### Updating the Windows release

1. While the old version still opens, run `powershell -File scripts/backup.ps1`.
2. Run `powershell -File scripts/stop.ps1`, or close the launcher window and confirm the service has stopped.
3. Extract the new ZIP into a fresh directory; do not overwrite the old version in place.
4. Copy the old directory's `data/` into the new directory in full; do not let the new package's empty directories overwrite the old database.
5. Start from the new directory and check the work count, the most recent prose, and the backup list. Only archive or delete the old directory after everything checks out.

## macOS

Apple Silicon users (M1 and later) can download `macos-arm64.tar.gz` from Releases; no preinstalled Node.js is required.

1. Extract the release package and place the directory somewhere writable.
2. Double-click `Start-NarraLume.command`, or run `./Start-NarraLume.command` in a terminal.
3. Open `http://127.0.0.1:4317` in your browser.

If macOS blocks the first launch, right-click the script in Finder and choose "Open", confirming the file comes from this project's GitHub Releases. The launcher prefers an existing Node.js 24 on the system; without a suitable version it downloads and verifies the official Node.js arm64 runtime.

Backup and stop:

```bash
./scripts/backup.sh
./scripts/stop.sh
```

## Linux

The first Linux release package targets x64 desktops or servers. After downloading `linux-x64.tar.gz` from Releases:

```bash
tar -xzf NarraLume-*-linux-x64.tar.gz
cd NarraLume-*
./Start-NarraLume.sh
```

The launcher prefers an existing Node.js 24 on the system; without a suitable version it downloads and verifies the official Node.js x64 runtime. A graphical desktop attempts to open the browser; without one, visit the printed address manually.

On macOS and Linux, data is stored in `data/` beside the release files by default, and logs live in `.runtime/logs/`. The same launcher variables can be set before starting:

```bash
export NARRALUME_PORT=4321
export NARRALUME_DATA_DIR="$HOME/NarraLume-data"
./Start-NarraLume.sh
```

When updating a release package, run `./scripts/backup.sh` and `./scripts/stop.sh` first, extract the new version into a new directory, then copy the old directory's `data/` across in full. Never overwrite a directory in use or a running database directly.

## Development environment

See [CONTRIBUTING](../CONTRIBUTING.md) for the full contribution workflow. The most common commands are:

```bash
npm ci
npm run dev
npm run verify
```

`npm run verify` runs formatting, linting, type checks, tests, evidence, and the production build. Run it before committing at the very least, or state which checks could not run and why.

The development Web app listens on `http://127.0.0.1:4318`; the Server/API listens on `http://127.0.0.1:4317`. If you need environment variables, copy `.env.example` to `.env.local`; never commit real keys.

## What to do after startup

1. Open "Shelf" and click "Blank book". You can create a book and write by hand without any model.
2. Enter "Story", fill in the author intent, then build the outline, entities, canon facts, relations, timeline, and foreshadows as needed.
3. Create chapter prose in "Writing"; when you want AI, create a provider and a model in "Settings" and assign it to the "Default generation model" role.
4. In "Delivery", review quality reminders, export the work, and create a content snapshot.

For the full feature walkthrough see the [user guide](user-guide.md); for environment variables and provider protocols see [Configuration](configuration.md).

## When startup fails

- Port in use: set `NARRALUME_PORT` for the local launcher, or stop the process occupying 4317/4318.
- The browser cannot open the page: make sure the launcher window has not exited, and visit the Web address printed in that window.
- Data directory not writable: point `NARRALUME_DATA_DIR` or `NARRATIVE_DATA_DIR` at a directory your user can write to.
- AI requests fail: check the provider protocol, Base URL, API key, and CORS; confirm the provider works with the connection probe in "Settings" first.
