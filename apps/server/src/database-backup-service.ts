import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, parse, relative, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

import {
  SystemBackupManifestSchema,
  type SystemBackupManifestDto,
  type SystemBackupPreviewDto,
} from "@narralume/contracts";
import type { NarrativeDatabase } from "@narralume/persistence";

export class DatabaseBackupService {
  readonly backupDirectory: string;

  constructor(
    private readonly database: NarrativeDatabase,
    backupDirectory: string,
    private readonly retention = 10,
  ) {
    if (database.path === ":memory:")
      throw new DatabaseBackupError(
        "backup.memory_database",
        "In-memory databases do not support file-based disaster recovery",
      );
    this.backupDirectory = resolve(backupDirectory);
    mkdirSync(this.backupDirectory, { recursive: true });
  }

  list(): SystemBackupManifestDto[] {
    const files = readdirSync(this.backupDirectory);
    const partials = files.filter((file) => file.endsWith(".partial"));
    if (partials.length > 0)
      throw new DatabaseBackupError(
        "backup.partial_detected",
        `Backup directory contains unfinished files: ${partials.join(", ")}`,
      );
    const manifests = files
      .filter((file) => file.endsWith(".manifest.json"))
      .map((file) => {
        try {
          return this.readManifestFile(resolve(this.backupDirectory, file));
        } catch (error) {
          throw new DatabaseBackupError(
            "backup.manifest_corrupt",
            `Backup manifest is corrupt: ${file}`,
            error,
          );
        }
      });
    const referenced = new Set(
      manifests.map((manifest) => manifest.databaseFile),
    );
    const orphaned = files.filter(
      (file) => file.endsWith(".sqlite") && !referenced.has(file),
    );
    if (orphaned.length > 0)
      throw new DatabaseBackupError(
        "backup.orphan_detected",
        `Backup directory contains databases without a manifest: ${orphaned.join(", ")}`,
      );
    for (const manifest of manifests) {
      if (!existsSync(this.backupPath(manifest.databaseFile)))
        throw new DatabaseBackupError(
          "backup.file_missing",
          `Backup database file does not exist: ${manifest.databaseFile}`,
        );
    }
    return manifests.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async create(label: string, now: string) {
    const id = randomUUID();
    const stamp = now.replace(/[:.]/gu, "-");
    const databaseFile = `${stamp}-${id}.sqlite`;
    const databasePath = this.backupPath(databaseFile);
    const temporaryPath = `${databasePath}.partial`;
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    // 本服务只在 Node 服务端实例化；进程内驱动恒为 node:sqlite。
    await sqliteBackup(this.database.raw as DatabaseSync, temporaryPath, {
      rate: 256,
    });
    const inspection = inspectTemporaryDatabase(temporaryPath);
    if (
      inspection.integrityCheck !== "ok" ||
      inspection.foreignKeyViolations > 0
    ) {
      unlinkSync(temporaryPath);
      throw new DatabaseBackupError(
        "backup.validation_failed",
        "Online backup failed the SQLite integrity check",
      );
    }
    renameSync(temporaryPath, databasePath);
    const manifest = SystemBackupManifestSchema.parse({
      id,
      label,
      databaseFile,
      createdAt: now,
      sizeBytes: statSync(databasePath).size,
      sha256: await hashFile(databasePath),
      migration: inspection.migration,
      pageCount: inspection.pageCount,
      projectCount: inspection.counts.projects,
    });
    const manifestPath = this.manifestPath(id);
    const temporaryManifest = `${manifestPath}.partial`;
    writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2), "utf8");
    renameSync(temporaryManifest, manifestPath);
    this.applyRetention();
    return manifest;
  }

  async preview(id: string): Promise<SystemBackupPreviewDto> {
    const manifest = this.requireManifest(id);
    const databasePath = this.backupPath(manifest.databaseFile);
    if (!existsSync(databasePath))
      throw new DatabaseBackupError(
        "backup.file_missing",
        "Backup database file does not exist",
      );
    const sha256 = await hashFile(databasePath);
    const inspection = inspectDatabase(databasePath);
    const hashMatches = sha256 === manifest.sha256;
    return {
      manifest,
      valid:
        hashMatches &&
        inspection.integrityCheck === "ok" &&
        inspection.foreignKeyViolations === 0 &&
        inspection.migration === manifest.migration &&
        inspection.migration <= this.database.currentMigration(),
      hashMatches,
      integrityCheck: inspection.integrityCheck,
      foreignKeyViolations: inspection.foreignKeyViolations,
      counts: inspection.counts,
    };
  }

  async restore(id: string, targetDirectoryInput: string, overwrite: boolean) {
    const preview = await this.preview(id);
    if (!preview.valid)
      throw new DatabaseBackupError(
        "backup.restore.invalid",
        "Backup failed the pre-restore validation",
      );
    const requestedTargetDirectory = resolve(targetDirectoryInput);
    mkdirSync(requestedTargetDirectory, { recursive: true });
    const currentDirectory = realpathSync.native(dirname(this.database.path));
    const targetDirectory = validateRestoreTarget(
      requestedTargetDirectory,
      currentDirectory,
      realpathSync.native(this.backupDirectory),
    );
    const databasePath = resolve(targetDirectory, "narralume.sqlite");
    if (existsSync(databasePath) && !overwrite)
      throw new DatabaseBackupError(
        "backup.restore.target_exists",
        "Target data directory already contains a database; enable overwrite explicitly to replace it",
      );
    const temporaryPath = resolve(
      targetDirectory,
      `.narralume-${randomUUID()}.partial`,
    );
    const sourcePath = this.backupPath(preview.manifest.databaseFile);
    copyFileSync(sourcePath, temporaryPath);
    const restoredInspection = inspectTemporaryDatabase(temporaryPath);
    const restoredHash = await hashFile(temporaryPath);
    if (
      restoredHash !== preview.manifest.sha256 ||
      restoredInspection.integrityCheck !== "ok" ||
      restoredInspection.foreignKeyViolations > 0
    ) {
      unlinkSync(temporaryPath);
      throw new DatabaseBackupError(
        "backup.restore.copy_invalid",
        "Restored copy failed validation; existing data was not modified",
      );
    }
    validateRestoreTarget(
      targetDirectory,
      currentDirectory,
      this.backupDirectory,
    );
    replaceDatabaseFile(temporaryPath, databasePath);
    return {
      targetDirectory,
      databasePath,
      sha256: restoredHash,
      migration: restoredInspection.migration,
      counts: restoredInspection.counts,
    };
  }

  private applyRetention() {
    const manifests = this.list();
    for (const manifest of manifests.slice(Math.max(1, this.retention))) {
      const databasePath = this.backupPath(manifest.databaseFile);
      const manifestPath = this.manifestPath(manifest.id);
      if (existsSync(databasePath)) unlinkSync(databasePath);
      if (existsSync(manifestPath)) unlinkSync(manifestPath);
    }
  }

  private requireManifest(id: string) {
    if (!/^[0-9a-f-]{36}$/u.test(id))
      throw new DatabaseBackupError("backup.id.invalid", "Invalid backup ID");
    const path = this.manifestPath(id);
    if (!existsSync(path))
      throw new DatabaseBackupError("backup.not_found", "Backup not found");
    return this.readManifestFile(path);
  }

  private readManifestFile(path: string) {
    return SystemBackupManifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    );
  }

  private manifestPath(id: string) {
    return resolve(this.backupDirectory, `${id}.manifest.json`);
  }

  private backupPath(databaseFile: string) {
    if (basename(databaseFile) !== databaseFile)
      throw new DatabaseBackupError(
        "backup.path.invalid",
        "Backup manifest contains an invalid path",
      );
    const path = resolve(this.backupDirectory, databaseFile);
    if (dirname(path) !== this.backupDirectory)
      throw new DatabaseBackupError(
        "backup.path.invalid",
        "Backup file lies outside the configured directory",
      );
    return path;
  }
}

function validateRestoreTarget(
  targetDirectory: string,
  currentDirectory: string,
  backupDirectory: string,
): string {
  const resolvedTarget = resolve(targetDirectory);
  if (resolvedTarget === parse(resolvedTarget).root)
    throw new DatabaseBackupError(
      "backup.restore.root_forbidden",
      "A filesystem root cannot be used directly as a data directory",
    );
  assertNoLinkedPath(resolvedTarget);
  const realTarget = realpathSync.native(resolvedTarget);
  if (realTarget === currentDirectory)
    throw new DatabaseBackupError(
      "backup.restore.current_directory",
      "The live data directory cannot be overwritten in place; choose a different directory",
    );
  if (realTarget === realpathSync.native(backupDirectory))
    throw new DatabaseBackupError(
      "backup.restore.backup_directory",
      "The backup directory cannot also be used as the restore data directory",
    );
  return realTarget;
}

function assertNoLinkedPath(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const segment of relative(root, path)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink())
      throw new DatabaseBackupError(
        "backup.restore.link_forbidden",
        "The restore data directory must not contain symbolic links or junctions",
      );
  }
}

function inspectTemporaryDatabase(databasePath: string) {
  try {
    return inspectDatabase(databasePath);
  } finally {
    for (const suffix of ["-shm", "-wal"]) {
      const path = `${databasePath}${suffix}`;
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

export class DatabaseBackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseBackupError";
  }
}

export function replaceDatabaseFile(
  temporaryPath: string,
  databasePath: string,
  move: (source: string, target: string) => void = renameSync,
): void {
  if (!existsSync(databasePath)) {
    move(temporaryPath, databasePath);
    return;
  }
  const previousPath = `${databasePath}.previous-${randomUUID()}`;
  move(databasePath, previousPath);
  try {
    move(temporaryPath, databasePath);
  } catch (error) {
    try {
      move(previousPath, databasePath);
    } catch (rollbackError) {
      throw new DatabaseBackupError(
        "backup.restore.rollback_failed",
        `Restore install failed; the previous database was kept at ${previousPath}`,
        new AggregateError([error, rollbackError]),
      );
    }
    throw new DatabaseBackupError(
      "backup.restore.install_failed",
      "Restore install failed; the original database was rolled back",
      error,
    );
  }
  unlinkSync(previousPath);
}

function inspectDatabase(path: string) {
  const database = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
  });
  try {
    const integrity = database
      .prepare("PRAGMA integrity_check")
      .get() as Record<string, unknown>;
    const migration = database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS migration FROM schema_migrations",
      )
      .get() as { migration: number };
    const pageCount = database.prepare("PRAGMA page_count").get() as Record<
      string,
      number
    >;
    return {
      integrityCheck: String(Object.values(integrity)[0] ?? "unknown"),
      foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all()
        .length,
      migration: Number(migration.migration),
      pageCount: Number(Object.values(pageCount)[0] ?? 0),
      counts: {
        projects: tableCount(database, "projects"),
        documents: tableCount(database, "documents"),
        versions: tableCount(database, "document_versions"),
        canonFacts: tableCount(database, "canon_facts"),
        runs: tableCount(database, "runs"),
      },
    };
  } finally {
    database.close();
  }
}

function tableCount(database: DatabaseSync, table: string) {
  const result = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as {
    count: number;
  };
  return Number(result.count);
}

function hashFile(path: string) {
  return new Promise<string>((resolveHash, rejectHash) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(digest.digest("hex")));
  });
}
