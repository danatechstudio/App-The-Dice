// Booking UI pieces (brief §20–23). Bookings arrive in Phase 5; the style
// guide shows them now so the flow is designed before it is built.

const STEPS = ['Event', 'Spaces', 'Details', 'Review', 'Confirmed'] as const;

export function Stepper({ current }: { current: number }) {
  return (
    <div class="stepper-wrap">
      <ol class="stepper" aria-label="Booking progress">
        {STEPS.map((s, i) => (
          <li key={s} data-state={i < current ? 'done' : i === current ? 'current' : 'todo'} aria-current={i === current ? 'step' : undefined}>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Real numbers only: shows booked/capacity, never invented urgency. */
export function Capacity({ booked, capacity }: { booked: number; capacity: number }) {
  const left = Math.max(capacity - booked, 0);
  const pct = Math.min(100, Math.round((booked / capacity) * 100));
  const state = left === 0 ? 'full' : left <= Math.max(2, Math.ceil(capacity * 0.2)) ? 'nearly' : 'open';
  return (
    <div class={`capacity capacity--${state}`}>
      <div class="capacity__head">
        <span>
          {booked} / {capacity} booked
        </span>
        <span>{left === 0 ? 'Full' : `${left} ${left === 1 ? 'space' : 'spaces'} left`}</span>
      </div>
      <div class="capacity__bar" role="progressbar" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={booked} aria-label="Spaces booked">
        <div class="capacity__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
