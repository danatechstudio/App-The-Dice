// The game library in the organiser, for admins (docs/GAME_LIBRARY_AUDIT.md):
// - Library: every game, with search and filters; add, edit, retire, covers.
// - Review: titles waiting for proof the café owns them. Confirming one asks
//   how you know, and is recorded.
// - Import: a dry run of the manifest, then applying it; and the switch that
//   puts the library live in the public app.

import { BookCheck, ImagePlus, Pencil, Plus, RotateCcw, Upload, X } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { hostApi } from '../lib/hostApi';
import { resizeImage } from '../lib/images';
import { toast } from '../lib/toast';

const AUDIENCES = ['Children', 'Family', 'Adults', 'Party', 'Strategy'] as const;
const RIGHTS = [
  ['approved', 'Approved: we may use it'],
  ['pending', 'Pending: asked, no answer yet'],
  ['restricted', 'Restricted: we may not use it'],
  ['unknown', 'Unknown'],
] as const;

interface AdminGame {
  game_id: string;
  slug: string;
  title: string;
  edition: string | null;
  category: string;
  audiences: string[];
  min_age: number | null;
  min_players: number | null;
  max_players: number | null;
  play_time_min: number | null;
  play_time_max: number | null;
  synopsis: string;
  available_for_chooser: number;
  available_for_gotw: number;
  copies: number | null;
  cover_image_id: string | null;
  thumb_image_id: string | null;
  image_source_url: string | null;
  image_attribution: string | null;
  image_rights_status: string;
  image_status: string;
  ownership_evidence: string;
  confirmed_by: string;
  confirmed_at: string;
  retired_at: string | null;
}

interface Admin {
  live: boolean;
  games: AdminGame[];
  review: Record<string, number>;
  imports: { batch_id: string; mode: string; counts: string; created_by: string; created_at: string }[];
  manifest: { games: number; review: number; status: string | null };
}

interface ReviewEntry {
  review_id: string;
  source_title: string;
  kind: 'provisional' | 'uncertain';
  entry: Record<string, unknown>;
  reasons: string[];
}

type Tab = 'library' | 'review' | 'import';

export function GamesAdmin() {
  const [data, setData] = useState<Admin | null>(null);
  const [tab, setTab] = useState<Tab>('library');
  const load = useCallback(async () => {
    const res = await hostApi<Admin>('/api/staff/games');
    if (res.ok) setData(res.data);
    else toast(res.error);
  }, []);
  useEffect(() => void load(), [load]);

  const switchLive = async (on: boolean) => {
    const ask = on
      ? 'Put the café’s game library live? Roll Me a Game, the Games page and Game of the Week switch from the preview shelf to the confirmed games.'
      : 'Go back to the preview shelf? The confirmed games stay saved.';
    if (!confirm(ask)) return;
    const res = await hostApi('/api/staff/games/live', { on, confirm: true });
    toast(res.ok ? (on ? 'The game library is live.' : 'Back to the preview shelf.') : res.error);
    await load();
  };

  return (
    <section class="section" aria-labelledby="games-admin">
      <div class="section-head">
        <h2 id="games-admin">Game library</h2>
        {data && <Chip kind={data.live ? 'live' : 'preview'}>{data.live ? 'Live' : 'Preview shelf showing'}</Chip>}
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Only confirmed games the café owns reach the app. Titles waiting for proof are under Review.
        {data && !data.live && ' The public app shows the preview shelf until you put the library live (under Import).'}
      </p>
      <div class="segmented games-admin__tabs" role="group" aria-label="Game library">
        <button type="button" aria-pressed={tab === 'library'} onClick={() => setTab('library')}>
          Library{data ? ` (${data.games.filter(g => !g.retired_at).length})` : ''}
        </button>
        <button type="button" aria-pressed={tab === 'review'} onClick={() => setTab('review')}>
          Review{data?.review.open ? ` (${data.review.open})` : ''}
        </button>
        <button type="button" aria-pressed={tab === 'import'} onClick={() => setTab('import')}>
          Import
        </button>
      </div>
      {!data && <DiceLoader label="Loading the library..." />}
      {data && tab === 'library' && <Library data={data} onChanged={load} />}
      {data && tab === 'review' && <Review categories={categoriesOf(data)} onChanged={load} />}
      {data && tab === 'import' && <Import data={data} onChanged={load} onLive={switchLive} />}
    </section>
  );
}

const categoriesOf = (d: Admin) => [...new Set(d.games.map(g => g.category))].sort();
const range = (a: number | null, b: number | null, unit = '') => (a === null && b === null ? '?' : a === b || b === null ? `${a}${unit}` : a === null ? `≤${b}${unit}` : `${a}–${b}${unit}`);

// ---- Library ----

function Library({ data, onChanged }: { data: Admin; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'live' | 'retired' | 'no-cover' | 'cover-pending'>('live');
  const [editing, setEditing] = useState<AdminGame | 'new' | null>(null);
  const [cover, setCover] = useState<AdminGame | null>(null);
  const needle = q.trim().toLowerCase();
  const list = data.games.filter(g => {
    if (needle && !`${g.title} ${g.edition ?? ''} ${g.category}`.toLowerCase().includes(needle)) return false;
    if (show === 'retired') return !!g.retired_at;
    if (g.retired_at) return false;
    if (show === 'no-cover') return !g.cover_image_id;
    if (show === 'cover-pending') return !!g.cover_image_id && (g.image_status !== 'verified' || g.image_rights_status !== 'approved');
    return true;
  });
  const retire = async (g: AdminGame, back: boolean) => {
    if (!back && !confirm(`Retire ${g.title}? It leaves the app; its record and Game of the Week history stay.`)) return;
    const res = await hostApi(`/api/staff/games/${g.game_id}/${back ? 'restore' : 'retire'}`, {});
    toast(res.ok ? (back ? `${g.title} is back.` : `${g.title} retired.`) : res.error);
    onChanged();
  };

  return (
    <div class="stack" style={{ '--gap': '12px', marginTop: '12px' }}>
      <div class="cluster games-admin__tools">
        <input class="input" type="search" placeholder="Search title or category" aria-label="Search the library" value={q} onInput={e => setQ(e.currentTarget.value)} />
        <select class="input" aria-label="Show" value={show} onChange={e => setShow(e.currentTarget.value as typeof show)}>
          <option value="live">In the library</option>
          <option value="no-cover">No cover</option>
          <option value="cover-pending">Cover not approved</option>
          <option value="retired">Retired</option>
        </select>
        <button type="button" class="btn btn--secondary btn--sm" onClick={() => setEditing('new')}>
          <Plus size={16} aria-hidden="true" /> Add a game
        </button>
      </div>
      {editing && (
        <GameForm
          mode={editing === 'new' ? 'new' : 'edit'}
          initial={editing === 'new' ? {} : editing}
          categories={categoriesOf(data)}
          onDone={changed => {
            setEditing(null);
            if (changed) onChanged();
          }}
        />
      )}
      {cover && (
        <CoverForm
          game={cover}
          onDone={changed => {
            setCover(null);
            if (changed) onChanged();
          }}
        />
      )}
      {!list.length && <p class="meta">{data.games.length ? 'Nothing matches.' : 'No confirmed games yet. Import the manifest, or confirm titles under Review.'}</p>}
      {list.length > 0 && (
        <div class="table-wrap">
          <table class="table table--stack games-table">
            <thead>
              <tr>
                <th scope="col">Game</th>
                <th scope="col">Players · time · age</th>
                <th scope="col">Cover</th>
                <th scope="col">In</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map(g => (
                <tr key={g.game_id}>
                  <td>
                    <strong>{g.title}</strong>
                    {g.edition && <span class="meta"> · {g.edition}</span>}
                    <div class="meta">{g.category}{g.audiences.length ? ` · ${g.audiences.join(', ')}` : ''}</div>
                  </td>
                  <td>
                    {range(g.min_players, g.max_players)} players · {range(g.play_time_min, g.play_time_max, ' min')} · {g.min_age === null ? 'age ?' : `${g.min_age}+`}
                  </td>
                  <td>
                    {!g.cover_image_id ? (
                      <span class="meta">No cover</span>
                    ) : g.image_status === 'verified' && g.image_rights_status === 'approved' ? (
                      <Chip kind="live">Shown</Chip>
                    ) : (
                      <Chip kind="awaiting">{g.image_rights_status === 'approved' ? 'Match not checked' : `Rights ${g.image_rights_status}`}</Chip>
                    )}
                  </td>
                  <td class="meta">
                    {[g.available_for_chooser ? 'Roll Me a Game' : null, g.available_for_gotw ? 'Game of the Week' : null].filter(Boolean).join(', ') || 'Shelf only'}
                  </td>
                  <td class="table__action table__action--wide">
                    <div class="table__buttons">
                      {!g.retired_at && (
                        <>
                          <button type="button" class="btn btn--text btn--sm" onClick={() => setEditing(g)}>
                            <Pencil size={16} aria-hidden="true" /> Edit
                          </button>
                          <button type="button" class="btn btn--text btn--sm" onClick={() => setCover(g)}>
                            <ImagePlus size={16} aria-hidden="true" /> Cover
                          </button>
                        </>
                      )}
                      <button type="button" class="btn btn--text btn--sm" onClick={() => retire(g, !!g.retired_at)}>
                        {g.retired_at ? <><RotateCcw size={16} aria-hidden="true" /> Restore</> : <><X size={16} aria-hidden="true" /> Retire</>}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Adding, editing and confirming a game ----

type FormValues = {
  title: string;
  edition: string;
  category: string;
  audiences: string[];
  min_age: string;
  min_players: string;
  max_players: string;
  play_time_min: string;
  play_time_max: string;
  synopsis: string;
  copies: string;
  available_for_chooser: boolean;
  available_for_gotw: boolean;
  ownership_evidence: string;
};

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function GameForm({ mode, initial, categories, reviewId, onDone }: {
  mode: 'new' | 'edit' | 'confirm';
  initial: Partial<AdminGame> | Record<string, unknown>;
  categories: string[];
  reviewId?: string;
  onDone: (changed: boolean) => void;
}) {
  const i = initial as Record<string, unknown>;
  const [f, setF] = useState<FormValues>(() => ({
    title: str(i.title),
    edition: str(i.edition),
    category: str(i.category),
    audiences: Array.isArray(i.audiences) ? (i.audiences as string[]) : [],
    min_age: str(i.min_age),
    min_players: str(i.min_players),
    max_players: str(i.max_players),
    play_time_min: str(i.play_time_min),
    play_time_max: str(i.play_time_max),
    synopsis: str(i.synopsis),
    copies: str(i.copies),
    available_for_chooser: i.available_for_chooser !== 0 && i.available_for_chooser !== false,
    available_for_gotw: i.available_for_gotw !== 0 && i.available_for_gotw !== false,
    ownership_evidence: '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValues>(k: K, v: FormValues[K]) => setF(x => ({ ...x, [k]: v }));
  const id = (k: string) => `gf-${k}`;

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const path = mode === 'new' ? '/api/staff/games' : mode === 'edit' ? `/api/staff/games/${i.game_id}` : `/api/staff/game-review/${reviewId}/confirm`;
    const res = await hostApi(path, { ...f, edition: f.edition || null, copies: f.copies || null });
    setBusy(false);
    if (res.ok) {
      toast(mode === 'confirm' ? `${f.title} confirmed and added to the library.` : mode === 'new' ? `${f.title} added.` : `${f.title} saved.`);
      onDone(true);
    } else if (res.kind === 'invalid') setErrors(res.errors ?? {});
    else toast(res.error);
  };

  const field = (k: keyof FormValues, label: string, opts: { type?: string; hint?: string; optional?: boolean; wide?: boolean } = {}) => (
    <div class={`field${errors[k] ? ' field--error' : ''}${opts.wide ? ' games-form__wide' : ''}`}>
      <label for={id(k)}>
        {label} {opts.optional && <span class="field__optional">optional</span>}
      </label>
      <input id={id(k)} class="input" type={opts.type ?? 'text'} inputMode={opts.type === 'number' ? 'numeric' : undefined} value={f[k] as string}
        list={k === 'category' ? 'gf-categories' : undefined} aria-invalid={!!errors[k]} aria-describedby={errors[k] ? `${id(k)}-error` : undefined}
        onInput={e => set(k, e.currentTarget.value as never)} />
      {opts.hint && <p class="field__hint">{opts.hint}</p>}
      {errors[k] && <p id={`${id(k)}-error`} class="field__error">{errors[k]}</p>}
    </div>
  );

  return (
    <section class="card card--pad games-form" aria-label={mode === 'confirm' ? `Confirm ${f.title}` : mode === 'new' ? 'Add a game' : `Edit ${f.title}`}>
      <div class="section-head" style={{ marginBottom: 0 }}>
        <h3>{mode === 'confirm' ? `Confirm ${f.title || 'this title'}` : mode === 'new' ? 'Add a game' : `Edit ${f.title}`}</h3>
        <button type="button" class="btn btn--icon btn--text" onClick={() => onDone(false)} aria-label="Close the form">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <form class="games-form__grid" onSubmit={submit} noValidate>
        <datalist id="gf-categories">
          {categories.map(c => <option key={c} value={c} />)}
        </datalist>
        {field('title', 'Title', { wide: true })}
        {field('edition', 'Edition', { optional: true, hint: 'Only if it matters, e.g. “Europe” or “2nd edition”.' })}
        {field('category', 'Category', { hint: 'One main category, e.g. Strategy, Party, Co-operative.' })}
        <fieldset class={`field games-form__wide${errors.audiences ? ' field--error' : ''}`}>
          <legend>Who it's for</legend>
          <div class="cluster" style={{ '--gap': '6px' }}>
            {AUDIENCES.map(a => (
              <button key={a} type="button" class="filter" aria-pressed={f.audiences.includes(a)}
                onClick={() => set('audiences', f.audiences.includes(a) ? f.audiences.filter(x => x !== a) : [...f.audiences, a])}>
                {a}
              </button>
            ))}
          </div>
          {errors.audiences && <p class="field__error">{errors.audiences}</p>}
        </fieldset>
        {field('min_players', 'Fewest players', { type: 'number' })}
        {field('max_players', 'Most players', { type: 'number' })}
        {field('min_age', 'Minimum age', { type: 'number' })}
        {field('play_time_min', 'Shortest play (min)', { type: 'number', optional: true })}
        {field('play_time_max', 'Longest play (min)', { type: 'number' })}
        {field('copies', 'Copies', { type: 'number', optional: true, hint: 'Leave empty if not counted.' })}
        <div class={`field games-form__wide${errors.synopsis ? ' field--error' : ''}`}>
          <label for={id('synopsis')}>Synopsis</label>
          <textarea id={id('synopsis')} class="input" rows={3} maxLength={600} value={f.synopsis} aria-invalid={!!errors.synopsis}
            onInput={e => set('synopsis', e.currentTarget.value)} />
          <p class="field__hint">2 or 3 short sentences. Shown on the roll and the game's page.</p>
          {errors.synopsis && <p class="field__error">{errors.synopsis}</p>}
        </div>
        <fieldset class="field">
          <legend>In Roll Me a Game?</legend>
          <div class="segmented segmented--inline" role="group" aria-label="In Roll Me a Game">
            <button type="button" aria-pressed={f.available_for_chooser} onClick={() => set('available_for_chooser', true)}>Yes</button>
            <button type="button" aria-pressed={!f.available_for_chooser} onClick={() => set('available_for_chooser', false)}>No</button>
          </div>
        </fieldset>
        <fieldset class="field">
          <legend>Can be Game of the Week?</legend>
          <div class="segmented segmented--inline" role="group" aria-label="Can be Game of the Week">
            <button type="button" aria-pressed={f.available_for_gotw} onClick={() => set('available_for_gotw', true)}>Yes</button>
            <button type="button" aria-pressed={!f.available_for_gotw} onClick={() => set('available_for_gotw', false)}>No</button>
          </div>
        </fieldset>
        {mode !== 'edit' && (
          <div class={`field games-form__wide${errors.ownership_evidence ? ' field--error' : ''}`}>
            <label for={id('ownership_evidence')}>How do you know the café has it?</label>
            <input id={id('ownership_evidence')} class="input" value={f.ownership_evidence} maxLength={300} aria-invalid={!!errors.ownership_evidence}
              placeholder="e.g. On the shelf, checked 16 Oct" onInput={e => set('ownership_evidence', e.currentTarget.value)} />
            <p class="field__hint">Recorded with your name and the date.</p>
            {errors.ownership_evidence && <p class="field__error">{errors.ownership_evidence}</p>}
          </div>
        )}
        {mode === 'edit' && (
          <p class="meta games-form__wide">
            Confirmed by {str(i.confirmed_by)}: “{str(i.ownership_evidence)}”. Edits are kept even if the manifest is imported again.
          </p>
        )}
        <div class="cluster games-form__wide" style={{ '--gap': '8px' }}>
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {mode === 'confirm' ? <><BookCheck size={18} aria-hidden="true" /> Confirm we have it</> : 'Save'}
          </button>
          <button type="button" class="btn btn--text" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

// ---- Covers ----

function CoverForm({ game, onDone }: { game: AdminGame; onDone: (changed: boolean) => void }) {
  const [cover, setCover] = useState<{ cover: string; thumb: string } | null>(null);
  const [source, setSource] = useState(game.image_source_url ?? '');
  const [attribution, setAttribution] = useState(game.image_attribution ?? '');
  const [rights, setRights] = useState(game.image_rights_status === 'unknown' && !game.cover_image_id ? 'pending' : game.image_rights_status);
  const [matches, setMatches] = useState(game.image_status === 'verified');
  const [busy, setBusy] = useState(false);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const [c, t] = await Promise.all([resizeImage(file, 800), resizeImage(file, 320, 0.78)]);
    if (!c || !t) return toast("That image couldn't be read. Try a JPEG or PNG.");
    setCover({ cover: c, thumb: t });
  };
  const save = async () => {
    setBusy(true);
    const body = { rights_status: rights, matches_edition: matches };
    const res = cover
      ? await hostApi(`/api/staff/games/${game.game_id}/cover`, { ...cover, ...body, source_url: source, attribution })
      : await hostApi(`/api/staff/games/${game.game_id}/cover/status`, body);
    setBusy(false);
    if (res.ok) {
      toast('Cover saved.');
      onDone(true);
    } else toast(res.error);
  };
  const remove = async () => {
    if (!confirm(`Remove ${game.title}'s cover? The placeholder shows instead.`)) return;
    const res = await hostApi(`/api/staff/games/${game.game_id}/cover/remove`, {});
    toast(res.ok ? 'Cover removed.' : res.error);
    onDone(res.ok);
  };
  const preview = cover?.cover ?? (game.cover_image_id ? `/images/games/${game.cover_image_id}` : null);

  return (
    <section class="card card--pad games-form" aria-label={`Cover for ${game.title}`}>
      <div class="section-head" style={{ marginBottom: 0 }}>
        <h3>Cover for {game.title}{game.edition ? ` (${game.edition})` : ''}</h3>
        <button type="button" class="btn btn--icon btn--text" onClick={() => onDone(false)} aria-label="Close">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <p class="meta">
        Use the box of the café's own edition. It shows in the app only when it matches that edition and the right to use it is approved. Record where it came from either way.
      </p>
      <div class="games-cover">
        {preview ? <img src={preview} alt={`Box cover of ${game.title}`} width={160} height={160} /> : <div class="games-cover__empty">No cover</div>}
        <label class="btn btn--secondary btn--sm">
          <Upload size={16} aria-hidden="true" /> {preview ? 'Choose another image' : 'Choose an image'}
          <input type="file" accept="image/jpeg,image/png,image/webp" class="visually-hidden" onChange={e => pickFile(e.currentTarget.files?.[0])} />
        </label>
      </div>
      <div class="games-form__grid">
        <div class="field games-form__wide">
          <label for="gc-source">Where it came from</label>
          <input id="gc-source" class="input" type="url" value={source} disabled={!cover && !!game.cover_image_id} placeholder="https://publisher.example/game"
            onInput={e => setSource(e.currentTarget.value)} />
          <p class="field__hint">The page the image is on (a publisher's product page, say). Never a search result.</p>
        </div>
        <div class="field games-form__wide">
          <label for="gc-attr">Credit <span class="field__optional">optional</span></label>
          <input id="gc-attr" class="input" value={attribution} disabled={!cover && !!game.cover_image_id} placeholder="e.g. © Days of Wonder"
            onInput={e => setAttribution(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="gc-rights">Right to use it</label>
          <select id="gc-rights" class="input" value={rights} onChange={e => setRights(e.currentTarget.value)}>
            {RIGHTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <fieldset class="field">
          <legend>Matches the café's edition?</legend>
          <div class="segmented segmented--inline" role="group" aria-label="Matches the café's edition">
            <button type="button" aria-pressed={matches} onClick={() => setMatches(true)}>Yes</button>
            <button type="button" aria-pressed={!matches} onClick={() => setMatches(false)}>Not checked</button>
          </div>
        </fieldset>
        <div class="cluster games-form__wide" style={{ '--gap': '8px' }}>
          <button type="button" class="btn btn--primary" onClick={save} disabled={busy || (!cover && !game.cover_image_id)}>
            Save
          </button>
          {game.cover_image_id && (
            <button type="button" class="btn btn--text" onClick={remove} disabled={busy}>
              Remove cover
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- The review register ----

function Review({ categories, onChanged }: { categories: string[]; onChanged: () => void }) {
  const [entries, setEntries] = useState<ReviewEntry[] | null>(null);
  const [confirming, setConfirming] = useState<ReviewEntry | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ entries: ReviewEntry[] }>('/api/staff/game-review?status=open');
    if (res.ok) setEntries(res.data.entries);
  }, []);
  useEffect(() => void load(), [load]);
  const reject = async (e: ReviewEntry) => {
    const note = prompt(`Reject ${e.source_title}? Say why (optional), e.g. "Not ours".`);
    if (note === null) return;
    const res = await hostApi(`/api/staff/game-review/${e.review_id}/reject`, { note });
    toast(res.ok ? `${e.source_title} rejected.` : res.error);
    await load();
    onChanged();
  };

  if (!entries) return <DiceLoader label="Loading the review list..." />;
  return (
    <div class="stack" style={{ '--gap': '12px', marginTop: '12px' }}>
      <p class="meta">
        These titles come from the catalogue but aren't proven to be on the café's shelf. Confirm each one you can see on the shelf (it goes live with your note), or reject it.
      </p>
      {confirming && (
        <GameForm
          mode="confirm"
          reviewId={confirming.review_id}
          initial={confirming.entry}
          categories={categories}
          onDone={async changed => {
            setConfirming(null);
            if (changed) {
              await load();
              onChanged();
            }
          }}
        />
      )}
      {!entries.length && <p class="meta">Nothing waiting for review.</p>}
      <ul class="list" role="list">
        {entries.map(e => (
          <li key={e.review_id} class="card card--pad review-entry">
            <div class="cluster" style={{ justifyContent: 'space-between' }}>
              <strong>{e.source_title}</strong>
              <Chip kind={e.kind === 'uncertain' ? 'cancelled' : 'awaiting'}>{e.kind === 'uncertain' ? 'Uncertain' : 'Not yet checked'}</Chip>
            </div>
            {e.reasons.length > 0 && <p class="meta">{e.reasons.join(' · ')}</p>}
            {typeof e.entry.synopsis === 'string' && <p class="meta">{e.entry.synopsis}</p>}
            <div class="cluster" style={{ '--gap': '8px' }}>
              <button type="button" class="btn btn--secondary btn--sm" onClick={() => setConfirming(e)}>
                <BookCheck size={16} aria-hidden="true" /> Confirm we have it
              </button>
              <button type="button" class="btn btn--text btn--sm" onClick={() => reject(e)}>
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Import and going live ----

interface Plan {
  ok: boolean;
  applied: boolean;
  errors: string[];
  counts: Record<string, number>;
  add: { title: string; edition: string | null }[];
  update: { title: string; changed: string[] }[];
  not_in_manifest: { title: string }[];
}

function Import({ data, onChanged, onLive }: { data: Admin; onChanged: () => void; onLive: (on: boolean) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [retire, setRetire] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (mode: 'dry_run' | 'apply') => {
    if (mode === 'apply' && !confirm(`Apply the import? ${plan?.counts.add ?? 0} added, ${plan?.counts.update ?? 0} updated${retire ? `, ${plan?.counts.not_in_manifest ?? 0} retired` : ''}. It's one transaction.`)) return;
    setBusy(true);
    const res = await hostApi<Plan>('/api/staff/games/import', { mode, retire_missing: retire, confirm: mode === 'apply' ? 'apply' : undefined });
    setBusy(false);
    if (res.ok) {
      setPlan(res.data);
      if (mode === 'apply') {
        toast('Import applied.');
        onChanged();
      }
    } else toast(res.error);
  };
  const m = data.manifest;
  return (
    <div class="stack" style={{ '--gap': '14px', marginTop: '12px' }}>
      <div class="card card--pad stack" style={{ '--gap': '8px' }}>
        <h3>The manifest</h3>
        <p class="meta">
          {m.status === 'awaiting-source'
            ? 'Waiting for the source catalogue: there is nothing to import yet.'
            : `${m.games} confirmed games and ${m.review} titles for review, from the source catalogue.`}
        </p>
        <label class="cluster" style={{ '--gap': '8px' }}>
          <input type="checkbox" checked={retire} onChange={e => setRetire(e.currentTarget.checked)} />
          Retire imported games that are no longer in the manifest
        </label>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <button type="button" class="btn btn--secondary" onClick={() => run('dry_run')} disabled={busy}>
            Dry run
          </button>
          <button type="button" class="btn btn--primary" onClick={() => run('apply')} disabled={busy || !plan || !plan.ok || plan.applied}>
            Apply import
          </button>
        </div>
        {plan && <PlanReport plan={plan} />}
      </div>
      <div class="card card--pad stack" style={{ '--gap': '8px' }}>
        <h3>Put the library live</h3>
        <p class="meta">
          {data.live
            ? 'The app shows the café’s confirmed games. Going back shows the preview shelf again; nothing is deleted.'
            : `The app shows the preview shelf. Going live swaps Roll Me a Game, the Games page and Game of the Week to the ${data.games.filter(g => !g.retired_at).length} confirmed games.`}
        </p>
        <div>
          <button type="button" class={`btn ${data.live ? 'btn--text' : 'btn--primary'}`} onClick={() => onLive(!data.live)}>
            {data.live ? 'Back to the preview shelf' : 'Put the library live'}
          </button>
        </div>
      </div>
      {data.imports.length > 0 && (
        <details class="card card--pad">
          <summary>Recent imports</summary>
          <ul class="meta" style={{ marginTop: '8px' }}>
            {data.imports.map(b => (
              <li key={b.batch_id}>
                {new Date(b.created_at).toLocaleString('en-GB')} · {b.mode === 'apply' ? 'Applied' : 'Dry run'} by {b.created_by}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PlanReport({ plan }: { plan: Plan }) {
  const c = plan.counts;
  return (
    <div class="stack" style={{ '--gap': '6px' }} role="status">
      <p>
        <strong>{plan.applied ? 'Applied:' : plan.ok ? 'Dry run:' : 'Can’t be applied:'}</strong> {c.add} to add, {c.update} to update, {c.kept_admin_edits} kept as edited,{' '}
        {c.not_in_manifest} no longer in the manifest, {c.review_add} new for review.
      </p>
      {plan.errors.length > 0 && (
        <ul class="field__error">
          {plan.errors.slice(0, 20).map(e => <li key={e}>{e}</li>)}
        </ul>
      )}
      {plan.add.length > 0 && <p class="meta">Adds: {plan.add.map(a => (a.edition ? `${a.title} (${a.edition})` : a.title)).join(', ')}</p>}
      {plan.update.length > 0 && <p class="meta">Updates: {plan.update.map(u => `${u.title} (${u.changed.join(', ')})`).join('; ')}</p>}
      {plan.not_in_manifest.length > 0 && <p class="meta">Not in the manifest: {plan.not_in_manifest.map(g => g.title).join(', ')}</p>}
    </div>
  );
}
