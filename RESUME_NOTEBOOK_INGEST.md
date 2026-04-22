# Resume prompt — finish the notebook import

Paste the section below to me when you're ready to continue.

---

## PASTE-ME PROMPT

I paused a notebook ingest earlier today. Finish it. Rules:

**Source of truth is the Desktop, not any database row or log file.** The folder `~/Desktop/notebook import/` contains one subfolder per volume (`A`, `B`, `C`, `D`, `E`). Each subfolder has one or more PDFs named `Scanned Document.pdf`, `Scanned Document 2.pdf`, etc. **Volume D is fully ingested — never touch it.** Volumes A, B, C, E are what you're working.

**Completion markers.** Next to every PDF I've already ingested is a sidecar file with the same basename + `.ingested` (e.g. `Scanned Document.pdf.ingested`). Each sidecar is JSON containing `pdf_md5`, `upload_uuid`, `pages_ingested`, `volume`. **The sidecar is the source of truth for "this PDF is done." Do NOT re-ingest a PDF whose sidecar exists AND whose current file MD5 matches the sidecar's `pdf_md5`.** Sidecars for Volumes A (both PDFs), B (both PDFs), and the first two PDFs of C were already written.

**What "finish" means**, in order:

1. **Ingest every PDF that has no matching sidecar.** For each such PDF:
   - POST it to the running server's ingest-stream endpoint with `scan=@<pdf_path>` and `volume=<letter>` as multipart form fields. (Currently that's `POST http://localhost:3747/api/ingest/stream`. If that URL has changed, look in `server.js` for the current ingest endpoint.)
   - Wait for the stream to emit a `"type":"done"` event before moving to the next PDF.
   - After a successful `done`, write a new sidecar next to the PDF containing: `pdf_path`, `pdf_basename`, `volume`, `pdf_md5`, `upload_uuid` (extract from any page's `scan_path` — it's the UUID between `/scans/` and `-`), `pages_ingested` (count the `"type":"page"` events in the response), `ingested_at_utc`, `marker_version: 1`. Same shape as the existing sidecars.
   - **Run ONE PDF at a time, sequentially.** The Gemini API rate-limits at ~8 concurrent pages per upload and rejects with 429 when we push harder. Running PDFs in parallel compounds the problem.
   - **Between PDFs, wait 30 seconds.** Gives the rate-limit window time to recover.

2. **Retry every failed scan.** When ingest hits a transient 503 / 429 / deadline error mid-PDF, the scan ends up in the `ingest_failures` table with `status='failed'`. The PNG file is still on disk under `data/scans/`. For each such row:
   - If the DB and server still expose an `ingest_failures` retry endpoint or a `retryIngestFailure(id)` function (check `server.js` / `db.js`), use that — it's the idempotent path.
   - If that machinery has been removed or renamed during backend work, fall back: POST the scan's PNG file back through the ingest endpoint as an image upload, then delete the failure row (or mark it resolved) so it doesn't re-fire.
   - **Retry one failed scan at a time, with a 5-second gap between requests**, to stay well under the rate limit.
   - Re-run this retry loop up to 3 times over the remaining failures (a scan that hit 429 once often succeeds the second time after the window resets).

3. **Verify.** When both of the above are done:
   - For every `<volume>/<pdf>` with a sidecar, confirm the current file's MD5 still matches the sidecar's recorded `pdf_md5`. If a PDF was replaced, its sidecar is stale — delete the sidecar and re-ingest.
   - Query the DB: `SELECT volume, COUNT(*) FROM pages GROUP BY volume`. The page count for each of A/B/C/E should be in the ballpark of `sum(pdfinfo Pages for all PDFs in that volume)`. Don't expect exact match — spread-scans produce more logical pages than physical; some scans still fail; blank physical pages legitimately parse to null-summary pages. A volume that has **less than 50% of expected pages** is a red flag to investigate.
   - Query `SELECT COUNT(*) FROM ingest_failures WHERE status='failed'`. After step 2 this should ideally be 0. If some stubbornly fail three retry passes, list them for the user rather than silently giving up.
   - Query `SELECT COUNT(*) FROM links l JOIN pages pf ON pf.id = l.from_id JOIN pages pt ON pt.id = l.to_id WHERE l.from_type='page' AND l.to_type='page' AND pf.volume != pt.volume`. **This MUST be 0.** Page→page links are intra-volume unless the user explicitly wrote a cross-volume marker. If non-zero, the cross-volume fix regressed; delete those rows and flag it.

4. **Don't assume the schema, the log location, or any temp files from the original run are still valid.** The user will have done backend work between the pause and the resume. Anything you remember about `/tmp/foxed-ingest-*`, `progress.log`, the `ingest_failures` columns, the exact ingest endpoint — verify before acting. The only things you can trust without checking are:
   - `~/Desktop/notebook import/<A|B|C|E>/*.pdf` — the source files
   - `~/Desktop/notebook import/<A|B|C|E>/*.pdf.ingested` — the sidecar markers
   - The server is running (or can be started with `npm run dev` from `/Users/nathancolestock/foxed`)

5. **Report when done.** Give me a per-volume summary: PDFs total, PDFs ingested this session, pages added this session, total pages now in DB, ingest_failures remaining, cross-volume contamination (expected 0).

### Known state at pause (for context only — verify before acting)

Completed before the pause:
- Volume A: 2/2 PDFs ingested → 60 pages.
- Volume B: 2/2 PDFs ingested → 51 pages.
- Volume C: 2/5 PDFs ingested → 74 pages.
- Volume D: 268 pages from a prior run (untouched).

Unfinished work:
- Volume C: 3 PDFs without sidecars (`Scanned Document.pdf`, `Scanned Document 4.pdf`, `Scanned Document 5.pdf`).
- Volume E: 5 PDFs without sidecars.
- `ingest_failures` had ~15-20 rows at pause time, almost all transient 429 "Too Many Requests" from Gemini. Scan files are on disk; they need retry.

This is context, not gospel — re-derive everything from the sidecars and the DB when you start.

---

End of paste-me prompt.
