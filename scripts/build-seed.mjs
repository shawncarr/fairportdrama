#!/usr/bin/env node
/**
 * Generates seed SQL from the archived Astro site's content collections.
 *
 * Emits SQL rather than writing to D1 directly so the exact statements can be
 * reviewed before they touch a database that holds live newsletter
 * subscribers.
 *
 *   node scripts/build-seed.mjs [--source ../fairportdrama] [--out seed/content.sql]
 *
 * Image columns are populated from seed/image-manifest.json when present,
 * mapping each source file to its Cloudflare Images id. Without the manifest
 * every image column is NULL and the content still migrates - images can be
 * backfilled independently.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const SOURCE = arg('--source', '../fairportdrama');
const OUT = arg('--out', 'seed/content.sql');
const CONTENT = path.join(SOURCE, 'src/content');

const manifestPath = 'seed/image-manifest.json';
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : {};

// ---------------------------------------------------------------- helpers

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Non-finite number: ${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
};

const json = (v) => q(JSON.stringify(v ?? []));

/**
 * Resolves a colocated content image reference ("./photo.jpg") to a
 * Cloudflare Images id via the manifest. Unmapped images become NULL rather
 * than a broken reference.
 */
const imageId = (collection, entry, ref) => {
  if (!ref) return null;
  const key = path.posix.join(collection, entry, ref.replace(/^\.\//, ''));
  return manifest[key] ?? null;
};

const readEntries = (collection) => {
  const dir = path.join(CONTENT, collection);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'index.json')))
    .sort()
    .map((d) => ({
      id: d,
      data: JSON.parse(fs.readFileSync(path.join(dir, d, 'index.json'), 'utf8')),
    }));
};

// Deterministic ids for child rows, so re-running produces identical SQL and
// the diff between two runs is meaningful.
const childId = (...parts) => parts.join(':').replace(/[^a-zA-Z0-9:_-]/g, '_');

const lines = [];
const emit = (s) => lines.push(s);
const stats = {};

// ---------------------------------------------------------------- members

const members = readEntries('members');
stats.members = members.length;
stats.memberPhotos = 0;
stats.memberRoles = 0;

/**
 * Members who have appeared in a production.
 *
 * Built ahead of the member rows because shows are emitted later in this file
 * but decide a member's starting visibility.
 *
 * These students' names and photographs were already published in a printed
 * playbill and displayed in the theater lobby, so the site discloses nothing
 * new about them and they start visible. A member with no cast or crew credit
 * was never in a playbill, so that reasoning does not reach them - they start
 * hidden, as does anyone added later, since the column default in the schema
 * is `limited` and nothing here changes it for them.
 */
const credited = new Set();
for (const { data } of readEntries('shows')) {
  for (const c of [...(data.cast ?? []), ...(data.crew ?? [])]) {
    if (c.memberId) credited.add(c.memberId);
  }
}
stats.membersVisible = 0;
stats.membersHidden = 0;

emit('-- members');
for (const { id, data } of members) {
  const photo = imageId('members', id, data.photo);
  if (photo) stats.memberPhotos++;

  const visibility = credited.has(id) ? 'full' : 'limited';
  if (visibility === 'full') stats.membersVisible++;
  else stats.membersHidden++;

  emit(
    `INSERT INTO members (id,name,grade,graduation_year,photo_image_id,bio,instagram,visibility,is_active,is_officer,officer_title) VALUES (` +
      [
        q(id),
        q(data.name),
        q(data.grade),
        q(data.graduationYear ?? null),
        q(photo),
        q(data.bio ?? null),
        q(data.instagram ?? null),
        q(visibility),
        q(data.isActive ?? true),
        q(data.isOfficer ?? false),
        q(data.officerTitle ?? null),
      ].join(',') +
      ');',
  );

  for (const role of data.roles ?? []) {
    stats.memberRoles++;
    emit(`INSERT INTO member_roles (member_id,role) VALUES (${q(id)},${q(role)});`);
  }
}

// ---------------------------------------------------------------- shows

const shows = readEntries('shows');
stats.shows = shows.length;
stats.performances = 0;
stats.cast = 0;
stats.crew = 0;
stats.tba = 0;
stats.gallery = 0;

emit('\n-- shows');
for (const { id, data } of shows) {
  const images = data.images ?? {};
  emit(
    `INSERT INTO shows (id,title,season,year,venue,synopsis,ticket_url,poster_image_id,hero_image_id,og_image_id,is_current,is_highlighted) VALUES (` +
      [
        q(id),
        q(data.title),
        q(data.season),
        q(data.year),
        q(data.venue ?? 'Fairport High School Auditorium'),
        q(data.synopsis),
        q(data.ticketUrl ?? null),
        q(imageId('shows', id, images.poster)),
        q(imageId('shows', id, images.hero)),
        // `og` points into public/ on the old site rather than being colocated,
        // so it is looked up by its literal path.
        q(manifest[images.og] ?? null),
        q(data.isCurrent ?? false),
        q(data.isHighlighted ?? false),
      ].join(',') +
      ');',
  );

  for (const [i, p] of (data.performances ?? []).entries()) {
    stats.performances++;
    emit(
      `INSERT INTO show_performances (id,show_id,date,time) VALUES (${q(childId(id, 'perf', i))},${q(id)},${q(p.date)},${q(p.time)});`,
    );
  }

  for (const [i, c] of (data.cast ?? []).entries()) {
    stats.cast++;
    if (c.memberId == null) stats.tba++;
    emit(
      `INSERT INTO show_cast (id,show_id,member_id,role,additional_roles,tier,sort_order) VALUES (` +
        [
          q(childId(id, 'cast', i)),
          q(id),
          q(c.memberId ?? null),
          q(c.role),
          json(c.additionalRoles),
          q(c.tier ?? 'ensemble'),
          q(i),
        ].join(',') +
        ');',
    );
  }

  for (const [i, c] of (data.crew ?? []).entries()) {
    stats.crew++;
    if (c.memberId == null) stats.tba++;
    emit(
      `INSERT INTO show_crew (id,show_id,member_id,role,sort_order) VALUES (` +
        [q(childId(id, 'crew', i)), q(id), q(c.memberId ?? null), q(c.role), q(i)].join(
          ',',
        ) +
        ');',
    );
  }

  for (const [i, g] of (images.gallery ?? []).entries()) {
    const gid = imageId('shows', id, g);
    if (!gid) continue;
    stats.gallery++;
    emit(
      `INSERT INTO show_gallery_images (id,show_id,image_id,caption,sort_order) VALUES (${q(childId(id, 'gal', i))},${q(id)},${q(gid)},NULL,${q(i)});`,
    );
  }
}

// ---------------------------------------------------------------- sponsors

const sponsors = readEntries('sponsors');
stats.sponsors = sponsors.length;

emit('\n-- sponsors');
for (const { id, data } of sponsors) {
  emit(
    `INSERT INTO sponsors (id,name,logo_image_id,website,tier,show_id,is_active) VALUES (` +
      [
        q(id),
        q(data.name),
        q(imageId('sponsors', id, data.logo)),
        q(data.website ?? null),
        q(data.tier),
        q(data.showId ?? null),
        q(data.isActive ?? true),
      ].join(',') +
      ');',
  );
}

// ---------------------------------------------------------------- spirit wear

const spiritwear = readEntries('spiritwear');
stats.spiritWear = spiritwear.length;

emit('\n-- spirit wear');
for (const { id, data } of spiritwear) {
  // Money is stored in cents; the source stores dollars as a float.
  const cents = Math.round(Number(data.price) * 100);
  if (!Number.isInteger(cents)) throw new Error(`Bad price for ${id}: ${data.price}`);

  emit(
    `INSERT INTO spirit_wear (id,name,description,price_cents,image_id,sizes,colors,category,is_available,is_featured) VALUES (` +
      [
        q(id),
        q(data.name),
        q(data.description),
        q(cents),
        q(imageId('spiritwear', id, data.image)),
        json(data.sizes),
        json(data.colors),
        q(data.category ?? 'apparel'),
        q(data.isAvailable ?? true),
        q(data.isFeatured ?? false),
      ].join(',') +
      ');',
  );
}

// ---------------------------------------------------------------- news

const news = readEntries('news');
stats.news = news.length;
if (news.length > 0) {
  throw new Error(
    `Found ${news.length} news entries. The source collection was empty when this ` +
      `script was written; news is markdown with frontmatter, not index.json, ` +
      `so it needs a separate reader before it can migrate.`,
  );
}

// ---------------------------------------------------------------- write

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  [
    '-- Generated by scripts/build-seed.mjs. Do not edit by hand.',
    `-- Source: ${SOURCE}`,
    `-- Images mapped: ${Object.keys(manifest).length > 0 ? 'yes' : 'NO MANIFEST - all image columns NULL'}`,
    '',
    ...lines,
    '',
  ].join('\n'),
);

console.log(`Wrote ${OUT}`);
console.table(stats);
if (Object.keys(manifest).length === 0) {
  console.warn(
    '\nNo seed/image-manifest.json found: every image column is NULL.\n' +
      'Run the image upload step and regenerate to populate them.',
  );
}
