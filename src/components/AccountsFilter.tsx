import { html } from 'hono/html';

export interface AccountRow {
  email: string;
  name: string | null;
  role: string | null;
  memberId: string | null;
}

/**
 * The per-row state the filter reads.
 *
 * Shared by the table and its test, for the same reason as the roster's: a
 * renamed attribute would leave the table rendering perfectly and every filter
 * dead.
 */
export const accountRowAttrs = (a: AccountRow) => ({
  'data-row': '',
  'data-search': `${a.email} ${a.name ?? ''}`.toLowerCase(),
  'data-role': a.role ?? '',
  'data-linked': a.memberId ? 'linked' : 'unlinked',
});

/** The same shape for the invitations table, which has its own statuses. */
export const inviteRowAttrs = (inv: { email: string; role: string; status: string }) => ({
  'data-invite-row': '',
  'data-search': inv.email.toLowerCase(),
  'data-role': inv.role,
  'data-status': inv.status,
});

const CONTROL =
  'px-3 py-2 rounded-lg border border-neutral-300 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none';

export function AccountsFilter({ roles }: { roles: readonly { value: string; label: string }[] }) {
  return (
    <div class="flex flex-wrap gap-3 mb-3">
      <label class="flex-1 min-w-[12rem]">
        <span class="sr-only">Search accounts by email or name</span>
        <input
          type="search"
          id="accounts-search"
          placeholder="Search by email or name"
          autocomplete="off"
          class={`w-full ${CONTROL}`}
        />
      </label>

      <label>
        <span class="sr-only">Filter accounts by role</span>
        <select id="accounts-role" class={CONTROL}>
          <option value="">All roles</option>
          {roles.map((r) => (
            <option value={r.value}>{r.label}</option>
          ))}
          <option value="__none">No access</option>
        </select>
      </label>

      <label>
        <span class="sr-only">Filter accounts by whether they have a member profile</span>
        <select id="accounts-linked" class={CONTROL}>
          <option value="">Linked and unlinked</option>
          <option value="linked">Linked to a profile</option>
          <option value="unlinked">Not linked</option>
        </select>
      </label>
    </div>
  );
}

export function InvitesFilter({ roles }: { roles: readonly { value: string; label: string }[] }) {
  return (
    <div class="flex flex-wrap gap-3 mb-3">
      <label class="flex-1 min-w-[12rem]">
        <span class="sr-only">Search invitations by email</span>
        <input
          type="search"
          id="invites-search"
          placeholder="Search invitations"
          autocomplete="off"
          class={`w-full ${CONTROL}`}
        />
      </label>

      <label>
        <span class="sr-only">Filter invitations by role</span>
        <select id="invites-role" class={CONTROL}>
          <option value="">All roles</option>
          {roles.map((r) => (
            <option value={r.value}>{r.label}</option>
          ))}
        </select>
      </label>

      <label>
        <span class="sr-only">Filter invitations by status</span>
        {/*
          Defaults to open. Once a season has been onboarded the accepted rows
          outnumber everything else, and the only ones that need acting on are
          the ones still outstanding.
        */}
        <select id="invites-status" class={CONTROL}>
          <option value="open" selected>
            Open only
          </option>
          <option value="">Every status</option>
          <option value="accepted">Accepted</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
        </select>
      </label>
    </div>
  );
}

/**
 * Filters both tables.
 *
 * Neither carries a bulk action, so unlike the roster there is nothing to
 * clear when a row is hidden - hiding is all this has to do.
 */
export const AccountsFilterScript = () => html`
  <script>
    (function () {
      function wire(prefix, rowSelector, keys) {
        var search = document.getElementById(prefix + '-search');
        if (!search) return;

        var controls = keys.map(function (k) {
          return { key: k, el: document.getElementById(prefix + '-' + k) };
        });
        var rows = Array.prototype.slice.call(document.querySelectorAll(rowSelector));
        var shown = document.querySelector('[data-' + prefix + '-shown]');
        var empty = document.querySelector('[data-' + prefix + '-empty]');

        function apply() {
          var term = search.value.trim().toLowerCase();
          var visible = 0;

          rows.forEach(function (row) {
            var ok = !term || row.getAttribute('data-search').indexOf(term) !== -1;

            controls.forEach(function (c) {
              if (!ok || !c.el || !c.el.value) return;
              var want = c.el.value;
              var actual = row.getAttribute('data-' + c.key);
              // "__none" is how an empty attribute is asked for, since an
              // empty select value already means "no filter".
              ok = want === '__none' ? actual === '' : actual === want;
            });

            row.hidden = !ok;
            if (ok) visible++;
          });

          if (shown) shown.textContent = String(visible);
          if (empty) empty.classList.toggle('hidden', visible !== 0);
        }

        search.addEventListener('input', apply);
        controls.forEach(function (c) {
          if (c.el) c.el.addEventListener('change', apply);
        });
        apply();
      }

      wire('accounts', '[data-row]', ['role', 'linked']);
      wire('invites', '[data-invite-row]', ['role', 'status']);
    })();
  </script>
`;
