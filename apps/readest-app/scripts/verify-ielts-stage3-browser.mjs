import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [baseURL, executablePath, output, scope = 'all'] = process.argv.slice(2);
if (!baseURL || !executablePath || !output) throw new Error('Expected URL, Chromium executable and screenshot directory');
await mkdir(output, {recursive:true});
const browser = await chromium.launch({ executablePath, headless:true });
try {
  const context = await browser.newContext({ baseURL, viewport: {width: 1280, height: 850} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    const connected = new WeakMap();
    HTMLMediaElement.prototype.play = function () {
      if (this instanceof HTMLAudioElement && this.src.startsWith('blob:')) {
        let capture = connected.get(this);
        if (!capture) {
          const audioContext = new AudioContext();
          const source = audioContext.createMediaElementSource(this);
          const analyser = audioContext.createAnalyser();
          source.connect(analyser);
          analyser.connect(audioContext.destination);
          capture = { element: this, audioContext, analyser };
          connected.set(this, capture);
        }
        window.stage3Media = capture;
        void capture.audioContext.resume();
      }
      return play.call(this);
    };
  });
  await page.goto('/', {waitUntil:'domcontentloaded',timeout:90000});
  await page.getByRole('heading', {name:'学习区'}).waitFor();
  await page.screenshot({path:join(output,'desktop-home.png')});
  if (scope === 'all' || scope === 'reader') {
    await page.getByRole('link', {name:/阅读/}).click();
    await page.getByRole('link', {name:'001–020 阅读A'}).click();
    await page.getByRole('button', {name:'打开阅读A原文'}).click();
    await page.waitForURL(/\/reader/);
    let target;
    for (let tries = 0; tries < 40; tries++) {
      for (const frame of page.frames()) {
        const candidate = frame.locator('p#a-p01').getByRole('button', {name:'atmosphere',exact:true}).first();
        if (await candidate.isVisible()) { target = candidate; break; }
      }
      if (target) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!target) {
      await page.screenshot({path:join(output,'reader-failure.png')});
      console.log(JSON.stringify({url:page.url(),frames:page.frames().map(frame => frame.url()),errors,text:(await page.locator('body').innerText()).slice(0,1500)}));
    }
    assert.ok(target, 'Reading A exact paragraph should be displayed in a reader frame');
    await target.click();
    const dialog = page.getByRole('dialog', {name:'本篇用义'});
    await dialog.getByText('气氛', {exact:true}).waitFor();
    await dialog.getByRole('button', {name:'编辑个人释义'}).click();
    await dialog.getByLabel('个人释义').fill('本次文章使用的气氛');
    await dialog.getByRole('button', {name:'保存释义'}).click();
    await dialog.getByText('已保存', {exact:true}).waitFor();
    await dialog.getByRole('button', {name:'标为待复习'}).click();
    await dialog.getByRole('button', {name:'取消待复习'}).waitFor();
    await page.screenshot({path:join(output,'reader-sense.png')});
    await page.goto('/learning?module=reading&material=B');
    await page.getByRole('button', {name:/atmosphere/}).click();
    await page.getByText('本次文章使用的气氛', {exact:true}).waitFor();
    await page.getByLabel('只看待复习').check();
    await page.getByRole('button', {name:/atmosphere/}).waitFor();
    assert.equal(await page.getByRole('button', {name:/hydrosphere/}).count(), 0);
    await page.getByRole('button', {name:'取消待复习'}).click();
    await page.getByText('没有符合筛选的义项。').waitFor();
    await page.goto('/learning?module=writing&material=trial');
    await page.getByRole('button', {name:/本次文章使用的气氛/}).waitFor();
    assert.equal(await page.getByText('atmosphere',{exact:true}).count(),0);
    await page.getByRole('button', {name:/本次文章使用的气氛/}).click();
    await page.getByText('atmosphere',{exact:true}).waitFor();
    await page.goto('/learning?module=speaking&material=trial');
    await page.getByRole('button', {name:'播放原音'}).waitFor();
    await page.getByText('剑桥词典发音（需联网）').waitFor();
    await page.getByText('查看跟读原稿',{exact:true}).click();
    await page.getByText(/Before the school group arrives/).waitFor();
    console.log('reader mapping and A → B shared meaning passed');
  }
  if (scope === 'all' || scope === 'listening') {
    await page.setViewportSize({width:390,height:720});
    await page.goto('/learning?module=listening&material=trial');
    const input = page.getByRole('textbox', {name:'atmosphere 出现序号'});
    await input.waitFor();
    assert.equal(await page.getByRole('textbox').count(),7);
    await input.fill('1、8');
    await page.getByRole('button', {name:'展开原稿'}).click();
    assert.equal(await input.inputValue(), '1、8');
    await page.getByRole('button', {name:'收起原稿'}).click();
    await page.getByRole('button', {name:'核对', exact:true}).click();
    await page.getByText('已填写序号准确率 1/2（50%）', {exact:true}).waitFor();
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), '1、8');
    await page.getByRole('button', {name:'播放原音'}).click();
    await page.waitForFunction(() => window.stage3Media?.element.currentTime > 0.3);
    const slider = page.getByRole('slider', {name:'原音播放位置'});
    const pause = page.getByRole('button', {name:'暂停',exact:true});
    await pause.click();
    const pausedAt = await page.evaluate(() => window.stage3Media.element.currentTime);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.stage3Media.element.currentTime), pausedAt);
    await slider.press('Home');
    for (let i=0;i<5;i++) await slider.press('PageUp');
    await page.waitForFunction(() => window.stage3Media.element.currentTime > 35 && window.stage3Media.element.currentTime < 50);
    await page.getByRole('button', {name:'播放原音'}).click();
    const middleSignal = await captureSignal(36, 55);
    await pause.click();
    await slider.press('End');
    for(let i=0;i<45;i++) await slider.press('ArrowLeft');
    await page.waitForFunction(() => window.stage3Media.element.currentTime > 75 && window.stage3Media.element.currentTime < 81);
    await page.getByRole('button', {name:'播放原音'}).click();
    const endSignal = await captureSignal(75, 82.2);
    await page.getByRole('button', {name:'展开原稿'}).click();
    await page.screenshot({path:join(output,'mobile-listening.png'),fullPage:true});
    assert.equal(await input.inputValue(),'1、8');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    console.log('OPFS reload, counting, playback clock, pause, resume and seeking passed');
    console.log(JSON.stringify({middleSignal,endSignal,method:'Chromium Web Audio analyser on the playing media element, before the audio output destination'}));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pageErrors: errors }));

  async function captureSignal(min, max) {
    const observation = await page.waitForFunction(([from,to]) => {
      const {element,analyser} = window.stage3Media;
      if (element.paused || element.currentTime < from || element.currentTime > to) return null;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum,x) => sum + x*x,0) / samples.length);
      return rms > 0.005 ? {seconds:element.currentTime, duration:element.duration,rms} : null;
    }, [min,max]);
    return observation.jsonValue();
  }
} finally {
  await browser.close();
}
