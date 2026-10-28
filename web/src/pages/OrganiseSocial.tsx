// Social prompts, admins only (docs/superpowers/specs/2026-10-18-social-master-prompt-design.md §5).
// Each event gets its own master prompt, written from the facts the café put in the Logic Engine,
// and every post is checked against that event's facts before it goes out. The panel (Organise ›
// Social posts) has the prompts waiting for a person, each with its example post, inline Approve,
// Regenerate and Fix (Fix all for the lot) and one-tap fact suggestions, the approved prompts with theirs, the switch and the posts the check held; the event
// editor has one event's facts, its prompt and example, Regenerate, Approve with a note, versions and checks.

import { AlertTriangle, Check, ExternalLink, RefreshCw, Wand2 } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip, type ChipKind } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { shortDate, todayLondon } from '../lib/dates';
import {
  hostApi,
  type EventSocial,
  type SocialApprovedItem,
  type SocialCheck,
  type SocialExample,
  type SocialMode,
  type SocialOverview,
  type SocialPromptStatus,
  type SocialReviewItem,
  type SocialSuggestion,
} from '../lib/hostApi';
import { editorHref, socialOrder } from '../lib/eventTrail';
import { saveTrail } from '../lib/eventTrailStore';
import { exampleView } from '../lib/socialExample';
import { toast } from '../lib/toast';

const MODES: { mode: SocialMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'Posts go out just as they do now. Nothing is checked.' },
  { mode: 'shadow', label: 'Shadow', hint: 'Every post is checked and the result kept here, but nothing is held back.' },
  { mode: 'enforce', label: 'Enforce', hint: 'A post that fails its check is held back and doesn’t go out.' },
];

const STATUS: Record<SocialPromptStatus, { label: string; kind: ChipKind }> = {
  pending: { label: 'Waiting for the builder', kind: 'awaiting' },
  validated: { label: 'Checked', kind: 'completed' },
  review_required: { label: 'Needs review', kind: 'awaiting' },
  approved: { label: 'Approved', kind: 'approved' },
  superseded: { label: 'Replaced', kind: 'completed' },
  blocked: { label: 'Blocked', kind: 'cancelled' },
};

const clockOf = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => `${shortDate(todayLondon(new Date(iso)))}, ${clockOf(iso)}`;

/** The problems a refused approval lists (the server sends them as a list). */
const listOf = (errors: unknown): string[] => (Array.isArray(errors) ? errors : errors && typeof errors === 'object' ? Object.values(errors) : []).map(String);

const prompts = (n: number) => `${n} prompt${n === 1 ? '' : 's'}`;

// ---- The panel (Organise › Social posts) ----

export function SocialPanel() {
  const [data, setData] = useState<SocialOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const res = await hostApi<SocialOverview>('/api/staff/social');
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, []);
  useEffect(() => void load(), [load]);
  const waiting = data ? data.review.length : 0;
  const reviewIds = data ? data.review.map(r => r.event_id) : [];
  const approvedIds = data ? data.approved.map(a => a.event_id) : [];
  // Opening an event remembers this list's order, so the editor can step through it.
  const remember = (fromApproved: boolean) => () => saveTrail({ from: 'social', ids: socialOrder(reviewIds, approvedIds, fromApproved) });

  return (
    <section class="section" aria-labelledby="social-prompts">
      <div class="section-head">
        <h2 id="social-prompts">Social prompts {waiting > 0 && <span class="count-badge">{waiting}</span>}</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Each event gets its own master prompt, written from the facts you’ve put in the Logic Engine, and every post is checked against that event’s facts
        before it goes out. Each prompt has an example post beside it, written and checked the way a real post would be. Examples are never posted.
      </p>
      {error && <LoadError error={error} onRetry={load} />}
      {!data && !error && <DiceLoader label="Loading social prompts..." />}
      {data && (
        <div class="stack social" style={{ '--gap': '20px' }}>
          <div>
            <div class="cluster social__review-head">
              <h3 class="label social__subhead">Prompts to review</h3>
              {data.review.length > 0 && <FixAll count={data.review.length} onDone={load} />}
            </div>
            {data.review.length > 0 && (
              <p class="meta social__subhead">
                Fix sends a prompt back to be rewritten without the problems listed. It never changes the event’s facts: a suggested change waits for you to tap
                Apply.
              </p>
            )}
            {!data.review.length && (
              <p class="meta">Nothing to review. Prompts that need a person show up here, for events still running and Public or App Bookable.</p>
            )}
            <div class="list">
              {data.review.map(r => (
                <ReviewCard key={`${r.event_id}-${r.version}`} r={r} onDone={load} onOpen={remember(false)} />
              ))}
            </div>
          </div>
          {data.approved.length > 0 && (
            <details class="social__group">
              <summary class="label">Approved ({data.approved.length})</summary>
              <p class="meta">What a good prompt looks like, with its example post.</p>
              <div class="list">
                {data.approved.map(a => (
                  <ApprovedCard key={`${a.event_id}-${a.version}`} a={a} onOpen={remember(true)} />
                ))}
              </div>
            </details>
          )}
          <ModePicker mode={data.mode} onSaved={load} />
          <div>
            <h3 class="label social__subhead">Held posts: the last 50</h3>
            <p class="meta" style={{ marginBottom: '8px' }}>
              The last 50 posts that failed their check: held in Enforce, or in Shadow, the ones that would have been. The organiser’s count takes those from
              this week.
            </p>
            {!data.held.length && <p class="meta">No posts have failed their check.</p>}
            <div class="list">
              {data.held.map(h => (
                <CheckCard key={h.check_id} c={h} />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Fix all: every prompt in the review list goes back to be rewritten, and the builder runs once. */
function FixAll({ count, onDone }: { count: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const fixAll = async () => {
    setBusy(true);
    const res = await hostApi<{ count: number }>('/api/staff/social/fix-all', {});
    setBusy(false);
    if (!res.ok) return toast(res.error);
    toast(res.data.count ? `Fixing ${prompts(res.data.count)}: they’ll be back within a couple of minutes.` : 'Nothing to fix just now.');
    onDone();
  };
  return (
    <button type="button" class="btn btn--secondary btn--sm" disabled={busy} onClick={fixAll}>
      <Wand2 size={16} aria-hidden="true" /> {busy ? 'Fixing...' : `Fix all (${count})`}
    </button>
  );
}

/** A change to the event's facts that would answer the checks: one tap sends it through Sheet sync, or a link to the field to reword. */
function SuggestionRow({ eventId, s }: { eventId: string; s: SocialSuggestion }) {
  const [state, setState] = useState<'idle' | 'busy' | 'applied'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (s.kind === 'booking_missing' || s.kind === 'description_day') {
    const href = `/organise/events/${encodeURIComponent(eventId)}?from=social#${s.link}`;
    return (
      <li class="social__suggestion">
        <a href={href}>{s.text}</a>
      </li>
    );
  }
  const apply = async () => {
    setState('busy');
    setError(null);
    const res = await hostApi(`/api/staff/events/${eventId}/sheet-edit`, { values: { [s.column]: s.to }, note: 'Suggested from the social prompt checks' });
    if (res.ok) {
      setState('applied');
      return toast('Applied: on its way to the sheet. The prompt is remade once the change is back.');
    }
    setState('idle');
    const detail = res.kind === 'invalid' ? listOf(res.errors)[0] : undefined;
    setError(detail ? `${res.error}: ${detail}` : res.error);
  };
  return (
    <li class="social__suggestion">
      <p>{s.text}</p>
      {state === 'applied' ? (
        <p class="meta" role="status">
          <Check size={16} aria-hidden="true" /> Applied: on its way to the sheet
        </p>
      ) : (
        <button type="button" class="btn btn--secondary btn--sm" disabled={state === 'busy'} onClick={apply}>
          {state === 'busy' ? 'Applying...' : 'Apply'}
        </button>
      )}
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** A prompt's text, folded away until asked for. */
function PromptText({ text, version }: { text: string | null; version: number }) {
  if (!text) return <p class="meta">No text: the builder couldn’t make one.</p>;
  return (
    <details class="social__group">
      <summary class="label">The prompt</summary>
      <div class="social__prompt" tabIndex={0} aria-label={`Prompt, version ${version}`}>
        {text}
      </div>
    </details>
  );
}

/** The example post beside a prompt: on its way, couldn’t be written, or written and checked (would pass, or would be held and why). */
function ExampleBlock({ example }: { example: SocialExample }) {
  const view = exampleView(example);
  return (
    <div class="stack social__example" style={{ '--gap': '6px' }}>
      <div class="cluster" style={{ '--gap': '8px' }}>
        <h4 class="label">Example post</h4>
        {view.kind === 'pass' && <Chip kind="approved">Would pass</Chip>}
        {view.kind === 'held' && <Chip kind="preview">Would be held</Chip>}
      </div>
      {(view.kind === 'waiting' || view.kind === 'failed') && <p class="meta">{view.line}</p>}
      {view.kind === 'held' && example.problems.length > 0 && (
        <ul class="meta social__reasons">
          {example.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {example.post && <p class="social__text">{example.post}</p>}
      {example.post && example.generated_at && <p class="meta">Written {when(example.generated_at)}. Never posted.</p>}
    </div>
  );
}

const editorLink = (eventId: string) => editorHref(eventId, 'social');

/** One prompt waiting for a person: why, the prompt, its example, and Approve (with a note) or Regenerate, right here. */
function ReviewCard({ r, onDone, onOpen }: { r: SocialReviewItem; onDone: () => void; onOpen: () => void }) {
  const [note, setNote] = useState('Checked prompt and example');
  const [busy, setBusy] = useState<null | 'approve' | 'regenerate' | 'fix'>(null);
  const [asked, setAsked] = useState(r.fixing);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const noteId = `social-note-${r.event_id}`;
  const canApprove = r.status === 'review_required' && !!r.master_prompt;

  const approve = async () => {
    setBusy('approve');
    setError(null);
    setErrors([]);
    const res = await hostApi<{ version: number }>(`/api/staff/events/${r.event_id}/social/approve`, { reason: note });
    setBusy(null);
    if (res.ok) {
      toast(`${r.name}: approved as version ${res.data.version}. It’s written to the Logic Engine on the next run.`);
      return onDone();
    }
    setError(res.error);
    setErrors(res.kind === 'invalid' ? listOf(res.errors) : []);
  };
  const regenerate = async () => {
    setBusy('regenerate');
    const res = await hostApi(`/api/staff/events/${r.event_id}/social/regenerate`, {});
    setBusy(null);
    if (res.ok) setAsked(true);
    toast(res.ok ? `${r.name}: a new prompt is being made now, usually within a couple of minutes (15 at most).` : res.error);
    onDone();
  };
  const fix = async () => {
    setBusy('fix');
    const res = await hostApi(`/api/staff/events/${r.event_id}/social/fix`, {});
    setBusy(null);
    if (res.ok) setAsked(true);
    toast(res.ok ? `Fixing ${r.name}: it’ll be back within a couple of minutes.` : res.error);
    onDone();
  };

  return (
    <article class="card card--pad stack social__review" style={{ '--gap': '10px' }} aria-labelledby={`review-${r.event_id}`}>
      <div class="cluster" style={{ '--gap': '8px' }}>
        <strong id={`review-${r.event_id}`}>{r.name}</strong>
        <Chip kind={STATUS[r.status].kind}>{STATUS[r.status].label}</Chip>
        <span class="meta">v{r.version}</span>
      </div>
      {r.questions.length > 0 && (
        <ul class="social__reasons">
          {r.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      )}
      {r.suggestions.length > 0 && (
        <div class="stack social__suggestions" style={{ '--gap': '6px' }}>
          <h4 class="label">Suggested changes to the facts</h4>
          <ul class="stack" style={{ '--gap': '8px' }}>
            {r.suggestions.map((s, i) => (
              <SuggestionRow key={i} eventId={r.event_id} s={s} />
            ))}
          </ul>
        </div>
      )}
      <PromptText text={r.master_prompt} version={r.version} />
      {r.example && <ExampleBlock example={r.example} />}
      {canApprove && (
        <div class={`field${error ? ' field--error' : ''}`}>
          <label for={noteId}>Your note</label>
          <input
            id={noteId}
            class="input"
            maxLength={500}
            value={note}
            required
            aria-describedby={`${noteId}-hint${error ? ` ${noteId}-error` : ''}`}
            onInput={e => setNote(e.currentTarget.value)}
          />
          <p id={`${noteId}-hint`} class="field__hint">
            Kept with the approval, for the record.
          </p>
          {error && (
            <div id={`${noteId}-error`} class="field__error" role="alert">
              <p>{error}</p>
              {errors.length > 0 && (
                <ul class="social__reasons">
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              <p>Open the event to change the prompt before approving it.</p>
            </div>
          )}
        </div>
      )}
      <div class="cluster social__actions">
        {canApprove && (
          <button type="button" class="btn btn--primary btn--sm" disabled={!!busy || !note.trim()} onClick={approve}>
            <Check size={16} aria-hidden="true" /> {busy === 'approve' ? 'Approving...' : 'Approve'}
          </button>
        )}
        {!asked && (
          <button type="button" class="btn btn--secondary btn--sm" disabled={!!busy} onClick={fix}>
            <Wand2 size={16} aria-hidden="true" /> {busy === 'fix' ? 'Fixing...' : 'Fix'}
          </button>
        )}
        <button type="button" class="btn btn--secondary btn--sm" disabled={!!busy || asked} onClick={regenerate}>
          <RefreshCw size={16} aria-hidden="true" /> {asked ? 'New prompt on its way' : busy === 'regenerate' ? 'Asking...' : 'Regenerate'}
        </button>
        <a class="btn btn--text btn--sm" href={editorLink(r.event_id)} onClick={onOpen} aria-label={`Open the event editor for ${r.name}`}>
          <ExternalLink size={16} aria-hidden="true" /> Open the event
        </a>
      </div>
    </article>
  );
}

/** An approved prompt in use, with its example. */
function ApprovedCard({ a, onOpen }: { a: SocialApprovedItem; onOpen: () => void }) {
  return (
    <article class="card card--pad stack" style={{ '--gap': '10px' }}>
      <div class="cluster" style={{ '--gap': '8px' }}>
        <strong>{a.name}</strong>
        <Chip kind={STATUS.approved.kind}>{STATUS.approved.label}</Chip>
        <span class="meta">v{a.version}</span>
      </div>
      {a.approved_by && (
        <p class="meta">
          Approved by {a.approved_by === 'system' ? 'the checks' : a.approved_by}
          {a.approved_at ? `, ${when(a.approved_at)}` : ''}
        </p>
      )}
      <PromptText text={a.master_prompt} version={a.version} />
      <ExampleBlock example={a.example} />
      <p>
        <a class="btn btn--text btn--sm" href={editorLink(a.event_id)} onClick={onOpen} aria-label={`Open the event editor for ${a.name}`}>
          <ExternalLink size={16} aria-hidden="true" /> Open the event
        </a>
      </p>
    </article>
  );
}

function ModePicker({ mode, onSaved }: { mode: SocialMode; onSaved: () => void }) {
  const [choice, setChoice] = useState<SocialMode>(mode);
  const [busy, setBusy] = useState(false);
  useEffect(() => setChoice(mode), [mode]);
  const save = async () => {
    setBusy(true);
    const res = await hostApi<{ mode: SocialMode }>('/api/staff/social/mode', { mode: choice });
    setBusy(false);
    toast(res.ok ? `Social prompts: ${MODES.find(m => m.mode === res.data.mode)!.label}.` : res.error);
    onSaved();
  };
  return (
    <fieldset class="field stack social__modes" style={{ '--gap': '8px' }}>
      <legend class="label">Checking posts</legend>
      {MODES.map(m => (
        <label key={m.mode} class="social__choice">
          <input type="radio" name="social-mode" value={m.mode} checked={choice === m.mode} onChange={() => setChoice(m.mode)} />
          <span>
            <strong>
              {m.label}
              {m.mode === mode ? ' (now)' : ''}
            </strong>
            <span class="meta">{m.hint}</span>
          </span>
        </label>
      ))}
      {choice === 'enforce' && mode !== 'enforce' && (
        <div class="notice notice--warning" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <p>Posts that fail their check won’t go out. Look through the Shadow results first, so nothing good is held by surprise.</p>
        </div>
      )}
      <div>
        <button type="button" class="btn btn--primary btn--sm" disabled={busy || choice === mode} onClick={save}>
          {busy ? 'Saving...' : 'Save'}
        </button>
      </div>
    </fieldset>
  );
}

/** One check: held (or would have been), or passed, with its reasons and the start of its text. */
function CheckCard({ c }: { c: SocialCheck }) {
  const label = c.result === 'pass' ? 'Passed' : c.mode === 'enforce' ? 'Held' : 'Would have been held';
  const kind: ChipKind = c.result === 'pass' ? 'approved' : c.mode === 'enforce' ? 'cancelled' : 'preview';
  return (
    <article class="card card--pad stack social__check" style={{ '--gap': '6px' }}>
      <div class="cluster" style={{ '--gap': '8px' }}>
        <strong>{c.names.join(', ') || 'No event'}</strong>
        <Chip kind={kind}>{label}</Chip>
      </div>
      <p class="meta">
        {when(c.created_at)} · {c.kind.replace('_', ' ')}
        {c.platform ? ` · ${c.platform}` : ''} · {c.check_id}
      </p>
      {c.reasons.length > 0 && (
        <ul class="meta social__reasons">
          {c.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <p class="social__text">{c.text ?? <em class="meta">(text cleared after 90 days)</em>}</p>
      {c.image_text && <p class="social__text">Poster: {c.image_text}</p>}
    </article>
  );
}

// ---- One event (the Edit event page) ----

/** factsInEditor: the Edit event page has a Social facts section to change them in. */
export function EventSocialSection({ eventId, factsInEditor = false }: { eventId: string; factsInEditor?: boolean }) {
  const [data, setData] = useState<EventSocial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const res = await hostApi<EventSocial>(`/api/staff/events/${eventId}/social`);
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, [eventId]);
  useEffect(() => void load(), [load]);
  // Opened from "Review the prompt" on the panel: once it has loaded, bring this section into view.
  const loaded = data !== null;
  useEffect(() => {
    if (loaded && location.hash === '#social-prompt') document.getElementById('social-prompt')?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  return (
    <section id="social-prompt" class="card card--pad stack social" style={{ '--gap': '16px' }} aria-labelledby="ev-social">
      <h2 id="ev-social">Social prompt</h2>
      {error && <LoadError error={error} onRetry={load} />}
      {!data && !error && <DiceLoader label="Loading the social prompt..." />}
      {data && (
        <>
          {data.mode === 'off' && <p class="meta">Checking posts is Off for now, so posts go out as they always have. The prompt is kept ready here.</p>}
          <Facts data={data} inEditor={factsInEditor} />
          <Prompt data={data} eventId={eventId} onChanged={load} />
          <History data={data} />
          <div>
            <h3 class="label social__subhead">Recent checks</h3>
            {!data.checks.length && <p class="meta">No posts for this event have been checked yet.</p>}
            <div class="list">
              {data.checks.map(c => (
                <CheckCard key={c.check_id} c={c} />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Facts({ data, inEditor }: { data: EventSocial; inEditor: boolean }) {
  return (
    <div class="stack" style={{ '--gap': '12px' }}>
      <div class="social__facts">
        <div>
          <h3 class="label">Approved Facts</h3>
          {data.facts.length ? (
            <dl class="social__dl">
              {data.facts.map((f, i) => (
                <div key={i}>
                  <dt>{f.key}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p class="meta">None yet.</p>
          )}
        </div>
        <div>
          <h3 class="label">People &amp; Roles</h3>
          {data.people.length ? (
            <dl class="social__dl">
              {data.people.map((p, i) => (
                <div key={i}>
                  <dt>{p.name}</dt>
                  <dd>{p.role}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p class="meta">None yet.</p>
          )}
        </div>
        <div>
          <h3 class="label">Banned Phrases</h3>
          {data.banned.length ? (
            <ul class="social__tags">
              {data.banned.map((b, i) => (
                <li key={i} class="tag">
                  {b}
                </li>
              ))}
            </ul>
          ) : (
            <p class="meta">None.</p>
          )}
        </div>
      </div>
      {inEditor ? (
        <p class="field__hint">
          <a
            href="#social-facts"
            onClick={e => {
              e.preventDefault();
              document.getElementById('social-facts')?.scrollIntoView({ block: 'start' });
            }}
          >
            Change these under Social facts
          </a>
          , above. They reach the Logic Engine first, show here after the next sync, and the prompt is made again.
        </p>
      ) : (
        <p class="field__hint">Edit these in the Logic Engine, in the event’s row. Changes show here after the next sync, and the prompt is made again.</p>
      )}
      {data.parse_errors.length > 0 && (
        <div class="notice notice--warning">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>Some lines can’t be read</strong>
            <p>They aren’t used until they’re fixed{inEditor ? ' under Social facts' : ' in the Logic Engine'}:</p>
            <ul class="social__reasons">
              {data.parse_errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function Prompt({ data, eventId, onChanged }: { data: EventSocial; eventId: string; onChanged: () => void }) {
  const p = data.prompt;
  // Lines that can't be read are listed once, with the facts above, not again here.
  const looks = p ? [...p.questions, ...p.errors].filter(q => !data.parse_errors.includes(q)) : [];
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const regenerate = async () => {
    setBusy(true);
    const res = await hostApi(`/api/staff/events/${eventId}/social/regenerate`, {});
    setBusy(false);
    toast(res.ok ? 'A new prompt is being made now, usually within a couple of minutes (15 at most).' : res.error);
    onChanged();
  };

  return (
    <div class="stack" style={{ '--gap': '10px' }}>
      <h3 class="label social__subhead">The prompt</h3>
      {!p ? (
        <p class="meta">No prompt yet. One is made automatically for events with a date to come, usually within a couple of minutes of the facts being filled in (15 at most).</p>
      ) : (
        <>
          <div class="cluster" style={{ '--gap': '8px' }}>
            <Chip kind={STATUS[p.status].kind}>{STATUS[p.status].label}</Chip>
            <span class="meta">Version {p.version}</span>
            {data.in_use !== null && data.in_use !== p.version && <span class="meta">· posts still use version {data.in_use}</span>}
            {!p.current_facts && <span class="meta">· the facts have changed since</span>}
          </div>
          <p class="meta">
            {[
              p.generated_at ? `Made ${when(p.generated_at)}` : null,
              p.validated_at ? `checked ${when(p.validated_at)}` : null,
              p.approved_by ? `approved by ${p.approved_by === 'system' ? 'the checks' : p.approved_by}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
              .replace(/^./, c => c.toUpperCase())}
            {p.override_reason ? ` · “${p.override_reason}”` : ''}
          </p>
          {looks.length > 0 && (
            <div class={`notice ${p.status === 'blocked' ? 'notice--danger' : 'notice--info'}`}>
              <div>
                <p>
                  <strong>{p.status === 'approved' ? 'Noted when it was made' : 'What needs a look'}</strong>
                </p>
                <ul class="social__reasons">
                  {looks.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {p.master_prompt ? (
            <div class="social__prompt" tabIndex={0} aria-label={`Prompt, version ${p.version}`}>
              {p.master_prompt}
            </div>
          ) : (
            <p class="meta">No text: the builder couldn’t make one.</p>
          )}
          {p.example && <ExampleBlock example={p.example} />}
        </>
      )}
      {data.in_use === null && data.mode === 'enforce' && (
        <p class="meta">There’s no approved prompt for the facts as they are now, so this event’s posts are held until one is approved.</p>
      )}
      <div class="cluster">
        <button type="button" class="btn btn--secondary btn--sm" disabled={busy || data.regenerating} onClick={regenerate}>
          <RefreshCw size={16} aria-hidden="true" /> {data.regenerating ? 'New prompt on its way' : 'Regenerate'}
        </button>
        {!open && (
          <button type="button" class="btn btn--secondary btn--sm" onClick={() => setOpen(true)}>
            <Check size={16} aria-hidden="true" /> Approve with a note
          </button>
        )}
      </div>
      {open && <ApproveForm eventId={eventId} start={p?.master_prompt ?? ''} onClose={() => setOpen(false)} onSaved={() => (setOpen(false), onChanged())} />}
    </div>
  );
}

// Code adds this line itself, so the form leaves it out of the text to edit.
const RULE = /\s*Use ONLY the date and time supplied for the target occurrence at posting time; never state any other date or time\.\s*$/;

function ApproveForm({ eventId, start, onClose, onSaved }: { eventId: string; start: string; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(start.replace(RULE, ''));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErrors([]);
    setError(null);
    const res = await hostApi<{ version: number }>(`/api/staff/events/${eventId}/social/approve`, { text, reason });
    setBusy(false);
    if (res.ok) {
      toast(`Approved as version ${res.data.version}. It’s written to the Logic Engine on the next run.`);
      return onSaved();
    }
    setError(res.error);
    setErrors(res.kind === 'invalid' ? listOf(res.errors) : []);
    document.getElementById('social-text')?.focus();
  };
  const problems = errors.length > 0 || !!error;
  return (
    <div class="stack social__approve" style={{ '--gap': '12px' }}>
      <div class={`field${problems ? ' field--error' : ''}`}>
        <label for="social-text">Prompt</label>
        <textarea
          id="social-text"
          class="input"
          rows={8}
          maxLength={3000}
          value={text}
          aria-describedby={`social-text-hint${problems ? ' social-text-error' : ''}`}
          onInput={e => setText(e.currentTarget.value)}
        />
        <p id="social-text-hint" class="field__hint">
          It gets the same checks as a made prompt: no dates, times or weekdays, no price but the event’s own, no other event’s name, and no names that aren’t
          in its facts. The line about using only the post’s own date and time is added for you.
        </p>
        {problems && (
          <div id="social-text-error" class="field__error" role="alert">
            <p>{error}</p>
            {errors.length > 0 && (
              <ul class="social__reasons">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div class="field">
        <label for="social-reason">Your note</label>
        <input
          id="social-reason"
          class="input"
          maxLength={500}
          value={reason}
          required
          aria-describedby="social-reason-hint"
          onInput={e => setReason(e.currentTarget.value)}
        />
        <p id="social-reason-hint" class="field__hint">
          Why you’re approving it, for the record: the answer to its question, or what you changed.
        </p>
      </div>
      <div class="cluster">
        <button type="button" class="btn btn--primary btn--sm" disabled={busy || !reason.trim() || !text.trim()} onClick={save}>
          {busy ? 'Checking...' : 'Approve'}
        </button>
        <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function History({ data }: { data: EventSocial }) {
  if (data.history.length < 2) return null;
  return (
    <details class="social__history">
      <summary class="label">Earlier versions ({data.history.length - 1})</summary>
      <ol class="list">
        {data.history.slice(1).map(v => (
          <li key={v.version} class="stack" style={{ '--gap': '4px' }}>
            <div class="cluster" style={{ '--gap': '8px' }}>
              <strong>Version {v.version}</strong>
              <Chip kind={STATUS[v.status].kind}>{STATUS[v.status].label}</Chip>
            </div>
            <p class="meta">
              {when(v.created_at)}
              {v.approved_by ? ` · approved by ${v.approved_by === 'system' ? 'the checks' : v.approved_by}` : ''}
              {v.override_reason ? ` · “${v.override_reason}”` : ''}
            </p>
            {v.master_prompt && (
              <div class="social__prompt social__prompt--old" tabIndex={0} aria-label={`Prompt, version ${v.version}`}>
                {v.master_prompt}
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** A list that didn't load: why, and a way to try again. */
function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div class="notice notice--warning" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <div class="stack" style={{ '--gap': '8px' }}>
        <p>{error}</p>
        <div>
          <button type="button" class="btn btn--secondary btn--sm" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" /> Try again
          </button>
        </div>
      </div>
    </div>
  );
}
