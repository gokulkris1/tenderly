# Recorded eTenders markup

`search-results.html` and `notice-detail.html` are real pages from
www.etenders.gov.ie, recorded on 24 August 2026, and used to pin the parsers in
`server/src/etenders.ts` against a portal we do not control.

They are recorded rather than hand-written because the failure this guards
against is markup drift, and only the portal's own markup can demonstrate it.

## Scrubbing

The portal carries one personal field, `Contact Point`. Its value is replaced
with the role `Procurement Officer`. Email addresses become
`procurement@example.test` and phone numbers are zeroed. Everything else —
buyer organisations, titles, CPV codes, dates and values — is public procurement
information published by the authority.

`etenders-contract.test.ts` asserts these properties, so a future re-recording
that forgets to scrub fails the build.

## Re-recording

Fetch the two pages, apply the same scrubbing, and update the expected values in
`etenders-contract.test.ts` to match. If the assertions fail before you touch
them, the portal has changed and the parser — not the test — is what needs
attention.
