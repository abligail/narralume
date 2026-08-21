import { sha256Hex } from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";
import { SqliteRetrievalRepository } from "./retrieval-repository.js";

export type MemoryLayer = "working" | "episodic" | "semantic";
export type MemoryStatus = "active" | "stale" | "retired";

export interface NarrativeMemory {
  id: string;
  projectId: string;
  layer: MemoryLayer;
  scopeType: string;
  scopeId: string;
  title: string;
  content: string;
  stateDelta: Readonly<Record<string, unknown>>;
  sourceHash: string;
  status: MemoryStatus;
  refreshedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlotPrediction {
  id: string;
  projectId: string;
  title: string;
  horizon: number;
  summary: string;
  impact: readonly string[];
  risks: readonly string[];
  uncertainty: number;
  contextFingerprint: string;
  status: "candidate" | "adopted" | "dismissed";
  stale: boolean;
  sourceIds: readonly string[];
  createdAt: string;
  updatedAt: string;
}

interface PredictionOutline {
  id: string;
  title: string;
  summary: string | null;
  conflict: string | null;
}

interface PredictionForeshadow {
  id: string;
  title: string;
  description: string;
  status: string;
}

interface PredictionIntent {
  promise: string | null;
  ending_direction: string | null;
  current_focus: string | null;
}

interface PredictionRelationship {
  id: string;
  relation: string;
  intensity: number | null;
  source_name: string;
  target_name: string;
}

interface PredictionFact {
  id: string;
  subject_name: string;
  predicate: string;
  object_value: string | null;
  authority: string;
}

interface PredictionContext {
  project: {
    title: string;
    premise: string | null;
    phase: string;
    archived_at: string | null;
  };
  outline: PredictionOutline[];
  foreshadows: PredictionForeshadow[];
  intent: PredictionIntent | undefined;
  relationships: PredictionRelationship[];
  facts: PredictionFact[];
  entities: Array<{
    id: string;
    type: string;
    name: string;
    description: string | null;
  }>;
  timeline: Array<{
    id: string;
    title: string;
    description: string | null;
    outline_node_id: string | null;
    story_time_start: string | null;
    story_time_end: string | null;
    sequence: number;
    visibility: string;
  }>;
  fingerprint: string;
}

export interface DryRunFinding {
  kind: "entity" | "fact" | "timeline" | "foreshadow" | "outline";
  sourceId: string;
  label: string;
  impact: string;
  severity: "info" | "warning";
}

export class SqliteLongNovelRepository {
  private readonly retrieval: SqliteRetrievalRepository;

  constructor(private readonly database: NarrativeDatabase) {
    this.retrieval = new SqliteRetrievalRepository(database);
  }

  listMemories(
    projectId: string,
    options: { includeStale?: boolean } = {},
  ): NarrativeMemory[] {
    this.requireProject(projectId);
    const rows = this.database.raw
      .prepare(
        options.includeStale
          ? `SELECT * FROM narrative_memories WHERE project_id = ?
             ORDER BY status, CASE layer WHEN 'working' THEN 0 WHEN 'episodic' THEN 1 ELSE 2 END, updated_at DESC`
          : `SELECT * FROM narrative_memories WHERE project_id = ? AND status = 'active'
             ORDER BY CASE layer WHEN 'working' THEN 0 WHEN 'episodic' THEN 1 ELSE 2 END, updated_at DESC`,
      )
      .all(projectId) as unknown as MemoryRow[];
    return rows.map(mapMemory);
  }

  rebuildMemories(projectId: string, now: string): NarrativeMemory[] {
    this.requireProject(projectId);
    const summaries = this.latestSummaries(projectId);
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          "UPDATE narrative_memories SET status = 'stale', updated_at = ? WHERE project_id = ? AND status = 'active' AND scope_type != 'sleep'",
        )
        .run(now, projectId);
      this.database.raw
        .prepare(
          `DELETE FROM text_segments
           WHERE project_id = ? AND source_type = 'narrative_memory'
             AND source_id IN (
               SELECT id FROM narrative_memories
               WHERE project_id = ? AND status != 'active'
             )`,
        )
        .run(projectId, projectId);
      for (const summary of summaries) {
        const layer = memoryLayer(summary.scope_type);
        const id = stableId(
          "memory",
          projectId,
          layer,
          summary.scope_type,
          summary.scope_id,
          summary.source_hash,
        );
        this.database.raw
          .prepare(
            `INSERT INTO narrative_memories(
               id, project_id, layer, scope_type, scope_id, title, content,
               state_delta_json, source_hash, status, refreshed_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
             ON CONFLICT(project_id, layer, scope_type, scope_id, source_hash) DO UPDATE SET
               title = excluded.title,
               content = excluded.content,
               state_delta_json = excluded.state_delta_json,
               source_hash = excluded.source_hash,
               status = 'active',
               refreshed_at = excluded.refreshed_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            id,
            projectId,
            layer,
            summary.scope_type,
            summary.scope_id,
            `${scopeLabel(summary.scope_type)} · ${summary.scope_id}`,
            summary.summary,
            summary.state_delta_json,
            summary.source_hash,
            now,
            now,
            now,
          );
      }
    });
    for (const memory of this.listMemories(projectId)) this.indexMemory(memory);
    return this.listMemories(projectId);
  }

  consolidateSleep(projectId: string, now: string): NarrativeMemory | null {
    const sources = this.listMemories(projectId).filter(
      (memory) => memory.layer === "episodic",
    );
    if (sources.length === 0) return null;
    const selected = sources.slice(0, 20);
    const sourceHash = sha256(
      selected
        .map((memory) => memory.sourceHash)
        .sort()
        .join("\n"),
    );
    const id = stableId("memory", projectId, "semantic", "sleep", sourceHash);
    const seenContent = new Set<string>();
    const content = selected
      .filter((memory) => {
        const fingerprint = memory.content.normalize("NFKC").trim();
        if (seenContent.has(fingerprint)) return false;
        seenContent.add(fingerprint);
        return true;
      })
      .map((memory) => `【${memory.title}】${memory.content}`)
      .join("\n");
    const stateDelta = mergeMemoryStateDeltas(selected);
    this.database.raw
      .prepare(
        `INSERT INTO narrative_memories(
           id, project_id, layer, scope_type, scope_id, title, content,
           state_delta_json, source_hash, status, refreshed_at, created_at, updated_at
         ) VALUES (?, ?, 'semantic', 'sleep', ?, '睡眠整理', ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(project_id, layer, scope_type, scope_id, source_hash) DO UPDATE SET
           content = excluded.content,
           state_delta_json = excluded.state_delta_json,
           source_hash = excluded.source_hash,
           status = 'active',
           refreshed_at = excluded.refreshed_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        projectId,
        sourceHash,
        content,
        JSON.stringify(stateDelta),
        sourceHash,
        now,
        now,
        now,
      );
    const memory = this.listMemories(projectId).find(
      (candidate) =>
        candidate.layer === "semantic" && candidate.scopeId === sourceHash,
    );
    if (!memory) return null;
    this.indexMemory(memory);
    return memory;
  }

  listPredictions(projectId: string): PlotPrediction[] {
    this.requireProject(projectId);
    const currentFingerprint = this.predictionContext(projectId).fingerprint;
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM plot_predictions WHERE project_id = ? ORDER BY created_at DESC, id",
      )
      .all(projectId) as unknown as PredictionRow[];
    return rows.map((row) => {
      const prediction = mapPrediction(row);
      return {
        ...prediction,
        stale:
          prediction.status === "candidate" &&
          prediction.contextFingerprint !== currentFingerprint,
      };
    });
  }

  generatePredictions(
    projectId: string,
    input: { direction: string; horizon: number; count: number },
    now: string,
  ): PlotPrediction[] {
    this.requireProject(projectId);
    const { outline, foreshadows, intent, relationships, facts, fingerprint } =
      this.predictionContext(projectId);
    const generationFingerprint = sha256(
      stableJson({
        contextFingerprint: fingerprint,
        direction: input.direction,
        horizon: input.horizon,
      }),
    );
    const seeds = predictionSeeds(
      input.direction,
      outline,
      foreshadows,
      intent,
      relationships,
      facts,
    );
    const predictions = seeds.slice(0, input.count).map((seed, index) => ({
      id: stableId(
        "prediction",
        projectId,
        generationFingerprint,
        String(index),
      ),
      projectId,
      title: seed.title,
      horizon: input.horizon,
      summary: seed.summary,
      impact: seed.impact,
      risks: seed.risks,
      uncertainty: Math.min(0.9, 0.35 + index * 0.12),
      contextFingerprint: fingerprint,
      status: "candidate" as const,
      stale: false,
      sourceIds: seed.sourceIds,
      createdAt: now,
      updatedAt: now,
    }));
    const insert = this.database.raw.prepare(
      `INSERT INTO plot_predictions(
         id, project_id, title, horizon, summary, impact_json, risks_json,
         uncertainty, context_fingerprint, status, source_ids_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         summary = excluded.summary,
         impact_json = excluded.impact_json,
         risks_json = excluded.risks_json,
         uncertainty = excluded.uncertainty,
         source_ids_json = excluded.source_ids_json,
         updated_at = excluded.updated_at`,
    );
    for (const prediction of predictions)
      insert.run(
        prediction.id,
        projectId,
        prediction.title,
        prediction.horizon,
        prediction.summary,
        JSON.stringify(prediction.impact),
        JSON.stringify(prediction.risks),
        prediction.uncertainty,
        prediction.contextFingerprint,
        JSON.stringify(prediction.sourceIds),
        now,
        now,
      );
    const stored = new Map(
      this.listPredictions(projectId).map((prediction) => [
        prediction.id,
        prediction,
      ]),
    );
    return predictions.map((prediction) => stored.get(prediction.id)!);
  }

  decidePrediction(
    projectId: string,
    predictionId: string,
    status: "adopted" | "dismissed",
    now: string,
  ): PlotPrediction {
    const candidate = this.database.raw
      .prepare(
        "SELECT * FROM plot_predictions WHERE project_id = ? AND id = ? AND status = 'candidate'",
      )
      .get(projectId, predictionId) as PredictionRow | undefined;
    if (!candidate)
      throw new PersistenceNotFoundError("plot_prediction", predictionId);
    if (
      status === "adopted" &&
      candidate.context_fingerprint !==
        this.predictionContext(projectId).fingerprint
    ) {
      throw new LongNovelPersistenceError(
        "prediction.context.stale",
        "The story state has changed, so this prediction can no longer be adopted; please regenerate it",
      );
    }
    const changed = this.database.raw
      .prepare(
        "UPDATE plot_predictions SET status = ?, updated_at = ? WHERE project_id = ? AND id = ? AND status = 'candidate'",
      )
      .run(status, now, projectId, predictionId).changes;
    if (changed !== 1)
      throw new PersistenceNotFoundError("plot_prediction", predictionId);
    return this.listPredictions(projectId).find(
      (prediction) => prediction.id === predictionId,
    )!;
  }

  dryRun(
    projectId: string,
    change: string,
  ): {
    fingerprint: string;
    findings: DryRunFinding[];
    safeToProceed: boolean;
  } {
    this.requireProject(projectId);
    const normalized = change.normalize("NFKC").toLocaleLowerCase();
    const findings: DryRunFinding[] = [];
    const findingKeys = new Set<string>();
    const addFinding = (finding: DryRunFinding) => {
      const key = `${finding.kind}:${finding.sourceId}`;
      if (findingKeys.has(key)) return;
      findingKeys.add(key);
      findings.push(finding);
    };
    const matchedEntityIds = new Set<string>();
    const entities = this.database.raw
      .prepare(
        "SELECT id, name, description FROM canon_entities WHERE project_id = ? AND status = 'active'",
      )
      .all(projectId) as unknown as Array<{
      id: string;
      name: string;
      description: string | null;
    }>;
    for (const entity of entities) {
      if (!normalized.includes(entity.name.toLocaleLowerCase())) continue;
      matchedEntityIds.add(entity.id);
      addFinding({
        kind: "entity",
        sourceId: entity.id,
        label: entity.name,
        impact: `将影响人物/设定“${entity.name}”及其关联事实。`,
        severity: "info",
      });
      const facts = this.database.raw
        .prepare(
          `SELECT id, predicate FROM canon_facts
           WHERE project_id = ? AND (subject_id = ? OR object_entity_id = ?)
             AND id NOT IN (SELECT fact_id FROM canon_fact_withdrawals)`,
        )
        .all(projectId, entity.id, entity.id) as unknown as Array<{
        id: string;
        predicate: string;
      }>;
      for (const fact of facts.slice(0, 12))
        addFinding({
          kind: "fact",
          sourceId: fact.id,
          label: fact.predicate,
          impact: `需复核正典事实“${fact.predicate}”是否仍成立。`,
          severity: "warning",
        });
    }
    for (const entityId of matchedEntityIds) {
      const relationships = this.database.raw
        .prepare(
          `SELECT id, relation FROM relationship_events
           WHERE project_id = ? AND (from_entity_id = ? OR to_entity_id = ?)
           ORDER BY created_at DESC LIMIT 12`,
        )
        .all(projectId, entityId, entityId) as unknown as Array<{
        id: string;
        relation: string;
      }>;
      for (const relationship of relationships)
        addFinding({
          kind: "entity",
          sourceId: relationship.id,
          label: relationship.relation,
          impact: `需复核关联关系“${relationship.relation}”及双方动机。`,
          severity: "warning",
        });
      const directEvents = this.database.raw
        .prepare(
          `SELECT event.id, event.title
           FROM timeline_events event
           JOIN timeline_participants participant ON participant.event_id = event.id
           WHERE event.project_id = ? AND participant.entity_id = ?
           ORDER BY event.sequence LIMIT 20`,
        )
        .all(projectId, entityId) as unknown as Array<{
        id: string;
        title: string;
      }>;
      for (const event of directEvents) {
        addFinding({
          kind: "timeline",
          sourceId: event.id,
          label: event.title,
          impact: "该时间线事件直接包含被改动实体，需要重验参与结果。",
          severity: "warning",
        });
        const descendants = this.database.raw
          .prepare(
            `WITH RECURSIVE impacted(id) AS (
               SELECT effect_event_id FROM causal_links WHERE cause_event_id = ?
               UNION
               SELECT links.effect_event_id FROM causal_links links
               JOIN impacted ON links.cause_event_id = impacted.id
             )
             SELECT event.id, event.title FROM impacted
             JOIN timeline_events event ON event.id = impacted.id
             WHERE event.project_id = ? ORDER BY event.sequence LIMIT 30`,
          )
          .all(event.id, projectId) as unknown as Array<{
          id: string;
          title: string;
        }>;
        for (const descendant of descendants)
          addFinding({
            kind: "timeline",
            sourceId: descendant.id,
            label: descendant.title,
            impact: `该事件位于“${event.title}”的下游因果链，需重新验证。`,
            severity: "warning",
          });
      }
    }
    const clues = this.database.raw
      .prepare(
        `SELECT id, title FROM foreshadows
         WHERE project_id = ? AND status IN ('planned','planted','developing')`,
      )
      .all(projectId) as unknown as Array<{ id: string; title: string }>;
    for (const clue of clues) {
      if (!normalized.includes(clue.title.toLocaleLowerCase())) continue;
      addFinding({
        kind: "foreshadow",
        sourceId: clue.id,
        label: clue.title,
        impact: "该改动触及尚未回收的伏笔，需要确认兑现窗口。",
        severity: "warning",
      });
      const dependents = this.database.raw
        .prepare(
          `WITH RECURSIVE impacted(id) AS (
             SELECT foreshadow_id FROM foreshadow_dependencies WHERE depends_on_id = ?
             UNION
             SELECT dependencies.foreshadow_id
             FROM foreshadow_dependencies dependencies
             JOIN impacted ON dependencies.depends_on_id = impacted.id
           )
           SELECT item.id, item.title FROM impacted
           JOIN foreshadows item ON item.id = impacted.id
           WHERE item.project_id = ? LIMIT 30`,
        )
        .all(clue.id, projectId) as unknown as Array<{
        id: string;
        title: string;
      }>;
      for (const dependent of dependents)
        addFinding({
          kind: "foreshadow",
          sourceId: dependent.id,
          label: dependent.title,
          impact: `该伏笔依赖“${clue.title}”，上游变化会传递到其回收条件。`,
          severity: "warning",
        });
    }
    const outlineMatches = this.database.raw
      .prepare(
        `SELECT id, title FROM outline_nodes
         WHERE project_id = ? ORDER BY depth, ordinal`,
      )
      .all(projectId) as unknown as Array<{ id: string; title: string }>;
    for (const node of outlineMatches) {
      if (!normalized.includes(node.title.toLocaleLowerCase())) continue;
      addFinding({
        kind: "outline",
        sourceId: node.id,
        label: node.title,
        impact: "该大纲节点被直接提及，需要复核目标、冲突与结果。",
        severity: "warning",
      });
      const descendants = this.database.raw
        .prepare(
          `WITH RECURSIVE children(id) AS (
             SELECT id FROM outline_nodes WHERE project_id = ? AND parent_id = ?
             UNION
             SELECT node.id FROM outline_nodes node
             JOIN children ON node.parent_id = children.id
             WHERE node.project_id = ?
           )
           SELECT node.id, node.title FROM children
           JOIN outline_nodes node ON node.id = children.id LIMIT 50`,
        )
        .all(projectId, node.id, projectId) as unknown as Array<{
        id: string;
        title: string;
      }>;
      for (const descendant of descendants)
        addFinding({
          kind: "outline",
          sourceId: descendant.id,
          label: descendant.title,
          impact: `该节点是“${node.title}”的下游结构，需要随上游变更复核。`,
          severity: "warning",
        });
    }
    return {
      fingerprint: sha256(stableJson({ projectId, change, findings })),
      findings,
      safeToProceed: findings.every(
        (finding) => finding.severity !== "warning",
      ),
    };
  }

  private latestSummaries(projectId: string): SummaryRow[] {
    return this.database.raw
      .prepare(
        `SELECT summary.* FROM narrative_summaries summary
         JOIN (
           SELECT scope_type, scope_id, MAX(created_at) AS latest_at
           FROM narrative_summaries WHERE project_id = ?
           GROUP BY scope_type, scope_id
         ) latest ON latest.scope_type = summary.scope_type
           AND latest.scope_id = summary.scope_id AND latest.latest_at = summary.created_at
         WHERE summary.project_id = ? ORDER BY summary.created_at DESC`,
      )
      .all(projectId, projectId) as unknown as SummaryRow[];
  }

  private predictionContext(projectId: string): PredictionContext {
    const project = this.database.raw
      .prepare(
        "SELECT title, premise, phase, archived_at FROM projects WHERE id = ?",
      )
      .get(projectId) as PredictionContext["project"] | undefined;
    if (!project) throw new PersistenceNotFoundError("project", projectId);
    const outline = this.database.raw
      .prepare(
        `SELECT id, title, summary, conflict FROM outline_nodes
         WHERE project_id = ? AND status IN ('planned','drafting')
         ORDER BY depth, ordinal, id LIMIT 12`,
      )
      .all(projectId) as unknown as PredictionOutline[];
    const foreshadows = this.database.raw
      .prepare(
        `SELECT id, title, description, status FROM foreshadows
         WHERE project_id = ? AND status IN ('planned','planted','developing')
         ORDER BY importance DESC, updated_at DESC, id LIMIT 12`,
      )
      .all(projectId) as unknown as PredictionForeshadow[];
    const intent = this.database.raw
      .prepare(
        "SELECT promise, ending_direction, current_focus FROM author_intents WHERE project_id = ?",
      )
      .get(projectId) as PredictionIntent | undefined;
    const relationships = this.database.raw
      .prepare(
        `SELECT current.id, current.relation, current.intensity,
                source.name AS source_name, target.name AS target_name
         FROM (
           SELECT event.*,
             ROW_NUMBER() OVER (
               PARTITION BY from_entity_id, to_entity_id, relation
               ORDER BY created_at DESC, event.rowid DESC
             ) AS rank
           FROM relationship_events event WHERE project_id = ?
         ) current
         JOIN canon_entities source ON source.id = current.from_entity_id
         JOIN canon_entities target ON target.id = current.to_entity_id
         WHERE current.rank = 1
         ORDER BY source.id, target.id, current.relation LIMIT 12`,
      )
      .all(projectId) as unknown as PredictionRelationship[];
    const facts = this.database.raw
      .prepare(
        `SELECT fact.id, entity.name AS subject_name, fact.predicate,
                COALESCE(object_entity.name, fact.value_json) AS object_value,
                fact.authority
         FROM canon_facts fact
         JOIN canon_entities entity ON entity.id = fact.subject_id
         LEFT JOIN canon_entities object_entity ON object_entity.id = fact.object_entity_id
         WHERE fact.project_id = ? AND fact.authority IN ('confirmed','locked')
           AND fact.id NOT IN (SELECT fact_id FROM canon_fact_withdrawals)
         ORDER BY CASE fact.authority WHEN 'locked' THEN 0 ELSE 1 END,
                  fact.created_at DESC, fact.id LIMIT 12`,
      )
      .all(projectId) as unknown as PredictionFact[];
    const entities = this.database.raw
      .prepare(
        `SELECT id, type, name, description FROM canon_entities
         WHERE project_id = ? AND status = 'active' ORDER BY id LIMIT 100`,
      )
      .all(projectId) as unknown as PredictionContext["entities"];
    const timeline = this.database.raw
      .prepare(
        `SELECT id, title, description, outline_node_id, story_time_start,
                story_time_end, sequence, visibility
         FROM timeline_events WHERE project_id = ?
         ORDER BY sequence, id LIMIT 100`,
      )
      .all(projectId) as unknown as PredictionContext["timeline"];
    return {
      project,
      outline,
      foreshadows,
      intent,
      relationships,
      facts,
      entities,
      timeline,
      fingerprint: sha256(
        stableJson({
          project,
          outline,
          foreshadows,
          intent,
          relationships,
          facts,
          entities,
          timeline,
        }),
      ),
    };
  }

  private indexMemory(memory: NarrativeMemory): void {
    this.retrieval.upsertSegment({
      id: `segment:${memory.id}`,
      projectId: memory.projectId,
      sourceType: "narrative_memory",
      sourceId: memory.id,
      title: memory.title,
      content: memory.content,
      authority: "confirmed",
      metadata: {
        layer: memory.layer,
        scopeType: memory.scopeType,
        scopeId: memory.scopeId,
        sourceHash: memory.sourceHash,
      },
      entityIds: [],
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });
  }

  private requireProject(projectId: string): void {
    const project = this.database.raw
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(projectId);
    if (!project) throw new PersistenceNotFoundError("project", projectId);
  }
}

export class LongNovelPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LongNovelPersistenceError";
  }
}

interface MemoryRow {
  id: string;
  project_id: string;
  layer: MemoryLayer;
  scope_type: string;
  scope_id: string;
  title: string;
  content: string;
  state_delta_json: string;
  source_hash: string;
  status: MemoryStatus;
  refreshed_at: string;
  created_at: string;
  updated_at: string;
}

interface SummaryRow {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string;
  summary: string;
  state_delta_json: string;
  source_hash: string;
  created_at: string;
}

interface PredictionRow {
  id: string;
  project_id: string;
  title: string;
  horizon: number;
  summary: string;
  impact_json: string;
  risks_json: string;
  uncertainty: number;
  context_fingerprint: string;
  status: PlotPrediction["status"];
  source_ids_json: string;
  created_at: string;
  updated_at: string;
}

function mapMemory(row: MemoryRow): NarrativeMemory {
  return {
    id: row.id,
    projectId: row.project_id,
    layer: row.layer,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    title: row.title,
    content: row.content,
    stateDelta: parseObject(row.state_delta_json),
    sourceHash: row.source_hash,
    status: row.status,
    refreshedAt: row.refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPrediction(row: PredictionRow): PlotPrediction {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    horizon: row.horizon,
    summary: row.summary,
    impact: parseStrings(row.impact_json),
    risks: parseStrings(row.risks_json),
    uncertainty: row.uncertainty,
    contextFingerprint: row.context_fingerprint,
    status: row.status,
    stale: false,
    sourceIds: parseStrings(row.source_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memoryLayer(scopeType: string): MemoryLayer {
  if (scopeType === "session") return "working";
  if (scopeType === "scene" || scopeType === "chapter") return "episodic";
  return "semantic";
}

function scopeLabel(scopeType: string): string {
  return (
    {
      scene: "场景",
      chapter: "章节",
      arc: "故事弧",
      volume: "卷",
      book: "全书",
      session: "会话",
    }[scopeType] ?? scopeType
  );
}

function predictionSeeds(
  direction: string,
  outline: Array<{
    id: string;
    title: string;
    summary: string | null;
    conflict: string | null;
  }>,
  foreshadows: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
  }>,
  intent:
    | {
        promise: string | null;
        ending_direction: string | null;
        current_focus: string | null;
      }
    | undefined,
  relationships: Array<{
    id: string;
    relation: string;
    intensity: number | null;
    source_name: string;
    target_name: string;
  }>,
  facts: Array<{
    id: string;
    subject_name: string;
    predicate: string;
    object_value: string | null;
    authority: string;
  }>,
) {
  const result: Array<{
    title: string;
    summary: string;
    impact: string[];
    risks: string[];
    sourceIds: string[];
  }> = [];
  for (const relationship of relationships.slice(0, 2))
    result.push({
      title: `检验${relationship.source_name}与${relationship.target_name}的${relationship.relation}`,
      summary: `${inputDirection(direction)}通过一次必须共同承担后果的选择，检验“${relationship.relation}”是否会强化、反转或破裂。`,
      impact: [
        `关系强度：${relationship.intensity ?? "未知"}`,
        `双方：${relationship.source_name} / ${relationship.target_name}`,
      ],
      risks: ["角色动机需要当前章节证据", "关系变化必须在结算中留痕"],
      sourceIds: [relationship.id],
    });
  for (const fact of facts.slice(0, 2))
    result.push({
      title: `兑现「${fact.subject_name}·${fact.predicate}」的后果`,
      summary: `${inputDirection(direction)}让“${fact.subject_name}${fact.predicate}${fact.object_value ?? ""}”不再只是背景设定，而是限制本次选择的代价。`,
      impact: [
        `${fact.authority === "locked" ? "锁定" : "确认"}正典参与因果`,
        "减少设定与剧情脱节",
      ],
      risks: ["不得篡改事实本身", "需避免生硬解释设定"],
      sourceIds: [fact.id],
    });
  for (const node of outline.slice(0, 2))
    result.push({
      title: `推进「${node.title}」`,
      summary: `${direction || "沿当前故事承诺推进"}；让“${node.title}”的冲突产生不可逆后果。${node.summary ?? ""}`,
      impact: [
        "推进主线",
        node.conflict ? `兑现冲突：${node.conflict}` : "建立新的因果链",
      ],
      risks: ["过早消耗主线张力", "需要复核人物动机"],
      sourceIds: [node.id],
    });
  for (const clue of foreshadows.slice(0, 2))
    result.push({
      title: `放大伏笔「${clue.title}」`,
      summary: `让“${clue.title}”从背景线索转为角色必须回应的事件，但暂不完全揭底。`,
      impact: ["提高线索可见度", "连接后续回收窗口"],
      risks: ["信息释放过快", "可能削弱悬念"],
      sourceIds: [clue.id],
    });
  result.push({
    title: "反向施压",
    summary: `从与“${intent?.current_focus ?? (direction || "当前目标")}”相反的方向制造代价，检验角色是否仍会坚持。`,
    impact: ["强化角色能动性", "显露主题代价"],
    risks: ["偏离作者当前意图", "需要新的铺垫"],
    sourceIds: [],
  });
  result.push({
    title: "陌生变量",
    summary: `引入一个不直接推翻现有正典的新变量，让“${direction || "当前计划"}”出现第二种解释。`,
    impact: ["扩展选择空间", "制造信息差"],
    risks: ["增加认知负担", "需要在后续章节回收"],
    sourceIds: [],
  });
  result.push({
    title: "延迟兑现",
    summary:
      "暂缓主线答案，先让角色为一次看似较小的选择支付代价，再把后果接回主线。",
    impact: ["积累因果势能", "保留悬念"],
    risks: ["节奏可能变慢", "必须留下明确推进信号"],
    sourceIds: [],
  });
  return result;
}

function stableId(...parts: string[]): string {
  return `${parts[0]}-${sha256(parts.join("\0")).slice(0, 24)}`;
}

function inputDirection(direction: string): string {
  const normalized = direction.trim();
  return normalized ? `沿“${normalized}”推进，` : "沿当前故事承诺推进，";
}

function sha256(value: string): string {
  return sha256Hex(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseStrings(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function mergeMemoryStateDeltas(
  memories: readonly NarrativeMemory[],
): Record<string, unknown> {
  const values = new Map<string, unknown[]>();
  for (const memory of memories) {
    for (const [key, value] of Object.entries(memory.stateDelta)) {
      const entries = values.get(key) ?? [];
      const fingerprint = stableJson(value);
      if (!entries.some((entry) => stableJson(entry) === fingerprint))
        entries.push(value);
      values.set(key, entries);
    }
  }
  return {
    consolidatedFrom: memories.map((memory) => memory.id),
    ...Object.fromEntries(
      [...values.entries()].map(([key, entries]) => [
        key,
        entries.length === 1 ? entries[0] : entries,
      ]),
    ),
  };
}
