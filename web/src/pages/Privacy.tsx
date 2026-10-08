// The privacy notice (docs/RTD_PRIVACY.md). Who is responsible, the contact
// address and how long booking details are kept come from the app's settings,
// so they can change without a new release. It reads fine without them (offline).

import { useApi } from '../lib/api';
import { useTitle } from '../lib/title';

interface PrivacyInfo {
  controller: string;
  contact_email: string | null;
  booking_retention_months: number;
}

const UPDATED = '8 October 2026';

export function Privacy() {
  useTitle('Privacy');
  const { data } = useApi<PrivacyInfo>('/api/privacy');
  const controller = data?.controller ?? 'Roll The Dice Board Game Café, Cleethorpes';
  const months = data?.booking_retention_months ?? 12;
  const contact = data?.contact_email ? (
    <>
      email <a href={`mailto:${data.contact_email}`}>{data.contact_email}</a>, reply to any email from us, or ask at the café
    </>
  ) : (
    <>reply to any email from us, or ask at the café</>
  );

  return (
    <div class="container">
      <header class="page-head">
        <p class="label">Privacy</p>
      </header>
      <article class="card card--pad privacy" aria-labelledby="privacy-title">
        <h1 id="privacy-title" class="display">
          How we use your details
        </h1>
        <p class="meta">Last updated {UPDATED}</p>

        <section aria-labelledby="p-who">
          <h2 id="p-who">Who we are</h2>
          <p>
            <strong>{controller}</strong> is responsible for the details you give us in this app (the "data controller"). For any question about your details,
            or to use your rights below, {contact}.
          </p>
        </section>

        <section aria-labelledby="p-what">
          <h2 id="p-what">What we collect, and why</h2>
          <h3>When you book</h3>
          <p>
            Your name, email address, mobile number (if you give it), how many places you book and any note. We use them to hold your places, send your
            confirmation, tell you if anything changes, and plan the event. We need them to take your booking.
          </p>
          <h3>To stop misuse of the booking form</h3>
          <p>
            A scrambled code made from your internet address and the date, which can't be turned back into the address. It's only used to stop too many
            bookings coming from one place in a short time. That's in our legitimate interest, and yours.
          </p>
          <h3>If you host games, or ask to</h3>
          <p>
            Your name, the email address you sign in with, what you'd like to run and the sessions you plan. We use them to decide on requests, put your
            sessions in the diary, and email you about bookings and changes.
          </p>
          <h3>If you apply for a market stall</h3>
          <p>
            Your stall name, your name, email address and mobile number, what you sell, any links you give, your insurance details, any photos and any
            note. We use them to decide on your application, to email you the result (and, if you're approved, how to pay), and to arrange the market.
            That's in our legitimate interest, and needed to give you a pitch.
          </p>
          <h3>If you turn on event alerts</h3>
          <p>
            Your browser gives us an address to send notifications to, which works only for that browser on that device, and what we need to lock them so only
            your device can read them. It doesn't tell us who you are. We use it only to send you reminders about events at the café, because you asked us to,
            and you can turn them off at any time (on the home page). When you turn them on, we also keep a scrambled code made from your network address for 2
            days, to stop the button being misused.
          </p>
          <h3>Counting visits</h3>
          <p>
            The app counts how often its pages are viewed and its buttons pressed (for example, how many times an event was opened or shared), so the café
            can see what people are interested in. Each count is added to a daily total for the page or event. Nothing about you goes with it: no network
            address, no device ID and no cookie, so a count can't be traced back to anyone. Visits by the café team and hosts aren't counted.
          </p>
          <h3>On your device</h3>
          <p>
            The app remembers a few choices in your browser, like your diary filters, reduced motion, and whether you've closed the install message. They stay on
            your device and aren't sent to us. Hosts and café staff also get a sign-in cookie for the organiser. There are no advertising or tracking cookies.
          </p>
        </section>

        <section aria-labelledby="p-share">
          <h2 id="p-share">Who sees it</h2>
          <ul>
            <li>
              <strong>The café team</strong> sees everything about bookings, so they can run the event and contact you if they need to.
            </li>
            <li>
              <strong>The host of a hosted session</strong> sees your name, how many are coming and your note. Not your email address or phone number.
            </li>
            <li>
              <strong>Market applications</strong> are seen only by the café team, photos included. They're also kept in the café's market list.
            </li>
            <li>
              <strong>Event alerts</strong> travel through your browser's own notification service (Google for Chrome and Android, Apple for Safari and iPhone,
              Mozilla for Firefox, Microsoft for Edge on Windows). They're locked so that only your device can read them.
            </li>
            <li>
              <strong>The people and companies who run the app for us:</strong> our app developer, who builds and looks after the app and its emails; Cloudflare
              (hosting and storage); and Google (the app's emails are sent through Gmail). They only use your details to do that work for us. Some of it may be
              handled outside the UK, under the safeguards UK law requires.
            </li>
          </ul>
          <p>
            We never sell your details, and we don't use your booking or application details for marketing. The only reminders we send are event alerts, and
            only if you turn them on.
          </p>
          <p>
            Event pages show the café's own photos of past events. If you're in one and would like it taken down, let us know.
          </p>
        </section>

        <section aria-labelledby="p-keep">
          <h2 id="p-keep">How long we keep it</h2>
          <ul>
            <li>
              <strong>Bookings:</strong> your name, email, mobile and note are erased automatically {months} months after the event. We keep only how many people
              came.
            </li>
            <li>
              <strong>Emails about bookings</strong> are deleted from the app 90 days after sending. Copies in the café's own mailboxes are deleted once they're no
              longer needed.
            </li>
            <li>
              <strong>The scrambled code</strong> from the booking form is deleted after 2 days.
            </li>
            <li>
              <strong>Requests to host</strong> that weren't approved, or were withdrawn, are erased after 12 months.
            </li>
            <li>
              <strong>Market applications</strong> are erased 12 months after the market, photos included, and cleared from the café's market list at the
              same time.
            </li>
            <li>
              <strong>Event alerts:</strong> the notification address is deleted when you turn alerts off, or as soon as your browser tells us it no longer works
              (for example, after you remove the app).
            </li>
            <li>
              <strong>Visit counts</strong> are daily totals with nothing about anyone in them, so we keep them.
            </li>
            <li>
              <strong>Hosts:</strong> we keep your details while you host with us. If you stop, ask us and we'll delete them. We keep a record of decisions made in the
              organiser, like who approved a session or cancelled a date.
            </li>
          </ul>
        </section>

        <section aria-labelledby="p-rights">
          <h2 id="p-rights">Your rights</h2>
          <p>
            You can ask us for a copy of your details, to correct them, to delete them, or to stop or limit how we use them. To cancel a booking, use the link in
            your confirmation email. For anything else, {contact}. We'll reply within a month.
          </p>
          <p>
            If you're unhappy with how we've handled your details, you can complain to the Information Commissioner's Office at{' '}
            <a href="https://ico.org.uk/make-a-complaint/" rel="noopener">
              ico.org.uk
            </a>{' '}
            or on 0303 123 1113. We'd appreciate the chance to put it right first.
          </p>
        </section>

        <section aria-labelledby="p-children">
          <h2 id="p-children">Children</h2>
          <p>If you're under 13, please ask a parent or carer to book for you.</p>
        </section>

        <section aria-labelledby="p-changes">
          <h2 id="p-changes">Changes</h2>
          <p>If we change how we use your details, we'll update this page and the date at the top.</p>
        </section>
      </article>
    </div>
  );
}
