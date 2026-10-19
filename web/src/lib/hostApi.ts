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
/** Private sessions show in the diary only as "Private session" and their time. */
export type Access = 'open' | 'private';

export interface HostSession {
  session_id: string;
  host_user_id: string;
  host_name: string | null;
  host_email: string;
  host_role: HostRole;
  name: string;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  price_pence: number;
  price_label: string;
  max_players: number;
  frequency: Frequency;
  access: Access;
  status: SessionStatus;
  decision_note: string | null;
  decided_at: string | null;
  event_id: string | null;
  /** Times it was sent again after a decline or withdrawal. */
  resubmissions?: number;
  /** Live sessions: upcoming dates, with who's booked. */
  dates?: SessionDate[];
  /** Live sessions: what the diary shows now, which a change request starts from. */
  live?: LiveDetails | null;
  /** Live sessions: the latest change request, while waiting or decided in the last fortnight. */
  change?: ChangeRequest | null;
}

export interface LiveDetails {
  name: string;
  description: string | null;
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  price: string;
  price_pence: number;
  access: Access;
}

export type ChangeField = 'name' | 'description' | 'event_date' | 'start_time' | 'end_time' | 'price' | 'access';

/** A host's change to a live session (src/host/changes.ts). */
export interface ChangeRequest {
  request_id: string;
  session_id: string;
  host: string;
  frequency: Frequency;
  name: string;
  note: string | null;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn' | 'superseded';
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied: boolean;
  created_at: string;
  changes: { field: ChangeField; label: string; now: string | null; proposed: string | null }[];
  bookings: number;
  people: number;
}

export interface DateBooking {
  booking_id: string;
  lead_name: string;
  party_size: number;
  notes: string | null;
  /** Approvers only. */
  email?: string;
  mobile?: string | null;
}

/** One date of a live session (docs/RTD_BOOKINGS.md). */
export interface SessionDate {
  occurrence_id: string;
  host_session_id: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  status: 'scheduled' | 'cancelled';
  cancelled_by: 'host' | 'staff' | null;
  /** Places on this date; null: no limit. */
  capacity: number | null;
  /** Places set for this date alone; otherwise it follows the session or event. */
  own_capacity: number | null;
  booked: number;
  bookings: DateBooking[];
}

/** For approvers: a booked or hosted date, with its session and host (null for the café's own events). */
export interface HostedDate extends Omit<SessionDate, 'host_session_id'> {
  event_id: string;
  event_name: string;
  host_session_id: string | null;
  session: { session_id: string; name: string; access: Access; max_players: number | null; host_name: string | null; host_email: string; host_role: HostRole } | null;
}

/** For approvers: a café event people can book, with its places (docs/RTD_BOOKINGS.md#places). */
export interface EventPlaces {
  event_id: string;
  name: string;
  source: 'event_index' | 'standard_diary';
  frequency: string | null;
  next_date: string;
  /** App Capacity in the sheet. */
  sheet_places: number | null;
  /** Set in the organiser; wins until App Capacity changes in the sheet. */
  app_places: number | null;
  /** What applies; null: no limit. */
  places: number | null;
  most_booked: number;
  dates_with_own_places: number;
  /** Whether people need to book: what applies, what was set in the organiser (null: the default), and the default. */
  booking_mode: BookingMode;
  booking_mode_set: BookingMode | null;
  booking_mode_default: BookingMode;
  /** Bookings standing on dates to come. */
  bookings: number;
}

export type BookingMode = 'none' | 'optional' | 'required';

/** Most places on a date (the server checks too). */
export const MAX_PLACES = { hosted: 100, cafe: 500 } as const;

/** A request to host games or join the café team (docs/RTD_ONBOARDING.md). */
export interface Application {
  application_id: string;
  email: string;
  display_name: string;
  role: 'host' | 'staff';
  about: string;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface JoinMe {
  email: string;
  has_access: boolean;
  application: Application | null;
}

export interface TeamMember {
  user_id: string;
  email: string;
  display_name: string | null;
  role: HostRole;
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
  | { ok: false; kind: 'signed-out' | 'not-host' | 'invalid' | 'error'; error: string; errors?: Record<string, string>; reason?: string; status?: number; body?: unknown };

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
  if (!res.ok) return { ok: false, kind: 'error', error: data.error ?? `Something went wrong (${res.status})`, status: res.status, body: data };
  if (body !== undefined && /^\/api\/(staff|host)\//.test(path)) afterChange?.();
  return { ok: true, data: data as T };
}

// Set by lib/staffSummary, so the organiser's counts follow every change made here.
let afterChange: (() => void) | null = null;
export const setAfterChange = (fn: () => void) => void (afterChange = fn);

/** The admin event editor (src/events/admin.ts): every event, whatever its kind. */
export type EventKind = 'event_index' | 'standard_diary' | 'host_session' | 'market';
export type EventVisibility = 'public' | 'app_bookable' | 'private' | 'hidden';

export interface AdminEventRow {
  event_id: string;
  name: string;
  kind: EventKind;
  next_date: string | null;
  visibility: EventVisibility;
  active: boolean;
  bookings: number;
  pending: { kind: 'sheet_edit' | 'host_change' | 'change_on_way'; id: string } | null;
}

export interface AdminEventDetails {
  name: string;
  description: string;
  event_date: string;
  start_time: string;
  end_time: string;
  price: string;
  category: string;
}

export interface AdminEventForm extends AdminEventRow {
  session_id: string | null;
  market_id: string | null;
  details: AdminEventDetails;
  unavailable: Partial<Record<keyof AdminEventDetails | 'active', string>>;
  places: number | null;
  most_booked: number;
  booking_mode: BookingMode;
  booking_mode_set: BookingMode | null;
  dates: {
    occurrence_id: string;
    date: string;
    start_time: string | null;
    status: 'scheduled' | 'cancelled';
    hidden: boolean;
    places: number | null;
    capacity: number | null;
    booked: number;
    bookings: number;
  }[];
}

/** Social prompts (src/social/admin.ts): admins only. */
export type SocialMode = 'off' | 'shadow' | 'enforce';
export type SocialPromptStatus = 'pending' | 'validated' | 'review_required' | 'approved' | 'superseded' | 'blocked';

export interface SocialReviewItem {
  event_id: string;
  name: string;
  status: 'review_required' | 'blocked';
  version: number;
  questions: string[];
}

/** A check made before a post. Failed ones were held (enforce) or would have been (shadow). */
export interface SocialCheck {
  check_id: string;
  event_ids: string[];
  names: string[];
  mode: 'shadow' | 'enforce';
  kind: string;
  platform: string | null;
  result: 'pass' | 'fail';
  reasons: string[];
  created_at: string;
  /** Shortened for the screen; null once cleared (after 90 days). */
  text: string | null;
  image_text: string | null;
}

export interface SocialOverview {
  mode: SocialMode;
  review: SocialReviewItem[];
  held: SocialCheck[];
}

export interface SocialPromptVersion {
  version: number;
  status: SocialPromptStatus;
  master_prompt: string | null;
  approved_by: string | null;
  generated_at: string | null;
  validated_at: string | null;
  approved_at: string | null;
  override_reason: string | null;
  created_at: string;
  current_facts: boolean;
}

export interface EventSocial {
  mode: SocialMode;
  facts: { key: string; value: string }[];
  people: { name: string; role: string }[];
  banned: string[];
  parse_errors: string[];
  prompt: (SocialPromptVersion & { questions: string[]; errors: string[] }) | null;
  in_use: number | null;
  regenerating: boolean;
  history: SocialPromptVersion[];
  checks: SocialCheck[];
}
