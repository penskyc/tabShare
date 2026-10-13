// Room audio addon (tabshare_net.node): two rooms link through a local AOO connection server and hear each other.
// Run from desktop/: node --test native/net.test.mjs   (skipped if the addon isn't built; NET_LIVE=1 also tries
// aoo.sonobus.net)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

let net = null;
try {
  net = createRequire(import.meta.url)('./build/Release/tabshare_net.node');
} catch {
  /* not built */
}
const SR = 48000;
const N = Number(process.env.NET_BLOCK ?? 128);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

/** Drives both rooms like audio callbacks; a sends a 440 Hz sine. Returns the energy b received and its zero crossings. */
async function run(a, b, blocks, onBlock) {
  const tone = new Float32Array(N);
  const outA = new Float32Array(2 * N);
  const outB = new Float32Array(2 * N);
  let phase = 0;
  let energy = 0;
  let crossings = 0;
  let prev = 0;
  let counted = 0;
  const t0 = performance.now();
  for (let i = 0; i < blocks; i++) {
    for (let k = 0; k < N; k++) tone[k] = 0.5 * Math.sin((phase += (2 * Math.PI * 440) / SR));
    outA.fill(0);
    outB.fill(0);
    a.process(tone, outA);
    b.process(null, outB);
    if (globalThis.CAPTURE) globalThis.CAPTURE.push(...outB.filter((_, j) => j % 2 === 0));
    for (let k = 0; k < N; k++) {
      const v = outB[2 * k];
      energy += v * v;
      if (Math.abs(v) > 1e-4) {
        if ((v > 0) !== (prev > 0)) crossings++;
        counted++;
      }
      prev = v;
    }
    if (onBlock?.(i)) break;
    // real time: 128 samples @ 48 kHz = 2.67 ms per block
    // (spin, not setTimeout: Windows timers tick every ~15 ms, which would turn this into bursts)
    const due = t0 + ((i + 1) * N * 1000) / SR;
    while (performance.now() < due);
    if (i % 64 === 0) await new Promise((r) => setImmediate(r)); // yield without a ~15 ms timer
  }
  return { energy, freq: counted ? (crossings / 2) * (SR / counted) : 0 };
}

async function linkAndHear(host, port, label) {
  const a = new net.Room();
  const b = new net.Room();
  const group = `tabshare-test-${rand()}`;
  const cfg = (user) => ({ user, group, groupPassword: 'pw-' + group, host, port, sampleRate: SR, blockSize: N, format: Number(process.env.NET_FORMAT ?? 1) });
  a.start(cfg(`ts-a-${rand()}`));
  b.start(cfg(`ts-b-${rand()}`));
  a.setSending(true);
  try {
    // Up to 15 s to connect, link and unmute.
    let heard = false;
    const r = await run(a, b, Math.round((15 * SR) / N), () => {
      const p = b.status().peers[0];
      return (heard = !!p && p.linked && !p.muted && p.level > 0.05);
    });
    const sa = a.status();
    const sb = b.status();
    assert.equal(sa.state, 'connected', `${label}: a connected (${sa.error ?? ''})`);
    assert.equal(sb.state, 'connected', `${label}: b connected (${sb.error ?? ''})`);
    assert.ok(heard, `${label}: b hears a (${JSON.stringify(sb.peers)})`);
    // Pitch survives the trip: measure 1 s.
    globalThis.CAPTURE = process.env.NET_DUMP ? [] : null;
    const m = await run(a, b, Math.round(SR / N));
    if (globalThis.CAPTURE) (await import('node:fs')).writeFileSync(process.env.NET_DUMP, JSON.stringify(globalThis.CAPTURE));
    globalThis.CAPTURE = null;
    console.log(label, 'measure', JSON.stringify({ ...m, peer: b.status().peers[0] }));
    assert.ok(m.energy > 1, `${label}: steady audio (energy ${m.energy})`);
    assert.ok(Math.abs(m.freq - 440) < 20, `${label}: 440 Hz arrives as ${m.freq.toFixed(1)} Hz`);
    const peer = b.status().peers[0];
    console.log(`${label}: rtt ${peer.rttMs.toFixed(1)} ms, buffer ${peer.bufferMs.toFixed(1)} ms, latency ${peer.latencyMs.toFixed(1)} ms, drops ${peer.drops}`);

    // Gain 0 silences that person.
    b.setPeer(peer.user, { gain: 0, bufferMs: 0 });
    const muted = await run(a, b, 200);
    assert.equal(muted.energy, 0, `${label}: gain 0 is silent`);
    b.setPeer(peer.user, { gain: 1, bufferMs: 20 });

    // Switching to PCM 16 keeps audio flowing.
    a.setFormat(2);
    await run(a, b, 200);
    const pcm = await run(a, b, Math.round(SR / N));
    assert.ok(pcm.energy > 1, `${label}: PCM 16 audio (energy ${pcm.energy})`);
    assert.equal(b.status().peers[0].bufferMs, 20, 'manual buffer kept');

    // Not sending: silence on the other side.
    a.setSending(false);
    await run(a, b, 200);
    const stopped = await run(a, b, 200);
    assert.ok(stopped.energy < 1e-3, `${label}: nothing arrives while not sending (${stopped.energy})`);
  } finally {
    a.stop();
    b.stop();
  }
  assert.equal(a.status().state, 'off');
}

test('two rooms link through a local server and hear each other', { skip: !net }, async () => {
  const port = 20998;
  assert.ok(net.startTestServer(port), 'test server starts');
  try {
    await linkAndHear('127.0.0.1', port, 'local');
  } finally {
    net.stopTestServer();
  }
});

test('live: aoo.sonobus.net', { skip: !net || !process.env.NET_LIVE }, async () => {
  await linkAndHear('aoo.sonobus.net', 10998, 'live');
});

test('start validates its config', { skip: !net }, () => {
  const r = new net.Room();
  assert.throws(() => r.start({ group: 'x', sampleRate: 48000, blockSize: 128 }), /required/);
  assert.equal(r.status().state, 'off');
});
