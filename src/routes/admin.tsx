import { Hono, type Context } from 'hono';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { AppEnv } from '~/env';
import {
  RosterFilterScript,
  RosterFilters,
  rosterRowAttrs,
} from '~/components/RosterFilter';
import { getDb, getGallery, getPerformances } from '~/db/queries';
import {
  members,
  news,
  showCast,
  showCrew,
  shows,
  MEMBER_VISIBILITY,
  NEWS_CATEGORY,
} from '~/db/schema/content';
import {
  APP_ROLE,
  auditEvents,
  invites,
  pendingEdits,
  PENDING_EDIT_STATUS,
  type AppRole,
} from '~/db/schema/governance';
import { user } from '~/db/schema/auth';
import { adminLayout } from '~/layouts/AdminLayout';
import { noStore, requirePermission, requireSignIn } from '~/middleware/require';
import { can } from '~/lib/auth/permissions';
import { createAuth } from '~/lib/auth';
import {
  VISIBILITY_LABELS,
  approvePendingEdit,
  rejectPendingEdit,
  submitSelfEdit,
} from '~/services/member-profile';
import { displayName } from '~/lib/member-display';
import { IMAGE_VARIANT, MAX_IMAGE_BYTES, uploadImage, type ImageStore } from '~/lib/images';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { writeWithAudit } from '~/lib/audit/write';
import { createInvite, inviteStatus, revokeInvite } from '~/services/invites';
import { assignRole, linkMember, revokeAccess } from '~/services/accounts';
import {
  countSubscribers,
  listSubscribers,
  toCsv,
  unsubscribeByEmail,
} from '~/services/newsletter';
import { replaceCast, replaceCrew } from '~/services/casting';
import { updateShowImages } from '~/services/show-images';
import {
  DEFAULT_VENUE,
  createShow,
  deleteShow,
  replacePerformances,
  setFeaturedShow,
  showIsDeletable,
  updateShow,
} from '~/services/shows';
import { addGalleryImages, removeGalleryImage } from '~/services/gallery';
import {
  GRADES,
  addOffice,
  advanceGrades,
  createMember,
  deleteOffice,
  endOffice,
  getOffices,
  isGrade,
  previewAdvanceGrades,
  reactivateMember,
  removeMemberInformation,
  updateMember,
} from '~/services/members';
import { gradePlural, schoolYearLabel, schoolYearStart } from '~/lib/grades';
import {
  NEWS_CATEGORY_LABELS,
  createNewsPost,
  deleteNewsPost,
  isNewsCategory,
  updateNewsPost,
} from '~/services/news';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('/admin/*', noStore);
adminRoutes.use('/admin/*', adminLayout);

// ---------------------------------------------------------------- sign in/out

adminRoutes.get('/admin/sign-in', (c) => {
  const next = c.req.query('next') ?? '/admin';
  const signedIn = Boolean(c.get('role'));
  if (signedIn) return c.redirect(next, 302);

  return c.render(
    <div class="mx-auto max-w-md">
      <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-8">
        <h1 class="font-display text-2xl font-bold text-neutral-900 mb-2">Sign in</h1>
        <p class="text-sm text-neutral-600 mb-6">
          Use your school Google account, or the email address a board member invited.
        </p>

        <a
          href={`/admin/sign-in/google?next=${encodeURIComponent(next)}`}
          class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-neutral-300 hover:bg-neutral-50 transition-colors font-medium"
        >
          Continue with Google
        </a>

        <div class="flex items-center gap-3 my-6">
          <div class="h-px bg-neutral-200 flex-1" />
          <span class="text-xs text-neutral-500 uppercase">or</span>
          <div class="h-px bg-neutral-200 flex-1" />
        </div>

        <form method="post" action="/admin/sign-in" class="space-y-3">
          <input type="hidden" name="next" value={next} />
          <label for="signin-email" class="block text-sm font-medium text-neutral-700">
            Email address
          </label>
          <input
            type="email"
            id="signin-email"
            name="email"
            required
            autocomplete="email"
            class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
          />
          <button
            type="submit"
            class="w-full px-4 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
          >
            Email me a sign-in link
          </button>
        </form>

        <p class="text-xs text-neutral-500 mt-6">
          Access is by invitation. If you have not been invited, ask a Boosters board
          member.
        </p>
      </div>
    </div>,
    { title: 'Sign in' },
  );
});

/**
 * Starts Google sign-in.
 *
 * Better Auth's /sign-in/social endpoint is POST-only and answers with JSON
 * carrying the provider URL - its client library then navigates there. This
 * site ships no client JavaScript on the sign-in page, so a plain link to that
 * endpoint 404s and a plain form POST would render the JSON as text.
 *
 * Doing the call here turns it back into an ordinary link. The Set-Cookie
 * headers must be forwarded with it: the call issues the PKCE verifier and
 * state cookies, and dropping them makes Google's callback fail a state check
 * that is genuinely protecting against a forged callback.
 */
adminRoutes.get('/admin/sign-in/google', async (c) => {
  const next = c.req.query('next') ?? '/admin';

  const { headers, response } = await createAuth(c.env).api.signInSocial({
    body: { provider: 'google', callbackURL: next },
    headers: c.req.raw.headers,
    returnHeaders: true,
  });

  const url = (response as { url?: string } | null)?.url;
  if (!url) {
    return c.redirect(
      `/admin/sign-in?error=${encodeURIComponent('Google sign-in is unavailable. Try the email link instead.')}`,
      302,
    );
  }

  const out = new Headers();
  for (const cookie of headers.getSetCookie()) out.append('set-cookie', cookie);
  out.set('location', url);
  return new Response(null, { status: 302, headers: out });
});

adminRoutes.post('/admin/sign-in', async (c) => {
  const form = await c.req.formData();
  const email = String(form.get('email') ?? '');
  const next = String(form.get('next') ?? '/admin');

  // Delegates to Better Auth, which suppresses the send for addresses with
  // neither an account nor a usable invite. The confirmation below is shown
  // either way so this cannot be used to discover who has access.
  await createAuth(c.env)
    .api.signInMagicLink({
      body: { email, callbackURL: next },
      headers: c.req.raw.headers,
    })
    .catch(() => undefined);

  return c.render(
    <div class="mx-auto max-w-md">
      <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-8 text-center">
        <h1 class="font-display text-2xl font-bold text-neutral-900 mb-3">Check your email</h1>
        <p class="text-sm text-neutral-600">
          If that address has access, a sign-in link is on its way. The link expires
          shortly and can only be used once.
        </p>
      </div>
    </div>,
    { title: 'Check your email' },
  );
});

adminRoutes.post('/admin/sign-out', async (c) => {
  await createAuth(c.env)
    .api.signOut({ headers: c.req.raw.headers })
    .catch(() => undefined);
  return c.redirect('/', 302);
});

// ---------------------------------------------------------------- overview

adminRoutes.get('/admin', requireSignIn, async (c) => {
  const db = getDb(c.env.DB);
  const role = c.get('role')!;
  const memberId = c.get('memberId');

  const [pendingCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(pendingEdits)
    .where(eq(pendingEdits.status, PENDING_EDIT_STATUS.Pending));

  const [publicCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(members)
    .where(eq(members.visibility, MEMBER_VISIBILITY.Full));

  const [memberCount] = await db.select({ n: sql<number>`COUNT(*)` }).from(members);

  return c.render(
    <div class="space-y-6">
      <h1 class="font-display text-2xl font-bold text-neutral-900">Overview</h1>

      <div class="grid gap-4 sm:grid-cols-3">
        {can(role, 'memberEdit', 'approve') && (
          <a
            href="/admin/approvals"
            class="block bg-white rounded-xl ring-1 ring-neutral-200 p-5 hover:ring-primary-300 transition-all"
          >
            <p class="text-3xl font-display font-bold text-neutral-900">
              {pendingCount?.n ?? 0}
            </p>
            <p class="text-sm text-neutral-600 mt-1">Edits awaiting review</p>
          </a>
        )}

        {can(role, 'member', 'update') && (
          <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-5">
            <p class="text-3xl font-display font-bold text-neutral-900">
              {publicCount?.n ?? 0}
              <span class="text-lg text-neutral-400"> / {memberCount?.n ?? 0}</span>
            </p>
            <p class="text-sm text-neutral-600 mt-1">Members showing full profiles</p>
          </div>
        )}

        {memberId && (
          <a
            href="/admin/profile"
            class="block bg-white rounded-xl ring-1 ring-neutral-200 p-5 hover:ring-primary-300 transition-all"
          >
            <p class="font-display font-bold text-neutral-900">My profile</p>
            <p class="text-sm text-neutral-600 mt-1">
              Control what appears about you publicly
            </p>
          </a>
        )}
      </div>

      {!memberId && (
        <p class="text-sm text-neutral-600 bg-white rounded-xl ring-1 ring-neutral-200 p-5">
          Your account is not linked to a member profile, so you do not appear on the
          public site. That is normal for board members and volunteers.
        </p>
      )}
    </div>,
    { title: 'Overview' },
  );
});

// ---------------------------------------------------------------- my profile

adminRoutes.get(
  '/admin/profile',
  requirePermission('memberSelf', 'update'),
  async (c) => {
    const memberId = c.get('memberId');
    if (!memberId) {
      return c.render(
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-8">
          <h1 class="font-display text-2xl font-bold text-neutral-900 mb-2">No profile</h1>
          <p class="text-neutral-600">
            Your account is not linked to a member record, so there is nothing about you
            on the public site. A board member can link one if that is wrong.
          </p>
        </div>,
        { title: 'My Profile' },
      );
    }

    const db = getDb(c.env.DB);
    const [member] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
    if (!member) return c.notFound();

    const queued = await db
      .select()
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.targetId, memberId),
          eq(pendingEdits.status, PENDING_EDIT_STATUS.Pending),
        ),
      );

    const saved = c.req.query('saved');
    const error = c.req.query('error');
    const images = c.get('images');
    const currentPhoto = images.deliveryUrl(member.photoImageId, IMAGE_VARIANT.Thumb);

    // Shown only while a photo change is queued, so the member can see what
    // they submitted rather than the photo still live on the site.
    const proposedPhotoId = queued
      .map((q) => (q.proposed as Record<string, unknown>).photoImageId)
      .find((id): id is string => typeof id === 'string');
    const proposedPhoto = images.deliveryUrl(proposedPhotoId, IMAGE_VARIANT.Thumb);

    return c.render(
      <div class="max-w-2xl space-y-6">
        <h1 class="font-display text-2xl font-bold text-neutral-900">My Profile</h1>

        {saved && (
          <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
            {saved === 'queued'
              ? 'Saved. Your changes to your bio or photo need approval before they appear.'
              : 'Saved.'}
          </p>
        )}

        {error && (
          <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
            {error}
          </p>
        )}

        <form
          method="post"
          action="/admin/profile"
          enctype="multipart/form-data"
          class="space-y-6"
        >
          <section class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
            <h2 class="font-display font-semibold text-neutral-900 mb-1">
              Who can see your details
            </h2>
            <p class="text-sm text-neutral-600 mb-4">
              This takes effect immediately. You never need approval to show less.
            </p>

            {(
              [MEMBER_VISIBILITY.Limited, MEMBER_VISIBILITY.Full] as const
            ).map((value) => (
              <label class="flex items-start gap-3 py-2 cursor-pointer">
                <input
                  type="radio"
                  name="visibility"
                  value={value}
                  checked={member.visibility === value}
                  class="mt-1"
                />
                <span>
                  <span class="block font-medium text-neutral-900">
                    {VISIBILITY_LABELS[value]}
                  </span>
                  <span class="block text-sm text-neutral-500">
                    {value === MEMBER_VISIBILITY.Limited
                      ? `You appear as "${displayName({ name: member.name, visibility: MEMBER_VISIBILITY.Limited })}" with no photo and no profile page.`
                      : 'Your full name, photo, and bio appear on the site, with your own page.'}
                  </span>
                </span>
              </label>
            ))}
          </section>

          <section class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
            <h2 class="font-display font-semibold text-neutral-900 mb-1">About you</h2>
            <p class="text-sm text-neutral-600 mb-4">
              Changes here are reviewed before they appear publicly.
            </p>

            <label for="bio" class="block text-sm font-medium text-neutral-700 mb-1">
              Bio
            </label>
            <textarea
              id="bio"
              name="bio"
              rows={6}
              maxlength={2000}
              class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
            >
              {member.bio ?? ''}
            </textarea>

            <label
              for="instagram"
              class="block text-sm font-medium text-neutral-700 mb-1 mt-4"
            >
              Instagram handle (optional)
            </label>
            <input
              type="text"
              id="instagram"
              name="instagram"
              value={member.instagram ?? ''}
              maxlength={64}
              class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
            />

            <p class="block text-sm font-medium text-neutral-700 mb-1 mt-6">Photo</p>
            <div class="flex items-start gap-4">
              {(proposedPhoto ?? currentPhoto) ? (
                <img
                  src={proposedPhoto ?? currentPhoto ?? ''}
                  alt=""
                  class="w-24 h-24 rounded-lg object-cover ring-1 ring-neutral-200 shrink-0"
                />
              ) : (
                <div class="w-24 h-24 rounded-lg bg-neutral-100 ring-1 ring-neutral-200 shrink-0 flex items-center justify-center text-neutral-400 text-xs">
                  None
                </div>
              )}
              <div class="flex-1">
                {proposedPhoto && (
                  <p class="text-xs text-amber-800 mb-2">
                    This is the photo you submitted. It is not on the site until it is
                    approved.
                  </p>
                )}
                <input
                  type="file"
                  id="photo"
                  name="photo"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  class="w-full text-sm text-neutral-600 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border-0 file:bg-neutral-100 file:text-neutral-800 file:font-medium hover:file:bg-neutral-200"
                />
                <p class="text-xs text-neutral-500 mt-2">
                  JPEG, PNG, GIF, or WebP, up to {MAX_IMAGE_BYTES / 1024 / 1024} MB. A
                  square headshot works best. Leave this empty to keep the photo you
                  have.
                </p>
                {member.photoImageId && (
                  <label class="flex items-center gap-2 text-sm text-neutral-700 mt-3">
                    <input type="checkbox" name="removePhoto" value="1" />
                    Remove my photo instead
                  </label>
                )}
              </div>
            </div>
          </section>

          {queued.length > 0 && (
            <p class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
              You have {queued.length} change{queued.length === 1 ? '' : 's'} waiting for
              review.
            </p>
          )}

          <button
            type="submit"
            class="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
          >
            Save
          </button>
        </form>

        <p class="text-sm text-neutral-500">
          Your name, grade, and roles are maintained by the Drama Club. Ask a board
          member if something is wrong.
        </p>
      </div>,
      { title: 'My Profile' },
    );
  },
);

adminRoutes.post(
  '/admin/profile',
  requirePermission('memberSelf', 'update'),
  async (c) => {
    const memberId = c.get('memberId');
    if (!memberId) return c.redirect('/admin/profile', 302);

    const form = await c.req.formData();
    const visibility = String(form.get('visibility') ?? '');
    const bio = String(form.get('bio') ?? '').trim();
    const instagram = String(form.get('instagram') ?? '').trim();

    // Removal wins over a simultaneous upload: if someone ticks "remove" and
    // also picks a file, the safer reading of the intent is that the photo
    // should come down.
    const removePhoto = Boolean(form.get('removePhoto'));
    let photoImageId: string | null | undefined;

    if (removePhoto) {
      photoImageId = null;
    } else {
      const upload = await uploadImage(c.get('images'), form.get('photo'));
      if (upload && 'error' in upload) {
        return c.redirect(`/admin/profile?error=${encodeURIComponent(upload.error)}`, 302);
      }
      photoImageId = upload?.imageId;
    }

    const result = await submitSelfEdit(getDb(c.env.DB), c.get('actor'), memberId, {
      visibility:
        visibility === MEMBER_VISIBILITY.Full || visibility === MEMBER_VISIBILITY.Limited
          ? visibility
          : undefined,
      bio: bio.length > 0 ? bio : null,
      instagram: instagram.length > 0 ? instagram : null,
      photoImageId,
    });

    const flag = result.queuedForApproval.length > 0 ? 'queued' : result.noChange ? '' : '1';
    return c.redirect(`/admin/profile${flag ? `?saved=${flag}` : ''}`, 302);
  },
);

// ---------------------------------------------------------------- approvals

/**
 * One side of an approval diff.
 *
 * A photo has to be shown as a photo. Rendering the image id as text would ask
 * an officer to accept responsibility for publishing something they never saw,
 * which would make the acknowledgement checkbox a formality.
 */
function ProposedValue({
  field,
  value,
  images,
}: {
  field: string;
  value: unknown;
  images: ImageStore;
}) {
  if (field === 'photoImageId') {
    const url = typeof value === 'string' ? images.deliveryUrl(value, IMAGE_VARIANT.Thumb) : null;
    return url ? (
      <img src={url} alt="" class="w-28 h-28 rounded-lg object-cover ring-1 ring-neutral-200" />
    ) : (
      <p class="text-neutral-500">(no photo)</p>
    );
  }

  return (
    <p class="text-neutral-800 whitespace-pre-wrap">{String(value ?? '(empty)')}</p>
  );
}

adminRoutes.get(
  '/admin/approvals',
  requirePermission('memberEdit', 'approve'),
  async (c) => {
    const db = getDb(c.env.DB);

    const queue = await db
      .select({
        id: pendingEdits.id,
        targetId: pendingEdits.targetId,
        proposed: pendingEdits.proposed,
        submittedAt: pendingEdits.submittedAt,
        submittedByUserId: pendingEdits.submittedByUserId,
        memberName: members.name,
        memberVisibility: members.visibility,
        memberBio: members.bio,
        memberInstagram: members.instagram,
        memberPhotoImageId: members.photoImageId,
      })
      .from(pendingEdits)
      .leftJoin(members, eq(members.id, pendingEdits.targetId))
      .where(eq(pendingEdits.status, PENDING_EDIT_STATUS.Pending))
      .orderBy(desc(pendingEdits.submittedAt));

    return c.render(
      <div class="max-w-3xl space-y-6">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Approvals</h1>

        <div class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
          <strong>Your name is recorded on every decision.</strong> Approving publishes
          this to the live site, where anyone can see it. If you are not sure, leave it
          for someone else.
        </div>

        {queue.length === 0 ? (
          <p class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 text-neutral-600">
            Nothing is waiting for review.
          </p>
        ) : (
          queue.map((item) => {
            const proposed = item.proposed as Record<string, unknown>;
            const currentValues: Record<string, unknown> = {
              bio: item.memberBio,
              instagram: item.memberInstagram,
              photoImageId: item.memberPhotoImageId,
            };

            return (
              <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
                <h2 class="font-display font-semibold text-neutral-900">
                  {item.memberName ?? item.targetId}
                </h2>
                <p class="text-xs text-neutral-500 mb-4">
                  Submitted {item.submittedAt}
                </p>

                <dl class="space-y-4 mb-5">
                  {Object.entries(proposed).map(([field, value]) => (
                    <div>
                      <dt class="text-xs uppercase tracking-wide text-neutral-500 mb-1">
                        {field}
                      </dt>
                      <dd class="grid sm:grid-cols-2 gap-3 text-sm">
                        <div class="rounded-lg bg-red-50 ring-1 ring-red-100 p-3">
                          <p class="text-xs text-red-700 mb-1">Current</p>
                          <ProposedValue
                            field={field}
                            value={currentValues[field]}
                            images={c.get('images')}
                          />
                        </div>
                        <div class="rounded-lg bg-green-50 ring-1 ring-green-100 p-3">
                          <p class="text-xs text-green-700 mb-1">Proposed</p>
                          <ProposedValue field={field} value={value} images={c.get('images')} />
                        </div>
                      </dd>
                    </div>
                  ))}
                </dl>

                <div class="flex flex-wrap gap-3 items-center">
                  <form method="post" action={`/admin/approvals/${item.id}/approve`}>
                    <label class="flex items-center gap-2 text-sm text-neutral-700 mb-2">
                      <input type="checkbox" name="acknowledged" required />
                      I have read this and accept responsibility for publishing it
                    </label>
                    <button
                      type="submit"
                      class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
                    >
                      Approve
                    </button>
                  </form>

                  <form
                    method="post"
                    action={`/admin/approvals/${item.id}/reject`}
                    class="flex items-end gap-2"
                  >
                    <div>
                      <label
                        for={`note-${item.id}`}
                        class="block text-xs text-neutral-500 mb-1"
                      >
                        Reason (optional)
                      </label>
                      <input
                        type="text"
                        id={`note-${item.id}`}
                        name="note"
                        maxlength={200}
                        class="px-3 py-2 rounded-lg border border-neutral-300 text-sm"
                      />
                    </div>
                    <button
                      type="submit"
                      class="px-5 py-2 bg-neutral-200 hover:bg-neutral-300 text-neutral-800 font-medium rounded-lg transition-colors"
                    >
                      Reject
                    </button>
                  </form>
                </div>
              </div>
            );
          })
        )}
      </div>,
      { title: 'Approvals' },
    );
  },
);

adminRoutes.post(
  '/admin/approvals/:id/approve',
  requirePermission('memberEdit', 'approve'),
  async (c) => {
    const form = await c.req.formData();
    // The acknowledgement is enforced server-side, not just marked `required`
    // in the markup, so it cannot be bypassed by posting directly.
    if (!form.get('acknowledged')) return c.redirect('/admin/approvals', 302);

    await approvePendingEdit(getDb(c.env.DB), c.get('actor'), c.req.param('id'));
    return c.redirect('/admin/approvals', 302);
  },
);

adminRoutes.post(
  '/admin/approvals/:id/reject',
  requirePermission('memberEdit', 'approve'),
  async (c) => {
    const form = await c.req.formData();
    const note = String(form.get('note') ?? '').trim();
    await rejectPendingEdit(
      getDb(c.env.DB),
      c.get('actor'),
      c.req.param('id'),
      note.length > 0 ? note : null,
    );
    return c.redirect('/admin/approvals', 302);
  },
);

// ---------------------------------------------------------------- activity

adminRoutes.get('/admin/audit', requirePermission('audit', 'readOwn'), async (c) => {
  const db = getDb(c.env.DB);
  const role = c.get('role')!;
  const actor = c.get('actor');
  const memberId = c.get('memberId');
  const readAll = can(role, 'audit', 'readAll');

  // readOwn resolves to "what I changed" OR "what was changed about me", which
  // is the useful pair: an account holder can see their own actions and
  // anything done to their profile by someone else.
  const scope = readAll
    ? undefined
    : or(
        eq(auditEvents.actorUserId, actor.id ?? '__none__'),
        memberId ? eq(auditEvents.targetId, memberId) : sql`0 = 1`,
      );

  const rows = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      targetKind: auditEvents.targetKind,
      targetId: auditEvents.targetId,
      actorLabel: auditEvents.actorLabel,
      actorKind: auditEvents.actorKind,
      diff: auditEvents.diff,
      payload: auditEvents.payload,
      ip: auditEvents.ip,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(scope)
    .orderBy(desc(auditEvents.id))
    .limit(100);

  const officerApprovals = readAll
    ? await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(auditEvents)
        .where(eq(auditEvents.action, AUDIT_ACTION.MemberEditApproved))
    : [];

  return c.render(
    <div class="space-y-6">
      <div class="flex items-baseline justify-between">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Activity</h1>
        {!readAll && (
          <p class="text-sm text-neutral-500">
            Changes you made, and changes made to your profile.
          </p>
        )}
      </div>

      {readAll && (officerApprovals[0]?.n ?? 0) > 0 && (
        <p class="rounded-lg bg-neutral-50 ring-1 ring-neutral-200 px-4 py-3 text-sm text-neutral-700">
          {officerApprovals[0]!.n} member edit
          {officerApprovals[0]!.n === 1 ? ' has' : 's have'} been approved. Officers can
          approve, so it is worth reviewing these periodically.
        </p>
      )}

      {rows.length === 0 ? (
        <p class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 text-neutral-600">
          Nothing recorded yet.
        </p>
      ) : (
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-neutral-50 text-left">
              <tr>
                <th class="px-4 py-3 font-medium text-neutral-600">When</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Who</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Action</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Target</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Changed</th>
                {readAll && <th class="px-4 py-3 font-medium text-neutral-600">IP</th>}
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              {rows.map((row) => (
                <tr>
                  <td class="px-4 py-3 text-neutral-500 whitespace-nowrap">
                    {row.createdAt.replace('T', ' ').slice(0, 16)}
                  </td>
                  <td class="px-4 py-3 text-neutral-800">
                    {row.actorLabel ?? (row.actorKind === 'system' ? 'System' : 'Unknown')}
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-neutral-700">{row.action}</td>
                  <td class="px-4 py-3 text-neutral-600">{row.targetId}</td>
                  <td class="px-4 py-3 text-neutral-600">
                    {row.diff ? Object.keys(row.diff).join(', ') : '—'}
                  </td>
                  {readAll && (
                    <td class="px-4 py-3 text-neutral-400 font-mono text-xs">
                      {row.ip ?? '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>,
    { title: 'Activity' },
  );
});

// ---------------------------------------------------------------- members

adminRoutes.get('/admin/members', requirePermission('member', 'update'), async (c) => {
  const db = getDb(c.env.DB);
  const roster = await db
    .select({
      id: members.id,
      name: members.name,
      grade: members.grade,
      visibility: members.visibility,
      hasPhoto: sql<number>`CASE WHEN ${members.photoImageId} IS NULL THEN 0 ELSE 1 END`,
      hasBio: sql<number>`CASE WHEN ${members.bio} IS NULL THEN 0 ELSE 1 END`,
      isActive: members.isActive,
    })
    .from(members)
    .orderBy(members.name);

  const publicCount = roster.filter((m) => m.visibility === MEMBER_VISIBILITY.Full).length;
  const changed = c.req.query('changed');
  const created = c.req.query('created');
  const invited = c.req.query('invited');
  const inviteError = c.req.query('inviteError');
  const advanced = c.req.query('advanced');
  const advanceError = c.req.query('advanceError');

  // Only the grades somebody is actually in, so the filter never offers an
  // option that selects nothing.
  const gradesInUse = GRADES.filter((g) => roster.some((m) => m.grade === g));

  const canAdvance = can(c.get('role')!, 'member', 'advanceYear');
  const schoolYear = schoolYearStart(new Date());
  const rollover = canAdvance ? await previewAdvanceGrades(db) : null;

  return c.render(
    <div class="space-y-6">
      <div class="flex items-center justify-between gap-4">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Members</h1>
        {can(c.get('role')!, 'member', 'create') && (
          <a
            href="/admin/members/new"
            class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Add member
          </a>
        )}
      </div>

      {changed && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          Updated {changed} member{changed === '1' ? '' : 's'}.
        </p>
      )}

      {created && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          Added {created}, listed as first name and last initial.
          {invited === '1' && ' Their sign-in invitation is on its way.'}
          {invited === 'unsent' &&
            ' The invitation was created but the email could not be sent - resend it from Accounts.'}
        </p>
      )}

      {inviteError && (
        <p class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
          {created} was added, but the invitation failed: {inviteError} You can invite them
          from Accounts.
        </p>
      )}

      {advanced && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          Moved {advanced} member{advanced === '1' ? '' : 's'} up a grade.
        </p>
      )}

      {advanceError && (
        <p class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
          {advanceError}
        </p>
      )}

      <div class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
        <strong>{publicCount} of {roster.length}</strong> members show a full profile.
        Everyone else appears as first name and last initial with no photo. Only make
        someone public if a photo release is on file for them.
      </div>

      {rollover && rollover.total > 0 && (
        <details class="rounded-xl bg-white ring-1 ring-neutral-200 px-4 py-3">
          <summary class="cursor-pointer text-sm font-medium text-neutral-800">
            Start the {schoolYearLabel(schoolYear)} school year
          </summary>

          <div class="mt-4 space-y-4 text-sm text-neutral-700">
            <p>
              Moves every student up one grade. This is the only place grades change in
              bulk, and there is no undo - putting {rollover.total} members back is{' '}
              {rollover.total} edits by hand.
            </p>

            <ul class="space-y-1">
              {rollover.counts.map((row) => (
                <li>
                  <strong>{row.count}</strong> {gradePlural(row.grade)} &rarr;{' '}
                  {gradePlural(row.next)}
                  {row.next === 'Alumni' && (
                    <span class="text-amber-700"> (they leave the members page)</span>
                  )}
                </li>
              ))}
            </ul>

            <form
              method="post"
              action="/admin/members/advance-year"
              onsubmit={`return confirm('Move ${rollover.total} members up a grade and graduate ${rollover.graduating} seniors? This cannot be undone.')`}
            >
              <input type="hidden" name="schoolYear" value={String(schoolYear)} />
              <label class="flex items-start gap-2 mb-3">
                <input type="checkbox" name="acknowledged" required class="mt-1" />
                <span>
                  I am starting the {schoolYearLabel(schoolYear)} year and the{' '}
                  {rollover.graduating} current seniors have graduated
                </span>
              </label>
              <button
                type="submit"
                class="px-5 py-2 bg-neutral-800 hover:bg-neutral-900 text-white font-medium rounded-lg transition-colors"
              >
                Advance all grades
              </button>
            </form>
          </div>
        </details>
      )}

      <RosterFilters grades={gradesInUse} />

      <form method="post" action="/admin/members/visibility">
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-neutral-50 text-left">
              <tr>
                <th class="px-4 py-3 w-8">
                  <input
                    type="checkbox"
                    id="roster-select-all"
                    aria-label="Select all shown members"
                  />
                </th>
                <th class="px-4 py-3 font-medium text-neutral-600">Name</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Grade</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Visibility</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Has</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              {roster.map((m) => (
                <tr
                  class={m.isActive ? '' : 'opacity-50'}
                  {...rosterRowAttrs({
                    name: m.name,
                    grade: m.grade,
                    visibility: m.visibility,
                    isActive: m.isActive,
                    hasPhoto: Boolean(m.hasPhoto),
                    hasBio: Boolean(m.hasBio),
                  })}
                >
                  <td class="px-4 py-2">
                    <input type="checkbox" name="memberIds" value={m.id} />
                  </td>
                  <td class="px-4 py-2">
                    <a
                      href={`/admin/members/${m.id}`}
                      class="text-primary-600 hover:text-primary-700"
                    >
                      {m.name}
                    </a>
                  </td>
                  <td class="px-4 py-2 text-neutral-500">{m.grade}</td>
                  <td class="px-4 py-2">
                    <span
                      class={`px-2 py-0.5 rounded-full text-xs ${
                        m.visibility === MEMBER_VISIBILITY.Full
                          ? 'bg-green-100 text-green-800'
                          : 'bg-neutral-100 text-neutral-600'
                      }`}
                    >
                      {m.visibility}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-neutral-500 text-xs">
                    {[m.hasPhoto ? 'photo' : null, m.hasBio ? 'bio' : null]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p class="mt-3 text-sm text-neutral-500" role="status" aria-live="polite">
          Showing <span data-shown>{roster.length}</span> of {roster.length}.
          <span data-selected-wrap class="hidden">
            {' '}
            <strong data-selected>0</strong> selected.
          </span>
        </p>

        <div class="flex flex-wrap gap-3 mt-4 items-center">
          <button
            type="submit"
            name="visibility"
            value={MEMBER_VISIBILITY.Full}
            class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
          >
            Make selected public
          </button>
          <button
            type="submit"
            name="visibility"
            value={MEMBER_VISIBILITY.Limited}
            class="px-5 py-2 bg-neutral-200 hover:bg-neutral-300 text-neutral-800 font-medium rounded-lg transition-colors"
          >
            Make selected private
          </button>
          <label class="flex items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" name="acknowledged" required />
            I have confirmed a photo release is on file for each selected member
          </label>
        </div>
      </form>

      <RosterFilterScript />
    </div>,
    { title: 'Members' },
  );
});

// ------------------------------------------------------- create a member

interface MemberFormValues {
  name: string;
  grade: string;
  graduationYear: string;
  email: string;
  role: string;
}

const EMPTY_MEMBER_FORM: MemberFormValues = {
  name: '',
  grade: 'Freshman',
  graduationYear: '',
  email: '',
  role: APP_ROLE.Member,
};

/**
 * The add-member form.
 *
 * Re-rendered with the submitted values when a name collides, so hitting a
 * conflict never costs someone their typing.
 */
function MemberForm({
  values,
  canSetOfficer,
  canInvite,
  allowDuplicate = false,
}: {
  values: MemberFormValues;
  canSetOfficer: boolean;
  canInvite: boolean;
  allowDuplicate?: boolean;
}) {
  const field =
    'w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none';
  const key = allowDuplicate ? 'dup' : 'new';

  return (
    <form method="post" action="/admin/members/new" class="space-y-5">
      {allowDuplicate && <input type="hidden" name="allowDuplicate" value="1" />}

      <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for={`m-name-${key}`} class="block text-sm font-medium text-neutral-700 mb-1">
              Full name
            </label>
            <input
              type="text"
              id={`m-name-${key}`}
              name="name"
              required
              maxlength={120}
              value={values.name}
              class={field}
            />
          </div>

          <div>
            <label for={`m-grade-${key}`} class="block text-sm font-medium text-neutral-700 mb-1">
              Grade
            </label>
            <select id={`m-grade-${key}`} name="grade" class={`${field} bg-white`}>
              {GRADES.map((g) => (
                <option value={g} selected={values.grade === g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label for={`m-year-${key}`} class="block text-sm font-medium text-neutral-700 mb-1">
              Graduation year (optional)
            </label>
            <input
              type="text"
              id={`m-year-${key}`}
              name="graduationYear"
              inputmode="numeric"
              placeholder="2027"
              value={values.graduationYear}
              class={field}
            />
          </div>
        </div>

        <p class="rounded-lg bg-neutral-50 ring-1 ring-neutral-200 px-4 py-3 text-sm text-neutral-700">
          They will be listed as first name and last initial, with no photo and no
          profile page, until they choose otherwise themselves.
        </p>

        {canSetOfficer && (
          <p class="text-sm text-neutral-600">
            Club offices are recorded on the member's own page once they exist, so a
            term can carry a start and end year rather than being a checkbox.
          </p>
        )}
      </div>

      {canInvite && (
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 space-y-4">
          <div>
            <h2 class="font-display font-semibold text-neutral-900">
              Invite them to sign in
            </h2>
            <p class="text-sm text-neutral-600 mt-1">
              Optional. Leave the email empty for someone who only needs to appear in a
              program - most members never sign in at all.
            </p>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                for={`m-email-${key}`}
                class="block text-sm font-medium text-neutral-700 mb-1"
              >
                Email address
              </label>
              <input
                type="email"
                id={`m-email-${key}`}
                name="email"
                value={values.email}
                class={field}
              />
              <p class="text-xs text-neutral-500 mt-1">
                Must be the address they will actually sign in with.
              </p>
            </div>

            <div>
              <label
                for={`m-role-${key}`}
                class="block text-sm font-medium text-neutral-700 mb-1"
              >
                Role
              </label>
              <select id={`m-role-${key}`} name="role" class={`${field} bg-white`}>
                <option value={APP_ROLE.Member} selected={values.role === APP_ROLE.Member}>
                  Member - own profile only
                </option>
                <option value={APP_ROLE.Officer} selected={values.role === APP_ROLE.Officer}>
                  Officer - news, cast lists, approvals
                </option>
                <option value={APP_ROLE.Staff} selected={values.role === APP_ROLE.Staff}>
                  Staff - everything except accounts
                </option>
                <option value={APP_ROLE.Admin} selected={values.role === APP_ROLE.Admin}>
                  Admin - everything
                </option>
              </select>
            </div>
          </div>
        </div>
      )}

      <div class="flex gap-3">
        <button
          type="submit"
          class="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
        >
          {allowDuplicate ? 'Add as a different person' : 'Add member'}
        </button>
        <a
          href="/admin/members"
          class="px-6 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 font-medium rounded-lg transition-colors"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

adminRoutes.get('/admin/members/new', requirePermission('member', 'create'), (c) =>
  c.render(
    <div class="max-w-2xl space-y-6">
      <div>
        <a href="/admin/members" class="text-sm text-primary-600 hover:text-primary-700">
          &larr; All members
        </a>
        <h1 class="font-display text-2xl font-bold text-neutral-900 mt-2">Add a member</h1>
      </div>

      <MemberForm
        values={EMPTY_MEMBER_FORM}
        canSetOfficer={can(c.get('role')!, 'member', 'setOfficer')}
        canInvite={can(c.get('role')!, 'account', 'invite')}
      />
    </div>,
    { title: 'Add a member' },
  ),
);

adminRoutes.post('/admin/members/new', requirePermission('member', 'create'), async (c) => {
  const db = getDb(c.env.DB);
  const actor = c.get('actor');
  const role = c.get('role')!;
  const canSetOfficer = can(role, 'member', 'setOfficer');
  const canInvite = can(role, 'account', 'invite');

  const form = await c.req.formData();
  const values: MemberFormValues = {
    name: String(form.get('name') ?? ''),
    grade: String(form.get('grade') ?? 'Freshman'),
    graduationYear: String(form.get('graduationYear') ?? '').trim(),
    email: canInvite ? String(form.get('email') ?? '').trim() : '',
    role: String(form.get('role') ?? APP_ROLE.Member),
  };

  const year = Number.parseInt(values.graduationYear, 10);

  const result = await createMember(
    db,
    actor,
    {
      name: values.name,
      grade: isGrade(values.grade) ? values.grade : 'Freshman',
      graduationYear: Number.isFinite(year) ? year : null,
    },
    { allowDuplicateName: Boolean(form.get('allowDuplicate')) },
  );

  if (!result.ok && result.reason === 'invalid') {
    return c.render(
      <div class="max-w-2xl space-y-6">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Add a member</h1>
        <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
          {result.error}
        </p>
        <MemberForm values={values} canSetOfficer={canSetOfficer} canInvite={canInvite} />
      </div>,
      { title: 'Add a member' },
    );
  }

  if (!result.ok && result.reason === 'duplicate') {
    return c.render(
      <div class="max-w-2xl space-y-6">
        <h1 class="font-display text-2xl font-bold text-neutral-900">
          Someone by that name is already on the roster
        </h1>

        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
          <p class="font-medium text-neutral-900">{result.existing.name}</p>
          <p class="text-sm text-neutral-500">
            {result.existing.grade}
            {result.existing.isActive ? '' : ' - no longer active'}
          </p>

          <p class="text-sm text-neutral-600 mt-4">
            If this is the same person, use the record they already have: their cast
            credits and history are attached to it, and a second record splits them
            across two ids.
          </p>

          <div class="flex flex-wrap gap-3 mt-4">
            {!result.existing.isActive && (
              <form method="post" action={`/admin/members/${result.existing.id}/reactivate`}>
                <button
                  type="submit"
                  class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Same person - put them back on the roster
                </button>
              </form>
            )}
            <a
              href="/admin/members"
              class="px-5 py-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-sm font-medium rounded-lg transition-colors"
            >
              {result.existing.isActive ? 'Same person - never mind' : 'Cancel'}
            </a>
          </div>
        </div>

        <div>
          <h2 class="font-display font-semibold text-neutral-900 mb-1">
            Or is this a different student?
          </h2>
          <p class="text-sm text-neutral-600 mb-4">
            Two students really can share a name. This one would be added as{' '}
            <code>{result.suggestedId}</code>.
          </p>
          <MemberForm
            values={values}
            canSetOfficer={canSetOfficer}
            canInvite={canInvite}
            allowDuplicate
          />
        </div>
      </div>,
      { title: 'Name already used' },
    );
  }

  if (!result.ok) return c.redirect('/admin/members', 302);

  // The member is kept whatever happens to the invite. Discarding them on a
  // send failure would mean retyping the roster entry to try again.
  let notice = '';
  if (canInvite && values.email.length > 0) {
    const invite = await createInvite(db, actor, c.env.EMAIL, c.env.SITE_URL, {
      email: values.email,
      role: (values.role as AppRole) ?? APP_ROLE.Member,
      memberId: result.id,
    });
    notice = invite.ok
      ? invite.emailed
        ? '&invited=1'
        : '&invited=unsent'
      : `&inviteError=${encodeURIComponent(invite.error)}`;
  }

  return c.redirect(`/admin/members?created=${encodeURIComponent(values.name)}${notice}`, 302);
});

adminRoutes.post(
  '/admin/members/:id/reactivate',
  requirePermission('member', 'update'),
  async (c) => {
    await reactivateMember(getDb(c.env.DB), c.get('actor'), c.req.param('id'));
    return c.redirect('/admin/members', 302);
  },
);

adminRoutes.post(
  '/admin/members/advance-year',
  requirePermission('member', 'advanceYear'),
  async (c) => {
    const form = await c.req.formData();
    // Enforced server-side, not merely marked required in the markup.
    if (!form.get('acknowledged')) return c.redirect('/admin/members', 302);

    // The year comes from the form rather than the clock so that the page the
    // person read is the year they advanced. A tab left open across July would
    // otherwise run a different rollover than the one it described.
    const schoolYear = Number(form.get('schoolYear'));
    if (!Number.isInteger(schoolYear)) return c.redirect('/admin/members', 302);

    const result = await advanceGrades(getDb(c.env.DB), c.get('actor'), schoolYear);

    if (!result.ok) {
      const message = `Grades have already been advanced for ${schoolYearLabel(schoolYear)}. Nothing was changed.`;
      return c.redirect(`/admin/members?advanceError=${encodeURIComponent(message)}`, 302);
    }

    return c.redirect(`/admin/members?advanced=${result.advanced}`, 302);
  },
);

adminRoutes.post(
  '/admin/members/visibility',
  requirePermission('member', 'update'),
  async (c) => {
    const form = await c.req.formData();
    // Enforced server-side, not merely marked required in the markup.
    if (!form.get('acknowledged')) return c.redirect('/admin/members', 302);

    const visibility = String(form.get('visibility'));
    if (visibility !== MEMBER_VISIBILITY.Full && visibility !== MEMBER_VISIBILITY.Limited) {
      return c.redirect('/admin/members', 302);
    }

    const ids = form.getAll('memberIds').map(String).filter(Boolean);
    if (ids.length === 0) return c.redirect('/admin/members', 302);

    const db = getDb(c.env.DB);
    const actor = c.get('actor');
    let changed = 0;

    // Written one at a time so each member gets its own audit row. A single
    // bulk row would record "someone changed 40 people" without saying which,
    // which is exactly what the log exists to answer.
    for (const id of ids) {
      const [current] = await db.select().from(members).where(eq(members.id, id)).limit(1);
      if (!current || current.visibility === visibility) continue;

      await writeWithAudit(
        db,
        actor,
        [
          db
            .update(members)
            .set({ visibility, updatedAt: new Date().toISOString() })
            .where(eq(members.id, id)),
        ],
        {
          action: AUDIT_ACTION.MemberVisibilityChanged,
          targetKind: AUDIT_ENTITY_KIND.Member,
          targetId: id,
          diff: { visibility: { before: current.visibility, after: visibility } },
          payload: { bulk: true },
        },
      );
      changed++;
    }

    return c.redirect(`/admin/members?changed=${changed}`, 302);
  },
);

// --------------------------------------------------------- edit a member
//
// Registered after /admin/members/new and /admin/members/visibility so those
// literal paths are not swallowed by the :id parameter.

adminRoutes.get('/admin/members/:id', requirePermission('member', 'update'), async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');
  const role = c.get('role')!;
  const id = c.req.param('id');

  const [member] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!member) return c.notFound();

  const queued = await db
    .select()
    .from(pendingEdits)
    .where(
      and(eq(pendingEdits.targetId, id), eq(pendingEdits.status, PENDING_EDIT_STATUS.Pending)),
    );

  const canSetOfficer = can(role, 'member', 'setOfficer');
  const offices = await getOffices(db, id);
  // A school year is named for the calendar year it starts in, and it starts
  // in August, so anything before then still belongs to the previous one.
  const now = new Date();
  const schoolYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const photo = images.deliveryUrl(member.photoImageId, IMAGE_VARIANT.Thumb);
  const saved = c.req.query('saved');
  const error = c.req.query('error');
  const field =
    'w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none';

  return c.render(
    <div class="max-w-2xl space-y-6">
      <div>
        <a href="/admin/members" class="text-sm text-primary-600 hover:text-primary-700">
          &larr; All members
        </a>
        <h1 class="font-display text-2xl font-bold text-neutral-900 mt-2">{member.name}</h1>
        <p class="text-sm text-neutral-500">
          {member.isActive ? 'On the roster' : 'Not on the roster'}
          {' · '}
          {member.visibility === MEMBER_VISIBILITY.Full
            ? 'shown publicly'
            : `shown as ${displayName({ name: member.name, visibility: MEMBER_VISIBILITY.Limited })}`}
        </p>
      </div>

      {saved && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          {saved === 'removed'
            ? 'Their photo, biography, and full name have been taken down.'
            : 'Saved.'}
        </p>
      )}
      {error && (
        <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
          {error}
        </p>
      )}

      {queued.length > 0 && (
        <p class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
          This member has {queued.length} change{queued.length === 1 ? '' : 's'} waiting in{' '}
          <a href="/admin/approvals" class="underline">
            approvals
          </a>
          . Approving later will overwrite whatever you set here.
        </p>
      )}

      <form
        method="post"
        action={`/admin/members/${member.id}`}
        enctype="multipart/form-data"
        class="space-y-5"
      >
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 space-y-4">
          <h2 class="font-display font-semibold text-neutral-900">Roster</h2>

          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label for="e-name" class="block text-sm font-medium text-neutral-700 mb-1">
                Full name
              </label>
              <input
                type="text"
                id="e-name"
                name="name"
                required
                maxlength={120}
                value={member.name}
                class={field}
              />
              <p class="text-xs text-neutral-500 mt-1">
                The web address stays <code>/members/{member.id}</code> even if the name
                changes, so existing links and their show credits keep working.
              </p>
            </div>

            <div>
              <label for="e-grade" class="block text-sm font-medium text-neutral-700 mb-1">
                Grade
              </label>
              <select id="e-grade" name="grade" class={`${field} bg-white`}>
                {GRADES.map((g) => (
                  <option value={g} selected={member.grade === g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label for="e-year" class="block text-sm font-medium text-neutral-700 mb-1">
                Graduation year
              </label>
              <input
                type="text"
                id="e-year"
                name="graduationYear"
                inputmode="numeric"
                value={member.graduationYear ? String(member.graduationYear) : ''}
                class={field}
              />
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" name="isActive" value="1" checked={member.isActive} />
            Currently on the roster
          </label>

        </div>

        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 space-y-4">
          <div>
            <h2 class="font-display font-semibold text-neutral-900">Profile</h2>
            <p class="text-sm text-neutral-600 mt-1">
              This is what the member writes about themselves. Editing it here publishes
              immediately, with no review, and your name is recorded against the change.
            </p>
          </div>

          <div>
            <label for="e-bio" class="block text-sm font-medium text-neutral-700 mb-1">
              Bio
            </label>
            <textarea id="e-bio" name="bio" rows={5} maxlength={2000} class={field}>
              {member.bio ?? ''}
            </textarea>
          </div>

          <div>
            <label for="e-insta" class="block text-sm font-medium text-neutral-700 mb-1">
              Instagram handle
            </label>
            <input
              type="text"
              id="e-insta"
              name="instagram"
              maxlength={64}
              value={member.instagram ?? ''}
              class={field}
            />
          </div>

          <div>
            <p class="block text-sm font-medium text-neutral-700 mb-1">Photo</p>
            <div class="flex items-start gap-4">
              {photo ? (
                <img
                  src={photo}
                  alt=""
                  class="w-24 h-24 rounded-lg object-cover ring-1 ring-neutral-200 shrink-0"
                />
              ) : (
                <div class="w-24 h-24 rounded-lg bg-neutral-100 ring-1 ring-neutral-200 shrink-0 flex items-center justify-center text-xs text-neutral-400">
                  None
                </div>
              )}
              <div class="flex-1">
                <input
                  type="file"
                  name="photo"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  class="w-full text-sm text-neutral-600 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border-0 file:bg-neutral-100 file:text-neutral-800 file:font-medium hover:file:bg-neutral-200"
                />
                <p class="text-xs text-neutral-500 mt-2">
                  Up to {MAX_IMAGE_BYTES / 1024 / 1024} MB. Leave empty to keep the current
                  photo.
                </p>
                {member.photoImageId && (
                  <label class="flex items-center gap-2 text-sm text-neutral-700 mt-3">
                    <input type="checkbox" name="removePhoto" value="1" />
                    Remove the photo
                  </label>
                )}
              </div>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 space-y-4">
          <h2 class="font-display font-semibold text-neutral-900">Public visibility</h2>

          {([MEMBER_VISIBILITY.Limited, MEMBER_VISIBILITY.Full] as const).map((value) => (
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                value={value}
                checked={member.visibility === value}
                class="mt-1"
              />
              <span>
                <span class="block font-medium text-neutral-900">
                  {VISIBILITY_LABELS[value]}
                </span>
                <span class="block text-sm text-neutral-500">
                  {value === MEMBER_VISIBILITY.Limited
                    ? 'No photo, no bio, no profile page.'
                    : 'Full name, photo, and bio, with their own page.'}
                </span>
              </span>
            </label>
          ))}

          <label class="flex items-start gap-2 text-sm text-neutral-700 pt-2 border-t border-neutral-100">
            <input type="checkbox" name="acknowledged" class="mt-0.5" />
            <span>
              If making them public: I have confirmed a photo release is on file for this
              member.
            </span>
          </label>
        </div>

        <button
          type="submit"
          class="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
        >
          Save
        </button>
      </form>

      {canSetOfficer && (
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
          <h2 class="font-display font-semibold text-neutral-900">Club offices</h2>
          <p class="text-sm text-neutral-600 mt-1 mb-4">
            A term stays on their profile after it ends, so a student can point at what
            they held and when. Someone is a current officer exactly while a term has no
            end year.
          </p>

          {offices.length > 0 && (
            <ul class="space-y-2 mb-5">
              {offices.map((o) => (
                <li class="flex flex-wrap items-center gap-3 text-sm">
                  <span class="font-medium text-neutral-900">{o.title}</span>
                  <span class="text-neutral-500">
                    {o.startYear}
                    {'–'}
                    {o.endYear ?? 'present'}
                  </span>
                  {o.endYear === null && (
                    <span class="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs">
                      current
                    </span>
                  )}

                  {o.endYear === null && (
                    <form
                      method="post"
                      action={`/admin/members/${member.id}/offices/${o.id}/end`}
                      class="flex items-center gap-2"
                    >
                      <input
                        type="text"
                        name="endYear"
                        inputmode="numeric"
                        value={String(o.startYear + 1)}
                        class="w-20 px-2 py-1 rounded border border-neutral-300 text-sm"
                        aria-label="Year the term ended"
                      />
                      <button
                        type="submit"
                        class="px-3 py-1 text-xs bg-neutral-100 hover:bg-neutral-200 rounded transition-colors"
                      >
                        End term
                      </button>
                    </form>
                  )}

                  <form
                    method="post"
                    action={`/admin/members/${member.id}/offices/${o.id}/delete`}
                    onsubmit="return confirm('Remove this term entirely? Ending it is usually what you want.')"
                    class="ml-auto"
                  >
                    <button
                      type="submit"
                      class="px-2 py-1 text-xs text-red-700 hover:bg-red-50 rounded transition-colors"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <form
            method="post"
            action={`/admin/members/${member.id}/offices`}
            class="flex flex-wrap gap-3 items-end pt-4 border-t border-neutral-100"
          >
            <div class="flex-1 min-w-40">
              <label for="o-title" class="block text-xs font-medium text-neutral-600 mb-1">
                Office
              </label>
              <input
                type="text"
                id="o-title"
                name="title"
                required
                maxlength={60}
                placeholder="Treasurer"
                class="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm"
              />
            </div>
            <div>
              <label for="o-start" class="block text-xs font-medium text-neutral-600 mb-1">
                School year starting
              </label>
              <input
                type="text"
                id="o-start"
                name="startYear"
                required
                inputmode="numeric"
                value={String(schoolYear)}
                class="w-24 px-3 py-2 rounded-lg border border-neutral-300 text-sm"
              />
            </div>
            <button
              type="submit"
              class="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Add term
            </button>
          </form>
          <p class="text-xs text-neutral-500 mt-2">
            {schoolYear}
            {'–'}
            {schoolYear + 1} is the current school year. Leave a term open; end it when
            the board changes.
          </p>
        </div>
      )}

      <div class="bg-white rounded-xl ring-1 ring-red-200 p-6">
        <h2 class="font-display font-semibold text-neutral-900">
          Remove their information
        </h2>
        <p class="text-sm text-neutral-600 mt-1 mb-4">
          For a student or family asking to be taken off the site. Clears the photo,
          biography, and handle, hides the surname, and takes them off the roster. Their
          part in past productions stays, credited as{' '}
          {displayName({ name: member.name, visibility: MEMBER_VISIBILITY.Limited })} -
          removing that would erase the record of who performed the role.
        </p>
        <form
          method="post"
          action={`/admin/members/${member.id}/remove`}
          onsubmit="return confirm('Take down this member’s photo, biography, and surname?')"
        >
          <button
            type="submit"
            class="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Remove their information
          </button>
        </form>
      </div>
    </div>,
    { title: member.name },
  );
});

adminRoutes.post('/admin/members/:id', requirePermission('member', 'update'), async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const role = c.get('role')!;
  const canSetOfficer = can(role, 'member', 'setOfficer');

  const [current] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!current) return c.notFound();

  const form = await c.req.formData();
  const back = (qs: string) => c.redirect(`/admin/members/${id}${qs}`, 302);

  const wants = String(form.get('visibility') ?? '');
  const visibility =
    wants === MEMBER_VISIBILITY.Full || wants === MEMBER_VISIBILITY.Limited ? wants : undefined;

  // Same gate as the bulk tool, so this is not a quieter route to the same
  // change. Only asked for when exposure increases; withdrawing is always free.
  if (
    visibility === MEMBER_VISIBILITY.Full &&
    current.visibility !== MEMBER_VISIBILITY.Full &&
    !form.get('acknowledged')
  ) {
    return back(
      `?error=${encodeURIComponent('Confirm a photo release is on file before making this member public.')}`,
    );
  }

  let photoImageId: string | null | undefined;
  if (form.get('removePhoto')) {
    photoImageId = null;
  } else {
    const upload = await uploadImage(c.get('images'), form.get('photo'));
    if (upload && 'error' in upload) return back(`?error=${encodeURIComponent(upload.error)}`);
    photoImageId = upload?.imageId;
  }

  const name = String(form.get('name') ?? '').trim().replace(/\s+/g, ' ');
  const grade = String(form.get('grade') ?? '');
  const year = Number.parseInt(String(form.get('graduationYear') ?? ''), 10);
  const bio = String(form.get('bio') ?? '').trim();
  const instagram = String(form.get('instagram') ?? '').trim();

  await updateMember(db, c.get('actor'), id, {
    name: name.length > 0 ? name : undefined,
    grade: isGrade(grade) ? grade : undefined,
    graduationYear: Number.isFinite(year) ? year : null,
    bio: bio.length > 0 ? bio : null,
    instagram: instagram.length > 0 ? instagram : null,
    photoImageId,
    visibility,
    isActive: Boolean(form.get('isActive')),
  });

  return back('?saved=1');
});

adminRoutes.post(
  '/admin/members/:id/offices',
  requirePermission('member', 'setOfficer'),
  async (c) => {
    const id = c.req.param('id');
    const form = await c.req.formData();
    const startYear = Number.parseInt(String(form.get('startYear') ?? ''), 10);

    if (!Number.isFinite(startYear) || startYear < 1900 || startYear > 2200) {
      return c.redirect(
        `/admin/members/${id}?error=${encodeURIComponent('Enter a four-digit year.')}`,
        302,
      );
    }

    const result = await addOffice(getDb(c.env.DB), c.get('actor'), id, {
      title: String(form.get('title') ?? ''),
      startYear,
    });

    return c.redirect(
      result.ok
        ? `/admin/members/${id}?saved=1`
        : `/admin/members/${id}?error=${encodeURIComponent(result.error)}`,
      302,
    );
  },
);

adminRoutes.post(
  '/admin/members/:id/offices/:officeId/end',
  requirePermission('member', 'setOfficer'),
  async (c) => {
    const id = c.req.param('id');
    const form = await c.req.formData();
    const endYear = Number.parseInt(String(form.get('endYear') ?? ''), 10);

    if (!Number.isFinite(endYear)) {
      return c.redirect(
        `/admin/members/${id}?error=${encodeURIComponent('Enter the year the term ended.')}`,
        302,
      );
    }

    await endOffice(getDb(c.env.DB), c.get('actor'), c.req.param('officeId'), endYear);
    return c.redirect(`/admin/members/${id}?saved=1`, 302);
  },
);

adminRoutes.post(
  '/admin/members/:id/offices/:officeId/delete',
  requirePermission('member', 'setOfficer'),
  async (c) => {
    await deleteOffice(getDb(c.env.DB), c.get('actor'), c.req.param('officeId'));
    return c.redirect(`/admin/members/${c.req.param('id')}?saved=1`, 302);
  },
);

adminRoutes.post(
  '/admin/members/:id/remove',
  requirePermission('member', 'update'),
  async (c) => {
    await removeMemberInformation(getDb(c.env.DB), c.get('actor'), c.req.param('id'));
    return c.redirect(`/admin/members/${c.req.param('id')}?saved=removed`, 302);
  },
);

// ------------------------------------------------------------- newsletter

adminRoutes.get('/admin/newsletter', requirePermission('account', 'invite'), async (c) => {
  const db = getDb(c.env.DB);
  const search = c.req.query('q') ?? '';
  const status = (c.req.query('status') ?? 'active') as 'active' | 'unsubscribed' | 'all';

  const [rows, counts] = await Promise.all([
    listSubscribers(db, { search, status }),
    countSubscribers(db),
  ]);

  const removed = c.req.query('removed');

  return c.render(
    <div class="space-y-6">
      <div class="flex items-center justify-between gap-4">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Newsletter</h1>
        <a
          href={`/admin/newsletter/export?status=${status}`}
          class="px-5 py-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-sm font-medium rounded-lg transition-colors"
        >
          Download CSV
        </a>
      </div>

      {removed && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          {removed} has been unsubscribed.
        </p>
      )}

      <div class="rounded-lg bg-neutral-50 ring-1 ring-neutral-200 px-4 py-3 text-sm text-neutral-700">
        <strong>{counts.active}</strong> subscribed, {counts.total - counts.active}{' '}
        unsubscribed.
        <span class="block mt-1">
          This site collects addresses and does not send newsletters. Download the list
          and send from a mailing service, which handles bulk delivery, bounces, and the
          unsubscribe requirements that come with it.
        </span>
      </div>

      <form method="get" action="/admin/newsletter" class="flex flex-wrap gap-3 items-end">
        <div class="flex-1 min-w-48">
          <label for="q" class="block text-xs font-medium text-neutral-600 mb-1">
            Search
          </label>
          <input
            type="text"
            id="q"
            name="q"
            value={search}
            placeholder="name or email"
            class="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm"
          />
        </div>
        <div>
          <label for="status" class="block text-xs font-medium text-neutral-600 mb-1">
            Show
          </label>
          <select
            id="status"
            name="status"
            class="px-3 py-2 rounded-lg border border-neutral-300 bg-white text-sm"
          >
            <option value="active" selected={status === 'active'}>
              Subscribed
            </option>
            <option value="unsubscribed" selected={status === 'unsubscribed'}>
              Unsubscribed
            </option>
            <option value="all" selected={status === 'all'}>
              Everyone
            </option>
          </select>
        </div>
        <button
          type="submit"
          class="px-4 py-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-sm font-medium rounded-lg transition-colors"
        >
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <p class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 text-neutral-600">
          No subscribers match.
        </p>
      ) : (
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-neutral-50 text-left">
              <tr>
                <th class="px-4 py-3 font-medium text-neutral-600">Email</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Name</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Subscribed</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Source</th>
                <th class="px-4 py-3" />
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              {rows.map((r) => (
                <tr class={r.unsubscribedAt ? 'opacity-50' : ''}>
                  <td class="px-4 py-2 text-neutral-900">{r.email}</td>
                  <td class="px-4 py-2 text-neutral-600">{r.name ?? '—'}</td>
                  <td class="px-4 py-2 text-neutral-500">{r.subscribedAt.slice(0, 10)}</td>
                  <td class="px-4 py-2 text-neutral-500">{r.source ?? '—'}</td>
                  <td class="px-4 py-2 text-right">
                    {r.unsubscribedAt ? (
                      <span class="text-xs text-neutral-400">
                        left {r.unsubscribedAt.slice(0, 10)}
                      </span>
                    ) : (
                      <form
                        method="post"
                        action="/admin/newsletter/unsubscribe"
                        onsubmit={`return confirm('Unsubscribe ${r.email.replace(/'/g, "\\'")}?')`}
                      >
                        <input type="hidden" name="email" value={r.email} />
                        <button
                          type="submit"
                          class="px-3 py-1 text-xs text-red-700 hover:bg-red-50 rounded transition-colors"
                        >
                          Unsubscribe
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p class="text-xs text-neutral-500">
        Showing at most 500. Someone who asks to be removed can be unsubscribed here; the
        row is kept so the same address is not silently re-added later.
      </p>
    </div>,
    { title: 'Newsletter' },
  );
});

adminRoutes.get(
  '/admin/newsletter/export',
  requirePermission('account', 'invite'),
  async (c) => {
    const status = (c.req.query('status') ?? 'active') as 'active' | 'unsubscribed' | 'all';
    const rows = await listSubscribers(getDb(c.env.DB), { status });

    const csv = toCsv(
      rows.map((r) => ({
        email: r.email,
        name: r.name ?? '',
        subscribed_at: r.subscribedAt,
        unsubscribed_at: r.unsubscribedAt ?? '',
        source: r.source ?? '',
      })),
      ['email', 'name', 'subscribed_at', 'unsubscribed_at', 'source'],
    );

    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="newsletter-${status}.csv"`,
      'Cache-Control': 'no-store',
    });
  },
);

adminRoutes.post(
  '/admin/newsletter/unsubscribe',
  requirePermission('account', 'invite'),
  async (c) => {
    const form = await c.req.formData();
    const email = String(form.get('email') ?? '');

    await unsubscribeByEmail(getDb(c.env.DB), c.get('actor'), email);
    return c.redirect(`/admin/newsletter?removed=${encodeURIComponent(email)}`, 302);
  },
);

// ---------------------------------------------------------------- accounts

const ROLE_CHOICES = [
  { value: APP_ROLE.Member, label: 'Member - own profile only' },
  { value: APP_ROLE.Officer, label: 'Officer - news, cast lists, approvals' },
  { value: APP_ROLE.Staff, label: 'Staff - everything except accounts' },
  { value: APP_ROLE.Admin, label: 'Admin - everything' },
] as const;

adminRoutes.get('/admin/accounts', requirePermission('account', 'invite'), async (c) => {
  const db = getDb(c.env.DB);

  const [allInvites, accounts, activeMembers] = await Promise.all([
    db.select().from(invites).orderBy(desc(invites.createdAt)).limit(100),
    db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        memberId: user.memberId,
      })
      .from(user)
      .orderBy(user.email),
    db
      .select({ id: members.id, name: members.name, grade: members.grade })
      .from(members)
      .where(eq(members.isActive, true))
      .orderBy(members.name),
  ]);

  // Members already claimed by another account, so the link dropdown cannot
  // offer a choice the service will refuse. One account per member.
  const claimed = new Map(
    accounts.filter((a) => a.memberId).map((a) => [a.memberId as string, a.id]),
  );
  const linkableFor = (currentMemberId: string | null) =>
    activeMembers.filter((m) => !claimed.has(m.id) || m.id === currentMemberId);

  const error = c.req.query('error');
  const sent = c.req.query('sent');

  return c.render(
    <div class="space-y-8">
      <h1 class="font-display text-2xl font-bold text-neutral-900">Accounts</h1>

      {c.req.query('error') && (
        <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
          {c.req.query('error')}
        </p>
      )}

      {error && (
        <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
          {error}
        </p>
      )}
      {sent === 'ok' && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          Invitation sent.
        </p>
      )}
      {sent === 'nomail' && (
        <p class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
          The invite was created but the email could not be sent. The person can still
          sign in with that address; you may want to tell them directly.
        </p>
      )}

      <section class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
        <h2 class="font-display font-semibold text-neutral-900 mb-1">Invite someone</h2>
        <p class="text-sm text-neutral-600 mb-4">
          Access is invitation-only. Send the invite to the address they will actually
          sign in with - a school Google account will only match if the address is the
          same.
        </p>

        <form method="post" action="/admin/accounts/invite" class="grid gap-4 sm:grid-cols-3">
          <div class="sm:col-span-3">
            <label for="inv-email" class="block text-sm font-medium text-neutral-700 mb-1">
              Email address
            </label>
            <input
              type="email"
              id="inv-email"
              name="email"
              required
              class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
            />
          </div>

          <div>
            <label for="inv-role" class="block text-sm font-medium text-neutral-700 mb-1">
              Role
            </label>
            <select
              id="inv-role"
              name="role"
              class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 bg-white"
            >
              <option value="member">Member - own profile only</option>
              <option value="officer">Officer - news, cast lists, approvals</option>
              <option value="staff">Staff - everything except accounts</option>
              <option value="admin">Admin - everything</option>
            </select>
          </div>

          <div class="sm:col-span-2">
            <label for="inv-member" class="block text-sm font-medium text-neutral-700 mb-1">
              Link to a member profile (optional)
            </label>
            <select
              id="inv-member"
              name="memberId"
              class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 bg-white"
            >
              <option value="">No profile - board member or volunteer</option>
              {linkableFor(null).map((m) => (
                <option value={m.id}>
                  {m.name} ({m.grade})
                </option>
              ))}
            </select>
          </div>

          <div class="sm:col-span-3">
            <button
              type="submit"
              class="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
            >
              Send invitation
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 class="font-display font-semibold text-neutral-900 mb-3">Invitations</h2>
        {allInvites.length === 0 ? (
          <p class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 text-neutral-600">
            No invitations yet.
          </p>
        ) : (
          <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-neutral-50 text-left">
                <tr>
                  <th class="px-4 py-3 font-medium text-neutral-600">Email</th>
                  <th class="px-4 py-3 font-medium text-neutral-600">Role</th>
                  <th class="px-4 py-3 font-medium text-neutral-600">Profile</th>
                  <th class="px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th class="px-4 py-3" />
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-100">
                {allInvites.map((inv) => {
                  const status = inviteStatus(inv);
                  return (
                    <tr>
                      <td class="px-4 py-2 text-neutral-900">{inv.email}</td>
                      <td class="px-4 py-2 text-neutral-600">{inv.role}</td>
                      <td class="px-4 py-2 text-neutral-500">{inv.memberId ?? '—'}</td>
                      <td class="px-4 py-2">
                        <span
                          class={`px-2 py-0.5 rounded-full text-xs ${
                            status === 'open'
                              ? 'bg-green-100 text-green-800'
                              : status === 'accepted'
                                ? 'bg-neutral-100 text-neutral-600'
                                : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {status}
                        </span>
                      </td>
                      <td class="px-4 py-2 text-right">
                        {status === 'open' && (
                          <form method="post" action={`/admin/accounts/${inv.id}/revoke`}>
                            <button
                              type="submit"
                              class="text-sm text-red-600 hover:text-red-700"
                            >
                              Revoke
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 class="font-display font-semibold text-neutral-900 mb-3">Existing accounts</h2>
        {accounts.length === 0 ? (
          <p class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 text-neutral-600">
            Nobody has signed in yet.
          </p>
        ) : (
          <div class="space-y-3">
            {accounts.map((a) => (
              <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-5">
                <div class="flex flex-wrap items-baseline justify-between gap-2 mb-4">
                  <div>
                    <p class="font-medium text-neutral-900">{a.email}</p>
                    <p class="text-sm text-neutral-500">
                      {a.name || 'no name set'}
                      {a.role ? '' : ' · no access'}
                    </p>
                  </div>
                  {a.id === c.get('actor').id && (
                    <span class="px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 text-xs">
                      you
                    </span>
                  )}
                </div>

                <div class="grid gap-4 sm:grid-cols-2">
                  <form
                    method="post"
                    action={`/admin/accounts/user/${a.id}/role`}
                    class="flex items-end gap-2"
                  >
                    <div class="flex-1">
                      <label
                        for={`role-${a.id}`}
                        class="block text-xs font-medium text-neutral-600 mb-1"
                      >
                        Role
                      </label>
                      <select
                        id={`role-${a.id}`}
                        name="role"
                        class="w-full px-3 py-2 rounded-lg border border-neutral-300 bg-white text-sm"
                      >
                        <option value="" selected={!a.role}>
                          None - no access
                        </option>
                        {ROLE_CHOICES.map((r) => (
                          <option value={r.value} selected={a.role === r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="submit"
                      class="px-4 py-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-sm font-medium rounded-lg transition-colors"
                    >
                      Set
                    </button>
                  </form>

                  <form
                    method="post"
                    action={`/admin/accounts/user/${a.id}/link`}
                    class="flex items-end gap-2"
                  >
                    <div class="flex-1">
                      <label
                        for={`link-${a.id}`}
                        class="block text-xs font-medium text-neutral-600 mb-1"
                      >
                        Member profile
                      </label>
                      <select
                        id={`link-${a.id}`}
                        name="memberId"
                        class="w-full px-3 py-2 rounded-lg border border-neutral-300 bg-white text-sm"
                      >
                        <option value="" selected={!a.memberId}>
                          Not linked
                        </option>
                        {linkableFor(a.memberId).map((m) => (
                          <option value={m.id} selected={a.memberId === m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="submit"
                      class="px-4 py-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-sm font-medium rounded-lg transition-colors"
                    >
                      Set
                    </button>
                  </form>
                </div>

                {a.role && (
                  <div class="mt-4 pt-3 border-t border-neutral-100 flex justify-end">
                    <form
                      method="post"
                      action={`/admin/accounts/user/${a.id}/revoke`}
                      onsubmit="return confirm('End this account’s access and sign them out?')"
                    >
                      <button
                        type="submit"
                        class="px-3 py-2 text-sm text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        Remove access
                      </button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>,
    { title: 'Accounts' },
  );
});

adminRoutes.post(
  '/admin/accounts/invite',
  requirePermission('account', 'invite'),
  async (c) => {
    const form = await c.req.formData();
    const role = String(form.get('role') ?? '');
    const memberId = String(form.get('memberId') ?? '').trim();

    const validRoles: string[] = [
      APP_ROLE.Admin,
      APP_ROLE.Staff,
      APP_ROLE.Officer,
      APP_ROLE.Member,
    ];
    if (!validRoles.includes(role)) {
      return c.redirect('/admin/accounts?error=Pick+a+valid+role', 302);
    }

    const result = await createInvite(
      getDb(c.env.DB),
      c.get('actor'),
      c.env.EMAIL,
      c.env.SITE_URL,
      {
        email: String(form.get('email') ?? ''),
        role: role as AppRole,
        memberId: memberId.length > 0 ? memberId : null,
      },
    );

    if (!result.ok) {
      return c.redirect(`/admin/accounts?error=${encodeURIComponent(result.error)}`, 302);
    }
    return c.redirect(`/admin/accounts?sent=${result.emailed ? 'ok' : 'nomail'}`, 302);
  },
);

adminRoutes.post(
  '/admin/accounts/:id/revoke',
  requirePermission('account', 'revoke'),
  async (c) => {
    await revokeInvite(getDb(c.env.DB), c.get('actor'), c.req.param('id'));
    return c.redirect('/admin/accounts', 302);
  },
);
// Namespaced under /user/ so these are not confused with the invite routes
// above, where :id is an invite id rather than an account id.

const isAppRole = (v: string): v is AppRole =>
  (Object.values(APP_ROLE) as string[]).includes(v);

adminRoutes.post(
  '/admin/accounts/user/:id/role',
  requirePermission('account', 'assignRole'),
  async (c) => {
    const form = await c.req.formData();
    const raw = String(form.get('role') ?? '');
    const result = await assignRole(
      getDb(c.env.DB),
      c.get('actor'),
      c.req.param('id'),
      isAppRole(raw) ? raw : null,
    );

    return c.redirect(
      result.ok ? '/admin/accounts' : `/admin/accounts?error=${encodeURIComponent(result.error)}`,
      302,
    );
  },
);

adminRoutes.post(
  '/admin/accounts/user/:id/link',
  requirePermission('account', 'link'),
  async (c) => {
    const form = await c.req.formData();
    const memberId = String(form.get('memberId') ?? '').trim();
    const result = await linkMember(
      getDb(c.env.DB),
      c.get('actor'),
      c.req.param('id'),
      memberId.length > 0 ? memberId : null,
    );

    return c.redirect(
      result.ok ? '/admin/accounts' : `/admin/accounts?error=${encodeURIComponent(result.error)}`,
      302,
    );
  },
);

adminRoutes.post(
  '/admin/accounts/user/:id/revoke',
  requirePermission('account', 'revoke'),
  async (c) => {
    const result = await revokeAccess(getDb(c.env.DB), c.get('actor'), c.req.param('id'));

    return c.redirect(
      result.ok ? '/admin/accounts' : `/admin/accounts?error=${encodeURIComponent(result.error)}`,
      302,
    );
  },
);


// ---------------------------------------------------------------- news

adminRoutes.get('/admin/news', requirePermission('news', 'create'), async (c) => {
  const db = getDb(c.env.DB);
  const posts = await db.select().from(news).orderBy(desc(news.publishedAt));

  return c.render(
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <h1 class="font-display text-2xl font-bold text-neutral-900">News</h1>
        <a
          href="/admin/news/new"
          class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
        >
          Write a post
        </a>
      </div>

      {posts.length === 0 ? (
        <p class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 text-neutral-600">
          No posts yet. The News section of the site stays hidden until there is
          something to show.
        </p>
      ) : (
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-neutral-50 text-left">
              <tr>
                <th class="px-4 py-3 font-medium text-neutral-600">Title</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Category</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Date</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Status</th>
                <th class="px-4 py-3" />
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              {posts.map((post) => (
                <tr>
                  <td class="px-4 py-2 text-neutral-900">{post.title}</td>
                  <td class="px-4 py-2 text-neutral-600">
                    {NEWS_CATEGORY_LABELS[post.category]}
                  </td>
                  <td class="px-4 py-2 text-neutral-500">{post.publishedAt}</td>
                  <td class="px-4 py-2">
                    <span
                      class={`px-2 py-0.5 rounded-full text-xs ${
                        post.isDraft
                          ? 'bg-neutral-100 text-neutral-600'
                          : 'bg-green-100 text-green-800'
                      }`}
                    >
                      {post.isDraft ? 'draft' : 'published'}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-right">
                    <a
                      href={`/admin/news/${post.id}`}
                      class="text-sm text-primary-600 hover:text-primary-700"
                    >
                      Edit
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>,
    { title: 'News' },
  );
});

const newsForm = (
  post: {
    id?: string;
    title?: string;
    excerpt?: string;
    bodyMd?: string;
    category?: string;
    publishedAt?: string;
    isDraft?: boolean;
  },
  action: string,
) => (
  <form method="post" action={action} class="space-y-5 max-w-2xl">
    <div>
      <label for="title" class="block text-sm font-medium text-neutral-700 mb-1">
        Title
      </label>
      <input
        type="text"
        id="title"
        name="title"
        required
        maxlength={200}
        value={post.title ?? ''}
        class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
      />
      {post.id && (
        <p class="text-xs text-neutral-500 mt-1">
          The web address stays <code>/news/{post.id}</code> even if you change the
          title, so links people have already shared keep working.
        </p>
      )}
    </div>

    <div>
      <label for="excerpt" class="block text-sm font-medium text-neutral-700 mb-1">
        Summary
      </label>
      <textarea
        id="excerpt"
        name="excerpt"
        required
        rows={2}
        maxlength={300}
        class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
      >
        {post.excerpt ?? ''}
      </textarea>
      <p class="text-xs text-neutral-500 mt-1">
        Shown on the news list and when the post is shared.
      </p>
    </div>

    <div>
      <label for="bodyMd" class="block text-sm font-medium text-neutral-700 mb-1">
        Post
      </label>
      <textarea
        id="bodyMd"
        name="bodyMd"
        required
        rows={14}
        class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 font-mono text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
      >
        {post.bodyMd ?? ''}
      </textarea>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div>
        <label for="category" class="block text-sm font-medium text-neutral-700 mb-1">
          Category
        </label>
        <select
          id="category"
          name="category"
          class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 bg-white"
        >
          {Object.entries(NEWS_CATEGORY_LABELS).map(([value, label]) => (
            <option value={value} selected={post.category === value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label for="publishedAt" class="block text-sm font-medium text-neutral-700 mb-1">
          Date
        </label>
        <input
          type="date"
          id="publishedAt"
          name="publishedAt"
          required
          value={(post.publishedAt ?? '').slice(0, 10)}
          class="w-full px-4 py-2.5 rounded-lg border border-neutral-300"
        />
      </div>
    </div>

    <label class="flex items-center gap-2 text-sm text-neutral-700">
      <input type="checkbox" name="publish" checked={post.isDraft === false} />
      Publish this post to the website
    </label>

    <div class="flex gap-3">
      <button
        type="submit"
        class="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
      >
        Save
      </button>
      <a
        href="/admin/news"
        class="px-6 py-2.5 bg-neutral-200 hover:bg-neutral-300 text-neutral-800 font-medium rounded-lg transition-colors"
      >
        Cancel
      </a>
    </div>
  </form>
);

adminRoutes.get('/admin/news/new', requirePermission('news', 'create'), (c) =>
  c.render(
    <div class="space-y-6">
      <h1 class="font-display text-2xl font-bold text-neutral-900">Write a post</h1>
      {newsForm(
        { publishedAt: new Date().toISOString().slice(0, 10), isDraft: true },
        '/admin/news/new',
      )}
    </div>,
    { title: 'Write a post' },
  ),
);

const readNewsForm = async (c: { req: { formData: () => Promise<FormData> } }) => {
  const form = await c.req.formData();
  const category = String(form.get('category') ?? '');
  return {
    title: String(form.get('title') ?? '').trim(),
    excerpt: String(form.get('excerpt') ?? '').trim(),
    bodyMd: String(form.get('bodyMd') ?? '').trim(),
    category: isNewsCategory(category) ? category : NEWS_CATEGORY.General,
    publishedAt: String(form.get('publishedAt') ?? '').slice(0, 10),
    isDraft: !form.get('publish'),
  };
};

adminRoutes.post('/admin/news/new', requirePermission('news', 'create'), async (c) => {
  const input = await readNewsForm(c);
  if (!input.title || !input.excerpt || !input.bodyMd) {
    return c.redirect('/admin/news/new', 302);
  }
  await createNewsPost(getDb(c.env.DB), c.get('actor'), input);
  return c.redirect('/admin/news', 302);
});

adminRoutes.get('/admin/news/:id', requirePermission('news', 'update'), async (c) => {
  const db = getDb(c.env.DB);
  const [post] = await db.select().from(news).where(eq(news.id, c.req.param('id'))).limit(1);
  if (!post) return c.notFound();

  return c.render(
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Edit post</h1>
        {!post.isDraft && (
          <a
            href={`/news/${post.id}`}
            class="text-sm text-primary-600 hover:text-primary-700"
          >
            View on site
          </a>
        )}
      </div>

      {newsForm(post, `/admin/news/${post.id}`)}

      <form
        method="post"
        action={`/admin/news/${post.id}/delete`}
        class="pt-6 border-t border-neutral-200 max-w-2xl"
      >
        <label class="flex items-center gap-2 text-sm text-neutral-700 mb-2">
          <input type="checkbox" name="confirm" required />
          Yes, permanently delete this post
        </label>
        <button type="submit" class="text-sm text-red-600 hover:text-red-700">
          Delete post
        </button>
      </form>
    </div>,
    { title: 'Edit post' },
  );
});

adminRoutes.post('/admin/news/:id', requirePermission('news', 'update'), async (c) => {
  const input = await readNewsForm(c);
  await updateNewsPost(getDb(c.env.DB), c.get('actor'), c.req.param('id'), input);
  return c.redirect('/admin/news', 302);
});

adminRoutes.post(
  '/admin/news/:id/delete',
  requirePermission('news', 'delete'),
  async (c) => {
    const form = await c.req.formData();
    if (!form.get('confirm')) return c.redirect(`/admin/news/${c.req.param('id')}`, 302);
    await deleteNewsPost(getDb(c.env.DB), c.get('actor'), c.req.param('id'));
    return c.redirect('/admin/news', 302);
  },
);

// ---------------------------------------------------------------- shows

/**
 * The three artwork slots, each with the variant used for its own preview so
 * the admin shows roughly what the public page will.
 */
const SHOW_IMAGE_FIELDS = [
  {
    column: 'posterImageId',
    label: 'Poster',
    variant: IMAGE_VARIANT.Poster,
    preview: 'aspect-[2/3]',
    hint: 'Portrait, 2:3.',
  },
  {
    column: 'heroImageId',
    label: 'Hero banner',
    variant: IMAGE_VARIANT.Hero,
    preview: 'aspect-video',
    hint: 'Wide, 16:9.',
  },
  {
    column: 'ogImageId',
    label: 'Social preview',
    variant: IMAGE_VARIANT.Og,
    preview: 'aspect-[1200/630]',
    hint: 'Optional. Falls back to the hero.',
  },
] as const;

adminRoutes.get('/admin/shows', requirePermission('cast', 'assign'), async (c) => {
  const db = getDb(c.env.DB);
  const all = await db
    .select({
      id: shows.id,
      title: shows.title,
      season: shows.season,
      year: shows.year,
      isCurrent: shows.isCurrent,
      lastPerformance: sql<string | null>`(
        SELECT MAX(p.date) FROM show_performances p WHERE p.show_id = shows.id
      )`,
    })
    .from(shows)
    .orderBy(desc(shows.year));

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  return c.render(
    <div class="space-y-6">
      <div class="flex items-center justify-between gap-4">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Shows</h1>
        {can(c.get('role')!, 'show', 'create') && (
          <a
            href="/admin/shows/new"
            class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Add show
          </a>
        )}
      </div>
      <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-neutral-50 text-left">
            <tr>
              <th class="px-4 py-3 font-medium text-neutral-600">Show</th>
              <th class="px-4 py-3 font-medium text-neutral-600">Season</th>
              <th class="px-4 py-3 font-medium text-neutral-600">Home page</th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            {all.map((show) => (
              <tr>
                <td class="px-4 py-2 text-neutral-900">{show.title}</td>
                <td class="px-4 py-2 text-neutral-500">{show.season}</td>
                <td class="px-4 py-2 text-neutral-500">
                  {show.isCurrent ? (
                    show.lastPerformance && show.lastPerformance < today ? (
                      <span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">
                        featured, run over
                      </span>
                    ) : (
                      <span class="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs">
                        featured
                      </span>
                    )
                  ) : (
                    '\u2014'
                  )}
                </td>
                <td class="px-4 py-2 text-right">
                  <a
                    href={`/admin/shows/${show.id}`}
                    class="text-sm text-primary-600 hover:text-primary-700"
                  >
                    Cast &amp; crew
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>,
    { title: 'Shows' },
  );
});

// --------------------------------------------------------- create a show
// Registered before /admin/shows/:id so `new` is not read as an id.

interface ShowFormValues {
  title: string;
  season: string;
  year: string;
  venue: string;
  synopsis: string;
  ticketUrl: string;
  isHighlighted: boolean;
}

function ShowFields({ values }: { values: ShowFormValues }) {
  const field =
    'w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none';

  return (
    <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 space-y-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="sm:col-span-2">
          <label for="s-title" class="block text-sm font-medium text-neutral-700 mb-1">
            Title
          </label>
          <input
            type="text"
            id="s-title"
            name="title"
            required
            maxlength={200}
            value={values.title}
            class={field}
          />
        </div>

        <div>
          <label for="s-season" class="block text-sm font-medium text-neutral-700 mb-1">
            Season
          </label>
          <input
            type="text"
            id="s-season"
            name="season"
            required
            placeholder="Fall 2026"
            maxlength={40}
            value={values.season}
            class={field}
          />
        </div>

        <div>
          <label for="s-year" class="block text-sm font-medium text-neutral-700 mb-1">
            Year
          </label>
          <input
            type="text"
            id="s-year"
            name="year"
            required
            inputmode="numeric"
            value={values.year}
            class={field}
          />
        </div>

        <div class="sm:col-span-2">
          <label for="s-venue" class="block text-sm font-medium text-neutral-700 mb-1">
            Venue
          </label>
          <input
            type="text"
            id="s-venue"
            name="venue"
            maxlength={120}
            placeholder={DEFAULT_VENUE}
            value={values.venue}
            class={field}
          />
        </div>

        <div class="sm:col-span-2">
          <label for="s-synopsis" class="block text-sm font-medium text-neutral-700 mb-1">
            Synopsis
          </label>
          <textarea
            id="s-synopsis"
            name="synopsis"
            required
            rows={5}
            maxlength={2000}
            class={field}
          >
            {values.synopsis}
          </textarea>
        </div>

        <div class="sm:col-span-2">
          <label for="s-tickets" class="block text-sm font-medium text-neutral-700 mb-1">
            Ticket link
          </label>
          <input
            type="url"
            id="s-tickets"
            name="ticketUrl"
            placeholder="https://fairporthighschool.ludus.com/"
            value={values.ticketUrl}
            class={field}
          />
        </div>
      </div>

      <label class="flex items-center gap-2 text-sm text-neutral-700">
        <input type="checkbox" name="isHighlighted" value="1" checked={values.isHighlighted} />
        Highlight in "Past Productions" on the home page once it has closed
      </label>
    </div>
  );
}

const readShowForm = async (c: Context<AppEnv>) => {
  const form = await c.req.formData();
  const ticketUrl = String(form.get('ticketUrl') ?? '').trim();
  const values: ShowFormValues = {
    title: String(form.get('title') ?? '').trim(),
    season: String(form.get('season') ?? '').trim(),
    year: String(form.get('year') ?? '').trim(),
    venue: String(form.get('venue') ?? '').trim(),
    synopsis: String(form.get('synopsis') ?? '').trim(),
    ticketUrl,
    isHighlighted: Boolean(form.get('isHighlighted')),
  };
  return { form, values };
};

adminRoutes.get('/admin/shows/new', requirePermission('show', 'create'), (c) =>
  c.render(
    <div class="max-w-2xl space-y-6">
      <div>
        <a href="/admin/shows" class="text-sm text-primary-600 hover:text-primary-700">
          &larr; All shows
        </a>
        <h1 class="font-display text-2xl font-bold text-neutral-900 mt-2">Add a show</h1>
      </div>

      {c.req.query('error') && (
        <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
          {c.req.query('error')}
        </p>
      )}

      <form method="post" action="/admin/shows/new" class="space-y-5">
        <ShowFields
          values={{
            title: '',
            season: '',
            year: String(new Date().getFullYear()),
            venue: '',
            synopsis: '',
            ticketUrl: '',
            isHighlighted: false,
          }}
        />
        <p class="rounded-lg bg-neutral-50 ring-1 ring-neutral-200 px-4 py-3 text-sm text-neutral-700">
          The show is not featured on the home page until you say so, and you can add
          cast, dates, and artwork after creating it.
        </p>
        <button
          type="submit"
          class="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
        >
          Create show
        </button>
      </form>
    </div>,
    { title: 'Add a show' },
  ),
);

adminRoutes.post('/admin/shows/new', requirePermission('show', 'create'), async (c) => {
  const { values } = await readShowForm(c);
  const year = Number.parseInt(values.year, 10);

  if (!Number.isFinite(year) || year < 1900 || year > 2200) {
    return c.redirect(
      `/admin/shows/new?error=${encodeURIComponent('Enter a four-digit year.')}`,
      302,
    );
  }

  const result = await createShow(getDb(c.env.DB), c.get('actor'), {
    title: values.title,
    season: values.season,
    year,
    venue: values.venue,
    synopsis: values.synopsis,
    ticketUrl: values.ticketUrl.length > 0 ? values.ticketUrl : null,
    isHighlighted: values.isHighlighted,
  });

  if (!result.ok) {
    return c.redirect(`/admin/shows/new?error=${encodeURIComponent(result.error)}`, 302);
  }
  return c.redirect(`/admin/shows/${result.id}?created=1`, 302);
});

adminRoutes.get('/admin/shows/:id', requirePermission('cast', 'assign'), async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');
  const showId = c.req.param('id');

  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return c.notFound();

  const [cast, crew, roster, gallery, performances, deletable] = await Promise.all([
    db.select().from(showCast).where(eq(showCast.showId, showId)).orderBy(showCast.sortOrder),
    db.select().from(showCrew).where(eq(showCrew.showId, showId)).orderBy(showCrew.sortOrder),
    db
      .select({ id: members.id, name: members.name, grade: members.grade })
      .from(members)
      .where(eq(members.isActive, true))
      .orderBy(members.name),
    getGallery(db, showId),
    getPerformances(db, showId),
    showIsDeletable(db, showId),
  ]);

  const canEditShow = can(c.get('role')!, 'show', 'update');

  // Blank rows so dates can be added without any client-side scripting.
  const dateRows = [
    ...performances.map((p) => ({ date: p.date, time: p.time })),
    ...Array.from({ length: 4 }, () => ({ date: '', time: '' })),
  ];

  // Blank rows so roles can be added without any client-side scripting. The
  // form is plain HTML, which keeps it usable on a school Chromebook with
  // whatever browser and connection it has.
  const castRows = [
    ...cast.map((r) => ({ role: r.role, memberId: r.memberId, tier: r.tier })),
    ...Array.from({ length: 5 }, () => ({ role: '', memberId: null, tier: 'ensemble' })),
  ];
  const crewRows = [
    ...crew.map((r) => ({ role: r.role, memberId: r.memberId })),
    ...Array.from({ length: 5 }, () => ({ role: '', memberId: null })),
  ];

  const MemberSelect = ({ name, value }: { name: string; value: string | null }) => (
    <select name={name} class="w-full px-2 py-1.5 rounded border border-neutral-300 bg-white text-sm">
      <option value="" selected={!value}>
        TBA
      </option>
      {roster.map((m) => (
        <option value={m.id} selected={value === m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );

  return c.render(
    <div class="space-y-8">
      <div>
        <a href="/admin/shows" class="text-sm text-primary-600 hover:text-primary-700">
          &larr; All shows
        </a>
        <h1 class="font-display text-2xl font-bold text-neutral-900 mt-2">{show.title}</h1>
        <p class="text-neutral-500 text-sm">{show.season}</p>
      </div>

      {c.req.query('error') && (
        <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
          {c.req.query('error')}
        </p>
      )}

      {c.req.query('created') && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          Show created. Add the dates, cast, and artwork below, then feature it when you
          are ready to announce it.
        </p>
      )}

      {canEditShow && (
        <>
          <form method="post" action={`/admin/shows/${show.id}/details`} class="space-y-3">
            <h2 class="font-display font-semibold text-neutral-900">Details</h2>
            <ShowFields
              values={{
                title: show.title,
                season: show.season,
                year: String(show.year),
                venue: show.venue,
                synopsis: show.synopsis,
                ticketUrl: show.ticketUrl ?? '',
                isHighlighted: show.isHighlighted,
              }}
            />
            <p class="text-xs text-neutral-500">
              The web address stays <code>/shows/{show.id}</code> whatever the title
              becomes, so links already shared keep working.
            </p>
            <button
              type="submit"
              class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
            >
              Save details
            </button>
          </form>

          <form method="post" action={`/admin/shows/${show.id}/performances`} class="space-y-3">
            <h2 class="font-display font-semibold text-neutral-900">Performance dates</h2>
            <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-4 space-y-2">
              {dateRows.map((row) => (
                <div class="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="date"
                    name="date"
                    value={row.date}
                    class="col-span-6 px-2 py-1.5 rounded border border-neutral-300 text-sm"
                  />
                  <input
                    type="text"
                    name="time"
                    value={row.time}
                    placeholder="7:30 PM"
                    class="col-span-6 px-2 py-1.5 rounded border border-neutral-300 text-sm"
                  />
                </div>
              ))}
            </div>
            <p class="text-xs text-neutral-500">
              Clearing a date removes that performance. The site treats the run as over
              the day after the last date, so the home page stops advertising tickets on
              its own.
            </p>
            <button
              type="submit"
              class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
            >
              Save dates
            </button>
          </form>

          <section class="space-y-3">
            <h2 class="font-display font-semibold text-neutral-900">Home page</h2>
            <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
              {show.isCurrent ? (
                <>
                  <p class="text-sm text-neutral-700 mb-4">
                    This is the featured show on the home page.
                  </p>
                  <form method="post" action={`/admin/shows/${show.id}/feature`}>
                    <input type="hidden" name="featured" value="0" />
                    <button
                      type="submit"
                      class="px-5 py-2 bg-neutral-200 hover:bg-neutral-300 text-neutral-800 text-sm font-medium rounded-lg transition-colors"
                    >
                      Stop featuring it
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <p class="text-sm text-neutral-700 mb-4">
                    Featuring this show replaces whichever show is featured now - only one
                    can be.
                  </p>
                  <form method="post" action={`/admin/shows/${show.id}/feature`}>
                    <input type="hidden" name="featured" value="1" />
                    <button
                      type="submit"
                      class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Feature on the home page
                    </button>
                  </form>
                </>
              )}
            </div>
          </section>
        </>
      )}

      {/* Artwork writes need show.update, which officers do not hold, but the
          page itself is reachable with cast.assign. Rendering the form to
          someone whose submit would 403 is worse than not showing it. */}
      {can(c.get('role')!, 'show', 'update') && (
      <form
        method="post"
        action={`/admin/shows/${show.id}/images`}
        enctype="multipart/form-data"
        class="space-y-3"
      >
        <h2 class="font-display font-semibold text-neutral-900">Artwork</h2>
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6 grid gap-6 sm:grid-cols-3">
          {SHOW_IMAGE_FIELDS.map((f) => {
            const url = images.deliveryUrl(
              show[f.column] as string | null,
              f.variant,
            );
            return (
              <div>
                <p class="text-sm font-medium text-neutral-700 mb-2">{f.label}</p>
                {url ? (
                  <img
                    src={url}
                    alt=""
                    class={`${f.preview} w-full object-cover rounded-lg ring-1 ring-neutral-200 mb-2`}
                  />
                ) : (
                  <div
                    class={`${f.preview} w-full rounded-lg bg-neutral-100 ring-1 ring-neutral-200 mb-2 flex items-center justify-center text-xs text-neutral-400`}
                  >
                    None
                  </div>
                )}
                <input
                  type="file"
                  name={f.column}
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  class="w-full text-xs text-neutral-600 file:mr-2 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-neutral-100 file:text-neutral-800 hover:file:bg-neutral-200"
                />
                <p class="text-xs text-neutral-500 mt-1">{f.hint}</p>
              </div>
            );
          })}
        </div>
        <button
          type="submit"
          class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
        >
          Save artwork
        </button>
        <p class="text-xs text-neutral-500">
          Leave a slot empty to keep the image it has. Social previews fall back to the
          hero, then the poster, so the third slot is only needed to override that.
        </p>
      </form>
      )}

      {can(c.get('role')!, 'show', 'update') && (
        <section class="space-y-3">
          <h2 class="font-display font-semibold text-neutral-900">Gallery</h2>

          <div class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
            <strong>These photos show students.</strong> Only post pictures you have
            permission to publish. A student listed privately on the members page has
            asked not to be shown - putting their face in a gallery works against that,
            even without a name. Your name is recorded on every photo added or removed.
          </div>

          {gallery.length > 0 && (
            <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-4">
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {gallery.map((photo, i) => {
                  const url = images.deliveryUrl(photo.imageId, IMAGE_VARIANT.Gallery);
                  return (
                    <div>
                      {url && (
                        <img
                          src={url}
                          alt={`Gallery photo ${i + 1}`}
                          class="w-full aspect-square object-cover rounded-lg ring-1 ring-neutral-200"
                        />
                      )}
                      <form
                        method="post"
                        action={`/admin/shows/${show.id}/gallery/${photo.id}/delete`}
                        onsubmit="return confirm('Remove this photo?')"
                      >
                        <button
                          type="submit"
                          class="mt-1 w-full px-2 py-1 text-xs text-red-700 hover:bg-red-50 rounded transition-colors"
                        >
                          Remove
                        </button>
                      </form>
                    </div>
                  );
                })}
              </div>
              <p class="text-xs text-neutral-500 mt-3">
                Photos appear in the order shown, oldest first.
              </p>
            </div>
          )}

          <form
            method="post"
            action={`/admin/shows/${show.id}/gallery`}
            enctype="multipart/form-data"
            class="bg-white rounded-xl ring-1 ring-neutral-200 p-4 space-y-3"
          >
            <input
              type="file"
              name="photos"
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp"
              class="w-full text-sm text-neutral-600 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border-0 file:bg-neutral-100 file:text-neutral-800 file:font-medium hover:file:bg-neutral-200"
            />
            <p class="text-xs text-neutral-500">
              Pick several at once. JPEG, PNG, GIF, or WebP, up to{' '}
              {MAX_IMAGE_BYTES / 1024 / 1024} MB each.
            </p>

            <label class="flex items-start gap-2 text-sm text-neutral-700">
              <input type="checkbox" name="acknowledged" required class="mt-0.5" />
              <span>
                I have permission to publish photos of everyone shown in these pictures.
              </span>
            </label>

            <button
              type="submit"
              class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
            >
              Add photos
            </button>
          </form>
        </section>
      )}

      <p class="rounded-lg bg-neutral-50 ring-1 ring-neutral-200 px-4 py-3 text-sm text-neutral-700">
        Leave a role set to <strong>TBA</strong> if it is not cast yet - the part still
        shows on the site, which tells the audience it exists. Clearing the role name
        removes the row entirely.
      </p>

      <form method="post" action={`/admin/shows/${show.id}/cast`} class="space-y-3">
        <h2 class="font-display font-semibold text-neutral-900">Cast</h2>
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-4 space-y-2">
          {castRows.map((row) => (
            <div class="grid grid-cols-12 gap-2 items-center">
              <input
                type="text"
                name="role"
                value={row.role}
                placeholder="Role name"
                class="col-span-5 px-2 py-1.5 rounded border border-neutral-300 text-sm"
              />
              <div class="col-span-4">
                <MemberSelect name="memberId" value={row.memberId} />
              </div>
              <select
                name="tier"
                class="col-span-3 px-2 py-1.5 rounded border border-neutral-300 bg-white text-sm"
              >
                {(['lead', 'supporting', 'ensemble'] as const).map((t) => (
                  <option value={t} selected={row.tier === t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <button
          type="submit"
          class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
        >
          Save cast
        </button>
      </form>

      {canEditShow && can(c.get('role')!, 'show', 'delete') && (
        <div class="bg-white rounded-xl ring-1 ring-red-200 p-6">
          <h2 class="font-display font-semibold text-neutral-900">Delete this show</h2>
          {deletable ? (
            <>
              <p class="text-sm text-neutral-600 mt-1 mb-4">
                Nothing is recorded against it yet, so it can still be removed.
              </p>
              <form
                method="post"
                action={`/admin/shows/${show.id}/delete`}
                onsubmit="return confirm('Delete this show?')"
              >
                <button
                  type="submit"
                  class="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Delete show
                </button>
              </form>
            </>
          ) : (
            <p class="text-sm text-neutral-600 mt-1">
              This show has cast, crew, or photos recorded against it and can no longer be
              deleted - removing it would erase the record of who performed in it. Stop
              featuring it instead, and it will sit in the archive.
            </p>
          )}
        </div>
      )}

      <form method="post" action={`/admin/shows/${show.id}/crew`} class="space-y-3">
        <h2 class="font-display font-semibold text-neutral-900">Production team</h2>
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-4 space-y-2">
          {crewRows.map((row) => (
            <div class="grid grid-cols-12 gap-2 items-center">
              <input
                type="text"
                name="role"
                value={row.role}
                placeholder="Job (e.g. Stage Manager)"
                class="col-span-6 px-2 py-1.5 rounded border border-neutral-300 text-sm"
              />
              <div class="col-span-6">
                <MemberSelect name="memberId" value={row.memberId} />
              </div>
            </div>
          ))}
        </div>
        <button
          type="submit"
          class="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-lg transition-colors"
        >
          Save production team
        </button>
      </form>
    </div>,
    { title: show.title },
  );
});

adminRoutes.post(
  '/admin/shows/:id/cast',
  requirePermission('cast', 'assign'),
  async (c) => {
    const form = await c.req.formData();
    const roles = form.getAll('role').map(String);
    const memberIds = form.getAll('memberId').map(String);
    const tiers = form.getAll('tier').map(String);

    const rows = roles.map((role, i) => ({
      role,
      memberId: memberIds[i] ? memberIds[i]! : null,
      tier: (tiers[i] ?? 'ensemble') as 'lead' | 'supporting' | 'ensemble',
      additionalRoles: [] as string[],
    }));

    await replaceCast(getDb(c.env.DB), c.get('actor'), c.req.param('id'), rows);
    return c.redirect(`/admin/shows/${c.req.param('id')}`, 302);
  },
);

adminRoutes.post(
  '/admin/shows/:id/images',
  requirePermission('show', 'update'),
  async (c) => {
    const showId = c.req.param('id');
    const form = await c.req.formData();
    const store = c.get('images');

    const patch: Record<string, string> = {};
    for (const field of SHOW_IMAGE_FIELDS) {
      const upload = await uploadImage(store, form.get(field.column));
      if (upload && 'error' in upload) {
        return c.redirect(
          `/admin/shows/${showId}?error=${encodeURIComponent(`${field.label}: ${upload.error}`)}`,
          302,
        );
      }
      if (upload) patch[field.column] = upload.imageId;
    }

    await updateShowImages(getDb(c.env.DB), c.get('actor'), showId, patch);
    return c.redirect(`/admin/shows/${showId}`, 302);
  },
);

adminRoutes.post(
  '/admin/shows/:id/gallery',
  requirePermission('show', 'update'),
  async (c) => {
    const showId = c.req.param('id');
    const form = await c.req.formData();

    // Enforced here, not merely marked required in the markup. This
    // acknowledgement is the actual control on publishing photos of students:
    // nothing in code can verify a release exists.
    if (!form.get('acknowledged')) {
      return c.redirect(
        `/admin/shows/${showId}?error=${encodeURIComponent('Confirm you have permission before adding photos.')}`,
        302,
      );
    }

    const store = c.get('images');
    const imageIds: string[] = [];

    for (const entry of form.getAll('photos')) {
      const upload = await uploadImage(store, entry);
      if (upload && 'error' in upload) {
        // Whatever already uploaded stays uploaded but unreferenced; stopping
        // here means the good photos in the batch are not silently published
        // alongside a rejected one without the user knowing.
        return c.redirect(
          `/admin/shows/${showId}?error=${encodeURIComponent(upload.error)}`,
          302,
        );
      }
      if (upload) imageIds.push(upload.imageId);
    }

    await addGalleryImages(getDb(c.env.DB), c.get('actor'), showId, imageIds);
    return c.redirect(`/admin/shows/${showId}`, 302);
  },
);

adminRoutes.post(
  '/admin/shows/:id/gallery/:photoId/delete',
  requirePermission('show', 'update'),
  async (c) => {
    await removeGalleryImage(
      getDb(c.env.DB),
      c.get('actor'),
      c.req.param('id'),
      c.req.param('photoId'),
    );
    return c.redirect(`/admin/shows/${c.req.param('id')}`, 302);
  },
);

adminRoutes.post(
  '/admin/shows/:id/crew',
  requirePermission('cast', 'assign'),
  async (c) => {
    const form = await c.req.formData();
    const roles = form.getAll('role').map(String);
    const memberIds = form.getAll('memberId').map(String);

    const rows = roles.map((role, i) => ({
      role,
      memberId: memberIds[i] ? memberIds[i]! : null,
    }));

    await replaceCrew(getDb(c.env.DB), c.get('actor'), c.req.param('id'), rows);
    return c.redirect(`/admin/shows/${c.req.param('id')}`, 302);
  },
);
adminRoutes.post(
  '/admin/shows/:id/details',
  requirePermission('show', 'update'),
  async (c) => {
    const showId = c.req.param('id');
    const { values } = await readShowForm(c);
    const year = Number.parseInt(values.year, 10);

    await updateShow(getDb(c.env.DB), c.get('actor'), showId, {
      title: values.title.length > 0 ? values.title : undefined,
      season: values.season.length > 0 ? values.season : undefined,
      year: Number.isFinite(year) ? year : undefined,
      venue: values.venue.length > 0 ? values.venue : DEFAULT_VENUE,
      synopsis: values.synopsis.length > 0 ? values.synopsis : undefined,
      ticketUrl: values.ticketUrl.length > 0 ? values.ticketUrl : null,
      isHighlighted: values.isHighlighted,
    });

    return c.redirect(`/admin/shows/${showId}`, 302);
  },
);

adminRoutes.post(
  '/admin/shows/:id/performances',
  requirePermission('show', 'update'),
  async (c) => {
    const showId = c.req.param('id');
    const form = await c.req.formData();
    const dates = form.getAll('date').map(String);
    const times = form.getAll('time').map(String);

    await replacePerformances(
      getDb(c.env.DB),
      c.get('actor'),
      showId,
      dates.map((date, i) => ({ date, time: times[i] ?? '' })),
    );

    return c.redirect(`/admin/shows/${showId}`, 302);
  },
);

adminRoutes.post(
  '/admin/shows/:id/feature',
  requirePermission('show', 'update'),
  async (c) => {
    const showId = c.req.param('id');
    const form = await c.req.formData();
    const wanted = String(form.get('featured') ?? '') === '1';

    await setFeaturedShow(getDb(c.env.DB), c.get('actor'), wanted ? showId : null);
    return c.redirect(`/admin/shows/${showId}`, 302);
  },
);

adminRoutes.post(
  '/admin/shows/:id/delete',
  requirePermission('show', 'delete'),
  async (c) => {
    const showId = c.req.param('id');
    const result = await deleteShow(getDb(c.env.DB), c.get('actor'), showId);

    if (!result.ok) {
      return c.redirect(
        `/admin/shows/${showId}?error=${encodeURIComponent(result.error)}`,
        302,
      );
    }
    return c.redirect('/admin/shows', 302);
  },
);

