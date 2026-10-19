# Private Events Implementation Plan

> Executed inline (owner: "build"). Spec: `docs/superpowers/specs/2026-10-18-private-events-design.md`.

Constraints as for the admin event editor: prettier on new files only; `npm test` and `npm run typecheck` green before
each commit; commits end with the attribution lines; no production migration without the owner's go-ahead.

1. **Private dates in public reads** (`src/lib/queries.ts`, `src/routes/public.ts`, `src/routes/pages.ts`):
   `redactPrivate` keeps name and description; `findOccurrence(db, id, { listed: true })` and
   `nextOccurrence(..., { listed: true })` for the occurrence page, calendar links and page meta, each redacted.
   Tests in `test/private-events.test.ts`: list, page, calendar, booking refused.
2. **Enquiries** (`migrations/0023_enquiries.sql`, `src/events/enquiries.ts`, route in `src/routes/public.ts`):
   `sendEnquiry(db, occurrenceId, body, { now, ip, origin })`. Tests: checks, trap, limit, recipients, not for public
   dates.
3. **Retention** (`src/lib/privacy.ts`): delete enquiries after 90 days, null `ip_hash` after 2. Test.
4. **Web**: `EventCard` private ticket (name, Private game, link to the page), `Event.tsx` private panel with the form,
   `Home.tsx` wording, host form copy (`Organise.tsx`), Privacy page. Browser check.
5. **Docs**: changelog, RTD_PRIVACY.md, handoff, migration record.
