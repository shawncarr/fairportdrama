import { html } from 'hono/html';
import { MEMBER_VISIBILITY, type MemberVisibility } from '~/db/schema/content';

export interface RosterRow {
  name: string;
  grade: string;
  visibility: MemberVisibility;
  isActive: boolean;
  hasPhoto: boolean;
  hasBio: boolean;
}

/**
 * The per-row state the filter reads.
 *
 * Shared by the table and its test so the two cannot drift: a renamed
 * attribute would otherwise leave the table rendering perfectly and every
 * filter dead, which is exactly the failure this pairing exists to catch.
 */
export const rosterRowAttrs = (m: RosterRow) => ({
  'data-row': '',
  'data-name': m.name.toLowerCase(),
  'data-grade': m.grade,
  'data-visibility': m.visibility,
  'data-status': m.isActive ? 'active' : 'inactive',
  'data-has': `${m.hasPhoto ? 'photo ' : ''}${m.hasBio ? 'bio' : ''}`.trim(),
});

/**
 * Roster filters.
 *
 * The point of filtering here is not browsing - it is driving the bulk
 * visibility change below the table. "Everyone with a photo and a bio who is
 * still private" is the actual opt-in workflow, and it used to be 128 rows
 * read by eye.
 */
export function RosterFilters({ grades }: { grades: string[] }) {
  const control =
    'px-3 py-2 rounded-lg border border-neutral-300 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none';

  return (
    <div class="flex flex-wrap gap-3">
      <label class="flex-1 min-w-[12rem]">
        <span class="sr-only">Search the roster by name</span>
        <input
          type="search"
          id="roster-search"
          placeholder="Search by name"
          autocomplete="off"
          class={`w-full ${control}`}
        />
      </label>

      <label>
        <span class="sr-only">Filter by grade</span>
        <select id="roster-grade" class={control}>
          <option value="">All grades</option>
          {grades.map((g) => (
            <option value={g}>{g}</option>
          ))}
        </select>
      </label>

      <label>
        <span class="sr-only">Filter by visibility</span>
        <select id="roster-visibility" class={control}>
          <option value="">Public and private</option>
          <option value={MEMBER_VISIBILITY.Full}>Public only</option>
          <option value={MEMBER_VISIBILITY.Limited}>Private only</option>
        </select>
      </label>

      <label>
        <span class="sr-only">Filter by whether they are on this year's roster</span>
        <select id="roster-status" class={control}>
          <option value="">Active and inactive</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
        </select>
      </label>

      <label>
        <span class="sr-only">Filter by what is on their profile</span>
        <select id="roster-has" class={control}>
          <option value="">Any profile</option>
          <option value="photo">Has a photo</option>
          <option value="bio">Has a bio</option>
          <option value="none">Has neither</option>
        </select>
      </label>
    </div>
  );
}

/**
 * Filtering, and the selection safety that has to come with it.
 *
 * Hiding a row clears its checkbox. Without that, filtering after selecting
 * would submit members who are no longer on screen - and the action attached
 * to this selection publishes a student's name and photograph. Nobody should
 * be made public by a checkbox they cannot see.
 */
export const RosterFilterScript = () => html`
  <script>
    (function () {
      var search = document.getElementById('roster-search');
      if (!search) return;

      var selects = ['grade', 'visibility', 'status', 'has'].map(function (k) {
        return document.getElementById('roster-' + k);
      });
      var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row]'));
      var selectAll = document.getElementById('roster-select-all');
      var shown = document.querySelector('[data-shown]');
      var selected = document.querySelector('[data-selected]');
      var selectedWrap = document.querySelector('[data-selected-wrap]');

      var box = function (row) {
        return row.querySelector('input[name="memberIds"]');
      };

      function matchesHas(row, want) {
        var has = row.getAttribute('data-has');
        if (want === 'none') return has === '';
        return (' ' + has + ' ').indexOf(' ' + want + ' ') !== -1;
      }

      function visibleRows() {
        return rows.filter(function (row) {
          return !row.hidden;
        });
      }

      function countSelected() {
        var n = rows.filter(function (row) {
          return box(row).checked;
        }).length;
        if (selected) selected.textContent = String(n);
        if (selectedWrap) selectedWrap.classList.toggle('hidden', n === 0);

        var vis = visibleRows();
        if (selectAll) {
          var checkedVisible = vis.filter(function (row) {
            return box(row).checked;
          }).length;
          selectAll.checked = vis.length > 0 && checkedVisible === vis.length;
          selectAll.indeterminate = checkedVisible > 0 && checkedVisible < vis.length;
        }
      }

      function apply() {
        var term = search.value.trim().toLowerCase();
        var grade = selects[0].value;
        var visibility = selects[1].value;
        var status = selects[2].value;
        var has = selects[3].value;

        rows.forEach(function (row) {
          var ok =
            (!term || row.getAttribute('data-name').indexOf(term) !== -1) &&
            (!grade || row.getAttribute('data-grade') === grade) &&
            (!visibility || row.getAttribute('data-visibility') === visibility) &&
            (!status || row.getAttribute('data-status') === status) &&
            (!has || matchesHas(row, has));

          row.hidden = !ok;
          // A hidden row must never stay selected: the submit button below
          // makes the selection public.
          if (!ok) box(row).checked = false;
        });

        if (shown) shown.textContent = String(visibleRows().length);
        countSelected();
      }

      search.addEventListener('input', apply);
      selects.forEach(function (s) {
        s.addEventListener('change', apply);
      });

      if (selectAll) {
        selectAll.addEventListener('change', function () {
          var on = selectAll.checked;
          visibleRows().forEach(function (row) {
            box(row).checked = on;
          });
          countSelected();
        });
      }

      rows.forEach(function (row) {
        box(row).addEventListener('change', countSelected);
      });

      // Run once on load rather than only on the first interaction, so the
      // count comes from the rows themselves. The server renders a number into
      // the same span, and two places computing it independently is how they
      // come to disagree.
      apply();
    })();
  </script>
`;
