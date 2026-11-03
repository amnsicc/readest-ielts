import type { LearningRevision } from './types';
import { z } from 'zod';

const revisionBase = {
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{64}$/),
  deviceId: z.uuid(),
  recordId: z.string().min(1),
  parents: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  updatedAt: z.iso.datetime(),
};

const revisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...revisionBase,
    recordId: z.string().regex(/^meaning\/[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/),
    kind: z.literal('meaning'),
    value: z.string().max(65536),
  }),
  z.strictObject({
    ...revisionBase,
    recordId: z
      .string()
      .regex(/^mark\/(reading|listening|speaking|writing)\/[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/),
    kind: z.literal('review-mark'),
    value: z.boolean(),
  }),
]);

export function parseRevision(json: string): LearningRevision {
  return revisionSchema.parse(JSON.parse(json));
}

export function recordHeads(revisions: LearningRevision[], recordId: string): LearningRevision[] {
  const records = revisions.filter((revision) => revision.recordId === recordId);
  const parents = new Set(records.flatMap((revision) => revision.parents));
  return records.filter((revision) => !parents.has(revision.id));
}

export class LearningConflictError extends Error {
  readonly code = 'CONFLICT';

  constructor(
    readonly currentHeads: string[],
    readonly draft: string | boolean,
  ) {
    super('This record changed. Your draft has been retained.');
  }
}

export class LearningSaveError extends Error {
  readonly code = 'SAVE_FAILED';

  constructor(
    readonly draft: string | boolean,
    cause: unknown,
  ) {
    super('Saving failed. Your draft has been retained; retry when storage is available.', {
      cause,
    });
  }
}

export async function revisionIdentity(deviceId: string, recordId: string, parents: string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify([deviceId, recordId, [...parents].sort()]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
