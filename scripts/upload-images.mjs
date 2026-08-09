#!/usr/bin/env node
/**
 * Uploads content images to Cloudflare Images and writes seed/image-manifest.json.
 *
 *   npm run images:upload [-- --dry-run]
 *
 * Credentials come from .dev.vars, or from the environment if set there
 * instead. They are only ever needed here: the deployed Worker uploads through
 * the IMAGES binding and holds no token at all.
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

/**
 * Reads .dev.vars, which is where every other local credential in this project
 * lives. It is a wrangler file, so plain `node` knows nothing about it - this
 * script has to load it itself rather than assume the shell did.
 *
 * A value already in the environment wins, so a one-off override still works.
 */
function loadDevVars(file = '.dev.vars') {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Tolerate quoting, which wrangler accepts.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDevVars();

const ACCOUNT = process.env.CF_IMAGES_ACCOUNT_ID;
const TOKEN = process.env.CF_IMAGES_API_TOKEN;
const PLACEHOLDER = /^(dev-)?placeholder/i;

if (!DRY_RUN && (!ACCOUNT || !TOKEN || PLACEHOLDER.test(ACCOUNT) || PLACEHOLDER.test(TOKEN))) {
  const missing = [
    !ACCOUNT || PLACEHOLDER.test(ACCOUNT) ? 'CF_IMAGES_ACCOUNT_ID' : null,
    !TOKEN || PLACEHOLDER.test(TOKEN) ? 'CF_IMAGES_API_TOKEN' : null,
  ].filter(Boolean);

  console.error(
    `Missing or placeholder: ${missing.join(' and ')}.\n\n` +
      'Set them in .dev.vars (gitignored):\n' +
      '  CF_IMAGES_ACCOUNT_ID=...\n' +
      '  CF_IMAGES_API_TOKEN=...\n\n' +
      'The token needs Account -> Cloudflare Images -> Edit, from\n' +
      'https://dash.cloudflare.com/profile/api-tokens\n\n' +
      'Re-run with --dry-run to see what would be uploaded without them.',
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

/**
 * Whether the bytes really are an image.
 *
 * An extension is not evidence. The archive contains an og-default.jpg that is
 * eleven bytes of the ASCII text "placeholder", which Cloudflare rejects with
 * a content-type error that reads as though the upload code is at fault. This
 * is the same check the application applies to admin uploads.
 */
const looksLikeImage = (b) =>
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
  (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) ||
  (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50);

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const upload = async (abs) => {
  const bytes = fs.readFileSync(abs);
  const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';

  const body = new FormData();
  // The type is declared rather than left to be inferred from the filename.
  body.append('file', new Blob([bytes], { type }), path.basename(abs));
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

/**
 * The manifest is shared with load-local-images.mjs, which fills it with ids
 * for the KV shim. Those are not Cloudflare ids, so an entry holding one means
 * the file still needs uploading - treating any existing entry as done made
 * this script report "0 not yet uploaded" against a manifest full of local
 * ids, and upload nothing.
 */
const LOCAL_ID = /^local-/;
const isUploaded = (key) => Boolean(manifest[key]) && !LOCAL_ID.test(manifest[key]);

const notImages = found.filter((f) => {
  const head = fs.readFileSync(f.abs).subarray(0, 12);
  return !looksLikeImage(head);
});
const notImageKeys = new Set(notImages.map((f) => f.key));

const pending = found.filter((f) => !isUploaded(f.key) && !notImageKeys.has(f.key));
const shimEntries = found.filter((f) => LOCAL_ID.test(manifest[f.key] ?? '')).length;

console.log(`Found ${found.length} raster images (${pending.length} not yet uploaded)`);
if (shimEntries > 0) {
  console.log(
    `  ${shimEntries} currently hold local development ids and will be replaced.`,
  );
}
if (notImages.length > 0) {
  console.log(
    `\n${notImages.length} file(s) skipped - the extension says image, the bytes do not:`,
  );
  for (const f of notImages) {
    console.log(`  ${f.key} (${fs.statSync(f.abs).size} bytes)`);
  }
  console.log('  Replace them with real images, or leave them out.');
}
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
