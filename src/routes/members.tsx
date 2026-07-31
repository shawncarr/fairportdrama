import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import { getActiveMembers, getDb, getMemberShows, getPublicMemberProfile } from '~/db/queries';
import { IMAGE_VARIANT, imageUrl } from '~/lib/images';
import { roleDisplayName } from '~/lib/roles';

export const memberRoutes = new Hono<AppEnv>();

memberRoutes.get('/members', async (c) => {
  const members = await getActiveMembers(getDb(c.env.DB));
  const officers = members.filter((m) => m.isOfficer);
  const rest = members.filter((m) => !m.isOfficer);

  return c.render(
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">Our Members</h1>
      <p class="text-neutral-600 mb-10 max-w-2xl">
        The students and staff who bring our productions to life.
      </p>

      {officers.length > 0 && (
        <section class="mb-14">
          <h2 class="font-display text-2xl font-semibold text-neutral-900 mb-6">
            Club Officers
          </h2>
          <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {officers.map((m) => (
              <MemberCard member={m} />
            ))}
          </div>
        </section>
      )}

      <section>
        {officers.length > 0 && (
          <h2 class="font-display text-2xl font-semibold text-neutral-900 mb-6">Members</h2>
        )}
        <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {rest.map((m) => (
            <MemberCard member={m} />
          ))}
        </div>
      </section>
    </div>,
    {
      title: 'Members',
      description: 'Students and staff of the Fairport High School Drama Club.',
    },
  );
});

memberRoutes.get('/members/:slug', async (c) => {
  const db = getDb(c.env.DB);

  // Returns null for members who have not opted in, so the route 404s. The
  // slug itself is the full name, so serving a redacted page at this URL
  // would defeat the point.
  const member = await getPublicMemberProfile(db, c.req.param('slug'));
  if (!member) return c.notFound();

  const shows = await getMemberShows(db, member.id);
  const photo = imageUrl(member.photoImageId, IMAGE_VARIANT.Thumb);

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
}: {
  member: {
    id: string;
    name: string;
    photoImageId: string | null;
    href: string | null;
    grade: string;
    officerTitle: string | null;
  };
}) {
  const photo = imageUrl(member.photoImageId, IMAGE_VARIANT.Thumb);

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
    <a href={member.href} class="block">
      {body}
    </a>
  ) : (
    body
  );
}
