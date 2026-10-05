import { CalendarDays, ChessKnight, UsersRound } from 'lucide-preact';
import { useTitle } from '../lib/title';

export function Host() {
  useTitle('Become a game host');
  return (
    <div class="container" data-surface="host">
      <header class="page-head">
        <p class="label">Become a game host</p>
      </header>
      <section class="card card--feature card--navy host-hero" aria-labelledby="host-title">
        <h1 id="host-title" class="hero">
          Run the Table
        </h1>
        <p style={{ marginTop: '12px', fontSize: '1.125rem' }}>
          Got a game you love?
          <br />
          Help other people discover it.
        </p>
      </section>
      <div class="section host-points">
        <div class="card host-point">
          <ChessKnight size={28} aria-hidden="true" />
          <h2 class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>Bring a game you love</h2>
          <p class="meta">D&D one-shots, card clubs, learn-to-play nights: if it gets people round a table, it counts.</p>
        </div>
        <div class="card host-point">
          <UsersRound size={28} aria-hidden="true" />
          <h2 class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>We help fill the table</h2>
          <p class="meta">Your sessions go in the RTD diary and app, with bookings handled for you.</p>
        </div>
        <div class="card host-point">
          <CalendarDays size={28} aria-hidden="true" />
          <h2 class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>Pick dates that suit you</h2>
          <p class="meta">One-off or regular. The café team checks each session before it goes live.</p>
        </div>
      </div>
      <div class="section notice notice--info">
        <p>
          <strong>Host applications open soon.</strong> Until then, have a chat with the café team next time you're in.
        </p>
      </div>
      <div class="section card card--pad cluster" style={{ justifyContent: 'space-between' }}>
        <p>
          <strong>Already a host?</strong> Plan your sessions in the organiser.
        </p>
        <a class="btn btn--primary" href="/organise" target="_self">
          Open the organiser
        </a>
      </div>
    </div>
  );
}
