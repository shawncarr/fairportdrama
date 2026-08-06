import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { members, sponsors, spiritWear, MEMBER_VISIBILITY } from '~/db/schema/content';
import {
  auditEvents,
  pendingEdits,
  APP_ROLE,
  PENDING_EDIT_STATUS,
} from '~/db/schema/governance';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { generateId } from '~/lib/id';
import { get, post, resetTables, signIn } from '~/test/session';

/**
 * What an admin sees after an action succeeds.
 *
 * The write tests stop at the redirect and assert the database. Nobody
 * followed the redirect, so the confirmation messages - the only feedback that
 * anything happened - were never rendered. A wrong branch there means the page
 * silently says nothing, or says the wrong thing, after a change that did land.
 */

const db = () => getDb(env.DB);

/** Posts, then follows the redirect and returns the resulting page. */
const followRedirect = async (path: string, cookie: string, form: FormData) => {
  const res = await post(path, cookie, form);
  expect(res.status).toBe(302);
  const location = res.headers.get('location')!;
  const page = await get(location, cookie);
  expect(page.status, `${location} did not render`).toBe(200);
  return page.text();
};

beforeEach(async () => {
  await resetTables(['sponsors', 'spirit_wear', 'members']);
  await db().insert(members).values({
    id: 'daniel-doser',
    name: 'Daniel Doser',
    grade: 'Senior',
    bio: 'Original bio.',
    visibility: MEMBER_VISIBILITY.Limited,
    isActive: true,
  });
});

describe('after a member edits their own profile', () => {
  it('says the change is waiting for review when it needs approval', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');

    const form = new FormData();
    form.set('visibility', MEMBER_VISIBILITY.Limited);
    form.set('bio', 'A brand new bio.');
    form.set('instagram', '');

    const html = await followRedirect('/admin/profile', cookie, form);
    expect(html).toContain('need approval before they appear');
  });

  it('just says saved when the change took effect immediately', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');

    const form = new FormData();
    form.set('visibility', MEMBER_VISIBILITY.Full);
    form.set('bio', 'Original bio.');
    form.set('instagram', '');

    const html = await followRedirect('/admin/profile', cookie, form);
    expect(html).toContain('Saved.');
    // The page always explains that hiding needs no approval, so this asserts
    // on the flash message's own wording rather than the substring.
    expect(html).not.toContain('need approval before they appear');
  });
});

describe('after an admin changes members', () => {
  it('reports how many were updated in bulk', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const form = new FormData();
    form.append('memberIds', 'daniel-doser');
    form.set('visibility', MEMBER_VISIBILITY.Full);
    form.set('acknowledged', '1');

    const html = await followRedirect('/admin/members/visibility', cookie, form);
    expect(html).toContain('Updated 1 member');
  });

  it('confirms a new member, and says they start hidden', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const form = new FormData();
    form.set('name', 'Nora Whitfield');
    form.set('grade', 'Freshman');
    form.set('graduationYear', '2029');

    const html = await followRedirect('/admin/members/new', cookie, form);
    expect(html).toContain('Added Nora Whitfield');
    expect(html).toContain('first name and last initial');
  });

  it('says the invitation is on its way when one was sent', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const form = new FormData();
    form.set('name', 'Nora Whitfield');
    form.set('grade', 'Freshman');
    form.set('email', 'nora@example.com');
    form.set('role', APP_ROLE.Member);

    const html = await followRedirect('/admin/members/new', cookie, form);
    expect(html).toContain('invitation is on its way');
  });

  it('reports an invitation that failed without losing the member', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const form = new FormData();
    form.set('name', 'Nora Whitfield');
    form.set('grade', 'Freshman');
    form.set('email', 'not-an-address');
    form.set('role', APP_ROLE.Member);

    const html = await followRedirect('/admin/members/new', cookie, form);
    expect(html).toContain('invitation failed');
    expect(html).toContain('Nora Whitfield');
  });

  it('confirms an edit, and confirms a removal differently', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const edit = new FormData();
    edit.set('name', 'Daniel Doser');
    edit.set('grade', 'Alumni');
    edit.set('graduationYear', '2026');
    edit.set('bio', 'Original bio.');
    edit.set('instagram', '');
    edit.set('visibility', MEMBER_VISIBILITY.Limited);
    edit.set('isActive', '1');

    expect(await followRedirect('/admin/members/daniel-doser', cookie, edit)).toContain(
      'Saved.',
    );

    const removed = await followRedirect(
      '/admin/members/daniel-doser/remove',
      cookie,
      new FormData(),
    );
    expect(removed).toContain('have been taken down');
  });
});

describe('the officer approval review list', () => {
  const seedApprovalBy = async (actorId: string, label: string) => {
    await db().insert(auditEvents).values({
      id: generateId(),
      actorKind: 'user',
      actorUserId: actorId,
      actorLabel: label,
      action: AUDIT_ACTION.MemberEditApproved,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: 'daniel-doser',
      payload: { submittedByUserId: 'u_student' },
      relatedEntities: [],
      createdAt: new Date().toISOString(),
    });
  };

  it('tells an admin how many edits officers have approved', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await seedApprovalBy('u_officer', 'Ariana Toner');

    // The accountability half of letting officers approve: a review list
    // nobody looks at is not accountability.
    const html = await (await get('/admin/audit', cookie)).text();
    expect(html).toContain('been approved');
    expect(html).toContain('worth reviewing');
  });

  it('uses the singular for exactly one', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await seedApprovalBy('u_officer', 'Ariana Toner');

    const html = await (await get('/admin/audit', cookie)).text();
    expect(html).toContain('1 member edit has been approved');
  });

  it('is not shown to an officer, who cannot read the whole log', async () => {
    await seedApprovalBy('u_officer', 'Ariana Toner');
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');

    const html = await (await get('/admin/audit', cookie)).text();
    expect(html).not.toContain('worth reviewing');
  });
});

describe('the activity log with sparse rows', () => {
  it('names the system for an unattributed change and shows its target', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await db().insert(auditEvents).values({
      id: generateId(),
      actorKind: 'system',
      actorUserId: null,
      actorLabel: null,
      action: AUDIT_ACTION.NewsletterSubscribed,
      targetKind: AUDIT_ENTITY_KIND.NewsletterSubscriber,
      targetId: 'someone@example.com',
      relatedEntities: [],
      createdAt: new Date().toISOString(),
    });

    const html = await (await get('/admin/audit', cookie)).text();
    expect(html).toContain('System');
    expect(html).toContain('someone@example.com');
  });

  it('says so when there is nothing recorded yet', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await env.DB.exec('DELETE FROM audit_events');

    const html = await (await get('/admin/audit', cookie)).text();
    expect(html.toLowerCase()).toContain('nothing');
  });
});

describe('approvals', () => {
  beforeEach(async () => {
    await db().insert(pendingEdits).values({
      id: 'pe-1',
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: 'daniel-doser',
      proposed: { bio: 'A reviewed bio.' },
      submittedByUserId: 'u_student',
      submittedAt: new Date().toISOString(),
      status: PENDING_EDIT_STATUS.Pending,
    });
  });

  it('refuses to approve without the acknowledgement', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');

    // The checkbox is required in the markup, but the markup is not the
    // control - the approver's name goes on the record either way.
    await post('/admin/approvals/pe-1/approve', cookie, new FormData());

    const [edit] = await db().select().from(pendingEdits);
    expect(edit!.status).toBe(PENDING_EDIT_STATUS.Pending);
  });

  it('shows an empty queue once everything is handled', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');

    const approve = new FormData();
    approve.set('acknowledged', '1');
    const html = await followRedirect('/admin/approvals/pe-1/approve', cookie, approve);

    expect(html).toContain('Nothing is waiting for review');
  });

  it('records a rejection note', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');

    const reject = new FormData();
    reject.set('note', 'Please keep it about theater.');
    await post('/admin/approvals/pe-1/reject', cookie, reject);

    const [edit] = await db().select().from(pendingEdits);
    expect(edit!.status).toBe(PENDING_EDIT_STATUS.Rejected);
    expect(edit!.reviewNote).toBe('Please keep it about theater.');
  });
});

describe('the catalog editors with an image already set', () => {
  it('render the existing logo and product photo', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await db().insert(sponsors).values({
      id: 's1',
      name: 'Gold Co',
      tier: 'gold',
      logoImageId: 'img-sponsor-logo',
      isActive: true,
    });
    await db().insert(spiritWear).values({
      id: 'sw1',
      name: 'Hoodie',
      description: 'Warm.',
      priceCents: 3500,
      imageId: 'img-hoodie',
      isAvailable: true,
    });

    expect(await (await get('/admin/sponsors', cookie)).text()).toContain(
      'img-sponsor-logo',
    );
    expect(await (await get('/admin/spiritwear', cookie)).text()).toContain('img-hoodie');
  });
});
