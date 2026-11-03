// @vitest-environment node
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

async function removeIsolatedDirectory(root: string) {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('readest-ielts-process-')
  ) {
    throw new Error('Refusing cleanup outside the isolated process test directory');
  }
  await rm(root, { recursive: true, force: true });
}

it.each([
  'personal',
  'listening',
])('reads acknowledged %s data in another process after the writer is killed', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'readest-ielts-process-'));
  const worker = fileURLToPath(new URL('./diskWorker.mjs', import.meta.url));
  const child = spawn(
    process.execPath,
    [worker, root, kind === 'personal' ? 'write' : 'write-listening'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((done, reject) => {
    child.once('exit', () => done());
    child.once('error', reject);
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (bytes) => {
    errors += bytes.toString();
  });
  try {
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No saved receipt from worker: ${errors}`)),
        15000,
      );
      child.stdout.on('data', (bytes) => {
        output += bytes.toString();
        if (output.includes('SAVED:')) {
          clearTimeout(timeout);
          done();
        }
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`Writer exited before saved receipt: ${errors}`));
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    expect(output).toContain('"durable":true');
    child.kill('SIGKILL');
    await exited;
    const read = await promisify(execFile)(
      process.execPath,
      [worker, root, kind === 'personal' ? 'read' : 'read-listening'],
      {
        timeout: 15000,
      },
    );
    const line = read.stdout.split('\n').find((entry) => entry.startsWith('VIEW:'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(5))).toMatchObject(
      kind === 'personal'
        ? {
            personalMeaning: '进程中止后仍在的已保存解释',
            reviewMarks: { reading: { marked: true } },
          }
        : {
            rounds: expect.any(Array),
            currentRound: {
              rawInputs: { 'ielts:entry:1:listening': '1', 'ielts:entry:5:listening': '6' },
              result: {
                correct: 7,
                submitted: 7,
                percentage: 100,
                audioSha256: '128a967e08c895829efc24d5c1112d38b40585ce28e6ba2dc2f34ce25b4accee',
                rawInputs: { 'ielts:entry:1:listening': '1' },
              },
            },
          },
    );
    if (kind === 'listening') expect(JSON.parse(line!.slice(5)).rounds).toHaveLength(1);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await removeIsolatedDirectory(root);
  }
}, 35000);
