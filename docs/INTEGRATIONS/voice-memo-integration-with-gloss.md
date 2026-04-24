# Integration #9: Maestro → Gloss Voice Memo

**Status:** implemented  
**Direction:** Maestro (caller) → Gloss (callee/provider)  
**Contract owner:** gloss (owns `/api/ingest/voice`)

---

## Purpose

Allow the Maestro iPhone PWA to send a voice memo transcript directly into Gloss's
ingest pipeline. The user records on the Maestro capture screen, Maestro proxies the
transcript to Gloss, and Gloss stores it as a `voice_memo` page with full entity
extraction, daily-log filing, and AI index classification.

---

## Caller env vars (Maestro cloud)

| Var | Description |
|-----|-------------|
| `GLOSS_URL` | Base URL of the Gloss server, e.g. `https://your-gloss-app.fly.dev` |
| `GLOSS_API_KEY` | Gloss's `API_KEY` — used as `Authorization: Bearer <key>` |

---

## Gloss endpoint (callee)

### `POST /api/ingest/voice`

Unchanged from its original form. Accepts transcripts from any authorized caller.

**Auth:** `Authorization: Bearer <GLOSS_API_KEY>` (or `SUITE_API_KEY`)

**Request body (JSON):**

```json
{
  "transcript": "string — the transcribed speech, required",
  "date":       "YYYY-MM-DD — optional, defaults to today"
}
```

**Success response `200`:**

```json
{
  "ok":           true,
  "page_id":      "uuid",
  "date":         "YYYY-MM-DD",
  "summary":      "string | null",
  "items_count":  0,
  "backlog_count": 0,
  "daily_log":    { "id": "uuid", "date": "YYYY-MM-DD" },
  "review_url":   "/daily/{date}"
}
```

`review_url` is a Gloss-relative path the caller can append to `GLOSS_URL` to
open the daily log containing the new page.

**Error responses:**

| Status | Body |
|--------|------|
| 400 | `{ "error": "transcript is required" }` |
| 401 | `{ "error": "auth required" }` |
| 500 | `{ "error": "Voice ingest failed", "detail": "..." }` |

---

## Maestro proxy endpoint (caller)

### `POST /api/gloss/voice`

Lives in `maestro/cloud/server.js`. Proxies to Gloss and stores a `captures` row
with `source='voice_gloss'` for traceability in the Maestro dashboard.

**Auth:** same as all other Maestro cloud endpoints  
**Request body (JSON):**

```json
{
  "transcript": "string — required",
  "date":       "YYYY-MM-DD — optional"
}
```

**Success response `200`:** forwards Gloss's full response plus:

```json
{
  "ok":           true,
  "page_id":      "...",
  "date":         "...",
  "review_url":   "https://your-gloss-app.fly.dev/daily/YYYY-MM-DD",
  "capture_id":   42
}
```

`review_url` is the absolute URL (Maestro builds it from `GLOSS_URL + review_url`).

**Error responses:**

| Status | Body |
|--------|------|
| 400 | `{ "error": "transcript required" }` |
| 503 | `{ "error": "GLOSS_URL/GLOSS_API_KEY not configured" }` |
| 502 | `{ "error": "Gloss ingest failed", "status": <n>, "detail": "..." }` |

---

## Maestro PWA flow

1. User taps mic on **Maestro capture screen** in "Notebook" mode.
2. Web Speech API transcribes speech client-side (interim results shown live).
3. On stop/send, PWA calls `POST /api/gloss/voice` on Maestro cloud.
4. Maestro cloud proxies to Gloss and returns the review URL.
5. PWA shows success + a "View in Gloss" link (opens `review_url` in a new tab).

---

## Gloss review UX

Pages ingested via Maestro land in the daily log for the given date. The user
reviews them at `/#daily/{date}` — same surface used for all captures. No special
Maestro-specific UI is needed in Gloss.

---

## Integration test

`maestro/tests/integration/maestro-gloss-voice.test.mjs`

- Verifies `POST /api/gloss/voice` on Maestro cloud requires auth.
- When `GLOSS_API_KEY` is set: smoke-tests the full proxy path against the live
  Gloss instance; confirms `ok: true` and a non-empty `page_id`.

---

## Known constraints

- Maestro cloud must have `GLOSS_URL` + `GLOSS_API_KEY` set in its Fly secrets.
- If Gloss is unreachable, Maestro returns `502`; the PWA shows an error toast.
- Transcription quality depends on the browser's Web Speech API (Safari on iOS
  uses a high-quality model; Chrome uses a lighter one).
- The `source` field on the `captures` row is `'voice_gloss'`; the Gloss page
  records `source_kind='voice_memo'` (no separate Maestro column needed).
