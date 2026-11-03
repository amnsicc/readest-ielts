import type { DatabaseService } from '@/types/database';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { LearningHost, LearningRevision } from './types';
import { LearningConflictError, LearningSaveError, parseRevision, recordHeads } from './revisions';

export class LearningPersistence {
  private closed = false;
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly db: DatabaseService,
    readonly deviceId: string,
  ) {}

  static async open(host: LearningHost): Promise<LearningPersistence> {
    await host.createDir('Learning', 'Data', true);
    const db = await host.openDatabase('learning-inspect', 'Learning/learning.db', 'Data');
    try {
      const migrations = getMigrations('learning');
      const versions = await db.select<{ user_version: number }>('PRAGMA user_version');
      if (versions[0]!.user_version > migrations.length) {
        throw Object.assign(new Error('This learning database requires a newer application.'), {
          code: 'UNSUPPORTED_VERSION',
        });
      }
      await migrate(db, migrations);
      const persistence = new LearningPersistence(db, '');
      await persistence.readAll();
      await db.execute(
        'INSERT OR IGNORE INTO learning_device (singleton, device_id) VALUES (1, ?)',
        [crypto.randomUUID()],
      );
      const devices = await db.select<{ device_id: string }>(
        'SELECT device_id FROM learning_device WHERE singleton = 1',
      );
      return new LearningPersistence(db, devices[0]!.device_id);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async readAll(): Promise<LearningRevision[]> {
    const rows = await this.db.select<{ commit_id: string; payload_json: string }>(
      'SELECT commit_id, payload_json FROM learning_commits ORDER BY rowid',
    );
    try {
      const revisions = rows.map((row) => {
        const revision = parseRevision(row.payload_json);
        if (revision.id !== row.commit_id) throw new Error('Revision identity mismatch');
        return revision;
      });
      const byId = new Map(revisions.map((revision) => [revision.id, revision]));
      const children = new Map<string, string[]>();
      const dependencies = new Map(revisions.map((r) => [r.id, r.parents.length]));
      for (const revision of revisions) {
        if (new Set(revision.parents).size !== revision.parents.length)
          throw new Error('Duplicate revision parent');
        for (const parentId of revision.parents) {
          const parent = byId.get(parentId);
          if (!parent || parent.recordId !== revision.recordId)
            throw new Error('Invalid revision ancestry');
          const descendants = children.get(parentId) ?? [];
          descendants.push(revision.id);
          children.set(parentId, descendants);
        }
      }
      const resolved = revisions.filter((r) => r.parents.length === 0).map((r) => r.id);
      for (let i = 0; i < resolved.length; i++) {
        for (const child of children.get(resolved[i]!) ?? []) {
          const remaining = dependencies.get(child)! - 1;
          dependencies.set(child, remaining);
          if (remaining === 0) resolved.push(child);
        }
      }
      if (resolved.length !== revisions.length) throw new Error('Cyclic revision ancestry');
      return revisions;
    } catch (cause) {
      throw Object.assign(
        new Error('Saved learning records are damaged. The data has been retained.', { cause }),
        { code: 'CORRUPT_DATA' },
      );
    }
  }

  append(revision: LearningRevision): Promise<void> {
    const pending = this.writes.then(() => this.appendOnce(revision));
    this.writes = pending.catch(() => {});
    return pending;
  }

  private async appendOnce(revision: LearningRevision): Promise<void> {
    const currentHeads = recordHeads(await this.readAll(), revision.recordId)
      .map((r) => r.id)
      .sort();
    const expectedHeads = [...revision.parents].sort();
    if (JSON.stringify(currentHeads) !== JSON.stringify(expectedHeads)) {
      throw new LearningConflictError(currentHeads, revision.value);
    }
    try {
      await this.db.execute(
        'INSERT INTO learning_commits (commit_id, payload_json) VALUES (?, ?)',
        [revision.id, JSON.stringify(revision)],
      );
    } catch (error) {
      const latest = recordHeads(await this.readAll(), revision.recordId)
        .map((r) => r.id)
        .sort();
      if (JSON.stringify(latest) !== JSON.stringify(expectedHeads)) {
        throw new LearningConflictError(latest, revision.value);
      }
      throw new LearningSaveError(revision.value, error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.writes;
    this.closed = true;
    await this.db.close();
  }
}
