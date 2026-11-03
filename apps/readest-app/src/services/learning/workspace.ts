import { LearningPersistence } from './persistence';
import { LearningConflictError, LearningSaveError, revisionIdentity } from './revisions';
import type {
  LearningHost,
  LearningModule,
  LearningRevision,
  SaveReceipt,
  SenseView,
} from './types';
import { z } from 'zod';

const objectId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);
const expectedHeads = z.array(z.string().regex(/^[0-9a-f]{64}$/));
const meaningInput = z.strictObject({
  senseId: objectId,
  text: z.string().max(65536),
  expectedHeads,
});
const markInput = z.strictObject({
  objectId,
  module: z.enum(['reading', 'listening', 'speaking', 'writing']),
  marked: z.boolean(),
  expectedHeads,
});

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error('Invalid learning edit.', { cause: parsed.error }), {
      code: 'INVALID_INPUT',
    });
  }
  return parsed.data;
}

export class LearningWorkspace {
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private failedSaves = new Map<string, LearningSaveError>();

  private constructor(private readonly persistence: LearningPersistence) {}

  static async open(host: LearningHost): Promise<LearningWorkspace> {
    return new LearningWorkspace(await LearningPersistence.open(host));
  }

  async setPersonalMeaning(input: {
    senseId: string;
    text: string;
    expectedHeads: string[];
  }): Promise<SaveReceipt> {
    input = validate(meaningInput, input);
    return this.save(`meaning/${input.senseId}`, input.text, async () => {
      const revision: LearningRevision = {
        schemaVersion: 1,
        id: await revisionIdentity(
          this.persistence.deviceId,
          `meaning/${input.senseId}`,
          input.expectedHeads,
        ),
        deviceId: this.persistence.deviceId,
        recordId: `meaning/${input.senseId}`,
        parents: [...input.expectedHeads],
        kind: 'meaning',
        value: input.text,
        updatedAt: new Date().toISOString(),
      };
      await this.persistence.append(revision);
      return { revisionId: revision.id, durable: true };
    });
  }

  async setReviewMark(input: {
    objectId: string;
    module: LearningModule;
    marked: boolean;
    expectedHeads: string[];
  }): Promise<SaveReceipt> {
    input = validate(markInput, input);
    return this.save(`mark/${input.module}/${input.objectId}`, input.marked, async () => {
      const revision: LearningRevision = {
        schemaVersion: 1,
        id: await revisionIdentity(
          this.persistence.deviceId,
          `mark/${input.module}/${input.objectId}`,
          input.expectedHeads,
        ),
        deviceId: this.persistence.deviceId,
        recordId: `mark/${input.module}/${input.objectId}`,
        parents: [...input.expectedHeads],
        kind: 'review-mark',
        value: input.marked,
        updatedAt: new Date().toISOString(),
      };
      await this.persistence.append(revision);
      return { revisionId: revision.id, durable: true };
    });
  }

  private save(
    recordId: string,
    draft: string | boolean,
    operation: () => Promise<SaveReceipt>,
  ): Promise<SaveReceipt> {
    if (this.closing)
      return Promise.reject(
        Object.assign(new Error('The learning workspace is closed.'), { code: 'CLOSED' }),
      );
    const requested = this.pending.then(operation).catch((cause: unknown) => {
      // All work after accepting an edit, including identity generation and reads, is fallible.
      if (cause instanceof LearningConflictError || cause instanceof LearningSaveError) throw cause;
      throw new LearningSaveError(draft, cause);
    });
    this.pending = requested.then(
      () => {
        this.failedSaves.delete(recordId);
      },
      (error: unknown) => {
        if (error instanceof LearningSaveError) this.failedSaves.set(recordId, error);
      },
    );
    return requested;
  }

  async getSenseView(senseId: string): Promise<SenseView> {
    const all = await this.persistence.readAll();
    const records = all.filter((revision) => revision.recordId === `meaning/${senseId}`);
    const superseded = new Set(records.flatMap((revision) => revision.parents));
    const heads = records.filter((revision) => !superseded.has(revision.id));
    return {
      senseId,
      personalMeaning:
        heads.length === 1 && typeof heads[0]!.value === 'string' ? heads[0]!.value : null,
      meaningHeads: heads.map((revision) => revision.id),
      meaningConflicts:
        heads.length > 1
          ? heads.map(({ id, value, deviceId, updatedAt }) => ({
              revisionId: id,
              value,
              deviceId,
              updatedAt,
            }))
          : [],
      reviewMarks: Object.fromEntries(
        (['reading', 'listening', 'speaking', 'writing'] as const).map((module) => {
          const marks = all.filter((revision) => revision.recordId === `mark/${module}/${senseId}`);
          const parents = new Set(marks.flatMap((revision) => revision.parents));
          const current = marks.filter((revision) => !parents.has(revision.id));
          return [
            module,
            {
              marked: current.length > 1 ? null : current[0]?.value === true,
              heads: current.map((r) => r.id),
              conflicts:
                current.length > 1
                  ? current.map(({ id, value, deviceId, updatedAt }) => ({
                      revisionId: id,
                      value,
                      deviceId,
                      updatedAt,
                    }))
                  : [],
            },
          ];
        }),
      ) as SenseView['reviewMarks'],
    };
  }

  close(): Promise<void> {
    this.closing ??= this.pending
      .then(() => {
        if (this.failedSaves.size) throw this.failedSaves.values().next().value;
        return this.persistence.close();
      })
      .catch((error: unknown) => {
        this.closing = undefined;
        throw error;
      });
    return this.closing;
  }
}
