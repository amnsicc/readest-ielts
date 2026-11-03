import type { AppService } from '@/types/system';

export type LearningHost = Pick<
  AppService,
  'openDatabase' | 'createDir' | 'exists' | 'readFile' | 'writeFile'
>;

export interface SaveReceipt {
  revisionId: string;
  durable: true;
}

export interface LearningRevision {
  schemaVersion: 1;
  id: string;
  deviceId: string;
  recordId: string;
  parents: string[];
  kind: 'meaning' | 'review-mark';
  value: string | boolean;
  updatedAt: string;
}

export interface SenseView {
  senseId: string;
  personalMeaning: string | null;
  meaningHeads: string[];
  meaningConflicts: {
    revisionId: string;
    value: string | boolean;
    deviceId: string;
    updatedAt: string;
  }[];
  reviewMarks: Record<
    LearningModule,
    {
      marked: boolean | null;
      heads: string[];
      conflicts: {
        revisionId: string;
        value: string | boolean;
        deviceId: string;
        updatedAt: string;
      }[];
    }
  >;
}

export type LearningModule = 'reading' | 'listening' | 'speaking' | 'writing';
