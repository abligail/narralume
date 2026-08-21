import { sha256Hex } from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";

export interface ReviewIssueInput {
  id: string;
  category: string;
  severity: "info" | "minor" | "major" | "critical";
  message: string;
  evidence: readonly {
    quote: string;
    start?: number;
    end?: number;
    documentVersionId?: string | null;
    contentHash?: string;
    paragraphOrdinal?: number;
  }[];
  suggestedDirection: string | null;
}

export interface ReviewReportInput {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  documentVersionId: string | null;
  verdict: "pass" | "revise" | "block";
  summary: string;
  scores: Readonly<Record<string, number>>;
  reviewedContent: string;
  reviewedContentHash: string;
  issues: readonly ReviewIssueInput[];
  createdAt: string;
}

export class SqliteReviewRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertReport(report: ReviewReportInput): void {
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT OR IGNORE INTO review_reports(
            id, project_id, run_id, step_id, document_version_id, verdict,
            summary, score_json, reviewed_content, reviewed_content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          report.id,
          report.projectId,
          report.runId,
          report.stepId,
          report.documentVersionId,
          report.verdict,
          report.summary,
          JSON.stringify(report.scores),
          report.reviewedContent,
          report.reviewedContentHash,
          report.createdAt,
        );
      const insertIssue = this.database.raw.prepare(
        `INSERT OR IGNORE INTO review_issues(
          id, report_id, category, severity, message, evidence_json,
          suggested_direction, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      );
      for (const issue of report.issues) {
        insertIssue.run(
          issue.id,
          report.id,
          issue.category,
          issue.severity,
          issue.message,
          JSON.stringify(issue.evidence),
          issue.suggestedDirection,
          report.createdAt,
        );
      }
    });
  }

  insertRevisionProposal(proposal: {
    id: string;
    projectId: string;
    runId: string;
    stepId: string;
    baseDocumentVersionId: string | null;
    revisedContent: string;
    diff: Readonly<Record<string, unknown>>;
    addressedIssueIds: readonly string[];
    status: "proposed" | "accepted" | "rejected" | "superseded";
    createdAt: string;
  }): void {
    this.database.raw
      .prepare(
        `INSERT OR IGNORE INTO revision_proposals(
          id, project_id, run_id, step_id, base_document_version_id,
          revised_content, diff_json, addressed_issue_ids_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.projectId,
        proposal.runId,
        proposal.stepId,
        proposal.baseDocumentVersionId,
        proposal.revisedContent,
        JSON.stringify(proposal.diff),
        JSON.stringify(proposal.addressedIssueIds),
        proposal.status,
        proposal.createdAt,
      );
  }

  /**
   * A review may run before its manuscript version exists. Once commit has
   * created (or reused) the immutable version, bind only reports whose source
   * hash matches that exact content.
   */
  bindRunReportsToDocumentVersion(
    runId: string,
    documentVersionId: string,
    contentHash: string,
  ): number {
    return this.database.transaction(() => {
      const reports = this.database.raw
        .prepare(
          `SELECT id FROM review_reports
           WHERE run_id = ? AND reviewed_content_hash = ?`,
        )
        .all(runId, contentHash) as unknown as Array<{ id: string }>;
      if (reports.length === 0) return 0;
      const updateReport = this.database.raw.prepare(
        "UPDATE review_reports SET document_version_id = ? WHERE id = ?",
      );
      const readIssues = this.database.raw.prepare(
        "SELECT id, evidence_json FROM review_issues WHERE report_id = ?",
      );
      const updateIssue = this.database.raw.prepare(
        "UPDATE review_issues SET evidence_json = ? WHERE id = ?",
      );
      for (const report of reports) {
        updateReport.run(documentVersionId, report.id);
        const rows = readIssues.all(report.id) as unknown as Array<{
          id: string;
          evidence_json: string;
        }>;
        for (const row of rows) {
          const evidence = JSON.parse(
            row.evidence_json,
          ) as ReviewIssueInput["evidence"];
          updateIssue.run(
            JSON.stringify(
              evidence.map((item) =>
                item.contentHash === contentHash
                  ? { ...item, documentVersionId }
                  : item,
              ),
            ),
            row.id,
          );
        }
      }
      return reports.length;
    });
  }

  insertCanonChangeSet(changeSet: {
    id: string;
    projectId: string;
    runId: string;
    stepId: string;
    changes: Readonly<Record<string, unknown>>;
    status: "candidate" | "partially_applied" | "applied" | "rejected";
    createdAt: string;
  }): void {
    this.database.raw
      .prepare(
        `INSERT OR IGNORE INTO canon_change_sets(
          id, project_id, run_id, step_id, changes_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        changeSet.id,
        changeSet.projectId,
        changeSet.runId,
        changeSet.stepId,
        JSON.stringify(changeSet.changes),
        changeSet.status,
        changeSet.createdAt,
      );
  }

  getCanonChangeSet(
    projectId: string,
    changeSetId: string,
  ): CanonChangeSetView | null {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM canon_change_sets WHERE project_id = ? AND id = ?",
      )
      .get(projectId, changeSetId) as CanonChangeSetRow | undefined;
    return row ? mapCanonChangeSet(row) : null;
  }

  requireCanonChangeSet(
    projectId: string,
    changeSetId: string,
  ): CanonChangeSetView {
    const changeSet = this.getCanonChangeSet(projectId, changeSetId);
    if (!changeSet) throw new CanonChangeSetNotFoundError(changeSetId);
    return changeSet;
  }

  listCanonChangeSets(projectId: string): CanonChangeSetView[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM canon_change_sets
         WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(projectId) as unknown as CanonChangeSetRow[];
    return rows.map(mapCanonChangeSet);
  }

  decideCanonChangeSet(input: {
    projectId: string;
    changeSetId: string;
    expectedStatus: CanonChangeSetStatus;
    status: Exclude<CanonChangeSetStatus, "candidate">;
    now: string;
  }): CanonChangeSetView {
    const changed = this.database.raw
      .prepare(
        `UPDATE canon_change_sets SET status = ?, decided_at = ?
         WHERE project_id = ? AND id = ? AND status = ?`,
      )
      .run(
        input.status,
        input.now,
        input.projectId,
        input.changeSetId,
        input.expectedStatus,
      );
    if (changed.changes !== 1) {
      const current = this.getCanonChangeSet(
        input.projectId,
        input.changeSetId,
      );
      if (!current) throw new CanonChangeSetNotFoundError(input.changeSetId);
      throw new CanonChangeSetDecisionConflictError(
        input.changeSetId,
        input.expectedStatus,
        current.status,
      );
    }
    return this.requireCanonChangeSet(input.projectId, input.changeSetId);
  }

  getCanonItemDecision(
    changeSetId: string,
    itemId: string,
  ): CanonChangeSetItemDecision | null {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM canon_change_set_item_decisions
         WHERE change_set_id = ? AND item_id = ?`,
      )
      .get(changeSetId, itemId) as CanonChangeSetItemDecisionRow | undefined;
    return row ? mapCanonItemDecision(row) : null;
  }

  listCanonItemDecisions(changeSetId: string): CanonChangeSetItemDecision[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM canon_change_set_item_decisions
         WHERE change_set_id = ? ORDER BY created_at, item_id`,
      )
      .all(changeSetId) as unknown as CanonChangeSetItemDecisionRow[];
    return rows.map(mapCanonItemDecision);
  }

  insertCanonItemDecision(
    decision: CanonChangeSetItemDecision,
  ): CanonChangeSetItemDecision {
    this.database.raw
      .prepare(
        `INSERT INTO canon_change_set_item_decisions(
          change_set_id, item_id, action, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        decision.changeSetId,
        decision.itemId,
        decision.action,
        decision.result === null ? null : JSON.stringify(decision.result),
        decision.createdAt,
      );
    return decision;
  }

  updateCanonChangeSetStatus(input: {
    projectId: string;
    changeSetId: string;
    status: CanonChangeSetStatus;
    decidedAt: string | null;
  }): CanonChangeSetView {
    const changed = this.database.raw
      .prepare(
        `UPDATE canon_change_sets SET status = ?, decided_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(input.status, input.decidedAt, input.projectId, input.changeSetId);
    if (changed.changes !== 1)
      throw new CanonChangeSetNotFoundError(input.changeSetId);
    return this.requireCanonChangeSet(input.projectId, input.changeSetId);
  }

  listReports(runId: string): ReviewReportView[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM review_reports WHERE run_id = ? ORDER BY created_at",
      )
      .all(runId) as unknown as ReviewReportRow[];
    const issues = this.database.raw.prepare(
      "SELECT * FROM review_issues WHERE report_id = ? ORDER BY created_at, id",
    );
    return rows.map((row) => ({
      id: row.id,
      stepId: row.step_id,
      verdict: row.verdict,
      summary: row.summary,
      scores: JSON.parse(row.score_json) as Record<string, number>,
      issues: (issues.all(row.id) as unknown as ReviewIssueRow[]).map(
        (issue) => ({
          id: issue.id,
          category: issue.category,
          severity: issue.severity,
          message: issue.message,
          evidence: JSON.parse(
            issue.evidence_json,
          ) as ReviewIssueInput["evidence"],
          suggestedDirection: issue.suggested_direction,
          status: issue.status,
        }),
      ),
      createdAt: row.created_at,
    }));
  }

  listProjectReports(projectId: string): ProjectReviewReportView[] {
    const rows = this.database.raw
      .prepare(
        `SELECT report.*, version.document_id, document.title AS document_title
         FROM review_reports report
         LEFT JOIN document_versions version ON version.id = report.document_version_id
         LEFT JOIN documents document ON document.id = version.document_id
         WHERE report.project_id = ?
         ORDER BY report.created_at DESC, report.id DESC`,
      )
      .all(projectId) as unknown as ProjectReviewReportRow[];
    const issues = this.database.raw.prepare(
      `SELECT issue.*, action.action, action.note, action.created_at AS decided_at
       FROM review_issues issue
       LEFT JOIN review_issue_actions action ON action.id = (
         SELECT latest.id FROM review_issue_actions latest
         WHERE latest.issue_id = issue.id
         ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
       )
       WHERE issue.report_id = ? ORDER BY issue.created_at, issue.id`,
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      stepId: row.step_id,
      documentVersionId: row.document_version_id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      verdict: row.verdict,
      summary: row.summary,
      scores: JSON.parse(row.score_json) as Record<string, number>,
      reviewedContent: row.reviewed_content,
      reviewedContentHash: row.reviewed_content_hash,
      issues: (issues.all(row.id) as unknown as ProjectReviewIssueRow[]).map(
        mapProjectIssue,
      ),
      createdAt: row.created_at,
    }));
  }

  listRevisionProposals(projectId: string): ReviewRevisionProposalView[] {
    const rows = this.database.raw
      .prepare(
        `SELECT proposal.*, version.content AS base_content, version.document_id
         FROM revision_proposals proposal
         LEFT JOIN document_versions version
           ON version.id = proposal.base_document_version_id
         WHERE proposal.project_id = ?
         ORDER BY proposal.created_at DESC, proposal.id DESC`,
      )
      .all(projectId) as unknown as RevisionProposalRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      documentId: row.document_id,
      baseDocumentVersionId: row.base_document_version_id,
      baseContent: row.base_content,
      revisedContent: row.revised_content,
      diff: JSON.parse(row.diff_json) as Record<string, unknown>,
      addressedIssueIds: JSON.parse(row.addressed_issue_ids_json) as string[],
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    }));
  }

  getRevisionProposal(
    projectId: string,
    proposalId: string,
  ): ReviewRevisionProposalDetail | null {
    const row = this.database.raw
      .prepare(
        `SELECT proposal.*, version.content AS base_content,
                version.document_id
         FROM revision_proposals proposal
         LEFT JOIN document_versions version
           ON version.id = proposal.base_document_version_id
         WHERE proposal.project_id = ? AND proposal.id = ?`,
      )
      .get(projectId, proposalId) as RevisionProposalDetailRow | undefined;
    return row
      ? {
          id: row.id,
          projectId: row.project_id,
          runId: row.run_id,
          stepId: row.step_id,
          documentId: row.document_id,
          baseDocumentVersionId: row.base_document_version_id,
          baseContent: row.base_content,
          revisedContent: row.revised_content,
          diff: JSON.parse(row.diff_json) as Record<string, unknown>,
          addressedIssueIds: JSON.parse(
            row.addressed_issue_ids_json,
          ) as string[],
          status: row.status,
          createdAt: row.created_at,
          decidedAt: row.decided_at,
        }
      : null;
  }

  decideRevisionProposal(input: {
    projectId: string;
    proposalId: string;
    expectedStatus: "proposed";
    status: "accepted" | "rejected" | "superseded";
    now: string;
  }): ReviewRevisionProposalDetail {
    const changed = this.database.raw
      .prepare(
        `UPDATE revision_proposals SET status = ?, decided_at = ?
         WHERE project_id = ? AND id = ? AND status = ?`,
      )
      .run(
        input.status,
        input.now,
        input.projectId,
        input.proposalId,
        input.expectedStatus,
      );
    if (changed.changes !== 1) {
      const current = this.getRevisionProposal(
        input.projectId,
        input.proposalId,
      );
      if (!current) throw new RevisionProposalNotFoundError(input.proposalId);
      throw new RevisionProposalDecisionConflictError(
        input.proposalId,
        input.expectedStatus,
        current.status,
      );
    }
    return this.getRevisionProposal(input.projectId, input.proposalId)!;
  }

  resolveProposalIssues(issueIds: readonly string[]): number {
    const uniqueIds = [...new Set(issueIds)];
    if (uniqueIds.length === 0) return 0;
    const placeholders = uniqueIds.map(() => "?").join(",");
    return Number(
      this.database.raw
        .prepare(
          `UPDATE review_issues SET status = 'resolved'
           WHERE id IN (${placeholders}) AND status IN ('open','accepted')`,
        )
        .run(...uniqueIds).changes,
    );
  }

  learnFromIssues(
    projectId: string,
    issueIds: readonly string[],
    now: string,
  ): ReviewLesson[] {
    const uniqueIds = [...new Set(issueIds)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.database.raw
      .prepare(
        `SELECT issue.id, issue.category, issue.message, issue.suggested_direction
         FROM review_issues issue
         JOIN review_reports report ON report.id = issue.report_id
         WHERE report.project_id = ? AND issue.id IN (${placeholders})`,
      )
      .all(projectId, ...uniqueIds) as unknown as Array<{
      id: string;
      category: string;
      message: string;
      suggested_direction: string | null;
    }>;
    const upsert = this.database.raw.prepare(
      `INSERT INTO review_lessons(
         id, project_id, category, pattern, guidance, confidence,
         occurrences, status, last_issue_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0.6, 1, 'active', ?, ?, ?)
       ON CONFLICT(project_id, category, pattern) DO UPDATE SET
         guidance = excluded.guidance,
         confidence = MIN(0.95, review_lessons.confidence + 0.08),
         occurrences = review_lessons.occurrences + 1,
         status = 'active',
         last_issue_id = excluded.last_issue_id,
         updated_at = excluded.updated_at`,
    );
    for (const row of rows) {
      const pattern = normalizeLessonPattern(row.message);
      const id = `lesson-${sha256Hex(`${projectId}\0${row.category}\0${pattern}`).slice(0, 24)}`;
      upsert.run(
        id,
        projectId,
        row.category,
        pattern,
        row.suggested_direction?.trim() || row.message,
        row.id,
        now,
        now,
      );
    }
    return this.listLessons(projectId);
  }

  listLessons(projectId: string, activeOnly = true): ReviewLesson[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM review_lessons WHERE project_id = ?
         ${activeOnly ? "AND status = 'active'" : ""}
         ORDER BY confidence DESC, occurrences DESC, updated_at DESC`,
      )
      .all(projectId) as unknown as ReviewLessonRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      category: row.category,
      pattern: row.pattern,
      guidance: row.guidance,
      confidence: row.confidence,
      occurrences: row.occurrences,
      status: row.status,
      lastIssueId: row.last_issue_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  acceptRunRevisionProposals(runId: string, decidedAt: string): number {
    return Number(
      this.database.raw
        .prepare(
          `UPDATE revision_proposals
           SET status = 'accepted', decided_at = ?
           WHERE run_id = ? AND status = 'proposed'`,
        )
        .run(decidedAt, runId).changes,
    );
  }

  supersedeRunRevisionProposals(runId: string, decidedAt: string): number {
    return Number(
      this.database.raw
        .prepare(
          `UPDATE revision_proposals
           SET status = 'superseded', decided_at = ?
           WHERE run_id = ? AND status = 'proposed'`,
        )
        .run(decidedAt, runId).changes,
    );
  }

  decideIssue(input: {
    id: string;
    projectId: string;
    issueId: string;
    action: ReviewIssueDecisionAction;
    note: string | null;
    expectedStatus: ReviewIssueStatus;
    now: string;
  }): ReviewIssueDecision {
    return this.database.transaction(() => {
      const row = this.database.raw
        .prepare(
          `SELECT issue.status FROM review_issues issue
           JOIN review_reports report ON report.id = issue.report_id
           WHERE report.project_id = ? AND issue.id = ?`,
        )
        .get(input.projectId, input.issueId) as
        { status: ReviewIssueStatus } | undefined;
      if (!row) throw new ReviewIssueNotFoundError(input.issueId);
      if (row.status !== input.expectedStatus)
        throw new ReviewIssueDecisionConflictError(
          input.issueId,
          input.expectedStatus,
          row.status,
        );
      const resultingStatus = resultingIssueStatus(input.action);
      const updated = this.database.raw
        .prepare(
          "UPDATE review_issues SET status = ? WHERE id = ? AND status = ?",
        )
        .run(resultingStatus, input.issueId, input.expectedStatus);
      if (updated.changes !== 1)
        throw new ReviewIssueDecisionConflictError(
          input.issueId,
          input.expectedStatus,
          row.status,
        );
      this.database.raw
        .prepare(
          `INSERT INTO review_issue_actions(
             id, issue_id, action, note, prior_status, resulting_status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.issueId,
          input.action,
          input.note,
          input.expectedStatus,
          resultingStatus,
          input.now,
        );
      return {
        id: input.id,
        issueId: input.issueId,
        action: input.action,
        note: input.note,
        priorStatus: input.expectedStatus,
        resultingStatus,
        createdAt: input.now,
      };
    });
  }

  getLatestIssueDecision(
    projectId: string,
    issueId: string,
  ): ReviewIssueDecision | null {
    const row = this.database.raw
      .prepare(
        `SELECT action.* FROM review_issue_actions action
         JOIN review_issues issue ON issue.id = action.issue_id
         JOIN review_reports report ON report.id = issue.report_id
         WHERE report.project_id = ? AND issue.id = ?
         ORDER BY action.created_at DESC, action.rowid DESC LIMIT 1`,
      )
      .get(projectId, issueId) as ReviewIssueDecisionRow | undefined;
    return row
      ? {
          id: row.id,
          issueId: row.issue_id,
          action: row.action,
          note: row.note,
          priorStatus: row.prior_status,
          resultingStatus: row.resulting_status,
          createdAt: row.created_at,
        }
      : null;
  }
}

export interface ReviewReportView {
  id: string;
  stepId: string;
  verdict: ReviewReportInput["verdict"];
  summary: string;
  scores: Record<string, number>;
  issues: (ReviewIssueInput & { status: string })[];
  createdAt: string;
}

export type ReviewIssueStatus = "open" | "accepted" | "rejected" | "resolved";
export type ReviewIssueDecisionAction =
  "accept" | "reject" | "false_positive" | "intentional_keep";

export interface ReviewIssueDecision {
  id: string;
  issueId: string;
  action: ReviewIssueDecisionAction;
  note: string | null;
  priorStatus: ReviewIssueStatus;
  resultingStatus: ReviewIssueStatus;
  createdAt: string;
}

export interface ProjectReviewIssueView extends ReviewIssueInput {
  status: ReviewIssueStatus;
  decision: {
    action: ReviewIssueDecisionAction;
    note: string | null;
    decidedAt: string;
  } | null;
}

export interface ProjectReviewReportView {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  documentVersionId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  verdict: ReviewReportInput["verdict"];
  summary: string;
  scores: Record<string, number>;
  reviewedContent: string | null;
  reviewedContentHash: string | null;
  issues: ProjectReviewIssueView[];
  createdAt: string;
}

export interface ReviewRevisionProposalView {
  id: string;
  runId: string;
  stepId: string;
  documentId: string | null;
  baseDocumentVersionId: string | null;
  baseContent: string | null;
  revisedContent: string;
  diff: Record<string, unknown>;
  addressedIssueIds: string[];
  status: "proposed" | "accepted" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
}

export interface ReviewRevisionProposalDetail extends ReviewRevisionProposalView {
  projectId: string;
}

export type CanonChangeSetStatus =
  "candidate" | "partially_applied" | "applied" | "rejected";

export interface CanonChangeSetView {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  changes: Record<string, unknown>;
  status: CanonChangeSetStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface CanonChangeSetItemDecision {
  changeSetId: string;
  itemId: string;
  action: "apply" | "reject";
  result: Record<string, unknown> | null;
  createdAt: string;
}

export interface ReviewLesson {
  id: string;
  projectId: string;
  category: string;
  pattern: string;
  guidance: string;
  confidence: number;
  occurrences: number;
  status: "active" | "retired";
  lastIssueId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReviewReportRow {
  id: string;
  step_id: string;
  verdict: ReviewReportInput["verdict"];
  summary: string;
  score_json: string;
  project_id: string;
  run_id: string;
  document_version_id: string | null;
  reviewed_content: string | null;
  reviewed_content_hash: string | null;
  created_at: string;
}

interface ReviewIssueRow {
  id: string;
  category: string;
  severity: ReviewIssueInput["severity"];
  message: string;
  evidence_json: string;
  suggested_direction: string | null;
  status: string;
}

interface ProjectReviewReportRow extends ReviewReportRow {
  document_id: string | null;
  document_title: string | null;
}

interface ProjectReviewIssueRow extends ReviewIssueRow {
  action: ReviewIssueDecisionAction | null;
  note: string | null;
  decided_at: string | null;
}

interface ReviewIssueDecisionRow {
  id: string;
  issue_id: string;
  action: ReviewIssueDecisionAction;
  note: string | null;
  prior_status: ReviewIssueStatus;
  resulting_status: ReviewIssueStatus;
  created_at: string;
}

interface RevisionProposalRow {
  id: string;
  run_id: string;
  step_id: string;
  document_id: string | null;
  base_document_version_id: string | null;
  base_content: string | null;
  revised_content: string;
  diff_json: string;
  addressed_issue_ids_json: string;
  status: ReviewRevisionProposalView["status"];
  created_at: string;
  decided_at: string | null;
}

interface RevisionProposalDetailRow extends RevisionProposalRow {
  project_id: string;
  document_id: string | null;
}

interface CanonChangeSetRow {
  id: string;
  project_id: string;
  run_id: string;
  step_id: string;
  changes_json: string;
  status: CanonChangeSetStatus;
  created_at: string;
  decided_at: string | null;
}

interface CanonChangeSetItemDecisionRow {
  change_set_id: string;
  item_id: string;
  action: "apply" | "reject";
  result_json: string | null;
  created_at: string;
}

interface ReviewLessonRow {
  id: string;
  project_id: string;
  category: string;
  pattern: string;
  guidance: string;
  confidence: number;
  occurrences: number;
  status: ReviewLesson["status"];
  last_issue_id: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeLessonPattern(message: string): string {
  return message
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function mapCanonChangeSet(row: CanonChangeSetRow): CanonChangeSetView {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    stepId: row.step_id,
    changes: JSON.parse(row.changes_json) as Record<string, unknown>,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function mapCanonItemDecision(
  row: CanonChangeSetItemDecisionRow,
): CanonChangeSetItemDecision {
  return {
    changeSetId: row.change_set_id,
    itemId: row.item_id,
    action: row.action,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : null,
    createdAt: row.created_at,
  };
}

function mapProjectIssue(row: ProjectReviewIssueRow): ProjectReviewIssueView {
  return {
    id: row.id,
    category: row.category,
    severity: row.severity,
    message: row.message,
    evidence: JSON.parse(row.evidence_json) as ReviewIssueInput["evidence"],
    suggestedDirection: row.suggested_direction,
    status: row.status as ReviewIssueStatus,
    decision:
      row.action && row.decided_at
        ? { action: row.action, note: row.note, decidedAt: row.decided_at }
        : null,
  };
}

function resultingIssueStatus(
  action: ReviewIssueDecisionAction,
): ReviewIssueStatus {
  if (action === "accept") return "accepted";
  if (action === "intentional_keep") return "resolved";
  return "rejected";
}

export class ReviewIssueNotFoundError extends Error {
  constructor(readonly issueId: string) {
    super(`Review issue not found: ${issueId}`);
    this.name = "ReviewIssueNotFoundError";
  }
}

export class ReviewIssueDecisionConflictError extends Error {
  constructor(
    readonly issueId: string,
    readonly expected: ReviewIssueStatus,
    readonly actual: ReviewIssueStatus,
  ) {
    super(
      `Review issue status changed: expected ${expected}, actual ${actual}`,
    );
    this.name = "ReviewIssueDecisionConflictError";
  }
}

export class CanonChangeSetNotFoundError extends Error {
  constructor(readonly changeSetId: string) {
    super(`Canon change set not found: ${changeSetId}`);
    this.name = "CanonChangeSetNotFoundError";
  }
}

export class CanonChangeSetDecisionConflictError extends Error {
  constructor(
    readonly changeSetId: string,
    readonly expected: CanonChangeSetStatus,
    readonly actual: CanonChangeSetStatus,
  ) {
    super(
      `Canon change set status changed: expected ${expected}, actual ${actual}`,
    );
    this.name = "CanonChangeSetDecisionConflictError";
  }
}

export class RevisionProposalNotFoundError extends Error {
  constructor(readonly proposalId: string) {
    super(`Revision proposal not found: ${proposalId}`);
    this.name = "RevisionProposalNotFoundError";
  }
}

export class RevisionProposalDecisionConflictError extends Error {
  constructor(
    readonly proposalId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Revision proposal status changed: expected ${expected}, actual ${actual}`,
    );
    this.name = "RevisionProposalDecisionConflictError";
  }
}
