// One-shot: seed roles/areas from Weekly Compass Companion and tag existing pages as Volume D.
// Idempotent: upsert by (kind,label). Loading db.js applies pending migrations.
const db = require('../db');
const crypto = require('crypto');

const SEED = [
  {
    role: 'Valor',
    focus: 'Brilliant at the basics. Crystal clarity.',
    areas: [
      ['Protect & advance mission', 'Every classroom, hire, and conversation moves students toward the mission.'],
      ['Hire & keep good teachers', "Every teacher unified around Valor's mission and statement of faith."],
      ['Develop strong culture', 'Students, faculty, and parents marked by joy in the Lord, curiosity, and fortitude.'],
      ['Report honestly to board', 'Give the board the truth, not a polished version. Surface problems early.'],
      ['Admit right families', 'Families understand and reinforce the mission at home — not just comfortable with it.'],
      ['Solid financial footing', 'Financially healthy — not dependent on annual fundraising or below-market pay.'],
      ['Space conducive to mission', 'The building is clean, aesthetic, and ready for teachers and students.'],
    ],
  },
  {
    role: 'Christ the King',
    focus: 'Mobilize members for good works.',
    areas: [
      ['Know the sheep', 'Be hospitable. Pray for them regularly. Really know them. Ensure emergency pastoral care happens.'],
      ['Feed the sheep', "Preach and teach God's word. Plan and lead services. Encourage and exhort."],
      ['Lead the sheep', 'Model a godly life. Oversee day-to-day operations. Develop strategy with the Lead Pastor and elders.'],
      ['Protect the sheep', 'Warn about false doctrine and refute it. Lead membership classes.'],
    ],
  },
  {
    role: 'Home',
    focus: 'Talkative marriage.',
    areas: [
      ['Loving marriage', 'Maddie is my delight. Filled with admiration for one another. We chat naturally.'],
      ['Children raised in the Lord', "Kids love God's law and follow it from the heart. On track to be prepared for marriage by 18."],
      ['Take dominion of property', "Our home and cars are ordered, cared for, and useful for the family's mission."],
      ['Financially independent', 'Living well within our means, saving, generous with others, on track for retirement.'],
    ],
  },
  {
    role: 'Personal',
    focus: 'Personal integrity. Keep promises to myself.',
    areas: [
      ['Joy in the Lord', 'A vibrant walk with God. Bible, meditation, and prayer every morning first thing.'],
      ['Mental acuity & knowledge', 'Focused, undistracted life. Read a chapter every day. Do my own thinking and writing.'],
      ['Physical health & strength', 'Wake up early, work out hard, in control of body and passions.'],
      ['Personal integrity', "Keep promises to myself. Do the right thing even when it's hard."],
    ],
  },
];

function upsertRoleOrArea(kind, label, { current_focus, standard, priority }) {
  const existing = db.getEntityByKindLabel(kind, label);
  if (existing) {
    db.updateEntity(existing.id, { label, current_focus, standard });
    // updateEntity doesn't touch priority → set directly.
    require('better-sqlite3');
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.upsertEntity({ id, kind, label });
  db.updateEntity(id, { label, current_focus, standard });
  return id;
}

const better = require('better-sqlite3');
const raw = new better(require('path').join(__dirname, '..', 'data', 'foxed.db'));
const setPriority = raw.prepare(`UPDATE entities SET priority = ? WHERE id = ?`);

let rolePriority = 1;
for (const { role, focus, areas } of SEED) {
  const roleId = upsertRoleOrArea('role', role, { current_focus: focus, standard: null });
  setPriority.run(rolePriority++, roleId);
  let areaPriority = 1;
  for (const [label, standard] of areas) {
    const areaId = upsertRoleOrArea('area', label, { current_focus: null, standard });
    setPriority.run(areaPriority++, areaId);
    try { db.linkRoleToArea(roleId, areaId); } catch (e) { console.warn('link failed:', label, e.message); }
  }
}

// Tag all existing pages as Volume D.
const upd = raw.prepare(`UPDATE pages SET volume = 'D' WHERE volume IS NULL OR volume = '' OR typeof(volume) = 'integer'`);
const r = upd.run();
console.log(`pages updated to Volume D: ${r.changes}`);

// Verify.
const roles = db.listRolesWithAreas();
console.log(`\nRoles now (${roles.length}):`);
for (const role of roles) {
  console.log(`  [${role.priority}] ${role.label}${role.current_focus ? '  — focus: ' + role.current_focus : ''}`);
  for (const a of role.areas) {
    console.log(`      [${a.priority}] ${a.label}${a.standard ? ' — ' + a.standard.slice(0, 50) + '…' : ''}`);
  }
}
raw.close();
