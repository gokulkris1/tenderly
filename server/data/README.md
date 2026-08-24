# Reference data

## cpv-2008.csv

The Common Procurement Vocabulary as adopted by Regulation (EC) No. 213/2008,
English descriptions only, extracted from the official `cpv_2008.xml`
distribution published via TED/SIMAP.

Columns: `code` (8 digits, leading zeros preserved), `check_digit`, `description`.
9,454 rows — the full CPV 2008 list.

It is committed rather than fetched at build time because CPV is a fixed
standard that changes only when the Commission amends the regulation. A build
that silently depended on a third-party host being up would be a worse trade
than a 350 KB file in the repository.

To refresh it after a regulation amendment, re-extract the `LANG="EN"` text from
the official XML rather than hand-editing rows.
