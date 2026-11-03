// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningWorkspace } from '@/services/learning/workspace';
import { createDiskHost } from './diskHost';

describe('learning workspace on isolated disk storage', () => {
  let root: string;
  let workspaces: LearningWorkspace[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'readest-ielts-'));
    workspaces = [];
  });

  afterEach(async () => {
    for (const workspace of workspaces) await workspace.close();
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('readest-ielts-')
    ) {
      throw new Error('Refusing cleanup outside the isolated test directory');
    }
    await rm(root, { recursive: true, force: true });
  });

  async function open() {
    const workspace = await LearningWorkspace.open(createDiskHost(root));
    workspaces.push(workspace);
    return workspace;
  }

  it('reads the saved personal meaning after closing and opening another instance', async () => {
    const first = await open();
    const saved = await first.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '我记作：地球的外层',
      expectedHeads: [],
    });
    expect(saved.durable).toBe(true);
    await first.close();

    const reopened = await open();
    expect(await reopened.getSenseView('trial:sense:crust:earth')).toMatchObject({
      personalMeaning: '我记作：地球的外层',
      meaningHeads: [saved.revisionId],
    });
    expect(await reopened.getSenseView('trial:sense:crust:bread')).toMatchObject({
      personalMeaning: null,
      meaningHeads: [],
    });
  });

  it('keeps a review mark in its own module across reopening', async () => {
    const first = await open();
    const saved = await first.setReviewMark({
      objectId: 'trial:sense:crust:earth',
      module: 'reading',
      marked: true,
      expectedHeads: [],
    });
    await first.close();
    const reopened = await open();
    expect((await reopened.getSenseView('trial:sense:crust:earth')).reviewMarks).toMatchObject({
      reading: { marked: true, heads: [saved.revisionId] },
      listening: { marked: false, heads: [] },
    });
  });

  it('preserves the newer meaning and returns the stale draft instead of overwriting it', async () => {
    const workspace = await open();
    const first = await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '旧解释',
      expectedHeads: [],
    });
    await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '较新的解释',
      expectedHeads: [first.revisionId],
    });
    await expect(
      workspace.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '另一个窗口还在写的草稿',
        expectedHeads: [first.revisionId],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', draft: '另一个窗口还在写的草稿' });
    expect((await workspace.getSenseView('trial:sense:crust:earth')).personalMeaning).toBe(
      '较新的解释',
    );
  });

  it('allows only one concurrent edit from the same device baseline', async () => {
    const workspace = await open();
    const outcomes = await Promise.allSettled([
      workspace.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '窗口甲',
        expectedHeads: [],
      }),
      workspace.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '窗口乙',
        expectedHeads: [],
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect((await workspace.getSenseView('trial:sense:crust:earth')).meaningHeads).toHaveLength(1);
  });

  it('protects the same baseline across two workspace instances sharing one device directory', async () => {
    const first = await open();
    const second = await open();
    const outcomes = await Promise.allSettled([
      first.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '实例甲',
        expectedHeads: [],
      }),
      second.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '实例乙',
        expectedHeads: [],
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await first.getSenseView('trial:sense:crust:earth')).meaningHeads).toHaveLength(1);
  });

  it('reports failed saving with its draft, preserves the saved value, and permits retry', async () => {
    let failWrites = false;
    const workspace = await LearningWorkspace.open(
      createDiskHost(root, { failWrites: () => failWrites }),
    );
    workspaces.push(workspace);
    const first = await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '已保存',
      expectedHeads: [],
    });
    failWrites = true;
    await expect(
      workspace.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '尚未保存的草稿',
        expectedHeads: [first.revisionId],
      }),
    ).rejects.toMatchObject({ code: 'SAVE_FAILED', draft: '尚未保存的草稿' });
    expect((await workspace.getSenseView('trial:sense:crust:earth')).personalMeaning).toBe(
      '已保存',
    );
    failWrites = false;
    await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '重试已保存',
      expectedHeads: [first.revisionId],
    });
    await workspace.close();
    expect((await (await open()).getSenseView('trial:sense:crust:earth')).personalMeaning).toBe(
      '重试已保存',
    );
  });

  it('refuses a newer database version without resetting the saved meaning', async () => {
    const workspace = await open();
    await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '未来版本也不能覆盖我',
      expectedHeads: [],
    });
    await workspace.close();
    const host = createDiskHost(root);
    // Existing-database fixture setup at the storage boundary; assertions use the public workspace.
    const newer = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    await newer.execute('PRAGMA user_version = 99');
    await newer.close();
    await expect(LearningWorkspace.open(host)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
    const original = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    await original.execute('PRAGMA user_version = 1');
    await original.close();
    expect((await (await open()).getSenseView('trial:sense:crust:earth')).personalMeaning).toBe(
      '未来版本也不能覆盖我',
    );
  });

  it('refuses malformed saved JSON instead of opening a blank replacement workspace', async () => {
    const workspace = await open();
    await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '未损坏的旧记录',
      expectedHeads: [],
    });
    await workspace.close();
    const host = createDiskHost(root);
    const fixture = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
      'broken-fixture',
      '{broken',
    ]);
    await fixture.close();
    await expect(LearningWorkspace.open(host)).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
    const repairFixture = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    await repairFixture.execute('DELETE FROM learning_commits WHERE commit_id = ?', [
      'broken-fixture',
    ]);
    await repairFixture.close();
    expect((await (await open()).getSenseView('trial:sense:crust:earth')).personalMeaning).toBe(
      '未损坏的旧记录',
    );
  });

  it('rejects structurally invalid records even when their JSON is parseable', async () => {
    const workspace = await open();
    await workspace.close();
    const fixture = await createDiskHost(root).openDatabase(
      'fixture',
      'Learning/learning.db',
      'Data',
    );
    await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
      'invalid-fixture',
      '{"schemaVersion":1,"parents":null}',
    ]);
    await fixture.close();
    await expect(LearningWorkspace.open(createDiskHost(root))).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
  });

  it('rejects an invalid edit at the public boundary before it can damage saved records', async () => {
    const workspace = await open();
    await expect(
      workspace.setPersonalMeaning({ senseId: '', text: '非法对象', expectedHeads: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await workspace.close();
    expect(
      (await (await open()).getSenseView('trial:sense:crust:earth')).personalMeaning,
    ).toBeNull();
  });

  it('waits for an edit already requested before closing', async () => {
    const workspace = await open();
    const saving = workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '立即退出前的输入',
      expectedHeads: [],
    });
    const closing = workspace.close();
    await expect(saving).resolves.toMatchObject({ durable: true });
    await closing;
    expect((await (await open()).getSenseView('trial:sense:crust:earth')).personalMeaning).toBe(
      '立即退出前的输入',
    );
  });

  it('does not lose the first window when another closes its connection on the same device', async () => {
    const first = await open();
    const second = await open();
    await second.close();
    await expect(
      first.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '仍打开的窗口',
        expectedHeads: [],
      }),
    ).resolves.toMatchObject({ durable: true });
    await expect(
      second.setPersonalMeaning({
        senseId: 'trial:sense:crust:earth',
        text: '关闭后误提交',
        expectedHeads: [],
      }),
    ).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('retains cancelling a review mark without affecting another module', async () => {
    const first = await open();
    const mark = await first.setReviewMark({
      objectId: 'trial:sense:crust:earth',
      module: 'reading',
      marked: true,
      expectedHeads: [],
    });
    await first.setReviewMark({
      objectId: 'trial:sense:crust:earth',
      module: 'listening',
      marked: true,
      expectedHeads: [],
    });
    const cancelled = await first.setReviewMark({
      objectId: 'trial:sense:crust:earth',
      module: 'reading',
      marked: false,
      expectedHeads: [mark.revisionId],
    });
    await first.close();
    expect(
      (await (await open()).getSenseView('trial:sense:crust:earth')).reviewMarks,
    ).toMatchObject({
      reading: { marked: false, heads: [cancelled.revisionId] },
      listening: { marked: true },
    });
  });

  it('refuses saved revisions with missing ancestry instead of hiding older values', async () => {
    const workspace = await open();
    await workspace.close();
    const fixture = await createDiskHost(root).openDatabase(
      'fixture',
      'Learning/learning.db',
      'Data',
    );
    await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
      'a'.repeat(64),
      JSON.stringify({
        schemaVersion: 1,
        id: 'a'.repeat(64),
        deviceId: '00000000-0000-4000-8000-000000000001',
        recordId: 'meaning/trial:sense:crust:earth',
        parents: ['b'.repeat(64)],
        kind: 'meaning',
        value: '缺少父记录的解释',
        updatedAt: '2026-11-03T08:00:00.000Z',
      }),
    ]);
    await fixture.close();
    await expect(LearningWorkspace.open(createDiskHost(root))).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
  });

  it('refuses a saved revision cycle instead of showing no personal meaning', async () => {
    const workspace = await open();
    await workspace.close();
    const fixture = await createDiskHost(root).openDatabase(
      'fixture',
      'Learning/learning.db',
      'Data',
    );
    for (const [id, parent] of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
        id!.repeat(64),
        JSON.stringify({
          schemaVersion: 1,
          id: id!.repeat(64),
          deviceId: '00000000-0000-4000-8000-000000000001',
          recordId: 'meaning/trial:sense:crust:earth',
          parents: [parent!.repeat(64)],
          kind: 'meaning',
          value: '环形修订',
          updatedAt: '2026-11-03T08:00:00.000Z',
        }),
      ]);
    }
    await fixture.close();
    await expect(LearningWorkspace.open(createDiskHost(root))).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
  });

  it('exposes both saved meaning branches without selecting the later row as the winner', async () => {
    const workspace = await open();
    await workspace.close();
    const fixture = await createDiskHost(root).openDatabase(
      'fixture',
      'Learning/learning.db',
      'Data',
    );
    for (const [id, value] of [
      ['a', 'PC解释'],
      ['b', '手机解释'],
    ] as const) {
      await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
        id.repeat(64),
        JSON.stringify({
          schemaVersion: 1,
          id: id.repeat(64),
          deviceId: '00000000-0000-4000-8000-000000000001',
          recordId: 'meaning/trial:sense:crust:earth',
          parents: [],
          kind: 'meaning',
          value,
          updatedAt: '2026-11-03T08:00:00.000Z',
        }),
      ]);
    }
    await fixture.close();
    expect(await (await open()).getSenseView('trial:sense:crust:earth')).toMatchObject({
      personalMeaning: null,
      meaningConflicts: [
        { revisionId: 'a'.repeat(64), value: 'PC解释' },
        { revisionId: 'b'.repeat(64), value: '手机解释' },
      ],
    });
  });

  it('refuses closing after a pending save failed and lets the caller retry its retained draft', async () => {
    let failWrites = false;
    const workspace = await LearningWorkspace.open(
      createDiskHost(root, { failWrites: () => failWrites }),
    );
    workspaces.push(workspace);
    failWrites = true;
    const saving = workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '退出前保存失败的草稿',
      expectedHeads: [],
    });
    const closing = workspace.close();
    await expect(saving).rejects.toMatchObject({ code: 'SAVE_FAILED' });
    await expect(closing).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      draft: '退出前保存失败的草稿',
    });
    failWrites = false;
    await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth',
      text: '退出前保存失败的草稿',
      expectedHeads: [],
    });
    await workspace.close();
    expect((await (await open()).getSenseView('trial:sense:crust:earth')).personalMeaning).toBe(
      '退出前保存失败的草稿',
    );
  });

  it('exposes conflicting review marks without silently turning the mark off', async () => {
    const workspace = await open();
    await workspace.close();
    const fixture = await createDiskHost(root).openDatabase(
      'fixture',
      'Learning/learning.db',
      'Data',
    );
    for (const [id, value] of [
      ['a', true],
      ['b', false],
    ] as const) {
      await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
        id.repeat(64),
        JSON.stringify({
          schemaVersion: 1,
          id: id.repeat(64),
          deviceId: '00000000-0000-4000-8000-000000000001',
          recordId: 'mark/reading/trial:sense:crust:earth',
          parents: [],
          kind: 'review-mark',
          value,
          updatedAt: '2026-11-03T08:00:00.000Z',
        }),
      ]);
    }
    await fixture.close();
    expect(
      (await (await open()).getSenseView('trial:sense:crust:earth')).reviewMarks.reading,
    ).toMatchObject({
      marked: null,
      conflicts: [{ value: true }, { value: false }],
    });
  });
});
