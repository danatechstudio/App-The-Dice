// Event photos: which events want photos, keeping each event's set in step
// with its Drive folder, storing uploaded bytes in KV, and picking a photo
// for each occurrence.
//
// Flow (n8n "RTD Event Images"):
//   1. GET  /internal/images/plan       → events with a photo folder
//   2. n8n lists those folders in Drive and picks the newest photos
//   3. POST /internal/images/sync       → app drops photos no longer chosen,
//                                          says which ones it still needs
//   4. PUT  /internal/images/:event/:id → n8n sends each needed photo (resized)

const RUN_ID = /^[A-Za-z0-9:_.-]{1,100}$/;
const SOURCE_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const IMAGE_ID = /^[a-f0-9]{32}$/;

/** Photos kept per event, and the size n8n asks Google to resize them to. */
export const MAX_PER_EVENT = 8;
export const IMAGE_SIZE = 1400;
export const MAX_IMAGE_BYTES = 5_000_000;

const ELIGIBLE = `e.active = 1 AND e.visibility IN ('public', 'app_bookable')
  AND e.photo_folder_id IS NOT NULL AND e.photo_folder_id <> ''`;

const kvKey = (imageId: string) => `img:${imageId}`;
const j = (field: string) => `json_extract(value, '$.${field}')`;

export interface PlanEvent {
  event_id: string;
  name: string;
  folder_id: string;
}

export async function imagePlan(db: D1Database) {
  const { results } = await db
    .prepare(`SELECT e.event_id, e.display_name AS name, e.photo_folder_id AS folder_id FROM events e WHERE ${ELIGIBLE} ORDER BY e.event_id`)
    .all<PlanEvent>();
  return { events: results, max_per_event: MAX_PER_EVENT, size: IMAGE_SIZE };
}

export interface SyncPayload {
  run_id: string;
  events: { event_id: string; files: { id: string; name: string }[] }[];
}

export function parseImageSync(body: unknown): SyncPayload | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (typeof b.run_id !== 'string' || !RUN_ID.test(b.run_id)) return 'run_id is required (letters, digits, :_.- up to 100)';
  if (!Array.isArray(b.events) || b.events.length > 500) return 'events must be an array (up to 500)';
  const events: SyncPayload['events'] = [];
  for (const e of b.events) {
    if (!e || typeof e !== 'object') return 'Each event must be an object';
    const { event_id, files } = e as Record<string, unknown>;
    if (typeof event_id !== 'string' || !event_id) return 'Each event needs an event_id';
    if (!Array.isArray(files) || files.length > MAX_PER_EVENT) return `files must be an array of up to ${MAX_PER_EVENT}`;
    const clean: { id: string; name: string }[] = [];
    for (const f of files) {
      const { id, name } = (f ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string' || !SOURCE_ID.test(id)) return `Bad Drive file id for ${event_id}`;
      clean.push({ id, name: typeof name === 'string' ? name.slice(0, 200) : '' });
    }
    events.push({ event_id, files: clean });
  }
  return { run_id: b.run_id, events };
}

export interface ImageSyncResult {
  status: 'ok' | 'rejected';
  reason: string | null;
  missing: { event_id: string; source_id: string }[];
  removed: number;
  ignored: string[];
}

/** Bring each listed event's photo set in line with its Drive folder. */
export async function syncImages(db: D1Database, kv: KVNamespace, payload: SyncPayload, now: string): Promise<ImageSyncResult> {
  const [eligibleRes, existingRes] = await db.batch([
    db.prepare(`SELECT e.event_id FROM events e WHERE ${ELIGIBLE}`),
    db.prepare('SELECT event_id, source_id, image_id FROM event_images'),
  ]);
  const eligible = new Set(((eligibleRes?.results ?? []) as { event_id: string }[]).map(r => r.event_id));
  const existing = (existingRes?.results ?? []) as { event_id: string; source_id: string; image_id: string | null }[];

  const listed = payload.events.filter(e => eligible.has(e.event_id));
  const ignored = payload.events.filter(e => !eligible.has(e.event_id)).map(e => e.event_id);
  // An empty list against events that want photos usually means Drive wasn't read.
  if (eligible.size > 0 && listed.length === 0) {
    return { status: 'rejected', reason: 'No eligible events in the snapshot; nothing changed', missing: [], removed: 0, ignored };
  }

  const wanted = new Map<string, number>(); // `${event}|${file}` → sort
  const upserts: { event_id: string; source_id: string; source_name: string; sort: number }[] = [];
  for (const e of listed) {
    e.files.forEach((f, sort) => {
      wanted.set(`${e.event_id}|${f.id}`, sort);
      upserts.push({ event_id: e.event_id, source_id: f.id, source_name: f.name, sort });
    });
  }
  const listedIds = new Set(listed.map(e => e.event_id));
  // Drop photos the folder no longer offers, and all photos of events that
  // stopped being eligible (hidden, inactive or folder removed).
  const removals = existing.filter(r =>
    eligible.has(r.event_id) ? listedIds.has(r.event_id) && !wanted.has(`${r.event_id}|${r.source_id}`) : true,
  );

  const writes: D1PreparedStatement[] = [];
  if (removals.length) {
    writes.push(
      db
        .prepare(
          `DELETE FROM event_images WHERE source = 'drive' AND (event_id, source_id) IN
             (SELECT ${j('event_id')}, ${j('source_id')} FROM json_each(?1))`,
        )
        .bind(JSON.stringify(removals)),
      db
        .prepare(
          `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, source, created_at)
           SELECT 'event', ${j('event_id')}, 'n8n', ?2, 'image.removed', ${j('source_id')}, 'drive_images', ?3 FROM json_each(?1)`,
        )
        .bind(JSON.stringify(removals), payload.run_id, now),
    );
  }
  if (upserts.length) {
    writes.push(
      db
        .prepare(
          `INSERT INTO event_images (event_id, source, source_id, source_name, sort, created_at, updated_at)
           SELECT ${j('event_id')}, 'drive', ${j('source_id')}, ${j('source_name')}, ${j('sort')}, ?2, ?2 FROM json_each(?1) WHERE true
           ON CONFLICT (event_id, source, source_id) DO UPDATE SET
             sort = excluded.sort, source_name = excluded.source_name,
             updated_at = CASE WHEN event_images.sort = excluded.sort AND event_images.source_name IS excluded.source_name
                               THEN event_images.updated_at ELSE excluded.updated_at END`,
        )
        .bind(JSON.stringify(upserts), now),
    );
  }
  if (writes.length) await db.batch(writes);
  await deleteOrphans(db, kv, removals.map(r => r.image_id));
  await sweepStore(db, kv, Date.parse(now));

  const have = new Set(existing.filter(r => r.image_id).map(r => `${r.event_id}|${r.source_id}`));
  const missing = upserts.filter(u => !have.has(`${u.event_id}|${u.source_id}`)).map(u => ({ event_id: u.event_id, source_id: u.source_id }));
  return { status: 'ok', reason: null, missing, removed: removals.length, ignored };
}

/** Remove stored bytes no event uses any more. Several events can share a photo. */
async function deleteOrphans(db: D1Database, kv: KVNamespace, imageIds: (string | null)[]): Promise<void> {
  const candidates = [...new Set(imageIds.filter((id): id is string => !!id))];
  if (!candidates.length) return;
  const { results } = await db
    .prepare(
      `SELECT value AS image_id FROM json_each(?1)
       WHERE value NOT IN (SELECT image_id FROM event_images WHERE image_id IS NOT NULL)`,
    )
    .bind(JSON.stringify(candidates))
    .all<{ image_id: string }>();
  await Promise.all(results.map(r => kv.delete(kvKey(r.image_id))));
}

const SWEEP_GRACE_MS = 60 * 60 * 1000;

/**
 * Self-healing: delete stored bytes that no event references, e.g. after an
 * interrupted upload or a replaced rendition. Only objects older than an
 * hour, so an upload in flight is never swept.
 */
async function sweepStore(db: D1Database, kv: KVNamespace, now: number): Promise<void> {
  const { results } = await db
    .prepare('SELECT DISTINCT image_id FROM event_images WHERE image_id IS NOT NULL')
    .all<{ image_id: string }>();
  const used = new Set(results.map(r => r.image_id));
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await kv.list<{ type?: string; stored?: number }>({ prefix: 'img:', cursor });
    const stale = list.keys.filter(k => !used.has(k.name.slice(4)) && now - (k.metadata?.stored ?? 0) > SWEEP_GRACE_MS);
    await Promise.all(stale.map(k => kv.delete(k.name)));
    if (list.list_complete) break;
    cursor = list.cursor;
  }
}

/** The real type, from the file's first bytes (never trust the header). */
export function sniffImageType(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  return null;
}

async function imageIdFor(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export type UploadResult =
  | { ok: true; image_id: string; url: string }
  | { ok: false; status: 404 | 413 | 415; error: string };

/** Store one photo the last sync asked for. */
export async function storeImage(
  db: D1Database,
  kv: KVNamespace,
  args: { eventId: string; sourceId: string; bytes: Uint8Array; runId: string | null; now: string },
): Promise<UploadResult> {
  const { eventId, sourceId, bytes, now } = args;
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: `Image larger than ${MAX_IMAGE_BYTES} bytes` };
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, status: 415, error: 'Not a JPEG, PNG, WebP, GIF or AVIF image' };
  const row = await db
    .prepare("SELECT image_id FROM event_images WHERE event_id = ?1 AND source = 'drive' AND source_id = ?2")
    .bind(eventId, sourceId)
    .first<{ image_id: string | null }>();
  if (!row) return { ok: false, status: 404, error: 'This photo was not requested by the last image sync' };

  const imageId = await imageIdFor(bytes);
  const shared = await db.prepare('SELECT 1 FROM event_images WHERE image_id = ?1 LIMIT 1').bind(imageId).first();
  if (!shared) await kv.put(kvKey(imageId), bytes, { metadata: { type, stored: Date.parse(now) } });

  await db.batch([
    db
      .prepare(
        `UPDATE event_images SET image_id = ?3, content_type = ?4, bytes = ?5, updated_at = ?6
         WHERE event_id = ?1 AND source = 'drive' AND source_id = ?2`,
      )
      .bind(eventId, sourceId, imageId, type, bytes.byteLength, now),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('event', ?1, 'n8n', ?2, 'image.added', ?3, ?4, 'drive_images', ?5)`,
      )
      .bind(eventId, args.runId, sourceId, imageId, now),
  ]);
  if (row.image_id && row.image_id !== imageId) await deleteOrphans(db, kv, [row.image_id]);
  return { ok: true, image_id: imageId, url: `/images/${imageId}` };
}

/** Bytes for /images/:id, only while the photo belongs to a visible event. */
export async function readImage(db: D1Database, kv: KVNamespace, imageId: string) {
  if (!IMAGE_ID.test(imageId)) return null;
  const visible = await db
    .prepare(
      `SELECT ei.content_type FROM event_images ei JOIN events e ON e.event_id = ei.event_id
       WHERE ei.image_id = ?1 AND e.active = 1 AND e.visibility IN ('public', 'app_bookable') LIMIT 1`,
    )
    .bind(imageId)
    .first<{ content_type: string }>();
  if (!visible) return null;
  const body = await kv.get(kvKey(imageId), 'stream');
  return body ? { body, type: visible.content_type } : null;
}

/** Uploaded photo URLs per event, in display order. */
export async function imagesByEvent(db: D1Database, eventIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const ids = [...new Set(eventIds)];
  if (!ids.length) return map;
  const { results } = await db
    .prepare(
      `SELECT event_id, image_id FROM event_images
       WHERE image_id IS NOT NULL AND event_id IN (SELECT value FROM json_each(?1))
       ORDER BY event_id, sort`,
    )
    .bind(JSON.stringify(ids))
    .all<{ event_id: string; image_id: string }>();
  for (const r of results) map.set(r.event_id, [...(map.get(r.event_id) ?? []), `/images/${r.image_id}`]);
  return map;
}

/** FNV-1a: a stable pick, so one date always shows the same photo and dates differ. */
function stableIndex(seed: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  return (h >>> 0) % n;
}

/** Fill `image` from the event's photos where no override is set. */
export async function withImages<T extends { event_id: string; occurrence_id: string; image: string | null }>(
  db: D1Database,
  rows: T[],
): Promise<T[]> {
  const needs = rows.filter(r => !r.image);
  if (!needs.length) return rows;
  const photos = await imagesByEvent(db, needs.map(r => r.event_id));
  return rows.map(r => {
    const list = photos.get(r.event_id);
    return r.image || !list?.length ? r : { ...r, image: list[stableIndex(r.occurrence_id, list.length)]! };
  });
}
