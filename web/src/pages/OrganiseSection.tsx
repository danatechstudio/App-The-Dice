// One section of the organiser for approvers and admins (/organise/<section>):
// a header back to the hub, and that section's panels, unchanged. The hub's
// cards and these pages both come from SECTIONS.

import { ArrowLeft } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { DiceLoader } from '../components/States';
import { hostApi, type HostRecord, type HostSession, type HostUser } from '../lib/hostApi';
import type { StaffMarket } from '../lib/markets';
import { useStaffSummary, type SectionKey } from '../lib/staffSummary';
import { useTitle } from '../lib/title';
import { HostsPanel, ReviewCard } from './Organise';
import { AttentionPanel } from './OrganiseAttention';
import { ChangesPanel } from './OrganiseChanges';
import { DatesPanel } from './OrganiseDateEditor';
import { HostedDatesPanel } from './OrganiseDates';
import { DeliveryPanel } from './OrganiseDelivery';
import { GamesAdmin } from './OrganiseGames';
import { MarketApplicationsPanel, MarketsAdmin } from './OrganiseMarkets';
import { MenuAdmin } from './OrganiseMenu';
import { AllEventsPanel } from './OrganiseEvents';
import { EventPlacesPanel } from './OrganisePlaces';
import { RemindersAdmin } from './OrganiseReminders';
import { SheetSyncPanel } from './OrganiseSheetSync';
import { SocialPanel } from './OrganiseSocial';
import { StatsAdmin } from './OrganiseStats';
import { ApproversPanel, JoinRequests } from './OrganiseTeam';

export interface SectionDef {
  key: SectionKey;
  title: string;
  /** What's in it, shown on the hub's card. */
  blurb: string;
  adminOnly: boolean;
  /** How each waiting part reads on the hub: [one, more than one]. */
  partLabels: Record<string, [string, string]>;
}

export const SECTIONS: SectionDef[] = [
  {
    key: 'approve',
    title: 'To approve',
    blurb: 'Join requests, sessions, hosts’ changes and market applications',
    adminOnly: false,
    partLabels: {
      join_requests: ['join request', 'join requests'],
      sessions: ['session', 'sessions'],
      changes: ['change', 'changes'],
      market_applications: ['market application', 'market applications'],
    },
  },
  {
    key: 'attention',
    title: 'Needs attention',
    blurb: 'Events that need a decision, and emails that didn’t send',
    adminOnly: false,
    partLabels: { open_items: ['event', 'events'], failed_deliveries: ['email not sent', 'emails not sent'] },
  },
  {
    key: 'events',
    title: 'Events & dates',
    blurb: 'Every event: change, cancel or stop it; dates, booking and places',
    adminOnly: false,
    partLabels: {
      sheet_edit_problems: ['Logic Engine change stuck', 'Logic Engine changes stuck'],
    },
  },
  {
    key: 'social',
    title: 'Social posts',
    blurb: 'Event prompts to approve, with an example post for each, and held posts',
    adminOnly: true,
    partLabels: {
      social_prompts: ['prompt to review', 'prompts to review'],
      facts_undecided: ['event with facts to decide', 'events with facts to decide'],
      social_held: ['post held this week', 'posts held this week'],
    },
  },
  { key: 'bookings', title: 'Bookings', blurb: 'Booked dates coming up', adminOnly: false, partLabels: {} },
  { key: 'people', title: 'People', blurb: 'Hosts and approvers', adminOnly: false, partLabels: {} },
  {
    key: 'content',
    title: 'Café content',
    blurb: 'Food & drinks menu, game library, markets and event reminders',
    adminOnly: true,
    partLabels: { menu_sheet_problem: ['menu sheet problem', 'menu sheet problems'], games_to_review: ['game to review', 'games to review'] },
  },
  { key: 'stats', title: 'Stats', blurb: 'How the app is used', adminOnly: true, partLabels: {} },
];

export const sectionDef = (key: string | undefined) => SECTIONS.find(s => s.key === key);

/** "2 join requests · 1 session": the waiting parts, in words. */
export function waitingLine(def: SectionDef, parts: Record<string, number> | undefined): string {
  return Object.entries(parts ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${(def.partLabels[k] ?? [k, k])[n === 1 ? 0 : 1]}`)
    .join(' · ');
}

/** Scroll to the panel a link names (#awaiting), once it has loaded: every 250ms, for up to 5 seconds. */
function useHashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries >= 20) clearInterval(timer);
      el?.scrollIntoView({ block: 'start' });
    }, 250);
    return () => clearInterval(timer);
  }, []);
}

export function OrganiseSection({ def, me, isAdmin, onDecided }: { def: SectionDef; me: HostUser; isAdmin: boolean; onDecided: () => void }) {
  useTitle(def.title);
  useHashScroll();
  const { data } = useStaffSummary();
  const count = data?.sections[def.key]?.count ?? 0;

  return (
    <div class="container organiser" data-surface="staff">
      <header class="page-head organiser-section__head">
        <a class="btn btn--text btn--sm organiser-section__back" href="/organise">
          <ArrowLeft size={16} aria-hidden="true" /> Organiser
        </a>
        <h1>
          {def.title} {count > 0 && <span class="count-badge">{count}</span>}
        </h1>
      </header>
      {def.adminOnly && !isAdmin ? (
        <div class="card card--pad stack" style={{ '--gap': '12px' }}>
          <p>This section is for admins.</p>
          <p>
            <a href="/organise">Back to the organiser</a>
          </p>
        </div>
      ) : (
        <div class="staff-section">
          <SectionPanels section={def.key} me={me} isAdmin={isAdmin} onDecided={onDecided} />
        </div>
      )}
    </div>
  );
}

function SectionPanels({ section, me, isAdmin, onDecided }: { section: SectionKey; me: HostUser; isAdmin: boolean; onDecided: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh(n => n + 1);
  switch (section) {
    case 'approve':
      return <ApprovePanels onDecided={onDecided} refresh={refresh} />;
    case 'attention':
      return (
        <>
          <AttentionPanel isAdmin={isAdmin} />
          <DeliveryPanel />
        </>
      );
    case 'events':
      return (
        <>
          {isAdmin && <AllEventsPanel />}
          <DatesPanel />
          <EventPlacesPanel refresh={refresh} />
          {isAdmin && <SheetSyncPanel />}
        </>
      );
    case 'social':
      return <SocialPanel />;
    case 'bookings':
      return <HostedDatesPanel refresh={refresh} />;
    case 'people':
      return <PeoplePanels me={me} isAdmin={isAdmin} refresh={refresh} onChanged={bump} />;
    case 'content':
      return <ContentPanels />;
    case 'stats':
      return <StatsAdmin />;
  }
}

function ApprovePanels({ onDecided, refresh }: { onDecided: () => void; refresh: number }) {
  const [pending, setPending] = useState<HostSession[] | null>(null);
  const [markets, setMarkets] = useState<StaffMarket[] | null>(null);
  const load = useCallback(async () => {
    const [p, m] = await Promise.all([
      hostApi<{ sessions: HostSession[] }>('/api/staff/host-sessions?status=submitted'),
      hostApi<{ markets: StaffMarket[] }>('/api/staff/markets'),
    ]);
    if (p.ok) setPending(p.data.sessions.slice().reverse());
    if (m.ok) setMarkets(m.data.markets);
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <JoinRequests onDecided={load} />
      <section class="section" aria-labelledby="awaiting">
        <div class="section-head">
          <h2 id="awaiting">Sessions awaiting approval {pending && pending.length > 0 && <span class="count-badge">{pending.length}</span>}</h2>
        </div>
        {pending === null && <DiceLoader label="Loading submissions..." />}
        {pending && !pending.length && <p class="meta">Nothing waiting. New submissions from hosts appear here.</p>}
        <div class="list">
          {pending?.map(s => (
            <ReviewCard
              key={s.session_id}
              s={s}
              onDone={() => {
                load();
                onDecided();
              }}
            />
          ))}
        </div>
      </section>
      <ChangesPanel />
      <MarketApplicationsPanel markets={markets} refresh={refresh} onChanged={load} />
    </>
  );
}

function PeoplePanels({ me, isAdmin, refresh, onChanged }: { me: HostUser; isAdmin: boolean; refresh: number; onChanged: () => void }) {
  const [hosts, setHosts] = useState<HostRecord[] | null>(null);
  const load = useCallback(async () => {
    const h = await hostApi<{ hosts: HostRecord[] }>('/api/staff/hosts');
    if (h.ok) setHosts(h.data.hosts);
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <>
      <HostsPanel hosts={hosts} isAdmin={isAdmin} onChanged={() => (load(), onChanged())} />
      {isAdmin && <ApproversPanel me={me} refresh={refresh} />}
    </>
  );
}

function ContentPanels() {
  const [markets, setMarkets] = useState<StaffMarket[] | null>(null);
  const load = useCallback(async () => {
    const m = await hostApi<{ markets: StaffMarket[] }>('/api/staff/markets');
    if (m.ok) setMarkets(m.data.markets);
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <>
      <MenuAdmin />
      <GamesAdmin />
      <MarketsAdmin markets={markets} onChanged={load} />
      <RemindersAdmin />
    </>
  );
}
