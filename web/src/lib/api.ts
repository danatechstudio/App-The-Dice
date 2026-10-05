import { useCallback, useEffect, useState } from 'preact/hooks';

export type Category = 'Gaming' | 'Quiz' | 'Social' | 'Club' | 'Tournament' | 'Market' | 'Workshop' | 'Other';

export interface Occurrence {
  occurrence_id: string;
  event_id: string;
  name: string;
  category: Category;
  description: string | null;
  date: string; // YYYY-MM-DD, London
  start_time: string | null; // HH:MM, London
  end_time: string | null;
  starts_at: string | null; // UTC ISO
  ends_at: string | null;
  all_day: boolean;
  projected: boolean;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
  rescheduled_to: string | null;
  /** Private ones arrive as "Private session" with only their time (the café is busy). */
  visibility: 'public' | 'app_bookable' | 'private';
  image: string | null;
  price_display: string | null;
  /** Max players, when known (host sessions set it). */
  capacity: number | null;
  /** All of the event's photos (single-occurrence endpoint only). */
  images?: string[];
}

export interface EventSummary {
  event_id: string;
  name: string;
  category: Category;
  description: string | null;
  frequency: string;
  image: string | null;
  images: string[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const cache = new Map<string, { at: number; data: unknown }>();
const FRESH_MS = 60_000;

export async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'No connection');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  const data = (await res.json()) as T;
  cache.set(url, { at: Date.now(), data });
  return data;
}

/** Fetch with an in-memory cache: cached data shows instantly, then refreshes if stale. */
export function useApi<T>(url: string | null) {
  const cached = url ? (cache.get(url) as { at: number; data: T } | undefined) : undefined;
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({
    data: cached?.data,
    loading: !!url && !cached,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    const hit = cache.get(url) as { at: number; data: T } | undefined;
    setState({ data: hit?.data, loading: !hit });
    if (hit && Date.now() - hit.at < FRESH_MS && nonce === 0) return;
    let live = true;
    getJson<T>(url).then(
      data => live && setState({ data, loading: false }),
      (error: ApiError) => live && setState(s => ({ data: s.data, error, loading: false })),
    );
    return () => {
      live = false;
    };
  }, [url, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { ...state, reload };
}
