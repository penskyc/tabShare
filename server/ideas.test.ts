// Ideas storage: add (idempotent by id), rename/tag, delete, validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabshare-ideas-'));
const store = await import('./store.js');
const ideas = await import('./ideas.js');

const body = Buffer.from('fake webm bytes');
const q = (over: Record<string, unknown> = {}) => ({
  id: 'take0001abcd',
  tags: JSON.stringify(['riff']),
  by: 'Corey',
  model: 'Fender Twin',
  durationMs: '3000',
  createdAt: String(Date.now() - 1000),
  ...over,
});

test('addIdea stores the file and the metadata, with a default label', () => {
  const room = store.createRoom('Ideas', 'pw12');
  const r = ideas.addIdea(room, q(), body, 'audio/webm;codecs=opus');
  assert.ok(typeof r !== 'string');
  assert.equal(r.created, true);
  assert.equal(r.idea.mime, 'audio/webm');
  assert.equal(r.idea.size, body.length);
  assert.equal(r.idea.durationMs, 3000);
  assert.equal(r.idea.model, 'Fender Twin');
  assert.deepEqual(r.idea.tags, ['riff']);
  assert.match(r.idea.label, /^Idea · /);
  assert.deepEqual(fs.readFileSync(ideas.ideaFile(room.id, r.idea)), body);
  assert.deepEqual(room.ideas, [r.idea]);
});

test('addIdea with an id that exists returns it unchanged (retried upload)', () => {
  const room = store.createRoom('Ideas', 'pw12');
  const first = ideas.addIdea(room, q({ label: 'First' }), body, 'audio/webm');
  const again = ideas.addIdea(room, q({ label: 'Second' }), Buffer.from('other'), 'audio/webm');
  assert.ok(typeof first !== 'string' && typeof again !== 'string');
  assert.equal(again.created, false);
  assert.equal(again.idea.label, 'First');
  assert.equal(room.ideas?.length, 1);
  assert.deepEqual(fs.readFileSync(ideas.ideaFile(room.id, first.idea)), body);
});

test('addIdea keeps an old createdAt (pending take uploaded days later), rejects future ones', () => {
  const room = store.createRoom('Ideas', 'pw12');
  const old = Date.now() - 5 * 24 * 3600 * 1000;
  const r = ideas.addIdea(room, q({ createdAt: String(old) }), body, 'audio/mp4');
  assert.ok(typeof r !== 'string');
  assert.equal(r.idea.createdAt, old);
  assert.match(ideas.ideaFile(room.id, r.idea), /\.m4a$/);
  const f = ideas.addIdea(room, q({ id: 'take0002abcd', createdAt: String(Date.now() + 3600_000) }), body, 'audio/mp4');
  assert.ok(typeof f !== 'string');
  assert.ok(f.idea.createdAt <= Date.now());
});

test('addIdea rejects bad input and writes nothing', () => {
  const room = store.createRoom('Ideas', 'pw12');
  const cases: [Record<string, unknown>, Buffer, string][] = [
    [q(), body, 'video/webm'],
    [q({ id: '../../etc' }), body, 'audio/webm'],
    [q(), Buffer.alloc(0), 'audio/webm'],
    [q({ durationMs: '0' }), body, 'audio/webm'],
    [q({ tags: JSON.stringify(Array.from({ length: 11 }, (_, i) => `t${i}`)) }), body, 'audio/webm'],
    [q({ tags: 'not json' }), body, 'audio/webm'],
    [q({ label: 'x'.repeat(101) }), body, 'audio/webm'],
  ];
  for (const [query, b, mime] of cases) assert.equal(typeof ideas.addIdea(room, query, b, mime), 'string', JSON.stringify(query) + mime);
  assert.equal(room.ideas?.length ?? 0, 0);
  assert.deepEqual(fs.existsSync(path.join(store.FILES_DIR, room.id, 'ideas')) ? fs.readdirSync(path.join(store.FILES_DIR, room.id, 'ideas')) : [], []);
});

test('patchIdea renames and retags; invalid → message, unknown → null', () => {
  const room = store.createRoom('Ideas', 'pw12');
  const r = ideas.addIdea(room, q(), body, 'audio/webm');
  assert.ok(typeof r !== 'string');
  const p = ideas.patchIdea(room, r.idea.id, { label: ' Slow groove ', tags: ['slow', 'Slow', 'drop D'] });
  assert.ok(p && typeof p !== 'string');
  assert.equal(p.label, 'Slow groove');
  assert.deepEqual(p.tags, ['slow', 'drop D']);
  assert.equal(typeof ideas.patchIdea(room, r.idea.id, { tags: ['x'.repeat(31)] }), 'string');
  assert.equal(typeof ideas.patchIdea(room, r.idea.id, { label: '' }), 'string');
  assert.equal(room.ideas?.[0].label, 'Slow groove');
  assert.equal(ideas.patchIdea(room, 'nope00000000', { label: 'x' }), null);
});

test('removeIdea deletes the file and the entry', () => {
  const room = store.createRoom('Ideas', 'pw12');
  const r = ideas.addIdea(room, q(), body, 'audio/webm');
  assert.ok(typeof r !== 'string');
  const file = ideas.ideaFile(room.id, r.idea);
  assert.equal(ideas.removeIdea(room, r.idea.id), true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(room.ideas, []);
  assert.equal(ideas.removeIdea(room, r.idea.id), false);
});

test('addIdea clamps an overlong duration instead of refusing a real take', () => {
  const room = store.createRoom('Ideas', 'pw12');
  const r = ideas.addIdea(room, q({ durationMs: String(16 * 60 * 1000) }), body, 'audio/webm');
  assert.ok(typeof r !== 'string', String(r));
  assert.equal(r.idea.durationMs, 15 * 60 * 1000 + 30_000);
});
