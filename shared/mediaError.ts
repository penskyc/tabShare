// Turns a getUserMedia failure into advice the person can act on. Pure (platform passed in), so it's unit-tested.

export type MediaKind = 'camera' | 'microphone';
export type MediaOs = 'windows' | 'mac' | 'ios' | 'other';

export interface MediaContext {
  os: MediaOs;
  /** Desktop or iOS app: there's no address bar, and the app grants the site permission itself. */
  app: boolean;
}

/** OS from the desktop bridge's platform when there is one, else the user agent. */
export function mediaOs(nativePlatform: string | undefined, userAgent: string): MediaOs {
  if (nativePlatform === 'win32') return 'windows';
  if (nativePlatform === 'darwin') return 'mac';
  if (nativePlatform === 'ios') return 'ios';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (/Windows/.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'mac';
  return 'other';
}

const label = (kinds: MediaKind[]) => (new Set(kinds).size > 1 ? 'camera and microphone' : kinds[0]);
const settings = (kinds: MediaKind[]) => [...new Set(kinds)].sort().map((k) => (k === 'camera' ? 'Camera' : 'Microphone')).join(' and ');

/** Where to turn access on at the OS level. */
function osFix(kinds: MediaKind[], ctx: MediaContext, appName: string): string {
  switch (ctx.os) {
    case 'windows':
      return `Open Windows Settings → Privacy & security → ${settings(kinds)} and turn on access, including "Let desktop apps access your ${label(kinds)}". Antivirus "webcam protection" can block it too.`;
    case 'mac':
      return `Open System Settings → Privacy & Security → ${settings(kinds)}, turn on ${appName}, then quit and reopen it.`;
    case 'ios':
      return `Open Settings → ${appName} and turn on ${settings(kinds)}.`;
    default:
      return `Check your system's privacy settings for the ${label(kinds)}.`;
  }
}

/** Is this the OS refusing (not the site permission)? Chrome says "Permission denied by system". */
const bySystem = (e: { name: string; message: string }) => /system/i.test(e.message);

export function mediaErrorMessage(e: { name: string; message: string }, kinds: MediaKind[], ctx: MediaContext): string {
  const what = label(kinds);
  const osName = ctx.os === 'windows' ? 'Windows' : ctx.os === 'mac' ? 'macOS' : ctx.os === 'ios' ? 'iOS' : 'Your system';
  const appName = ctx.app ? 'tabShare' : 'your browser';
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    // The apps grant the site permission themselves, so a refusal there is always the OS.
    if (ctx.app || bySystem(e)) return `${osName} is blocking the ${what}. ${osFix(kinds, ctx, appName)}`;
    return `Your browser blocked the ${what}. Click the camera/lock icon in the address bar, allow it and try again. Already allowed? Then ${osName === 'Your system' ? 'your system' : osName} is blocking it: ${osFix(kinds, ctx, appName)}`;
  }
  if (e.name === 'NotReadableError' || e.name === 'AbortError') {
    return `The ${what} couldn't start: another app may be using it (close other call apps), or it's switched off (a camera key or privacy switch).`;
  }
  if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return `No ${what} found.`;
  return `${what[0].toUpperCase()}${what.slice(1)} unavailable: ${e.message || e.name}`;
}
