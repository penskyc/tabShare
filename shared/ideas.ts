// Ideas (recorded takes): validation, labels and filtering, shared by the server and the Ideas panel.
import { IDEA_MIMES, type Idea, type IdeaMime } from './protocol.js';

const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const MAX_LABEL = 100;
const MAX_TAGS = 10;
const MAX_TAG = 30;

/** A client-made idea id (url-safe, 8–32 characters), or null. */
export function ideaId(s: unknown): string | null {
  return typeof s === 'string' && ID_RE.test(s) ? s : null;
}

/** The base mime type (no codecs) if it's one we store, else null. */
export function baseMime(m: unknown): IdeaMime | null {
  if (typeof m !== 'string') return null;
  const base = m.split(';')[0].trim().toLowerCase();
  return (IDEA_MIMES as readonly string[]).includes(base) ? (base as IdeaMime) : null;
}

export function ideaExt(mime: string): 'webm' | 'm4a' | 'ogg' {
  return mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm';
}

export function cleanLabel(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t && t.length <= MAX_LABEL ? t : null;
}

/** Trimmed tags, empties dropped, de-duplicated ignoring case; null if not ≤ 10 strings of ≤ 30 characters. */
export function cleanTags(t: unknown): string[] | null {
  if (!Array.isArray(t)) return null;
  const out: string[] = [];
  for (const raw of t) {
    if (typeof raw !== 'string') return null;
    const tag = raw.trim();
    if (tag.length > MAX_TAG) return null;
    if (tag && !out.some((o) => o.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out.length <= MAX_TAGS ? out : null;
}

/** "Idea · Nov 18, 9:42 pm" */
export function defaultIdeaLabel(d: Date): string {
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s*([AP])M$/i, (_, p: string) => ` ${p.toLowerCase()}m`);
  return `Idea · ${date}, ${time}`;
}

/** Newest first; `query` matches the label or a tag, `tag` must equal one of the tags (both ignore case). */
export function filterIdeas(ideas: Idea[], query: string, tag: string | null): Idea[] {
  const q = query.trim().toLowerCase();
  const t = tag?.toLowerCase() ?? null;
  return ideas
    .filter((i) => (!t || i.tags.some((x) => x.toLowerCase() === t)) && (!q || i.label.toLowerCase().includes(q) || i.tags.some((x) => x.toLowerCase().includes(q))))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Every tag in use (first spelling seen), most used first, then alphabetical. */
export function allTags(ideas: Idea[]): string[] {
  const counts = new Map<string, { tag: string; n: number }>();
  for (const i of ideas)
    for (const tag of i.tags) {
      const k = tag.toLowerCase();
      const c = counts.get(k);
      if (c) c.n++;
      else counts.set(k, { tag, n: 1 });
    }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.tag.toLowerCase().localeCompare(b.tag.toLowerCase())).map((c) => c.tag);
}

/** A download file name: characters Windows/macOS refuse become "_". */
export function safeFileName(label: string): string {
  const s = label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return s || 'idea';
}
