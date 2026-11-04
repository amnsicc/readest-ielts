// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { DatabaseRow } from '@/types/database';
import type { ExerciseDefinition } from '@/services/learning/listening';
import fixed from '@/services/learning/fixedExercise.json';
import { LearningWorkspace } from '@/services/learning/workspace';
import { createDiskHost } from './diskHost';

it.each([
  'draft',
  'result',
])('retains write and recovery diagnostics for a failed %s', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'readest-stage3-fault-'));
  const host = createDiskHost(root);
  let armed = false;
  let failRead = false;
  const workspace = await LearningWorkspace.open({
    ...host,
    async openDatabase(...args) {
      const db = await host.openDatabase(...args);
      if (args[1] !== 'Learning/listening.db') return db;
      return {
        ...db,
        async execute(sql: string, params?: unknown[]) {
          if (armed && sql.includes('INSERT INTO listening_events')) {
            failRead = true;
            throw new Error('WRITE_FAILURE');
          }
          return db.execute(sql, params);
        },
        async select<T extends DatabaseRow>(sql: string, params?: unknown[]) {
          if (failRead) throw new Error('RECOVERY_READ_FAILURE');
          return db.select<T>(sql, params);
        },
      };
    },
  });
  try {
    const exercise = fixed as ExerciseDefinition;
    await workspace.registerExerciseVersion(exercise);
    const { currentRound } = await workspace.openExercise(exercise.exerciseId);
    const draft = {
      roundId: currentRound.roundId,
      expectedHeads: [],
      rawInputs: { 'ielts:entry:1:listening': '1、8' },
    };
    const operation = () =>
      kind === 'draft' ? workspace.saveDraft(draft) : workspace.checkRound(draft.roundId);
    if (kind === 'result') await workspace.saveDraft(draft);
    armed = true;
    const error = await operation().catch((value: unknown) => value);
    const closing = await workspace.close().catch((value: unknown) => value);
    armed = false;
    failRead = false;
    await operation();
    expect(error).toMatchObject({
      code: 'SAVE_FAILED',
      cause: { errors: [{ message: 'WRITE_FAILURE' }, { message: 'RECOVERY_READ_FAILURE' }] },
    });
    expect(closing).toBe(error);
    if (kind === 'draft') expect(error).toMatchObject({ draft: draft.rawInputs });
    await workspace.close();
    const reopened = await LearningWorkspace.open(host);
    expect((await reopened.getRound(draft.roundId)).rawInputs['ielts:entry:1:listening']).toBe(
      '1、8',
    );
    await reopened.close();
  } finally {
    await workspace.close();
    if (
      dirname(resolve(root)) === resolve(tmpdir()) &&
      basename(root).startsWith('readest-stage3-fault-')
    )
      await rm(root, { recursive: true, force: true });
  }
});
