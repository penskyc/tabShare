import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseUrl } from './protocol.js';

test('browseUrl: only plain http(s) pages can be shared', () => {
  assert.equal(browseUrl('https://reverb.com/item/123-boss-ds-1'), 'https://reverb.com/item/123-boss-ds-1');
  assert.equal(browseUrl('http://example.com'), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,hi', 'about:blank', 'https://user:pw@example.com/', 'not a url', '', 42, null, `https://x.com/${'a'.repeat(2100)}`]) {
    assert.equal(browseUrl(bad), null, String(bad).slice(0, 40));
  }
});
