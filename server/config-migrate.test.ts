// An existing install configured with ADMIN_PASSWORD / TONE3000_CLIENT_ID keeps working after the upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabshare-migrate-'));
process.env.ADMIN_PASSWORD = 'old-env-password';
process.env.TONE3000_CLIENT_ID = 't3k_pub_env';
const c = await import('./config.js');

test('env settings become the admin account and settings', () => {
  assert.equal(c.needsSetup(), false);
  assert.equal(c.setupCode, '');
  assert.ok(c.checkAdmin('admin', 'old-env-password'));
  assert.equal(c.publicSettings().tone3000ClientId, 't3k_pub_env');
});
