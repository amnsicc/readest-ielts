import catalog from './catalog.json';
import definition from './fixedExercise.json';
import type { ExerciseDefinition } from './listening';
import type { StudySense } from './catalogTypes';

export const studySenses = catalog.senses as StudySense[];
export const readingMaterials = catalog.reading;
export type ReadingMaterial = (typeof readingMaterials)[number];

export const speakingAudioWords = new Set(['atmosphere', 'oxygen', 'carbon dioxide', 'core']);
export const fixedListening = definition as ExerciseDefinition;
