// Market emails (docs/RTD_MARKETS.md), written into the outbox like the
// booking emails; n8n (RTD Outbox) sends them. Everything typed is escaped.
// `{{application_id}}` is filled in by the database when the application is saved.

import { esc, firstName, longDate, shortDate, timeLabel } from '../lib/format';
import { priceLabel } from '../host/sessions';
import { APPROVALS_INBOX, fact, join, link, p, type Email } from '../notify/emails';

export interface MarketFacts {
  market_id: string;
  name: string;
  event_date: string;
  start_time: string;
  end_time: string | null;
  pitches: number;
  pitch_fee_pence: number;
  payment_details: string;
}

export interface VendorFacts {
  stall_name: string;
  contact_name: string;
  email: string;
  mobile: string;
  products: string;
  links: string | null;
  insured: boolean;
  insurer: string | null;
  insurance_expiry: string | null;
  notes: string | null;
  photo_count: number;
  waitlisted: boolean;
}

const when = (m: MarketFacts) => `${longDate(m.event_date)}, ${timeLabel(m.start_time, m.end_time)}`;
const title = (m: MarketFacts) => `${m.name}, ${shortDate(m.event_date)}`;
/** Several lines typed by an admin or a vendor, kept as lines. */
const lines = (s: string) => esc(s).replace(/\r?\n/g, '<br>');
const SIGN_OFF = p('Thanks,<br>The Roll The Dice team');

export function insuranceText(v: Pick<VendorFacts, 'insured' | 'insurer' | 'insurance_expiry'>): string {
  if (!v.insured) return 'No';
  return `Yes${v.insurer ? `, ${v.insurer}` : ''}${v.insurance_expiry ? `, until ${shortDate(v.insurance_expiry)} ${v.insurance_expiry.slice(0, 4)}` : ''}`;
}

/** To the vendor, straight after they apply. Replies reach the approvers' inbox. */
export function vendorApplied(m: MarketFacts, v: VendorFacts): Email {
  const fee = priceLabel(m.pitch_fee_pence);
  return {
    dedupe_key: 'market-applied:{{application_id}}',
    kind: 'market_applied',
    to: v.email,
    reply_to: APPROVALS_INBOX,
    subject: `We've got your application: ${title(m)}`,
    html: join([
      p(`Hi ${esc(firstName(v.contact_name))},`),
      p(`Thanks for applying for a pitch at <strong>${esc(m.name)}</strong>.`),
      fact('When', when(m)),
      fact('Stall', esc(v.stall_name)),
      fact('Reference', '{{application_id}}'),
      v.waitlisted
        ? p("Every pitch has been taken for now, so you're on the <strong>waiting list</strong>. If a pitch frees up, the café team will be in touch.")
        : p('The café team will look at your application and email you with their decision.'),
      p(fee === 'Free' ? "There's no pitch fee for this market." : `The pitch fee is ${fee}, paid once you're approved. We'll send the payment details then.`),
      p('Any questions? Just reply to this email.'),
      SIGN_OFF,
    ]),
  };
}

/** To the approvers, for every application. Replying reaches the vendor. */
export function marketApplicationToApprove(m: MarketFacts, v: VendorFacts, approved: number, organiserUrl: string): Email {
  return {
    dedupe_key: 'market-new:{{application_id}}',
    kind: 'market_application',
    to: APPROVALS_INBOX,
    reply_to: v.email,
    subject: `Market application to approve: ${v.stall_name}, ${title(m)}${v.waitlisted ? ' (waiting list)' : ''}`,
    html: join([
      p(`<strong>${esc(v.stall_name)}</strong> has applied for a pitch at ${esc(m.name)} (${when(m)}).`),
      fact('Reference', '{{application_id}}'),
      fact('Contact', esc(v.contact_name)),
      fact('Email', link(`mailto:${v.email}`, v.email)),
      fact('Mobile', esc(v.mobile)),
      fact('What they sell', lines(v.products)),
      v.links && fact('Links', lines(v.links)),
      fact('Public liability insurance', esc(insuranceText(v))),
      fact('Photos', v.photo_count ? `${v.photo_count}, in the organiser` : 'None'),
      v.notes && fact('Notes', lines(v.notes)),
      fact('Pitches', `${approved} of ${m.pitches} approved so far${v.waitlisted ? '; this one is on the waiting list' : ''}`),
      p(link(organiserUrl, 'Approve or decline it in the organiser')),
      p(`Reply to this email to contact ${esc(firstName(v.contact_name))}.`),
    ]),
  };
}

/** To the vendor when they're approved: the confirmation, and how to pay. */
export function vendorApproved(m: MarketFacts, v: { application_id: string; contact_name: string; email: string; stall_name: string }, note: string | null): Email {
  const fee = priceLabel(m.pitch_fee_pence);
  return {
    dedupe_key: `market-approved:${v.application_id}`,
    kind: 'market_approved',
    to: v.email,
    reply_to: APPROVALS_INBOX,
    subject: `You're in: ${title(m)}`,
    html: join([
      p(`Hi ${esc(firstName(v.contact_name))},`),
      p(`Good news: <strong>${esc(v.stall_name)}</strong> has a pitch at <strong>${esc(m.name)}</strong>.`),
      fact('When', when(m)),
      fact('Where', 'Roll The Dice Board Game Café'),
      fact('Reference', esc(v.application_id)),
      note && p(`A note from the café: "${lines(note)}"`),
      fee === 'Free'
        ? p("There's no pitch fee for this market.")
        : join([
            fact('Pitch fee', fee),
            p('<strong>How to pay</strong>'),
            p(lines(m.payment_details)),
            p(`Please use your reference, <strong>${esc(v.application_id)}</strong>, when you pay.`),
          ]),
      p("Can't make it any more? Reply to this email, so the pitch can go to someone else."),
      p('See you there,<br>The Roll The Dice team'),
    ]),
  };
}

/** To the vendor when they're not approved. */
export function vendorDeclined(m: MarketFacts, v: { application_id: string; contact_name: string; email: string; stall_name: string }, note: string | null): Email {
  return {
    dedupe_key: `market-declined:${v.application_id}`,
    kind: 'market_declined',
    to: v.email,
    reply_to: APPROVALS_INBOX,
    subject: `Your application: ${title(m)}`,
    html: join([
      p(`Hi ${esc(firstName(v.contact_name))},`),
      p(`Thanks for applying to bring <strong>${esc(v.stall_name)}</strong> to ${esc(m.name)}. Sorry, we can't offer you a pitch this time.`),
      note && p(`A note from the café: "${lines(note)}"`),
      p("We hope you'll apply for one of our future markets."),
      SIGN_OFF,
    ]),
  };
}
