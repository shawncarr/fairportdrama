#!/usr/bin/env node
/**
 * Creates the first admin invite, so somebody can sign in and take over.
 *
 * Access is invite-only and invites are issued by an admin, which leaves no
 * way in on a fresh database. This writes one invite row directly - the only
 * step that ever bypasses the admin UI - and then the normal sign-in flow
 * takes over: the gate in databaseHooks.user.create.before finds the invite,
 * creates the account with the admin role, consumes the invite, and records
 * Account.InviteAccepted. No user row is fabricated.
 *
 * Refuses to run if an admin already exists, so it is a bootstrap rather than
 * a standing back door.
 *
 *   node scripts/bootstrap-admin.mjs you@example.com            # local
 *   node scripts/bootstrap-admin.mjs you@example.com --remote   # production
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const REMOTE = args.includes('--remote');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/bootstrap-admin.mjs <email> [--remote]');
  process.exit(1);
}

const TARGET = REMOTE ? '--remote' : '--local';
const DB = 'fairport-drama-db';

const d1 = (sql) => {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, TARGET, '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
};

const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// UUID v7, matching src/lib/id.ts so ids sort chronologically like every other
// row the application writes.
function uuidv7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  b[0] = (now / 2 ** 40) & 0xff;
  b[1] = (now / 2 ** 32) & 0xff;
  b[2] = (now / 2 ** 24) & 0xff;
  b[3] = (now / 2 ** 16) & 0xff;
  b[4] = (now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

console.log(`\nBootstrapping admin access on the ${REMOTE ? 'REMOTE' : 'local'} database.\n`);

const [{ n: admins }] = d1("SELECT COUNT(*) n FROM user WHERE role = 'admin'");
if (admins > 0) {
  console.error(
    `Refusing: ${admins} admin account${admins === 1 ? '' : 's'} already exist.\n` +
      'Invite people from /admin/accounts instead.',
  );
  process.exit(1);
}

const open = d1(
  `SELECT id FROM invites WHERE email = ${q(email)} AND accepted_at IS NULL AND revoked_at IS NULL`,
);
if (open.length > 0) {
  console.error(`Refusing: ${email} already has an open invite. Use it, or revoke it first.`);
  process.exit(1);
}

const now = new Date();
const expires = new Date(now.getTime() + 14 * 864e5);

d1(
  `INSERT INTO invites (id,email,role,member_id,token,expires_at,accepted_at,accepted_by_user_id,revoked_at,created_by_user_id,created_at) VALUES (` +
    [
      q(uuidv7()),
      q(email),
      q('admin'),
      'NULL',
      q(uuidv7()),
      q(expires.toISOString()),
      'NULL',
      'NULL',
      'NULL',
      // Not a real user id. The audit trail will show the account was created
      // by accepting an invite that nobody issued, which is what happened.
      q('bootstrap'),
      q(now.toISOString()),
    ].join(',') +
    ');',
);

const base = REMOTE ? 'https://fairportdrama.com' : 'http://localhost:8787';

console.log(`Invite created for ${email}, valid until ${expires.toDateString()}.\n`);
console.log('Next:');
console.log(`  1. Open ${base}/admin/sign-in`);
console.log('  2. Enter that address and request a sign-in link');
console.log('  3. Follow the emailed link - the invite is consumed on the way in');
console.log('\nThe magic-link path needs no Google credentials, so this works');
console.log('before OAuth is configured.\n');
