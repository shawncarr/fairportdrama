#!/usr/bin/env node
/**
 * Loads the archived site's images into the local KV shim, so `wrangler dev`
 * renders the real photos instead of empty boxes.
 *
 * Writes an image manifest keyed the same way the Cloudflare upload script
 * produces, so `npm run seed:build` populates image columns identically. Ids
 * are deterministic here rather than opaque, because these never leave the
 * developer's machine and a readable id makes local debugging easier - the
 * privacy argument for opaque ids applies to public delivery URLs.
 *
 *   node scripts/load-local-images.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE = '../fairportdrama/src/content';
const PUBLIC_SOURCE = '../fairportdrama/public';
const MANIFEST = 'seed/image-manifest.json';
const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const found = [];
for (const collection of fs.readdirSync(SOURCE)) {
  const cdir = path.join(SOURCE, collection);
  if (!fs.statSync(cdir).isDirectory()) continue;
  for (const entry of fs.readdirSync(cdir)) {
    const edir = path.join(cdir, entry);
    if (!fs.statSync(edir).isDirectory()) continue;
    for (const file of fs.readdirSync(edir)) {
      if (!IMAGE_RE.test(file)) continue;
      found.push({
        key: path.posix.join(collection, entry, file),
        abs: path.join(edir, file),
      });
    }
  }
}

const ogDir = path.join(PUBLIC_SOURCE, 'images');
if (fs.existsSync(ogDir)) {
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const abs = path.join(dir, f);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (IMAGE_RE.test(f)) {
        found.push({ key: '/' + path.relative(PUBLIC_SOURCE, abs), abs });
      }
    }
  };
  walk(ogDir);
}

const manifest = {};
let n = 0;

for (const { key, abs } of found) {
  // Stable id derived from the source path, so re-running does not duplicate.
  const id = 'local-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  const ext = path.extname(abs).toLowerCase();

  execFileSync(
    'npx',
    [
      'wrangler', 'kv', 'key', 'put',
      `local-image:${id}`,
      '--binding', 'KV', '--local',
      '--path', abs,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  execFileSync(
    'npx',
    [
      'wrangler', 'kv', 'key', 'put',
      `local-image:${id}:meta`,
      JSON.stringify({ contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' }),
      '--binding', 'KV', '--local',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  manifest[key] = id;
  n++;
  if (n % 20 === 0) console.log(`  ${n}/${found.length}`);
}

fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Loaded ${n} images into local KV.`);
console.log('Next: npm run seed:build && npm run seed:apply:local');
