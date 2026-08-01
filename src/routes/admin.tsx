import { Hono } from 'hono';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { AppEnv } from '~/env';
import { getDb } from '~/db/queries';
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
import { replaceCast, replaceCrew } from '~/services/casting';
import { updateShowImages } from '~/services/show-images';
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
          href={`/api/auth/sign-in/social?provider=google&callbackURL=${encodeURIComponent(next)}`}
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

  return c.render(
    <div class="space-y-6">
      <h1 class="font-display text-2xl font-bold text-neutral-900">Members</h1>

      {changed && (
        <p class="rounded-lg bg-green-50 text-green-800 text-sm px-4 py-3 ring-1 ring-green-200">
          Updated {changed} member{changed === '1' ? '' : 's'}.
        </p>
      )}

      <div class="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3 ring-1 ring-amber-200">
        <strong>{publicCount} of {roster.length}</strong> members show a full profile.
        Everyone else appears as first name and last initial with no photo. Only make
        someone public if a photo release is on file for them.
      </div>

      <form method="post" action="/admin/members/visibility">
        <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-neutral-50 text-left">
              <tr>
                <th class="px-4 py-3 w-8" />
                <th class="px-4 py-3 font-medium text-neutral-600">Name</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Grade</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Visibility</th>
                <th class="px-4 py-3 font-medium text-neutral-600">Has</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              {roster.map((m) => (
                <tr class={m.isActive ? '' : 'opacity-50'}>
                  <td class="px-4 py-2">
                    <input type="checkbox" name="memberIds" value={m.id} />
                  </td>
                  <td class="px-4 py-2 text-neutral-900">{m.name}</td>
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
    </div>,
    { title: 'Members' },
  );
});

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

// ---------------------------------------------------------------- accounts

adminRoutes.get('/admin/accounts', requirePermission('account', 'invite'), async (c) => {
  const db = getDb(c.env.DB);

  const [allInvites, accounts, unlinkedMembers] = await Promise.all([
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

  const error = c.req.query('error');
  const sent = c.req.query('sent');

  return c.render(
    <div class="space-y-8">
      <h1 class="font-display text-2xl font-bold text-neutral-900">Accounts</h1>

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
              {unlinkedMembers.map((m) => (
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
          <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-neutral-50 text-left">
                <tr>
                  <th class="px-4 py-3 font-medium text-neutral-600">Email</th>
                  <th class="px-4 py-3 font-medium text-neutral-600">Name</th>
                  <th class="px-4 py-3 font-medium text-neutral-600">Role</th>
                  <th class="px-4 py-3 font-medium text-neutral-600">Profile</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-100">
                {accounts.map((a) => (
                  <tr>
                    <td class="px-4 py-2 text-neutral-900">{a.email}</td>
                    <td class="px-4 py-2 text-neutral-600">{a.name}</td>
                    <td class="px-4 py-2 text-neutral-600">{a.role ?? 'none'}</td>
                    <td class="px-4 py-2 text-neutral-500">{a.memberId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
  const all = await db.select().from(shows).orderBy(desc(shows.year));

  return c.render(
    <div class="space-y-6">
      <h1 class="font-display text-2xl font-bold text-neutral-900">Shows</h1>
      <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-neutral-50 text-left">
            <tr>
              <th class="px-4 py-3 font-medium text-neutral-600">Show</th>
              <th class="px-4 py-3 font-medium text-neutral-600">Season</th>
              <th class="px-4 py-3 font-medium text-neutral-600">Featured</th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            {all.map((show) => (
              <tr>
                <td class="px-4 py-2 text-neutral-900">{show.title}</td>
                <td class="px-4 py-2 text-neutral-500">{show.season}</td>
                <td class="px-4 py-2 text-neutral-500">{show.isCurrent ? 'yes' : '—'}</td>
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

adminRoutes.get('/admin/shows/:id', requirePermission('cast', 'assign'), async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');
  const showId = c.req.param('id');

  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return c.notFound();

  const [cast, crew, roster] = await Promise.all([
    db.select().from(showCast).where(eq(showCast.showId, showId)).orderBy(showCast.sortOrder),
    db.select().from(showCrew).where(eq(showCrew.showId, showId)).orderBy(showCrew.sortOrder),
    db
      .select({ id: members.id, name: members.name, grade: members.grade })
      .from(members)
      .where(eq(members.isActive, true))
      .orderBy(members.name),
  ]);

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
