const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Large PNGs (>10MB) reliably hit Gemini's processing deadline. Convert them to
// JPEG at 85% quality before upload — same legibility, ~90% smaller payload.
// sips is macOS built-in; falls back to the raw file on any error.
function prepareImageForGemini(imagePath) {
  const ext = imagePath.split('.').pop().toLowerCase();
  if (ext !== 'png') return { filePath: imagePath, mimeType: 'image/jpeg', cleanup: null };
  let size = 0;
  try { size = fs.statSync(imagePath).size; } catch { /* ignore */ }
  if (size <= 10 * 1024 * 1024) return { filePath: imagePath, mimeType: 'image/png', cleanup: null };
  const tmp = path.join(os.tmpdir(), `gloss-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const r = spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', imagePath, '--out', tmp], { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(tmp)) {
    return { filePath: tmp, mimeType: 'image/jpeg', cleanup: () => { try { fs.unlinkSync(tmp); } catch {} } };
  }
  return { filePath: imagePath, mimeType: 'image/png', cleanup: null };
}

const PARSE_MODEL = 'gemini-2.5-pro';
const CHAT_MODEL = 'gemini-2.5-flash';

const PARSE_SYSTEM = `You are parsing a handwritten notebook page for a personal knowledge system called Gloss.

The notebook is sovereign. Never quote the user's exact words verbatim.
Every item you extract must be a pointer-summary, not a transcription.

Good pointer-summary: "a ★-marked idea on catechesis as scaffold"
Bad (verbatim): "catechesis as scaffold, not cage"

Return ONLY valid JSON, no markdown fences, no commentary.`;

const PARSE_PROMPT = `FIRST, segment the image into logical notebook pages.

A "logical page" is ONE coherent piece of the notebook — typically one daily log, one topical entry, one index page, or one bibliographic note. A single image can contain:
  - one logical page (normal case: a single notebook page photographed up close),
  - two logical pages (a spread: left + right, with a visible gutter/spine),
  - multiple logical pages (e.g. the user wrote two or three days' logs side-by-side on one physical page, or a spread where each side is itself split into two dated sections).

Clues a new logical page begins: a new date header, a new topical title, a horizontal rule or clear visual break, a page-number change, a fresh margin column that restarts numbering. When in doubt between one logical page and two, split — we'd rather have two narrow entries than one conflated one.

CRITICAL — COLLECTION-KIND SWITCHES FORCE A SPLIT: If the handwriting on one physical side shifts from one collection_kind to a different one (e.g. a dated daily_log entry transitions into clearly-titled sermon notes or a named topical entry, or vice versa), that is TWO logical pages, not one with two hints. A single logical page has ONE primary collection — its collection_hints array should describe that one collection (plus optionally its continuation from a prior page), never a mix of daily_log + topical or two different topicals. Examples:
  - A daily log dated "Dec 22" that contains a section headed "Andy's sermon — 1 Tim 3:16" → split into TWO pages: one daily_log, one topical with the sermon title.
  - Sermon-prep notes at the top of a page, followed by a dated bullet journal entry below → TWO pages.
  - Two different named topicals ("Formation" section, then "Books to read" section) on the same side → TWO pages.
When you do split, each logical page gets its OWN items and entities drawn only from its own region of the image — do not duplicate content across the split.

Return this top-level shape:
{
  "pages": [ <PAGE_OBJECT>, <PAGE_OBJECT>, ... ]   // 1 or more entries
}

Parse each logical page INDEPENDENTLY. Each gets its own volume, page_number, summary, collection_hints, items, entities, backlog_items. Different logical pages on the same image can file into completely different collections — do NOT force them to share a collection_hint just because they're on the same scan.

Order the array in reading order (left-to-right, top-to-bottom).

BULLET-JOURNAL THREADING: This user threads topics across non-adjacent pages using small corner markers:
  - A tiny page number in the BOTTOM-LEFT corner means "this page is continued FROM that page." (e.g. bottom-left "36" on p.42 means "I'm continuing my p.36 thought here")
  - A tiny page number in the BOTTOM-RIGHT corner (or a forward-arrow marker) means "this page is continued ON that page." (e.g. bottom-right "42" on p.36 means "continues on p.42")
  These numbers are NOT part of the main content. Do NOT extract them as items or entities. DO extract them into the PAGE_OBJECT fields continued_from and continued_to. If you see them, the page shares its collection with the referenced page even if the header is absent — set continuation:true on the relevant collection_hint.

PAGE_OBJECT shape:
{
  "volume": <integer or null — if you see a volume number on the page>,
  "page_number": <integer or null>,
  "continued_from": <integer — bottom-left corner page ref, or null>,
  "continued_to": <integer — bottom-right corner page ref, or null>,
  "raw_ocr_text": "<full verbatim transcription of all handwriting on THIS page only, EXCLUDING the small corner threading markers — stored privately, never shown in UI>",
  "summary": "<one pointer-phrase describing the page, max 12 words. Write it the way the USER would describe their own day/page — as if they wrote it. NEVER start with preambles like 'a daily log', 'a note about', 'a page about', 'reflections on', 'including...'. NEVER use meta language like 'including tasks and appointments' or 'contains notes on' — just describe the content. Good examples: 'pastoral call with Ron, then drafted Ezra sermon outline'; 'budget review, car in shop, Maddie's birthday planning'. Bad: 'A daily log from April 20 including tasks and appointments.' Bad: 'A note about organizing church documents.'>",
  "collection_hints": [
    {
      "kind": "<daily_log|topical|monthly_log|future_log|index>",
      "label": "<normalized: ISO date like '2024-03-15' for daily_log; short title for topical, e.g. 'Formation'; 'YYYY-MM' for monthly_log>",
      "continuation": <true if this page appears to continue a prior page's daily_log/collection (no new header, thoughts picked up mid-stream), false otherwise>,
      "confidence": <0.0 to 1.0>
    }
  ],
  "book_hints": [
    {
      "title": "<book title as written, trimmed>",
      "author_label": "<author name as written, trimmed; null if no author present>",
      "year": "<year if visible, else null>",
      "confidence": <0.0 to 1.0>
    }
  ],
  "artifact_hints": [
    {
      "title": "<title of the filed artifact — a document, plan, SOP, handout, memo, printed material this page describes or is a cover for>",
      "drawer": "<drawer label if user wrote one, else null>",
      "hanging_folder": "<hanging folder label if user wrote one, else null>",
      "manila_folder": "<manila folder label if user wrote one, else null>",
      "confidence": <0.0 to 1.0>
    }
  ],
  "reference_hints": [
    {
      "title": "<title of external reference: article, URL, podcast, video, paper>",
      "source": "<publication, channel, or short source string; null if unknown>",
      "external_url": "<URL if visible on the page, else null>",
      "confidence": <0.0 to 1.0>
    }
  ],
  "items": [
    {
      "kind": "<task|event|idea|quote|scripture_ref|prayer|prose_block|bibliographic_note>",
      "text": "<pointer-summary max 20 words, NO verbatim quotation of the user's words>",
      "status": "<open|done|migrated|scheduled|cancelled|note — see bullet-journal glyph grammar below. OMIT if not applicable>",
      "confidence": <0.0 to 1.0>
    }
  ],
  "page_refs": [
    {
      "volume": "<optional — the volume letter/number written with the page reference, e.g. 'D' in 'v.D p.90'. Omit if the user wrote only a page number with no volume>",
      "page_number": <integer — the referenced page number>,
      "role_summary": "<one pointer-phrase max 16 words describing WHY this page is being referenced: 'continuation of the sermon outline', 'earlier conversation with J.T.', 'followup on decision made there'. Required.>",
      "confidence": <0.0 to 1.0>
    }
  ],
  "entities": [
    { "kind": "<person|household|scripture|topic|date>",
      "label": "<normalized string — see rules below>",
      "role_summary": "<one pointer-phrase, max 16 words, describing THIS entity's specific role on THIS page — what the user wrote about this person / how this scripture was used / what this topic meant here. NOT the whole page summary. Good for a person named Brad: 'prayer request about his job search'. Bad: 'a daily log from April 20.' Bad (verbatim): 'Brad told me he lost his job.' Write as if the user is recalling why this person / verse / topic appears here. Required for every entity.>",
      "book": "<scripture only: full canonical book name, e.g. 'Nehemiah'>",
      "chapter": <scripture only: integer>,
      "verse_start": <scripture only: integer or null>,
      "verse_end": <scripture only: integer or null>
    }
  ],
  "backlog_items": [
    {
      "kind": "<question|filing|link_proposal>",
      "subject": "<what you are uncertain about — short headline>",
      "proposal": "<for filing/link_proposal: your proposed action. For question: the full question to ask the user>",
      "answer_format": "<REQUIRED for kind=question, OMIT for filing/link_proposal. One of: short | long | choice>",
      "options": ["<only for answer_format=choice: 2-5 short option strings>"]
    }
  ]
}

collection_hints guidance:
- EVERY non-blank page MUST emit at least one collection_hint. Only return collection_hints: [] when the page is literally blank or is a pure navigation/index/TOC page. "I'm not sure what kind" is NOT a reason to return an empty array — propose your best-guess topical label with lower confidence (0.5-0.7).
- Daily log pages usually have a date at the top and contain mixed task/event/note content.
- Topical collection pages have a title heading (e.g. "Formation", "Books to read"). Use the exact title user wrote as the label, normalized (trim, title case).
- Planning grids, weekly overviews, monthly calendars, goal lists with no specific topic heading: emit a topical hint with a descriptive label derived from the page's scope (e.g. "Week 12 2026 plan", "March 2026 overview"), or monthly_log / future_log if a date range is written.
- THREADING — use it aggressively with page numbers and the document outline:
  - If page N-1 and page N+1 (by page_number) are in the same collection X per the document outline, page N is almost certainly in X too — emit that label (with continuation:true if N has no header of its own).
  - If the document outline shows pages N-1 and N sharing a header like "Sermon notes — Nehemiah" and page N+1 starts a new header, page N is a continuation of N-1.
  - If the current page has a bottom-LEFT corner threading marker pointing back to page M, re-use whatever collection label page M had in the document outline / prior context.
  - A page with NO header/date that picks up mid-thought MUST set continuation:true and re-use the prior page's label (from prior context or document outline). If no prior context exists, still set continuation:true and propose your best guess.

BULLET-JOURNAL GLYPH GRAMMAR for items[].status:
This user marks each entry with a leading glyph that carries meaning. Detect it and set status accordingly:
  - "•" or "☐" or "·" or just text (no leading glyph) on a task line → status:"open"
  - "X" or "✓" or "✗" crossed over a task → status:"done"
  - "→" (leading arrow, pointing right) on a task → status:"migrated" (user pushed this task to another day/list)
  - "<" (leading arrow pointing back/left) on a task → status:"scheduled" (user moved this to the future log)
  - strikethrough / line-through entire item → status:"cancelled"
  - "○" or "◯" circle → event (use kind:"event", status:"open")
  - no bullet, indented or margin-text that is just commentary → status:"note"
  - quotes, scripture refs, prayers, and prose blocks: status:"note" (they're not tasks)
Set status on EVERY item when a leading glyph is visible. If the glyph is ambiguous, omit status rather than guess.

page_refs guidance — cross-page links the user is drawing:
When the user writes a page-number reference on this page (e.g. "→ p.172", "see p.47", "cf. v.D p.90", "cont. p.8", "pulled from p.3"), emit a page_refs entry for each one. This lets the system create page→page links automatically so you can click from this page to the page being referenced.
- page_number is the integer mentioned.
- volume is the volume letter/number if the user wrote one (e.g. "v.D p.90" → volume:"D"). Omit volume if the user wrote just "p.90" — the system will assume same volume as this page.
- role_summary is a short pointer-phrase describing WHY the reference exists. Required.
- DO NOT emit page_refs for the bottom-corner threading markers (continued_from / continued_to) — those already have dedicated fields above.
- DO NOT emit page_refs for "p.1" or page-one-of-a-volume style structural references where the user just means "start of this volume."
- If the user writes the same page number in multiple spots on the page (e.g. once as an arrow, once in a prose aside), emit ONE entry with the best role_summary.
- Emit with confidence 0.9 if the reference is unambiguous (explicit arrow or "see p.X"), 0.7 if it's a passing mention you inferred as a page reference. Return an empty array if there are none.

book_hints / artifact_hints / reference_hints guidance:
- Emit book_hints ONLY when the page is clearly reading notes on a specific book — title + author written on the page, quoted excerpts, chapter references, or "notes on <Title>" heading. Do NOT emit book_hints for casual mentions of a book in a daily log ("read some Aquinas today"). The page must BE notes on the book.
- Emit artifact_hints when the page is a description, cover, or table-of-contents for a piece of filed physical material (a sermon draft, an SOP, a handout, a meeting memo). Drawer / hanging folder / manila folder are optional — include only if the user wrote a filing location.
- Emit reference_hints when the page primarily annotates an external resource: a URL, podcast, article, YouTube video, paper. The title and source should be what the user wrote.
- Most pages will have ZERO of these hints — they're daily logs or topicals, not bibliographic notes. Use low confidence (0.5-0.7) if you're not sure.
- confidence should reflect how clearly the page identifies the entity: a page that says "Notes on Aquinas's Summa Theologiae, book I" at the top → 0.95. A page that quotes Aquinas once in a daily log → do NOT emit a hint.

entity extraction — EXTRACT ONLY WHAT IS WRITTEN ON THIS PAGE:
- CRITICAL: Entities MUST come from text visible in THIS image. NEVER pull names, references, or topics from the "prior context" block — prior context is ONLY for detecting collection continuation, NEVER a source of entities.
- Before emitting any person/scripture/topic, point to where on the page you saw it. If you cannot point to it on the page, DO NOT emit it. Hallucinated entities are a serious bug.
- That said, DO extract every proper noun that IS written on the page: first name, last name, initials, nickname, "Pastor X", "Dr. Y", "my dad", "Mom". When in doubt about whether something is on the page, leave it out and emit a backlog_items question instead.
- If you can ONLY read a partial name (e.g. "J—" or a smudged surname), still extract the readable portion AND emit a backlog_items question asking for clarification.
- A topic is any concept the page foregrounds (formation, sabbath, grief, a project name). Zero, one, or two topics per page is typical — do not invent topics to hit a quota.

entity normalization rules:
- scripture: ALWAYS expand abbreviations ("Neh" → "Nehemiah", "1 Cor" → "1 Corinthians", "Ps" → "Psalms"). label MUST be in the form "Book Chapter" or "Book Chapter:Verse" or "Book Chapter:Start-End" (e.g. "Nehemiah 6", "Nehemiah 6:1-8", "Psalms 23:1"). Always include book, chapter, verse_start, verse_end fields. verse_start/verse_end null if a whole-chapter reference.
- person: label should be the fullest form you can confidently assign. If the user wrote a first name only AND you have no prior context, use exactly what they wrote ("Sarah"). If ambiguous between two known people, extract the name AS WRITTEN and emit a backlog_items question with answer_format="choice" — do NOT skip the person entirely.
- household: emit when the page mentions a family/household as a unit rather than an individual — "the Brennekes", "Brenneke's for dinner", "the Smith family", "Thompsons over". label should be the household surname only, without "family" / "the" / possessive / plural ("Brenneke", not "the Brennekes"). If the page only names individual members, emit person entities instead — not a household. If both the household AND specific members are named, emit both.
- topic: lowercase, singular where natural ("formation", "catechesis", "sabbath").
- date: ISO 8601 ("2026-03-15").

backlog_items guidance — pick the right kind:
- "filing" / "link_proposal" = you are proposing a concrete action; the user only needs to approve or reject it.
- "question" = you genuinely need information from the user before you can act. You MUST include "answer_format":
    - "choice" = when there is a small known set of options (e.g. disambiguating between 2-3 people already in the system). Include "options" array.
    - "short" = when a one-line answer would suffice (e.g. "What does the ⧖ symbol mean?", "What does this abbreviation stand for?")
    - "long" = when you need a paragraph (e.g. "Tell me what this collection is about so I file future pages correctly.")

Generate a backlog item whenever:
- confidence for any item is below 0.75 (prefer "filing" with a proposal)
- a person name is ambiguous between known contacts (use kind="question", answer_format="choice")
- you see an unfamiliar symbol (use kind="question", answer_format="short")
- a scripture reference is unclear (use kind="question", answer_format="short")
- a collection_hint is a guess (use kind="filing")
- handwriting is unreadable in a specific spot (use kind="question", answer_format="short", and START the subject with "[Handwriting]: " so the system can log the correction permanently — e.g. "[Handwriting]: Word after 'prayer:' looks like 'Pwy' — what does it say?")

CRITICAL subject formatting rules — the system deduplicates backlog items by subject text:
- For person-identity questions, ALWAYS format the subject as exactly: Who is "[name]"?  where [name] is the name exactly as written in the notebook. Example: Who is "Baz"?  Never write it any other way (no "Identify person:", no "Clarify mention of", no extra words).
- For symbol/abbreviation questions, START the subject with the symbol/abbreviation so it never changes across pages: e.g. "What does ⧖ mean?" not "I see a symbol ⧖ — what is it?".
- Subjects must be stable — the system matches them exactly to avoid asking the same thing twice.`;

// Gemini sometimes truncates the output mid-string (hits the output-token cap).
// Strategy: try JSON.parse first; if that fails and the text looks like
// `{ "pages": [ ... ` with an unterminated tail, salvage as many complete
// array entries as we can by walking nesting depth with a JSON-aware scanner.
function tryParseOrSalvage(raw) {
  try { return JSON.parse(raw); } catch {}
  // Locate '"pages"' array start.
  const m = raw.match(/"pages"\s*:\s*\[/);
  if (!m) throw new Error('JSON parse failed and no "pages" array to salvage');
  const arrStart = m.index + m[0].length;
  const entries = [];
  let i = arrStart, depth = 0, objStart = -1;
  let inStr = false, esc = false;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { entries.push(JSON.parse(raw.slice(objStart, i + 1))); } catch {}
        objStart = -1;
      }
      continue;
    }
    if (c === ']' && depth === 0) break;
  }
  if (!entries.length) throw new Error('JSON parse failed and salvage recovered 0 pages');
  return { pages: entries, _salvaged: true };
}

async function parsePageImage(imagePath, priorContext = '', recentAnsweredQuestions = [], documentOutline = '', userKindHint = null, knownHouseholds = [], knownAliases = [], handwritingCorrections = [], notebookGlossary = []) {
  const img = prepareImageForGemini(imagePath);
  const imageData = fs.readFileSync(img.filePath);
  const base64 = imageData.toString('base64');
  const mimeType = img.mimeType;

  const answeredBlock = recentAnsweredQuestions.length
    ? `The user has previously answered these questions — DO NOT ask them again, and use the answers where relevant:\n${recentAnsweredQuestions.map(q => `- Q: ${q.subject}  A: ${q.answer}`).join('\n')}\n\n`
    : '';
  const priorBlock = priorContext
    ? `Recently ingested pages (use ONLY to detect whether this page continues a prior collection — DO NOT extract entities from these summaries):\n${priorContext}\n\n`
    : '';
  const outlineBlockText = documentOutline
    ? `Document outline — headers glimpsed on every scan in this import, so you can see how collections flow and thread across pages (use ONLY for collection continuation/threading detection, NOT as a source of entities):\n${documentOutline}\n\n`
    : '';
  const kindPhrase = { book: 'a set of book notes', artifact: 'an artifact cover or description', reference: 'an external reference (article/URL/podcast) annotation' }[userKindHint];
  const userKindBlock = kindPhrase
    ? `The user has told Gloss that this scan is ${kindPhrase}. Emit AT LEAST ONE ${userKindHint}_hint with your best extraction of title/author/source from the page, even at moderate confidence. Do NOT refuse the hint because the page is a short note — the user explicitly declared its kind.\n\n`
    : '';
  const householdsBlock = knownHouseholds.length
    ? `Known households already on file (use these exact labels when the page mentions them — match possessives/plurals/"the X family" to the bare surname):\n${knownHouseholds.map(h => `- ${h}`).join('\n')}\n\n`
    : '';
  const aliasesBlock = knownAliases.length
    ? `Known person aliases — when the page mentions any of these nicknames/short names, emit the CANONICAL name as the person entity (do NOT ask who they are):\n${knownAliases.map(a => `- ${a.aliases.join(', ')} → ${a.canonical}`).join('\n')}\n\n`
    : '';
  const handwritingBlock = handwritingCorrections.length
    ? `Confirmed handwriting readings for this notebook — when you see these ambiguous forms, use the confirmed reading without asking:\n${handwritingCorrections.map(c => `- ${c.subject.replace(/^\[handwriting\]:\s*/i, '').replace(/\s*—.*$/, '').trim()} → "${c.answer}"`).join('\n')}\n\n`
    : '';
  const glossaryBlock = notebookGlossary.length
    ? `Notebook vocabulary — terms, abbreviations, and symbols with confirmed meanings. Do NOT ask about any of these:\n${notebookGlossary.map(g => `- ${g.term} → ${g.meaning}`).join('\n')}\n\n`
    : '';
  const userText = `${answeredBlock}${aliasesBlock}${glossaryBlock}${handwritingBlock}${priorBlock}${outlineBlockText}${householdsBlock}${userKindBlock}${PARSE_PROMPT}`;

  const response = await genai.models.generateContent({
    model: PARSE_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: userText }
      ]
    }],
    config: {
      systemInstruction: PARSE_SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 16384,
    }
  });

  const raw = (response.text || '').trim();
  img.cleanup?.();
  if (!raw) throw new Error('Gemini returned empty response');
  const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const parsed = tryParseOrSalvage(json);
  // Normalize to always have a pages array. Accept three shapes:
  //   A) { pages: [...] }                 (new, canonical)
  //   B) { is_spread: true, pages: [...]} (interim)
  //   C) { volume, page_number, ... }     (legacy single-page root)
  if (Array.isArray(parsed.pages) && parsed.pages.length > 0) return { pages: parsed.pages };
  return { pages: [parsed] };
}

const CHAT_SYSTEM = `You are Gloss, a quiet data-forward notebook companion.

Rules:
- NEVER quote the user's words verbatim. Use pointer-summaries only.
- ALWAYS cite sources using the → v.X p.Y format (volume X, page Y). If volume is unknown use → p.Y.
- Format responses as a Markdown numbered list, not conversational prose.
- Lead with a single summary line naming the count and what the query was about, then the list. Example: "Found 3 notes on prayer:".
- If nothing relevant is found, reply with a short sentence like "I don't have any notes matching that." — do not include bracketed placeholders.
- Maximum 10 items per response. If there are more, end with "(+N more — refine your query)".`;

async function chat(query, contextItems, notebookGlossary = []) {
  const contextBlock = contextItems.length === 0
    ? 'No relevant notes found.'
    : contextItems.map((item, i) => {
        const cite = item.volume ? `→ v.${item.volume} p.${item.page_number ?? '?'}` : `→ p.${item.page_number ?? '?'}`;
        return `[${i + 1}] [${item.kind}] ${item.text} ${cite} (page_id:${item.page_id})`;
      }).join('\n');
  const glossaryBlock = notebookGlossary.length
    ? `\n\nNotebook vocabulary (use these meanings when interpreting the query or notes):\n${notebookGlossary.map(g => `- ${g.term}: ${g.meaning}`).join('\n')}`
    : '';

  const response = await genai.models.generateContent({
    model: CHAT_MODEL,
    contents: [{
      role: 'user',
      parts: [{ text: `Query: ${query}\n\nAvailable context from the notebook:\n${contextBlock}${glossaryBlock}` }]
    }],
    config: {
      systemInstruction: CHAT_SYSTEM,
      temperature: 0.3,
      maxOutputTokens: 1024,
    }
  });

  return (response.text || '').trim();
}

const REEXAMINE_SYSTEM = `You are re-examining a notebook page you already parsed.

The user has just confirmed a new fact about this page (e.g. "X is a person named here" or "this refers to scripture Y").
Reconsider the page with that in mind. What did you miss or get wrong the first time?

Rules:
- Never quote the user's words verbatim. Use pointer-summaries only.
- ONLY emit entities/backlog items you are MORE confident about now than before.
- Don't re-list things already in "known_entities".
- Return ONLY valid JSON, no markdown fences.`;

async function reexaminePage(imagePath, knownEntities, newlyConfirmed, recentAnsweredQuestions = [], knownAliases = [], handwritingCorrections = [], notebookGlossary = [], rotation = 0) {
  const img = prepareImageForGemini(imagePath);
  const imageData = fs.readFileSync(img.filePath);
  const base64 = imageData.toString('base64');
  const mimeType = img.mimeType;

  // Rotation hint — the file on disk is the original (sometimes sideways) scan.
  // The user has marked this page as visually rotated by `rotation` degrees CW.
  // We tell the model so it reads the image in the orientation the user expects.
  // (Pre-rotating the bytes would require an image lib — deferred. See plan 1.7.)
  const rotationLine = rotation
    ? `\nORIENTATION HINT: this scan is stored at its original orientation but the user has rotated it ${rotation}° clockwise for display. Read the image as if it were rotated ${rotation}° clockwise — that is the correct top-of-page.`
    : '';

  const confirmLine = newlyConfirmed.kind === 'hint'
    ? `The user gave me this free-form hint about the page: "${newlyConfirmed.label}"${rotationLine}`
    : `The user just told me this page mentions: ${newlyConfirmed.kind} = "${newlyConfirmed.label}".${rotationLine}`;

  const answeredBlock = recentAnsweredQuestions.length
    ? `\n\nThe user has previously answered these questions (do NOT re-ask them, and DO use the answers to inform your reading):\n${recentAnsweredQuestions.map(q => `- Q: ${q.subject}  A: ${q.answer}`).join('\n')}`
    : '';
  const aliasesBlock = knownAliases.length
    ? `\n\nKnown person aliases (when the page names any of these nicknames/short names, emit the canonical person — do NOT queue a question):\n${knownAliases.map(a => `- ${a.aliases.join(', ')} → ${a.canonical}`).join('\n')}`
    : '';
  const handwritingBlock = handwritingCorrections.length
    ? `\n\nConfirmed handwriting readings — apply without asking:\n${handwritingCorrections.map(c => `- ${c.subject.replace(/^\[handwriting\]:\s*/i, '').replace(/\s*—.*$/, '').trim()} → "${c.answer}"`).join('\n')}`
    : '';
  const glossaryBlock = notebookGlossary.length
    ? `\n\nNotebook vocabulary (do NOT ask about these):\n${notebookGlossary.map(g => `- ${g.term} → ${g.meaning}`).join('\n')}`
    : '';

  const userText = `${confirmLine}

Reconsider the page in light of this. You have THREE powers:
1. ADD things you missed (new_entities, new_backlog_items).
2. EDIT things you got wrong (revisions — rename a person, replace a topic, rewrite the summary).
3. PRUNE — if the hint/answer makes a pending question obsolete, flag it.

Known entities already linked to this page:
${JSON.stringify(knownEntities, null, 2)}${answeredBlock}${aliasesBlock}${glossaryBlock}${handwritingBlock}

Return JSON in this exact shape:
{
  "new_entities": [
    { "kind": "person|scripture|topic", "label": "<string>",
      "book": "<scripture only>", "chapter": <int>, "verse_start": <int|null>, "verse_end": <int|null>,
      "confidence": <0.0-1.0> }
  ],
  "revisions": {
    "rename_people": [
      { "from": "<existing label exactly as in known_entities.people>", "to": "<new canonical label>" }
    ],
    "replace_topics": [
      { "from": "<existing topic label>", "to": "<corrected topic label>" }
    ],
    "rewrite_summary": "<new one-line pointer-summary for the page, or null if unchanged>"
  }
}

There is NO new_backlog_items field in the re-examine output. Re-examining is for correcting — if you have a follow-up question that the user hasn't answered, only emit it inside revisions if it's strictly needed.

Guidance:
- If the user's confirmation resolves an earlier ambiguity (e.g. they confirmed "Ron" — now you're sure "Ron's wife H—" is Heather), emit the now-confident entity under new_entities.
- If the user's hint RENAMES someone ("J— is Jake Thompson"), emit a revisions.rename_people entry AND make sure the new_entities contains the corrected full-name person. Do NOT leave both the old partial label and the new label linked.
- If the hint refocuses the page's topic ("this is about sabbath rest, not productivity"), emit a revisions.replace_topics entry AND optionally revisions.rewrite_summary.
- If the summary currently misses the thrust of the page given the hint, rewrite it (max 12 words, pointer-summary, no preambles).
- Be conservative: if nothing new is truly more confident, return {new_entities:[], revisions:{rename_people:[],replace_topics:[],rewrite_summary:null}}.`;

  const response = await genai.models.generateContent({
    model: PARSE_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: userText }
      ]
    }],
    config: {
      systemInstruction: REEXAMINE_SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 4096,
    }
  });

  const empty = { new_entities: [], revisions: { rename_people: [], replace_topics: [], rewrite_summary: null } };
  const raw = (response.text || '').trim();
  img.cleanup?.();
  if (!raw) return empty;
  const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(json);
    parsed.revisions = parsed.revisions || { rename_people: [], replace_topics: [], rewrite_summary: null };
    parsed.revisions.rename_people = parsed.revisions.rename_people || [];
    parsed.revisions.replace_topics = parsed.revisions.replace_topics || [];
    return parsed;
  } catch { return empty; }
}

const VOICE_SYSTEM = `You are parsing a voice-memo transcript for a personal knowledge system called Gloss.

The transcript is private raw material. Never quote the user's exact words verbatim in any extracted item.
Every item must be a pointer-summary, not a transcription.

Return ONLY valid JSON, no markdown fences, no commentary.`;

const VOICE_PROMPT = `Parse this voice-memo transcript and return JSON matching exactly this shape:

{
  "summary": "<3–5 sentences, written in first-person as the user would naturally describe this memo to themselves later. Capture what happened, why it mattered, and any emotional or evaluative color the user expressed. Do NOT quote verbatim. Do NOT start with 'I recorded' or 'This memo'. Start mid-thought, like journal notes — e.g. 'Met with Christian Stradley today...' or 'Worked through the tension between...'>",
  "items": [
    { "kind": "task|event|idea|quote|scripture_ref|prayer|prose_block", "text": "<pointer-summary max 20 words, NO verbatim quotation>", "confidence": <0.0-1.0> }
  ],
  "entities": [
    { "kind": "person|scripture|topic|date",
      "label": "<normalized>",
      "role_summary": "<one pointer-phrase, max 16 words, describing THIS entity's specific role in this memo — why the user mentioned them / how the verse / topic came up. NOT the whole memo summary. NEVER quote the user verbatim. Required for every entity.>",
      "book": "<scripture only>", "chapter": <int>, "verse_start": <int|null>, "verse_end": <int|null>
    }
  ],
  "backlog_items": [
    { "kind": "question|filing|link_proposal",
      "subject": "<short>",
      "proposal": "<full text>",
      "answer_format": "<required for question: short|long|choice>",
      "options": ["<only for choice>"]
    }
  ]
}

Rules:
- Entities must be mentioned in the transcript. Do not invent.
- Scripture labels: "Book Chapter" or "Book Chapter:Verse" with full book names.
- Topics: lowercase, singular ("formation", "sabbath").
- Keep items few and dense — voice memos ramble; the goal is pointer-summaries of substantive thoughts, not every phrase.`;

async function parseVoiceMemo(transcript, recentAnsweredQuestions = [], knownAliases = [], notebookGlossary = []) {
  const answeredBlock = recentAnsweredQuestions.length
    ? `The user has previously answered these — do NOT re-ask them:\n${recentAnsweredQuestions.map(q => `- Q: ${q.subject}  A: ${q.answer}`).join('\n')}\n\n`
    : '';
  const aliasesBlock = knownAliases.length
    ? `Known person aliases (when the transcript names any of these nicknames, emit the canonical person):\n${knownAliases.map(a => `- ${a.aliases.join(', ')} → ${a.canonical}`).join('\n')}\n\n`
    : '';
  const glossaryBlock = notebookGlossary.length
    ? `Notebook vocabulary — do NOT ask about these:\n${notebookGlossary.map(g => `- ${g.term} → ${g.meaning}`).join('\n')}\n\n`
    : '';
  const userText = `${answeredBlock}${aliasesBlock}${glossaryBlock}${VOICE_PROMPT}\n\nTRANSCRIPT:\n${transcript}`;
  const response = await genai.models.generateContent({
    model: PARSE_MODEL,
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    config: {
      systemInstruction: VOICE_SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 4096,
    }
  });
  const raw = (response.text || '').trim();
  if (!raw) throw new Error('Gemini returned empty response for voice memo');
  const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(json);
}

// Parse a user-authored markdown document as a single logical notebook page.
// Text is user's own prose (not OCR, not handwriting) — still a pointer-summary
// invariant applies: items/summary/role_summary never quote the markdown verbatim.
// Returns the same { pages: [PAGE_OBJECT] } shape as parsePageImage so the caller
// can reuse savePageFromParse and get full collection/book/artifact/reference
// hint handling, threading, page_refs, etc.
const MARKDOWN_SYSTEM = `You are parsing a user-authored markdown document for a personal knowledge system called Gloss.

The markdown is the user's own prose, typed directly into the app. Treat it with the same rules as a handwritten notebook page:
- Never quote the user's words verbatim in any extracted item, summary, or role_summary.
- Every items[].text is a pointer-summary (max 20 words).
- raw_ocr_text holds the full markdown exactly as written and is stored privately — never surfaced to downstream LLMs or to the UI except via the transcript endpoint.

Return ONLY valid JSON, no markdown fences, no commentary.`;

const MARKDOWN_PROMPT = `Parse this markdown document as ONE logical notebook page. Return the same top-level shape as handwritten-page parsing:

{ "pages": [ <PAGE_OBJECT> ] }   // exactly one entry — markdown is one logical page

PAGE_OBJECT shape (same as scan parsing, but volume/page_number/continued_from/continued_to are always null — markdown has no notebook position):
{
  "volume": null,
  "page_number": null,
  "continued_from": null,
  "continued_to": null,
  "raw_ocr_text": "<the full markdown exactly as the user typed it>",
  "summary": "<one pointer-phrase max 12 words. First-person the way the user would describe this note — 'thoughts on catechesis as scaffold', 'research notes on sabbath practice'. NEVER preambles like 'a markdown note about'.>",
  "collection_hints": [
    {
      "kind": "<daily_log|topical|monthly_log|future_log|index>",
      "label": "<normalized title>",
      "continuation": false,
      "confidence": <0.0-1.0>
    }
  ],
  "book_hints":     [ ... same shape as scan parsing ],
  "artifact_hints": [ ... same shape as scan parsing ],
  "reference_hints":[ ... same shape as scan parsing ],
  "items": [
    { "kind": "task|event|idea|quote|scripture_ref|prayer|prose_block|bibliographic_note",
      "text": "<pointer-summary max 20 words, NO verbatim>",
      "status": "<open|done|migrated|scheduled|cancelled|note — OMIT if not applicable>",
      "confidence": <0.0-1.0>
    }
  ],
  "page_refs": [],
  "entities": [
    { "kind": "person|household|scripture|topic|date",
      "label": "<normalized>",
      "role_summary": "<one pointer-phrase max 16 words, why this entity appears in this note. Required.>",
      "book": "<scripture only>", "chapter": <int>, "verse_start": <int|null>, "verse_end": <int|null>
    }
  ],
  "backlog_items": [ ... same shape as scan parsing ]
}

Guidance specific to markdown:
- If the first line is a top-level heading (# Title), use it as a TOPICAL collection_hint with that title (confidence 0.9). This is the normal case — markdown notes usually have a clear title.
- If the document is dated (an explicit YYYY-MM-DD date header, or the user passed a date in context), and the body reads like a daily journal entry, you may emit a daily_log collection_hint instead. Otherwise prefer topical.
- Markdown lists (- task, - [ ] task, - [x] done) map to items with kind="task" and status="open"/"done" as appropriate.
- Markdown blockquotes (> ...) are usually quotes — kind="quote" — but still pointer-summarize them.
- Checkbox syntax "- [x]" = status:"done", "- [ ]" = status:"open".
- Extract people / scripture / topic entities the same way as for scan pages (only what's actually in the text; never invent).
- If the markdown is obviously one thing (a topical note) and you have no other signals, emit ONE topical collection_hint. Empty collection_hints is only valid if the document is literally blank.

Subject formatting rules for backlog_items are the same as for scan parsing (e.g. person-ID questions must use the form: Who is "[name]"?).`;

async function parseMarkdownPage(markdown, { recentAnsweredQuestions = [], knownAliases = [], notebookGlossary = [], priorContext = '', userDate = null, userTitle = null } = {}) {
  const answeredBlock = recentAnsweredQuestions.length
    ? `The user has previously answered these — do NOT re-ask:\n${recentAnsweredQuestions.map(q => `- Q: ${q.subject}  A: ${q.answer}`).join('\n')}\n\n`
    : '';
  const aliasesBlock = knownAliases.length
    ? `Known person aliases (emit canonical when the document mentions any of these):\n${knownAliases.map(a => `- ${a.aliases.join(', ')} → ${a.canonical}`).join('\n')}\n\n`
    : '';
  const glossaryBlock = notebookGlossary.length
    ? `Notebook vocabulary — do NOT ask about these:\n${notebookGlossary.map(g => `- ${g.term} → ${g.meaning}`).join('\n')}\n\n`
    : '';
  const priorBlock = priorContext
    ? `Recently ingested pages (for collection-continuation detection only, NEVER a source of entities):\n${priorContext}\n\n`
    : '';
  const userContextBlock = (userDate || userTitle)
    ? `User-supplied context for this note:\n${userDate ? `- captured date: ${userDate}\n` : ''}${userTitle ? `- user-supplied title: ${userTitle}\n` : ''}\n`
    : '';
  const userText = `${answeredBlock}${aliasesBlock}${glossaryBlock}${priorBlock}${userContextBlock}${MARKDOWN_PROMPT}\n\nMARKDOWN:\n${markdown}`;

  const response = await genai.models.generateContent({
    model: PARSE_MODEL,
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    config: {
      systemInstruction: MARKDOWN_SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 8192,
    }
  });

  const raw = (response.text || '').trim();
  if (!raw) throw new Error('Gemini returned empty response for markdown');
  const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const parsed = tryParseOrSalvage(json);
  if (Array.isArray(parsed.pages) && parsed.pages.length > 0) return { pages: parsed.pages };
  return { pages: [parsed] };
}

// Fast header-only probe for a single scan. Used BEFORE the full parse on
// multi-page PDFs so every page-parser gets a document outline and can
// correctly detect when a collection bleeds across physical pages
// (e.g. a topical page that started earlier and continues without a header).
async function probePageHeader(imagePath) {
  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = imagePath.split('.').pop().toLowerCase();
  const mediaTypeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mimeType = mediaTypeMap[ext] || 'image/jpeg';

  const prompt = `Look at this notebook scan. It may contain one notebook page, a two-page spread, or multiple dated sections.

For each logical notebook page visible, report:
- its header (date, title, or "no header")
- the notebook page number printed somewhere on the page (often top corner), if visible
- bullet-journal THREADING markers:
  * bottom-LEFT corner: a small page number indicates this page CONTINUES FROM that page (e.g. bottom-left "36" means "this is continued from page 36").
  * bottom-RIGHT corner (or sometimes top-right): a small page number indicates this page CONTINUES TO that page (e.g. bottom-right "42" means "continued on page 42").
  These markers are small, often in a margin, and are NOT part of the page's main content. They let a topic thread span non-adjacent pages.

Return ONLY valid JSON in this exact shape (no markdown fences):
{
  "pages": [
    {
      "page_number": <integer printed on this page, or null>,
      "header": "<what's at the top — e.g. 'Mon Apr 20', '2026-04-15', 'Formation', 'Books to Read', or 'no header (continuation)' if the page has no visible title/date and appears to continue a prior page's thought>",
      "kind_guess": "<daily_log | topical | monthly_log | future_log | index | unclear>",
      "continuation": <true if the page has NO header and text starts mid-thought, false otherwise>,
      "continued_from": <integer page number in bottom-left corner, or null>,
      "continued_to": <integer page number in bottom-right / forward-marker corner, or null>
    }
  ]
}`;

  try {
    const response = await genai.models.generateContent({
      model: CHAT_MODEL,  // flash — probe needs to be cheap and fast
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: prompt }
        ]
      }],
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 512,
      }
    });
    const raw = (response.text || '').trim();
    if (!raw) return { pages: [] };
    const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    return { pages: Array.isArray(parsed.pages) ? parsed.pages : [] };
  } catch (err) {
    // Probe failures are non-fatal — fall back to no outline hint for this page.
    console.warn('probe failed:', err.message);
    return { pages: [] };
  }
}

// Phase 4.5 — multi-turn assistant with bounded action catalog.
// The model returns ONE of two top-level shapes:
//   { "text": "<plain answer with → v.X p.Y citations>" }
//   { "action": { "name": "<action_name>", "args": {...}, "rationale": "<why>" } }
// Never both. Actions are proposed, not executed. The server validates.
const ASSISTANT_SYSTEM = `You are Gloss, the user's notebook assistant. You can answer with text OR propose a single bounded action; never both.

NEVER quote the user's notebook prose verbatim — every reference must be a pointer-summary. Cite sources as → v.X p.Y (or → p.Y if volume unknown).

Reply by emitting ONE valid JSON object, no markdown fences. The object MUST have exactly one of these top-level keys:

1. {"text": "<your answer>"}
   Use when the user is asking a question, requesting a summary, or chatting. Format multi-item answers as a numbered list. Maximum 10 items per response.

2. {"action": {"name": "...", "args": {...}, "rationale": "..."}}
   Use when the user is asking you to MUTATE notebook state. Propose exactly one action; the user confirms with Accept/Reject before it runs.

Allowed actions and their args:
- rename_entity { kind: 'person'|'topic'|'scripture'|'collection'|'book', id: string, new_label: string }
- merge_entities { kind: ..., source_id: string, target_id: string }
- add_person_alias { person_id: string, alias: string }
- link_page_to_collection { page_id: string, collection_id: string }
- unlink { link_id: string }
- refine_page { page_id: string, hint: string }
- edit_page_summary { page_id: string, new_summary: string }
- set_parent { kind: 'topic'|'collection'|'person'|'artifact', id: string, parent_id: string|null }
- remember { key: string, value: string }

Rules:
- If the user mentions an entity by name, do NOT guess an id — first ask a clarifying text question to disambiguate, OR rely on the resolved-mentions block in the context.
- "rationale" should be one short sentence the user can read to confirm intent.
- For "remember", use snake_case keys like "prefer_title_case_topics".
- If you cannot help (action out of scope, ambiguous), reply with text explaining why.`;

async function chatWithActions({ history, contextItems = [], notebookGlossary = [], memory = [], pinnedPage = null }) {
  const contextBlock = contextItems.length === 0
    ? 'No relevant notes found from search.'
    : contextItems.map((item, i) => {
        const cite = item.volume ? `→ v.${item.volume} p.${item.page_number ?? '?'}` : `→ p.${item.page_number ?? '?'}`;
        return `[${i + 1}] [${item.kind}] ${item.text} ${cite} (page_id:${item.page_id || ''})`;
      }).join('\n');
  const glossaryBlock = notebookGlossary.length
    ? `\n\nNotebook vocabulary:\n${notebookGlossary.map(g => `- ${g.term}: ${g.meaning}`).join('\n')}`
    : '';
  const memBlock = memory.length
    ? `\n\nDurable memory:\n${memory.map(m => `- ${m.key} = ${m.value}`).join('\n')}`
    : '';
  const pinnedBlock = pinnedPage
    ? `\n\nPINNED PAGE (the user pinned this page to scope the conversation):\npage_id=${pinnedPage.id} ${pinnedPage.volume ? '→ v.'+pinnedPage.volume+' p.'+(pinnedPage.page_number ?? '?') : ''}\nsummary: ${pinnedPage.summary || '(none)'}\n`
    : '';

  // Compose multi-turn contents from history (capped to last 15 turns).
  const recent = history.slice(-15);
  const contents = recent.map(m => ({
    role: m.role === 'assistant' || m.role === 'action' ? 'model' : 'user',
    parts: [{ text: m.role === 'action' ? `(previously proposed action: ${m.proposal_json || ''}${m.status ? ' ['+m.status+']' : ''})` : (m.body || '') }],
  }));

  // Tack the context onto the last user turn so the model has it fresh.
  if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
    const last = contents[contents.length - 1];
    last.parts[0].text += `\n\n--- Context for this turn ---\n${contextBlock}${glossaryBlock}${memBlock}${pinnedBlock}`;
  }

  let raw = '';
  try {
    const response = await genai.models.generateContent({
      model: CHAT_MODEL,
      contents,
      config: {
        systemInstruction: ASSISTANT_SYSTEM,
        temperature: 0.3,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    });
    raw = (response.text || '').trim();
  } catch (err) {
    return { kind: 'text', text: `(model error: ${err.message || err})` };
  }

  if (!raw) return { kind: 'text', text: '(no response)' };
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.action && typeof parsed.action === 'object' && parsed.action.name) {
      return { kind: 'action', action: parsed.action };
    }
    if (typeof parsed.text === 'string') return { kind: 'text', text: parsed.text };
    // Fallback: treat the whole response as text if shape is unrecognized.
    return { kind: 'text', text: cleaned };
  } catch {
    return { kind: 'text', text: cleaned };
  }
}

// --- Phase 6: AI-described indexes, classification, meta-category suggestions ---

const INDEX_STRUCTURE_SYSTEM = `You are designing a hierarchical index for a personal notebook.

The notebook is sovereign — NEVER quote the user's prose. All labels and descriptions you produce must be YOUR words, not theirs.

Do not name slots after entities that appear on the majority of pages in the vault (e.g. "God" or "Bible" in a theology index). Those are background, not signal — they would collect every page and narrow nothing. Favor specific sub-topics that genuinely partition the index's scope.

Return ONLY valid JSON, no markdown fences, no commentary.`;

const INDEX_STRUCTURE_PROMPT = `The user wants a new index for their notebook, described as:

"{{description}}"

Design a useful hierarchical structure. Hard limits:
- Maximum DEPTH of 3 levels (root → child → grandchild). Prefer 2 levels unless the domain truly needs more.
- Maximum 12 children at the root level (fewer is fine — 6-10 is typical).
- Maximum 8 children under any single non-root node.
- Each node needs a short label (2-6 words, title case) and a one-sentence description the classifier will use to decide whether a notebook page belongs under it.

Return JSON exactly in this shape:
{
  "root_description": "<1-2 sentence description of the whole index, in your own words>",
  "children": [
    {
      "label": "<short title case label>",
      "description": "<one-sentence description — WHAT kind of page belongs here. Be specific enough that a classifier can tell this slot from its siblings.>",
      "children": [
        { "label": "...", "description": "...", "children": [] }
      ]
    }
  ]
}

Leaf nodes (no children) have "children": [].

Good description: "Pages dealing with the doctrine of Scripture — inspiration, canon, inerrancy, interpretation, and its authority."
Bad description: "Bibliology." (just restates the label)
Bad description (verbatim user language): a direct quote from the user's prompt.`;

async function generateIndexStructure(description) {
  const userText = INDEX_STRUCTURE_PROMPT.replace('{{description}}', description || '');
  const response = await genai.models.generateContent({
    model: CHAT_MODEL,
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    config: {
      systemInstruction: INDEX_STRUCTURE_SYSTEM,
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  });
  const raw = (response.text || '').trim();
  if (!raw) throw new Error('Gemini returned empty response for index structure');
  const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(json);
  parsed.root_description = parsed.root_description || '';
  parsed.children = Array.isArray(parsed.children) ? parsed.children : [];
  // Enforce depth limit defensively.
  function trim(node, depth) {
    node.children = Array.isArray(node.children) ? node.children : [];
    if (depth >= 3) node.children = [];
    node.children.forEach(c => trim(c, depth + 1));
  }
  parsed.children.forEach(c => trim(c, 2));
  return parsed;
}

const CLASSIFY_SYSTEM = `You are classifying a notebook page into a set of candidate index slots.

Never quote the user's prose verbatim. Your role_summary output must be YOUR words describing WHY the page fits a slot, not a transcription of the page.

Return ONLY valid JSON, no markdown fences.`;

async function classifyPageForIndexes({ pageSummary, items, candidateLeaves }) {
  // candidateLeaves: [{ id, label, description, path: "Root > Parent > Leaf" }]
  const leavesBlock = candidateLeaves.map((l, i) =>
    `[${i + 1}] id=${l.id}  "${l.path}"\n    ${l.description || '(no description)'}`
  ).join('\n\n');
  const itemsBlock = (items || []).slice(0, 40).map(it => `- [${it.kind}] ${it.text}`).join('\n');

  const userText = `A notebook page needs to be classified against candidate index slots.

Page summary: ${pageSummary || '(no summary)'}

Page items (pointer-summaries):
${itemsBlock || '(no items)'}

Candidate index slots:
${leavesBlock}

For each slot the page plausibly belongs in, return an entry. Skip slots that don't fit.

Rules:
- Only include a slot if the page genuinely belongs there. False positives pollute the index — be conservative.
- confidence ∈ [0.0, 1.0]. Use ≥0.80 only when the fit is unmistakable. 0.50-0.75 for "probably fits, user should confirm". Below 0.50 — don't include.
- role_summary MUST explain (in your words, max 18 words) WHY this page fits this slot. Example for a slot "Bibliology": "Notes on the doctrine of Scripture's authority over tradition." NOT: "A daily log from April 20."

Return JSON:
{
  "matches": [
    { "id": "<slot id>", "confidence": <0.0-1.0>, "role_summary": "<why this page fits this slot>" }
  ]
}

If nothing fits, return {"matches": []}.`;

  try {
    const response = await genai.models.generateContent({
      model: CHAT_MODEL,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: CLASSIFY_SYSTEM,
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    });
    const raw = (response.text || '').trim();
    if (!raw) return { matches: [] };
    const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    return { matches: Array.isArray(parsed.matches) ? parsed.matches : [] };
  } catch (err) {
    console.warn('classifyPageForIndexes failed:', err.message);
    return { matches: [] };
  }
}

const META_SUGGEST_SYSTEM = `You are proposing meta-category indexes for a personal notebook.

The user has lots of small index rows (topics, people, collections, books). Your job is to propose 3-7 groupings that would usefully cluster them.

Return ONLY valid JSON, no markdown fences.`;

async function suggestMetaCategories(indexRowSample) {
  // indexRowSample: [{ kind, id, label }]
  const rowsBlock = indexRowSample.map(r => `- [${r.kind}] id=${r.id}  "${r.label}"`).join('\n');
  const userText = `Here is a sample of the user's existing index rows across kinds:

${rowsBlock}

Propose between 3 and 7 meta-category indexes — higher-level groupings that would meaningfully cluster these rows. Each proposal should have:
- a short title (2-5 words, title case)
- a one-sentence description (your words, not the user's)
- a list of candidate children (pulled from the rows above) you'd start the index with

Be selective. Only propose a grouping if it truly illuminates structure in the data — don't force 7 if only 3 are useful.

Return JSON:
{
  "proposals": [
    {
      "title": "<short title>",
      "description": "<one-sentence description>",
      "candidate_children": [
        { "kind": "<kind from rows>", "id": "<id from rows>", "label": "<label from rows>" }
      ]
    }
  ]
}`;

  try {
    const response = await genai.models.generateContent({
      model: CHAT_MODEL,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: META_SUGGEST_SYSTEM,
        responseMimeType: 'application/json',
        temperature: 0.4,
        maxOutputTokens: 2048,
      },
    });
    const raw = (response.text || '').trim();
    if (!raw) return { proposals: [] };
    const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    return { proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [] };
  } catch (err) {
    console.warn('suggestMetaCategories failed:', err.message);
    return { proposals: [] };
  }
}

// --- Cross-kind auto-linking (collection ↔ artifact ↔ reference ↔ daily_log) ---

const CROSS_KIND_SYSTEM = `You are judging whether two notebook "index rows" are substantively related.

Index rows come in four kinds: collection (user-grouped pages on one topic), artifact (filed physical material — sermons, handouts, SOPs), reference (external resource — URL, article, book, podcast), daily_log (a dated journal entry).

A link means: when the user is looking at one of these, seeing the other will actually help them. Shared proper noun does NOT imply link. Two dated entries on the same day do NOT imply link. Two sermons in the same series DO imply link. An article about habit formation and a collection titled "Habits" DO imply link.

The notebook is sovereign — NEVER quote the user's prose verbatim. Your role_summary values must be YOUR words (max 18 words) describing WHY the two rows belong together, not transcriptions of either row.

Return ONLY valid JSON, no markdown fences.`;

async function classifyRowForCrossKind({ fromRow, candidates }) {
  const fromBlock = `KIND: ${fromRow.kind}\nLABEL: ${fromRow.label || '(no label)'}\nDESCRIPTION: ${fromRow.description || '(none)'}`;
  const candidatesBlock = (candidates || []).slice(0, 40).map((c, i) =>
    `[${i + 1}] kind=${c.kind} id=${c.id}\n    label: ${c.label || '(no label)'}\n    description: ${c.description || '(none)'}`
  ).join('\n\n');

  const userText = `FROM row (the one we're looking for related material for):

${fromBlock}

CANDIDATE rows (up to 40, pre-filtered by keyword overlap):

${candidatesBlock || '(none)'}

For each candidate that is substantively related to the FROM row, return an entry. Skip candidates that share only surface keywords.

Rules:
- confidence ∈ [0.0, 1.0]. Use ≥0.80 only when the relationship is unmistakable. 0.50–0.74 for "probably related, user should confirm". Below 0.50 — skip entirely.
- role_summary MUST explain (in your words, max 18 words) why the two rows belong together, oriented from the FROM row's perspective. Example for a collection "Sabbath Rhythms" linked to an artifact "Sermon: Mark 2 Sabbath": "Sermon handout develops the theology underlying these Sabbath practice notes."

Return JSON:
{
  "matches": [
    { "kind": "<candidate kind>", "id": "<candidate id>", "confidence": <0.0-1.0>, "role_summary": "<why related>" }
  ]
}

If nothing fits, return {"matches": []}.`;

  try {
    const response = await genai.models.generateContent({
      model: CHAT_MODEL,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: CROSS_KIND_SYSTEM,
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    });
    const raw = (response.text || '').trim();
    if (!raw) return { matches: [] };
    const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    return { matches: Array.isArray(parsed.matches) ? parsed.matches : [] };
  } catch (err) {
    console.warn('classifyRowForCrossKind failed:', err.message);
    return { matches: [] };
  }
}

// --- Topical (back-of-book) user-index rebuild ---

const TOPICAL_ENTRIES_SYSTEM = `You are curating a topical back-of-book index for a personal notebook.

The user has created a topical index (e.g. "theology", "spiritual disciplines"). Your job: given a pool of candidate entries (people, topics, scripture, collections, artifacts, references), decide which ones genuinely belong — and which are noise.

An entry is NOISE if it does not narrow the index. Example: "Bible" or "God" in a theology index appears on every theological page and therefore partitions nothing — reject. "Incarnation" narrows and is signal — accept. Always honor the provided indexDescription as the scope.

The notebook is sovereign — NEVER quote the user's prose. All role_summary and why_included / reason fields are YOUR words (≤18 words each).

Return ONLY valid JSON, no markdown fences.`;

async function generateTopicalIndexEntries({ indexTitle, indexDescription, candidates, totalPages }) {
  const candBlock = (candidates || []).slice(0, 200).map((c, i) =>
    `[${i + 1}] kind=${c.kind} id=${c.id} label="${c.label || ''}" pages=${c.page_count || 0}`
  ).join('\n');

  const userText = `Index title: "${indexTitle || ''}"
Index description / scope: ${indexDescription || '(no description — use the title as the scope)'}
Total pages in vault: ${totalPages || 'unknown'}

Candidate entries (already pre-filtered for surface overlap):

${candBlock || '(none)'}

For each candidate, decide:
- ENTRY — belongs in this index because it narrows the scope meaningfully.
- REJECT — doesn't belong, or is omnipresent noise that would not help the user find anything specific.

Rules:
- Reject anything that appears on a majority of pages for a vault-wide theme — those are background, not signal.
- Reject candidates that only share a surface keyword with the index title but are off-scope (e.g. "faithful" the adjective in a dog-breeds collection shouldn't land in a theology index).
- Each ENTRY needs a role_summary (your words, ≤18 words) explaining WHY it's in this index from the index's perspective. E.g. for "Atonement" in a theology index: "Centers the index's treatment of reconciliation, substitution, and the cross's scope."
- Each REJECT needs a short reason (≤12 words).

Return JSON:
{
  "entries":  [{ "kind": "<kind>", "id": "<id>", "role_summary": "<why in>", "why_included": "<1-line rationale>" }],
  "rejected": [{ "kind": "<kind>", "id": "<id>", "reason": "<why out>" }]
}`;

  try {
    const response = await genai.models.generateContent({
      model: CHAT_MODEL,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: TOPICAL_ENTRIES_SYSTEM,
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 4096,
      },
    });
    const raw = (response.text || '').trim();
    if (!raw) return { entries: [], rejected: [] };
    const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
    };
  } catch (err) {
    console.warn('generateTopicalIndexEntries failed:', err.message);
    return { entries: [], rejected: [] };
  }
}

// Transcribe a recorded audio file (webm / mp4 / aac / m4a / wav) into a
// plain-text transcript via Gemini flash. Returns the trimmed transcript
// string. Throws on empty response. Used by /api/ingest/voice-audio which
// then hands the transcript off to parseVoiceMemo for the real entity
// extraction — this call is intentionally narrow: audio → text, nothing
// else. Keeping transcription separate means the pointer-summary /
// entity-extraction prompts stay single-purpose and testable.
async function transcribeAudio(audioPath, mimeType) {
  const data = fs.readFileSync(audioPath);
  const base64 = data.toString('base64');
  const response = await genai.models.generateContent({
    model: CHAT_MODEL,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this voice memo exactly as spoken. Output only the transcript text — no commentary, no timestamps, no speaker labels, no markdown fences. Preserve the speaker\'s actual words; do not summarize.' },
      { inlineData: { mimeType, data: base64 } },
    ]}],
    config: {
      temperature: 0.0,
      maxOutputTokens: 8192,
    },
  });
  const text = (response.text || '').trim();
  if (!text) throw new Error('Gemini returned empty transcript for audio');
  return text;
}

module.exports = {
  parsePageImage, chat, chatWithActions, reexaminePage, parseVoiceMemo, parseMarkdownPage, probePageHeader,
  generateIndexStructure, classifyPageForIndexes, suggestMetaCategories,
  classifyRowForCrossKind, generateTopicalIndexEntries, transcribeAudio,
};
