import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { buildDrums, defaultSong, drumSong, drumsToAlphaTex, KIT, SECTION_TYPES, STYLES, type DrumSong } from './drums.js';

function parse(tex: string) {
  const i = new alphaTab.importer.AlphaTexImporter();
  i.initFromString(tex, new alphaTab.Settings());
  return i.readScore();
}
const kitNotes = new Set(Object.values(KIT));
const steps = (ts: '4/4' | '12/8') => (ts === '4/4' ? 16 : 12);

test('every style × section type × seed: full bars, kit-only notes, deterministic', () => {
  for (const style of Object.keys(STYLES)) {
    for (const type of SECTION_TYPES) {
      for (let seed = 1; seed <= 20; seed++) {
        const song: DrumSong = { style, tempo: 100, sections: [{ type, bars: 4, seed }, { type: 'chorus', bars: 2, seed: seed + 99 }] };
        const a = buildDrums(song);
        const where = `${style}/${type}/${seed}`;
        assert.equal(a.bars.length, 6, where);
        for (const bar of a.bars) {
          assert.equal(bar.length, steps(a.ts), where);
          for (const hits of bar) for (const h of hits) assert.ok(kitNotes.has(h.n), `${where}: note ${h.n}`);
        }
        assert.deepEqual(buildDrums(song), a, `deterministic ${where}`);
        assert.ok(a.bars.some((b) => b.some((s) => s.length)), `${where} not silent`);
      }
    }
  }
});

test('seeds give different grooves, sections start with a crash, the song ends on beat 1', () => {
  for (const style of Object.keys(STYLES)) {
    const variants = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) variants.add(JSON.stringify(buildDrums({ style, tempo: 100, sections: [{ type: 'verse', bars: 4, seed }] }).bars));
    assert.ok(variants.size >= 4, `${style}: only ${variants.size} different verses from 12 seeds`);
    const song = defaultSong(style, 7);
    const b = buildDrums(song);
    b.sectionStartBars.forEach((bar, i) => {
      if (i > 0) assert.ok(b.bars[bar][0].some((h) => h.n === KIT.crash), `${style}: no crash at section ${i}`);
    });
    const last = b.bars[b.bars.length - 1];
    assert.ok(last[0].some((h) => h.n === KIT.crash), `${style}: ending has no crash`);
    assert.ok(last.slice(1).every((s) => s.length === 0), `${style}: ending keeps playing after beat 1`);
  }
});

test('alphaTex parses with the same notes, sections and time signature', () => {
  for (const style of Object.keys(STYLES)) {
    for (const seed of [1, 2, 3]) {
      const song = defaultSong(style, seed);
      const b = buildDrums(song);
      const score = parse(drumsToAlphaTex(song, 'Test'));
      const st = score.tracks[0].staves[0];
      assert.ok(st.isPercussion, style);
      assert.equal(st.bars.length, b.bars.length, `${style} bar count`);
      const parsed = st.bars.flatMap((bar) => bar.voices[0].beats.flatMap((x) => x.notes)).length;
      const want = b.bars.flat(2).length;
      assert.equal(parsed, want, `${style}/${seed} note count`);
      const mb = score.masterBars[0];
      assert.equal(`${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`, b.ts, `${style} time signature`);
      assert.equal(score.masterBars.filter((m) => m.section).length, song.sections.length, `${style} section markers`);
      assert.equal(score.tempo, song.tempo);
    }
  }
});

test('drumSong accepts valid songs and rejects anything else', () => {
  const ok = defaultSong('rock', 1);
  assert.deepEqual(drumSong(JSON.parse(JSON.stringify(ok))), ok);
  const bad: unknown[] = [
    null,
    'rock',
    { ...ok, style: 'polka' },
    { ...ok, tempo: 10 },
    { ...ok, tempo: '100' },
    { ...ok, sections: [] },
    { ...ok, sections: Array(33).fill(ok.sections[0]) },
    { ...ok, sections: [{ type: 'drop', bars: 4, seed: 1 }] },
    { ...ok, sections: [{ type: 'verse', bars: 17, seed: 1 }] },
    { ...ok, sections: [{ type: 'verse', bars: 2.5, seed: 1 }] },
    { ...ok, sections: [{ type: 'verse', bars: 4, seed: -1 }] },
  ];
  for (const b of bad) assert.equal(drumSong(b), null, JSON.stringify(b)?.slice(0, 60));
  // Extra fields are dropped, not passed through.
  assert.deepEqual(Object.keys(drumSong({ ...ok, evil: 1 })!).sort(), ['sections', 'style', 'tempo']);
});
