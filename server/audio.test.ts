// Room audio credentials: the SonoBus group each room's desktop apps join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabshare-audio-'));
const store = await import('./store.js');

test('audio credentials are stable per room and rotate with the room password', () => {
  const room = store.createRoom('Audio test', 'first-password');
  const a = store.audioCredentials(room);
  assert.match(a.group, /^tabshare-[0-9a-f]{16}$/);
  assert.ok(a.password.length >= 32);
  assert.deepEqual(store.audioCredentials(room), a, 'same room, same credentials');

  const other = store.createRoom('Other', 'first-password');
  assert.notEqual(store.audioCredentials(other).group, a.group, 'each room has its own group');

  store.setPassword(room, 'second-password');
  const b = store.audioCredentials(room);
  assert.equal(b.group, a.group, 'group name kept');
  assert.notEqual(b.password, a.password, 'password rotates, so removed people lose access');
});
