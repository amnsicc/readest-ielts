import { z } from 'zod';

export const listeningId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);
export const exerciseDefinitionSchema = z
  .strictObject({
    exerciseId: listeningId,
    exerciseVersionId: listeningId,
    previousVersionId: listeningId.nullable(),
    materialVersionId: listeningId,
    audioAssetId: listeningId,
    audioSha256: z.string().regex(/^[0-9a-f]{64}$/),
    answerVersionId: listeningId,
    ruleVersion: z.literal('filled-events-v1'),
    targets: z
      .array(
        z.strictObject({
          targetId: listeningId,
          originalNumber: z.number().int().positive(),
          word: z.string().min(1),
          correctNumbers: z.array(z.number().int().positive().max(2147483647)).min(1),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((definition, ctx) => {
    const ids = definition.targets.map((target) => target.targetId);
    const originals = definition.targets.map((target) => target.originalNumber);
    const events = definition.targets.flatMap((target) => target.correctNumbers);
    if (
      new Set(ids).size !== ids.length ||
      new Set(originals).size !== originals.length ||
      new Set(events).size !== events.length ||
      [...events].sort((a, b) => a - b).some((number, index) => number !== index + 1)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Target identities, original numbers and occurrence numbers must be unique; occurrence numbers must cover 1..N.',
      });
    }
    if (originals.some((number, index) => index > 0 && number <= originals[index - 1]!))
      ctx.addIssue({ code: 'custom', message: 'Targets must retain original-number order.' });
  });
export type ExerciseDefinition = z.infer<typeof exerciseDefinitionSchema>;
export const rawInputsSchema = z.record(listeningId, z.string().max(16384));
export type RawInputs = z.infer<typeof rawInputsSchema>;
export const saveDraftSchema = z.strictObject({
  roundId: listeningId,
  rawInputs: rawInputsSchema,
  expectedHeads: z.array(listeningId).max(1),
});
export type DraftInput = z.infer<typeof saveDraftSchema>;

export const resultSchema = z.strictObject({
  resultId: listeningId,
  roundId: listeningId,
  checkedAt: z.iso.datetime(),
  exerciseVersionId: listeningId,
  materialVersionId: listeningId,
  audioAssetId: listeningId,
  audioSha256: z.string().regex(/^[0-9a-f]{64}$/),
  answerVersionId: listeningId,
  ruleVersion: z.literal('filled-events-v1'),
  rawInputs: rawInputsSchema,
  draftHeads: z.array(listeningId).max(1),
  correct: z.number().int().nonnegative(),
  submitted: z.number().int().nonnegative(),
  percentage: z.number().min(0).max(100).nullable(),
  scope: z.literal('filled-events'),
  label: z.literal('已填写序号准确率'),
  totalExpected: z.number().int().nonnegative(),
  unmatchedExpected: z.number().int().nonnegative(),
  blankTargetIds: z.array(listeningId),
  questionTargetIds: z.array(listeningId),
  duplicates: z.array(
    z.strictObject({ targetId: listeningId, number: z.number().int().positive() }),
  ),
});
export type ListeningResult = z.infer<typeof resultSchema>;

export const listeningEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('definition'), definition: exerciseDefinitionSchema }),
  z.strictObject({
    kind: z.literal('round'),
    roundId: listeningId,
    exerciseId: listeningId,
    exerciseVersionId: listeningId,
    previousRoundId: listeningId.nullable(),
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('draft'),
    roundId: listeningId,
    revisionId: listeningId,
    previousRevisionId: listeningId.nullable(),
    rawInputs: rawInputsSchema,
  }),
  z.strictObject({ kind: z.literal('result'), result: resultSchema }),
]);
export type ListeningEvent = z.infer<typeof listeningEventSchema>;
export interface RoundView {
  roundId: string;
  exerciseId: string;
  definition: ExerciseDefinition;
  rawInputs: RawInputs;
  draftHeads: string[];
  result: ListeningResult | null;
}
export interface ExerciseView {
  definition: ExerciseDefinition;
  currentRound: RoundView;
  rounds: RoundView[];
}

export class ListeningError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_ANSWER',
    message: string,
  ) {
    super(message);
  }
}

export function calculateFilled(definition: ExerciseDefinition, rawInputs: RawInputs) {
  let correct = 0;
  let submitted = 0;
  const issues: { targetId: string; token: string }[] = [];
  const blankTargetIds: string[] = [];
  const questionTargetIds: string[] = [];
  const duplicates: { targetId: string; number: number }[] = [];
  for (const target of definition.targets) {
    const tokens = (rawInputs[target.targetId] ?? '')
      .split(/[,，、\s]+/)
      .filter((token) => token && token !== '?' && token !== '？');
    for (const token of tokens) {
      if (!/^\d+$/.test(token) || Number(token) < 1 || Number(token) > 2147483647)
        issues.push({ targetId: target.targetId, token });
    }
    const numbers = [...new Set(tokens.map(Number))];
    if (!(rawInputs[target.targetId] ?? '').trim()) blankTargetIds.push(target.targetId);
    if (/[?？]/.test(rawInputs[target.targetId] ?? '')) questionTargetIds.push(target.targetId);
    for (const number of numbers)
      if (tokens.filter((token) => Number(token) === number).length > 1)
        duplicates.push({ targetId: target.targetId, number });
    submitted += numbers.length;
    correct += numbers.filter((number) => target.correctNumbers.includes(number)).length;
  }
  if (issues.length)
    throw Object.assign(
      new ListeningError('INVALID_ANSWER', 'Correct the invalid sequence numbers before checking.'),
      { issues },
    );
  const totalExpected = definition.targets.reduce(
    (total, target) => total + target.correctNumbers.length,
    0,
  );
  return {
    correct,
    submitted,
    percentage: submitted === 0 ? null : (correct / submitted) * 100,
    scope: 'filled-events' as const,
    label: '已填写序号准确率' as const,
    totalExpected,
    unmatchedExpected: totalExpected - correct,
    blankTargetIds,
    questionTargetIds,
    duplicates,
  };
}
