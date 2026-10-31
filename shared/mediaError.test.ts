import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaErrorMessage, mediaOs } from './mediaError';

const denied = { name: 'NotAllowedError', message: 'Permission denied' };
const bySystem = { name: 'NotAllowedError', message: 'Permission denied by system' };

test('mediaOs: bridge platform first, then user agent', () => {
  assert.equal(mediaOs('win32', 'Macintosh'), 'windows');
  assert.equal(mediaOs('darwin', ''), 'mac');
  assert.equal(mediaOs(undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(mediaOs(undefined, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac');
  assert.equal(mediaOs(undefined, 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'ios');
  assert.equal(mediaOs(undefined, 'Mozilla/5.0 (X11; Linux x86_64)'), 'other');
});

test('desktop app: a refusal is always the OS, never the address bar', () => {
  const m = mediaErrorMessage(denied, ['camera'], { os: 'windows', app: true });
  assert.match(m, /^Windows is blocking the camera/);
  assert.match(m, /Let desktop apps access your camera/);
  assert.doesNotMatch(m, /address bar/);
});

test('browser: "denied by system" points at the OS settings', () => {
  const m = mediaErrorMessage(bySystem, ['camera', 'microphone'], { os: 'mac', app: false });
  assert.match(m, /^macOS is blocking the camera and microphone/);
  assert.match(m, /Privacy & Security → Camera and Microphone, turn on your browser/);
});

test('browser: plain denial mentions the address bar and the OS', () => {
  const m = mediaErrorMessage(denied, ['microphone'], { os: 'windows', app: false });
  assert.match(m, /address bar/);
  assert.match(m, /Privacy & security → Microphone/);
});

test('busy or missing device', () => {
  assert.match(mediaErrorMessage({ name: 'NotReadableError', message: 'Could not start video source' }, ['camera'], { os: 'windows', app: true }), /another app may be using it/);
  assert.equal(mediaErrorMessage({ name: 'NotFoundError', message: '' }, ['microphone'], { os: 'mac', app: false }), 'No microphone found.');
});
