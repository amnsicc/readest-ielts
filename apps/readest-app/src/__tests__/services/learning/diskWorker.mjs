import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

// A separate Node process exercises the public workspace on real disk, without UI or Tauri claims.
const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const [dataRoot, mode] = process.argv.slice(2);
const server = await createServer({
  root: appRoot,
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null },
  resolve: { alias: { '@': resolve(appRoot, 'src') } },
  optimizeDeps: { noDiscovery: true },
});

try {
  const { LearningWorkspace } = await server.ssrLoadModule('/src/services/learning/workspace.ts');
  const { createDiskHost } = await server.ssrLoadModule('/src/__tests__/services/learning/diskHost.ts');
  const workspace = await LearningWorkspace.open(createDiskHost(dataRoot));
  if (mode === 'write') {
    const receipt = await workspace.setPersonalMeaning({
      senseId: 'trial:sense:crust:earth', text: '进程中止后仍在的已保存解释', expectedHeads: [],
    });
    await workspace.setReviewMark({ objectId: 'trial:sense:crust:earth', module: 'reading', marked: true, expectedHeads: [] });
    process.stdout.write(`SAVED:${JSON.stringify(receipt)}\n`);
    // Parent kills this process after SAVED. Do not close/checkpoint the workspace first.
    await new Promise(() => { setInterval(() => {}, 1000); });
  } else if (mode === 'read') {
    const view = await workspace.getSenseView('trial:sense:crust:earth');
    await workspace.close();
    process.stdout.write(`VIEW:${JSON.stringify(view)}\n`);
  } else if (mode === 'write-listening') {
    const definition = JSON.parse(await readFile(new URL('../../fixtures/data/listening-fixed-seven.json', import.meta.url), 'utf8'));
    await workspace.registerExerciseVersion(definition);
    const exercise = await workspace.openExercise(definition.exerciseId);
    const receipt = await workspace.saveDraft({
      roundId: exercise.currentRound.roundId,
      expectedHeads: [],
      rawInputs: {
        'ielts:entry:1:listening': '1', 'ielts:entry:4:listening': '4',
        'ielts:entry:5:listening': '6', 'ielts:entry:6:listening': '7',
        'ielts:entry:7:listening': '5', 'ielts:entry:8:listening': '3',
        'ielts:entry:9:listening': '2',
      },
    });
    await workspace.checkRound(exercise.currentRound.roundId);
    process.stdout.write(`SAVED:${JSON.stringify(receipt)}\n`);
    await new Promise(() => { setInterval(() => {}, 1000); });
  } else if (mode === 'read-listening') {
    const view = await workspace.openExercise('ielts:listening:001-010');
    await workspace.close();
    process.stdout.write(`VIEW:${JSON.stringify(view)}\n`);
  } else {
    throw new Error('Unknown worker operation');
  }
} finally {
  await server.close();
}
