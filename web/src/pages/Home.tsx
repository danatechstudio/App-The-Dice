import { ArrowRight, ChevronRight, Dices, Star, Ticket } from 'lucide-preact';
import { DiceMark, Logo } from '../components/Brand';
import { Chip } from '../components/Chips';
import { EventCard } from '../components/EventCard';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import { PREVIEW_GAMES, PREVIEW_GAME_OF_THE_WEEK, minutesLabel, playersLabel } from '../data/preview-games';
import { addDays } from '../lib/dates';
import { firstPerEvent, notOver, useUpcoming } from '../lib/events';
import { useTitle } from '../lib/title';

export function Home() {
  useTitle(null);
  const { occurrences, error, loading, reload, today } = useUpcoming();
  const upcoming = (occurrences ?? []).filter(o => notOver(o, today));
  const tonight = upcoming.filter(o => o.date === today);
  // Lead with tonight; otherwise the next event that has a time (a proper event,
  // rather than a regular room booking).
  const feature = tonight.find(o => o.start_time) ?? tonight[0] ?? upcoming.find(o => o.start_time) ?? upcoming[0];
  const comingUp = firstPerEvent(upcoming.filter(o => o.date <= addDays(today, 14)), feature ? [feature] : []).slice(0, 8);
  const heading = tonight.length ? 'Tonight at Roll The Dice' : 'Next up at Roll The Dice';

  return (
    <>
      <section class="home-hero tone-navy" aria-label="Roll The Dice">
        <div class="container">
          <h1 class="visually-hidden">Roll The Dice Board Game Café</h1>
          <Logo class="home-hero__logo" eager />
          <p class="home-hero__tag label">
            Games <strong>·</strong> Community <strong>·</strong> Events
          </p>
        </div>
      </section>

      <div class="container home-grid">
        <div>
          <section class="home-tonight" aria-labelledby="tonight">
            <div class="section-head">
              <h2 id="tonight">{heading}</h2>
            </div>
            {loading && !occurrences && <div class="card"><DiceLoader /></div>}
            {error && !occurrences && <div class="card"><ErrorState error={error} onRetry={reload} /></div>}
            {occurrences && !feature && (
              <div class="card">
                <EmptyState title="Nothing on the table yet." text="Check back soon for more events." />
              </div>
            )}
            {feature && <EventCard o={feature} feature today={today} />}
          </section>

          {comingUp.length > 0 && (
            <section class="section" aria-labelledby="coming-up">
              <div class="section-head">
                <h2 id="coming-up">Coming Up</h2>
                <a href="/diary">
                  Full diary <ChevronRight size={18} aria-hidden="true" />
                </a>
              </div>
              <div class="rail" role="list">
                {comingUp.map(o => (
                  <div role="listitem" key={o.occurrence_id}>
                    <EventCard o={o} today={today} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside class="home-side" aria-label="More from Roll The Dice">
          <RollPromo />
          <GameOfTheWeekMini />
          <BookPromo />
        </aside>
      </div>
    </>
  );
}

function RollPromo() {
  return (
    <section class="section card card--navy card--feature promo" aria-labelledby="roll-promo">
      <p class="label">Can't decide?</p>
      <div class="promo__dice">
        <DiceMark />
      </div>
      <h2 id="roll-promo" class="display">
        Roll Me a Game
      </h2>
      <p>Tell us how many are playing and how long you've got. The dice do the rest.</p>
      <a class="btn btn--roll btn--lg btn--block" href="/roll">
        <Dices class="wiggle" size={22} aria-hidden="true" /> Roll Me a Game
      </a>
    </section>
  );
}

function GameOfTheWeekMini() {
  const game = PREVIEW_GAMES.find(g => g.id === PREVIEW_GAME_OF_THE_WEEK)!;
  return (
    <section class="section card promo" aria-labelledby="gotw-mini">
      <div class="cluster" style={{ justifyContent: 'space-between' }}>
        <p class="label stars">
          <Star size={14} aria-hidden="true" /> Game of the Week <Star size={14} aria-hidden="true" />
        </p>
        <Chip kind="preview">Preview</Chip>
      </div>
      <h2 id="gotw-mini" class="gotw-mini__title">
        {game.name}
      </h2>
      <p class="meta">
        {game.tagline} · {playersLabel(game)} · {minutesLabel(game)}
      </p>
      <a class="btn btn--secondary" href="/games">
        View game <ArrowRight size={18} aria-hidden="true" />
      </a>
    </section>
  );
}

function BookPromo() {
  return (
    <section class="section card promo" aria-labelledby="book-promo">
      <p class="label">Book a session</p>
      <h2 id="book-promo" class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>
        Save your seat at the table
      </h2>
      <p class="meta">Online booking is on its way. Until then, book with the café team as usual.</p>
      <a class="btn btn--secondary" href="/book">
        <Ticket size={18} aria-hidden="true" /> Booking & hosting
      </a>
    </section>
  );
}
