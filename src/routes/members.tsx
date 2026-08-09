import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '~/env';
import { getActiveMembers, getDb, getMemberShows, getPublicMemberProfile } from '~/db/queries';
import { gradePlural, ROSTER_GRADE_ORDER } from '~/lib/grades';
import { IMAGE_VARIANT, type ImageStore } from '~/lib/images';
import { roleDisplayName } from '~/lib/roles';

export const memberRoutes = new Hono<AppEnv>();

type DirectoryMember = Awaited<ReturnType<typeof getActiveMembers>>[number];

/**
 * Officers in the order a playbill would print them, not alphabetically.
 *
 * An unranked title sorts last rather than first, so inventing a new office
 * does not push it above the president.
 */
const OFFICE_RANK: Record<string, number> = {
  President: 1,
  'Co-President': 1,
  'Vice President': 2,
  Secretary: 3,
  Treasurer: 4,
};

const byOffice = (a: DirectoryMember, b: DirectoryMember) => {
  const rank = (m: DirectoryMember) => OFFICE_RANK[m.officerTitle ?? ''] ?? 99;
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
};

memberRoutes.get('/members', async (c) => {
  const images = c.get('images');
  const roster = await getActiveMembers(getDb(c.env.DB));

  const officers = roster.filter((m) => m.isOfficer).sort(byOffice);
  // Alumni have their own page. They are a third of the roster already and
  // grow by a graduating class every year, so leaving them in would slowly
  // turn the directory into a page about people who have left.
  const alumni = roster.filter((m) => m.grade === 'Alumni');
  const current = roster.filter((m) => !m.isOfficer && m.grade !== 'Alumni');

  const groups: { grade: string; members: DirectoryMember[] }[] = ROSTER_GRADE_ORDER.map(
    (grade) => ({
      grade: grade as string,
      members: current.filter((m) => m.grade === grade),
    }),
  ).filter((g) => g.members.length > 0);

  // Anything the grade order does not name still has to appear somewhere.
  const ungrouped = current.filter(
    (m) => !(ROSTER_GRADE_ORDER as readonly string[]).includes(m.grade),
  );
  if (ungrouped.length > 0) groups.push({ grade: 'Everyone else', members: ungrouped });

  const roles = [...new Set(roster.flatMap((m) => m.roles))].sort((a, b) =>
    roleDisplayName(a).localeCompare(roleDisplayName(b)),
  );

  return c.render(
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">Our Members</h1>
      <p class="text-neutral-600 mb-8 max-w-2xl">
        The students and staff who bring our productions to life.
      </p>

      <MemberFilters roles={roles} />

      {officers.length > 0 && (
        <section class="mb-14" data-group>
          <SectionHeading title="Club Officers" count={officers.length} accent />
          <MemberGrid members={officers} images={images} />
        </section>
      )}

      {groups.map((group) => (
        <section class="mb-12" data-group>
          <SectionHeading title={gradePlural(group.grade)} count={group.members.length} />
          <MemberGrid members={group.members} images={images} />
        </section>
      ))}

      <p
        class="hidden text-neutral-500 text-center py-12"
        data-empty
        role="status"
        aria-live="polite"
      >
        No members match that search.
      </p>

      {alumni.length > 0 && (
        <a
          href="/members/alumni"
          class="inline-flex items-center gap-2 mt-4 px-5 py-3 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-neutral-800 font-medium transition-colors"
        >
          Alumni ({alumni.length}) &rarr;
        </a>
      )}

      <FilterScript />
    </div>,
    {
      title: 'Members',
      description: 'Students and staff of the Fairport High School Drama Club.',
    },
  );
});

memberRoutes.get('/members/alumni', async (c) => {
  const images = c.get('images');
  const roster = await getActiveMembers(getDb(c.env.DB));
  const alumni = roster.filter((m) => m.grade === 'Alumni');

  return c.render(
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
      <a href="/members" class="text-sm text-primary-600 hover:text-primary-700">
        &larr; All members
      </a>
      <h1 class="font-display text-4xl font-bold text-neutral-900 mt-6 mb-3">Alumni</h1>
      <p class="text-neutral-600 mb-8 max-w-2xl">
        Former members of the Drama Club. Their production credits stay on their profiles.
      </p>

      {alumni.length > 0 ? (
        <MemberGrid members={alumni} images={images} />
      ) : (
        <p class="text-neutral-500 py-12">No alumni are listed yet.</p>
      )}
    </div>,
    {
      title: 'Alumni',
      description: 'Former members of the Fairport High School Drama Club.',
    },
  );
});

function SectionHeading({
  title,
  count,
  accent = false,
}: {
  title: string;
  count: number;
  accent?: boolean;
}) {
  return (
    <h2 class="font-display text-2xl font-semibold text-neutral-900 mb-6 flex items-center gap-3">
      <span class={accent ? 'bg-accent-500 text-neutral-900 px-4 py-1 rounded-lg' : ''}>
        {title}
      </span>
      <span class="text-neutral-400 text-sm font-normal" data-count>
        {count}
      </span>
      <span class="flex-1 h-px bg-neutral-200" />
    </h2>
  );
}

function MemberGrid({
  members,
  images,
}: {
  members: DirectoryMember[];
  images: ImageStore;
}) {
  return (
    <div class="grid gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {members.map((m) => (
        <MemberCard member={m} images={images} />
      ))}
    </div>
  );
}

/**
 * Search and role filter.
 *
 * Rendered with no default filtering applied, so a visitor without JavaScript
 * gets the whole directory rather than an inert control over an empty page.
 */
function MemberFilters({ roles }: { roles: string[] }) {
  return (
    <div class="flex flex-col sm:flex-row gap-3 mb-10" data-filters>
      <label class="flex-1">
        <span class="sr-only">Search members by name</span>
        <input
          type="search"
          id="member-search"
          placeholder="Search by name"
          autocomplete="off"
          class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
        />
      </label>
      {roles.length > 0 && (
        <label>
          <span class="sr-only">Filter members by role</span>
          <select
            id="member-role"
            class="w-full sm:w-56 px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
          >
            <option value="">All roles</option>
            {roles.map((role) => (
              <option value={role}>{roleDisplayName(role)}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/**
 * Filtering runs over the cards already in the page rather than re-querying.
 *
 * The whole roster is ~130 cards and is served from one cached response, so a
 * round trip per keystroke would buy nothing. Section headings and their counts
 * follow the visible cards, and a section with nothing left in it hides
 * entirely rather than leaving a heading over empty space.
 */
const FilterScript = () => html`
  <script>
    (function () {
      var search = document.getElementById('member-search');
      var role = document.getElementById('member-role');
      if (!search) return;

      var cards = Array.prototype.slice.call(document.querySelectorAll('[data-member]'));
      var groups = Array.prototype.slice.call(document.querySelectorAll('[data-group]'));
      var empty = document.querySelector('[data-empty]');

      function apply() {
        var term = search.value.trim().toLowerCase();
        var want = role ? role.value : '';
        var shown = 0;

        cards.forEach(function (card) {
          var matchesName = !term || card.getAttribute('data-name').indexOf(term) !== -1;
          var matchesRole =
            !want || (' ' + card.getAttribute('data-roles') + ' ').indexOf(' ' + want + ' ') !== -1;
          var visible = matchesName && matchesRole;
          card.hidden = !visible;
          if (visible) shown++;
        });

        groups.forEach(function (group) {
          var visible = group.querySelectorAll('[data-member]:not([hidden])').length;
          group.hidden = visible === 0;
          var count = group.querySelector('[data-count]');
          if (count) count.textContent = String(visible);
        });

        if (empty) empty.classList.toggle('hidden', shown !== 0);
      }

      search.addEventListener('input', apply);
      if (role) role.addEventListener('change', apply);
    })();
  </script>
`;

memberRoutes.get('/members/:slug', async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');

  // Returns null for members who have not opted in, so the route 404s. The
  // slug itself is the full name, so serving a redacted page at this URL
  // would defeat the point.
  const member = await getPublicMemberProfile(db, c.req.param('slug'));
  if (!member) return c.notFound();

  const shows = await getMemberShows(db, member.id);
  const photo = images.deliveryUrl(member.photoImageId, IMAGE_VARIANT.Thumb);

  return c.render(
    <div class="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-16">
      <a href="/members" class="text-sm text-primary-600 hover:text-primary-700">
        &larr; All members
      </a>

      <div class="mt-6 flex flex-col sm:flex-row gap-8 items-start">
        {photo && (
          <img
            src={photo}
            alt={member.name}
            class="w-40 h-40 rounded-xl object-cover ring-1 ring-neutral-200"
          />
        )}
        <div>
          <h1 class="font-display text-3xl font-bold text-neutral-900">{member.name}</h1>
          <p class="text-neutral-500 mt-1">
            {member.grade}
            {member.officerTitle && ` · ${member.officerTitle}`}
          </p>

          {member.offices.length > 0 && (
            <ul class="mt-4 space-y-1">
              {member.offices.map((office) => (
                <li class="text-sm">
                  <span class="font-medium text-neutral-800">{office.title}</span>
                  <span class="text-neutral-500"> · {office.term}</span>
                  {!office.isCurrent && (
                    <span class="ml-2 px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 text-xs align-middle">
                      past
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {member.roles.length > 0 && (
            <ul class="flex flex-wrap gap-2 mt-4">
              {member.roles.map((role) => (
                <li class="px-3 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
                  {roleDisplayName(role)}
                </li>
              ))}
            </ul>
          )}

          {member.bio && <p class="text-neutral-700 mt-6 leading-relaxed">{member.bio}</p>}
        </div>
      </div>

      {shows.length > 0 && (
        <section class="mt-12">
          <h2 class="font-display text-xl font-semibold text-neutral-900 mb-4">
            Productions
          </h2>
          <ul class="space-y-2">
            {shows.map((show) => (
              <li>
                <a
                  href={`/shows/${show.id}`}
                  class="text-primary-600 hover:text-primary-700"
                >
                  {show.title}
                </a>
                <span class="text-neutral-500 text-sm"> &middot; {show.season}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>,
    { title: member.name, description: member.bio ?? `${member.name} - Fairport Drama Club` },
  );
});

/**
 * Directory card.
 *
 * Everything here comes from the query layer's public projection: a member who
 * has not opted in has no photo, no link, and a name already reduced to first
 * name and last initial.
 */
function MemberCard({
  member,
  images,
}: {
  images: ImageStore;
  member: {
    id: string;
    name: string;
    photoImageId: string | null;
    href: string | null;
    grade: string;
    officerTitle: string | null;
    roles: string[];
  };
}) {
  const photo = images.deliveryUrl(member.photoImageId, IMAGE_VARIANT.Thumb);
  // Lowercased here so the filter compares without allocating per keystroke.
  // The displayed name is already reduced for anyone who has not opted in, so
  // filtering cannot match on a surname the page does not show.
  const filterAttrs = {
    'data-member': '',
    'data-name': member.name.toLowerCase(),
    'data-roles': member.roles.join(' '),
  };

  const body = (
    <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-hidden h-full hover:ring-primary-300 transition-all">
      <div class="aspect-square bg-neutral-100 flex items-center justify-center">
        {photo ? (
          <img src={photo} alt={member.name} loading="lazy" class="w-full h-full object-cover" />
        ) : (
          <span class="text-4xl text-neutral-300" aria-hidden="true">
            🎭
          </span>
        )}
      </div>
      <div class="p-4">
        <p class="font-medium text-neutral-900">{member.name}</p>
        <p class="text-sm text-neutral-500">
          {member.officerTitle ?? member.grade}
        </p>
      </div>
    </div>
  );

  return member.href ? (
    <a href={member.href} class="block" {...filterAttrs}>
      {body}
    </a>
  ) : (
    <div {...filterAttrs}>{body}</div>
  );
}
