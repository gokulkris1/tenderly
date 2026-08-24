# Runbook: backup, restore and staging seed

*An untested backup is not a backup. This document exists so a restore is a
procedure somebody follows rather than a thing somebody improvises at the worst
possible moment.*

## What has to survive

There is less to back up than there appears to be, because **the document store
is the database**. Uploaded tender packs and vault certificates are stored as
`bytea` columns — `tender_documents.bytes` and `evidence_library.bytes` — not in
object storage. Object storage is TLY-52 and has not been chosen. So today:

| What | Where it lives | Backed up by | Frequency | Retention |
|---|---|---|---|---|
| Application database | Neon Postgres, one project | Neon's own history, plus the off-provider dump below | Neon: continuous. Dump: weekly, and before any migration that repoints a foreign key | Neon: `[INPUT NEEDED: confirm the history window on the current Neon plan and record it here]`. Dump: 8 weeks |
| Uploaded documents and vault files | The same database (`bytea` columns) | The same two mechanisms | Same | Same |
| Encryption key for documents at rest | Not yet — see *Key custody* | — | — | — |
| Backlog, migrations, seed scripts | This repository | GitHub | Every push | Full history |

The `[INPUT NEEDED: …]` above is deliberate and follows the same rule as the
product: an unverified number written down confidently is worse than an obvious
gap. Fill it from the Neon console, do not guess it, and do not plan a recovery
around a retention window nobody has looked at.

**Neon's history is not the whole answer.** It protects against our mistakes; it
does not protect against losing the Neon account, a billing lapse, or a provider
incident. That is what the off-provider dump is for, and it is the one somebody
has to actually run.

## Taking an off-provider dump

```
pg_dump --format=custom --no-owner --no-privileges \
        --file "tenderly-$(date +%Y-%m-%d).dump" "$DATABASE_URL"
```

Custom format because it restores selectively and compresses; `--no-owner` and
`--no-privileges` because the restore target will not have Neon's roles.

Store the file outside Neon — the point is that it survives losing Neon —
encrypted at rest, with access limited to whoever can already reach production.
A dump contains every customer's bids, CVs and certificates: it is the most
sensitive single object this company holds, and it should be treated with more
care than the database it came from, not less.

**Verify the dump you just took**, before you rely on it:

```
DATABASE_URL="$DATABASE_URL" node scripts/backup/rehearse-restore.mjs
```

## Restoring into staging

1. **Stop writing to staging.** Pause the staging Render service, or accept that
   anything written during the restore is lost.
2. **Create an empty target.** Restoring over a database with rows in it merges
   two datasets and produces something nobody designed.
   ```
   psql "$ADMIN_URL" -c 'CREATE DATABASE tenderly_staging_restore'
   ```
3. **Restore.**
   ```
   pg_restore --no-owner --no-privileges \
              --dbname "$STAGING_RESTORE_URL" tenderly-YYYY-MM-DD.dump
   ```
   `pg_restore` exits non-zero on notices as well as on failures. Its exit
   status is not the check — step 4 is.
4. **Verify** (see below). Do not point staging at the restored database until
   verification passes.
5. **Point staging at it** by updating `DATABASE_URL` on the staging service and
   redeploying. The application applies migrations at boot and every migration
   is idempotent, so a dump taken from an older schema is brought forward
   automatically.
6. **Sign in and open a bid.** The verification script proves the rows are
   there; a person proves the product works.

## Verification: what "restored" means

A restore is complete when all of these hold. `scripts/backup/rehearse-restore.mjs`
checks the first two automatically and is what CI runs on every pull request.

1. **Row counts match per table.** Every table in `public`, compared against the
   source — not a spot check of the big ones. A table that restored empty is
   the failure mode that looks like success.
2. **A vault document comes back byte for byte.** The script reads one
   `evidence_library` row with bytes from both databases and compares the
   buffers. Counting rows proves the metadata survived; only the bytes prove the
   certificate did.
3. **The application starts against it** and applies migrations without error.
4. **Signing in works and a bid opens** — one manual step, because the first
   three can all pass on a database the product cannot actually use.

## Key custody

**Nothing is encrypted at the application level yet.** Document encryption at
rest is TLY-96 and is blocked on the storage decision in TLY-52. Neon encrypts
its storage volumes, and that key is Neon's, not ours — it protects against
somebody walking off with a disk and against nothing else that matters here.

This section states the custody rules that take effect the day TLY-96 ships, so
that they are agreed before there is a key to lose rather than after:

- **Where it is held.** A single data-encryption key, held in the Render
  environment as `TENDERLY_DOCUMENT_KEY` and nowhere else in the running system.
  A sealed copy is held outside Render — the same off-provider place as the
  dumps, under separate access — because a key that only exists in the platform
  you are recovering from is not a backup of anything.
- **Who can retrieve it.** The account owner on Render, and whoever holds the
  off-provider copy. Nobody else, and it is never pasted into a chat, a ticket,
  a log line or a commit.
- **What a lost key means.** **The documents are gone.** Not degraded, not
  recoverable with effort: the ciphertext is in the database backup and there is
  no way to read it. Every tender pack and every certificate a customer uploaded
  becomes bytes nobody can open. This is the whole reason the sealed off-provider
  copy exists, and the reason the copy must be tested, exactly like the dumps.
- **Rotation** re-encrypts under the new key rather than switching keys and
  hoping: both keys are held until the re-encryption has been verified by the
  check below.

### The expected signal of a key mismatch

Once TLY-96 ships, a restore performed with the wrong key **fails at step 2 of
verification**: the vault document download fails with a decryption error, and
the bytes comparison in the rehearsal script does not match. Row counts will
still be perfect, the application will still start, and sign-in will still work
— which is precisely why the document check is part of verification and not an
optional extra. A restore that passes every check except that one has recovered
the filing cabinet and not the files.

If you see a decryption error after a restore, do not re-run the restore. The
data is fine; the key is wrong. Retrieve the correct key from the sealed copy.

## Rehearsal record

The rehearsal is automated: `restore-rehearsal` runs in the `ci-pr` workflow on
every pull request, against the CI database that the test suite has just filled
with tenders, answers, evidence and an uploaded document. It dumps, restores
into a fresh database, compares every table's row count and compares the bytes
of a vault document. A failure fails the build.

Automating it is deliberate. A rehearsal somebody performs once and writes down
is evidence about the day they did it; one that runs on every change is evidence
about today.

| Date | Operator | Elapsed | Result |
|---|---|---|---|
| _first run pending_ | GitHub Actions · `ci-pr` / `restore-rehearsal` | — | To be filled from the first run of the rehearsal step |

Each run prints its own evidence line in the form
`REHEARSAL <date> · <operator> · <elapsed>s · <n> tables`. When a restore is
performed by hand against staging, add a row here with the same fields and the
name of the person who did it.

**Still to prove:** AC4 and AC6 of TLY-100 — that a restored vault document
opens with its original content *through the encryption layer*, and that a wrong
key produces a decryption error — cannot be exercised until TLY-96 adds the
encryption. The byte-for-byte document check runs today and is the same check;
it gains the decryption step, and the key-mismatch case, when there is a key.

## Staging seed

Staging does not need production data to be useful, and putting production data
there spreads customer bids to a system with weaker access controls. Prefer:

```
npm run seed:staging
```

Restore a production dump into staging only when reproducing a specific
production fault, and drop the restored database when you are done.
