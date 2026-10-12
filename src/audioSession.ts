// iOS WebKit (Safari + the iOS app): Web Audio follows the silent switch unless navigator.audioSession.type is
// 'playback', and capturing audio needs 'play-and-record' (else getUserMedia fails: "category is not compatible with
// audio capture"). Every audio capture switches first, whoever calls it; the room switches back once nothing records.
const session = (navigator as { audioSession?: { type: string } }).audioSession;

if (session && navigator.mediaDevices?.getUserMedia) {
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => {
    if (c?.audio) session.type = 'play-and-record';
    return getUserMedia(c);
  };
}

export function setAudioSession(capturing: boolean) {
  if (session) session.type = capturing ? 'play-and-record' : 'playback';
}
