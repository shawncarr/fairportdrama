#!/usr/bin/env node
/**
 * Uploads content images to Cloudflare Images and writes seed/image-manifest.json.
 *
 *   CF_IMAGES_ACCOUNT_ID=... CF_IMAGES_API_TOKEN=... node scripts/upload-images.mjs [--dry-run]
 *
 * The token needs the "Cloudflare Images: Edit" permission. Requires an Images
 * paid plan, since this stores images rather than only transforming them.
 *
 * IMPORTANT - image ids are deliberately NOT derived from the source path.
 *
 * Cloudflare supports custom ids, and `members/daniel-doser/photo` would be
 * convenient. It would also put the member's full name back into every
 * delivery URL, which is exactly the leak that moving off colocated filenames
 * was meant to close - a member set to `limited` visibility would still be
 * identifiable from the URL of their own photo. Auto-generated opaque ids are
 * the reason the migration fixes this rather than relocating it.
 *
 * Idempotency comes from the manifest instead: entries already present are
 * skipped, so re-running after a partial failure resumes rather than
 * duplicating.
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE = '../fairportdrama/src/content';
const PUBLIC_SOURCE = '../fairportdrama/public';
const MANIFEST = 'seed/image-manifest.json';

const ACCOUNT = process.env.CF_IMAGES_ACCOUNT_ID;
const TOKEN = process.env.CF_IMAGES_API_TOKEN;

if (!DRY_RUN && (!ACCOUNT || !TOKEN)) {
  console.error(
    'Missing CF_IMAGES_ACCOUNT_ID or CF_IMAGES_API_TOKEN.\n' +
      'Re-run with --dry-run to see what would be uploaded.',
  );
  process.exit(1);
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;
// Cloudflare Images rasterises on delivery and does not serve vectors as
// vectors. An SVG logo should keep its crispness, so it stays a static asset.
const VECTOR_RE = /\.svg$/i;

const manifest = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  : {};

/** Collects every image referenced by content, keyed as collection/entry/file. */
const collect = () => {
  const found = [];
  const vectors = [];

  for (const collection of fs.readdirSync(SOURCE)) {
    const cdir = path.join(SOURCE, collection);
    if (!fs.statSync(cdir).isDirectory()) continue;

    for (const entry of fs.readdirSync(cdir)) {
      const edir = path.join(cdir, entry);
      if (!fs.statSync(edir).isDirectory()) continue;

      for (const file of fs.readdirSync(edir)) {
        const abs = path.join(edir, file);
        const key = path.posix.join(collection, entry, file);
        if (VECTOR_RE.test(file)) vectors.push({ key, abs });
        else if (IMAGE_RE.test(file)) found.push({ key, abs });
      }
    }
  }

  // Open Graph images live in public/ on the old site and are referenced by
  // absolute path, so they are keyed by that same path.
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

  return { found, vectors };
};

const upload = async (abs) => {
  const body = new FormData();
  body.append('file', new Blob([fs.readFileSync(abs)]), path.basename(abs));
  // requireSignedURLs=false: these are public site images.
  body.append('requireSignedURLs', 'false');

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/images/v1`,
    { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body },
  );

  const json = await response.json();
  if (!response.ok || !json.success) {
    throw new Error(
      `${path.basename(abs)}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`,
    );
  }
  return json.result.id;
};

const { found, vectors } = collect();
const pending = found.filter((f) => !manifest[f.key]);

console.log(`Found ${found.length} raster images (${pending.length} not yet uploaded)`);
if (vectors.length > 0) {
  console.log(
    `\n${vectors.length} vector image(s) left as static assets rather than uploaded:`,
  );
  for (const v of vectors) console.log(`  ${v.key}`);
  console.log('  Copy these into public/ and reference them directly.');
}

if (DRY_RUN) {
  console.log('\n--dry-run: nothing uploaded.');
  const bytes = pending.reduce((n, f) => n + fs.statSync(f.abs).size, 0);
  console.log(`Would upload ${pending.length} files, ${(bytes / 1e6).toFixed(1)} MB.`);
  process.exit(0);
}

let done = 0;
let failed = 0;
for (const { key, abs } of pending) {
  try {
    manifest[key] = await upload(abs);
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${pending.length}`);
    // Persist after every success so an interrupted run resumes cleanly.
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  } catch (error) {
    failed++;
    console.error(`  FAILED ${key}: ${error.message}`);
  }
}

console.log(`\nUploaded ${done}, failed ${failed}, manifest has ${Object.keys(manifest).length} entries.`);
console.log('Next: node scripts/build-seed.mjs   (to populate image columns)');
process.exit(failed === 0 ? 0 : 1);
