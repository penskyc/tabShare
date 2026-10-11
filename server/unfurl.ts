import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { LinkPreview } from '../shared/protocol.js';
export { URL_RE } from '../shared/protocol.js';

// The server lives on a home LAN: never let chat links make it fetch private addresses.
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT / Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3], // multicast + reserved
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

export function isPrivateAddress(addr: string) {
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) addr = mapped[1];
  const family = isIP(addr);
  if (!family) return true;
  return blocked.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

async function assertPublic(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  if (url.username || url.password) throw new Error('credentials in url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  // shortcut: DNS is checked before fetch (rebinding window), fine for a friends-only room server; pin IPs via a custom agent if this ever faces strangers.
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('private address');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts Open Graph (falling back to twitter:/basic) metadata from an HTML document. */
export function parsePreview(html: string, pageUrl: string): LinkPreview | null {
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3];
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content != null && !(key in meta)) meta[key] = decode(attrs.content);
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = meta['og:title'] ?? meta['twitter:title'] ?? (titleTag ? decode(titleTag) : undefined);
  if (!title) return null;
  let image: string | undefined = meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'];
  try {
    image = image ? new URL(image, pageUrl).href : undefined;
    if (image && !/^https?:/.test(image)) image = undefined;
  } catch {
    image = undefined;
  }
  const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
  return {
    url: pageUrl,
    title: clip(title, 200)!,
    description: clip(meta['og:description'] ?? meta['twitter:description'] ?? meta['description'], 300),
    image,
    siteName: clip(meta['og:site_name'], 80) ?? new URL(pageUrl).hostname.replace(/^www\./, ''),
  };
}

const MAX_BYTES = 1024 * 1024;
const cache = new Map<string, LinkPreview | null>();

export async function unfurl(rawUrl: string): Promise<LinkPreview | null> {
  if (cache.has(rawUrl)) return cache.get(rawUrl)!;
  let result: LinkPreview | null = null;
  try {
    let url = new URL(rawUrl);
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublic(url);
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tabShareBot/1.0; link preview)', Accept: 'text/html' },
      });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      url = new URL(loc, url);
      res = null;
    }
    if (res?.ok && /text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? '') && res.body) {
      // Read at most MAX_BYTES; <head> metadata is near the top.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
      reader.cancel().catch(() => {});
      result = parsePreview(new TextDecoder().decode(Buffer.concat(chunks)), url.href);
    }
  } catch {
    result = null;
  }
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(rawUrl, result);
  return result;
}
