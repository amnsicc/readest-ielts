// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningWorkspace } from '@/services/learning/workspace';
import { createDiskHost } from './diskHost';

describe('stage-one acceptance regressions through the public workspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'readest-ielts-fixes-'));
  });

  afterEach(async () => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('readest-ielts-fixes-')
    ) {
      throw new Error('Refusing cleanup outside the isolated acceptance fixture');
    }
    await rm(root, { recursive: true, force: true });
  });

  it('F01 retains the draft and blocks close after a read failure before saving', async () => {
    const base = createDiskHost(root);
    let failRead = false;
    const host = {
      ...base,
      async openDatabase(...args: Parameters<typeof base.openDatabase>) {
        const db = await base.openDatabase(...args);
        return {
          ...db,
          select: (async (sql, params) => {
            if (failRead && sql.includes('FROM learning_commits'))
              throw new Error('TRANSIENT_READ_FAILURE');
            return db.select(sql, params);
          }) as typeof db.select,
        };
      },
    };
    const workspace = await LearningWorkspace.open(host);
    const saved = await workspace.setPersonalMeaning({
      senseId: 'probe:failure',
      text: 'last durable value',
      expectedHeads: [],
    });
    failRead = true;
    const failure: unknown = await workspace
      .setPersonalMeaning({
        senseId: 'probe:failure',
        text: 'must retain this draft',
        expectedHeads: [saved.revisionId],
      })
      .catch((error: unknown) => error);
    const closing: unknown = await workspace.close().catch((error: unknown) => error);
    failRead = false;
    if (closing !== undefined) {
      expect((await workspace.getSenseView('probe:failure')).personalMeaning).toBe(
        'last durable value',
      );
      await workspace.setPersonalMeaning({
        senseId: 'probe:failure',
        text: 'must retain this draft',
        expectedHeads: [saved.revisionId],
      });
      await workspace.close();
    }
    const reopened = await LearningWorkspace.open(base);
    const recovered = await reopened.getSenseView('probe:failure');
    await reopened.close();
    expect(failure).toMatchObject({
      code: 'SAVE_FAILED',
      draft: 'must retain this draft',
      cause: { message: 'TRANSIENT_READ_FAILURE' },
    });
    expect(closing).toMatchObject({ code: 'SAVE_FAILED', draft: 'must retain this draft' });
    expect(recovered.personalMeaning).toBe('must retain this draft');
  });

  it('F02 refuses a wrong-kind child and preserves the prior readable meaning', async () => {
    const host = createDiskHost(root);
    const workspace = await LearningWorkspace.open(host);
    const saved = await workspace.setPersonalMeaning({
      senseId: 'probe:corrupt',
      text: 'saved meaning that must not disappear',
      expectedHeads: [],
    });
    await workspace.close();
    const fixture = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    const bad = {
      schemaVersion: 1,
      id: 'c'.repeat(64),
      deviceId: '00000000-0000-4000-8000-000000000003',
      recordId: 'meaning/probe:corrupt',
      parents: [saved.revisionId],
      kind: 'review-mark',
      value: true,
      updatedAt: '2026-11-03T08:00:00.000Z',
    };
    await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
      bad.id,
      JSON.stringify(bad),
    ]);
    await fixture.close();
    const opened = await LearningWorkspace.open(host).then(
      async (value) => {
        await value.close();
        return null;
      },
      (error: unknown) => error,
    );
    // Remove only the injected fixture; verify the prior user value through the public API.
    const removeFixture = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    await removeFixture.execute('DELETE FROM learning_commits WHERE commit_id = ?', [bad.id]);
    await removeFixture.close();
    const reopened = await LearningWorkspace.open(host);
    const view = await reopened.getSenseView('probe:corrupt');
    await reopened.close();
    expect(opened).toMatchObject({ code: 'CORRUPT_DATA' });
    expect(view.personalMeaning).toBe('saved meaning that must not disappear');
    expect(view.meaningHeads).toEqual([saved.revisionId]);
  });

  it('F03 rejects a damaged local identity without changing it or accepting new records', async () => {
    const host = createDiskHost(root);
    const workspace = await LearningWorkspace.open(host);
    const saved = await workspace.setPersonalMeaning({
      senseId: 'probe:device',
      text: 'existing value',
      expectedHeads: [],
    });
    await workspace.close();
    const fixture = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    const identities = await fixture.select<{ device_id: string }>(
      'SELECT device_id FROM learning_device',
    );
    await fixture.execute('UPDATE learning_device SET device_id = ? WHERE singleton = 1', [
      'invalid-device-id',
    ]);
    await fixture.close();
    const failure = await LearningWorkspace.open(host).then(
      async (opened) => {
        await opened.close();
        return null;
      },
      (error: unknown) => error,
    );
    const inspect = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    const retainedIdentity = await inspect.select<{ device_id: string }>(
      'SELECT device_id FROM learning_device',
    );
    // Restore only our damaged-identity fixture, then observe original records via the public API.
    await inspect.execute('UPDATE learning_device SET device_id = ? WHERE singleton = 1', [
      identities[0]!.device_id,
    ]);
    await inspect.close();
    const reopened = await LearningWorkspace.open(host);
    const view = await reopened.getSenseView('probe:device');
    await reopened.close();
    expect(failure).toMatchObject({ code: 'CORRUPT_DATA' });
    expect(retainedIdentity).toEqual([{ device_id: 'invalid-device-id' }]);
    expect(view).toMatchObject({
      personalMeaning: 'existing value',
      meaningHeads: [saved.revisionId],
    });
  });

  it('F01 keeps both diagnostics when writing and its recovery read fail', async () => {
    const base = createDiskHost(root);
    let failWrite = false;
    let failRead = false;
    const host = {
      ...base,
      async openDatabase(...args: Parameters<typeof base.openDatabase>) {
        const db = await base.openDatabase(...args);
        return {
          ...db,
          async execute(sql: string, params?: unknown[]) {
            if (failWrite) {
              failRead = true;
              throw new Error('WRITE_IO_FAILURE');
            }
            return db.execute(sql, params);
          },
          select: (async (sql, params) => {
            if (failRead) throw new Error('RECOVERY_READ_FAILURE');
            return db.select(sql, params);
          }) as typeof db.select,
        };
      },
    };
    const workspace = await LearningWorkspace.open(host);
    failWrite = true;
    const failure: unknown = await workspace
      .setReviewMark({ objectId: 'probe:mark', module: 'writing', marked: true, expectedHeads: [] })
      .catch((error: unknown) => error);
    const closing: unknown = await workspace.close().catch((error: unknown) => error);
    failRead = false;
    failWrite = false;
    if (closing !== undefined) {
      await workspace.setReviewMark({
        objectId: 'probe:mark',
        module: 'writing',
        marked: true,
        expectedHeads: [],
      });
      await workspace.close();
    }
    expect(failure).toMatchObject({
      code: 'SAVE_FAILED',
      draft: true,
      cause: { errors: [{ message: 'WRITE_IO_FAILURE' }, { message: 'RECOVERY_READ_FAILURE' }] },
    });
    expect(closing).toMatchObject({ code: 'SAVE_FAILED', draft: true });
  });

  it('F03 never acknowledges a new revision that violates the reading protocol', async () => {
    const host = createDiskHost(root);
    const workspace = await LearningWorkspace.open(host);
    // Time is a system boundary: a malformed timestamp must not poison persisted records.
    const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('invalid-clock-value');
    let failure: unknown;
    try {
      failure = await workspace
        .setPersonalMeaning({
          senseId: 'probe:write-protocol',
          text: 'retry this draft',
          expectedHeads: [],
        })
        .catch((error: unknown) => error);
    } finally {
      clock.mockRestore();
    }
    // Retry the same original baseline. A rejected record must not have been committed.
    const closing = await workspace.close().then(
      () => null,
      (error: unknown) => error,
    );
    if (closing !== null) {
      await workspace.setPersonalMeaning({
        senseId: 'probe:write-protocol',
        text: 'retry this draft',
        expectedHeads: [],
      });
      await workspace.close();
      const reopened = await LearningWorkspace.open(host);
      const view = await reopened.getSenseView('probe:write-protocol');
      await reopened.close();
      expect(view.personalMeaning).toBe('retry this draft');
    }
    expect(failure).toMatchObject({ code: 'SAVE_FAILED', draft: 'retry this draft' });
    expect(closing).toMatchObject({ code: 'SAVE_FAILED' });
  });

  it('F03 does not silently replace a missing device identity in an existing workspace', async () => {
    const host = createDiskHost(root);
    const workspace = await LearningWorkspace.open(host);
    await workspace.setPersonalMeaning({
      senseId: 'probe:missing-device',
      text: 'keep my provenance',
      expectedHeads: [],
    });
    await workspace.close();
    const fixture = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    const previous = await fixture.select<{ device_id: string }>(
      'SELECT device_id FROM learning_device',
    );
    await fixture.execute('DELETE FROM learning_device');
    await fixture.close();
    const result = await LearningWorkspace.open(host).then(
      async (w) => {
        await w.close();
        return null;
      },
      (error: unknown) => error,
    );
    const check = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    const remaining = await check.select<{ device_id: string }>(
      'SELECT device_id FROM learning_device',
    );
    await check.execute('INSERT OR REPLACE INTO learning_device VALUES (1, ?)', [
      previous[0]!.device_id,
    ]);
    await check.close();
    const reopened = await LearningWorkspace.open(host);
    const view = await reopened.getSenseView('probe:missing-device');
    await reopened.close();
    expect(result).toMatchObject({ code: 'CORRUPT_DATA' });
    expect(remaining).toEqual([]);
    expect(view.personalMeaning).toBe('keep my provenance');
  });

  it('F01 retains a draft if identity generation fails before any database work', async () => {
    const workspace = await LearningWorkspace.open(createDiskHost(root));
    const digest = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('IDENTITY_GENERATION_FAILURE'));
    let failure: unknown;
    try {
      failure = await workspace
        .setPersonalMeaning({
          senseId: 'probe:identity',
          text: 'identity draft',
          expectedHeads: [],
        })
        .catch((error: unknown) => error);
    } finally {
      digest.mockRestore();
    }
    const closing: unknown = await workspace.close().catch((error: unknown) => error);
    if (closing !== undefined) {
      await workspace.setPersonalMeaning({
        senseId: 'probe:identity',
        text: 'identity draft',
        expectedHeads: [],
      });
      await workspace.close();
    }
    expect(failure).toMatchObject({
      code: 'SAVE_FAILED',
      draft: 'identity draft',
      cause: { message: 'IDENTITY_GENERATION_FAILURE' },
    });
    expect(closing).toMatchObject({ code: 'SAVE_FAILED', draft: 'identity draft' });
  });

  it.each([
    { recordId: 'mark/reading/probe:invalid', kind: 'meaning', value: 'wrong domain' },
    { recordId: 'mark/unknown/probe:invalid', kind: 'review-mark', value: true },
    { recordId: 'mark/reading/', kind: 'review-mark', value: true },
    { recordId: 'meaning/', kind: 'meaning', value: 'missing identity' },
    { recordId: 'meaning/probe:invalid', kind: 'meaning', value: true },
  ])('F02 rejects invalid record domain/type $recordId $kind', async (input) => {
    const host = createDiskHost(root);
    const workspace = await LearningWorkspace.open(host);
    await workspace.close();
    const fixture = await host.openDatabase('fixture', 'Learning/learning.db', 'Data');
    await fixture.execute('INSERT INTO learning_commits VALUES (?, ?)', [
      'd'.repeat(64),
      JSON.stringify({
        schemaVersion: 1,
        id: 'd'.repeat(64),
        deviceId: '00000000-0000-4000-8000-000000000003',
        parents: [],
        updatedAt: '2026-11-03T08:00:00.000Z',
        ...input,
      }),
    ]);
    await fixture.close();
    const failure = await LearningWorkspace.open(host).then(
      async (opened) => {
        await opened.close();
        return null;
      },
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'CORRUPT_DATA' });
  });
});
