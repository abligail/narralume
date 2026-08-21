import type {
  CoCreateParticipant,
  CoCreateSession,
  DocumentComment,
  EditProposal,
  SceneAdoption,
  StoryBranch,
  StoryPersona,
  StoryTurn,
  TurnSwipe,
} from "@narralume/domain";
import { requireCreativeText, validateTextRange } from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface CoCreateSessionDetail {
  session: CoCreateSession;
  participants: (CoCreateParticipant & { persona: StoryPersona })[];
  branches: StoryBranch[];
  turns: (StoryTurn & { swipes: TurnSwipe[] })[];
  adoptions: SceneAdoption[];
}

export class SqliteCreativeRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertPersona(persona: StoryPersona): StoryPersona {
    return this.database.transaction(() => {
      const name = requireCreativeText(
        persona.name,
        "persona.name.empty",
        "Persona name",
      );
      this.assertEntityProject(persona.projectId, persona.entityId);
      const inserted = this.database.raw
        .prepare(
          `INSERT INTO story_personas(
            id, project_id, kind, entity_id, name, description, instructions,
            voice_json, status, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, name) DO NOTHING`,
        )
        .run(
          persona.id,
          persona.projectId,
          persona.kind,
          persona.entityId,
          name,
          persona.description,
          persona.instructions,
          JSON.stringify(persona.voice),
          persona.status,
          persona.createdAt,
          persona.updatedAt,
          persona.version,
        );
      if (inserted.changes !== 1) {
        throw new CreativePersistenceError(
          "persona.name.conflict",
          "A persona with this name already exists in this project; please choose another name",
        );
      }
      return this.requirePersona(persona.id);
    });
  }

  updatePersona(
    id: string,
    input: Pick<
      StoryPersona,
      | "kind"
      | "entityId"
      | "name"
      | "description"
      | "instructions"
      | "voice"
      | "status"
      | "updatedAt"
    > & { expectedVersion: number },
  ): StoryPersona {
    return this.database.transaction(() => {
      const current = this.requirePersona(id);
      this.requireVersion(
        current.version,
        input.expectedVersion,
        "persona.version.conflict",
        "The persona was updated elsewhere; refresh and try again",
      );
      const name = requireCreativeText(
        input.name,
        "persona.name.empty",
        "Persona name",
      );
      this.assertEntityProject(current.projectId, input.entityId);
      const duplicate = this.database.raw
        .prepare(
          "SELECT 1 AS present FROM story_personas WHERE project_id = ? AND name = ? AND id <> ? LIMIT 1",
        )
        .get(current.projectId, name, id);
      if (duplicate) {
        throw new CreativePersistenceError(
          "persona.name.conflict",
          "A persona with this name already exists in this project; please choose another name",
        );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE story_personas SET kind = ?, entity_id = ?, name = ?, description = ?,
            instructions = ?, voice_json = ?, status = ?, updated_at = ?,
            version = version + 1 WHERE id = ? AND version = ?`,
        )
        .run(
          input.kind,
          input.entityId,
          name,
          input.description,
          input.instructions,
          JSON.stringify(input.voice),
          input.status,
          input.updatedAt,
          id,
          input.expectedVersion,
        );
      if (result.changes !== 1) {
        throw new CreativePersistenceError(
          "persona.version.conflict",
          "The persona was updated elsewhere; refresh and try again",
        );
      }
      return this.requirePersona(id);
    });
  }

  getPersona(id: string): StoryPersona | null {
    const row = this.database.raw
      .prepare("SELECT * FROM story_personas WHERE id = ?")
      .get(id) as PersonaRow | undefined;
    return row ? mapPersona(row) : null;
  }

  requirePersona(id: string): StoryPersona {
    const persona = this.getPersona(id);
    if (!persona) throw new PersistenceNotFoundError("story_persona", id);
    return persona;
  }

  listPersonas(projectId: string, includeRetired = false): StoryPersona[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM story_personas WHERE project_id = ?
         ${includeRetired ? "" : "AND status = 'active'"}
         ORDER BY kind, name`,
      )
      .all(projectId) as unknown as PersonaRow[];
    return rows.map(mapPersona);
  }

  createSession(input: {
    id: string;
    branchId: string;
    projectId: string;
    title: string;
    speakerPolicy: CoCreateSession["speakerPolicy"];
    targetOutlineNodeId: string | null;
    authorPersonaId: string | null;
    directorNote: string | null;
    contextTurns: number;
    participantIds: readonly string[];
    now: string;
  }): CoCreateSessionDetail {
    return this.database.transaction(() => {
      const title = requireCreativeText(
        input.title,
        "cocreate.title.empty",
        "Session title",
      );
      if (input.authorPersonaId) {
        this.assertPersonaProject(input.projectId, input.authorPersonaId);
      }
      this.assertOutlineNodeProject(input.projectId, input.targetOutlineNodeId);
      const participants = [...new Set(input.participantIds)];
      for (const personaId of participants) {
        this.assertPersonaProject(input.projectId, personaId);
      }
      this.database.raw
        .prepare(
          `INSERT INTO cocreate_sessions(
            id, project_id, title, status, speaker_policy,
            active_branch_id, target_outline_node_id, author_persona_id,
            director_note, context_turns, created_at, updated_at, version
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          input.id,
          input.projectId,
          title,
          input.speakerPolicy,
          input.branchId,
          input.targetOutlineNodeId,
          input.authorPersonaId,
          input.directorNote,
          input.contextTurns,
          input.now,
          input.now,
        );
      this.database.raw
        .prepare(
          `INSERT INTO story_branches(
            id, session_id, parent_branch_id, forked_from_turn_id, name,
            status, head_turn_id, created_at, updated_at
          ) VALUES (?, ?, NULL, NULL, '主线', 'active', NULL, ?, ?)`,
        )
        .run(input.branchId, input.id, input.now, input.now);
      const insertParticipant = this.database.raw.prepare(
        `INSERT INTO cocreate_participants(
          session_id, persona_id, position, enabled, talkativeness, created_at
        ) VALUES (?, ?, ?, 1, 0.5, ?)`,
      );
      participants.forEach((personaId, index) =>
        insertParticipant.run(input.id, personaId, index, input.now),
      );
      return this.requireSessionDetail(input.id);
    });
  }

  getSession(id: string): CoCreateSession | null {
    const row = this.database.raw
      .prepare("SELECT * FROM cocreate_sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  requireSession(id: string): CoCreateSession {
    const session = this.getSession(id);
    if (!session) throw new PersistenceNotFoundError("cocreate_session", id);
    return session;
  }

  updateSession(
    id: string,
    input: Partial<
      Pick<
        CoCreateSession,
        | "title"
        | "status"
        | "speakerPolicy"
        | "targetOutlineNodeId"
        | "authorPersonaId"
        | "directorNote"
        | "contextTurns"
      >
    > & { expectedVersion: number; updatedAt: string },
  ): CoCreateSession {
    return this.database.transaction(() => {
      const current = this.requireSession(id);
      this.requireSessionVersion(current, input.expectedVersion);
      const next = { ...current, ...input };
      if (next.authorPersonaId) {
        this.assertPersonaProject(current.projectId, next.authorPersonaId);
      }
      this.assertOutlineNodeProject(
        current.projectId,
        next.targetOutlineNodeId,
      );
      const result = this.database.raw
        .prepare(
          `UPDATE cocreate_sessions SET title = ?, status = ?, speaker_policy = ?,
            target_outline_node_id = ?, author_persona_id = ?, director_note = ?,
            context_turns = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(
          requireCreativeText(
            next.title,
            "cocreate.title.empty",
            "Session title",
          ),
          next.status,
          next.speakerPolicy,
          next.targetOutlineNodeId,
          next.authorPersonaId,
          next.directorNote,
          next.contextTurns,
          input.updatedAt,
          id,
          input.expectedVersion,
        );
      if (result.changes !== 1) this.throwSessionVersionConflict();
      return this.requireSession(id);
    });
  }

  listSessions(projectId: string, includeArchived = false): CoCreateSession[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM cocreate_sessions WHERE project_id = ?
         ${includeArchived ? "" : "AND status != 'archived'"}
         ORDER BY updated_at DESC`,
      )
      .all(projectId) as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  replaceParticipants(
    sessionId: string,
    participants: readonly {
      personaId: string;
      enabled: boolean;
      talkativeness: number;
    }[],
    expectedVersion: number,
    now: string,
  ): CoCreateParticipant[] {
    return this.database.transaction(() => {
      const session = this.requireSession(sessionId);
      this.requireSessionVersion(session, expectedVersion);
      const unique = new Set<string>();
      for (const participant of participants) {
        if (unique.has(participant.personaId)) {
          throw new CreativePersistenceError(
            "cocreate.participant.duplicate",
            "The same persona cannot join the session more than once",
          );
        }
        unique.add(participant.personaId);
        this.assertPersonaProject(session.projectId, participant.personaId);
        if (participant.talkativeness < 0 || participant.talkativeness > 1) {
          throw new CreativePersistenceError(
            "cocreate.talkativeness.invalid",
            "Speaking tendency must be between 0 and 1",
          );
        }
      }
      const updated = this.database.raw
        .prepare(
          `UPDATE cocreate_sessions SET updated_at = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(now, sessionId, expectedVersion);
      if (updated.changes !== 1) this.throwSessionVersionConflict();
      this.database.raw
        .prepare("DELETE FROM cocreate_participants WHERE session_id = ?")
        .run(sessionId);
      const insert = this.database.raw.prepare(
        `INSERT INTO cocreate_participants(
          session_id, persona_id, position, enabled, talkativeness, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      participants.forEach((participant, position) =>
        insert.run(
          sessionId,
          participant.personaId,
          position,
          participant.enabled ? 1 : 0,
          participant.talkativeness,
          now,
        ),
      );
      return this.listParticipants(sessionId);
    });
  }

  listParticipants(sessionId: string): CoCreateParticipant[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM cocreate_participants WHERE session_id = ? ORDER BY position",
      )
      .all(sessionId) as unknown as ParticipantRow[];
    return rows.map(mapParticipant);
  }

  createBranch(input: {
    id: string;
    sessionId: string;
    fromTurnId: string;
    name: string;
    expectedVersion: number;
    now: string;
  }): StoryBranch {
    return this.database.transaction(() => {
      const session = this.requireSession(input.sessionId);
      this.requireSessionVersion(session, input.expectedVersion);
      const source = this.requireTurn(input.fromTurnId);
      if (
        source.sessionId !== session.id ||
        !this.listBranchTurns(source.branchId).some(
          (turn) => turn.id === source.id,
        )
      ) {
        throw new CreativePersistenceError(
          "branch.fork.invalid_turn",
          "The fork point is not part of the visible history of this session",
        );
      }
      this.database.raw
        .prepare(
          `INSERT INTO story_branches(
            id, session_id, parent_branch_id, forked_from_turn_id, name,
            status, head_turn_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          input.id,
          session.id,
          source.branchId,
          source.id,
          requireCreativeText(input.name, "branch.name.empty", "Branch name"),
          source.id,
          input.now,
          input.now,
        );
      this.setActiveBranch(
        session.id,
        input.id,
        input.expectedVersion,
        input.now,
      );
      return this.requireBranch(input.id);
    });
  }

  getBranch(id: string): StoryBranch | null {
    const row = this.database.raw
      .prepare("SELECT * FROM story_branches WHERE id = ?")
      .get(id) as BranchRow | undefined;
    return row ? mapBranch(row) : null;
  }

  requireBranch(id: string): StoryBranch {
    const branch = this.getBranch(id);
    if (!branch) throw new PersistenceNotFoundError("story_branch", id);
    return branch;
  }

  listBranches(sessionId: string): StoryBranch[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM story_branches WHERE session_id = ? ORDER BY created_at",
      )
      .all(sessionId) as unknown as BranchRow[];
    return rows.map(mapBranch);
  }

  setActiveBranch(
    sessionId: string,
    branchId: string,
    expectedVersion: number,
    now: string,
  ): CoCreateSession {
    const session = this.requireSession(sessionId);
    this.requireSessionVersion(session, expectedVersion);
    const branch = this.requireBranch(branchId);
    if (branch.sessionId !== sessionId || branch.status !== "active") {
      throw new CreativePersistenceError(
        "branch.session.mismatch",
        "The branch does not belong to this session or is already archived",
      );
    }
    const result = this.database.raw
      .prepare(
        `UPDATE cocreate_sessions SET active_branch_id = ?, updated_at = ?,
          version = version + 1 WHERE id = ? AND version = ?`,
      )
      .run(branchId, now, sessionId, expectedVersion);
    if (result.changes !== 1) this.throwSessionVersionConflict();
    return this.requireSession(sessionId);
  }

  insertTurn(input: {
    id: string;
    sessionId: string;
    branchId: string;
    role: StoryTurn["role"];
    personaId: string | null;
    content: string;
    sourceRunId?: string | null;
    metadata?: Readonly<Record<string, unknown>>;
    now: string;
  }): StoryTurn {
    return this.database.transaction(() => {
      const session = this.requireSession(input.sessionId);
      const branch = this.requireBranch(input.branchId);
      if (branch.sessionId !== session.id || branch.status !== "active") {
        throw new CreativePersistenceError(
          "turn.branch.invalid",
          "Cannot append turns to this branch",
        );
      }
      if (input.personaId) {
        this.assertPersonaProject(session.projectId, input.personaId);
      }
      const content = requireCreativeText(
        input.content,
        "turn.content.empty",
        "Turn content",
      );
      const ordinal = this.nextTurnOrdinal(branch.id);
      const parentTurnId = branch.headTurnId;
      this.database.raw
        .prepare(
          `INSERT INTO story_turns(
            id, project_id, session_id, branch_id, parent_turn_id, ordinal,
            role, persona_id, content, status, selected_swipe_id, source_run_id,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          session.projectId,
          session.id,
          branch.id,
          parentTurnId,
          ordinal,
          input.role,
          input.personaId,
          content,
          input.sourceRunId ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.now,
          input.now,
        );
      this.database.raw
        .prepare(
          "UPDATE story_branches SET head_turn_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.id, input.now, branch.id);
      this.database.raw
        .prepare(
          "UPDATE cocreate_sessions SET updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(input.now, session.id);
      return this.requireTurn(input.id);
    });
  }

  stageAssistantSwipe(input: {
    swipeId: string;
    turnId?: string | null;
    newTurnId?: string;
    sessionId: string;
    branchId: string;
    speakerPersonaId: string | null;
    content: string;
    sourceRunId: string;
    metadata?: Readonly<Record<string, unknown>>;
    now: string;
  }): { turn: StoryTurn; swipe: TurnSwipe } {
    return this.database.transaction(() => {
      const replayRow = this.database.raw
        .prepare("SELECT * FROM turn_swipes WHERE id = ?")
        .get(input.swipeId) as SwipeRow | undefined;
      if (replayRow) {
        const replay = mapSwipe(replayRow);
        return { turn: this.requireTurn(replay.turnId), swipe: replay };
      }
      const turn = input.turnId
        ? this.requireTurn(input.turnId)
        : this.insertTurn({
            id: input.newTurnId ?? `${input.sourceRunId}:turn`,
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "assistant",
            personaId: input.speakerPersonaId,
            content: input.content,
            sourceRunId: input.sourceRunId,
            ...(input.metadata ? { metadata: input.metadata } : {}),
            now: input.now,
          });
      if (
        turn.sessionId !== input.sessionId ||
        turn.branchId !== input.branchId ||
        turn.role !== "assistant"
      ) {
        throw new CreativePersistenceError(
          "swipe.turn.invalid",
          "A swipe can only be attached to an AI turn of the current branch",
        );
      }
      const existing = this.listSwipes(turn.id);
      this.database.raw
        .prepare(
          "UPDATE turn_swipes SET status = 'candidate' WHERE turn_id = ? AND status = 'selected'",
        )
        .run(turn.id);
      this.database.raw
        .prepare(
          `INSERT INTO turn_swipes(
            id, turn_id, ordinal, content, speaker_persona_id, source_run_id,
            status, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'selected', ?, ?)`,
        )
        .run(
          input.swipeId,
          turn.id,
          existing.length,
          requireCreativeText(
            input.content,
            "swipe.content.empty",
            "AI candidate",
          ),
          input.speakerPersonaId,
          input.sourceRunId,
          JSON.stringify(input.metadata ?? {}),
          input.now,
        );
      this.database.raw
        .prepare(
          `UPDATE story_turns SET content = ?, persona_id = ?, selected_swipe_id = ?,
            source_run_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.content,
          input.speakerPersonaId,
          input.swipeId,
          input.sourceRunId,
          input.now,
          turn.id,
        );
      return {
        turn: this.requireTurn(turn.id),
        swipe: this.requireSwipe(input.swipeId),
      };
    });
  }

  selectSwipe(turnId: string, swipeId: string, now: string): StoryTurn {
    return this.database.transaction(() => {
      const turn = this.requireTurn(turnId);
      const swipe = this.requireSwipe(swipeId);
      if (swipe.turnId !== turn.id) {
        throw new CreativePersistenceError(
          "swipe.turn.mismatch",
          "The candidate does not belong to this turn",
        );
      }
      this.database.raw
        .prepare(
          `UPDATE turn_swipes SET status = CASE WHEN id = ? THEN 'selected' ELSE 'candidate' END
           WHERE turn_id = ? AND status != 'rejected'`,
        )
        .run(swipeId, turnId);
      this.database.raw
        .prepare(
          `UPDATE story_turns SET content = ?, persona_id = ?, selected_swipe_id = ?,
           updated_at = ? WHERE id = ?`,
        )
        .run(swipe.content, swipe.speakerPersonaId, swipe.id, now, turn.id);
      return this.requireTurn(turn.id);
    });
  }

  getTurn(id: string): StoryTurn | null {
    const row = this.database.raw
      .prepare("SELECT * FROM story_turns WHERE id = ?")
      .get(id) as TurnRow | undefined;
    return row ? mapTurn(row) : null;
  }

  requireTurn(id: string): StoryTurn {
    const turn = this.getTurn(id);
    if (!turn) throw new PersistenceNotFoundError("story_turn", id);
    return turn;
  }

  listBranchTurns(branchId: string): StoryTurn[] {
    const branch = this.requireBranch(branchId);
    const lineage: StoryBranch[] = [];
    let cursor: StoryBranch | null = branch;
    while (cursor) {
      lineage.push(cursor);
      cursor = cursor.parentBranchId
        ? this.requireBranch(cursor.parentBranchId)
        : null;
    }
    lineage.reverse();
    const result: StoryTurn[] = [];
    for (let index = 0; index < lineage.length; index += 1) {
      const segment = lineage[index]!;
      const child = lineage[index + 1];
      const rows = this.listLocalTurns(segment.id);
      if (!child?.forkedFromTurnId) {
        result.push(...rows);
        continue;
      }
      const cutoff = this.requireTurn(child.forkedFromTurnId);
      result.push(...rows.filter((turn) => turn.ordinal <= cutoff.ordinal));
    }
    return result;
  }

  listTurnsWithSwipes(
    branchId: string,
  ): (StoryTurn & { swipes: TurnSwipe[] })[] {
    return this.listBranchTurns(branchId).map((turn) => ({
      ...turn,
      swipes: this.listSwipes(turn.id),
    }));
  }

  revertFromTurn(turnId: string, now: string): StoryBranch {
    return this.database.transaction(() => {
      const turn = this.requireTurn(turnId);
      const branch = this.requireBranch(turn.branchId);
      this.database.raw
        .prepare(
          `UPDATE story_turns SET status = 'reverted', updated_at = ?
           WHERE branch_id = ? AND ordinal >= ? AND status = 'active'`,
        )
        .run(now, branch.id, turn.ordinal);
      const head = [...this.listLocalTurns(branch.id)].reverse()[0] ?? null;
      this.database.raw
        .prepare(
          "UPDATE story_branches SET head_turn_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(head?.id ?? branch.forkedFromTurnId, now, branch.id);
      return this.requireBranch(branch.id);
    });
  }

  listSwipes(turnId: string): TurnSwipe[] {
    const rows = this.database.raw
      .prepare("SELECT * FROM turn_swipes WHERE turn_id = ? ORDER BY ordinal")
      .all(turnId) as unknown as SwipeRow[];
    return rows.map(mapSwipe);
  }

  requireSwipe(id: string): TurnSwipe {
    const row = this.database.raw
      .prepare("SELECT * FROM turn_swipes WHERE id = ?")
      .get(id) as SwipeRow | undefined;
    if (!row) throw new PersistenceNotFoundError("turn_swipe", id);
    return mapSwipe(row);
  }

  insertSceneAdoption(adoption: SceneAdoption): SceneAdoption {
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO scene_adoptions(
            id, project_id, session_id, branch_id, from_turn_id, to_turn_id,
            outline_node_id, document_id, document_version_id, run_id,
            canon_change_set_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          adoption.id,
          adoption.projectId,
          adoption.sessionId,
          adoption.branchId,
          adoption.fromTurnId,
          adoption.toTurnId,
          adoption.outlineNodeId,
          adoption.documentId,
          adoption.documentVersionId,
          adoption.runId,
          adoption.canonChangeSetId,
          adoption.createdAt,
        );
      const from = this.requireTurn(adoption.fromTurnId);
      const to = this.requireTurn(adoption.toTurnId);
      this.database.raw
        .prepare(
          `UPDATE story_turns SET status = 'adopted', updated_at = ?
           WHERE branch_id = ? AND ordinal BETWEEN ? AND ? AND status = 'active'`,
        )
        .run(
          adoption.createdAt,
          adoption.branchId,
          Math.min(from.ordinal, to.ordinal),
          Math.max(from.ordinal, to.ordinal),
        );
    });
    return this.requireSceneAdoption(adoption.id);
  }

  listSceneAdoptions(sessionId: string): SceneAdoption[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM scene_adoptions WHERE session_id = ? ORDER BY created_at",
      )
      .all(sessionId) as unknown as AdoptionRow[];
    return rows.map(mapAdoption);
  }

  requireSceneAdoption(id: string): SceneAdoption {
    const row = this.database.raw
      .prepare("SELECT * FROM scene_adoptions WHERE id = ?")
      .get(id) as AdoptionRow | undefined;
    if (!row) throw new PersistenceNotFoundError("scene_adoption", id);
    return mapAdoption(row);
  }

  insertComment(
    comment: DocumentComment,
    versionContent: string,
  ): DocumentComment {
    validateTextRange(versionContent, comment.startOffset, comment.endOffset);
    const quote = versionContent.slice(comment.startOffset, comment.endOffset);
    if (quote !== comment.quote) {
      throw new CreativePersistenceError(
        "comment.quote.mismatch",
        "The comment anchor does not match the version text",
      );
    }
    requireCreativeText(comment.body, "comment.body.empty", "Comment");
    this.database.raw
      .prepare(
        `INSERT INTO document_comments(
          id, project_id, document_id, version_id, start_offset, end_offset,
          quote, body, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comment.id,
        comment.projectId,
        comment.documentId,
        comment.versionId,
        comment.startOffset,
        comment.endOffset,
        comment.quote,
        comment.body.trim(),
        comment.status,
        comment.createdAt,
        comment.updatedAt,
      );
    return this.requireComment(comment.id);
  }

  setCommentStatus(
    id: string,
    status: DocumentComment["status"],
    now: string,
  ): DocumentComment {
    const result = this.database.raw
      .prepare(
        "UPDATE document_comments SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, id);
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("document_comment", id);
    return this.requireComment(id);
  }

  listComments(documentId: string): DocumentComment[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM document_comments WHERE document_id = ? ORDER BY created_at DESC",
      )
      .all(documentId) as unknown as CommentRow[];
    return rows.map(mapComment);
  }

  requireComment(id: string): DocumentComment {
    const row = this.database.raw
      .prepare("SELECT * FROM document_comments WHERE id = ?")
      .get(id) as CommentRow | undefined;
    if (!row) throw new PersistenceNotFoundError("document_comment", id);
    return mapComment(row);
  }

  insertEditProposal(proposal: EditProposal): EditProposal {
    this.database.raw
      .prepare(
        `INSERT OR IGNORE INTO edit_proposals(
          id, project_id, document_id, base_version_id, run_id, instruction,
          selection_start, selection_end, original_text, replacement_text,
          proposed_content, diff_json, status, accepted_version_id, created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.projectId,
        proposal.documentId,
        proposal.baseVersionId,
        proposal.runId,
        proposal.instruction,
        proposal.selectionStart,
        proposal.selectionEnd,
        proposal.originalText,
        proposal.replacementText,
        proposal.proposedContent,
        JSON.stringify(proposal.diff),
        proposal.status,
        proposal.acceptedVersionId,
        proposal.createdAt,
        proposal.decidedAt,
      );
    return this.requireEditProposal(proposal.id);
  }

  decideEditProposal(
    id: string,
    status: "accepted" | "rejected" | "superseded",
    acceptedVersionId: string | null,
    now: string,
  ): EditProposal {
    const current = this.requireEditProposal(id);
    if (current.status !== "proposed") return current;
    this.database.raw
      .prepare(
        `UPDATE edit_proposals SET status = ?, accepted_version_id = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(status, acceptedVersionId, now, id);
    return this.requireEditProposal(id);
  }

  listEditProposals(documentId: string): EditProposal[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM edit_proposals WHERE document_id = ? ORDER BY created_at DESC",
      )
      .all(documentId) as unknown as EditProposalRow[];
    return rows.map(mapEditProposal);
  }

  requireEditProposal(id: string): EditProposal {
    const row = this.database.raw
      .prepare("SELECT * FROM edit_proposals WHERE id = ?")
      .get(id) as EditProposalRow | undefined;
    if (!row) throw new PersistenceNotFoundError("edit_proposal", id);
    return mapEditProposal(row);
  }

  requireSessionDetail(id: string): CoCreateSessionDetail {
    const session = this.requireSession(id);
    const branchId = session.activeBranchId;
    return {
      session,
      participants: this.listParticipants(id).map((participant) => ({
        ...participant,
        persona: this.requirePersona(participant.personaId),
      })),
      branches: this.listBranches(id),
      turns: branchId ? this.listTurnsWithSwipes(branchId) : [],
      adoptions: this.listSceneAdoptions(id),
    };
  }

  private listLocalTurns(branchId: string): StoryTurn[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM story_turns WHERE branch_id = ? AND status != 'reverted'
         ORDER BY ordinal`,
      )
      .all(branchId) as unknown as TurnRow[];
    return rows.map(mapTurn);
  }

  private nextTurnOrdinal(branchId: string): number {
    const row = this.database.raw
      .prepare(
        "SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM story_turns WHERE branch_id = ?",
      )
      .get(branchId) as { ordinal: number };
    return row.ordinal;
  }

  private assertPersonaProject(projectId: string, personaId: string): void {
    const persona = this.requirePersona(personaId);
    if (persona.projectId !== projectId || persona.status !== "active") {
      throw new CreativePersistenceError(
        "persona.project.mismatch",
        "The persona does not belong to this project or has been disabled",
      );
    }
  }

  private assertOutlineNodeProject(
    projectId: string,
    outlineNodeId: string | null,
  ): void {
    if (!outlineNodeId) return;
    const row = this.database.raw
      .prepare("SELECT project_id FROM outline_nodes WHERE id = ?")
      .get(outlineNodeId) as { project_id: string } | undefined;
    if (!row || row.project_id !== projectId) {
      throw new CreativePersistenceError(
        "cocreate.target.mismatch",
        "The co-create target outline node does not belong to this project",
      );
    }
  }

  private assertEntityProject(
    projectId: string,
    entityId: string | null,
  ): void {
    if (!entityId) return;
    const row = this.database.raw
      .prepare("SELECT project_id FROM canon_entities WHERE id = ?")
      .get(entityId) as { project_id: string } | undefined;
    if (!row || row.project_id !== projectId) {
      throw new CreativePersistenceError(
        "persona.entity.mismatch",
        "The persona-bound entity does not belong to this project",
      );
    }
  }

  private requireSessionVersion(
    session: CoCreateSession,
    expectedVersion: number,
  ): void {
    this.requireVersion(
      session.version,
      expectedVersion,
      "cocreate.session.version.conflict",
      "The story room was updated elsewhere; refresh and try again",
    );
  }

  private requireVersion(
    actualVersion: number,
    expectedVersion: number,
    code: string,
    message: string,
  ): void {
    if (actualVersion !== expectedVersion) {
      throw new CreativePersistenceError(code, message);
    }
  }

  private throwSessionVersionConflict(): never {
    throw new CreativePersistenceError(
      "cocreate.session.version.conflict",
      "The story room was updated elsewhere; refresh and try again",
    );
  }
}

export class CreativePersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CreativePersistenceError";
  }
}

interface PersonaRow {
  id: string;
  project_id: string;
  kind: StoryPersona["kind"];
  entity_id: string | null;
  name: string;
  description: string | null;
  instructions: string;
  voice_json: string;
  status: StoryPersona["status"];
  created_at: string;
  updated_at: string;
  version: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  status: CoCreateSession["status"];
  speaker_policy: CoCreateSession["speakerPolicy"];
  active_branch_id: string | null;
  target_outline_node_id: string | null;
  author_persona_id: string | null;
  director_note: string | null;
  context_turns: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface ParticipantRow {
  session_id: string;
  persona_id: string;
  position: number;
  enabled: number;
  talkativeness: number;
  created_at: string;
}

interface BranchRow {
  id: string;
  session_id: string;
  parent_branch_id: string | null;
  forked_from_turn_id: string | null;
  name: string;
  status: StoryBranch["status"];
  head_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  project_id: string;
  session_id: string;
  branch_id: string;
  parent_turn_id: string | null;
  ordinal: number;
  role: StoryTurn["role"];
  persona_id: string | null;
  content: string;
  status: StoryTurn["status"];
  selected_swipe_id: string | null;
  source_run_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SwipeRow {
  id: string;
  turn_id: string;
  ordinal: number;
  content: string;
  speaker_persona_id: string | null;
  source_run_id: string | null;
  status: TurnSwipe["status"];
  metadata_json: string;
  created_at: string;
}

interface AdoptionRow {
  id: string;
  project_id: string;
  session_id: string;
  branch_id: string;
  from_turn_id: string;
  to_turn_id: string;
  outline_node_id: string;
  document_id: string;
  document_version_id: string;
  run_id: string;
  canon_change_set_id: string | null;
  created_at: string;
}

interface CommentRow {
  id: string;
  project_id: string;
  document_id: string;
  version_id: string;
  start_offset: number;
  end_offset: number;
  quote: string;
  body: string;
  status: DocumentComment["status"];
  created_at: string;
  updated_at: string;
}

interface EditProposalRow {
  id: string;
  project_id: string;
  document_id: string;
  base_version_id: string;
  run_id: string;
  instruction: string;
  selection_start: number;
  selection_end: number;
  original_text: string;
  replacement_text: string;
  proposed_content: string;
  diff_json: string;
  status: EditProposal["status"];
  accepted_version_id: string | null;
  created_at: string;
  decided_at: string | null;
}

function mapPersona(row: PersonaRow): StoryPersona {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    entityId: row.entity_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    voice: JSON.parse(row.voice_json) as Record<string, unknown>,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapSession(row: SessionRow): CoCreateSession {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    speakerPolicy: row.speaker_policy,
    activeBranchId: row.active_branch_id,
    targetOutlineNodeId: row.target_outline_node_id,
    authorPersonaId: row.author_persona_id,
    directorNote: row.director_note,
    contextTurns: row.context_turns,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapParticipant(row: ParticipantRow): CoCreateParticipant {
  return {
    sessionId: row.session_id,
    personaId: row.persona_id,
    position: row.position,
    enabled: Boolean(row.enabled),
    talkativeness: row.talkativeness,
    createdAt: row.created_at,
  };
}

function mapBranch(row: BranchRow): StoryBranch {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentBranchId: row.parent_branch_id,
    forkedFromTurnId: row.forked_from_turn_id,
    name: row.name,
    status: row.status,
    headTurnId: row.head_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTurn(row: TurnRow): StoryTurn {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    branchId: row.branch_id,
    parentTurnId: row.parent_turn_id,
    ordinal: row.ordinal,
    role: row.role,
    personaId: row.persona_id,
    content: row.content,
    status: row.status,
    selectedSwipeId: row.selected_swipe_id,
    sourceRunId: row.source_run_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSwipe(row: SwipeRow): TurnSwipe {
  return {
    id: row.id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    content: row.content,
    speakerPersonaId: row.speaker_persona_id,
    sourceRunId: row.source_run_id,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function mapAdoption(row: AdoptionRow): SceneAdoption {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    branchId: row.branch_id,
    fromTurnId: row.from_turn_id,
    toTurnId: row.to_turn_id,
    outlineNodeId: row.outline_node_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    runId: row.run_id,
    canonChangeSetId: row.canon_change_set_id,
    createdAt: row.created_at,
  };
}

function mapComment(row: CommentRow): DocumentComment {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
    versionId: row.version_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    quote: row.quote,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEditProposal(row: EditProposalRow): EditProposal {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
    baseVersionId: row.base_version_id,
    runId: row.run_id,
    instruction: row.instruction,
    selectionStart: row.selection_start,
    selectionEnd: row.selection_end,
    originalText: row.original_text,
    replacementText: row.replacement_text,
    proposedContent: row.proposed_content,
    diff: JSON.parse(row.diff_json) as Record<string, unknown>,
    status: row.status,
    acceptedVersionId: row.accepted_version_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
