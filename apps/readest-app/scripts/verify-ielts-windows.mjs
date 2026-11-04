import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const [exeArg, outputArg, mode = 'exercise'] = process.argv.slice(2);
if (process.platform !== 'win32' || !exeArg || !outputArg) {
  throw new Error('Usage on Windows: node verify-ielts-windows.mjs <exe> <output> [exercise|reopen|restore|smoke]');
}
assert.ok(['exercise', 'reopen', 'restore', 'smoke'].includes(mode));
const exe = resolve(exeArg);
const output = resolve(outputArg);
const run = promisify(execFile);
const personal = 'Windows 原生验收：本篇气氛';
const note = 'Windows 原生验收阅读笔记';
const annotate = /^(Annotate|笔记|筆記)$/;
const checks = [];
const emit = (name, details = {}) => {
  const result = { name, ...details };
  checks.push(result);
  console.log(JSON.stringify(result));
};
const server = createServer();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();
await new Promise((done) => server.close(done));
await mkdir(output, { recursive: true });

const proxy = 'http://127.0.0.1:1';
const child = spawn(exe, [], {
  cwd: resolve(exe, '..'),
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --proxy-server=${proxy} --disable-background-networking`,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: 'localhost,127.0.0.1,tauri.localhost,ipc.localhost,asset.localhost,rangefile.localhost',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(createWriteStream(join(output, 'app-stdout.log')));
child.stderr.pipe(createWriteStream(join(output, 'app-stderr.log')));
const closed = new Promise((done, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => done({ code, signal }));
});
closed.catch(() => {});
let page;
const requestClose = async () => {
  // Post WM_CLOSE to the actual native window without taking desktop focus.
  const { stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$app=Get-Process -Id ${child.pid} -ErrorAction Stop; $app.CloseMainWindow()`,
  ]);
  assert.match(stdout, /True/i);
};

const verifyExit = async () => {
  await requestClose();
  const stopped = await Promise.race([closed, delay(12000, null, { ref: false })]);
  assert.deepEqual(stopped, { code: 0, signal: null });
  emit('native process completely exited');
};

const cancelNativeClose = async () => {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TrialClosePrompt {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  public static long Cancel(uint expectedPid) {
    long result = 0;
    EnumWindows((hwnd, data) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != expectedPid) return true;
      var name = new StringBuilder(256);
      GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() != "#32770" || GetDlgItem(hwnd, 7) == IntPtr.Zero) return true;
      if (PostMessage(hwnd, 0x0111, new IntPtr(7), IntPtr.Zero)) result = hwnd.ToInt64();
      return false;
    }, IntPtr.Zero);
    return result;
  }
}
'@
$deadline=(Get-Date).AddSeconds(8)
do {
  $dialogHandle=[TrialClosePrompt]::Cancel(${child.pid})
  if($dialogHandle -ne 0) { "cancelled native dialog HWND $dialogHandle"; exit 0 }
  Start-Sleep -Milliseconds 150
} while((Get-Date) -lt $deadline)
throw 'No native Yes/No dialog for the tested process'
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  assert.match(stdout, /cancelled native dialog HWND \d+/);
  console.log(stdout.trim());
};

async function verify() {
  let available = false;
  for (let retry = 0; retry < 120; retry++) {
    if (child.exitCode !== null) throw new Error(`App exited before WebView2: ${child.exitCode}`);
    try {
      available = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      if (available) break;
    } catch {}
    await delay(500);
  }
  assert.ok(available, 'WebView2 CDP endpoint');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const [context] = browser.contexts();
  page = context.pages()[0] ?? (await context.waitForEvent('page'));
  page.setDefaultTimeout(20000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  page.on('pageerror', (error) => console.log('pageerror', error.message));
  await page.getByRole('heading', { name: '学习区' }).waitFor();
  const identity = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const directories = {};
    for (const [label, directory] of Object.entries({ config: 13, data: 14, local: 15, cache: 16, log: 17 })) {
      directories[label] = await invoke('plugin:path|resolve_directory', { directory });
    }
    return {
      name: await invoke('plugin:app|name'),
      version: await invoke('plugin:app|version'),
      updaterDisabled: await invoke('is_updater_disabled'),
      url: location.href,
      agent: navigator.userAgent,
      directories,
    };
  });
  assert.equal(identity.version, '0.1.0');
  assert.equal(identity.updaterDisabled, true);
  assert.equal(identity.name, mode === 'restore' ? 'Readest IELTS Trial Restore' : 'Readest IELTS Trial');
  assert.match(identity.url, /^https?:\/\/tauri\.localhost/);
  const blocked = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/', { signal: AbortSignal.timeout(4000) });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true);
  const nativeProbe = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const url = 'https://example.com/';
    const rid = await invoke('plugin:http|fetch', {
      clientConfig: { method: 'GET', url, headers: [], connectTimeout: 2000 },
    });
    try {
      await invoke('plugin:http|fetch_send', { rid });
      return null;
    } catch (error) {
      return String(error);
    }
  });
  assert.match(nativeProbe, /request|connect|proxy/i);
  emit('native identity and WebView external request blocked', {
    ...identity,
    pid: child.pid,
    sha256: createHash('sha256').update(await readFile(exe)).digest('hex'),
    offlineBoundary: 'WebView2 proxy set to unreachable loopback, native proxy environment also set',
    nativeProbe,
  });
  await page.screenshot({ path: join(output, 'home.png') });
  if (mode === 'smoke') {
    await verifyExit();
    return;
  }

  const openModule = async (name, material) => {
    await page.getByRole('link', { name: new RegExp(`^${name}`) }).first().click();
    await page.getByRole('link', { name: material, exact: true }).click();
  };
  const home = async () => {
    if (new URL(page.url()).pathname.startsWith('/reader')) {
      const box = await page.locator('.foliate-viewer').first().boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width / 2, box.y + 4);
      await page.getByRole('button', { name: /^(Go to Library|前往书库|前往書庫)$/ }).first().click();
      await page.waitForURL(/\/library/);
    }
    await page.getByRole('link', { name: '学习区', exact: true }).first().click();
    await page.getByRole('heading', { name: '学习区' }).waitFor();
  };
  const openReaderSense = async (label) => {
    await page.getByRole('button', { name: `打开阅读${label}原文` }).click();
    await page.waitForURL(/\/reader/);
    let target;
    for (let attempt = 0; attempt < 80 && !target; attempt++) {
      for (const frame of page.frames()) {
        const candidate = frame.getByRole('button', { name: 'atmosphere', exact: true }).first();
        if (await candidate.isVisible()) {
          target = candidate;
          break;
        }
      }
      if (!target) await delay(250);
    }
    assert.ok(target, `Reading ${label} atmosphere exists in its source sentence`);
    await target.click();
    const dialog = page.getByRole('dialog', { name: '本篇用义' });
    await dialog.waitFor();
    return { dialog, paragraph: target.locator('xpath=ancestor::p[1]') };
  };

  await openModule('阅读', '001–020 阅读A');
  const { dialog: a, paragraph } = await openReaderSense('A');
  if (mode === 'exercise') {
    await a.getByText('气氛', { exact: true }).waitFor();
    await a.getByRole('button', { name: '编辑个人释义' }).click();
    const draft = a.getByLabel('个人释义');
    await draft.fill(personal);
    await requestClose();
    await cancelNativeClose();
    assert.equal(await draft.inputValue(), personal);
    // Inject one failure at the WebView-to-native storage transport. Reads and
    // the successful retry still use the actual native database plugin.
    await page.evaluate(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (request, options) => {
        const address = new URL(String(request), location.href);
        const write =
          address.hostname === 'ipc.localhost' &&
          decodeURIComponent(address.pathname).endsWith('plugin:turso|execute') &&
          String(options?.body).includes('INSERT INTO learning_commits');
        if (!write) return nativeFetch(request, options);
        window.fetch = nativeFetch;
        await new Promise((resolve) => {
          window.releaseTrialWrite = resolve;
        });
        return new Response('Injected native storage transport failure', {
          status: 500,
          headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
        });
      };
    });
    await a.getByRole('button', { name: '保存释义' }).click();
    await page.waitForFunction(() => typeof window.releaseTrialWrite === 'function');
    await requestClose();
    await delay(450);
    assert.equal(child.exitCode, null);
    assert.equal(await draft.inputValue(), personal);
    await page.evaluate(() => window.releaseTrialWrite());
    await a.getByText('保存失败。当前编辑仍在，可重试。').waitFor();
    await requestClose();
    await cancelNativeClose();
    assert.equal(await draft.inputValue(), personal);
    await a.getByRole('button', { name: '保存释义' }).click();
    await a.getByText('已保存', { exact: true }).waitFor();
    await a.getByRole('button', { name: '标为待复习' }).click();
    await a.getByRole('button', { name: '取消待复习' }).waitFor();
    emit('WM_CLOSE preserved the draft during pending and failed writes; native retry succeeded');
  }
  await a.getByText(personal, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'reading-a.png') });
  await a.getByRole('button', { name: '关闭', exact: true }).click();
  if (mode === 'exercise') {
    await paragraph.evaluate((element) => {
      const doc = element.ownerDocument;
      const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text && text.textContent.trim().length < 20) text = walker.nextNode();
      if (!text) throw new Error('Reading A has no selectable source text');
      const range = doc.createRange();
      range.setStart(text, 0);
      range.setEnd(text, Math.min(50, text.textContent.length));
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      doc.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: rect.left + 5,
          clientY: rect.top + 5,
          bubbles: true,
          pointerType: 'mouse',
        }),
      );
    });
    const popup = page.locator('.selection-popup');
    await popup.getByRole('button', { name: annotate }).click();
    const editor = page.getByTestId('booknote-note-editor');
    await editor.getByRole('textbox').fill(note);
    await editor.getByRole('button', { name: /^(Save|保存|儲存)$/ }).click();
    await editor.waitFor({ state: 'hidden' });
  }
  const readerBox = await page.locator('.foliate-viewer').first().boundingBox();
  assert.ok(readerBox);
  const sidebar = page.getByRole('navigation', { name: /^(Sidebar|侧边栏|側邊欄)$/ });
  if (!(await sidebar.isVisible())) {
    await page.mouse.click(readerBox.x + readerBox.width / 2, readerBox.y + 4);
    await page.getByRole('button', { name: /^(Toggle Sidebar|切换侧边栏|切換側邊欄)$/ }).first().click();
  }
  await sidebar.getByRole('button', { name: annotate }).click();
  await sidebar.getByText(note, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'reading-a-note.png') });
  emit('reading note visible through the reader sidebar', { note });
  await home();
  await openModule('阅读', '001–020 阅读B');
  await page.getByLabel('只看待复习').check();
  await page.getByRole('button', { name: /atmosphere/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /hydrosphere/ }).count(), 0);
  await page.getByLabel('只看待复习').uncheck();
  const { dialog: b } = await openReaderSense('B');
  await b.getByText(personal, { exact: true }).waitFor();
  await b.getByText('源釋義：氣氛', { exact: true }).or(b.getByText('源释义：气氛')).waitFor();
  await page.screenshot({ path: join(output, 'reading-b.png') });
  emit('reading A and B source occurrence, shared personal meaning, reading mark and filter');

  await home();
  await openModule('写作', '001–020 写作词表');
  const writing = page.getByRole('button', { name: new RegExp(personal) });
  await writing.waitFor();
  assert.equal(await page.getByText('atmosphere', { exact: true }).count(), 0);
  await writing.click();
  await page.getByText('atmosphere', { exact: true }).waitFor();
  await page.getByRole('button', { name: '标为待复习' }).waitFor();
  await home();
  await openModule('写作', '001–020 写作词表');
  await writing.waitFor();
  assert.equal(await page.getByText('atmosphere', { exact: true }).count(), 0);
  await home();
  await openModule('口语', '001–020 口语词表');
  await page.getByText('查看跟读原稿', { exact: true }).click();
  await page.getByText(/Before the school group arrives/).waitFor();
  emit('writing concealment on re-entry, separate writing mark and speaking transcript');

  await home();
  await openModule('听力', '001–010 原音练习');
  const input = page.getByRole('textbox', { name: 'atmosphere 出现序号' });
  await input.waitFor();
  assert.equal(await page.getByRole('textbox').count(), 7);
  const firstResult = page.getByText('已填写序号准确率 1/2（50%）', { exact: true });
  if (mode === 'exercise') {
    await input.fill('1、8');
    await page.getByRole('button', { name: '展开原稿' }).click();
    assert.equal(await input.inputValue(), '1、8');
    await page.getByRole('button', { name: '收起原稿' }).click();
    await page.getByRole('button', { name: '核对', exact: true }).click();
    await firstResult.waitFor();
    await input.fill('1');
    await page.getByRole('button', { name: '保存填写', exact: true }).click();
    await page.getByText('已保存', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '1');
    await firstResult.waitFor();
    await page.getByRole('button', { name: '新一轮', exact: true }).click();
    await page.getByText('第 2 轮 · 未核对', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '');
    await input.fill('7');
    await page.getByRole('button', { name: '保存填写', exact: true }).click();
    await page.getByText('已保存', { exact: true }).waitFor();
  }
  assert.equal(await input.inputValue(), '7');
  const history = page.getByRole('region', { name: '历史轮次' });
  await history.getByText('第 1 轮 · 1/2', { exact: true }).click();
  await history.getByText(/已填写序号准确率 1\/2（50%）/).waitFor();
  await history.getByText('1、8', { exact: true }).waitFor();
  await history.getByText('核对后的填写', { exact: true }).waitFor();
  await history.getByText('1', { exact: true }).waitFor();
  emit('native listening saved value and frozen first check', {
    currentInput: '7',
    originalInput: '1、8',
    correctedInput: '1',
    first: '1/2',
  });

  await page.evaluate((capture) => {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this instanceof HTMLAudioElement && this.src.startsWith('blob:') && !window.trialMedia) {
        const context = new AudioContext();
        const source = context.createMediaElementSource(this);
        const analyser = context.createAnalyser();
        const recording = context.createMediaStreamDestination();
        source.connect(analyser);
        analyser.connect(context.destination);
        analyser.connect(recording);
        const recorder = new MediaRecorder(recording.stream);
        const chunks = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        window.trialMedia = { element: this, analyser, chunks, recorder };
        void context.resume();
        if (capture) {
          recorder.start();
          this.addEventListener('ended', () => recorder.stop(), { once: true });
        }
      }
      return originalPlay.call(this);
    };
  }, mode === 'exercise');
  const play = page.getByRole('button', { name: '播放原音', exact: true });
  const pause = page.getByRole('button', { name: '暂停', exact: true });
  await play.click();
  await page.waitForFunction(() => window.trialMedia?.element.currentTime > 0.25);
  const media = await page.evaluate(async () => {
    const element = window.trialMedia.element;
    const response = await fetch(element.src);
    const bytes = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    return { hash, duration: element.duration, bytes: bytes.byteLength };
  });
  assert.equal(media.hash, '128a967e08c895829efc24d5c1112d38b40585ce28e6ba2dc2f34ce25b4accee');
  assert.equal(media.bytes, 492912);
  assert.ok(Math.abs(media.duration - 82.152) < 0.2);
  if (mode === 'exercise') {
    await page.waitForFunction(() => window.trialMedia?.element.ended, undefined, { timeout: 100000 });
    await page.waitForFunction(() => window.trialMedia?.chunks.length > 0);
    const recorded = await page.evaluate(async () => {
      const capture = window.trialMedia;
      return Array.from(new Uint8Array(await new Blob(capture.chunks).arrayBuffer()));
    });
    await writeFile(join(output, 'native-media.webm'), Buffer.from(recorded));
  } else {
    await pause.click();
    const slider = page.getByRole('slider', { name: '原音播放位置' });
    const pausedAt = await page.evaluate(() => window.trialMedia.element.currentTime);
    await delay(400);
    assert.equal(await page.evaluate(() => window.trialMedia.element.currentTime), pausedAt);
    for (const key of ['Home', 'PageUp', 'PageUp', 'PageUp', 'PageUp', 'PageUp']) await slider.press(key);
    await page.waitForFunction(() => {
      const time = window.trialMedia.element.currentTime;
      return time > 35 && time < 50;
    });
    await play.click();
    await page.waitForFunction(() => {
      const { element, analyser } = window.trialMedia;
      const signal = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(signal);
      return element.currentTime > 35 && signal.some((value) => Math.abs(value) > 0.01);
    });
    await pause.click();
    await slider.press('End');
    for (let i = 0; i < 40; i++) await slider.press('ArrowLeft');
    await play.click();
    await page.waitForFunction(() => window.trialMedia.element.currentTime > 75);
    await pause.click();
  }
  await page.screenshot({ path: join(output, 'listening.png') });
  emit('exact fixed audio in native WebView2', {
    ...media,
    verification: mode === 'exercise' ? 'full playback and Web Audio capture' : 'pause, seek and resume',
  });
  await verifyExit();
}

try {
  await verify();
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
    console.error((await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 1200));
  }
  throw error;
} finally {
  await writeFile(join(output, 'checks.json'), JSON.stringify(checks, null, 2));
  if (child.exitCode === null) child.kill();
}
