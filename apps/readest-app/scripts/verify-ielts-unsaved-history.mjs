import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [url, chrome, output, scenario = 'meaning-cancel'] = process.argv.slice(2);
if (!url || !chrome || !output)
  throw new Error('Expected URL, Chrome executable and output directory');
if (
  !['meaning-cancel', 'meaning-forward', 'listening-history', 'saving', 'failure'].includes(
    scenario,
  )
) {
  throw new Error('Unknown history regression scenario');
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const results = [];
async function browserForward(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const history = await session.send('Page.getNavigationHistory');
    const target = history.entries[history.currentIndex + 1];
    assert.ok(target, 'A genuine forward entry must exist');
    await session.send('Page.navigateToHistoryEntry', { entryId: target.id });
    await page.waitForTimeout(80);
  } finally {
    await session.detach();
  }
}
try {
  if (scenario === 'failure') {
    for (const module of ['reading', 'listening']) {
      const context = await browser.newContext({ baseURL: url });
      await context.addInitScript(() => {
        window.historyTestStorage = { fail: false, injected: 0 };
      });
      // Intercept only the public DatabaseService adapter in this isolated browser.
      // Throw before a write, leaving real reads, migrations and OPFS unchanged.
      await context.route('**/*webDatabaseService_ts_*.js', async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        const marker = 'async execute(sql) {';
        assert.ok(body.includes(marker), 'The storage boundary must actually be instrumented');
        await route.fulfill({
          response,
          body: body.replace(
            marker,
            marker +
              `
          if (window.historyTestStorage.fail && /INSERT INTO (learning_commits|listening_events)/.test(sql)) {
            window.historyTestStorage.injected++;
            throw new Error('INJECTED_STORAGE_FAILURE');
          }`,
          ),
        });
      });
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await page.goto('/learning?module=' + module);
      await page
        .getByRole('link', {
          name: module === 'reading' ? '001–020 阅读A' : '001–010 原音练习',
          exact: true,
        })
        .click();
      await page
        .getByRole('link', { name: module === 'reading' ? '阅读' : '听力', exact: true })
        .click();
      await page.waitForURL('/learning?module=' + module);
      await page.evaluate(() => history.back());
      await page.waitForURL(/material=/);
      if (module === 'reading') {
        await page.getByRole('button', { name: /001 atmosphere/ }).click();
        await page.getByRole('button', { name: '编辑个人释义', exact: true }).click();
      }
      const input = page.getByRole('textbox', {
        name: module === 'reading' ? '个人释义' : 'atmosphere 出现序号',
        exact: true,
      });
      const draft = module === 'reading' ? 'FAILED-DRAFT' : '1、8、7';
      await input.fill(draft);
      await page.evaluate(() => {
        window.historyTestStorage.fail = true;
      });
      await page
        .getByRole('button', { name: module === 'reading' ? '保存释义' : '保存填写', exact: true })
        .click();
      try {
        await page.getByText(/当前编辑仍在|当前填写仍在/).waitFor({ timeout: 5000 });
      } catch (error) {
        console.log(
          JSON.stringify({
            module,
            text: await page.locator('body').innerText(),
            storage: await page.evaluate(() => window.historyTestStorage),
          }),
        );
        throw error;
      }
      const currentURL = page.url();
      await page.evaluate(() => history.back());
      await page.waitForTimeout(80);
      assert.equal(page.url(), currentURL);
      assert.equal(await input.inputValue(), draft);
      await browserForward(page);
      await page
        .getByRole('link', { name: module === 'reading' ? '阅读' : '听力', exact: true })
        .click();
      assert.equal(page.url(), currentURL);
      assert.equal(await input.inputValue(), draft);
      assert.equal(dialogs.length, 3);
      assert.ok(await page.evaluate(() => window.historyTestStorage.injected > 0));
      await page.evaluate(() => {
        window.historyTestStorage.fail = false;
      });
      await page
        .getByRole('button', { name: module === 'reading' ? '保存释义' : '保存填写', exact: true })
        .click();
      await page.getByText('已保存', { exact: true }).first().waitFor();
      await page.reload();
      if (module === 'reading') {
        await page.getByRole('button', { name: /001 atmosphere/ }).click();
        await page.getByText(draft, { exact: true }).waitFor();
      } else {
        await input.waitFor();
        assert.equal(await input.inputValue(), draft);
      }
      results.push({ scenario, module, dialogs, retainedDraft: draft, passed: true });
      await context.close();
    }
  } else if (scenario === 'listening-history' || scenario === 'meaning-forward') {
    const module = scenario === 'meaning-forward' ? 'reading' : 'listening';
    const context = await browser.newContext({ baseURL: url });
    const page = await context.newPage();
    let accept = false;
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message(), accepted: accept });
      if (accept) await dialog.accept();
      else await dialog.dismiss();
    });
    await page.goto('/learning?module=' + module);
    await page
      .getByRole('link', {
        name: module === 'reading' ? '001–020 阅读A' : '001–010 原音练习',
        exact: true,
      })
      .click();
    await page
      .getByRole('link', { name: module === 'reading' ? '阅读' : '听力', exact: true })
      .click();
    await page.waitForURL('/learning?module=' + module);
    await page.evaluate(() => history.back());
    await page.waitForURL(/material=/);
    if (module === 'reading') {
      await page.getByRole('button', { name: /001 atmosphere/ }).click();
      await page.getByRole('button', { name: '编辑个人释义', exact: true }).click();
    }
    const input = page.getByRole('textbox', {
      name: module === 'reading' ? '个人释义' : 'atmosphere 出现序号',
      exact: true,
    });
    await input.waitFor();
    const draft = module === 'reading' ? 'FORWARD-DRAFT' : '1、8、7';
    const currentURL = page.url();
    const started = Date.now();
    await input.fill(draft);
    await page.evaluate(() => history.back());
    const elapsedMilliseconds = Date.now() - started;
    await page.waitForTimeout(60);
    assert.equal(page.url(), currentURL);
    assert.equal(await input.inputValue(), draft);
    await browserForward(page);
    await page.waitForTimeout(60);
    assert.equal(page.url(), currentURL);
    assert.equal(await input.inputValue(), draft);
    assert.equal(dialogs.length, 2);
    accept = true;
    await browserForward(page);
    await page.waitForTimeout(100);
    console.log(
      JSON.stringify({
        scenario,
        afterAccepted: page.url(),
        dialogs,
        history: await page.evaluate(() => ({
          index: window.navigation?.currentEntry?.index,
          entries: window.navigation?.entries().map((e) => ({ index: e.index, url: e.url })),
        })),
      }),
    );
    await page.waitForURL('/learning?module=' + module);
    await page.evaluate(() => history.back());
    if (module === 'reading') {
      await page.getByRole('button', { name: /001 atmosphere/ }).click();
      assert.equal(await page.getByRole('textbox', { name: '个人释义', exact: true }).count(), 0);
      assert.equal(await page.getByText(draft, { exact: true }).count(), 0);
    } else {
      await input.waitFor();
      assert.equal(await input.inputValue(), '');
    }
    assert.equal(dialogs.length, 3, 'Only the accepted discard may leave');
    results.push({ scenario, elapsedMilliseconds, dialogs, passed: true });
    await context.close();
  } else if (scenario === 'saving') {
    for (const module of ['reading', 'listening']) {
      const context = await browser.newContext({ baseURL: url });
      await context.addInitScript(() => {
        const postMessage = Worker.prototype.postMessage;
        window.historyTestStorage = { mode: 'pass', pending: [], held: 0 };
        Worker.prototype.postMessage = function (message, ...args) {
          const state = window.historyTestStorage;
          if (message?.__turso__ === 'write_async' && state.mode === 'hold') {
            state.held++;
            state.pending.push(() => postMessage.call(this, message, ...args));
            return;
          }
          return postMessage.call(this, message, ...args);
        };
      });
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });
        await dialog.accept();
      });
      await page.goto('/learning?module=' + module);
      await page
        .getByRole('link', {
          name: module === 'reading' ? '001–020 阅读A' : '001–010 原音练习',
          exact: true,
        })
        .click();
      await page
        .getByRole('link', { name: module === 'reading' ? '阅读' : '听力', exact: true })
        .click();
      await page.waitForURL('/learning?module=' + module);
      await page.evaluate(() => history.back());
      await page.waitForURL(/material=/);
      if (module === 'reading') {
        await page.getByRole('button', { name: /001 atmosphere/ }).click();
        await page.getByRole('button', { name: '编辑个人释义', exact: true }).click();
      }
      const input = page.getByRole('textbox', {
        name: module === 'reading' ? '个人释义' : 'atmosphere 出现序号',
        exact: true,
      });
      await input.waitFor();
      await page.evaluate(() => {
        window.historyTestStorage.mode = 'hold';
      });
      await input.fill(module === 'reading' ? 'SAVE-IN-FLIGHT' : '1、8、7');
      await page
        .getByRole('button', { name: module === 'reading' ? '保存释义' : '保存填写', exact: true })
        .click();
      await page.waitForFunction(() => window.historyTestStorage.held > 0);
      const currentURL = page.url();
      await page.evaluate(() => history.back());
      await page.waitForTimeout(100);
      assert.equal(
        page.url(),
        currentURL,
        'Saving must block history navigation until acknowledgement',
      );
      assert.equal(
        dialogs.length,
        0,
        'Pending writes block leaving while the page displays saving',
      );
      await browserForward(page);
      await page
        .getByRole('link', { name: module === 'reading' ? '阅读' : '听力', exact: true })
        .click();
      assert.equal(page.url(), currentURL);
      assert.equal(dialogs.length, 0);
      await page.evaluate(() => {
        const state = window.historyTestStorage;
        state.mode = 'pass';
        for (const resume of state.pending.splice(0)) resume();
      });
      await page.getByText('已保存', { exact: true }).first().waitFor();
      await page.evaluate(() => history.back());
      await page.waitForURL('/learning?module=' + module);
      await page.evaluate(() => history.forward());
      if (module === 'reading') {
        await page.getByRole('button', { name: /001 atmosphere/ }).click();
        await page.getByText('SAVE-IN-FLIGHT', { exact: true }).waitFor();
      } else {
        await input.waitFor();
        assert.equal(await input.inputValue(), '1、8、7');
      }
      results.push({ scenario, module, dialogs, passed: true });
      await context.close();
    }
  } else {
    for (let repetition = 0; repetition < 2; repetition++) {
      const context = await browser.newContext({ baseURL: url });
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });
        await dialog.dismiss();
      });
      await page.goto('/learning?module=reading', { timeout: 90000 });
      await page.getByRole('link', { name: '001–020 阅读A', exact: true }).click();
      await page.getByRole('button', { name: /001 atmosphere/ }).click();
      await page.getByRole('button', { name: '编辑个人释义', exact: true }).click();
      const input = page.getByRole('textbox', { name: '个人释义', exact: true });
      const draft = 'BACK-REPAIR-' + repetition;
      await input.fill(draft);
      const currentURL = page.url();
      await page.evaluate(() => history.back());
      await page.waitForTimeout(120);
      assert.equal(page.url(), currentURL, 'Cancel must retain current history position');
      assert.equal(
        await input.inputValue(),
        draft,
        'Cancel must retain the editor and its exact draft',
      );
      assert.equal(dialogs.length, 1, 'Back should request exactly one leave confirmation');
      results.push({ scenario, repetition, dialogs, retainedDraft: draft, passed: true });
      await context.close();
    }
  }
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results));
