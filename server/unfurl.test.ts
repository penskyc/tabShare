import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL_RE, isPrivateAddress, parsePreview } from './unfurl.js';

test('blocks private and local addresses', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.5', '100.100.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', '0.0.0.0', 'nonsense']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '151.101.1.69', '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
});

test('parses open graph with either attribute order, entities and relative images', () => {
  const html = `<html><head><title>Fallback</title>
    <meta content="Songsterr &amp; Tabs" property="og:site_name">
    <meta property="og:title" content="Master of Puppets Tab">
    <meta name="description" content="Plain desc">
    <meta property='og:description' content='Accurate &quot;tab&quot;'>
    <meta property="og:image" content="/img/cover.png"></head></html>`;
  assert.deepEqual(parsePreview(html, 'https://www.songsterr.com/a/wsa/x'), {
    url: 'https://www.songsterr.com/a/wsa/x',
    title: 'Master of Puppets Tab',
    description: 'Accurate "tab"',
    image: 'https://www.songsterr.com/img/cover.png',
    siteName: 'Songsterr & Tabs',
  });
});

test('falls back to <title> and hostname, returns null without a title', () => {
  const p = parsePreview('<title> Just a page </title>', 'https://www.example.com/');
  assert.equal(p?.title, 'Just a page');
  assert.equal(p?.siteName, 'example.com');
  assert.equal(parsePreview('<p>nothing</p>', 'https://example.com'), null);
});

test('URL_RE trims trailing punctuation', () => {
  assert.equal('check https://youtu.be/abc123, nice'.match(URL_RE)?.[0], 'https://youtu.be/abc123');
  assert.equal('(see https://example.com/a?b=1)'.match(URL_RE)?.[0], 'https://example.com/a?b=1');
});
