import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diaryRow, freshDb, indexRow, request, sync } from './helpers';

// A stand-in for the built index.html, so these tests don't depend on web/dist.
const SHELL = `<!doctype html><html><head><title>Roll The Dice · Board Game Café</title>
<meta name="description" content="default" /><meta property="og:title" content="default" />
<meta property="og:description" content="default" /><meta property="og:image" content="/brand/og-default.png" />
</head><body><div id="app"></div></body></html>`;
const ASSETS = { fetch: async () => new Response(SHELL, { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher;
const page = (path: string) => request(path, {}, { ASSETS });

const QUIZ = 'RTD-OCC-00001-20261023';

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
  await sync({
    run_id: 'seed',
    sources: {
      event_index: [
        indexRow(1, { 'Event Name': 'Quiz', 'Base Details': 'A family quiz night, with prizes; bring a team!' }),
        indexRow(2, { 'Event Name': 'Food1', 'Event Date': '11/10/2026', 'App Visibility': 'Hidden' }),
      ],
      standard_diary: [diaryRow(24, { Group: 'Arkham Horror Card Game' })],
    },
  });
});
afterEach(() => vi.useRealTimers());

describe('Add to Calendar', () => {
  it('serves an .ics file with UTC times, location and the event link', async () => {
    const res = await request(`/api/occurrences/${QUIZ}/calendar.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="rtd-quiz-2026-10-23.ics"');
    const ics = await res.text();
    const unfolded = ics.replace(/\r\n /g, '');
    expect(ics.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(unfolded).toContain('DTSTART:20261023T173000Z'); // 18:30 BST
    expect(unfolded).toContain('DTEND:20261023T210000Z');
    expect(unfolded).toContain('SUMMARY:Quiz');
    expect(unfolded).toContain('DESCRIPTION:A family quiz night\\, with prizes\; bring a team!\\n\\nhttp://localhost/event/RTD-OCC-00001-20261023');
    expect(unfolded).toContain('LOCATION:Roll The Dice Board Game Café\\, Cleethorpes');
    expect(unfolded).toContain(`UID:${QUIZ}@localhost`);
  });

  it('uses whole-day dates when the diary has no time', async () => {
    const ics = (await (await request('/api/occurrences/RTD-OCC-00024-20261012/calendar.ics')).text()).replace(/\r\n /g, '');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261012');
    expect(ics).toContain('DTEND;VALUE=DATE:20261013');
  });

  it('redirects to a prefilled Google Calendar event', async () => {
    const res = await request(`/api/occurrences/${QUIZ}/google-calendar`);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('Location')!);
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('dates')).toBe('20261023T173000Z/20261023T210000Z');
    expect(url.searchParams.get('text')).toBe('Quiz');
  });

  it('never exposes hidden events', async () => {
    expect((await request('/api/occurrences/RTD-OCC-00002-20261011/calendar.ics')).status).toBe(404);
    expect((await request('/api/occurrences/RTD-OCC-00002-20261011/google-calendar')).status).toBe(404);
    expect((await request('/api/occurrences/nonsense/calendar.ics')).status).toBe(404);
  });
});

describe('shared event links', () => {
  it('names the event in the link preview', async () => {
    const res = await page(`/event/${QUIZ}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('<title>Quiz · Friday 23 October, 6:30 PM · Roll The Dice</title>');
    expect(html).toContain('<meta property="og:title" content="Quiz · Friday 23 October, 6:30 PM" />');
    expect(html).toContain('<meta property="og:image" content="http://localhost/brand/og-default.png" />');
    expect(html).toContain(`<meta property="og:url" content="http://localhost/event/${QUIZ}" />`);
  });

  it('resolves an evergreen event link to its next date', async () => {
    const html = await (await page('/events/RTD-EVT-00024')).text();
    expect(html).toContain('og:title" content="Arkham Horror Card Game · Monday 12 October"');
  });

  it('still serves the app for unknown or hidden events, as a 404 with no event details', async () => {
    for (const path of ['/event/RTD-OCC-00002-20261011', '/event/RTD-OCC-99999-20261011', '/events/RTD-EVT-00002']) {
      const res = await page(path);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('<div id="app"></div>');
      expect(html).not.toContain('Food1');
    }
  });

  it('serves the home page with an absolute share image', async () => {
    const html = await (await page('/')).text();
    expect(html).toContain('<meta property="og:image" content="http://localhost/brand/og-default.png" />');
  });

  it('keeps API 404s as JSON', async () => {
    const res = await page('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
