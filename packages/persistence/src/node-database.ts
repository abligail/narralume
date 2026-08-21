import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MigrationError, NarrativeDatabase } from "./database.js";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Node 打开路径：node:sqlite 驱动 + 磁盘文件（或 :memory:）。 */
export class NodeNarrativeDatabase extends NarrativeDatabase {
  constructor(path = ":memory:") {
    const resolved = path === ":memory:" ? path : resolve(path);
    if (resolved !== ":memory:") {
      mkdirSync(dirname(resolved), { recursive: true });
    }
    super(resolved, openNodeDriver(resolved));
  }

  /**
   * Migration 020 removes the legacy profile tables and selection columns.
   * Create and integrity-check a consistent SQLite snapshot before that
   * irreversible step. In-memory/test databases intentionally skip it.
   */
  protected override backupBeforeRuntimeConvergence(): void {
    if (this.path === ":memory:") return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.path}.pre-b1-${timestamp}.sqlite`;
    this.raw.exec(`VACUUM INTO ${sqlString(backupPath)}`);
    const backup = new DatabaseSync(backupPath, {
      enableForeignKeyConstraints: true,
      readOnly: true,
    });
    try {
      const row = backup.prepare("PRAGMA integrity_check").get() as
        { integrity_check: string } | undefined;
      if (row?.integrity_check !== "ok") {
        throw new MigrationError(
          `Pre-B1 migration backup failed integrity check: ${backupPath}`,
        );
      }
    } finally {
      backup.close();
    }
  }
}

function openNodeDriver(path: string): DatabaseSync {
  const raw = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  raw.exec(
    "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;",
  );
  if (path !== ":memory:") {
    raw.exec("PRAGMA journal_mode = WAL;");
  }
  return raw;
}
