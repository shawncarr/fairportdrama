#!/usr/bin/env node
/**
 * Verifies migrated data against the source content collections.
 *
 * Counting rows only proves the inserts ran. This also spot-checks that
 * specific values survived the transformation, and that the invariants the
 * migration is supposed to establish actually hold.
 *
 *   node scripts/verify-seed.mjs [--remote]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REMOTE = process.argv.includes('--remote');
const SOURCE = '../fairportdrama/src/content';

const sql = (command) => {
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'fairport-drama-db',
      REMOTE ? '--remote' : '--local',
      '--command',
      command,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const start = out.indexOf('[\n');
  return JSON.parse(out.slice(start))[0].results;
};

const one = (command) => Object.values(sql(command)[0])[0];

const entries = (collection) => {
  const dir = path.join(SOURCE, collection);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'index.json')))
    .map((d) => ({
      id: d,
      data: JSON.parse(fs.readFileSync(path.join(dir, d, 'index.json'), 'utf8')),
    }));
};

const members = entries('members');
const shows = entries('shows');

let failures = 0;
const check = (label, expected, actual) => {
  const ok = expected === actual;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} expected=${String(expected).padEnd(6)} actual=${actual}`,
  );
};

console.log(`\nVerifying ${REMOTE ? 'REMOTE' : 'local'} database against ${SOURCE}\n`);

// --- counts ---------------------------------------------------------------
check('members', members.length, one('SELECT COUNT(*) FROM members'));
check(
  'member_roles',
  members.reduce((n, m) => n + (m.data.roles?.length ?? 0), 0),
  one('SELECT COUNT(*) FROM member_roles'),
);
check('shows', shows.length, one('SELECT COUNT(*) FROM shows'));
check(
  'show_performances',
  shows.reduce((n, s) => n + (s.data.performances?.length ?? 0), 0),
  one('SELECT COUNT(*) FROM show_performances'),
);
check(
  'show_cast',
  shows.reduce((n, s) => n + (s.data.cast?.length ?? 0), 0),
  one('SELECT COUNT(*) FROM show_cast'),
);
check(
  'show_crew',
  shows.reduce((n, s) => n + (s.data.crew?.length ?? 0), 0),
  one('SELECT COUNT(*) FROM show_crew'),
);
check('sponsors', entries('sponsors').length, one('SELECT COUNT(*) FROM sponsors'));
check('spirit_wear', entries('spiritwear').length, one('SELECT COUNT(*) FROM spirit_wear'));

// --- invariants the migration must establish -------------------------------
console.log('');
check(
  'every member defaults to limited',
  members.length,
  one("SELECT COUNT(*) FROM members WHERE visibility='limited'"),
);
check('no member is public yet', 0, one("SELECT COUNT(*) FROM members WHERE visibility='full'"));

const sourceTba = shows.reduce(
  (n, s) =>
    n +
    (s.data.cast ?? []).filter((c) => c.memberId == null).length +
    (s.data.crew ?? []).filter((c) => c.memberId == null).length,
  0,
);
check(
  'TBA slots preserved as NULL',
  sourceTba,
  one(
    'SELECT (SELECT COUNT(*) FROM show_cast WHERE member_id IS NULL) + (SELECT COUNT(*) FROM show_crew WHERE member_id IS NULL)',
  ),
);
check(
  'no orphaned cast references',
  0,
  one(
    'SELECT COUNT(*) FROM show_cast c LEFT JOIN members m ON m.id=c.member_id WHERE c.member_id IS NOT NULL AND m.id IS NULL',
  ),
);
check(
  'no orphaned crew references',
  0,
  one(
    'SELECT COUNT(*) FROM show_crew c LEFT JOIN members m ON m.id=c.member_id WHERE c.member_id IS NOT NULL AND m.id IS NULL',
  ),
);

// --- value spot-checks -----------------------------------------------------
console.log('');
const sampleMember = members.find((m) => m.data.bio && m.data.isOfficer);
if (sampleMember) {
  const row = sql(
    `SELECT name, bio, officer_title FROM members WHERE id='${sampleMember.id}'`,
  )[0];
  check(`${sampleMember.id} name`, sampleMember.data.name, row.name);
  check(`${sampleMember.id} bio length`, sampleMember.data.bio.length, row.bio.length);
  check(
    `${sampleMember.id} officer title`,
    sampleMember.data.officerTitle,
    row.officer_title,
  );
}

const current = shows.find((s) => s.data.isCurrent);
if (current) {
  const row = sql(
    `SELECT title, synopsis, ticket_url FROM shows WHERE id='${current.id}'`,
  )[0];
  check(`${current.id} title`, current.data.title, row.title);
  check(`${current.id} synopsis length`, current.data.synopsis.length, row.synopsis.length);
  check(`${current.id} ticket url`, current.data.ticketUrl ?? null, row.ticket_url);

  // Cast order must survive: a cast list is meaningfully ordered.
  const firstCast = current.data.cast[0];
  const row2 = sql(
    `SELECT role, member_id FROM show_cast WHERE show_id='${current.id}' ORDER BY sort_order LIMIT 1`,
  )[0];
  check(`${current.id} first cast role`, firstCast.role, row2.role);
  check(`${current.id} first cast member`, firstCast.memberId ?? null, row2.member_id);
}

const sw = entries('spiritwear')[0];
if (sw) {
  const row = sql(`SELECT price_cents FROM spirit_wear WHERE id='${sw.id}'`)[0];
  check(`${sw.id} price -> cents`, Math.round(sw.data.price * 100), row.price_cents);
}

console.log(
  `\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
