// Needs attention emails (docs/RTD_EVENT_CONTROL_AUDIT.md §5.1, Stage 3c): a notice per
// expired item to every address, then a reminder each morning until it's sorted. Never twice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../src/attention/attention';
import { NOTICES_PER_RUN, remind } from '../src/attention/reminders';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const ADMIN = as('dan@example.com');
const STAFF = as('michelle@example.com');
const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ORIGIN = 'https://rtd.test';
const TO = ['cafe@example.com', 'dan@example.com'];

const at = (iso: string) => vi.setSystemTime(new Date(iso));
/** The hourly Cron Trigger: the detector, then the emails. */
const hourly = async () => {
  await detect(env.DB, new Date());
  return remind(env.DB, new Date(), ORIGIN);
};
const outbox = async () =>
  (await env.DB.prepare('SELECT dedupe_key, kind, to_email, subject, html FROM outbox ORDER BY message_id').all<{ dedupe_key: string; kind: string; to_email: string; subject: string; html: string }>()).results;
const settings = (body: unknown, who = ADMIN) => request('/api/staff/attention/emails', post(body), who);

/** Bingo ended on Fri 9 Oct; Quiz ends on Fri 23 Oct. */
const rows = (extra: ReturnType<typeof indexRow>[] = []) => ({
  event_index: [
    indexRow(1, { 'Event Name': 'Bingo', Frequency: 'Monthly', 'Event Date': '09/10/2026' }),
    indexRow(2, { 'Event Name': 'Quiz', 'Event Date': '23/10/2026' }),
    indexRow(3, { 'Event Name': 'D&D', 'Event Date': '' }),
    ...extra,
  ],
});

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-10-05T10:00:00Z');
  const t = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(t),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(t),
  ]);
  await sync({ run_id: 'seed', sources: rows() });
  await request('/api/staff/attention/switch', post({ on: true }), ADMIN);
  at('2026-10-10T12:00:00Z');
  await hourly(); // Bingo's item opens while the emails are off
});
afterEach(() => vi.useRealTimers());

describe('settings', () => {
  it('sends nothing until an admin sets the addresses and switches it on', async () => {
    expect(await hourly()).toEqual({ notices: 0, digest: 0 });
    expect(await outbox()).toEqual([]);
    expect((await settings({ to: TO.join(', '), on: true }, STAFF)).status).toBe(403);
    expect((await settings({ to: 'cafe@example.com, not-an-address' })).status).toBe(400);
    expect((await settings({ on: true })).status).toBe(400); // nobody to email yet
    expect((await settings({ to: 'a@x.com b@x.com c@x.com d@x.com e@x.com f@x.com' })).status).toBe(400);
    const res = await settings({ to: ' Cafe@Example.com; dan@example.com, cafe@example.com ', on: true });
    expect(await res.json()).toEqual({ on: true, to: TO });
    const audit = await env.DB.prepare("SELECT actor_id, new_value FROM audit_log WHERE action = 'attention.emails_changed'").first();
    expect(audit).toEqual({ actor_id: 'dan@example.com', new_value: JSON.stringify({ on: true, to: TO }) });
  });
});

describe('emails', () => {
  beforeEach(async () => {
    await settings({ to: TO.join(','), on: true });
  });

  it('puts what was already waiting into the next morning reminder, not a notice now', async () => {
    expect(await hourly()).toEqual({ notices: 0, digest: 0 });
    at('2026-10-11T07:59:00Z'); // 08:59 BST
    expect((await hourly()).digest).toBe(0);
    at('2026-10-11T08:10:00Z'); // 09:10 BST
    expect(await hourly()).toEqual({ notices: 0, digest: 1 });
    const sent = await outbox();
    expect(sent.map(m => [m.dedupe_key, m.kind, m.to_email])).toEqual([
      ['expiry-digest:2026-10-11:cafe@example.com', 'attention_digest', 'cafe@example.com'],
      ['expiry-digest:2026-10-11:dan@example.com', 'attention_digest', 'dan@example.com'],
    ]);
    expect(sent[0]!.subject).toBe('Needs attention: 1 event still waiting');
    expect(sent[0]!.html).toContain('<strong>Bingo</strong>: finished Fri 9 Oct, waiting 0 days');
    expect(sent[0]!.html).toContain('Also 1 event has no usable date');
    expect(sent[0]!.html).toContain('https://rtd.test/organise/attention#attention');
  });

  it('sends a notice to every address when a date passes, exactly once however often it runs', async () => {
    at('2026-10-23T21:00:01Z'); // Quiz is over (22:00 BST)
    expect(await hourly()).toEqual({ notices: 1, digest: 1 }); // and that day's reminder for Bingo
    for (let i = 0; i < 3; i++) await hourly();
    const notices = (await outbox()).filter(m => m.kind === 'attention_expired');
    expect(notices.map(m => [m.dedupe_key, m.to_email])).toEqual([
      [expect.stringMatching(/^expiry-new:\d+:cafe@example\.com$/), 'cafe@example.com'],
      [expect.stringMatching(/^expiry-new:\d+:dan@example\.com$/), 'dan@example.com'],
    ]);
    expect(notices[0]!.subject).toBe('Needs attention: Quiz (Fri 23 Oct) has no next date');
    expect(notices[0]!.html).toContain('finished on Friday 23 October at 6:30pm');
    expect(notices[0]!.html).toContain("Opening this email doesn't sort it");
    // Announced tonight, so it's not in tonight's reminder (that went out for Bingo alone).
    const digests = (await outbox()).filter(m => m.kind === 'attention_digest');
    expect(digests).toHaveLength(2);
    expect(digests[0]!.html).not.toContain('Quiz');
  });

  it('reminds every morning, once a day per address, and stops when it is sorted', async () => {
    for (const day of ['2026-10-11', '2026-10-12']) {
      at(`${day}T08:10:00Z`);
      await hourly();
      at(`${day}T15:10:00Z`);
      await hourly(); // later the same day: nothing more
    }
    expect((await outbox()).filter(m => m.kind === 'attention_digest')).toHaveLength(4);
    expect(await env.DB.prepare("SELECT reminder_count FROM attention_items WHERE kind = 'expired'").first()).toEqual({ reminder_count: 2 });

    const bingo = await env.DB.prepare("SELECT item_id FROM attention_items WHERE kind = 'expired'").first<{ item_id: number }>();
    await request(`/api/staff/attention/${bingo!.item_id}/resolve`, post({ action: 'archive' }), STAFF);
    at('2026-10-13T08:10:00Z');
    expect(await hourly()).toEqual({ notices: 0, digest: 0 });
    expect((await outbox()).filter(m => m.kind === 'attention_digest')).toHaveLength(4);
  });

  it(`announces at most ${NOTICES_PER_RUN} items a run, so a burst can't flood anyone`, async () => {
    const extra = Array.from({ length: 7 }, (_, i) => indexRow(10 + i, { 'Event Name': `One-off ${i}`, 'Event Date': '23/10/2026' }));
    at('2026-10-20T10:00:00Z');
    await sync({ run_id: 'more', sources: rows(extra) });
    at('2026-10-23T21:00:01Z');
    expect((await hourly()).notices).toBe(NOTICES_PER_RUN);
    expect((await hourly()).notices).toBe(3); // Quiz and the other two
    expect((await outbox()).filter(m => m.kind === 'attention_expired')).toHaveLength(8 * 2);
  });

  it('sends a test to every address, once a minute at most', async () => {
    expect((await request('/api/staff/attention/emails/test', post({}), STAFF)).status).toBe(403);
    await request('/api/staff/attention/emails/test', post({}), ADMIN);
    await request('/api/staff/attention/emails/test', post({}), ADMIN);
    expect((await outbox()).map(m => [m.kind, m.to_email])).toEqual([
      ['attention_test', 'cafe@example.com'],
      ['attention_test', 'dan@example.com'],
    ]);
  });

  it('shows admins how the emails have gone: queued, sent (Gmail took it), or stuck', async () => {
    at('2026-10-23T21:00:01Z');
    await hourly();
    type Emails = { on: boolean; to: string[]; digest: { state: string } | null; items: Record<string, { notice: string | null; first_notified_at: string | null }> };
    const look = async () => (await (await request('/api/staff/attention', {}, STAFF)).json<{ open: { item_id: number; name: string }[]; emails: Emails }>());
    let view = await look();
    const quiz = view.open.find(i => i.name === 'Quiz')!.item_id;
    expect(view.emails).toMatchObject({ on: true, to: TO, digest: { state: 'queued' } });
    expect(view.emails.items[quiz]).toMatchObject({ notice: 'queued' });

    // n8n collects and sends them (RTD Outbox): literal addresses, so it needs no change.
    const auth = { Authorization: 'Bearer test-sync-token' };
    const { messages } = await (await request('/internal/outbox/collect', { method: 'POST', headers: auth })).json<{ messages: { message_id: number; to: string }[] }>();
    expect(messages.map(m => m.to)).toEqual(expect.arrayContaining(TO));
    for (const m of messages.filter(m => m.to === 'cafe@example.com')) await request(`/internal/outbox/${m.message_id}/sent`, { method: 'POST', headers: auth });
    at('2026-10-23T21:40:00Z'); // the other address's emails are still waiting, 40 minutes on
    view = await look();
    expect(view.emails.items[quiz]).toMatchObject({ notice: 'stuck' });
    for (const m of messages.filter(m => m.to === 'dan@example.com')) await request(`/internal/outbox/${m.message_id}/sent`, { method: 'POST', headers: auth });
    view = await look();
    expect(view.emails.items[quiz]).toMatchObject({ notice: 'sent' });
    expect(view.emails.digest).toMatchObject({ state: 'sent' });
  });
});
