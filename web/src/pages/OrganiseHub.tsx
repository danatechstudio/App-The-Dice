// The organiser's front page for approvers and admins: a card per section with
// what's waiting in it. Sections with something waiting come first.

import { ChevronRight, RotateCcw } from 'lucide-preact';
import { useStaffSummary } from '../lib/staffSummary';
import { PushCard } from './OrganisePush';
import { SECTIONS, waitingLine, type SectionDef } from './OrganiseSection';

export function OrganiseHub({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, reload } = useStaffSummary();
  const mine = SECTIONS.filter(s => isAdmin || !s.adminOnly);
  const count = (s: SectionDef) => data?.sections[s.key]?.count ?? 0;
  const ordered = [...mine.filter(s => count(s) > 0), ...mine.filter(s => count(s) === 0)];

  return (
    <div class="organiser-hub" data-surface="staff">
      <PushCard />
      {error && (
        <div class="notice notice--info organiser-hub__error" role="status">
          <p>Couldn't load what's waiting.</p>
          <button type="button" class="btn btn--secondary btn--sm" onClick={reload}>
            <RotateCcw size={16} aria-hidden="true" /> Try again
          </button>
        </div>
      )}
      <nav class="organiser-hub__grid" aria-label="Organiser sections">
        {ordered.map(s => (
          <HubCard key={s.key} def={s} summary={data?.sections[s.key]} loading={!data && !error} />
        ))}
      </nav>
    </div>
  );
}

function HubCard({ def, summary, loading }: { def: SectionDef; summary?: { count: number; parts?: Record<string, number>; info?: Record<string, number> }; loading: boolean }) {
  const count = summary?.count ?? 0;
  const booked = summary?.info?.booked_dates_7_days;
  const line = count > 0 ? waitingLine(def, summary?.parts) : booked ? `${booked} booked ${booked === 1 ? 'date' : 'dates'} this week` : 'All clear';
  return (
    <a class={`card hub-card${count > 0 ? ' hub-card--waiting' : ''}`} href={`/organise/${def.key}`}>
      <span class="hub-card__top">
        <span class="hub-card__title">{def.title}</span>
        {loading ? <span class="hub-card__count hub-card__count--loading" aria-hidden="true" /> : count > 0 && <span class="hub-card__count">{count}</span>}
        <ChevronRight size={20} aria-hidden="true" class="hub-card__chevron" />
      </span>
      {!loading && <span class={`hub-card__line${count > 0 ? '' : ' meta'}`}>{line}</span>}
      <span class="hub-card__blurb meta">{def.blurb}</span>
    </a>
  );
}
