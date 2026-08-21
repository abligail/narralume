[中文](data-and-backup.md)

# Data, Privacy, and Backup

NarraLume does not provide cloud sync. Where your work actually lives depends on whether you use the hosted demo, a local Server, or Docker; signing into the same browser account does not make this data interoperate automatically.

Start by telling the three file types and recovery paths apart:

| Object                   | Scope                                 | Best for                                                                         | Contains model keys? |
| ------------------------ | ------------------------------------- | -------------------------------------------------------------------------------- | -------------------- |
| Project bundle           | One work                              | Importing a work into another NarraLume instance or handing it to a collaborator | No                   |
| Project content snapshot | One work in the current library       | Marking a milestone you can later restore as a new project                       | No                   |
| Full SQLite backup       | The entire library and local settings | Disaster recovery before upgrades, machine migration, or clearing site data      | Possibly             |

A practical habit: create a project snapshot after finishing important chapters, download the full library regularly, and make one more full backup — plus a trial restore into a new directory — before any upgrade or migration. A synced drive can hold backup files, but syncing itself is not a recoverable backup.

## Browser local kernel

Browser mode stores works, the story compass, run history, and any bring-your-own model keys saved in the interface in the OPFS SQLite database of the current browser and current site.

- Data is isolated per site; changing the domain, browser profile, or using a private window may hide the original library.
- Clearing site data deletes the local library. Before clearing any cache, click "Download my library" in Settings and confirm the downloaded file is readable.
- When the browser kernel calls a model directly, the upstream must allow CORS for the current site; this differs from the local Server's call chain.
- The browser library is not copied automatically into the release package's `data/`, and it does not sync just because you sign into the same account.

## Local Server and release launchers

The default database is `data/narralume.sqlite`, and consistency backups are written to `data/backups/`. If `NARRATIVE_DATA_DIR` or `NARRATIVE_BACKUP_DIR` is set, the environment variables win. Each platform launcher's `NARRALUME_DATA_DIR` overrides the data directory it uses.

Do not copy the live SQLite main file while the service is running. Use the full library download in Settings, `scripts/backup.ps1` on Windows, `scripts/backup.sh` on macOS/Linux, or the Server's backup API. The backup flow runs SQLite integrity and foreign-key checks plus SHA-256 verification, and writes to a temporary file before atomically replacing the target, so a half-finished file is never mistaken for a recoverable backup.

In a launcher release package:

- `data/` holds works and backups, and must be part of your personal backup plan.
- `.runtime/logs/` holds startup and error logs for diagnosing launch failures; it is not a data backup.
- Project content snapshots do not contain provider channels or keys; a full SQLite backup may contain locally stored provider credentials.

## Docker volumes

Compose places the database on the `narralume-data` volume and mounts backups separately to `${NARRATIVE_BACKUP_HOST_DIR:-./data/backups}` on the host. The volume itself is not a backup, and the backup directory must not sit on the same fragile disk as the only copy of the database.

Create an online backup:

```powershell
powershell -File scripts/docker-backup.ps1
```

Stop the service but keep the data:

```powershell
powershell -File scripts/docker-stop.ps1
```

Do not use `docker compose down --volumes` unless you explicitly intend to delete all work data and already hold a verified external backup.

## Project snapshots and project bundles: single-work recovery and migration

Fit for handing one work to a collaborator, making an experimental copy inside the same library, or leaving a readable milestone before delivery:

1. Open the project's "Delivery", fill in the "Backup label", and click "Create content snapshot".
2. In the snapshot list, confirm the label, time, and content scope.
3. To migrate, download the "Project bundle" under "Export formats" and import it in the target environment; Markdown, plain text, DOCX, and EPUB are reading/delivery formats only.
4. To roll back, click "Restore content copy" on the corresponding row, confirm the dialog, and open the new project.
5. On the new project, verify the story compass, outline, latest manuscript versions, comments, and run history; the original project is not overwritten.

Project snapshots intentionally do not carry provider channels or keys. After a restore, configure and assign models again in the target environment's Settings if you need AI.

## Full SQLite backup: whole-library disaster recovery

Fit for before clearing browser site data, before upgrading a release package, before migrating machines, and for release-candidate acceptance:

1. Stop any operation that would modify the database, and create a full-library backup. For a running local Server, use `scripts/backup.ps1` on Windows or `scripts/backup.sh` on macOS/Linux; in browser mode use "Download my library" in Settings.
2. Record the backup file's SHA-256 and copy the file to encrypted storage or a controlled synced directory separate from the application directory.
3. Preview or verify the backup in Settings and confirm that the integrity, foreign-key, and hash checks pass.
4. For recovery, prepare a brand-new target directory; never overwrite the database of the running instance.
5. Start a test instance against the restored directory and check work count, latest manuscript versions, story compass, outline, comments, run history, and the backup list.
6. Only after the drill passes, stop the production instance and switch `NARRATIVE_DATA_DIR`; keep the old directory until the new instance runs stably.

## How to confirm a backup is really usable

Do not settle for "the file exists". Regularly restore a full backup into a new test directory, then verify work count, latest manuscript versions, outline, confirmed facts, comments, and run history. Record the backup file name, creation time, SHA-256, application version, and restore directory. Clean up the test data only after the test instance checks out; the production data directory stays untouched.

Project maintainers should also check whether the restore left behind `.partial`, `.partial-shm`, or `.partial-wal` files, and keep one reviewable restore record for every release candidate.

If a backup contains real model credentials, do not upload the keys, the full database, or model responses — along with their hashes — to public Issues, CI artifacts, or screenshots. For security incident handling, see [SECURITY.md](../SECURITY.md).
