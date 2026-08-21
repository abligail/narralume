import type {
  Foreshadow,
  KnowledgeRecord,
  NarrativeSummary,
  RelationshipEvent,
  TimelineEvent,
} from "@narralume/domain";

import type { SqliteCanonRepository } from "./canon-repository.js";
import type { NarrativeDatabase } from "./database.js";
import type { SqliteStoryRepository } from "./story-repository.js";
import { totalReferenceCount } from "./reference-inspector.js";

export class SqliteNarrativeStateRepository {
  constructor(
    private readonly database: NarrativeDatabase,
    private readonly canon: SqliteCanonRepository,
    private readonly story: SqliteStoryRepository,
  ) {}

  insertRelationship(event: RelationshipEvent): RelationshipEvent {
    this.canon.requireEntity(event.projectId, event.fromEntityId);
    this.canon.requireEntity(event.projectId, event.toEntityId);
    if (event.outlineNodeId)
      this.story.requireOutlineNode(event.projectId, event.outlineNodeId);
    if (event.supersedesEventId) {
      const previous = this.getRelationship(
        event.projectId,
        event.supersedesEventId,
      );
      if (!previous) {
        throw new NarrativeStateError(
          "relationship.supersedes.not_found",
          `The superseded relationship event ${event.supersedesEventId} does not exist`,
        );
      }
      if (
        previous.fromEntityId !== event.fromEntityId ||
        previous.toEntityId !== event.toEntityId
      ) {
        throw new NarrativeStateError(
          "relationship.supersedes.pair_mismatch",
          "A relationship update must not change either party",
        );
      }
    }
    this.database.raw
      .prepare(
        `
        INSERT INTO relationship_events(
          id, project_id, from_entity_id, to_entity_id, relation, intensity, state_json,
          outline_node_id, story_time, source_id, supersedes_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        event.id,
        event.projectId,
        event.fromEntityId,
        event.toEntityId,
        event.relation,
        event.intensity,
        JSON.stringify(event.state),
        event.outlineNodeId,
        event.storyTime,
        event.sourceId,
        event.supersedesEventId,
        event.createdAt,
      );
    return event;
  }

  getRelationship(projectId: string, id: string): RelationshipEvent | null {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM relationship_events WHERE project_id = ? AND id = ?",
      )
      .get(projectId, id) as RelationshipRow | undefined;
    return row ? mapRelationship(row) : null;
  }

  listCurrentRelationships(projectId: string): RelationshipEvent[] {
    const rows = this.database.raw
      .prepare(
        `
        SELECT event.*
        FROM relationship_events event
        WHERE event.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM relationship_events newer
            WHERE newer.project_id = event.project_id
              AND newer.supersedes_event_id = event.id
          )
        ORDER BY event.from_entity_id, event.to_entity_id, event.created_at DESC
      `,
      )
      .all(projectId) as unknown as RelationshipRow[];
    return rows
      .map(mapRelationship)
      .filter((event) => event.state.lifecycle !== "voided");
  }

  removeRelationship(
    projectId: string,
    id: string,
    voidEvent: RelationshipEvent,
  ): { disposition: "deleted" | "voided"; references: number } {
    const current = this.getRelationship(projectId, id);
    if (!current)
      throw new NarrativeStateError(
        "relationship.not_found",
        `Relationship event ${id} does not exist`,
      );
    const references = totalReferenceCount(
      this.database,
      "relationship_events",
      id,
    );
    const hasHistoryOrSource = Boolean(
      references ||
      current.supersedesEventId ||
      current.sourceId ||
      current.outlineNodeId,
    );
    if (hasHistoryOrSource) {
      this.insertRelationship(voidEvent);
      return { disposition: "voided", references };
    }
    this.database.raw
      .prepare(
        "DELETE FROM relationship_events WHERE project_id = ? AND id = ?",
      )
      .run(projectId, id);
    return { disposition: "deleted", references: 0 };
  }

  listRelationshipHistory(projectId: string): RelationshipEvent[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM relationship_events
         WHERE project_id = ?
         ORDER BY created_at, id`,
      )
      .all(projectId) as unknown as RelationshipRow[];
    return rows.map(mapRelationship);
  }

  insertTimelineEvent(event: TimelineEvent): TimelineEvent {
    if (event.outlineNodeId)
      this.story.requireOutlineNode(event.projectId, event.outlineNodeId);
    for (const entityId of event.participants)
      this.canon.requireEntity(event.projectId, entityId);
    return this.database.transaction(() => {
      this.database.raw
        .prepare(
          `
          INSERT INTO timeline_events(
            id, project_id, title, description, outline_node_id, story_time_start,
            story_time_end, sequence, visibility, source_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          event.id,
          event.projectId,
          event.title,
          event.description,
          event.outlineNodeId,
          event.storyTimeStart,
          event.storyTimeEnd,
          event.sequence,
          event.visibility,
          event.sourceId,
          event.createdAt,
          event.updatedAt,
        );
      const participant = this.database.raw.prepare(
        "INSERT INTO timeline_participants(event_id, entity_id) VALUES (?, ?)",
      );
      for (const entityId of new Set(event.participants))
        participant.run(event.id, entityId);
      const causal = this.database.raw.prepare(
        "INSERT INTO causal_links(cause_event_id, effect_event_id) VALUES (?, ?)",
      );
      for (const causeId of new Set(event.causes)) {
        if (causeId === event.id)
          throw new NarrativeStateError(
            "timeline.cause.cycle",
            "Timeline events must not form a causal cycle",
          );
        const cause = this.database.raw
          .prepare(
            "SELECT id FROM timeline_events WHERE project_id = ? AND id = ? AND voided_at IS NULL",
          )
          .get(event.projectId, causeId);
        if (!cause)
          throw new NarrativeStateError(
            "timeline.cause.not_found",
            `Causal antecedent ${causeId} does not exist`,
          );
        causal.run(causeId, event.id);
      }
      this.recordRevision(
        event.projectId,
        "timeline",
        event.id,
        "create",
        null,
        event,
        event.createdAt,
      );
      return event;
    });
  }

  listTimeline(projectId: string): TimelineEvent[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM timeline_events WHERE project_id = ? AND voided_at IS NULL ORDER BY sequence, created_at",
      )
      .all(projectId) as unknown as TimelineRow[];
    const participants = this.database.raw.prepare(
      "SELECT entity_id FROM timeline_participants WHERE event_id = ? ORDER BY entity_id",
    );
    const causes = this.database.raw.prepare(
      `SELECT links.cause_event_id
       FROM causal_links links
       JOIN timeline_events cause
         ON cause.project_id = ? AND cause.id = links.cause_event_id
          AND cause.voided_at IS NULL
       WHERE links.effect_event_id = ?
       ORDER BY links.cause_event_id`,
    );
    return rows.map((row) => ({
      ...mapTimeline(row),
      participants: (
        participants.all(row.id) as unknown as { entity_id: string }[]
      ).map((entry) => entry.entity_id),
      causes: (
        causes.all(projectId, row.id) as unknown as {
          cause_event_id: string;
        }[]
      ).map((entry) => entry.cause_event_id),
    }));
  }

  removeTimelineEvent(
    projectId: string,
    id: string,
    now: string,
  ): { disposition: "deleted" | "voided"; references: number } {
    const current = this.listTimeline(projectId).find(
      (event) => event.id === id,
    );
    if (!current)
      throw new NarrativeStateError(
        "timeline.not_found",
        `Timeline event ${id} does not exist`,
      );
    const references = totalReferenceCount(
      this.database,
      "timeline_events",
      id,
      new Set([
        "timeline_participants.event_id",
        "causal_links.effect_event_id",
      ]),
    );
    if (references || current.sourceId) {
      this.database.raw
        .prepare(
          `UPDATE timeline_events SET voided_at = ?, updated_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(now, now, projectId, id);
      return { disposition: "voided", references };
    }
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          "DELETE FROM narrative_state_revisions WHERE project_id = ? AND entity_type = 'timeline' AND entity_id = ?",
        )
        .run(projectId, id);
      this.database.raw
        .prepare("DELETE FROM timeline_events WHERE project_id = ? AND id = ?")
        .run(projectId, id);
    });
    return { disposition: "deleted", references: 0 };
  }

  updateTimelineEvent(event: TimelineEvent): TimelineEvent {
    if (event.outlineNodeId)
      this.story.requireOutlineNode(event.projectId, event.outlineNodeId);
    for (const entityId of event.participants)
      this.canon.requireEntity(event.projectId, entityId);
    return this.database.transaction(() => {
      const before = this.listTimeline(event.projectId).find(
        (candidate) => candidate.id === event.id,
      );
      if (!before)
        throw new NarrativeStateError(
          "timeline.not_found",
          `Timeline event ${event.id} does not exist`,
        );
      for (const causeId of new Set(event.causes)) {
        if (
          causeId === event.id ||
          this.timelinePathExists(event.projectId, event.id, causeId)
        )
          throw new NarrativeStateError(
            "timeline.cause.cycle",
            `Causal edge ${causeId} -> ${event.id} would form a cycle`,
          );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE timeline_events SET title = ?, description = ?, outline_node_id = ?,
             story_time_start = ?, story_time_end = ?, sequence = ?, visibility = ?,
             source_id = ?, updated_at = ? WHERE project_id = ? AND id = ?`,
        )
        .run(
          event.title,
          event.description,
          event.outlineNodeId,
          event.storyTimeStart,
          event.storyTimeEnd,
          event.sequence,
          event.visibility,
          event.sourceId,
          event.updatedAt,
          event.projectId,
          event.id,
        );
      if (result.changes !== 1)
        throw new NarrativeStateError(
          "timeline.not_found",
          `Timeline event ${event.id} does not exist`,
        );
      this.database.raw
        .prepare("DELETE FROM timeline_participants WHERE event_id = ?")
        .run(event.id);
      this.database.raw
        .prepare("DELETE FROM causal_links WHERE effect_event_id = ?")
        .run(event.id);
      const participant = this.database.raw.prepare(
        "INSERT INTO timeline_participants(event_id, entity_id) VALUES (?, ?)",
      );
      for (const entityId of new Set(event.participants))
        participant.run(event.id, entityId);
      const causal = this.database.raw.prepare(
        "INSERT INTO causal_links(cause_event_id, effect_event_id) VALUES (?, ?)",
      );
      for (const causeId of new Set(event.causes)) {
        if (causeId === event.id)
          throw new NarrativeStateError(
            "timeline.cause.self",
            "A timeline event cannot cause itself",
          );
        this.requireTimelineEvent(event.projectId, causeId);
        causal.run(causeId, event.id);
      }
      this.recordRevision(
        event.projectId,
        "timeline",
        event.id,
        "update",
        before,
        event,
        new Date().toISOString(),
      );
      return event;
    });
  }

  insertForeshadow(foreshadow: Foreshadow): Foreshadow {
    for (const nodeId of [
      foreshadow.targetFromNodeId,
      foreshadow.targetToNodeId,
      foreshadow.resolutionNodeId,
      ...foreshadow.evidenceNodeIds,
    ]) {
      if (nodeId) this.story.requireOutlineNode(foreshadow.projectId, nodeId);
    }
    return this.database.transaction(() => {
      this.database.raw
        .prepare(
          `
          INSERT INTO foreshadows(
            id, project_id, title, description, status, importance, target_from_node_id,
            target_to_node_id, resolution_node_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          foreshadow.id,
          foreshadow.projectId,
          foreshadow.title,
          foreshadow.description,
          foreshadow.status,
          foreshadow.importance,
          foreshadow.targetFromNodeId,
          foreshadow.targetToNodeId,
          foreshadow.resolutionNodeId,
          foreshadow.createdAt,
          foreshadow.updatedAt,
        );
      const dependency = this.database.raw.prepare(
        "INSERT INTO foreshadow_dependencies(foreshadow_id, depends_on_id) VALUES (?, ?)",
      );
      for (const dependencyId of new Set(foreshadow.dependencies)) {
        this.requireForeshadow(foreshadow.projectId, dependencyId);
        if (dependencyId === foreshadow.id) {
          throw new NarrativeStateError(
            "foreshadow.cycle",
            "A foreshadow cannot depend on itself",
          );
        }
        dependency.run(foreshadow.id, dependencyId);
      }
      const evidence = this.database.raw.prepare(`
        INSERT INTO foreshadow_evidence(foreshadow_id, outline_node_id, created_at)
        VALUES (?, ?, ?)
      `);
      for (const nodeId of new Set(foreshadow.evidenceNodeIds)) {
        evidence.run(foreshadow.id, nodeId, foreshadow.updatedAt);
      }
      this.recordRevision(
        foreshadow.projectId,
        "foreshadow",
        foreshadow.id,
        "create",
        null,
        foreshadow,
        foreshadow.createdAt,
      );
      return foreshadow;
    });
  }

  listForeshadows(projectId: string): Foreshadow[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM foreshadows WHERE project_id = ? ORDER BY importance DESC, updated_at DESC",
      )
      .all(projectId) as unknown as ForeshadowRow[];
    const dependency = this.database.raw.prepare(
      "SELECT depends_on_id FROM foreshadow_dependencies WHERE foreshadow_id = ? ORDER BY depends_on_id",
    );
    const evidence = this.database.raw.prepare(
      "SELECT outline_node_id FROM foreshadow_evidence WHERE foreshadow_id = ? ORDER BY created_at",
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      importance: row.importance,
      targetFromNodeId: row.target_from_node_id,
      targetToNodeId: row.target_to_node_id,
      dependencies: (
        dependency.all(row.id) as unknown as { depends_on_id: string }[]
      ).map((entry) => entry.depends_on_id),
      evidenceNodeIds: (
        evidence.all(row.id) as unknown as { outline_node_id: string }[]
      ).map((entry) => entry.outline_node_id),
      resolutionNodeId: row.resolution_node_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateForeshadow(foreshadow: Foreshadow): Foreshadow {
    for (const nodeId of [
      foreshadow.targetFromNodeId,
      foreshadow.targetToNodeId,
      foreshadow.resolutionNodeId,
      ...foreshadow.evidenceNodeIds,
    ]) {
      if (nodeId) this.story.requireOutlineNode(foreshadow.projectId, nodeId);
    }
    return this.database.transaction(() => {
      const before = this.listForeshadows(foreshadow.projectId).find(
        (candidate) => candidate.id === foreshadow.id,
      );
      if (!before)
        throw new NarrativeStateError(
          "foreshadow.not_found",
          `Foreshadow ${foreshadow.id} does not exist`,
        );
      for (const dependencyId of new Set(foreshadow.dependencies)) {
        if (
          dependencyId === foreshadow.id ||
          this.foreshadowPathExists(
            foreshadow.projectId,
            dependencyId,
            foreshadow.id,
          )
        )
          throw new NarrativeStateError(
            "foreshadow.cycle",
            `Foreshadow dependency ${foreshadow.id} -> ${dependencyId} would form a cycle`,
          );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE foreshadows SET title = ?, description = ?, status = ?, importance = ?,
             target_from_node_id = ?, target_to_node_id = ?, resolution_node_id = ?,
             updated_at = ? WHERE project_id = ? AND id = ?`,
        )
        .run(
          foreshadow.title,
          foreshadow.description,
          foreshadow.status,
          foreshadow.importance,
          foreshadow.targetFromNodeId,
          foreshadow.targetToNodeId,
          foreshadow.resolutionNodeId,
          foreshadow.updatedAt,
          foreshadow.projectId,
          foreshadow.id,
        );
      if (result.changes !== 1)
        throw new NarrativeStateError(
          "foreshadow.not_found",
          `Foreshadow ${foreshadow.id} does not exist`,
        );
      this.database.raw
        .prepare("DELETE FROM foreshadow_dependencies WHERE foreshadow_id = ?")
        .run(foreshadow.id);
      this.database.raw
        .prepare("DELETE FROM foreshadow_evidence WHERE foreshadow_id = ?")
        .run(foreshadow.id);
      const dependency = this.database.raw.prepare(
        "INSERT INTO foreshadow_dependencies(foreshadow_id, depends_on_id) VALUES (?, ?)",
      );
      for (const dependencyId of new Set(foreshadow.dependencies)) {
        this.requireForeshadow(foreshadow.projectId, dependencyId);
        if (dependencyId === foreshadow.id)
          throw new NarrativeStateError(
            "foreshadow.cycle",
            "A foreshadow cannot depend on itself",
          );
        dependency.run(foreshadow.id, dependencyId);
      }
      const evidence = this.database.raw.prepare(
        `INSERT INTO foreshadow_evidence(foreshadow_id, outline_node_id, created_at)
         VALUES (?, ?, ?)`,
      );
      for (const nodeId of new Set(foreshadow.evidenceNodeIds))
        evidence.run(foreshadow.id, nodeId, foreshadow.updatedAt);
      this.recordRevision(
        foreshadow.projectId,
        "foreshadow",
        foreshadow.id,
        "update",
        before,
        foreshadow,
        foreshadow.updatedAt,
      );
      return foreshadow;
    });
  }

  removeForeshadow(
    projectId: string,
    id: string,
    now: string,
  ): { disposition: "deleted" | "abandoned"; references: number } {
    const current = this.listForeshadows(projectId).find(
      (item) => item.id === id,
    );
    if (!current)
      throw new NarrativeStateError(
        "foreshadow.not_found",
        `Foreshadow ${id} does not exist`,
      );
    const references = totalReferenceCount(
      this.database,
      "foreshadows",
      id,
      new Set([
        "foreshadow_dependencies.foreshadow_id",
        "foreshadow_evidence.foreshadow_id",
      ]),
    );
    const hasStoryEvidence =
      current.status !== "planned" ||
      current.evidenceNodeIds.length > 0 ||
      current.resolutionNodeId !== null;
    if (references || hasStoryEvidence) {
      if (current.status !== "abandoned")
        this.updateForeshadow({
          ...current,
          status: "abandoned",
          updatedAt: now,
        });
      return { disposition: "abandoned", references };
    }
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          "DELETE FROM narrative_state_revisions WHERE project_id = ? AND entity_type = 'foreshadow' AND entity_id = ?",
        )
        .run(projectId, id);
      this.database.raw
        .prepare("DELETE FROM foreshadows WHERE project_id = ? AND id = ?")
        .run(projectId, id);
    });
    return { disposition: "deleted", references: 0 };
  }

  insertKnowledge(record: KnowledgeRecord): KnowledgeRecord {
    if (record.knowerEntityId)
      this.canon.requireEntity(record.projectId, record.knowerEntityId);
    this.story.requireOutlineNode(record.projectId, record.learnedAtNodeId);
    if (record.factId) this.canon.requireFact(record.projectId, record.factId);
    if (record.timelineEventId)
      this.requireTimelineEvent(record.projectId, record.timelineEventId);
    this.database.raw
      .prepare(
        `
        INSERT INTO knowledge_records(
          id, project_id, knower_type, knower_entity_id, fact_id, timeline_event_id,
          learned_at_node_id, belief, source_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.projectId,
        record.knowerType,
        record.knowerEntityId,
        record.factId,
        record.timelineEventId,
        record.learnedAtNodeId,
        record.belief,
        record.sourceId,
        record.createdAt,
      );
    return record;
  }

  listKnowledge(projectId: string): KnowledgeRecord[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM knowledge_records WHERE project_id = ? ORDER BY created_at, id",
      )
      .all(projectId) as unknown as KnowledgeRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      knowerType: row.knower_type,
      knowerEntityId: row.knower_entity_id,
      factId: row.fact_id,
      timelineEventId: row.timeline_event_id,
      learnedAtNodeId: row.learned_at_node_id,
      belief: row.belief,
      sourceId: row.source_id,
      createdAt: row.created_at,
    }));
  }

  upsertSummary(summary: NarrativeSummary): NarrativeSummary {
    this.database.raw
      .prepare(
        `
        INSERT INTO narrative_summaries(
          id, project_id, scope_type, scope_id, summary, state_delta_json, source_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, scope_type, scope_id, source_hash) DO UPDATE SET
          summary = excluded.summary,
          state_delta_json = excluded.state_delta_json,
          created_at = excluded.created_at
      `,
      )
      .run(
        summary.id,
        summary.projectId,
        summary.scopeType,
        summary.scopeId,
        summary.summary,
        JSON.stringify(summary.stateDelta),
        summary.sourceHash,
        summary.createdAt,
      );
    return summary;
  }

  latestSummary(
    projectId: string,
    scopeType: NarrativeSummary["scopeType"],
    scopeId: string,
  ): NarrativeSummary | null {
    const row = this.database.raw
      .prepare(
        `
        SELECT * FROM narrative_summaries
        WHERE project_id = ? AND scope_type = ? AND scope_id = ?
        ORDER BY created_at DESC LIMIT 1
      `,
      )
      .get(projectId, scopeType, scopeId) as SummaryRow | undefined;
    return row
      ? {
          id: row.id,
          projectId: row.project_id,
          scopeType: row.scope_type,
          scopeId: row.scope_id,
          summary: row.summary,
          stateDelta: parseObject(row.state_delta_json),
          sourceHash: row.source_hash,
          createdAt: row.created_at,
        }
      : null;
  }

  listLatestSummaries(
    projectId: string,
    scopeType?: NarrativeSummary["scopeType"],
  ): NarrativeSummary[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM (
           SELECT summary.*,
             ROW_NUMBER() OVER (
               PARTITION BY scope_type, scope_id
               ORDER BY created_at DESC, summary.rowid DESC
             ) AS rank
           FROM narrative_summaries summary
           WHERE project_id = ? AND (? IS NULL OR scope_type = ?)
         ) WHERE rank = 1 ORDER BY created_at, scope_id`,
      )
      .all(projectId, scopeType ?? null, scopeType ?? null) as unknown as Array<
      SummaryRow & { rank: number }
    >;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      summary: row.summary,
      stateDelta: parseObject(row.state_delta_json),
      sourceHash: row.source_hash,
      createdAt: row.created_at,
    }));
  }

  listRevisions(
    projectId: string,
    entityType: "timeline" | "foreshadow",
    entityId: string,
  ): NarrativeStateRevision[] {
    const rows = this.database.raw
      .prepare(
        `SELECT id, project_id, entity_type, entity_id, operation,
                before_json, after_json, created_at
         FROM narrative_state_revisions
         WHERE project_id = ? AND entity_type = ? AND entity_id = ?
         ORDER BY id`,
      )
      .all(projectId, entityType, entityId) as unknown as RevisionRow[];
    return rows.map(mapRevision);
  }

  private timelinePathExists(
    projectId: string,
    fromEventId: string,
    toEventId: string,
  ): boolean {
    return Boolean(
      this.database.raw
        .prepare(
          `WITH RECURSIVE reachable(id) AS (
             SELECT links.effect_event_id
             FROM causal_links links
             JOIN timeline_events source
               ON source.id = links.cause_event_id
              AND source.project_id = ?
              AND source.voided_at IS NULL
             WHERE links.cause_event_id = ?
             UNION
             SELECT links.effect_event_id
             FROM causal_links links
             JOIN reachable ON links.cause_event_id = reachable.id
             JOIN timeline_events source
               ON source.id = links.cause_event_id
              AND source.voided_at IS NULL
           )
           SELECT 1 AS found
           FROM reachable
           JOIN timeline_events event
             ON event.id = reachable.id
            AND event.voided_at IS NULL
           WHERE reachable.id = ? AND event.project_id = ?
           LIMIT 1`,
        )
        .get(projectId, fromEventId, toEventId, projectId),
    );
  }

  private foreshadowPathExists(
    projectId: string,
    fromForeshadowId: string,
    toForeshadowId: string,
  ): boolean {
    return Boolean(
      this.database.raw
        .prepare(
          `WITH RECURSIVE reachable(id) AS (
             SELECT dependencies.depends_on_id
             FROM foreshadow_dependencies dependencies
             JOIN foreshadows source ON source.id = dependencies.foreshadow_id
             WHERE dependencies.foreshadow_id = ? AND source.project_id = ?
             UNION
             SELECT dependencies.depends_on_id
             FROM foreshadow_dependencies dependencies
             JOIN reachable ON dependencies.foreshadow_id = reachable.id
           )
           SELECT 1 AS found
           FROM reachable
           JOIN foreshadows item ON item.id = reachable.id
           WHERE reachable.id = ? AND item.project_id = ?
           LIMIT 1`,
        )
        .get(fromForeshadowId, projectId, toForeshadowId, projectId),
    );
  }

  private recordRevision(
    projectId: string,
    entityType: "timeline" | "foreshadow",
    entityId: string,
    operation: "create" | "update",
    before: TimelineEvent | Foreshadow | null,
    after: TimelineEvent | Foreshadow,
    createdAt: string,
  ): void {
    this.database.raw
      .prepare(
        `INSERT INTO narrative_state_revisions(
           project_id, entity_type, entity_id, operation,
           before_json, after_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        entityType,
        entityId,
        operation,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        createdAt,
      );
  }

  private requireForeshadow(projectId: string, id: string): void {
    const found = this.database.raw
      .prepare("SELECT id FROM foreshadows WHERE project_id = ? AND id = ?")
      .get(projectId, id);
    if (!found)
      throw new NarrativeStateError(
        "foreshadow.not_found",
        `Foreshadow ${id} does not exist`,
      );
  }

  private requireTimelineEvent(projectId: string, id: string): void {
    const found = this.database.raw
      .prepare(
        "SELECT id FROM timeline_events WHERE project_id = ? AND id = ? AND voided_at IS NULL",
      )
      .get(projectId, id);
    if (!found)
      throw new NarrativeStateError(
        "timeline.not_found",
        `Timeline event ${id} does not exist`,
      );
  }
}

export class NarrativeStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NarrativeStateError";
  }
}

interface RelationshipRow {
  id: string;
  project_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation: string;
  intensity: number | null;
  state_json: string;
  outline_node_id: string | null;
  story_time: string | null;
  source_id: string | null;
  supersedes_event_id: string | null;
  created_at: string;
}

interface TimelineRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  outline_node_id: string | null;
  story_time_start: string | null;
  story_time_end: string | null;
  sequence: number;
  visibility: TimelineEvent["visibility"];
  source_id: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeRow {
  id: string;
  project_id: string;
  knower_type: KnowledgeRecord["knowerType"];
  knower_entity_id: string | null;
  fact_id: string | null;
  timeline_event_id: string | null;
  learned_at_node_id: string;
  belief: KnowledgeRecord["belief"];
  source_id: string | null;
  created_at: string;
}

interface ForeshadowRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: Foreshadow["status"];
  importance: Foreshadow["importance"];
  target_from_node_id: string | null;
  target_to_node_id: string | null;
  resolution_node_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SummaryRow {
  id: string;
  project_id: string;
  scope_type: NarrativeSummary["scopeType"];
  scope_id: string;
  summary: string;
  state_delta_json: string;
  source_hash: string;
  created_at: string;
}

interface RevisionRow {
  id: number;
  project_id: string;
  entity_type: NarrativeStateRevision["entityType"];
  entity_id: string;
  operation: NarrativeStateRevision["operation"];
  before_json: string | null;
  after_json: string;
  created_at: string;
}

export interface NarrativeStateRevision {
  id: number;
  projectId: string;
  entityType: "timeline" | "foreshadow";
  entityId: string;
  operation: "create" | "update";
  before: Readonly<Record<string, unknown>> | null;
  after: Readonly<Record<string, unknown>>;
  createdAt: string;
}

function mapRelationship(row: RelationshipRow): RelationshipEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    relation: row.relation,
    intensity: row.intensity,
    state: parseObject(row.state_json),
    outlineNodeId: row.outline_node_id,
    storyTime: row.story_time,
    sourceId: row.source_id,
    supersedesEventId: row.supersedes_event_id,
    createdAt: row.created_at,
  };
}

function mapTimeline(row: TimelineRow): TimelineEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    outlineNodeId: row.outline_node_id,
    storyTimeStart: row.story_time_start,
    storyTimeEnd: row.story_time_end,
    sequence: row.sequence,
    participants: [],
    causes: [],
    visibility: row.visibility,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row: RevisionRow): NarrativeStateRevision {
  return {
    id: row.id,
    projectId: row.project_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    before: row.before_json ? parseObject(row.before_json) : null,
    after: parseObject(row.after_json),
    createdAt: row.created_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
