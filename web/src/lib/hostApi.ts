// Calls to the Access-protected organiser API. A sign-in that has run out
// shows up as a redirect to Cloudflare Access, which we turn into "sign in again".

export type HostRole = 'host' | 'staff' | 'admin';

export interface HostUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: HostRole;
}

export type SessionStatus = 'submitted' | 'approved' | 'declined' | 'withdrawn' | 'published';
/** The Logic Engine's own Frequency words, so sessions map straight onto Event Index. */
export type Frequency = 'one-off' | 'weekly';

export interface HostSession {
  session_id: string;
  host_user_id: string;
  host_name: string | null;
  host_email: string;
  name: string;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  price_pence: number;
  price_label: string;
  max_players: number;
  frequency: Frequency;
  status: SessionStatus;
  decision_note: string | null;
  decided_at: string | null;
  event_id: string | null;
}

export interface HostRecord {
  user_id: string;
  email: string;
  display_name: string | null;
  active: number;
  created_at: string;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'signed-out' | 'not-host' | 'invalid' | 'error'; error: string; errors?: Record<string, string>; reason?: string };

/** Where the "Sign in" button goes: a path Cloudflare Access guards, which sends people back to /organise. */
export const SIGN_IN_URL = '/api/staff/sign-in';

export async function hostApi<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, kind: 'error', error: "That didn't go through. Check your connection and try again." };
  }
  if (res.type === 'opaqueredirect') return { ok: false, kind: 'signed-out', error: 'Please sign in again.' };
  const data = (await res.json().catch(() => ({}))) as { error?: string; errors?: Record<string, string>; reason?: string };
  if (res.status === 401) return { ok: false, kind: 'signed-out', error: 'Please sign in again.', reason: data.reason };
  if (res.status === 403) return { ok: false, kind: 'not-host', error: data.error ?? 'Not allowed' };
  if (res.status === 400 || (res.status === 409 && data.errors)) return { ok: false, kind: 'invalid', error: data.error ?? 'Please check the form', errors: data.errors };
  if (!res.ok) return { ok: false, kind: 'error', error: data.error ?? `Something went wrong (${res.status})` };
  return { ok: true, data: data as T };
}
