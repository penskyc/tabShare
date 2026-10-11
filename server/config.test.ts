// First-run setup, admin sign-in and API keys against a fresh data dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabshare-config-'));
delete process.env.ADMIN_PASSWORD;
const c = await import('./config.js');

test('a fresh server needs setup and only the logged code completes it', () => {
  assert.equal(c.needsSetup(), true);
  assert.match(c.setupCode, /^[a-z2-9]{8}$/);
  assert.match(c.completeSetup({ code: 'wrongcode', username: 'corey', password: 'longenough', baseUrl: '', tone3000ClientId: '' })!, /Wrong setup code/);
  assert.match(c.completeSetup({ code: c.setupCode, username: 'corey', password: 'short', baseUrl: '', tone3000ClientId: '' })!, /at least 8/);
  assert.match(c.completeSetup({ code: c.setupCode, username: 'corey', password: 'longenough', baseUrl: 'ftp://x', tone3000ClientId: '' })!, /http/);
  assert.equal(c.completeSetup({ code: c.setupCode, username: 'corey', password: 'longenough', baseUrl: 'https://tabs.example.com/', tone3000ClientId: 't3k_pub_x' }), null);
  assert.equal(c.needsSetup(), false);
  assert.equal(c.completeSetup({ code: c.setupCode, username: 'x', password: 'longenough', baseUrl: '', tone3000ClientId: '' }), 'Already set up');
  assert.deepEqual(c.publicSettings(), { baseUrl: 'https://tabs.example.com', tone3000ClientId: 't3k_pub_x', requireAdminForRooms: true });
});

test('admin sign-in and sessions; changing the password signs sessions out', () => {
  assert.ok(c.checkAdmin('Corey', 'longenough'));
  assert.ok(!c.checkAdmin('corey', 'wrong-password'));
  const s = c.issueAdminSession();
  assert.ok(c.verifyAdminSession(s));
  assert.ok(!c.verifyAdminSession(s.slice(0, -2) + 'xx'));
  assert.equal(c.changeAccount('wrong', '', 'newpassword1'), 'Current password is wrong');
  assert.equal(c.changeAccount('longenough', '', 'newpassword1'), null);
  assert.ok(!c.verifyAdminSession(s), 'old session revoked');
  assert.ok(c.checkAdmin('corey', 'newpassword1'));
});

test('API keys: shown once, verified by hash, revocable', () => {
  const { key, info } = c.createApiKey("Mike's desktop");
  assert.match(key, /^tsk_/);
  assert.ok(!JSON.stringify(c.listApiKeys()).includes(key), 'the key itself is never listed');
  assert.ok(c.verifyApiKey(key));
  assert.ok(!c.verifyApiKey(key + 'x'));
  assert.ok(c.listApiKeys()[0].lastUsedAt);
  assert.ok(c.revokeApiKey(info.id));
  assert.ok(!c.verifyApiKey(key));
});

test('settings validation; nothing secret on disk in the clear', () => {
  assert.match(c.updateSettings({ port: 70000 })!, /Port/);
  assert.equal(c.updateSettings({ port: 8080, baseUrl: 'http://192.168.1.5:8080' }), null);
  assert.equal(c.listenPort(), 8080);
  assert.equal(c.updateSettings({ requireAdminForRooms: false }), null);
  assert.equal(c.roomsNeedAdmin(), false);
  const disk = fs.readFileSync(path.join(process.env.DATA_DIR!, 'config.json'), 'utf8');
  assert.ok(!disk.includes('newpassword1'));
});
