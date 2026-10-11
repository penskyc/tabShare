// The web app's iOS rig path, in Chrome, with a fake engine (platform 'ios') standing in for modules/tabshare-audio:
// voice picker shown and VST hidden, voiceChannel reaches the engine, and the call never captures the mic while the
// rig is on (the rig's voice input replaces it), then takes the mic again when the rig turns off.
// Run with `npm run dev` going in the repo root: node mobile/scripts/web-test.mjs   (uses desktop/'s playwright-core)
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
  const gum = () => page.evaluate(() => window.__gumAudio);
  if ((await gum()) !== 0) fail('call captured the mic while the rig was on');
  await page.getByRole('button', { name: /turn off rig/i }).click();
  await page.waitForTimeout(1500);
  if ((await gum()) !== 1) fail('call did not take the mic back after the rig turned off');
  const errors = await page.locator('.call-error').allTextContents();
  if (errors.length) fail(`errors shown: ${errors}`);
  console.log(process.exitCode ? 'iOS web test failed' : 'iOS web test passed: voice picker, voiceChannel, no mic capture while the rig is on, mic back after');
} finally {
  await browser.close();
  await fetch(`${api}/api/admin/rooms/${room.roomId}`, { method: 'DELETE', headers: admin });
}
