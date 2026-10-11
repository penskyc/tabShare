// Note names, scales, arpeggios and tunings for the tuner and the fretboard.

const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Root choices as players name them. */
export const ROOTS = ['C', 'C♯/D♭', 'D', 'E♭', 'E', 'F', 'F♯/G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

const pc = (midi: number) => ((midi % 12) + 12) % 12;

/** Flat keys (F, B♭, E♭, A♭, D♭) are spelled with flats, everything else with sharps. */
export const noteName = (midi: number, root = 0) => ([5, 10, 3, 8, 1].includes(pc(root)) ? FLATS : SHARPS)[pc(midi)];
export const noteWithOctave = (midi: number) => `${SHARPS[pc(midi)]}${Math.floor(midi / 12) - 1}`;
export const midiToHz = (midi: number, a4 = 440) => a4 * Math.pow(2, (midi - 69) / 12);

export const INTERVALS = ['1', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7'];
export const intervalName = (midi: number, root: number) => INTERVALS[pc(midi - root)];

export const SCALES: Record<string, number[]> = {
  Off: [],
  'Major (Ionian)': [0, 2, 4, 5, 7, 9, 11],
  'Natural minor (Aeolian)': [0, 2, 3, 5, 7, 8, 10],
  'Major pentatonic': [0, 2, 4, 7, 9],
  'Minor pentatonic': [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
  'Harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'Melodic minor': [0, 2, 3, 5, 7, 9, 11],
  'Whole tone': [0, 2, 4, 6, 8, 10],
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const ARPEGGIOS: Record<string, number[]> = {
  Off: [],
  Major: [0, 4, 7],
  Minor: [0, 3, 7],
  'Dominant 7': [0, 4, 7, 10],
  'Major 7': [0, 4, 7, 11],
  'Minor 7': [0, 3, 7, 10],
  'Minor 7♭5': [0, 3, 6, 10],
  'Diminished 7': [0, 3, 6, 9],
  Sus2: [0, 2, 7],
  Sus4: [0, 5, 7],
  'Power (5)': [0, 7],
};

export const inSet = (midi: number, root: number, set: number[]) => set.includes(pc(midi - root));

export interface TuningPreset {
  name: string;
  /** MIDI notes, lowest string first. */
  notes: number[];
}

export const TUNINGS: { guitar: TuningPreset[]; bass: TuningPreset[] } = {
  guitar: [
    { name: 'Standard (E A D G B E)', notes: [40, 45, 50, 55, 59, 64] },
    { name: 'Drop D', notes: [38, 45, 50, 55, 59, 64] },
    { name: 'Half step down (E♭)', notes: [39, 44, 49, 54, 58, 63] },
    { name: 'Full step down (D)', notes: [38, 43, 48, 53, 57, 62] },
    { name: 'Drop C', notes: [36, 43, 48, 53, 57, 62] },
    { name: 'DADGAD', notes: [38, 45, 50, 55, 57, 62] },
    { name: 'Open G', notes: [38, 43, 50, 55, 59, 62] },
    { name: '7-string (B E A D G B E)', notes: [35, 40, 45, 50, 55, 59, 64] },
  ],
  bass: [
    { name: 'Standard (E A D G)', notes: [28, 33, 38, 43] },
    { name: 'Drop D', notes: [26, 33, 38, 43] },
    { name: 'Half step down (E♭)', notes: [27, 32, 37, 42] },
    { name: 'Full step down (D)', notes: [26, 31, 36, 41] },
    { name: '5-string (B E A D G)', notes: [23, 28, 33, 38, 43] },
    { name: '6-string (B E A D G C)', notes: [23, 28, 33, 38, 43, 48] },
    { name: 'Tenor (A D G C)', notes: [33, 38, 43, 48] },
    { name: 'BEAD', notes: [23, 28, 33, 38] },
  ],
};

/** The string whose open note is closest to a played note (for the tuner's target string). */
export const closestString = (midi: number, strings: number[]) =>
  strings.reduce((best, s, i) => (Math.abs(s - midi) < Math.abs(strings[best] - midi) ? i : best), 0);
