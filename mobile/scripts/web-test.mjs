// The web app's iOS rig path, in Chrome, with a fake engine (platform 'ios') standing in for modules/tabshare-audio:
// voice picker shown and VST hidden, voiceChannel reaches the engine, and the call never captures the mic while the
// rig is on (the rig's voice input replaces it), then takes the mic again when the rig turns off. Then TONE3000 (mocked):
// the page asks the app for a sign-in sheet (authOpen), the real t3k-callback.html sends the redirect on to the app's
// tabshare:// scheme, and the app's authResult signs in and loads the picked tone.
// Run with `npm run dev` going in the repo root: node mobile/scripts/web-test.mjs   (uses desktop/'s playwright-core)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../desktop/package.json', import.meta.url))('playwright-core');
const api = 'http://localhost:3001', url = 'http://localhost:5173';
const post = (p, body, headers = {}) => fetch(api + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

const { token } = await post('/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASSWORD ?? 'devadmin' });
const admin = { authorization: `Bearer ${token}` };
const room = await post('/api/rooms', { name: 'iOS web test', password: 'smoke1234' }, admin);
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const page = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  await page.addInitScript(() => {
    window.__gumAudio = 0;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => (c?.audio && window.__gumAudio++, gum(c));
    const L = new Set();
    const out = (m) => setTimeout(() => L.forEach((l) => l(m)), 5);
    window.__out = out;
    let timer = null;
    window.__sent = [];
    window.tabshareNative = {
      platform: 'ios',
      onMessage: (cb) => (L.add(cb), () => L.delete(cb)),
      send: (m) => {
        window.__sent.push(m);
        if (m.type === 'devices') out({ type: 'devices', devices: [{ name: 'AudioBox Go', inputs: 2, outputs: 2 }] });
        if (m.type === 'vstList') out({ type: 'vstList', available: false, plugins: [] });
        if (m.type === 'start') {
          out({ type: 'started', device: 'AudioBox Go', sampleRate: 48000, bufferSize: 128, latencyMs: 6, inputs: 2, outputs: 2 });
          timer = setInterval(() => {
            out({ type: 'voice', samples: new Float32Array(1024).map((_, i) => 0.3 * Math.sin(i / 7.6)) });
            out({ type: 'pcm', samples: new Float32Array(1024).map(() => (Math.random() - 0.5) * 0.2) });
          }, 21);
        }
        if (m.type === 'stop') (clearInterval(timer), out({ type: 'stopped' }));
      },
    };
  });
  await page.goto(`${url}/#/r/${room.roomId}`);
  await page.getByPlaceholder('e.g. Corey').fill('iPad');
  await page.locator('input[type=password]').first().fill('smoke1234');
  await page.locator('button.btn.primary.big').click();
  await page.getByRole('button', { name: /^Rig/ }).first().click();
  const voice = page.getByLabel(/Voice \(call\)/);
  const options = await voice.locator('option').allTextContents();
  if (options.join('|') !== 'None (silent while playing)|Input 2') fail(`voice options: ${options}`);
  if (await page.getByLabel('VST3 plugin').count()) fail('VST section shown on iOS');
  await voice.selectOption('2');
  await page.getByRole('button', { name: /turn on rig/i }).click();
  await page.waitForTimeout(800);
  const params = (await page.evaluate(() => window.__sent.filter((m) => m.type === 'params'))).at(-1)?.params;
  if (params?.voiceChannel !== 1) fail(`voiceChannel sent: ${JSON.stringify(params)}`);
  await page.getByRole('button', { name: /Start call|Join call/ }).first().click();
  await page.waitForTimeout(2000);
  if (await page.getByRole('button', { name: /Pop out/ }).count()) fail('Pop out shown in the iOS app (its web view has no windows)');
  const gum = () => page.evaluate(() => window.__gumAudio);
  if ((await gum()) !== 0) fail('call captured the mic while the rig was on');
  await page.getByRole('button', { name: /turn off rig/i }).click();
  await page.waitForTimeout(1500);
  if ((await gum()) !== 1) fail('call did not take the mic back after the rig turned off');
  const errors = await page.locator('.call-error').allTextContents();
  if (errors.length) fail(`errors shown: ${errors}`);

  // TONE3000 through the app's sign-in sheet.
  const nam = readFileSync(new URL('../../.playwright-mcp/test.nam', import.meta.url), 'utf8');
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  const json = (route, body) => route.fulfill({ headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await page.context().route('https://www.tone3000.com/**', (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (u.pathname.endsWith('/oauth/authorize'))
      return route.fulfill({ status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}?code=c1&state=${u.searchParams.get('state')}&tone_id=42` } });
    if (u.pathname.endsWith('/oauth/token')) return json(route, { access_token: 'a', refresh_token: 'r', expires_in: 3600 });
    if (u.pathname.endsWith('/tones/42')) return json(route, { id: 42, title: 'Test tone' });
    if (u.pathname.endsWith('/models')) return json(route, { data: [{ id: 7, name: 'Crunch', size: 'standard', model_url: 'https://www.tone3000.com/dl/7', architecture_version: 2 }] });
    if (u.pathname === '/dl/7') return route.fulfill({ headers: { ...cors, 'content-type': 'text/plain' }, body: nam });
    return route.fulfill({ status: 404, headers: cors });
  });
  const authOpen = async () => {
    await page.getByRole('button', { name: 'Browse TONE3000' }).click();
    await page.waitForFunction(() => window.__sent.some((m) => m.type === 'authOpen'));
    return page.evaluate(() => { const i = window.__sent.findIndex((m) => m.type === 'authOpen'); return window.__sent.splice(i, 1)[0].url; });
  };
  // Canceling the sheet: no error, button usable again.
  await authOpen();
  await page.evaluate(() => window.__out({ type: 'authResult', url: null }));
  await page.waitForTimeout(300);
  if (await page.getByText(/TONE3000:|failed/i).count()) fail('error shown after canceling the sign-in sheet');
  // Signing in: the "sheet" (a second page) follows authorize -> t3k-callback.html -> tabshare://.
  const authUrl = await authOpen();
  if (!new URL(authUrl).searchParams.get('state')?.startsWith('app.')) fail(`state without the app. prefix: ${authUrl}`);
  const sheet = await page.context().newPage();
  const appUrl = new Promise((resolve) => {
    sheet.on('request', (r) => r.url().startsWith('tabshare:') && resolve(r.url()));
    sheet.on('requestfailed', (r) => r.url().startsWith('tabshare:') && resolve(r.url()));
  });
  await sheet.goto(authUrl).catch(() => {});
  const callback = await Promise.race([appUrl, new Promise((r) => setTimeout(() => r(null), 5000))]);
  if (!callback?.startsWith('tabshare://t3k-callback?code=c1')) fail(`callback page did not hand off to the app: ${callback}`);
  await sheet.close();
  await page.evaluate((url) => window.__out({ type: 'authResult', url }), callback);
  await page.getByRole('button', { name: /turn on rig/i }).click(); // the engine gets the model while the rig is on
  await page.waitForFunction(() => window.__sent.some((m) => m.type === 'loadModel'), null, { timeout: 5000 }).catch(() => fail('picked tone was not loaded'));
  if (!(await page.getByText('Test tone').count())) fail('tone name not shown');
  console.log(process.exitCode ? 'iOS web test failed' : 'iOS web test passed: voice picker, voiceChannel, no mic capture while the rig is on, mic back after, TONE3000 via the app');
} finally {
  await browser.close();
  await fetch(`${api}/api/admin/rooms/${room.roomId}`, { method: 'DELETE', headers: admin });
}
