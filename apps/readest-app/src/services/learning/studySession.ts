import type { LearningHost } from './types';
import { LearningWorkspace } from './workspace';

const sessions = new WeakMap<LearningHost, Promise<LearningWorkspace>>();

// A shared connection per application host keeps routes from racing bootstrap or closing
// a connection while a neighbouring view is saving.
export function getStudyWorkspace(host: LearningHost) {
  let session = sessions.get(host);
  if (!session) {
    session = LearningWorkspace.open(host).catch((error) => {
      sessions.delete(host);
      throw error;
    });
    sessions.set(host, session);
  }
  return session;
}
