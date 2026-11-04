import type { DatabaseService } from '@/types/database';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { LearningHost } from './types';
import { LearningConflictError } from './revisions';
import { eventKeys, validateListeningHistory } from './listeningHistory';
import { calculateFilled, listeningEventSchema, ListeningError } from './listening';
import type {
  DraftInput,
  ExerciseDefinition,
  ExerciseView,
  ListeningEvent,
  RoundView,
} from './listening';

export class ListeningStore {
  private constructor(private readonly db: DatabaseService) {}
  static async open(host: LearningHost): Promise<ListeningStore> {
    const db = await host.openDatabase('listening-inspect', 'Learning/listening.db', 'Data');
    try {
      const migrations = getMigrations('listening');
      const version = await db.select<{ user_version: number }>('PRAGMA user_version');
      if (version[0]!.user_version > migrations.length)
        throw Object.assign(
          new Error('A newer application is required for this listening database.'),
          { code: 'UNSUPPORTED_VERSION' },
        );
      await migrate(db, migrations);
      const store = new ListeningStore(db);
      await store.read();
      return store;
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  private async read(): Promise<ListeningEvent[]> {
    const rows = await this.db.select<{ event_id: string; slot: string; payload_json: string }>(
      'SELECT event_id, slot, payload_json FROM listening_events ORDER BY rowid',
    );
    try {
      const events = rows.map((row) => {
        const event = listeningEventSchema.parse(JSON.parse(row.payload_json));
        const keys = eventKeys(event);
        if (row.event_id !== keys.id || row.slot !== keys.slot)
          throw new Error('Listening storage identity mismatch');
        return event;
      });
      validateListeningHistory(events);
      return events;
    } catch (cause) {
      throw Object.assign(
        new Error('Saved listening records are damaged; data retained.', { cause }),
        { code: 'CORRUPT_DATA' },
      );
    }
  }
  private async append(id: string, slot: string, event: ListeningEvent) {
    const checked = listeningEventSchema.parse(event);
    validateListeningHistory([...(await this.read()), checked]);
    const payload = JSON.stringify(checked);
    if (checked.kind === 'result') {
      const prefix = `draft-base/${checked.result.roundId}/`;
      const expected = checked.result.draftHeads[0] ? `draft/${checked.result.draftHeads[0]}` : '';
      const result = await this.db.execute(
        `INSERT INTO listening_events (event_id, slot, payload_json) SELECT ?, ?, ?
         WHERE COALESCE((SELECT event_id FROM listening_events WHERE substr(slot, 1, ?) = ? ORDER BY rowid DESC LIMIT 1), '') = ?`,
        [id, slot, payload, prefix.length, prefix, expected],
      );
      if (result.rowsAffected !== 1)
        throw new ListeningError(
          'CONFLICT',
          'The draft changed during checking. Review it and check again.',
        );
      return;
    }
    await this.db.execute(
      'INSERT INTO listening_events (event_id, slot, payload_json) VALUES (?, ?, ?)',
      [id, slot, payload],
    );
  }
  async register(definition: ExerciseDefinition) {
    const events = await this.read();
    const existing = events.find(
      (e) =>
        e.kind === 'definition' && e.definition.exerciseVersionId === definition.exerciseVersionId,
    );
    if (existing?.kind === 'definition') {
      if (JSON.stringify(existing.definition) !== JSON.stringify(definition))
        throw new ListeningError(
          'CONFLICT',
          'An immutable exercise version already has different content.',
        );
      return { exerciseVersionId: definition.exerciseVersionId, durable: true as const };
    }
    const current = events
      .filter((e) => e.kind === 'definition' && e.definition.exerciseId === definition.exerciseId)
      .at(-1);
    if (
      (current?.kind === 'definition' ? current.definition.exerciseVersionId : null) !==
      definition.previousVersionId
    )
      throw new ListeningError('CONFLICT', 'The exercise predecessor changed.');
    try {
      validateListeningHistory([...events, { kind: 'definition', definition }]);
    } catch (cause) {
      throw new ListeningError(
        'CONFLICT',
        cause instanceof Error ? cause.message : 'Incompatible exercise version identities.',
      );
    }
    try {
      await this.append(
        `definition/${definition.exerciseVersionId}`,
        `definition-base/${definition.exerciseId}/${definition.previousVersionId ?? '-'}`,
        { kind: 'definition', definition },
      );
    } catch (error) {
      const latest = await this.read();
      const repeated = latest.find(
        (e) =>
          e.kind === 'definition' &&
          e.definition.exerciseVersionId === definition.exerciseVersionId,
      );
      if (
        repeated?.kind === 'definition' &&
        JSON.stringify(repeated.definition) === JSON.stringify(definition)
      )
        return { exerciseVersionId: definition.exerciseVersionId, durable: true as const };
      if (latest.length !== events.length)
        throw new ListeningError('CONFLICT', 'The exercise registration changed concurrently.');
      throw error;
    }
    return { exerciseVersionId: definition.exerciseVersionId, durable: true as const };
  }
  private view(events: ListeningEvent[], roundId: string): RoundView {
    const round = events.find((e) => e.kind === 'round' && e.roundId === roundId);
    if (!round || round.kind !== 'round')
      throw new ListeningError('NOT_FOUND', 'Listening round not found.');
    const version = events.find(
      (e) => e.kind === 'definition' && e.definition.exerciseVersionId === round.exerciseVersionId,
    );
    if (!version || version.kind !== 'definition')
      throw new ListeningError('NOT_FOUND', 'Exercise version not found.');
    const drafts = events.filter((e) => e.kind === 'draft' && e.roundId === roundId);
    const latest = drafts.at(-1);
    const result = events.find((e) => e.kind === 'result' && e.result.roundId === roundId);
    return {
      roundId,
      exerciseId: round.exerciseId,
      definition: version.definition,
      rawInputs:
        latest?.kind === 'draft'
          ? latest.rawInputs
          : Object.fromEntries(version.definition.targets.map((target) => [target.targetId, ''])),
      draftHeads: latest?.kind === 'draft' ? [latest.revisionId] : [],
      result: result?.kind === 'result' ? result.result : null,
    };
  }
  async getRound(roundId: string) {
    return this.view(await this.read(), roundId);
  }
  async openExercise(exerciseId: string): Promise<ExerciseView> {
    let events = await this.read();
    const versions = events.filter(
      (e) => e.kind === 'definition' && e.definition.exerciseId === exerciseId,
    );
    const current = versions.at(-1);
    if (!current || current.kind !== 'definition')
      throw new ListeningError('NOT_FOUND', 'Listening exercise not found.');
    let rounds = events.filter((e) => e.kind === 'round' && e.exerciseId === exerciseId);
    if (!rounds.length) {
      const roundId = crypto.randomUUID();
      try {
        await this.append(`round/${roundId}`, `round-base/${exerciseId}/-`, {
          kind: 'round',
          roundId,
          exerciseId,
          exerciseVersionId: current.definition.exerciseVersionId,
          previousRoundId: null,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        const winner = (await this.read()).some(
          (e) => e.kind === 'round' && e.exerciseId === exerciseId,
        );
        if (!winner) throw error;
      }
      events = await this.read();
      rounds = events.filter((e) => e.kind === 'round' && e.exerciseId === exerciseId);
    }
    const views = rounds.filter((e) => e.kind === 'round').map((e) => this.view(events, e.roundId));
    return { definition: current.definition, currentRound: views.at(-1)!, rounds: views };
  }
  async saveDraft(input: DraftInput) {
    const round = await this.getRound(input.roundId);
    const targetIds = new Set(round.definition.targets.map((target) => target.targetId));
    if (Object.keys(input.rawInputs).some((id) => !targetIds.has(id)))
      throw new ListeningError('INVALID_INPUT', 'The draft contains an unknown target.');
    if (JSON.stringify(round.draftHeads) !== JSON.stringify(input.expectedHeads))
      throw new LearningConflictError(round.draftHeads, input.rawInputs);
    const revisionId = crypto.randomUUID();
    const rawInputs = Object.fromEntries(
      round.definition.targets.map((target) => [
        target.targetId,
        Object.hasOwn(input.rawInputs, target.targetId) ? input.rawInputs[target.targetId]! : '',
      ]),
    );
    try {
      await this.append(
        `draft/${revisionId}`,
        `draft-base/${input.roundId}/${input.expectedHeads[0] ?? '-'}`,
        {
          kind: 'draft',
          roundId: input.roundId,
          revisionId,
          previousRevisionId: input.expectedHeads[0] ?? null,
          rawInputs,
        },
      );
    } catch (error) {
      const latest = await this.readAfterWriteFailure(input.roundId, error);
      if (JSON.stringify(latest.draftHeads) !== JSON.stringify(input.expectedHeads))
        throw new LearningConflictError(latest.draftHeads, input.rawInputs);
      throw error;
    }
    return { revisionId, durable: true as const };
  }
  async startNewRound(exerciseId: string): Promise<RoundView> {
    const alreadyStarted = (await this.read()).some(
      (e) => e.kind === 'round' && e.exerciseId === exerciseId,
    );
    const exercise = await this.openExercise(exerciseId);
    if (!alreadyStarted) return exercise.currentRound;
    const roundId = crypto.randomUUID();
    await this.append(
      `round/${roundId}`,
      `round-base/${exerciseId}/${exercise.currentRound.roundId}`,
      {
        kind: 'round',
        roundId,
        exerciseId,
        exerciseVersionId: exercise.definition.exerciseVersionId,
        previousRoundId: exercise.currentRound.roundId,
        createdAt: new Date().toISOString(),
      },
    );
    return this.getRound(roundId);
  }
  async checkRound(roundId: string) {
    const round = await this.getRound(roundId);
    if (round.result) return round;
    const { definition } = round;
    const result = {
      resultId: `result:${roundId}`,
      roundId,
      checkedAt: new Date().toISOString(),
      exerciseVersionId: definition.exerciseVersionId,
      materialVersionId: definition.materialVersionId,
      audioAssetId: definition.audioAssetId,
      audioSha256: definition.audioSha256,
      answerVersionId: definition.answerVersionId,
      ruleVersion: definition.ruleVersion,
      rawInputs: round.rawInputs,
      draftHeads: round.draftHeads,
      ...calculateFilled(definition, round.rawInputs),
    };
    try {
      await this.append(`result/${roundId}`, `result/${roundId}`, { kind: 'result', result });
    } catch (error) {
      const winner = await this.readAfterWriteFailure(roundId, error);
      if (winner.result) return winner;
      throw error;
    }
    return this.getRound(roundId);
  }
  private async readAfterWriteFailure(roundId: string, writeError: unknown) {
    try {
      return await this.getRound(roundId);
    } catch (readError) {
      throw new AggregateError(
        [writeError, readError],
        'Writing and the recovery read both failed.',
      );
    }
  }
  async close() {
    await this.db.close();
  }
}
