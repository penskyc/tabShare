import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allTags, baseMime, cleanLabel, cleanTags, defaultIdeaLabel, filterIdeas, ideaExt, ideaId, safeFileName } from './ideas.js';
import type { Idea } from './protocol.js';

test('ideaId: url-safe ids of 8–32 characters only', () => {
  assert.equal(ideaId('abcDEF12_-'), 'abcDEF12_-');
  for (const bad of ['../x', 'short', 'a'.repeat(33), 'has space1', 42, null, undefined]) assert.equal(ideaId(bad), null, String(bad));
});

test('baseMime: strips codecs, only audio/webm, audio/mp4, audio/ogg', () => {
  assert.equal(baseMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(baseMime('Audio/MP4'), 'audio/mp4');
  assert.equal(baseMime('audio/ogg; codecs=opus'), 'audio/ogg');
  for (const bad of ['video/webm', 'audio/wav', '', 1, undefined]) assert.equal(baseMime(bad), null, String(bad));
  assert.equal(ideaExt('audio/webm'), 'webm');
  assert.equal(ideaExt('audio/mp4'), 'm4a');
  assert.equal(ideaExt('audio/ogg'), 'ogg');
});

test('cleanLabel: trimmed, 1–100 characters', () => {
  assert.equal(cleanLabel('  Slow groove '), 'Slow groove');
  assert.equal(cleanLabel('  '), null);
  assert.equal(cleanLabel('x'.repeat(100)), 'x'.repeat(100));
  assert.equal(cleanLabel('x'.repeat(101)), null);
  assert.equal(cleanLabel(5), null);
});

test('cleanTags: trims, drops empties, dedups case-insensitively, ≤ 10 tags of ≤ 30 chars', () => {
  assert.deepEqual(cleanTags([' Riff', 'riff', '', 'drop D']), ['Riff', 'drop D']);
  assert.deepEqual(cleanTags([]), []);
  assert.equal(cleanTags(['x'.repeat(31)]), null);
  assert.deepEqual(cleanTags(['x'.repeat(30)]), ['x'.repeat(30)]);
  assert.equal(cleanTags(Array.from({ length: 11 }, (_, i) => `t${i}`)), null);
  assert.equal(cleanTags('riff'), null);
  assert.equal(cleanTags([1]), null);
});

test('defaultIdeaLabel: "Idea · Nov 18, 9:42 pm"', () => {
  assert.equal(defaultIdeaLabel(new Date(2026, 10, 18, 21, 42)), 'Idea · Nov 18, 9:42 pm');
  assert.equal(defaultIdeaLabel(new Date(2026, 0, 3, 9, 5)), 'Idea · Jan 3, 9:05 am');
});

const idea = (id: string, createdAt: number, label: string, tags: string[]): Idea => ({
  id,
  label,
  tags,
  createdAt,
  by: 'Corey',
  durationMs: 1000,
  model: null,
  mime: 'audio/webm',
  size: 10,
});

test('filterIdeas: newest first, query matches label or tag, tag filter exact (case-insensitive)', () => {
  const list = [idea('a', 1, 'Slow groove', ['slow']), idea('b', 3, 'Idea · Nov 18', ['riff', 'drop D']), idea('c', 2, 'Chorus thing', ['riff'])];
  assert.deepEqual(filterIdeas(list, '', null).map((i) => i.id), ['b', 'c', 'a']);
  assert.deepEqual(filterIdeas(list, 'drop', null).map((i) => i.id), ['b']);
  assert.deepEqual(filterIdeas(list, 'GROOVE', null).map((i) => i.id), ['a']);
  assert.deepEqual(filterIdeas(list, '', 'RIFF').map((i) => i.id), ['b', 'c']);
  assert.deepEqual(filterIdeas(list, 'chorus', 'riff').map((i) => i.id), ['c']);
  assert.deepEqual(filterIdeas(list, 'zzz', null), []);
});

test('allTags: unique, most used first, then alphabetical', () => {
  const list = [idea('a', 1, 'x', ['slow', 'Riff']), idea('b', 2, 'y', ['riff', 'drop D']), idea('c', 3, 'z', ['riff'])];
  assert.deepEqual(allTags(list), ['Riff', 'drop D', 'slow']);
});

test('safeFileName: replaces characters file systems refuse', () => {
  assert.equal(safeFileName('a/b:c?'), 'a_b_c_');
  assert.equal(safeFileName('Idea · Nov 18, 9:42 pm'), 'Idea · Nov 18, 9_42 pm');
  assert.equal(safeFileName('   '), 'idea');
});
