import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSyncPoints, parseYouTubeId, playOrder, shiftSyncPoints } from './sync.js';

test('parses YouTube ids from common URL forms', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    id,
    `https://www.youtube.com/watch?v=${id}&t=42s`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=x`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
  ]) {
    assert.equal(parseYouTubeId(u), id, u);
  }
  for (const u of ['', 'not a url', 'https://vimeo.com/123', 'https://youtube.com/watch?v=short']) assert.equal(parseYouTubeId(u), null, u);
});

test('play order counts repeat occurrences', () => {
  assert.deepEqual(playOrder([0, 1, 0, 1, 2]), [
    { index: 0, occurrence: 0 },
    { index: 1, occurrence: 0 },
    { index: 0, occurrence: 1 },
    { index: 1, occurrence: 1 },
    { index: 2, occurrence: 0 },
  ]);
});

test('merge replaces re-tapped bars and keeps the rest, sorted', () => {
  const p = (barIndex: number, ms: number, barOccurence = 0) => ({ barIndex, barOccurence, barPosition: 0, millisecondOffset: ms });
  const merged = mergeSyncPoints([p(0, 1000), p(1, 3000), p(2, 5000)], [p(1, 3100), p(3, 7000)]);
  assert.deepEqual(merged, [p(0, 1000), p(1, 3100), p(2, 5000), p(3, 7000)]);
  assert.deepEqual(shiftSyncPoints([p(0, 30)], -50), [p(0, 0)]);
});
