// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LearningWorkspace } from '@/services/learning/workspace';
import type { ExerciseDefinition } from '@/services/learning/listening';
import type { DatabaseRow } from '@/types/database';
import fixed from '../../fixtures/data/listening-fixed-seven.json';
import { createDiskHost } from './diskHost';

let root: string;
let opened: LearningWorkspace[];
const definition: ExerciseDefinition = { ...fixed, ruleVersion: 'filled-events-v1' };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'readest-ielts-integrity-'));
  opened = [];
});
afterEach(async () => {
  for (const workspace of opened) await workspace.close();
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('readest-ielts-integrity-')
  )
    throw new Error('Refusing cleanup outside the isolated integrity fixture');
  await rm(root, { recursive: true, force: true });
});
async function open(host = createDiskHost(root)) {
  const workspace = await LearningWorkspace.open(host);
  opened.push(workspace);
  return workspace;
}

it('binds the fixed seven targets in original numbering order with manually checked answers', async () => {
  const workspace = await open();
  await workspace.registerExerciseVersion(definition);
  const exercise = await workspace.openExercise(definition.exerciseId);
  expect(
    exercise.definition.targets.map((target) => [
      target.originalNumber,
      target.word,
      target.correctNumbers,
    ]),
  ).toEqual([
    [1, 'atmosphere', [1]],
    [4, 'oxygen', [4]],
    [5, 'oxide', [6]],
    [6, 'carbon dioxide', [7]],
    [7, 'hydrogen', [5]],
    [8, 'core', [3]],
    [9, 'crust', [2]],
  ]);
  expect(exercise.definition.audioSha256).toBe(
    '128a967e08c895829efc24d5c1112d38b40585ce28e6ba2dc2f34ce25b4accee',
  );
  await workspace.saveDraft({
    roundId: exercise.currentRound.roundId,
    expectedHeads: [],
    rawInputs: {
      'ielts:entry:1:listening': '1',
      'ielts:entry:4:listening': '4',
      'ielts:entry:5:listening': '6',
      'ielts:entry:6:listening': '7',
      'ielts:entry:7:listening': '5',
      'ielts:entry:8:listening': '3',
      'ielts:entry:9:listening': '2',
    },
  });
  expect((await workspace.checkRound(exercise.currentRound.roundId)).result).toMatchObject({
    correct: 7,
    submitted: 7,
    percentage: 100,
    unmatchedExpected: 0,
  });
});

it('preserves the complete raw draft and close protection when the pre-save read fails', async () => {
  const base = createDiskHost(root);
  let failReads = false;
  const workspace = await open({
    ...base,
    async openDatabase(...args) {
      const db = await base.openDatabase(...args);
      return {
        ...db,
        async select<T extends DatabaseRow>(sql: string, params?: unknown[]) {
          if (failReads && sql.includes('listening_events')) throw new Error('READ_UNAVAILABLE');
          return db.select<T>(sql, params);
        },
      };
    },
  });
  await workspace.registerExerciseVersion(definition);
  const { currentRound } = await workspace.openExercise(definition.exerciseId);
  failReads = true;
  const rawInputs = { 'ielts:entry:1:listening': '1,？oops  ' };
  await expect(
    workspace.saveDraft({ roundId: currentRound.roundId, expectedHeads: [], rawInputs }),
  ).rejects.toMatchObject({
    code: 'SAVE_FAILED',
    draft: rawInputs,
    cause: { message: 'READ_UNAVAILABLE' },
  });
  await expect(workspace.close()).rejects.toMatchObject({ code: 'SAVE_FAILED', draft: rawInputs });
  failReads = false;
  await workspace.saveDraft({ roundId: currentRound.roundId, expectedHeads: [], rawInputs });
  expect(
    (await workspace.getRound(currentRound.roundId)).rawInputs['ielts:entry:1:listening'],
  ).toBe('1,？oops  ');
});

it('keeps accepted meanings and review marks intact while creating and reopening the separate listening store', async () => {
  const workspace = await open();
  await workspace.setPersonalMeaning({
    senseId: 'trial:crust',
    text: '已有个人释义',
    expectedHeads: [],
  });
  await workspace.setReviewMark({
    objectId: 'trial:crust',
    module: 'reading',
    marked: true,
    expectedHeads: [],
  });
  const before = await workspace.getSenseView('trial:crust');
  await workspace.registerExerciseVersion(definition);
  await workspace.openExercise(definition.exerciseId);
  await workspace.close();
  const reopened = await open();
  expect(await reopened.getSenseView('trial:crust')).toEqual(before);
  expect((await reopened.openExercise(definition.exerciseId)).rounds).toHaveLength(1);
  const db = await createDiskHost(root).openDatabase('check', 'Learning/learning.db', 'Data');
  expect(await db.select('PRAGMA user_version')).toEqual([{ user_version: 1 }]);
  await db.close();
});

it('refuses a future listening schema without resetting its version or stored records', async () => {
  const workspace = await open();
  await workspace.registerExerciseVersion(definition);
  await workspace.close();
  const db = await createDiskHost(root).openDatabase('check', 'Learning/listening.db', 'Data');
  await db.execute('PRAGMA user_version = 99');
  const before = await db.select('SELECT * FROM listening_events');
  const reopened = await open();
  await expect(reopened.openExercise(definition.exerciseId)).rejects.toMatchObject({
    code: 'SAVE_FAILED',
    cause: { code: 'UNSUPPORTED_VERSION' },
  });
  expect(await db.select('PRAGMA user_version')).toEqual([{ user_version: 99 }]);
  expect(await db.select('SELECT * FROM listening_events')).toEqual(before);
  // Repair only this isolated fixture and retry the same failed operation to clear close protection.
  await db.execute('PRAGMA user_version = 1');
  await db.close();
  await reopened.openExercise(definition.exerciseId);
});

it.each([
  'wrong-kind',
  'wrong-input-type',
  'wrong-score',
  'wrong-audio',
])('rejects a persisted %s record without hiding or rewriting it', async (damage) => {
  const workspace = await open();
  await workspace.registerExerciseVersion(definition);
  const { currentRound } = await workspace.openExercise(definition.exerciseId);
  await workspace.saveDraft({
    roundId: currentRound.roundId,
    expectedHeads: [],
    rawInputs: { 'ielts:entry:1:listening': '1' },
  });
  await workspace.checkRound(currentRound.roundId);
  await workspace.close();
  const db = await createDiskHost(root).openDatabase('damage', 'Learning/listening.db', 'Data');
  const [row] = await db.select<{ event_id: string; payload_json: string }>(
    'SELECT event_id, payload_json FROM listening_events WHERE event_id = ?',
    [`result/${currentRound.roundId}`],
  );
  const payload = JSON.parse(row!.payload_json);
  if (damage === 'wrong-kind') payload.kind = 'draft';
  if (damage === 'wrong-input-type') payload.result.rawInputs['ielts:entry:1:listening'] = 1;
  if (damage === 'wrong-score') payload.result.correct = 999;
  if (damage === 'wrong-audio') payload.result.audioSha256 = 'b'.repeat(64);
  const damaged = JSON.stringify(payload);
  await db.execute('UPDATE listening_events SET payload_json = ? WHERE event_id = ?', [
    damaged,
    row!.event_id,
  ]);
  const reopened = await open();
  await expect(reopened.getRound(currentRound.roundId)).rejects.toMatchObject({
    code: 'SAVE_FAILED',
    cause: { code: 'CORRUPT_DATA' },
  });
  expect(
    (
      await db.select<{ payload_json: string }>(
        'SELECT payload_json FROM listening_events WHERE event_id = ?',
        [row!.event_id],
      )
    )[0]!.payload_json,
  ).toBe(damaged);
  await db.execute('UPDATE listening_events SET payload_json = ? WHERE event_id = ?', [
    row!.payload_json,
    row!.event_id,
  ]);
  await db.close();
  expect((await reopened.getRound(currentRound.roundId)).result).toMatchObject({
    correct: 1,
    submitted: 1,
    percentage: 100,
  });
});
