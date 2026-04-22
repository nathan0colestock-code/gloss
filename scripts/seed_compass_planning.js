// One-shot: seed Mission, Habits, and Relationships from the Weekly Compass.
// Companion to seed-compass.js (values + long-range goals) and
// seed_roles_volume.js (roles + areas). Idempotent: skips anything that
// already exists by label/body match. Run after the other two seeds.
//
// Usage:  node scripts/seed_compass_planning.js
//
// What it seeds:
//   - Mission       → values_versions slug='mission' (append-only)
//   - Habits        → habits table, tagged to a role_id when obvious
//   - Relationships → people table, marked with priority=1 and a growth note

const crypto = require('crypto');
const db = require('../db');

// ── Mission ────────────────────────────────────────────────────────────────
const MISSION_BODY =
  "Make disciples who glorify God in all of life by knowing, feeding, leading, " +
  "and protecting God's people. Know. Feed. Lead. Protect.";

// ── Habits ─────────────────────────────────────────────────────────────────
// The habits table is daily-checkable (one row per day), but the Compass has
// weekly/monthly/quarterly/annual rhythms. The pragmatic compromise: store
// the cadence in the label so the user sees it on the scorecard, and check
// each habit off on the day it actually happens. The user can later refine.
const HABITS = [
  // Weekly
  { label: '[Weekly] Evening of special time with Maddie', role: 'Home' },
  { label: '[Weekly] Family night',                         role: 'Home' },
  // Monthly
  { label: '[Monthly] One hour one-on-one with each kid',   role: 'Home' },
  { label: '[Monthly] Out-date with Maddie',                role: 'Home' },
  { label: '[Monthly] Read and discuss a book with Maddie', role: 'Home' },
  // Quarterly
  { label: '[Quarterly] Family day trip',                   role: 'Home' },
  { label: '[Quarterly] Plan a "big date" for me and Maddie', role: 'Home' },
  // Annually
  { label: '[Annually] Medical and dental exam',            role: 'Personal' },
  { label: '[Annually] Long family weekend',                role: 'Home' },
  { label: '[Annually] Take Maddie away for 1-2 nights',    role: 'Home' },
  // Longer-than-annual
  { label: '[Longer] Take Maddie away for 2-3 nights',      role: 'Home' },
  { label: '[Longer] Take Maddie away 4-6 nights somewhere special', role: 'Home' },
];

// ── Relationships to Improve ───────────────────────────────────────────────
// Names listed under "Relationships to Improve" in the Compass. The file's
// "How I want it to grow / next step" column was empty in the export, so we
// seed each person with a default growth note the user can refine in-app.
const RELATIONSHIPS = [
  'Jake Thompson',
  'Clint Manley',
  'Andrew Wittenberg',
  'Nick Bruggeman',
  'Jackie Thorne',
  'Levi Secord',
  'Tom Dippel',
  'Jake Lee',
  'Dustin Williams',
  'Andy Naselli',
  'Tom Dodds',
  'Michelle Hendron',
];
const DEFAULT_GROWTH_NOTE =
  'Relationship to grow — Compass priority. Add the next step here.';

// ── Seed Mission ───────────────────────────────────────────────────────────
let missionResult = 'skipped';
const currentMission = db.getCurrentMission();
if (currentMission && currentMission.body && currentMission.body.trim() === MISSION_BODY.trim()) {
  console.log('  skip mission: already current');
} else {
  db.setMission(MISSION_BODY);
  missionResult = currentMission ? 'updated (new version)' : 'created';
  console.log(`  mission: ${missionResult}`);
}

// ── Seed Habits ────────────────────────────────────────────────────────────
const existingHabits = new Set(
  db.listHabits({ includeArchived: true }).map(h => (h.label || '').toLowerCase())
);
const roleByLabel = {};
for (const r of db.listRolesWithAreas()) roleByLabel[r.label] = r.id;

let habitsAdded = 0;
let sortOrder = 1;
for (const h of HABITS) {
  if (existingHabits.has(h.label.toLowerCase())) {
    console.log(`  skip habit: ${h.label.slice(0, 50)}… (exists)`);
    sortOrder++;
    continue;
  }
  const role_id = roleByLabel[h.role] || null;
  if (h.role && !role_id) {
    console.warn(`  warn: role "${h.role}" not found — habit "${h.label}" seeded without role`);
  }
  db.createHabit({
    id: crypto.randomUUID(),
    label: h.label,
    role_id,
    sort_order: sortOrder++,
  });
  habitsAdded++;
}

// ── Seed Relationships ─────────────────────────────────────────────────────
let peopleAdded = 0;
let peopleAnnotated = 0;
for (const name of RELATIONSHIPS) {
  const existing = db.listPeople().find(p => (p.label || '').toLowerCase() === name.toLowerCase());
  if (existing) {
    // Already in the people table from earlier ingest. Bump priority and add
    // a growth note only if the person doesn't already have one — don't
    // clobber notes the user has already written.
    const needsNote = !existing.growth_note;
    const needsPriority = !existing.priority || existing.priority < 1;
    if (needsNote || needsPriority) {
      db.updatePerson(existing.id, {
        priority: needsPriority ? 1 : undefined,
        growth_note: needsNote ? DEFAULT_GROWTH_NOTE : undefined,
      });
      peopleAnnotated++;
      console.log(`  annotate person: ${name} (priority+note)`);
    } else {
      console.log(`  skip person: ${name} (exists, already prioritized)`);
    }
    continue;
  }
  const p = db.upsertPerson({ label: name });
  db.updatePerson(p.id, { priority: 1, growth_note: DEFAULT_GROWTH_NOTE });
  peopleAdded++;
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(
  `\nSeed complete: mission ${missionResult}, ` +
  `+${habitsAdded} habit${habitsAdded === 1 ? '' : 's'}, ` +
  `+${peopleAdded} new relationship${peopleAdded === 1 ? '' : 's'}, ` +
  `${peopleAnnotated} relationship${peopleAnnotated === 1 ? '' : 's'} annotated.`
);
