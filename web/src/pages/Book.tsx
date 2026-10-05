import { ArrowRight, ChessKnight, Ticket } from 'lucide-preact';
import { EventTicket } from '../components/EventCard';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import { firstPerEvent, notOver, useUpcoming } from '../lib/events';
import { useTitle } from '../lib/title';

export function Book() {
  useTitle('Book a session');
  const { occurrences, error, loading, reload, today } = useUpcoming();
  const timed = firstPerEvent((occurrences ?? []).filter(o => notOver(o, today) && o.start_time)).slice(0, 6);
  return (
    <div class="container">
      <header class="page-head">
        <p class="label">Book</p>
        <h1>Book a session</h1>
      </header>

      <div class="notice notice--info">
        <Ticket size={22} aria-hidden="true" />
        <div>
          <strong>Online booking is on its way.</strong>
          <p>You'll be able to save seats for game nights and hosted sessions here. Until then, book with the café team as usual.</p>
        </div>
      </div>

      <section class="section" aria-labelledby="book-next">
        <div class="section-head">
          <h2 id="book-next">Coming up</h2>
          <a href="/diary">
            Full diary <ArrowRight size={18} aria-hidden="true" />
          </a>
        </div>
        {loading && !occurrences && <DiceLoader />}
        {error && !occurrences && <ErrorState error={error} onRetry={reload} />}
        {occurrences && !timed.length && <EmptyState title="Nothing on the table yet." text="Check back soon for more events." />}
        <div class="list" role="list">
          {timed.map(o => (
            <div role="listitem" key={o.occurrence_id}>
              <EventTicket o={o} today={today} />
            </div>
          ))}
        </div>
      </section>

      <section class="section card card--feature card--navy host-hero" aria-labelledby="run-the-table">
        <ChessKnight size={40} aria-hidden="true" style={{ margin: '0 auto', color: 'var(--rtd-accent)' }} />
        <h2 id="run-the-table" class="hero">
          Run the Table
        </h2>
        <p>Got a game you love? Help other people discover it.</p>
        <a class="btn btn--inverse btn--lg" href="/host" style={{ marginTop: '16px' }}>
          Become a game host
        </a>
      </section>
    </div>
  );
}
