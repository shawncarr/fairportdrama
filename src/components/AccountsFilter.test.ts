/// <reference lib="dom" />
/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountsFilterScript,
  accountRowAttrs,
  inviteRowAttrs,
  type AccountRow,
} from './AccountsFilter';

/**
 * Both tables' filtering, actually run.
 *
 * One script drives two independent tables, which is where this could quietly
 * go wrong: filtering accounts must not touch the invitations, and the
 * invitations default to showing only the open ones.
 */

const ACCOUNTS: (AccountRow & { id: string })[] = [
  { id: 'a1', email: 'ada@x.org', name: 'Ada Lovelace', role: 'admin', memberId: 'ada' },
  { id: 'a2', email: 'ben@x.org', name: 'Ben Bell', role: 'member', memberId: null },
  { id: 'a3', email: 'cai@x.org', name: null, role: null, memberId: null },
  { id: 'a4', email: 'dot@x.org', name: 'Dot Dash', role: 'member', memberId: 'dot' },
];

const INVITES = [
  { email: 'eve@x.org', role: 'member', status: 'open' },
  { email: 'fay@x.org', role: 'member', status: 'accepted' },
  { email: 'gus@x.org', role: 'officer', status: 'open' },
  { email: 'hal@x.org', role: 'member', status: 'expired' },
];

const attrs = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');

async function mount() {
  const script = await (AccountsFilterScript() as unknown as {
    toString(): Promise<string> | string;
  }).toString();

  document.body.innerHTML = `
    <input type="search" id="accounts-search" />
    <select id="accounts-role"><option value="" selected></option><option value="admin">a</option><option value="member">m</option><option value="__none">n</option></select>
    <select id="accounts-linked"><option value="" selected></option><option value="linked">l</option><option value="unlinked">u</option></select>
    <span data-accounts-shown></span>
    <p data-accounts-empty class="hidden"></p>
    <table><tbody>
      ${ACCOUNTS.map((a) => `<tr ${attrs(accountRowAttrs(a))}><td>${a.email}</td></tr>`).join('')}
    </tbody></table>

    <input type="search" id="invites-search" />
    <select id="invites-role"><option value="" selected></option><option value="member">m</option><option value="officer">o</option></select>
    <select id="invites-status"><option value="open" selected>o</option><option value="">all</option><option value="accepted">a</option><option value="expired">e</option></select>
    <span data-invites-shown></span>
    <p data-invites-empty class="hidden"></p>
    <table><tbody>
      ${INVITES.map((i) => `<tr ${attrs(inviteRowAttrs(i))}><td>${i.email}</td></tr>`).join('')}
    </tbody></table>

    ${String(script)}
  `;

  const source = document.querySelector('script')?.textContent ?? '';
  if (source.trim().length === 0) throw new Error('accounts filter script did not render');
  new Function(source)();

  const visible = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((r) => !r.hidden)
      .map((r) => r.textContent!.trim());

  return {
    accounts: () => visible('[data-row]'),
    invitations: () => visible('[data-invite-row]'),
    accountsShown: () => document.querySelector('[data-accounts-shown]')!.textContent,
    invitesShown: () => document.querySelector('[data-invites-shown]')!.textContent,
    emptyShown: (prefix: string) =>
      !document.querySelector(`[data-${prefix}-empty]`)!.classList.contains('hidden'),
    set(id: string, value: string) {
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
      el.value = value;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input'));
    },
  };
}

let ui: Awaited<ReturnType<typeof mount>>;
beforeEach(async () => {
  ui = await mount();
});

describe('accounts', () => {
  it('starts with all of them', () => {
    expect(ui.accounts()).toHaveLength(4);
    expect(ui.accountsShown()).toBe('4');
  });

  it('searches the email and the name together', () => {
    ui.set('accounts-search', 'lovelace');
    expect(ui.accounts()).toEqual(['ada@x.org']);

    ui.set('accounts-search', 'ben@');
    expect(ui.accounts()).toEqual(['ben@x.org']);
  });

  it('filters by role', () => {
    ui.set('accounts-role', 'member');
    expect(ui.accounts()).toEqual(['ben@x.org', 'dot@x.org']);
  });

  it('finds accounts with no access at all', () => {
    // The ones that should not exist under invite-only signup, so being able
    // to list them is the point.
    ui.set('accounts-role', '__none');
    expect(ui.accounts()).toEqual(['cai@x.org']);
  });

  it('filters by whether a member profile is linked', () => {
    ui.set('accounts-linked', 'unlinked');
    expect(ui.accounts()).toEqual(['ben@x.org', 'cai@x.org']);

    ui.set('accounts-linked', 'linked');
    expect(ui.accounts()).toEqual(['ada@x.org', 'dot@x.org']);
  });

  it('combines search with the selects', () => {
    ui.set('accounts-role', 'member');
    ui.set('accounts-search', 'dot');
    expect(ui.accounts()).toEqual(['dot@x.org']);
  });

  it('says when nothing matches', () => {
    ui.set('accounts-search', 'nobody');
    expect(ui.accounts()).toEqual([]);
    expect(ui.emptyShown('accounts')).toBe(true);
  });
});

describe('invitations', () => {
  it('shows only the open ones to begin with', () => {
    // After a season is onboarded the accepted rows outnumber everything else,
    // and only the outstanding ones need acting on.
    expect(ui.invitations()).toEqual(['eve@x.org', 'gus@x.org']);
    expect(ui.invitesShown()).toBe('2');
  });

  it('can show every status', () => {
    ui.set('invites-status', '');
    expect(ui.invitations()).toHaveLength(4);
  });

  it('filters by status', () => {
    ui.set('invites-status', 'expired');
    expect(ui.invitations()).toEqual(['hal@x.org']);
  });

  it('filters by role within a status', () => {
    ui.set('invites-role', 'officer');
    expect(ui.invitations()).toEqual(['gus@x.org']);
  });
});

describe('the two tables are independent', () => {
  it('filtering accounts leaves the invitations alone', () => {
    ui.set('accounts-search', 'ada');

    expect(ui.accounts()).toEqual(['ada@x.org']);
    expect(ui.invitations()).toEqual(['eve@x.org', 'gus@x.org']);
  });

  it('filtering invitations leaves the accounts alone', () => {
    ui.set('invites-status', 'accepted');

    expect(ui.invitations()).toEqual(['fay@x.org']);
    expect(ui.accounts()).toHaveLength(4);
  });
});
