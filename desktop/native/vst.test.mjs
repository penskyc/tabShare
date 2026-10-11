// Loads real installed VST3s through the addon and runs audio through them (no audio device, nothing audible).
// Run from desktop/: node --test native/vst.test.mjs   (VST_TEST=name1,name2 picks plugins; skipped if not built)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ADDON = new URL('./build/Release/tabshare_vst.node', import.meta.url);
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

test('list, load, process and save state of installed VST3s', { skip: !existsSync(ADDON) && 'addon not built' }, async () => {
  const vst = require(fileURLToPath(ADDON));
  vst.init(() => {}, fileURLToPath(new URL('./build/Release/tabshare_plugin_host', import.meta.url))); // host: macOS only
  const all = vst.list();
  assert.ok(all.length > 0, 'found VST3 bundles');
  vst.prepare(48000, 128);
  const wanted = (process.env.VST_TEST ?? 'bx_cleansweep V2,bx_boom,FreeAMP,Fix Phaser').split(',');
  const picks = all.filter((p) => wanted.includes(p.name));
  assert.ok(picks.length, `none of ${wanted} installed`);
  let ok = 0;
  for (const [i, p] of picks.entries()) {
    try {
      const name = await vst.load(i, p.path);
      const x = new Float32Array(128);
      let out = [];
      const t0 = performance.now();
      for (let b = 0; b < 200; b++) {
        for (let k = 0; k < 128; k++) x[k] = 0.3 * Math.sin((2 * Math.PI * 220 * (b * 128 + k)) / 48000);
        vst.process(i, x);
        if (b > 100) out.push(...x);
      }
      const usPerBlock = ((performance.now() - t0) * 1000) / 200;
      const state = vst.getState(i);
      console.log(`  ${p.name} → "${name}": out rms ${rms(out).toFixed(4)} (in 0.2121), state ${state.length} chars, latency ${vst.latency(i)}, ${usPerBlock.toFixed(0)} µs/block`);
      assert.ok(Number.isFinite(rms(out)));
      ok++;
    } catch (e) {
      console.log(`  ${p.name}: ${e.message}`);
    }
    vst.unload(i);
  }
  assert.ok(ok > 0, 'at least one plugin loaded and processed');
});
