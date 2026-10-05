import { applyD1Migrations, env, reset } from 'cloudflare:test';
import app from '../src/index';

export { env };

/** Empty database with the schema applied. Call in beforeEach. */
export async function freshDb(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
}

export function request(path: string, init: RequestInit = {}, envOverrides: Partial<Env> = {}) {
  return app.request(path, init, { ...env, ...envOverrides });
}

export function sync(body: unknown, token = 'test-sync-token') {
  return request('/internal/sync/logic-engine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** An Event Index row as n8n's Google Sheets node returns it. */
export function indexRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    row_number: n + 1,
    'Event Name': `Event ${n}`,
    Frequency: '',
    Day: 'Friday',
    'Event Date': '23/10/2026',
    'Event Time': '18:30',
    'End Time': '22:00',
    'Base Details': `Details for event ${n}`,
    Status: 'Active',
    'Photo Folder ID': '',
    'Event ID': `RTD-EVT-${String(n).padStart(5, '0')}`,
    'App Visibility': 'Public',
    'App Category': 'Quiz',
    ...overrides,
  };
}

/** A Standard Diary row. */
export function diaryRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    row_number: n + 1,
    Group: `Group ${n}`,
    Day: 'Monday',
    Date: '12/10/2026',
    Notes: `Notes for group ${n}`,
    Frequency: 'Weekly',
    'Event ID': `RTD-EVT-${String(n).padStart(5, '0')}`,
    'App Visibility': 'Public',
    'App Category': 'Club',
    ...overrides,
  };
}
