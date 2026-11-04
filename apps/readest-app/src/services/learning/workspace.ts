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
import { ListeningStore } from './listeningStore';
import { exerciseDefinitionSchema, saveDraftSchema, ListeningError } from './listening';
import type { ExerciseDefinition, DraftInput } from './listening';
import type { LearningDraft } from './types';

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
  private listening: Promise<ListeningStore> | undefined;

  private constructor(
    private readonly persistence: LearningPersistence,
    private readonly host: LearningHost,
  ) {}

  static async open(host: LearningHost): Promise<LearningWorkspace> {
    return new LearningWorkspace(await LearningPersistence.open(host), host);
  }

  private listeningStore() {
    this.listening ??= ListeningStore.open(this.host).catch((error: unknown) => {
      this.listening = undefined;
      throw error;
    });
    return this.listening;
  }
  async registerExerciseVersion(definition: ExerciseDefinition) {
    const parsed = validate(exerciseDefinitionSchema, definition);
    return this.save(`definition/${parsed.exerciseVersionId}`, {}, async () =>
      (await this.listeningStore()).register(parsed),
    );
  }
  openExercise(exerciseId: string) {
    return this.save(`exercise/${exerciseId}`, {}, async () =>
      (await this.listeningStore()).openExercise(exerciseId),
    );
  }
  async saveDraft(input: DraftInput) {
    const parsed = validate(saveDraftSchema, input);
    return this.save(`draft/${parsed.roundId}`, parsed.rawInputs, async () =>
      (await this.listeningStore()).saveDraft(parsed),
    );
  }
  checkRound(roundId: string) {
    return this.save(`result/${roundId}`, {}, async () =>
      (await this.listeningStore()).checkRound(roundId),
    );
  }
  startNewRound(exerciseId: string) {
    return this.save(`exercise/${exerciseId}`, {}, async () =>
      (await this.listeningStore()).startNewRound(exerciseId),
    );
  }
  getRound(roundId: string) {
    return this.save(`query/${roundId}`, {}, async () =>
      (await this.listeningStore()).getRound(roundId),
    );
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

  private save<T>(recordId: string, draft: LearningDraft, operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        Object.assign(new Error('The learning workspace is closed.'), { code: 'CLOSED' }),
      );
    const requested = this.pending.then(operation).catch((cause: unknown) => {
      // All work after accepting an edit, including identity generation and reads, is fallible.
      if (
        cause instanceof LearningConflictError ||
        cause instanceof LearningSaveError ||
        cause instanceof ListeningError
      )
        throw cause;
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
      .then(async () => {
        if (process.env['NEXT_PUBLIC_IELTS_TRIAL'] === '1') {
          console.info('[ielts-close-workspace]', { stage: 'writes-settled', at: Date.now() });
        }
        if (this.failedSaves.size) throw this.failedSaves.values().next().value;
        if (this.listening) await (await this.listening).close();
        return this.persistence.close();
      })
      .catch((error: unknown) => {
        this.closing = undefined;
        throw error;
      });
    return this.closing;
  }
}
