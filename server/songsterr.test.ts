// Hits the real Songsterr API, so it only runs with SONGSTERR_LIVE=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { downloadSong, searchSongs } from './songsterr/index.js';

test('search, convert to GP7 and re-import with alphaTab', { skip: !process.env.SONGSTERR_LIVE && 'set SONGSTERR_LIVE=1' }, async () => {
  const hits = await searchSongs('Deep Purple Smoke on the water');
  assert.ok(hits.length > 0);
  const song = await downloadSong(hits[0].songId);
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(song.data));
  assert.equal(score.artist, song.artist);
  assert.ok(score.tracks.length > 0 && score.masterBars.length > 10);
});

test('unnamed Songsterr parts are named after their instrument, like on Songsterr', { skip: !process.env.SONGSTERR_LIVE && 'set SONGSTERR_LIVE=1' }, async () => {
  // blink-182 "Whats My Age Again AI": all three parts have an empty name on Songsterr.
  const { data } = await downloadSong(2264964);
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(data), new alphaTab.Settings());
  assert.deepEqual(
    score.tracks.map((t) => t.name),
    ['Distortion Guitar', 'Electric Bass (pick)', 'Drums'],
  );
});
