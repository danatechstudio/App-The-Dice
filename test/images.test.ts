import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, indexRow, request, sync } from './helpers';

const AUTH = { Authorization: 'Bearer test-sync-token' };
const QUIZ = 'RTD-EVT-00001';
const CHESS = 'RTD-EVT-00004';

// Tiny stand-ins with real magic numbers; the app sniffs types, not headers.
const jpeg = (seed: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, 1, 2, 3, 4, 5, 6, 7]);
const webp = (seed: number) => new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP'), seed]);

const file = (n: number) => ({ id: `drivefile${String(n).padStart(4, '0')}`, name: `IMG_${n}.jpg` });
const imgSync = (events: { event_id: string; files: { id: string; name: string }[] }[], run_id = 'n8n-1') =>
  request('/internal/images/sync', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id, events }) });
const upload = (eventId: string, sourceId: string, bytes: Uint8Array) =>
  request(`/internal/images/${eventId}/${sourceId}`, { method: 'PUT', headers: { ...AUTH, 'X-Run-Id': 'n8n-1' }, body: bytes });

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
  await sync({
    run_id: 'seed',
    sources: {
      event_index: [
        indexRow(1, { 'Event Name': 'Quiz', 'Photo Folder ID': 'folderQuiz123' }),
        indexRow(2, { 'Event Name': 'Food1', 'App Visibility': 'Hidden', 'Photo Folder ID': 'folderFood123' }),
        indexRow(3, { 'Event Name': 'Spooky Market', 'Event Date': '17/10/2026' }),
        indexRow(4, { 'Event Name': 'Kids Chess Club', 'Event Date': '08/10/2026', Frequency: 'Weekly', 'Photo Folder ID': 'folderQuiz123' }),
      ],
    },
  });
});
afterEach(() => vi.useRealTimers());

describe('image sync (n8n)', () => {
  it('needs the sync token', async () => {
    expect((await request('/internal/images/plan')).status).toBe(401);
    expect((await request('/internal/images/x/y', { method: 'PUT', body: jpeg(1) })).status).toBe(401);
  });

  it('plans only visible, active events that have a photo folder', async () => {
    const plan = await (await request('/internal/images/plan', { headers: AUTH })).json<{ events: { event_id: string; folder_id: string }[]; max_per_event: number }>();
    expect(plan.events).toEqual([
      { event_id: QUIZ, name: 'Quiz', folder_id: 'folderQuiz123' },
      { event_id: CHESS, name: 'Kids Chess Club', folder_id: 'folderQuiz123' },
    ]);
    expect(plan.max_per_event).toBe(8);
  });

  it('asks only for photos it does not have yet, then serves them', async () => {
    const first = await (await imgSync([{ event_id: QUIZ, files: [file(1), file(2)] }])).json<{ missing: unknown[] }>();
    expect(first.missing).toEqual([
      { event_id: QUIZ, source_id: file(1).id },
      { event_id: QUIZ, source_id: file(2).id },
    ]);
    const res = await upload(QUIZ, file(1).id, jpeg(1));
    expect(res.status).toBe(200);
    const { url } = await res.json<{ url: string }>();
    expect(url).toMatch(/^\/images\/[a-f0-9]{32}$/);

    const again = await (await imgSync([{ event_id: QUIZ, files: [file(1), file(2)] }], 'n8n-2')).json<{ missing: unknown[] }>();
    expect(again.missing).toEqual([{ event_id: QUIZ, source_id: file(2).id }]);

    const img = await request(url);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/jpeg');
    expect(img.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(jpeg(1));
  });

  it('refuses photos it did not ask for, non-images and oversized files', async () => {
    await imgSync([{ event_id: QUIZ, files: [file(1)] }]);
    expect((await upload(QUIZ, file(9).id, jpeg(1))).status).toBe(404);
    expect((await upload(QUIZ, file(1).id, new TextEncoder().encode('<html>not an image</html>'))).status).toBe(415);
    const big = new Uint8Array(5_000_001);
    big.set(jpeg(1));
    expect((await upload(QUIZ, file(1).id, big)).status).toBe(413);
  });

  it('drops photos removed from the folder, keeping bytes another event still uses', async () => {
    await imgSync([{ event_id: QUIZ, files: [file(1), file(2)] }, { event_id: CHESS, files: [file(1)] }]);
    const shared = (await (await upload(QUIZ, file(1).id, jpeg(7))).json<{ url: string }>()).url;
    await upload(CHESS, file(1).id, jpeg(7)); // same Drive file, shared folder
    const only = (await (await upload(QUIZ, file(2).id, webp(8))).json<{ url: string }>()).url;

    const res = await (await imgSync([{ event_id: QUIZ, files: [] }, { event_id: CHESS, files: [file(1)] }], 'n8n-3')).json<{ removed: number }>();
    expect(res.removed).toBe(2);
    expect((await request(shared)).status).toBe(200); // still Chess's photo
    expect((await request(only)).status).toBe(404);
    expect(await env.IMAGES.get(`img:${only.split('/').pop()}`)).toBeNull();
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'image.removed'").first<{ n: number }>();
    expect(audit?.n).toBe(2);
  });

  it('refuses a snapshot with no eligible events, so a failed Drive read changes nothing', async () => {
    const res = await imgSync([]);
    expect(res.status).toBe(409);
    const hidden = await imgSync([{ event_id: 'RTD-EVT-00002', files: [file(1)] }]);
    expect(hidden.status).toBe(409);
  });

  it('validates the payload', async () => {
    const bad = (body: unknown) =>
      request('/internal/images/sync', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await bad({ events: [] })).status).toBe(400);
    expect((await bad({ run_id: 'r', events: [{ event_id: QUIZ, files: [{ id: '../../etc' }] }] })).status).toBe(400);
    expect((await bad({ run_id: 'r', events: [{ event_id: QUIZ, files: Array.from({ length: 9 }, (_, i) => file(i)) }] })).status).toBe(400);
  });
});

describe('photos in the public app', () => {
  beforeEach(async () => {
    await imgSync([{ event_id: QUIZ, files: [file(1)] }, { event_id: CHESS, files: [file(2), file(3)] }]);
    await upload(QUIZ, file(1).id, jpeg(1));
    await upload(CHESS, file(2).id, jpeg(2));
    await upload(CHESS, file(3).id, jpeg(3));
  });

  it('gives each occurrence a photo, varying between dates of the same event', async () => {
    const { occurrences } = await (await request('/api/events')).json<{ occurrences: { name: string; date: string; image: string | null }[] }>();
    const quiz = occurrences.find(o => o.name === 'Quiz');
    expect(quiz?.image).toMatch(/^\/images\/[a-f0-9]{32}$/);
    expect(occurrences.find(o => o.name === 'Spooky Market')?.image).toBeNull();
    const chess = new Set(occurrences.filter(o => o.name === 'Kids Chess Club').map(o => o.image));
    expect(chess.size).toBe(2); // six weekly dates share two photos
  });

  it('lists all of an event\'s photos on its pages', async () => {
    const one = await (await request('/api/occurrences/RTD-OCC-00004-20261008')).json<{ occurrence: { image: string; images: string[] } }>();
    expect(one.occurrence.images).toHaveLength(2);
    expect(one.occurrence.images).toContain(one.occurrence.image);
    const series = await (await request(`/api/events/${CHESS}`)).json<{ event: { images: string[] } }>();
    expect(series.event.images).toHaveLength(2);
  });

  it('stops serving an event\'s photos once it is hidden', async () => {
    const { occurrences } = await (await request('/api/events')).json<{ occurrences: { name: string; image: string }[] }>();
    const url = occurrences.find(o => o.name === 'Quiz')!.image;
    await sync({ run_id: 'hide', sources: { event_index: [
      indexRow(1, { 'Event Name': 'Quiz', 'App Visibility': 'Hidden', 'Photo Folder ID': 'folderQuiz123' }),
      indexRow(2, { 'Event Name': 'Food1', 'App Visibility': 'Hidden', 'Photo Folder ID': 'folderFood123' }),
      indexRow(3, { 'Event Name': 'Spooky Market', 'Event Date': '17/10/2026' }),
      indexRow(4, { 'Event Name': 'Kids Chess Club', 'Event Date': '08/10/2026', Frequency: 'Weekly', 'Photo Folder ID': 'folderQuiz123' }),
    ] } });
    expect((await request(url)).status).toBe(404);
    expect((await request('/images/not-an-id')).status).toBe(404);
  });

  it('uses the photo in shared-link previews', async () => {
    const ASSETS = { fetch: async () => new Response('<html><head><title>x</title><meta property="og:image" content="/brand/og-default.png" /></head><body></body></html>') } as unknown as Fetcher;
    const html = await (await request('/event/RTD-OCC-00001-20261023', {}, { ASSETS })).text();
    expect(html).toMatch(/<meta property="og:image" content="http:\/\/localhost\/images\/[a-f0-9]{32}" \/>/);
  });
});
