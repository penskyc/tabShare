// Ideas: recorded takes saved to a room. Metadata in StoredRoom.ideas, audio in files/<room>/ideas/<id>.<ext>.
import fs from 'node:fs';
import path from 'node:path';
import { MAX_IDEA_MS, type Idea } from '../shared/protocol.js';
import { baseMime, cleanLabel, cleanTags, defaultIdeaLabel, ideaExt, ideaId } from '../shared/ideas.js';
import { FILES_DIR, saveSoon, type StoredRoom } from './store.js';

/** Slack on the 15-minute cap: the client's stop lands a little after the cap. */
const DURATION_SLACK_MS = 30_000;

export function ideaFile(roomId: string, idea: Pick<Idea, 'id' | 'mime'>): string {
  return path.join(FILES_DIR, roomId, 'ideas', `${idea.id}.${ideaExt(idea.mime)}`);
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Store an uploaded take. `q` = query fields id, label, tags (JSON array), by, model, durationMs, createdAt.
 * Returns an error message for bad input. An id that already exists returns that idea (a retried upload).
 */
export function addIdea(room: StoredRoom, q: Record<string, unknown>, body: Buffer, mime: unknown): { idea: Idea; created: boolean } | string {
  const id = ideaId(q.id);
  if (!id) return 'Bad idea id';
  const existing = room.ideas?.find((i) => i.id === id);
  if (existing) return { idea: existing, created: false };
  const type = baseMime(mime);
  if (!type) return 'Unsupported audio type';
  if (!Buffer.isBuffer(body) || body.length === 0) return 'Empty recording';
  const durationMs = Math.round(Number(q.durationMs));
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > MAX_IDEA_MS + DURATION_SLACK_MS) return 'Bad duration';
  let tags: string[] | null = [];
  if (q.tags !== undefined && q.tags !== '') {
    try {
      tags = cleanTags(JSON.parse(String(q.tags)));
    } catch {
      tags = null;
    }
  }
  if (!tags) return 'Up to 10 tags of up to 30 characters';
  const now = Date.now();
  const at = Number(q.createdAt);
  const createdAt = Number.isFinite(at) && at > 0 && at <= now + 60_000 ? at : now;
  let label = defaultIdeaLabel(new Date(createdAt));
  if (q.label !== undefined && q.label !== '') {
    const l = cleanLabel(q.label);
    if (!l) return 'Labels are 1–100 characters';
    label = l;
  }
  const idea: Idea = { id, label, tags, createdAt, by: text(q.by, 40), durationMs, model: text(q.model, 100) || null, mime: type, size: body.length };
  const file = ideaFile(room.id, idea);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  (room.ideas ??= []).push(idea);
  saveSoon();
  return { idea, created: true };
}

/** Rename and/or retag. Error message for bad input, null if there's no such idea. */
export function patchIdea(room: StoredRoom, id: string, patch: { label?: unknown; tags?: unknown }): Idea | string | null {
  const idea = room.ideas?.find((i) => i.id === id);
  if (!idea) return null;
  let label = idea.label;
  let tags = idea.tags;
  if (patch.label !== undefined) {
    const l = cleanLabel(patch.label);
    if (!l) return 'Labels are 1–100 characters';
    label = l;
  }
  if (patch.tags !== undefined) {
    const t = cleanTags(patch.tags);
    if (!t) return 'Up to 10 tags of up to 30 characters';
    tags = t;
  }
  idea.label = label;
  idea.tags = tags;
  saveSoon();
  return idea;
}

export function removeIdea(room: StoredRoom, id: string): boolean {
  const idx = room.ideas?.findIndex((i) => i.id === id) ?? -1;
  if (idx < 0 || !room.ideas) return false;
  const [idea] = room.ideas.splice(idx, 1);
  fs.rmSync(ideaFile(room.id, idea), { force: true });
  saveSoon();
  return true;
}
