/// <reference lib="dom" />
/**
 * @vitest-environment happy-dom
 */
// The DOM lib is enabled for this file only, for the reason given in
// PhotoGallery.test.ts: the project targets workerd, where `document` does not
// exist.
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMBER_VISIBILITY } from '~/db/schema/content';
import { RosterFilterScript, rosterRowAttrs, type RosterRow } from './RosterFilter';

/**
 * The roster filter, actually run.
 *
 * Asserting that the markup contains the script proves nothing about what the
 * script does, and one thing it does is a safety property: hiding a row clears
 * its checkbox. The button under this table publishes a student's name and
 * photograph, so a selection surviving out of view is the failure that matters.
 */

const ROSTER: (RosterRow & { id: string })[] = [
  {
    id: 'fran', name: 'Fran Full', grade: 'Senior',
    visibility: MEMBER_VISIBILITY.Full, isActive: true, hasPhoto: true, hasBio: true,
  },
  {
    id: 'bart', name: 'Bart Bare', grade: 'Freshman',
    visibility: MEMBER_VISIBILITY.Limited, isActive: true, hasPhoto: false, hasBio: false,
  },
  {
    id: 'pia', name: 'Pia Photo', grade: 'Freshman',
    visibility: MEMBER_VISIBILITY.Limited, isActive: true, hasPhoto: true, hasBio: true,
  },
  {
    id: 'gil', name: 'Gil Gone', grade: 'Alumni',
    visibility: MEMBER_VISIBILITY.Limited, isActive: false, hasPhoto: true, hasBio: false,
  },
];

const attrs = (m: RosterRow) =>
  Object.entries(rosterRowAttrs(m))
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');

/**
 * Builds the table the route builds and runs the component's own script over
 * it. The row attributes come from the shared helper the route uses, so this
 * cannot pass against markup the route does not emit.
 */
async function mount() {
  const script = await (RosterFilterScript() as unknown as {
    toString(): Promise<string> | string;
  }).toString();

  document.body.innerHTML = `
    <input type="search" id="roster-search" />
    <select id="roster-grade"><option value=""></option><option value="Senior">Senior</option><option value="Freshman">Freshman</option><option value="Alumni">Alumni</option></select>
    <select id="roster-visibility"><option value=""></option><option value="${MEMBER_VISIBILITY.Full}">p</option><option value="${MEMBER_VISIBILITY.Limited}">l</option></select>
    <select id="roster-status"><option value=""></option><option value="active">a</option><option value="inactive">i</option></select>
    <select id="roster-has"><option value=""></option><option value="photo">p</option><option value="bio">b</option><option value="none">n</option></select>
    <form>
      <table><tbody>
        ${ROSTER.map(
          (m) =>
            `<tr ${attrs(m)}><td><input type="checkbox" name="memberIds" value="${m.id}"></td><td>${m.name}</td></tr>`,
        ).join('')}
      </tbody></table>
      <input type="checkbox" id="roster-select-all" />
      <span data-shown></span><span data-selected-wrap class="hidden"><b data-selected></b></span>
    </form>
    ${String(script)}
  `;

  const source = document.querySelector('script')?.textContent ?? '';
  if (source.trim().length === 0) throw new Error('roster filter script did not render');
  new Function(source)();

  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-row]'));
  const boxOf = (id: string) =>
    document.querySelector<HTMLInputElement>(`input[value="${id}"]`)!;

  return {
    boxOf,
    selectAll: document.getElementById('roster-select-all') as HTMLInputElement,
    shown: () => rows().filter((r) => !r.hidden).map((r) => r.getAttribute('data-name')!),
    checked: () =>
      Array.from(document.querySelectorAll<HTMLInputElement>('input[name="memberIds"]'))
        .filter((b) => b.checked)
        .map((b) => b.value),
    shownCount: () => document.querySelector('[data-shown]')!.textContent,
    selectedCount: () => document.querySelector('[data-selected]')!.textContent,
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

describe('filtering', () => {
  it('starts with everyone shown', () => {
    expect(ui.shown()).toHaveLength(4);
    expect(ui.shownCount()).toBe('4');
  });

  it('narrows by name, case-insensitively', () => {
    ui.set('roster-search', 'FR');
    expect(ui.shown()).toEqual(['fran full']);
  });

  it('narrows by grade', () => {
    ui.set('roster-grade', 'Freshman');
    expect(ui.shown()).toEqual(['bart bare', 'pia photo']);
  });

  it('narrows by visibility', () => {
    ui.set('roster-visibility', MEMBER_VISIBILITY.Full);
    expect(ui.shown()).toEqual(['fran full']);
  });

  it('narrows by whether they are on this year’s roster', () => {
    ui.set('roster-status', 'inactive');
    expect(ui.shown()).toEqual(['gil gone']);
  });

  it('narrows by what is on the profile, including having neither', () => {
    ui.set('roster-has', 'bio');
    expect(ui.shown()).toEqual(['fran full', 'pia photo']);

    ui.set('roster-has', 'none');
    expect(ui.shown()).toEqual(['bart bare']);
  });

  it('does not match "bio" against a row that only has a photo', () => {
    ui.set('roster-has', 'bio');
    expect(ui.shown()).not.toContain('gil gone');
  });

  it('combines the filters, which is the workflow they exist for', () => {
    // "Everyone still private who has a photo and a bio" - the opt-in pass.
    ui.set('roster-visibility', MEMBER_VISIBILITY.Limited);
    ui.set('roster-has', 'bio');
    ui.set('roster-status', 'active');

    expect(ui.shown()).toEqual(['pia photo']);
  });

  it('restores everyone when the filters are cleared', () => {
    ui.set('roster-search', 'fran');
    ui.set('roster-search', '');
    expect(ui.shown()).toHaveLength(4);
  });
});

describe('selecting', () => {
  it('select-all takes only the rows on screen', () => {
    ui.set('roster-grade', 'Freshman');
    ui.selectAll.checked = true;
    ui.selectAll.dispatchEvent(new Event('change'));

    expect(ui.checked()).toEqual(['bart', 'pia']);
  });

  it('clears a selected row when a filter hides it', () => {
    ui.boxOf('fran').checked = true;
    ui.boxOf('fran').dispatchEvent(new Event('change'));
    expect(ui.checked()).toEqual(['fran']);

    ui.set('roster-grade', 'Freshman');

    // The safety property: Fran is off screen, so Fran is not in the submit.
    expect(ui.checked()).toEqual([]);
  });

  it('does not bring a cleared row back when the filter is removed', () => {
    ui.boxOf('fran').checked = true;
    ui.boxOf('fran').dispatchEvent(new Event('change'));
    ui.set('roster-grade', 'Freshman');
    ui.set('roster-grade', '');

    // Reappearing already ticked would be the same hazard, one step later.
    expect(ui.checked()).toEqual([]);
  });

  it('counts the selection, and hides the count when nothing is selected', () => {
    const wrap = document.querySelector('[data-selected-wrap]')!;
    expect(wrap.classList.contains('hidden')).toBe(true);

    ui.boxOf('fran').checked = true;
    ui.boxOf('fran').dispatchEvent(new Event('change'));

    expect(ui.selectedCount()).toBe('1');
    expect(wrap.classList.contains('hidden')).toBe(false);
  });

  it('shows select-all as partial when only some visible rows are ticked', () => {
    ui.boxOf('fran').checked = true;
    ui.boxOf('fran').dispatchEvent(new Event('change'));

    expect(ui.selectAll.checked).toBe(false);
    expect(ui.selectAll.indeterminate).toBe(true);
  });

  it('ticks select-all once every visible row is selected', () => {
    ui.set('roster-visibility', MEMBER_VISIBILITY.Full);
    ui.boxOf('fran').checked = true;
    ui.boxOf('fran').dispatchEvent(new Event('change'));

    expect(ui.selectAll.checked).toBe(true);
    expect(ui.selectAll.indeterminate).toBe(false);
  });

  it('unticks everything shown when select-all is turned off', () => {
    ui.selectAll.checked = true;
    ui.selectAll.dispatchEvent(new Event('change'));
    expect(ui.checked()).toHaveLength(4);

    ui.selectAll.checked = false;
    ui.selectAll.dispatchEvent(new Event('change'));
    expect(ui.checked()).toEqual([]);
  });
});
