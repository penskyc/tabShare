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
