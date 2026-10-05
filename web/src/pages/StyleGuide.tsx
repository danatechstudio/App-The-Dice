import {
  Bell, CalendarDays, CalendarPlus, Check, ChessKnight, ClipboardCheck, Dices, Gauge, LayoutDashboard, Plus, ScrollText,
  Settings, Ticket, Trash2, UserPlus, UsersRound,
} from 'lucide-preact';
import { Capacity, Stepper } from '../components/Booking';
import { DiceMark, Logo } from '../components/Brand';
import { Chip, type ChipKind } from '../components/Chips';
import { DiceTray, type DiceTrayHandle } from '../components/Dice';
import { EventCard, EventTicket } from '../components/EventCard';
import { DiceLoader, EmptyState, ErrorState, StaffError } from '../components/States';
import type { Occurrence } from '../lib/api';
import { addDays, todayLondon } from '../lib/dates';
import { useTitle } from '../lib/title';
import { colours, theme } from '../theme';
import { contrast } from '../theme/contrast';
import { useRef } from 'preact/hooks';

const sample = (over: Partial<Occurrence>): Occurrence => ({
  occurrence_id: 'RTD-OCC-00000-20260101',
  event_id: 'RTD-EVT-00000',
  name: 'Quiz Night',
  category: 'Quiz',
  description: 'A family quiz night with prizes at stake!',
  date: todayLondon(),
  start_time: '18:30',
  end_time: '22:00',
  starts_at: null,
  ends_at: null,
  all_day: false,
  projected: false,
  status: 'scheduled',
  rescheduled_to: null,
  visibility: 'public',
  image: null,
  price_display: null,
  ...over,
});

const CUSTOMER_CHIPS: [ChipKind, string][] = [
  ['today', 'Today'], ['tonight', 'Tonight'], ['booking-open', 'Booking open'], ['nearly-full', 'Nearly full'],
  ['full', 'Full'], ['free', 'Free'], ['new', 'New'], ['cancelled', 'Cancelled'],
];
const HOST_CHIPS: [ChipKind, string][] = [
  ['draft', 'Draft'], ['awaiting', 'Awaiting approval'], ['approved', 'Approved'], ['live', 'Live'],
  ['full', 'Full'], ['completed', 'Completed'], ['cancelled', 'Cancelled'],
];

const kebab = (s: string) => s.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);

/** /styleguide: every token and component, for design review and testing. */
export function StyleGuide() {
  useTitle('Style guide');
  const tray = useRef<DiceTrayHandle>(null);
  const today = todayLondon();
  // Example cards are not real events: stop their links going anywhere.
  const inert = (e: Event) => (e.target as Element).closest('a[href^="/event/"]') && e.preventDefault();

  return (
    <div class="container" onClickCapture={inert}>
      <header class="page-head">
        <p class="label">Design system</p>
        <h1>RTD style guide</h1>
        <p class="meta" style={{ marginTop: '8px' }}>
          Live components and tokens from <code>web/src/theme</code>. Example data only. Documented in docs/RTD_APP_THEME.md.
        </p>
      </header>

      <section class="sg-section">
        <h2>Brand</h2>
        <div class="sg-grid sg-grid--wide">
          <div class="sg-navy tone-navy">
            <Logo />
          </div>
          <div class="sg-navy tone-navy" style={{ display: 'grid', placeItems: 'center' }}>
            <DiceMark class="" alt="Dice mark" />
          </div>
        </div>
        <p class="meta" style={{ marginTop: '8px' }}>The logo always sits on brand navy, as in the reference. The dice mark is for small places.</p>
      </section>

      <section class="sg-section">
        <h2>Colour</h2>
        <div class="sg-grid">
          {Object.entries(colours).map(([name, hex]) => {
            const onWhite = contrast(hex, '#FFFFFF');
            const ink = onWhite >= 4.5 ? '#FFFFFF' : colours.text;
            return (
              <div class="swatch" key={name}>
                <div class="swatch__chip" style={{ background: hex, color: ink }}>
                  Aa {contrast(hex, ink)}
                </div>
                <div class="swatch__info">
                  <strong>{name}</strong>
                  <br />
                  <code>--rtd-{kebab(name)}</code>
                  <br />
                  <code>{hex}</code>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section class="sg-section">
        <h2>Type</h2>
        <div class="stack">
          <p class="hero">Hero · Arvo 700</p>
          <p class="display" style={{ fontSize: 'var(--rtd-size-h1)' }}>Heading 1 · Arvo 700</p>
          <p class="display" style={{ fontSize: 'var(--rtd-size-h2)' }}>Heading 2 · Arvo 700</p>
          <h3>Heading 3 · Figtree 600</h3>
          <p>Body · Figtree 400. Board games, a proper cup of tea and something on every week.</p>
          <p class="label">Label · Figtree 600 caps</p>
          <p class="meta">Metadata · Figtree 400, muted</p>
        </div>
      </section>

      <section class="sg-section">
        <h2>Spacing, radii, shadows</h2>
        <div class="stack" style={{ '--gap': '6px' }}>
          {Object.entries(theme.spacing).map(([k, v]) => (
            <div class="sg-space" key={k}>
              <span style={{ width: v }} />
              <code>--rtd-space-{k}</code> {v}
            </div>
          ))}
        </div>
        <div class="sg-grid" style={{ marginTop: '24px' }}>
          {Object.entries(theme.radii).filter(([k]) => k !== 'round').map(([k, v]) => (
            <div class="sg-box" key={k} style={{ borderRadius: v }}>radius {k} · {v}</div>
          ))}
          {Object.keys(theme.shadows).filter(k => k !== 'inset' && k !== 'sticker').map(k => (
            <div class="sg-box" key={k} style={{ borderRadius: 'var(--rtd-radius-card)', boxShadow: `var(--rtd-shadow-${k})`, border: 0 }}>shadow {k}</div>
          ))}
        </div>
      </section>

      <section class="sg-section">
        <h2>Buttons</h2>
        <div class="cluster" style={{ '--gap': '12px' }}>
          <button class="btn btn--primary" type="button"><Ticket size={18} aria-hidden="true" /> Book</button>
          <button class="btn btn--secondary" type="button">View</button>
          <button class="btn btn--roll" type="button"><Dices class="wiggle" size={20} aria-hidden="true" /> Roll Me a Game</button>
          <button class="btn btn--destructive" type="button"><Trash2 size={18} aria-hidden="true" /> Cancel booking</button>
          <button class="btn btn--destructive-quiet" type="button">Remove</button>
          <button class="btn btn--text" type="button">Text button</button>
          <button class="btn btn--primary" type="button" disabled>Disabled</button>
        </div>
        <div class="sg-navy tone-navy cluster" style={{ '--gap': '12px', marginTop: '16px' }}>
          <button class="btn btn--inverse" type="button">View Event</button>
          <button class="btn btn--outline-inverse" type="button">Narrow it down</button>
          <button class="btn btn--chaos" type="button"><Dices class="wiggle" size={20} aria-hidden="true" /> Chaos Roll</button>
        </div>
      </section>

      <section class="sg-section">
        <h2>Status chips</h2>
        <p class="label" style={{ marginBottom: '8px' }}>Customer</p>
        <div class="cluster">{CUSTOMER_CHIPS.map(([k, l]) => <Chip key={k} kind={k}>{l}</Chip>)}</div>
        <p class="label" style={{ margin: '16px 0 8px' }}>Host and staff</p>
        <div class="cluster">{HOST_CHIPS.map(([k, l]) => <Chip key={k} kind={k}>{l}</Chip>)}</div>
        <p class="label" style={{ margin: '16px 0 8px' }}>Filters</p>
        <div class="cluster">
          <button class="filter" type="button" aria-pressed="true">Gaming</button>
          <button class="filter" type="button" aria-pressed="false">Quiz</button>
          <button class="filter" type="button" aria-pressed="false">Club</button>
        </div>
      </section>

      <section class="sg-section">
        <h2>Event cards</h2>
        <div class="stack" style={{ '--gap': '16px' }}>
          <EventCard o={sample({})} feature today={today} />
          <div class="sg-grid sg-grid--wide">
            <EventCard o={sample({ name: 'Blood on the Clocktower', category: 'Gaming', date: addDays(today, 3), start_time: '11:00', end_time: '21:00', description: 'A mysterious game of deception', price_display: 'Free' })} today={today} />
            <EventCard o={sample({ name: 'Spooky Market', category: 'Market', date: addDays(today, 9), start_time: '10:00', end_time: '17:00', description: 'An autumnal Halloween market full of local traders' })} today={today} />
          </div>
          <EventTicket o={sample({ name: 'Kids Chess Club', category: 'Club', date: addDays(today, 1), start_time: '18:00', end_time: '19:00', description: 'Childrens chess club & tournament' })} today={today} />
          <EventTicket o={sample({ name: 'Arkham Horror Card Game', category: 'Club', start_time: null, end_time: null, date: addDays(today, 2), description: 'Tracking down the twin suns of a mysterious realm' })} today={today} />
          <EventTicket o={sample({ name: 'Bingo', category: 'Social', status: 'cancelled', date: addDays(today, 4), description: 'A family bingo night with prizes to win' })} today={today} />
        </div>
      </section>

      <section class="sg-section">
        <h2>Booking</h2>
        <div class="sg-grid sg-grid--wide">
          <div class="card card--pad stack">
            <Stepper current={2} />
            <Capacity booked={8} capacity={12} />
            <Capacity booked={10} capacity={12} />
            <Capacity booked={12} capacity={12} />
          </div>
          <div class="card confirm">
            <span class="confirm__tick"><Check size={34} strokeWidth={3} aria-hidden="true" /></span>
            <p class="hero">You're in</p>
            <p class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>D&D One Shot</p>
            <p><strong>Saturday · 7 PM</strong></p>
            <p class="meta">4 places reserved. We'll remind you before the game.</p>
            <button class="btn btn--primary" type="button"><CalendarPlus size={18} aria-hidden="true" /> Add to calendar</button>
            <button class="btn btn--text" type="button">Back to RTD</button>
          </div>
          <div class="card waitlist">
            <Chip kind="full">Full</Chip>
            <p class="display" style={{ fontSize: 'var(--rtd-size-h2)' }}>This session is full</p>
            <p>Want us to tell you if enough spaces become available?</p>
            <p><strong>You need: 3 spaces</strong></p>
            <button class="btn btn--primary" type="button"><Bell size={18} aria-hidden="true" /> Join waiting list</button>
            <p class="meta">Joining doesn't guarantee a place. We'll email you if one opens up.</p>
          </div>
        </div>
      </section>

      <section class="sg-section">
        <h2>Loading, empty and error</h2>
        <div class="sg-grid sg-grid--wide">
          <div class="card"><DiceLoader label="Finding your game..." /></div>
          <div class="card"><EmptyState title="No players booked yet." text="Share the event to get the table filling." /></div>
          <div class="card"><ErrorState onRetry={() => undefined} /></div>
          <div class="card card--pad" data-surface="staff">
            <StaffError status={409} message="Sync refused: 0 rows (previous 31). Data left untouched." action="Check the Logic Engine sheet is readable, then re-run RTD Event Sync." />
          </div>
        </div>
      </section>

      <section class="sg-section">
        <h2>Motion: the dice</h2>
        <div style={{ maxWidth: '520px' }} class="stack">
          <DiceTray ref={tray} />
          <button class="btn btn--roll" type="button" onClick={() => tray.current?.roll()}>
            <Dices class="wiggle" size={20} aria-hidden="true" /> Roll ({theme.durations.dice})
          </button>
          <p class="meta">
            fast {theme.durations.fast} · normal {theme.durations.normal} · feature {theme.durations.feature} · dice {theme.durations.dice}. All collapse to instant with reduced motion.
          </p>
        </div>
      </section>

      <section class="sg-section" data-surface="host">
        <h2>Host portal · RTD backstage</h2>
        <div class="host-dash">
          <div>
            <p class="label" style={{ color: 'var(--rtd-host)' }}>Host dashboard</p>
            <p class="display" style={{ fontSize: 'var(--rtd-size-h2)' }}>Welcome back, Sam</p>
          </div>
          <div class="card host-dash__next">
            <p class="label">Next session</p>
            <p class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>D&D One Shot</p>
            <p class="meta"><strong>Saturday · 7 PM</strong></p>
            <Capacity booked={6} capacity={8} />
            <button class="btn btn--primary" type="button"><UsersRound size={18} aria-hidden="true" /> View bookings</button>
          </div>
          <div class="cluster" style={{ justifyContent: 'space-between' }}>
            <p class="label">Your events</p>
            <button class="btn btn--secondary btn--sm" type="button"><Plus size={16} aria-hidden="true" /> Create session</button>
          </div>
          {([['D&D One Shot', 'Sat 24 Oct · 7 PM', '6 / 8 players', 'live'], ['Learn Wingspan', 'Thu 5 Nov · 6:30 PM', '0 / 5 players', 'awaiting'], ['Catan Club', 'Draft', 'No date yet', 'draft']] as const).map(([n, d, c, s]) => (
            <div class="card host-event" key={n}>
              <div>
                <h3>{n}</h3>
                <p class="meta">{d} · {c}</p>
              </div>
              <Chip kind={s}>{HOST_CHIPS.find(([k]) => k === s)?.[1]}</Chip>
            </div>
          ))}
        </div>
      </section>

      <section class="sg-section" data-surface="staff">
        <h2>Staff control</h2>
        <div class="staff">
          <nav class="staff__side" aria-label="Staff example">
            <div class="staff__brand"><DiceMark /> RTD CONTROL</div>
            {([['Dashboard', LayoutDashboard], ['Events', CalendarDays], ['Bookings', Ticket], ['Hosts', ChessKnight], ['Applications', UserPlus], ['Approvals', ClipboardCheck], ['Games', Dices], ['Notifications', Bell], ['Audit', ScrollText], ['Settings', Settings]] as const).map(([label, Icon], i) => (
              <a key={label} href="#" aria-current={i === 0 ? 'page' : undefined} onClick={e => e.preventDefault()}>
                <Icon size={18} aria-hidden="true" /> {label}
              </a>
            ))}
          </nav>
          <div class="staff__main">
            <h3 style={{ fontSize: 'var(--rtd-size-h2)', fontWeight: 700 }}>Dashboard</h3>
            <div class="stat-grid">
              <div class="stat"><p class="label">Today</p><p class="stat__value">4</p><p class="meta">events</p></div>
              <div class="stat"><p class="label">New bookings</p><p class="stat__value">17</p><p class="meta">since yesterday</p></div>
              <div class="stat"><p class="label">Waitlist</p><p class="stat__value">5</p><p class="meta">people</p></div>
              <div class="stat stat--attention"><p class="label">Host approvals</p><p class="stat__value">2</p><p class="meta">need a decision</p></div>
            </div>
            <p class="label">Recent bookings</p>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Event</th><th>Date</th><th>Name</th><th class="num">Places</th><th>Status</th></tr></thead>
                <tbody>
                  <tr><td>Quiz Night</td><td>Fri 23 Oct</td><td>A. Example</td><td class="num">4</td><td><Chip kind="booking-open">Confirmed</Chip></td></tr>
                  <tr><td>D&D One Shot</td><td>Sat 24 Oct</td><td>B. Example</td><td class="num">2</td><td><Chip kind="awaiting">Waitlist</Chip></td></tr>
                  <tr><td>Bingo</td><td>Fri 9 Oct</td><td>C. Example</td><td class="num">3</td><td><Chip kind="cancelled">Cancelled</Chip></td></tr>
                </tbody>
              </table>
            </div>
            <p class="meta"><Gauge size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-2px' }} /> Staff surface: no texture, interface headings, colour only for state.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
