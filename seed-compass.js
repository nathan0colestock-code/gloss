// One-shot seed from "Weekly Compass Companion" attachment.
// Safe to run multiple times — skips slugs/texts that already exist.

const crypto = require('crypto');
const db = require('./db');

const values = [
  { slug: 'piety',       title: 'Piety',       category: 'Character', position: 1,
    body: "I love God with all my heart, soul, mind, and strength. I pray often. My whole life is aimed at showing off his glory and making more disciples who follow him." },
  { slug: 'charity',     title: 'Charity',     category: 'Character', position: 2,
    body: "I love my neighbor as myself. I look first to the interests of others. I don't look over people or treat them as less important than what I am doing." },
  { slug: 'obedience',   title: 'Obedience',   category: 'Character', position: 3,
    body: "I follow God's law. If he says it, I believe it and act on it. I don't argue with God's ways. I love them — and when I don't love them yet, I learn to love them." },
  { slug: 'humility',    title: 'Humility',    category: 'Character', position: 4,
    body: "I don't think of myself often. When I do, I don't think too highly of myself. In my eyes, God is big and I am small. I don't look down on others because I'm too busy loving them." },
  { slug: 'discipline',  title: 'Discipline',  category: 'Character', position: 5,
    body: "I do the right thing even when it's hard. I wake up early and work out hard. I'm hard to distract. I'm in control of my body, mind, and passions." },

  { slug: 'marriage',    title: 'Marriage',    category: 'Household', position: 6,
    body: "My marriage is simply fantastic. We love being together. Filled with delight and admiration for one another." },
  { slug: 'maddie',      title: 'Maddie',      category: 'Household', position: 7,
    body: "My wife is flourishing. Constantly growing in faith, love, holiness, beauty, and intellect." },
  { slug: 'family',      title: 'Family',      category: 'Household', position: 8,
    body: "We have so much fun. Constantly joyful and enjoying one another and God's world. Catch, ice cream, dance, vacation, snuggle." },
  { slug: 'kids',        title: 'Kids',        category: 'Household', position: 9,
    body: "My children are flourishing. They love God's law and follow it from the heart. Fruits of the Spirit. On track for marriage by 18." },
  { slug: 'fin-ind',     title: 'Financial independence', category: 'Household', position: 10,
    body: "We live well within our means, save for the future, are generous with others, and will have plenty for retirement." },
  { slug: 'hospitable',  title: 'Hospitable',  category: 'Household', position: 11,
    body: "I share my life with others. Close friends and close family friends. We open our home and lives to those in our circles." },

  { slug: 'wisdom',      title: 'Wisdom',      category: 'Vocation',  position: 12,
    body: "I live a focused, undistracted life. Reading, writing, and deep thought are some of my deepest joys. In the age of AI, I'm a dinosaur who does his own thinking and writing." },
  { slug: 'lead',        title: 'Lead',        category: 'Vocation',  position: 13,
    body: "I am an effective leader with substantial influence and the capability to 'lead the charge.' I'm good at influencing people, and my track record speaks for itself." },
  { slug: 'feed',        title: 'Feed',        category: 'Vocation',  position: 14,
    body: "My preaching, teaching, and writing is a blessing to my church and those beyond. I'm good at writing and speaking, and it feels natural to me." },
];

const goals = [
  { text: 'Complete first You Are Your Own Gym program.',                        target_date: '2026-06-28', value_slug: 'discipline' },
  { text: 'Finish writing the rest of the 2026 sermons.',                        target_date: '2026-07-05', value_slug: 'feed' },
  { text: 'Create & disseminate Valor vision / marketing docs.',                 target_date: '2026-08-31', value_slug: 'lead' },
  { text: 'Maddie identifies governing values + plans each day.',                target_date: '2026-08-31', value_slug: 'maddie' },
  { text: 'Long-range goal and accountability system for each man.',             target_date: '2026-08-31', value_slug: 'lead' },
  { text: 'Submit plan to make Valor financially stable.',                       target_date: '2027-01-31', value_slug: 'lead' },
  { text: 'Self-publish Ezra-Nehemiah sermon series.',                           target_date: '2027-01-31', value_slug: 'feed' },
  { text: 'Top-notch SOPs for every Valor admin process.',                       target_date: '2027-05-30', value_slug: 'lead' },
  { text: 'Top-notch SOPs for every CtK admin process.',                         target_date: '2027-05-30', value_slug: 'lead' },
  { text: 'Debt-free (minus mortgage); Bahnsen contribution to $1M to kids.',    target_date: '2027-09-04', value_slug: 'fin-ind' },
  { text: 'Sight-read hymns on piano.',                                          target_date: '2028-12-31', value_slug: 'wisdom' },
  { text: 'House paid off (ten years early).',                                   target_date: '2045-01-01', value_slug: 'fin-ind' },
];

let valuesAdded = 0, goalsAdded = 0;
const existingValues = new Set(db.currentValues().map(v => v.slug));
for (const v of values) {
  if (existingValues.has(v.slug)) { console.log(`  skip value: ${v.slug} (exists)`); continue; }
  db.createValue({ id: crypto.randomUUID(), ...v });
  valuesAdded++;
}

const existingCommits = new Set(db.listCommitments().map(c => c.text.toLowerCase()));
for (const g of goals) {
  if (existingCommits.has(g.text.toLowerCase())) { console.log(`  skip goal: ${g.text.slice(0, 40)}… (exists)`); continue; }
  db.createCommitment({ id: crypto.randomUUID(), ...g });
  goalsAdded++;
}

console.log(`\nSeed complete: +${valuesAdded} values, +${goalsAdded} goals.`);
