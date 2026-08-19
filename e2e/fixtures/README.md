# E2E fixtures

Recorded artefacts so journeys never touch `etenders.gov.ie` in CI. A CI run that
reaches the live portal is a bug: it makes the suite flaky, and it puts load on a
public service we do not own.

| File | What it is |
|---|---|
| `notice-detail.html` | A recorded eTenders notice detail page, scrubbed of personal data. Drives the import journey. |
| `tender-pack.txt` | Stand-in for an extracted tender pack: requirements, award criteria, a mandatory certificate. |

## Re-recording

1. Fetch the page by hand, save the raw HTML here.
2. Remove names, emails, phone numbers and any direct download links.
3. Run `npm test --prefix server` — the parser contract tests in `server/tests/`
   assert against these files and will fail loudly if the shape changed.

Fixtures are the drift alarm (story E2-02). Do not "fix" a failing fixture test by
re-recording without reading what changed first.
