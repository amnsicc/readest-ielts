import type { ExerciseDefinition, ListeningEvent, RawInputs } from './listening';
import { calculateFilled } from './listening';

export function eventKeys(event: ListeningEvent): { id: string; slot: string } {
  switch (event.kind) {
    case 'definition':
      return {
        id: `definition/${event.definition.exerciseVersionId}`,
        slot: `definition-base/${event.definition.exerciseId}/${event.definition.previousVersionId ?? '-'}`,
      };
    case 'round':
      return {
        id: `round/${event.roundId}`,
        slot: `round-base/${event.exerciseId}/${event.previousRoundId ?? '-'}`,
      };
    case 'draft':
      return {
        id: `draft/${event.revisionId}`,
        slot: `draft-base/${event.roundId}/${event.previousRevisionId ?? '-'}`,
      };
    case 'result':
      return { id: `result/${event.result.roundId}`, slot: `result/${event.result.roundId}` };
  }
}

// Validate persisted references as well as JSON shapes: malformed records must never vanish from views.
export function validateListeningHistory(events: ListeningEvent[]) {
  const versions = new Map<string, ExerciseDefinition>();
  const activeVersions = new Map<string, string>();
  const rounds = new Map<
    string,
    { definition: ExerciseDefinition; rawInputs: RawInputs; heads: string[] }
  >();
  const activeRounds = new Map<string, string>();
  const seen = new Set<string>();
  const slots = new Set<string>();
  for (const event of events) {
    const keys = eventKeys(event);
    if (seen.has(keys.id) || slots.has(keys.slot))
      throw new Error('Duplicate listening identity/operation');
    seen.add(keys.id);
    slots.add(keys.slot);
    if (event.kind === 'definition') {
      const d = event.definition;
      if ((activeVersions.get(d.exerciseId) ?? null) !== d.previousVersionId)
        throw new Error('Invalid exercise version ancestry');
      for (const previous of versions.values()) {
        if (previous.audioAssetId === d.audioAssetId && previous.audioSha256 !== d.audioSha256)
          throw new Error('Audio identity reused with different bytes');
        if (
          previous.answerVersionId === d.answerVersionId &&
          JSON.stringify(previous.targets.map((t) => [t.targetId, t.correctNumbers])) !==
            JSON.stringify(d.targets.map((t) => [t.targetId, t.correctNumbers]))
        )
          throw new Error('Answer identity reused with different content');
      }
      versions.set(d.exerciseVersionId, d);
      activeVersions.set(d.exerciseId, d.exerciseVersionId);
    } else if (event.kind === 'round') {
      const d = versions.get(event.exerciseVersionId);
      if (
        !d ||
        d.exerciseId !== event.exerciseId ||
        (activeRounds.get(event.exerciseId) ?? null) !== event.previousRoundId
      )
        throw new Error('Invalid round ancestry/version');
      rounds.set(event.roundId, {
        definition: d,
        rawInputs: Object.fromEntries(d.targets.map((t) => [t.targetId, ''])),
        heads: [],
      });
      activeRounds.set(event.exerciseId, event.roundId);
    } else {
      const roundId = event.kind === 'draft' ? event.roundId : event.result.roundId;
      const round = rounds.get(roundId);
      if (!round) throw new Error('Listening record references a missing round');
      const rawInputs = event.kind === 'draft' ? event.rawInputs : event.result.rawInputs;
      const targetIds = round.definition.targets.map((t) => t.targetId).sort();
      if (JSON.stringify(Object.keys(rawInputs).sort()) !== JSON.stringify(targetIds))
        throw new Error('Invalid saved target identities');
      if (event.kind === 'draft') {
        if ((round.heads[0] ?? null) !== event.previousRevisionId)
          throw new Error('Invalid draft ancestry');
        round.rawInputs = rawInputs;
        round.heads = [event.revisionId];
      } else {
        const r = event.result;
        const d = round.definition;
        if (
          r.resultId !== `result:${roundId}` ||
          r.exerciseVersionId !== d.exerciseVersionId ||
          r.materialVersionId !== d.materialVersionId ||
          r.audioAssetId !== d.audioAssetId ||
          r.audioSha256 !== d.audioSha256 ||
          r.answerVersionId !== d.answerVersionId ||
          r.ruleVersion !== d.ruleVersion
        )
          throw new Error('Invalid result version identity');
        // Verify with the pinned immutable definition, never with the current exercise answers.
        if (
          JSON.stringify(r.draftHeads) !== JSON.stringify(round.heads) ||
          targetIds.some((id) => rawInputs[id] !== round.rawInputs[id])
        )
          throw new Error('Result does not match the checked draft');
        const expected = calculateFilled(d, rawInputs);
        for (const key of Object.keys(expected) as (keyof typeof expected)[])
          if (JSON.stringify(r[key]) !== JSON.stringify(expected[key]))
            throw new Error('Saved result contradicts its counting rule');
      }
    }
  }
}
