import { sha256Hex } from "@narralume/domain";
import type { SqliteRawDatabase } from "./driver.js";

import { migration001 } from "./migrations/001-foundation.js";
import { migration002 } from "./migrations/002-story-kernel.js";
import { migration003 } from "./migrations/003-harness.js";
import { migration004 } from "./migrations/004-autopilot.js";
import { migration005 } from "./migrations/005-cocreate-studio.js";
import { migration006 } from "./migrations/006-delivery.js";
import { migration007 } from "./migrations/007-editing-safety.js";
import { migration008 } from "./migrations/008-canon-fact-withdrawals.js";
import { migration009 } from "./migrations/009-review-workspace.js";
import { migration010 } from "./migrations/010-run-streams.js";
import { migration011 } from "./migrations/011-long-novel-intelligence.js";
import { migration012 } from "./migrations/012-product-lifecycle.js";
import { migration013 } from "./migrations/013-resilient-import-analysis.js";
import { migration014 } from "./migrations/014-data-safety.js";
import { migration015 } from "./migrations/015-llm-call-interruption.js";
import { migration016 } from "./migrations/016-providers-models-assignments.js";
import { migration017 } from "./migrations/017-profile-fk-to-models.js";
import { migration018 } from "./migrations/018-run-observability.js";
import { migration019 } from "./migrations/019-physical-call-reservations.js";
import { migration020 } from "./migrations/020-model-runtime-convergence.js";
import { migration021 } from "./migrations/021-cross-chapter-settlement.js";
import { migration022 } from "./migrations/022-project-foundation-requests.js";
import { migration023 } from "./migrations/023-chapter-document-identity.js";
import { migration024 } from "./migrations/024-normalize-current-document-segments.js";
import { migration025 } from "./migrations/025-project-assistant.js";
import { migration026 } from "./migrations/026-canon-candidate-decisions.js";
import { migration027 } from "./migrations/027-project-covers.js";
import { migration028 } from "./migrations/028-timeline-updated-at.js";
import { migration029 } from "./migrations/029-request-replays.js";
import { migration030 } from "./migrations/030-import-upload-batch-link.js";
import { migration031 } from "./migrations/031-collaboration-versions.js";
import { migration032 } from "./migrations/032-assistant-activity-identity.js";
import { migration033 } from "./migrations/033-assistant-long-goals.js";
import { migration034 } from "./migrations/034-project-backup-counts.js";
import { migration035 } from "./migrations/035-imported-agent-skills.js";
import { migration036 } from "./migrations/036-drop-empty-manuscript-documents.js";
import { migration037 } from "./migrations/037-assistant-conversation-settings.js";
import { migration038 } from "./migrations/038-drop-run-budget-limits.js";
import { migration039 } from "./migrations/039-resource-lifecycle.js";
import { migration040 } from "./migrations/040-project-write-guard.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly legacyRepairs?: readonly MigrationRepair[];
  /**
   * Rebuild-style migrations that DROP a referenced table must run with
   * foreign key enforcement disabled (SQLite's 12-step procedure), otherwise
   * the implicit DELETE fires ON DELETE actions on referencing tables.
   * The pragma is a no-op inside a transaction, so migrate() toggles it
   * around the migration transaction.
   */
  readonly foreignKeysOff?: boolean;
}

export interface MigrationRepair {
  readonly checksum: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
  migration030,
  migration031,
  migration032,
  migration033,
  migration034,
  migration035,
  migration036,
  migration037,
  migration038,
  migration039,
  migration040,
];

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

/** A persisted run_events row, broadcast to database-level listeners. */
export interface DatabaseRunEvent {
  runId: string;
  stepId: string | null;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

export class NarrativeDatabase {
  readonly raw: SqliteRawDatabase;
  readonly path: string;
  #transactionDepth = 0;
  readonly #afterCommitCallbacks: Array<Array<() => void>> = [];
  /**
   * Database-level run-event listeners: every persisted run_events row is
   * delivered here regardless of which repository instance wrote it, so the
   * SSE broadcast covers supervisor-, route- and worker-originated events
   * alike. Listener errors are swallowed — persistence is the source of truth.
   */
  readonly #runEventListeners = new Set<(event: DatabaseRunEvent) => void>();

  /**
   * 运行时无关的库实例：驱动由调用方提供。
   * Node 用 NodeNarrativeDatabase（node:sqlite），浏览器先初始化
   * OPFS sahpool 驱动再 new（见 @narralume/persistence/browser）。
   */
  constructor(path: string, driver: SqliteRawDatabase) {
    this.path = path;
    this.raw = driver;
  }

  migrate(migrations: readonly Migration[] = MIGRATIONS): number {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const existing = this.raw
      .prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      )
      .all() as unknown as MigrationRow[];
    const byVersion = new Map(existing.map((row) => [row.version, row]));

    for (const migration of [...migrations].sort(
      (a, b) => a.version - b.version,
    )) {
      const checksum = migrationChecksum(migration);
      const applied = byVersion.get(migration.version);
      if (applied) {
        if (applied.name !== migration.name) {
          throw new MigrationError(
            `Migration ${migration.version} (${migration.name}) differs from the applied name`,
          );
        }
        if (applied.checksum === checksum) continue;

        const repair = migration.legacyRepairs?.find(
          (candidate) => candidate.checksum === applied.checksum,
        );
        if (!repair) {
          throw new MigrationError(
            `Migration ${migration.version} (${migration.name}) does not match the applied checksum`,
          );
        }

        this.transaction(() => {
          this.raw.exec(repair.sql);
          this.raw
            .prepare(
              "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum = ?",
            )
            .run(checksum, migration.version, applied.checksum);
        });
        applied.checksum = checksum;
        continue;
      }

      if (migration.version === 20) this.backupBeforeRuntimeConvergence();
      this.applyMigration(migration, checksum);
    }

    return this.currentMigration();
  }

  /**
   * Migration 020 removes the legacy profile tables and selection columns.
   * Create and integrity-check a consistent SQLite snapshot before that
   * irreversible step. In-memory/test databases intentionally skip it, and
   * browser databases are always fresh (never carry pre-B1 data), so the
   * base implementation is a no-op — only NodeNarrativeDatabase overrides it.
   */
  protected backupBeforeRuntimeConvergence(): void {
    // Node-only behavior; see node-database.ts.
  }

  private applyMigration(migration: Migration, checksum: string): void {
    if (migration.foreignKeysOff) {
      this.raw.exec("PRAGMA foreign_keys = OFF;");
    }
    try {
      this.transaction(() => {
        this.raw.exec(migration.sql);
        if (migration.foreignKeysOff) {
          const violations = this.raw.prepare("PRAGMA foreign_key_check").all();
          if (violations.length > 0) {
            throw new MigrationError(
              `Migration ${migration.version} (${migration.name}) broke ${violations.length} foreign key references`,
            );
          }
        }
        this.raw
          .prepare(
            "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            migration.version,
            migration.name,
            checksum,
            new Date().toISOString(),
          );
      });
    } finally {
      if (migration.foreignKeysOff) {
        this.raw.exec("PRAGMA foreign_keys = ON;");
      }
    }
  }

  /** Subscribe to persisted run events. Returns an unsubscribe function. */
  onRunEvent(listener: (event: DatabaseRunEvent) => void): () => void {
    this.#runEventListeners.add(listener);
    return () => this.#runEventListeners.delete(listener);
  }

  /** Called by repositories after a run_events row is committed. */
  notifyRunEvent(event: DatabaseRunEvent): void {
    for (const listener of this.#runEventListeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are swallowed: persistence is the source of truth.
      }
    }
  }

  /** Run a callback only after the outermost transaction commits. */
  afterCommit(callback: () => void): void {
    const callbacks = this.#afterCommitCallbacks.at(-1);
    if (!callbacks) {
      this.runAfterCommit(callback);
      return;
    }
    callbacks.push(callback);
  }

  currentMigration(): number {
    const table = this.raw
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { present: number } | undefined;
    if (!table) return 0;
    const row = this.raw
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get() as {
      version: number;
    };
    return row.version;
  }

  transaction<T>(work: () => T): T {
    const depth = this.#transactionDepth;
    const savepoint = `nested_${depth}`;
    if (depth === 0) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    this.#afterCommitCallbacks.push([]);

    try {
      const result = work();
      this.#transactionDepth -= 1;
      if (depth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      const callbacks = this.#afterCommitCallbacks.pop() ?? [];
      const parentCallbacks = this.#afterCommitCallbacks.at(-1);
      if (parentCallbacks) {
        parentCallbacks.push(...callbacks);
      } else {
        for (const callback of callbacks) this.runAfterCommit(callback);
      }
      return result;
    } catch (error) {
      this.#transactionDepth -= 1;
      this.#afterCommitCallbacks.pop();
      if (depth === 0) this.raw.exec("ROLLBACK");
      else {
        this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }

  private runAfterCommit(callback: () => void): void {
    try {
      callback();
    } catch {
      // A committed transaction cannot be rolled back because a subscriber
      // failed. Persistence remains the source of truth.
    }
  }

  close(): void {
    this.raw.close();
  }
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

function migrationChecksum(migration: Migration): string {
  return sha256Hex(`${migration.version}\0${migration.name}\0${migration.sql}`);
}
