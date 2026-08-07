import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, isNull } from 'drizzle-orm';
import type { Bindings } from '~/env';
import * as schema from '~/db/schema';
import { invites } from '~/db/schema/governance';
import { user } from '~/db/schema/auth';
import { generateId } from '~/lib/id';
import { emailShell, sendEmail } from '~/lib/email';
import { escapeHtml } from '~/lib/html';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { AUDIT_ACTOR_KIND, systemActor } from '~/lib/audit/actor';
import { writeAuditOnly } from '~/lib/audit/write';
import {
  GATE_DENIAL_MESSAGE,
  decideInviteGate,
  normalizeEmail,
  type OpenInvite,
} from './invite-gate';

export function createAuth(env: Bindings) {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    baseURL: env.SITE_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),

    // Students sign in with their school Google account. Board members and
    // volunteers, who have no district address, use a magic link on whatever
    // email they actually read. One user table, one set of roles.
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },

    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          // The magic-link endpoint is public and unauthenticated, so without
          // this check anyone could make the site send mail to any address on
          // demand. The invite gate would still block account creation, but the
          // email would already have gone out - a spam amplification vector
          // that burns quota and damages the domain's sending reputation
          // through bounces and complaints from strangers.
          //
          // Skipping silently is deliberate: the endpoint still reports success
          // so it cannot be used to enumerate who has an account or an invite.
          if (!(await mayReceiveSignInLink(db, email))) {
            // The send is skipped silently so the page cannot be used to
            // discover who has access, but silence to the visitor is not the
            // same as silence in the log: this is the denial that happens most
            // often, and it is the only record that it happened at all.
            await writeAuditOnly(db, systemActor(), {
              action: AUDIT_ACTION.AuthSignInDenied,
              targetKind: AUDIT_ENTITY_KIND.User,
              targetId: email,
              payload: { email, method: 'magic-link' },
            });
            return;
          }

          await sendEmail(env.EMAIL, {
            to: email,
            subject: 'Your Fairport Drama Club sign-in link',
            html: emailShell(
              'Sign in to Fairport Drama Club',
              `<p style="margin:0 0 20px;">Use the button below to sign in. The link expires shortly and can only be used once.</p>
               <p style="margin:0 0 20px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#cc0000;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Sign in</a></p>
               <p style="margin:0;font-size:13px;color:#57534e;">If you did not request this, you can ignore this email.</p>`,
            ),
            text: `Sign in to Fairport Drama Club:\n\n${url}\n\nThis link expires shortly and can only be used once. If you did not request it, ignore this email.`,
          });
        },
      }),
    ],

    // Passwords are deliberately not enabled. A volunteer-run site should not
    // be storing password hashes or running reset flows for teenagers when
    // Google and magic links cover every case.
    emailAndPassword: { enabled: false },

    user: {
      additionalFields: {
        // Role lives on the user, not on a linked member record: board members
        // hold permissions without appearing anywhere on the public site.
        role: { type: 'string', required: false, input: false },
        // Optional link to a public profile. Null for board members.
        memberId: { type: 'string', required: false, input: false },
      },
    },

    databaseHooks: {
      user: {
        create: {
          /**
           * The authorization gate.
           *
           * Better Auth creates a user on first social sign-in by default. A
           * successful Google authentication proves identity and nothing else,
           * so without a matching invite this throws and no row is written -
           * not a disabled account, no account.
           */
          before: async (user) => {
            const email = normalizeEmail(user.email);

            const rows = await db
              .select({
                id: invites.id,
                email: invites.email,
                role: invites.role,
                memberId: invites.memberId,
                expiresAt: invites.expiresAt,
                acceptedAt: invites.acceptedAt,
                revokedAt: invites.revokedAt,
              })
              .from(invites)
              .where(eq(invites.email, email));

            const decision = decideInviteGate(rows as OpenInvite[]);

            if (!decision.allow) {
              // Recorded before throwing. Nothing else marks the attempt -
              // no row is written by design - so without this a run of
              // rejected sign-ins for one address leaves no trace at all.
              await writeAuditOnly(db, systemActor(), {
                action: AUDIT_ACTION.AuthSignInDenied,
                targetKind: AUDIT_ENTITY_KIND.User,
                targetId: email,
                // Reached by social sign-in, where the account authenticates
                // with Google first and only then meets the gate. The magic
                // link path is refused earlier, before any email goes out.
                payload: { email, reason: decision.reason, method: 'social' },
              });

              throw new APIError('FORBIDDEN', {
                message: GATE_DENIAL_MESSAGE[decision.reason],
              });
            }

            // Role and member link come from the invite, never from the
            // client. This is the only place a role is assigned at signup.
            return {
              data: {
                ...user,
                role: decision.invite.role,
                memberId: decision.invite.memberId,
              },
            };
          },

          /**
           * Consume the invite so it cannot be reused.
           *
           * Every still-open invite for the address is marked accepted, not
           * just the one selected. Any others were superseded by this signup,
           * and leaving one open would leave a second usable credential for an
           * address that already has an account.
           */
          after: async (user) => {
            const email = normalizeEmail(user.email);
            await db
              .update(invites)
              .set({ acceptedAt: new Date().toISOString(), acceptedByUserId: user.id })
              .where(
                and(
                  eq(invites.email, email),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt),
                ),
              );

            // Account creation is the most consequential mutation here - it is
            // how somebody gains access - and Better Auth writes the row, so
            // writeWithAudit has nothing to batch against. The actor is the
            // new account itself: nobody else was present.
            const role = (user as { role?: string | null }).role ?? null;
            await writeAuditOnly(
              db,
              {
                kind: AUDIT_ACTOR_KIND.User,
                id: user.id,
                label: user.email,
                ip: null,
                userAgent: null,
              },
              {
                action: AUDIT_ACTION.AccountInviteAccepted,
                targetKind: AUDIT_ENTITY_KIND.User,
                targetId: user.id,
                payload: { email, role },
              },
            );
          },
        },
      },
    },

    advanced: {
      database: { generateId: () => generateId() },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Whether an address is entitled to receive a sign-in link at all.
 *
 * True for an existing account (they sign in normally) or an address holding a
 * usable invite (they are completing signup). Everyone else gets nothing.
 */
async function mayReceiveSignInLink(db: Db, rawEmail: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail);

  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existing.length > 0) return true;

  const pending = await db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      memberId: invites.memberId,
      expiresAt: invites.expiresAt,
      acceptedAt: invites.acceptedAt,
      revokedAt: invites.revokedAt,
    })
    .from(invites)
    .where(eq(invites.email, email));

  return decideInviteGate(pending as OpenInvite[]).allow;
}
