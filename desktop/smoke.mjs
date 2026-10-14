// End-to-end check of the desktop app against a running tabShare (default: local `npm run dev`).
// Opens a room, turns the native rig on with the monitor MUTED (nothing reaches the speakers), loads a model,
// and checks the engine starts, reports latency, and streams processed audio into the page for the call.
// Usage (from desktop/): node smoke.mjs [path-to-app-exe]   env: TABSHARE_URL, ADMIN_USERNAME/ADMIN_PASSWORD, NAM_FILE
import { _electron as electron } from 'playwright-core';
import { readFileSync } from 'node:fs';

const url = process.env.TABSHARE_URL ?? 'http://localhost:5173';
const api = url.replace(':5173', ':3001');
const exe = process.argv[2];
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exitCode = 1;
};

// Sign in as the admin, make an API key for the app (the server requires one from the desktop app), make a room.
const post = (p, body, headers = {}) => fetch(api + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
const { token } = await post('/api/admin/login', { username: process.env.ADMIN_USERNAME ?? 'admin', password: process.env.ADMIN_PASSWORD ?? 'devadmin' });
if (!token) throw new Error('admin sign-in failed (ADMIN_USERNAME / ADMIN_PASSWORD)');
const admin = { authorization: `Bearer ${token}` };
const apiKey = await post('/api/admin/keys', { name: 'desktop smoke test' }, admin);
const created = await post('/api/rooms', { name: 'Desktop smoke', password: 'smoke1234' }, admin);

const appEnv = { ...process.env, TABSHARE_URL: url, TABSHARE_API_KEY: apiKey.key };
const app = await electron.launch(exe ? { executablePath: exe, env: appEnv } : { args: ['.'], env: appEnv });
app.process().stdout.on('data', (d) => process.stdout.write('[app] ' + d));
app.process().stderr.on('data', (d) => process.stdout.write('[app] ' + d));
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  await page.waitForLoadState('domcontentloaded');
  // Mute monitoring before the rig ever starts.
  await page.evaluate(() => {
    localStorage.setItem('tabshare.rig.monitor', '0');
    localStorage.setItem('tabshare.rig.outputDb', '-40');
  });
  if (!(await page.evaluate(() => !!window.tabshareNative))) throw new Error('window.tabshareNative missing');

  await page.evaluate((id) => {
    location.hash = `#/r/${id}`;
    location.reload();
  }, created.roomId);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('button.btn.primary.big').waitFor();
  await page.getByPlaceholder('e.g. Corey').fill('Smoke');
  await page.locator('input[type=password]').first().fill('smoke1234');
  await page.locator('button.btn.primary.big').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '../.playwright-mcp/desktop-room.png' });

  // Talk to the engine directly through the bridge, like useRig does.
  const result = await page.evaluate(async (namJson) => {
    const n = window.tabshareNative;
    const msgs = [];
    let pcm = 0;
    n.onMessage((m) => (m.type === 'pcm' ? pcm++ : msgs.push(m)));
    const wait = (type, ms = 5000) =>
      new Promise((res, rej) => {
        const t0 = Date.now();
        const tick = () => {
          const m = msgs.find((x) => x.type === type || x.type === 'error');
          if (m) return res(m);
          if (Date.now() - t0 > ms) return rej(new Error(`timeout waiting for ${type}`));
          setTimeout(tick, 20);
        };
        tick();
      });
    n.send({ type: 'devices' });
    const devices = await wait('devices');
    const device = devices.devices.find((d) => d.name.includes('Universal Audio'))?.name ?? devices.devices[0]?.name;
    n.send({ type: 'start', device, outChannel: 0, bufferSize: 128 });
    const started = await wait('started');
    n.send({ type: 'params', params: { channel: 0, inGain: 1, outGain: 0.01, monitor: false, bypass: false } });
    n.send({ type: 'loadModel', json: namJson });
    const loaded = await wait('modelLoaded');
    // The engine must refuse plugin paths that aren't installed plugins (the page is remote content).
    n.send({ type: 'vstList' });
    const vstRejected = (await wait('vstList')).available
      ? (n.send({ type: 'vstLoad', slot: 15, path: '/tmp/not-a-plugin.vst3' }), (await wait('vstError')).message)
      : 'no addon';
    await new Promise((r) => setTimeout(r, 2000));
    n.send({ type: 'stop' });
    await wait('stopped');
    return { devices: devices.devices, started, loaded, vstRejected, pcmPerSec: pcm / 2.5, errors: msgs.filter((m) => m.type === 'error') };
  }, readFileSync(process.env.NAM_FILE ?? '../.playwright-mcp/test.nam', 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  if (result.started.type !== 'started') fail(`engine did not start: ${JSON.stringify(result.started)}`);
  if (!result.loaded.ok) fail('model did not load');
  if (!/^(Not an installed|no addon)/.test(result.vstRejected)) fail(`made-up plugin path not rejected: ${result.vstRejected}`);
  if (result.pcmPerSec < 50) fail(`call feed too slow: ${result.pcmPerSec} msgs/s`);
  if (result.errors.length) fail(`engine errors: ${JSON.stringify(result.errors)}`);

  // Now through the real UI: Rig panel → Turn on rig → callStream gets a live track.
  await page.getByRole('button', { name: /^Rig/ }).first().click();
  await page.locator('input[type=file][accept*=".nam"]').setInputFiles(process.env.NAM_FILE ?? '../.playwright-mcp/test.nam');
  await page.getByRole('button', { name: /turn on rig/i }).click();
  await page.getByText(/Round-trip latency/).waitFor({ timeout: 8000 });
  await page.locator('.rig-status.ok').waitFor({ timeout: 5000 });
  // Dropout report (0.4.1+): once a second; Windows' patched audify plays output in the same callback ("direct").
  const health = page.getByText(/audio dropouts in the last 10 s/);
  await health.waitFor({ timeout: 5000 });
  const healthText = await health.textContent();
  console.log('audio health:', healthText);
  if (process.platform === 'win32' && !/direct/.test(healthText)) fail(`expected direct output on Windows: ${healthText}`);
  // Cab IR: decoded and normalized by the page, convolved by the engine.
  await page.locator('input[type=file][accept*=".wav"]').setInputFiles(process.env.IR_FILE ?? '../.playwright-mcp/test-ir.wav');
  await page.getByRole('button', { name: 'Clear' }).waitFor({ timeout: 5000 });
  if (await page.locator('.call-error').count()) fail(`rig error: ${await page.locator('.call-error').first().textContent()}`);
  // Call settings list the real devices by name (a failed Electron permission check hides them all).
  await page.getByRole('button', { name: /Start call|Join call/ }).first().click();
  await page.locator('button[title="Devices & audio"]').click();
  const names = await page.locator('.call-settings select').evaluateAll((sels) => sels.map((s) => [...s.options].map((o) => o.text)));
  const generic = /^(Microphone|Camera|Speaker|Default.*)$/;
  if (!names[0]?.some((t) => !generic.test(t))) fail(`call settings show no named microphones: ${JSON.stringify(names)}`);
  else console.log(`call devices: ${names.map((n) => n.length).join(' / ')} (mic / cam / speaker)`);
  await page.locator('button[title="Devices & audio"]').click();
  await page.getByRole('button', { name: 'Leave call' }).click();
  // Tuner with the rig on listens to the engine's dry tap (it falls back to the mic only if no tap arrives in 1.5 s).
  await page.getByRole('button', { name: 'Tuner', exact: true }).click();
  await page.waitForTimeout(2500);
  const tunerSource = await page.locator('.tuner-head .muted').textContent();
  if (!/· input \d/.test(tunerSource)) fail(`tuner isn't on the engine tap: "${tunerSource}"`);
  else console.log('tuner: engine tap,', tunerSource);
  await page.getByRole('button', { name: 'Close tuner' }).click();
  // VST3 (if the addon is built): add a free plugin through the UI, wait for it to load, open its window.
  const vstPicker = page.getByLabel('VST3 plugin');
  if (await vstPicker.count()) {
    const plugin = process.env.VST_PLUGIN ?? 'bx_boom';
    await vstPicker.fill(plugin.slice(1, -1).toUpperCase()); // partial, wrong case: the live search still finds it
    await vstPicker.press('Enter');
    await page.locator('.vst-chain li', { hasText: plugin }).getByText(/ok/).waitFor({ timeout: 15000 });
    // Bypass: the plugin stays in the list (and loaded) but is switched off; then back on.
    const li = page.locator('.vst-chain li', { hasText: plugin });
    await page.getByRole('button', { name: `Bypass ${plugin}` }).click();
    if (!(await li.getAttribute('class'))?.includes('bypassed')) fail('bypass did not switch the plugin off');
    await page.getByRole('button', { name: `Turn on ${plugin}` }).click();
    if ((await li.getAttribute('class'))?.includes('bypassed')) fail('plugin did not switch back on');
    else console.log('vst: bypass off/on ok');
    await page.locator('.vst-chain li', { hasText: plugin }).getByRole('button', { name: 'Edit' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: '../.playwright-mcp/desktop-vst.png' });
    await page.getByRole('button', { name: `Remove ${plugin}` }).click();
    console.log('vst: loaded, editor opened, removed', plugin);
  } else console.log('vst: addon not built, skipped');
  const ui = await page.evaluate(() => document.querySelector('.panel.rig')?.textContent);
  await page.screenshot({ path: '../.playwright-mcp/desktop-rig.png' });
  console.log('rig panel:', ui?.slice(0, 400));
  await page.getByRole('button', { name: /turn off rig/i }).click();
} catch (e) {
  await app.windows()[0]?.screenshot({ path: '../.playwright-mcp/desktop-fail.png' }).catch(() => {});
  fail(e.stack ?? String(e));
} finally {
  await app.close();
  if (created.roomId) {
    await fetch(`${api}/api/admin/rooms/${created.roomId}`, { method: 'DELETE', headers: admin });
    await fetch(`${api}/api/admin/keys/${apiKey.info.id}`, { method: 'DELETE', headers: admin });
  }
}
