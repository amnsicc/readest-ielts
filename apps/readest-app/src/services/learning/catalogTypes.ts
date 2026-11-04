import type { LearningModule } from './types';

export interface StudySense {
  id: string;
  number: string;
  word: string;
  meaning: string;
  pos: string;
  grades: Partial<Record<LearningModule, 0 | 1 | 2>>;
}
