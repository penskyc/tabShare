// One low-latency AudioContext shared by the instrument rig and the call mixer, so the guitar
// signal never gets resampled between contexts on its way into the call.
let ctx: AudioContext | null = null;

export function getAudioContext() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  return ctx;
}

/** Output device selection for the whole context (Chrome/Edge 110+). */
export const contextSinkSupported = () => typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
