import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { auditEvents, APP_ROLE } from '~/db/schema/governance';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { get, post, resetTables, signIn } from '~/test/session';

const db = () => getDb(env.DB);

const member = async () =>
  (await db().select().from(members).where(eq(members.id, 'daniel-doser')))[0]!;

const audits = async () => db().select().from(auditEvents);

/** The edit form as a browser submits it: every field present. */
const editForm = (over: Record<string, string> = {}) => {
  const form = new FormData();
  form.set('name', 'Daniel Doser');
  form.set('grade', 'Senior');
  form.set('graduationYear', '2026');
  form.set('bio', 'Original bio.');
  form.set('instagram', '');
  form.set('visibility', MEMBER_VISIBILITY.Full);
  form.set('isActive', '1');
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
};

beforeEach(async () => {
  await resetTables(['show_cast', 'show_crew', 'show_gallery_images', 'shows', 'members']);

  await db().insert(members).values({
    id: 'daniel-doser',
    name: 'Daniel Doser',
    grade: 'Senior',
    graduationYear: 2026,
    bio: 'Original bio.',
    photoImageId: 'img-live',
    visibility: MEMBER_VISIBILITY.Full,
    isActive: true,
  });
});

describe('editing roster fields', () => {
  it('saves a changed name without changing the id', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    await post('/admin/members/daniel-doser', cookie, editForm({ name: 'Daniel Doser-Smith' }));

    const row = await member();
    expect(row.name).toBe('Daniel Doser-Smith');
    // Rewriting the id would orphan cast credits and audit rows, which carry
    // it as plain text with no foreign key to complain.
    expect(row.id).toBe('daniel-doser');
  });

  it('changes grade and graduation year', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post(
      '/admin/members/daniel-doser',
      cookie,
      editForm({ grade: 'Alumni', graduationYear: '2027' }),
    );

    const row = await member();
    expect(row.grade).toBe('Alumni');
    expect(row.graduationYear).toBe(2027);
  });

  it('takes them off the roster when the box is unticked', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const form = editForm();
    form.delete('isActive');
    await post('/admin/members/daniel-doser', cookie, form);

    expect((await member()).isActive).toBe(false);
  });

  it('writes nothing when nothing changed', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await env.DB.exec('DELETE FROM audit_events');

    await post('/admin/members/daniel-doser', cookie, editForm());
    expect(await audits()).toHaveLength(0);
  });

  it('404s for a member who does not exist', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    expect((await get('/admin/members/nobody', cookie)).status).toBe(404);
  });
});

describe('officers editing a profile', () => {
  it('can change another member’s bio, by explicit decision', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);

    await post('/admin/members/daniel-doser', cookie, editForm({ bio: 'Rewritten by an officer.' }));
    expect((await member()).bio).toBe('Rewritten by an officer.');
  });

  it('is recorded with the officer named, since that is the only check', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    await env.DB.exec('DELETE FROM audit_events');

    await post('/admin/members/daniel-doser', cookie, editForm({ bio: 'Rewritten.' }));

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.MemberUpdated);
    expect(audit!.actorLabel).toBeTruthy();
    expect(audit!.diff).toMatchObject({
      bio: { before: 'Original bio.', after: 'Rewritten.' },
    });
    expect(audit!.payload).toMatchObject({ memberName: 'Daniel Doser' });
  });

  it('still cannot grant officer status by posting the field', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);

    await post(
      '/admin/members/daniel-doser',
      cookie,
      editForm({ isOfficer: '1', officerTitle: 'President' }),
    );

    const row = await member();
    expect(row.isOfficer).toBe(false);
    expect(row.officerTitle).toBeNull();
  });

  it('is refused entirely to a plain member', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    expect((await get('/admin/members/daniel-doser', cookie)).status).toBe(403);
    expect((await post('/admin/members/daniel-doser', cookie, editForm())).status).toBe(403);
  });
});

describe('visibility from the edit page', () => {
  beforeEach(async () => {
    await db()
      .update(members)
      .set({ visibility: MEMBER_VISIBILITY.Limited })
      .where(eq(members.id, 'daniel-doser'));
  });

  it('refuses to make someone public without the release acknowledgement', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    // Otherwise this page would be a quieter route to the same change the bulk
    // tool gates.
    const response = await post(
      '/admin/members/daniel-doser',
      cookie,
      editForm({ visibility: MEMBER_VISIBILITY.Full }),
    );

    expect(response.headers.get('location')).toContain('error=');
    expect((await member()).visibility).toBe(MEMBER_VISIBILITY.Limited);
  });

  it('makes them public once acknowledged', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post(
      '/admin/members/daniel-doser',
      cookie,
      editForm({ visibility: MEMBER_VISIBILITY.Full, acknowledged: '1' }),
    );

    expect((await member()).visibility).toBe(MEMBER_VISIBILITY.Full);
  });

  it('needs no acknowledgement to hide someone again', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post(
      '/admin/members/daniel-doser',
      cookie,
      editForm({ visibility: MEMBER_VISIBILITY.Full, acknowledged: '1' }),
    );

    // Withdrawing exposure is never gated, in either direction of the system.
    await post(
      '/admin/members/daniel-doser',
      cookie,
      editForm({ visibility: MEMBER_VISIBILITY.Limited }),
    );
    expect((await member()).visibility).toBe(MEMBER_VISIBILITY.Limited);
  });
});

describe('removing a member’s information', () => {
  it('clears the profile, hides them, and drops them from the roster', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const response = await post(
      '/admin/members/daniel-doser/remove',
      cookie,
      new FormData(),
    );
    expect(response.status).toBe(302);

    const row = await member();
    expect(row.bio).toBeNull();
    expect(row.photoImageId).toBeNull();
    expect(row.instagram).toBeNull();
    expect(row.visibility).toBe(MEMBER_VISIBILITY.Limited);
    expect(row.isActive).toBe(false);
  });

  it('keeps the row, so past credits survive', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/daniel-doser/remove', cookie, new FormData());

    // show_cast references members with onDelete: restrict; deleting would
    // erase who performed the role, and the printed playbill is the only other
    // copy of that.
    expect(await db().select().from(members)).toHaveLength(1);
    expect((await member()).name).toBe('Daniel Doser');
  });

  it('records who honoured the request under its own action', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await env.DB.exec('DELETE FROM audit_events');

    await post('/admin/members/daniel-doser/remove', cookie, new FormData());

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.MemberInformationRemoved);
    expect(audit!.actorUserId).toBeTruthy();
    expect(audit!.payload).toMatchObject({ memberName: 'Daniel Doser' });
  });

  it('leaves them unreachable on the public site afterwards', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/daniel-doser/remove', cookie, new FormData());

    expect((await get('/members/daniel-doser')).status).toBe(404);
    expect(await (await get('/sitemap.xml')).text()).not.toContain('daniel-doser');
  });
});

describe('the audit actor label', () => {
  it('falls back to the email when the account has no name', async () => {
    // Better Auth stores an empty string, not null, for a magic-link signup
    // that supplied no name. `??` treats that as a value, so every audit row
    // such a user wrote carried a blank "who" - which is most of them, and
    // exactly the field the log exists to record.
    const cookie = await signIn('nameless@example.com', APP_ROLE.Admin);
    await env.DB.exec('DELETE FROM audit_events');

    await post('/admin/members/daniel-doser', cookie, editForm({ bio: 'Changed.' }));

    const [audit] = await audits();
    expect(audit!.actorLabel).toBe('nameless@example.com');
  });
});
