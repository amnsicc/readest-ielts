// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningWorkspace } from '@/services/learning/workspace';
import type { ExerciseDefinition } from '@/services/learning/listening';
import { createDiskHost } from './diskHost';

// Independent hand-calculated S01–S10 fixture. Not the fixed seven-target recording.
const definition: ExerciseDefinition = {
  exerciseId: 'fixture:counting',
  exerciseVersionId: 'fixture:counting:v1',
  previousVersionId: null,
  materialVersionId: 'fixture:material:v1',
  audioAssetId: 'fixture:audio:v1',
  audioSha256: 'a'.repeat(64),
  answerVersionId: 'fixture:answers:v1',
  ruleVersion: 'filled-events-v1' as const,
  targets: [
    { targetId: 'alpha', originalNumber: 1, word: 'alpha', correctNumbers: [2, 7, 11] },
    { targetId: 'beta', originalNumber: 2, word: 'beta', correctNumbers: [1, 3, 5, 8] },
    { targetId: 'gamma', originalNumber: 3, word: 'gamma', correctNumbers: [4, 6, 9, 10] },
  ],
};

describe('listening through the public workspace on real disk', () => {
  let root: string;
  let opened: LearningWorkspace[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'readest-ielts-listening-'));
    opened = [];
  });
  afterEach(async () => {
    for (const workspace of opened) await workspace.close();
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('readest-ielts-listening-')
    ) {
      throw new Error('Refusing cleanup outside the isolated listening fixture');
    }
    await rm(root, { recursive: true, force: true });
  });
  async function open() {
    const workspace = await LearningWorkspace.open(createDiskHost(root));
    opened.push(workspace);
    return workspace;
  }
  it('S03 counts an extra nonexistent number as wrong: 3/4 = 75%', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const exercise = await workspace.openExercise('fixture:counting');
    await workspace.saveDraft({
      roundId: exercise.currentRound.roundId,
      rawInputs: { alpha: '2、7、11、12' },
      expectedHeads: exercise.currentRound.draftHeads,
    });
    const round = await workspace.checkRound(exercise.currentRound.roundId);
    expect(round.result).toMatchObject({
      correct: 3,
      submitted: 4,
      percentage: 75,
      rawInputs: { alpha: '2、7、11、12', beta: '', gamma: '' },
      ruleVersion: 'filled-events-v1',
    });
  });

  it('S05 preserves question marks and reports no computed percentage', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '?', beta: '？' },
      expectedHeads: [],
    });
    expect((await workspace.checkRound(currentRound.roundId)).result).toMatchObject({
      correct: 0,
      submitted: 0,
      percentage: null,
      rawInputs: { alpha: '?', beta: '？', gamma: '' },
    });
  });

  it('S08 retains unparsable input as a saved draft but refuses to score it', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,hello,-1,2.5' },
      expectedHeads: [],
    });
    await expect(workspace.checkRound(currentRound.roundId)).rejects.toMatchObject({
      code: 'INVALID_ANSWER',
      issues: [
        { targetId: 'alpha', token: 'hello' },
        { targetId: 'alpha', token: '-1' },
        { targetId: 'alpha', token: '2.5' },
      ],
    });
    const stored = await workspace.getRound(currentRound.roundId);
    expect(stored.result).toBeNull();
    expect(stored.rawInputs['alpha']).toBe('2,hello,-1,2.5');
    await workspace.close();
    expect((await (await open()).getRound(currentRound.roundId)).rawInputs['alpha']).toBe(
      '2,hello,-1,2.5',
    );
  });

  it('S09 freezes the first result while corrections and a deliberate new round remain separate', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    const draft = await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,7,11,12' },
      expectedHeads: [],
    });
    const first = await workspace.checkRound(currentRound.roundId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,7,11' },
      expectedHeads: [draft.revisionId],
    });
    expect((await workspace.checkRound(currentRound.roundId)).result).toEqual(first.result);
    const next = await workspace.startNewRound(definition.exerciseId);
    expect(next.roundId).not.toBe(currentRound.roundId);
    expect(next.rawInputs).toEqual({ alpha: '', beta: '', gamma: '' });
    expect(next.result).toBeNull();
    await workspace.close();
    const reopened = await open();
    const resumed = await reopened.openExercise(definition.exerciseId);
    expect(resumed.currentRound.roundId).toBe(next.roundId);
    expect(resumed.rounds).toHaveLength(2);
    expect((await reopened.getRound(currentRound.roundId)).result).toEqual(first.result);
    expect((await reopened.getRound(currentRound.roundId)).rawInputs['alpha']).toBe('2,7,11');
  });

  it('S02 shows partial submission scope, blank rows, and unfilled expected events', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,7' },
      expectedHeads: [],
    });
    expect((await workspace.checkRound(currentRound.roundId)).result).toMatchObject({
      correct: 2,
      submitted: 2,
      percentage: 100,
      scope: 'filled-events',
      label: '已填写序号准确率',
      totalExpected: 11,
      unmatchedExpected: 9,
      blankTargetIds: ['beta', 'gamma'],
    });
  });

  it('S10 makes same-version registration idempotent and keeps results tied to old answers', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,7,11,12' },
      expectedHeads: [],
    });
    const checked = await workspace.checkRound(currentRound.roundId);
    await workspace.registerExerciseVersion(structuredClone(definition));
    const v2 = {
      ...structuredClone(definition),
      exerciseVersionId: 'fixture:counting:v2',
      previousVersionId: definition.exerciseVersionId,
      materialVersionId: 'fixture:material:v2',
      audioAssetId: 'fixture:audio:v2',
      audioSha256: 'b'.repeat(64),
      answerVersionId: 'fixture:answers:v2',
      targets: [
        { ...definition.targets[0]!, correctNumbers: [1, 2, 3] },
        { ...definition.targets[1]!, correctNumbers: [4, 5, 6, 7] },
        { ...definition.targets[2]!, correctNumbers: [8, 9, 10, 11] },
      ],
    };
    await workspace.registerExerciseVersion(v2);
    await workspace.registerExerciseVersion(definition); // Old metadata cannot roll the active version back.
    const resumed = await workspace.openExercise(definition.exerciseId);
    expect(resumed.currentRound.roundId).toBe(currentRound.roundId);
    expect(resumed.rounds).toHaveLength(1);
    expect(resumed.currentRound.result).toEqual(checked.result);
    expect(resumed.currentRound.result).toMatchObject({
      correct: 3,
      submitted: 4,
      answerVersionId: 'fixture:answers:v1',
      audioSha256: 'a'.repeat(64),
    });
    const next = await workspace.startNewRound(definition.exerciseId);
    expect(next.definition.exerciseVersionId).toBe(v2.exerciseVersionId);
    await expect(
      workspace.registerExerciseVersion({ ...definition, audioSha256: 'c'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('retains a stale filling draft as a conflict instead of overwriting a newer submission', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    const first = await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2' },
      expectedHeads: [],
    });
    await expect(
      workspace.saveDraft({
        roundId: currentRound.roundId,
        rawInputs: { alpha: '7' },
        expectedHeads: [],
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      draft: { alpha: '7' },
      currentHeads: [first.revisionId],
    });
    expect((await workspace.getRound(currentRound.roundId)).rawInputs['alpha']).toBe('2');
  });

  it('keeps exactly one persisted result when independent connections check the same round', async () => {
    const base = createDiskHost(root);
    let gateEnabled = false;
    let waiting = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = {
      ...base,
      async openDatabase(...args: Parameters<typeof base.openDatabase>) {
        const db = await base.openDatabase(...args);
        return {
          ...db,
          async execute(sql: string, params?: unknown[]) {
            if (gateEnabled) {
              waiting++;
              if (waiting === 2) release();
              await gate;
            }
            return db.execute(sql, params);
          },
        };
      },
    };
    const first = await LearningWorkspace.open(host);
    opened.push(first);
    await first.registerExerciseVersion(definition);
    const { currentRound } = await first.openExercise(definition.exerciseId);
    await first.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,7,11' },
      expectedHeads: [],
    });
    const second = await LearningWorkspace.open(host);
    opened.push(second);
    await second.getRound(currentRound.roundId);
    gateEnabled = true; // Force both connections to reach the write boundary before either commits.
    const results = await Promise.all([
      first.checkRound(currentRound.roundId),
      second.checkRound(currentRound.roundId),
    ]);
    expect(results[0]!.result).toEqual(results[1]!.result);
    expect((await second.openExercise(definition.exerciseId)).rounds).toHaveLength(1);
  });

  it('does not silently drop input attached to an unknown target', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await expect(
      workspace.saveDraft({
        roundId: currentRound.roundId,
        rawInputs: { alpha: '2', typo: '99' },
        expectedHeads: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await workspace.getRound(currentRound.roundId)).draftHeads).toEqual([]);
  });

  it.each([
    ['S01', { alpha: '2,7,11', beta: '1,3,5,8', gamma: '4,6,9,10' }, 11, 11, 100],
    ['S04', { alpha: '1' }, 0, 1, 0],
    ['S06', { alpha: '2，7、11 ' }, 3, 3, 100],
    ['S07', { alpha: '2,2,7,11' }, 3, 3, 100],
    ['S05-empty', {}, 0, 0, null],
    ['mixed-question', { alpha: '2 ?' }, 1, 1, 100],
  ] as const)('%s uses the independent fixture expected count', async (_name, rawInputs, correct, submitted, percentage) => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { ...rawInputs },
      expectedHeads: [],
    });
    const round = await workspace.checkRound(currentRound.roundId);
    expect(round.result).toMatchObject({ correct, submitted, percentage });
    if (_name === 'S07')
      expect(round.result?.duplicates).toEqual([{ targetId: 'alpha', number: 2 }]);
  });

  it.each([
    '0',
    '-2',
    '1.5',
    '2147483648',
    '1e2',
    'not-a-number',
  ])('S08 refuses invalid token %s without discarding it', async (token) => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: `2,${token}` },
      expectedHeads: [],
    });
    await expect(workspace.checkRound(currentRound.roundId)).rejects.toMatchObject({
      code: 'INVALID_ANSWER',
    });
    expect((await workspace.getRound(currentRound.roundId)).result).toBeNull();
  });

  it('rejects an ambiguous answer definition before it can inflate or distort the count', async () => {
    const workspace = await open();
    const invalid = structuredClone(definition);
    invalid.targets[0]!.correctNumbers = [2, 2, 7];
    await expect(workspace.registerExerciseVersion(invalid)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await workspace.registerExerciseVersion(definition);
    expect((await workspace.openExercise(definition.exerciseId)).definition).toEqual(definition);
  });

  it('refuses an orphaned saved draft rather than silently ignoring damaged listening history', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    await workspace.close();
    const fixture = await createDiskHost(root).openDatabase(
      'fixture',
      'Learning/listening.db',
      'Data',
    );
    await fixture.execute('INSERT INTO listening_events VALUES (?, ?, ?)', [
      'draft/orphan',
      'draft-base/missing/root',
      JSON.stringify({
        kind: 'draft',
        roundId: 'missing',
        revisionId: 'orphan',
        previousRevisionId: null,
        rawInputs: { alpha: '2' },
      }),
    ]);
    await fixture.close();
    const reopened = await open();
    const failure = await reopened
      .openExercise(definition.exerciseId)
      .catch((error: unknown) => error);
    const repair = await createDiskHost(root).openDatabase(
      'fixture',
      'Learning/listening.db',
      'Data',
    );
    await repair.execute('DELETE FROM listening_events WHERE event_id = ?', ['draft/orphan']);
    await repair.close();
    await reopened.openExercise(definition.exerciseId);
    expect(failure).toMatchObject({ code: 'SAVE_FAILED', cause: { code: 'CORRUPT_DATA' } });
  });

  it('does not commit a result for an old draft after another connection saves a newer draft', async () => {
    const base = createDiskHost(root);
    let pause = false;
    let reachedWrite = () => {};
    let resumeWrite = () => {};
    const reached = new Promise<void>((done) => {
      reachedWrite = done;
    });
    const resumed = new Promise<void>((done) => {
      resumeWrite = done;
    });
    const host = {
      ...base,
      async openDatabase(...args: Parameters<typeof base.openDatabase>) {
        const db = await base.openDatabase(...args);
        return {
          ...db,
          async execute(sql: string, params?: unknown[]) {
            if (pause) {
              pause = false;
              reachedWrite();
              await resumed;
            }
            return db.execute(sql, params);
          },
        };
      },
    };
    const checking = await LearningWorkspace.open(host);
    opened.push(checking);
    await checking.registerExerciseVersion(definition);
    const { currentRound } = await checking.openExercise(definition.exerciseId);
    const saved = await checking.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2' },
      expectedHeads: [],
    });
    const editing = await open();
    await editing.getRound(currentRound.roundId);
    pause = true;
    const outcome = checking.checkRound(currentRound.roundId).catch((error: unknown) => error);
    await reached;
    await editing.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '7' },
      expectedHeads: [saved.revisionId],
    });
    resumeWrite();
    const result = await outcome;
    expect(result).toMatchObject({ code: 'CONFLICT' });
    expect((await editing.getRound(currentRound.roundId)).result).toBeNull();
    expect((await checking.checkRound(currentRound.roundId)).result?.rawInputs['alpha']).toBe('7');
  });

  it('opens the same first round when two connections arrive at the write boundary together', async () => {
    const base = createDiskHost(root);
    let enabled = false;
    let waiting = 0;
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const host = {
      ...base,
      async openDatabase(...args: Parameters<typeof base.openDatabase>) {
        const db = await base.openDatabase(...args);
        return {
          ...db,
          async execute(sql: string, params?: unknown[]) {
            if (enabled) {
              if (++waiting === 2) release();
              await gate;
            }
            return db.execute(sql, params);
          },
        };
      },
    };
    const first = await LearningWorkspace.open(host);
    opened.push(first);
    const second = await LearningWorkspace.open(host);
    opened.push(second);
    await first.registerExerciseVersion(definition);
    await second.registerExerciseVersion(definition);
    enabled = true;
    const rounds = await Promise.all([
      first.openExercise(definition.exerciseId),
      second.openExercise(definition.exerciseId),
    ]);
    expect(rounds[0]!.currentRound.roundId).toBe(rounds[1]!.currentRound.roundId);
    expect(rounds[0]!.rounds).toHaveLength(1);
  });

  it('starts exactly one round if new-round is the first action on a registered exercise', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    const round = await workspace.startNewRound(definition.exerciseId);
    const exercise = await workspace.openExercise(definition.exerciseId);
    expect(exercise.rounds).toHaveLength(1);
    expect(exercise.currentRound.roundId).toBe(round.roundId);
  });

  it('retains a failed filling draft and refuses close until it has been saved', async () => {
    let failWrites = false;
    const workspace = await LearningWorkspace.open(
      createDiskHost(root, { failWrites: () => failWrites }),
    );
    opened.push(workspace);
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    failWrites = true;
    await expect(
      workspace.saveDraft({
        roundId: currentRound.roundId,
        rawInputs: { alpha: '2,7' },
        expectedHeads: [],
      }),
    ).rejects.toMatchObject({ code: 'SAVE_FAILED', draft: { alpha: '2,7' } });
    await expect(workspace.close()).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      draft: { alpha: '2,7' },
    });
    failWrites = false;
    expect((await workspace.getRound(currentRound.roundId)).draftHeads).toEqual([]);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,7' },
      expectedHeads: [],
    });
    await workspace.close();
    expect(
      (await (await open()).openExercise(definition.exerciseId)).currentRound.rawInputs['alpha'],
    ).toBe('2,7');
  });

  it('does not create a result or erase inputs when saving the checked result fails', async () => {
    let failWrites = false;
    const workspace = await LearningWorkspace.open(
      createDiskHost(root, { failWrites: () => failWrites }),
    );
    opened.push(workspace);
    await workspace.registerExerciseVersion(definition);
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { alpha: '2,7,11,12' },
      expectedHeads: [],
    });
    failWrites = true;
    await expect(workspace.checkRound(currentRound.roundId)).rejects.toMatchObject({
      code: 'SAVE_FAILED',
    });
    failWrites = false;
    expect((await workspace.getRound(currentRound.roundId)).result).toBeNull();
    expect((await workspace.checkRound(currentRound.roundId)).result).toMatchObject({
      correct: 3,
      submitted: 4,
      percentage: 75,
    });
  });

  it('validates answer and audio identities independently of exercise version identity', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion(definition);
    await expect(
      workspace.registerExerciseVersion({
        ...definition,
        exerciseVersionId: 'fixture:bad-audio',
        previousVersionId: definition.exerciseVersionId,
        audioSha256: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const changed = structuredClone(definition);
    changed.exerciseVersionId = 'fixture:bad-answer';
    changed.previousVersionId = definition.exerciseVersionId;
    changed.targets[0]!.correctNumbers = [1, 7, 11];
    changed.targets[1]!.correctNumbers = [2, 3, 5, 8];
    await expect(workspace.registerExerciseVersion(changed)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await workspace.openExercise(definition.exerciseId)).definition).toEqual(definition);
  });

  it('can extend an exercise whose legitimate version identity is root', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion({ ...definition, exerciseVersionId: 'root' });
    await workspace.registerExerciseVersion({
      ...definition,
      exerciseVersionId: 'fixture:next',
      previousVersionId: 'root',
    });
    expect((await workspace.openExercise(definition.exerciseId)).definition.exerciseVersionId).toBe(
      'fixture:next',
    );
  });

  it('treats an omitted target named constructor as an empty draft', async () => {
    const workspace = await open();
    await workspace.registerExerciseVersion({
      ...definition,
      targets: definition.targets.map((target) =>
        target.targetId === 'alpha' ? { ...target, targetId: 'constructor' } : target,
      ),
    });
    const { currentRound } = await workspace.openExercise(definition.exerciseId);
    await workspace.saveDraft({
      roundId: currentRound.roundId,
      rawInputs: { beta: '1' },
      expectedHeads: [],
    });
    expect((await workspace.getRound(currentRound.roundId)).rawInputs['constructor']).toBe('');
    expect((await workspace.checkRound(currentRound.roundId)).result).toMatchObject({
      correct: 1,
      submitted: 1,
      percentage: 100,
    });
  });

  it('does not let callers mutate saved definitions, returned results, or queued inputs', async () => {
    const workspace = await open();
    const input = structuredClone(definition);
    const registering = workspace.registerExerciseVersion(input);
    input.targets[0]!.correctNumbers[0] = 999;
    await registering;
    const exercise = await workspace.openExercise(definition.exerciseId);
    exercise.definition.targets[0]!.correctNumbers[0] = 999;
    const rawInputs = { alpha: '2,7' };
    const expectedHeads: string[] = [];
    const saving = workspace.saveDraft({
      roundId: exercise.currentRound.roundId,
      rawInputs,
      expectedHeads,
    });
    rawInputs.alpha = '999';
    expectedHeads.push('fake');
    await saving;
    const checked = await workspace.checkRound(exercise.currentRound.roundId);
    checked.result!.correct = 999;
    checked.result!.rawInputs['alpha'] = '999';
    expect((await workspace.getRound(exercise.currentRound.roundId)).result).toMatchObject({
      correct: 2,
      submitted: 2,
      rawInputs: { alpha: '2,7' },
    });
  });
});
