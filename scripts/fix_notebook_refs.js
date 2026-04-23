// One-shot: convert all notebook-page→reference links into collections.
// Run once: node scripts/fix_notebook_refs.js
const db = require('../db');
const { randomUUID } = require('crypto');

const fixes = [
  { pageId: '98e5f7b0-39a8-4a4d-aab7-b50eb8b7f8e3', title: 'Discussion of Hybrid Systems',                          refId: '860339e7-ef7d-4dc5-8ac8-008769c1e141' },
  { pageId: '1ccf4ad2-771f-41d8-8967-038ea97f2bab', title: 'The Book of Daniel pt 1-6',                             refId: 'f979dc99-36a8-4308-9582-cb3f375a0efd' },
  { pageId: '41a722cb-6050-405e-9704-29471adab5ee', title: 'Satan Tempts Adam + Eve to Outsmart God',               refId: '3a39134a-99db-480a-8b65-d888f258d6d6' },
  { pageId: '4f38ec61-b965-4217-a5c8-4092b951731a', title: 'The Altar as a Place of Refuge and Judgment',          refId: 'e01a49cf-8f87-46cf-996b-7967511c91eb' },
  { pageId: '74bb63ea-251d-4546-83a6-4c56445a78b4', title: 'War of the Gods in Daniel',                            refId: 'ccdd6cfe-7966-4a82-af5b-5b3d3729b196' },
  { pageId: 'c4fa4a7f-d411-41f9-8417-765a2b95f738', title: 'Bear His Iniquity',                                    refId: '4c8f6a31-ae66-445a-9390-b9603c3abf73' },
  { pageId: 'db6785bd-3a71-492d-8320-ef2c70f8f01b', title: 'The Book of Daniel 1-6, pt 1',                         refId: 'a1c12ace-9b13-40b6-b3e3-151e8c4db1ea' },
  { pageId: 'efd782d2-a123-4694-a7e4-db26608f3fc9', title: 'AIA1X9.20A',                                           refId: 'c0813147-f15a-4618-ada2-aeb707fd920c' },
  { pageId: 'd2969d29-1844-445c-bc4c-fe57bae7946d', title: 'On Plymouth Colony',                                   refId: '69c0b52a-70a1-4e34-913f-dd6ab7006161' },
  { pageId: '8bf7305b-749f-47a7-9ce2-af1cc10f81a7', title: "Does 'Sons of God' Mean Seth's Kids or Angels?",      refId: '453a1ce3-54de-42ed-8579-e15da31ec826' },
  { pageId: '00b2f6fb-cccb-4f9d-8730-333c45c60051', title: 'Genesis Creation Accounts',                            refId: 'f2b44022-dcca-4f5b-bca4-81e26586b305' },
  { pageId: '99131241-1e2b-43b6-8546-4afc16d35b0c', title: 'Why Destroy The Beasts Too?',                         refId: 'd7d14432-fb81-4c07-8fab-5a45687d73d4' },
  { pageId: '3c4b9b44-1faa-419b-971b-7e40e78ab376', title: 'And God Saw That It Was Good',                        refId: 'ef9a3397-1776-419c-a8b9-fd989d80bb4d' },
  { pageId: 'a2b8d0dc-345a-41ed-945b-fc711a996e1d', title: 'Annotation on Exodus 20:5',                           refId: '2125cf56-d844-4b23-b1b7-6505120fcdf7' },
  { pageId: 'b98cc6ac-ff24-4294-8114-21867181fc31', title: 'Note on the Identity of the Three Men in Genesis 18', refId: '48ec65c4-b9e2-4b04-af46-35eb8af0a7f3' },
  { pageId: '77f3de39-1058-4288-bba6-086880d07864', title: 'The Gospel Coalition',                                 refId: '877a6819-3c87-4b5e-884e-5ec2893462f2' },
  // E p.93 — ref already deleted ("article"), no collection assigned
  { pageId: '6c1438f9-d9d8-48e8-b5d0-32f2a777cb6f', title: 'Worship and Biblical Interpretation',                refId: null },
];

for (const { pageId, title, refId } of fixes) {
  // Find or create the topical collection
  const groups = db.listCollectionsGrouped({ includeArchived: true });
  const allCols = groups.flatMap(g => g.collections ?? []);
  const existing = allCols.find(c => c.title?.toLowerCase() === title.toLowerCase());

  let colId;
  if (existing) {
    colId = existing.id;
    console.log(`  reuse  "${title}"`);
  } else {
    colId = randomUUID();
    db.createCollection({ id: colId, kind: 'topical', title });
    console.log(`  create "${title}"`);
  }

  // Link page → collection
  try {
    db.linkBetween({ from_type: 'page', from_id: pageId, to_type: 'collection', to_id: colId, role_summary: null });
    console.log(`         linked page ${pageId.slice(0,8)}`);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      console.log(`         link already exists`);
    } else throw e;
  }

  // Remove page→reference link, then delete the reference row
  if (refId) {
    db.removePageLinkToTarget(pageId, 'reference', refId);
    db.deleteReference(refId);
    console.log(`         removed ref  ${refId.slice(0,8)}`);
  }
}

console.log('\nDone.');
