export async function getStudyAsset(filename: string, sha256: string, signal?: AbortSignal) {
  const response = await fetch(`/ielts-study/${filename}`, { signal });
  if (!response.ok) throw new Error('Study asset could not be loaded');
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (actual !== sha256) throw new Error('Study asset integrity check failed');
  return bytes;
}
