import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Read-only derivation for the approved, fixed recording. This never generates audio or edits sources.
const { values } = parseArgs({
  options: { materials: { type: 'string' }, output: { type: 'string' }, provenance: { type: 'string' } },
});
if (!values.materials || !values.output) throw new Error('--materials and --output are required');
const stem = 'listening-round-01-001-010';
const hashes = {
  mp3: '128a967e08c895829efc24d5c1112d38b40585ce28e6ba2dc2f34ce25b4accee',
  txt: '1644f9d683f0b92eb17a07d5c3dab391c6587dc9e753816557a3f7d4668962e2',
  'targets.md': '78bc17791ff2d468f10bb061fb305e4791697cac9771470e210d713b9e4585e1',
};
const sourceBytes = {};
const sources = [];
for (const [extension, expected] of Object.entries(hashes)) {
  const name = extension === 'targets.md' ? `${stem}-targets.md` : `${stem}.${extension}`;
  const path = resolve(values.materials, name);
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) throw new Error(`Approved source hash changed: ${path}`);
  sources.push({ path, sha256, bytes: bytes.length });
  sourceBytes[extension] = bytes;
}
const targets = [...sourceBytes['targets.md'].toString('utf8').matchAll(/\| \[(\d+)\] \| ([^|]+) \| P\d \|/g)]
  .map((match) => ({
    targetId: `ielts:entry:${match[1]}:listening`,
    originalNumber: Number(match[1]),
    word: match[2].trim(),
    correctNumbers: [],
  }));
if (targets.length !== 7) throw new Error('Expected the approved seven tagged targets');
const transcript = sourceBytes.txt.toString('utf8');
const occurrences = targets.flatMap((target) => {
  const escaped = target.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...transcript.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))]
    .map((match) => ({ target, index: match.index }));
}).sort((a, b) => a.index - b.index);
for (const [index, occurrence] of occurrences.entries()) occurrence.target.correctNumbers.push(index + 1);
if (occurrences.length !== 7 || targets.some((target) => target.correctNumbers.length !== 1))
  throw new Error('The fixed transcript occurrence inventory changed');
const definition = {
  exerciseId: 'ielts:listening:001-010',
  exerciseVersionId: 'ielts:listening:001-010:v1',
  previousVersionId: null,
  materialVersionId: 'ielts:material:001-200:20261027',
  audioAssetId: 'ielts:audio:listening:001-010:v1',
  audioSha256: hashes.mp3,
  answerVersionId: 'ielts:answers:listening:001-010:v1',
  ruleVersion: 'filled-events-v1',
  targets,
};
await mkdir(dirname(resolve(values.output)), { recursive: true });
await writeFile(values.output, `${JSON.stringify(definition, null, 2)}\n`);
if (values.provenance) {
  await mkdir(dirname(resolve(values.provenance)), { recursive: true });
  await writeFile(values.provenance, `${JSON.stringify({ sources, definition: resolve(values.output) }, null, 2)}\n`);
}
process.stdout.write(`Derived ${targets.length} targets / ${occurrences.length} events: ${resolve(values.output)}\n`);
