// Stem jobs against a fake StemDeck: submit, follow progress, collect the stems, clean up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TabMeta } from '../shared/protocol.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabshare-stems-'));

interface FakeJob {
  status: string;
  progress: number;
  stage: string;
  error?: string;
  stem_presence?: Record<string, number>;
  body: string;
}
const jobs = new Map<string, FakeJob>();
const deleted: string[] = [];
let next = 1;
const read = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => ok(b));
  });
const fake = createServer(async (req, res) => {
  const url = req.url ?? '';
  const body = await read(req);
  const json = (code: number, v: unknown) => (res.writeHead(code, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(v)));
  if (req.method === 'POST' && url === '/api/jobs') {
    const id = `job${next++}`;
    jobs.set(id, { status: 'queued', progress: 0, stage: 'Queued', body });
    return json(200, { job_id: id });
  }
  const m = url.match(/^\/api\/jobs\/(\w+)(.*)$/);
  const job = m && jobs.get(m[1]);
  if (!m || !job) return json(404, { detail: 'job not found' });
  if (req.method === 'DELETE') return (deleted.push(m[1]), jobs.delete(m[1]), json(200, { status: 'deleted' }));
  const stem = m[2].match(/^\/stems\/(\w+)\.mp3$/);
  if (stem) return (res.writeHead(200, { 'Content-Type': 'audio/mpeg' }), res.end(`mp3:${m[1]}:${stem[1]}`));
  json(200, { job_id: m[1], ...job, body: undefined });
});
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok));
process.env.STEMDECK_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/`;

const store = await import('./store.js');
const s = await import('./stems.js');

const room = store.createRoom('Stems', 'pw');
const tab: TabMeta = { id: 'tab1', fileName: 'a.gp', ext: 'gp', size: 1, uploadedBy: 'x', uploadedAt: 0 };
room.tabs.push(tab);
let changes = 0;
const onChange = () => void changes++;

test.after(() => fake.close());

test('YouTube job: queued → running → ready, silent stems left out, job deleted', async () => {
  await s.startStems(room, tab, { youtube: 'dQw4w9WgXcQ' }, onChange);
  const id = tab.stems!.jobId!;
  assert.equal(tab.stems!.status, 'queued');
  assert.equal(tab.stems!.from, 'youtube');
  assert.deepEqual(JSON.parse(jobs.get(id)!.body), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });

  Object.assign(jobs.get(id)!, { status: 'separating', progress: 0.4, stage: 'Separating stems' });
  await s.pollStems(onChange);
  assert.equal(tab.stems!.status, 'running');
  assert.equal(tab.stems!.progress, 0.4);
  assert.equal(tab.stems!.stage, 'Separating stems');

  const before = changes;
  await s.pollStems(onChange);
  assert.equal(changes, before, 'no change, no broadcast');

  Object.assign(jobs.get(id)!, { status: 'done', progress: 1, stem_presence: { vocals: 80, drums: 60, bass: 50, guitar: 40, piano: 0, other: 12 } });
  await s.pollStems(onChange);
  assert.equal(tab.stems!.status, 'ready');
  assert.deepEqual(tab.stems!.names, ['vocals', 'drums', 'bass', 'guitar', 'other']);
  assert.equal(tab.stems!.jobId, undefined);
  assert.equal(tab.stems!.videoId, 'dQw4w9WgXcQ');
  assert.equal(fs.readFileSync(s.stemFile(room.id, tab, 'bass'), 'utf8'), `mp3:${id}:bass`);
  assert.ok(!fs.existsSync(s.stemFile(room.id, tab, 'piano')));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(deleted.includes(id), 'StemDeck job deleted');
});

test('upload job: multipart file; StemDeck error ends as error and drops the old stems', async () => {
  await s.startStems(room, tab, { file: Buffer.from('fake audio'), name: 'song.mp3' }, onChange);
  const id = tab.stems!.jobId!;
  assert.equal(tab.stems!.from, 'upload');
  assert.match(jobs.get(id)!.body, /filename="song\.mp3"[\s\S]*fake audio/);
  assert.ok(!fs.existsSync(s.stemsDir(room.id, tab)), 'old stems removed when redoing');

  Object.assign(jobs.get(id)!, { status: 'error', error: 'Could not decode audio' });
  await s.pollStems(onChange);
  assert.equal(tab.stems!.status, 'error');
  assert.equal(tab.stems!.error, 'Could not decode audio');
});

test('a job StemDeck no longer knows (restart, wiped) becomes an error; removeStems clears everything', async () => {
  await s.startStems(room, tab, { youtube: 'dQw4w9WgXcQ' }, onChange);
  jobs.delete(tab.stems!.jobId!);
  await s.pollStems(onChange);
  assert.equal(tab.stems!.status, 'error');
  assert.match(tab.stems!.error!, /lost the job/);

  await s.startStems(room, tab, { youtube: 'dQw4w9WgXcQ' }, onChange);
  const id = tab.stems!.jobId!;
  s.removeStems(room.id, tab);
  assert.equal(tab.stems, undefined);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(deleted.includes(id));
});
