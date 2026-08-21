import type { NarrativeDatabase } from "@narralume/persistence";

/**
 * Runs keep executing after their project is soft-deleted unless every step
 * re-validates the project. Each worker suite calls this before executing a
 * step so a deleted project turns the run into a permanent failure instead
 * of writing into recycled data.
 */
export function requireActiveProject(
  database: NarrativeDatabase,
  projectId: string,
): void {
  const row = database.raw
    .prepare("SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL")
    .get(projectId) as { id: string } | undefined;
  if (!row) {
    throw {
      code: "project.not_found",
      message: "Project not found or deleted",
      retryable: false,
    };
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Operation aborted",
  );
  error.name = "AbortError";
  throw error;
}

/**
 * Final write boundary for an async run step. Call this inside the synchronous
 * database transaction, after every awaited model or embedding operation.
 */
export function requireActiveRunCommit(
  database: NarrativeDatabase,
  runId: string,
  projectId: string,
  signal: AbortSignal,
): void {
  throwIfAborted(signal);
  requireActiveProject(database, projectId);
  const row = database.raw
    .prepare("SELECT status, cancel_requested FROM runs WHERE id = ?")
    .get(runId) as { status: string; cancel_requested: number } | undefined;
  if (!row || row.status !== "running" || row.cancel_requested === 1) {
    const error = new Error("Run is no longer writable");
    error.name = "AbortError";
    throw error;
  }
}
