/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '~/lib/markdown';
import { mountRichText } from './editor';

const setup = (attrs: string, value: string) => {
  document.body.innerHTML = `<form><textarea ${attrs}></textarea></form>`;
  const textarea = document.querySelector('textarea')!;
  textarea.value = value;
  return textarea;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mounting', () => {
  it('hides the textarea, drops required, and loads its markdown', () => {
    const textarea = setup('data-rich="basic" required', 'Line one\nLine two');
    const mounted = mountRichText(textarea)!;

    expect(textarea.hidden).toBe(true);
    expect(textarea.required).toBe(false);
    expect(mounted.editor.getMarkdown()).toBe('Line one\nLine two');
  });

  it('leaves the text untouched until someone edits it', () => {
    const textarea = setup('data-rich="full"', 'Price is 5 * 3');
    mountRichText(textarea);
    expect(textarea.value).toBe('Price is 5 * 3');
  });

  it('writes markdown back on every edit', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;

    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.toggleBold();
    expect(textarea.value).toBe('**Hello**');
  });

  it('round-trips plain text through an edit and an undo', () => {
    const source = 'Line one\nLine two\n\nNew paragraph.';
    const textarea = setup('data-rich="basic"', source);
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('!');
    editor.commands.undo();
    expect(textarea.value).toBe(source);
  });

  it('renders literal markdown characters the same after an edit', () => {
    // They come back escaped (`5 \* 3`), which marked renders identically.
    const source = 'Tickets are 5 * 3 dollars, my_var stays, and #1 is fine.';
    const textarea = setup('data-rich="basic"', source);
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('!');
    editor.commands.undo();
    expect(renderMarkdown(textarea.value)).toBe(renderMarkdown(source));
  });

  it('round-trips a synopsis shaped like the real ones', () => {
    // The seed data is generated and gitignored, so this stands in for it.
    const source =
      'A demigod quest across America.\n\nPercy must find the lightning bolt\nbefore the summer solstice.';
    const textarea = setup('data-rich="full"', source);
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('!');
    editor.commands.undo();
    expect(textarea.value).toBe(source);
  });

  it('drops a heading pasted into a bio but keeps its words', () => {
    const textarea = setup('data-rich="basic"', 'Bio');
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('<h1>Pasted</h1>');
    expect(textarea.value).toContain('Pasted');
    expect(textarea.value).not.toContain('#');
  });
});

describe('falling back to the plain textarea', () => {
  // Tiptap loads a document with an unregistered node as empty, so mounting
  // here would erase the field on the next save.
  it.each([
    ['basic', '# Big news'],
    ['basic', '> quoted'],
    ['full', '| a |\n|---|\n| 1 |'],
    ['full', '<b>raw</b>'],
    ['full', 'caf&eacute;'],
    ['full', '[![i](https://x.example/a.png)](https://x.example)'],
    ['basic', '- a\n\n- b'],
  ])('leaves a %s field holding %j alone and says why', (profile, source) => {
    const textarea = setup(`data-rich="${profile}" required`, source);

    expect(mountRichText(textarea)).toBeNull();
    expect(textarea.hidden).toBe(false);
    expect(textarea.required).toBe(true);
    expect(textarea.value).toBe(source);
    expect(document.body.textContent).toContain("formatting the editor can't show");
  });
});

const buttons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-rich-toolbar] button')].map(
    (b) => b.getAttribute('aria-label'),
  );
const click = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-rich-toolbar] button')]
    .find((b) => b.getAttribute('aria-label') === label)!
    .click();

describe('the toolbar', () => {
  it('offers headings and quotes for full fields', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    expect(buttons()).toEqual([
      'Bold', 'Italic', 'Heading', 'Subheading', 'Bullets', 'Numbers', 'Quote', 'Link', 'Undo', 'Redo',
    ]);
  });

  it('offers only what a bio may hold', () => {
    mountRichText(setup('data-rich="basic"', 'x'));
    expect(buttons()).toEqual(['Bold', 'Italic', 'Bullets', 'Numbers', 'Link', 'Undo', 'Redo']);
  });

  it('shows an icon on each button, with its name for screen readers and a tooltip', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    for (const b of document.querySelectorAll('[data-rich-toolbar] button')) {
      const label = b.getAttribute('aria-label');
      expect(label).toBeTruthy();
      expect(b.getAttribute('title')).toBe(label);
      expect(b.textContent?.trim()).toBe('');
      const svg = b.querySelector('svg')!;
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.querySelector('path, line')).not.toBeNull();
    }
  });

  it('never submits the form', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    for (const b of document.querySelectorAll('[data-rich-toolbar] button')) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });

  it('applies formatting and reports it with aria-pressed', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;
    editor.commands.setTextSelection({ from: 1, to: 6 });

    click('Bold');
    expect(textarea.value).toBe('**Hello**');
    const bold = [...document.querySelectorAll('[data-rich-toolbar] button')].find(
      (b) => b.getAttribute('aria-label') === 'Bold',
    )!;
    expect(bold.getAttribute('aria-pressed')).toBe('true');
  });

  it('links to a safe address', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;
    editor.commands.setTextSelection({ from: 1, to: 6 });
    window.prompt = () => 'https://example.com';

    click('Link');
    expect(textarea.value).toBe('[Hello](https://example.com)');
  });

  it('encodes characters that would break the markdown link', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;
    editor.commands.setTextSelection({ from: 1, to: 6 });
    window.prompt = () => 'https://example.com/a b (1)';

    click('Link');
    expect(textarea.value).toBe('[Hello](https://example.com/a%20b%20%281%29)');
  });

  it('is announced as a group of formatting controls', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    const toolbar = document.querySelector('[data-rich-toolbar]')!;
    expect(toolbar.getAttribute('role')).toBe('group');
    expect(toolbar.getAttribute('aria-label')).toBe('Formatting');
  });

  it('refuses an unsafe address and says so', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;
    editor.commands.setTextSelection({ from: 1, to: 6 });
    window.prompt = () => 'javascript:alert(1)';

    click('Link');
    expect(textarea.value).toBe('Hello');
    expect(document.body.textContent).toContain('Links must start with');
  });
});

const submit = (form: HTMLFormElement) => {
  const event = new Event('submit', { cancelable: true });
  form.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('the counter', () => {
  it('counts markdown, not visible text', () => {
    const textarea = setup('data-rich="basic" maxlength="2000"', '[a](https://example.com)');
    mountRichText(textarea);
    expect(document.body.textContent).toContain('24 / 2,000');
  });

  it('is absent on fields without a limit', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    expect(document.body.textContent).not.toContain('/ ');
  });
});

describe('submitting', () => {
  it('stops an empty required field and says so', () => {
    const textarea = setup('data-rich="full" required', '');
    mountRichText(textarea);
    expect(submit(textarea.form!)).toBe(true);
    expect(document.body.textContent).toContain("This can't be empty.");
  });

  it('stops a field over its limit', () => {
    const textarea = setup('data-rich="basic" maxlength="5"', 'abcdef');
    mountRichText(textarea);
    expect(submit(textarea.form!)).toBe(true);
    expect(document.body.textContent).toContain('1 character over the limit');
  });

  it('clears the empty-field message once someone types', () => {
    const textarea = setup('data-rich="full" required', '');
    const { editor } = mountRichText(textarea)!;
    submit(textarea.form!);

    editor.commands.insertContent('Now it has words.');
    expect(document.body.textContent).not.toContain("This can't be empty.");
  });

  it('lets a valid field through', () => {
    const textarea = setup('data-rich="full" required maxlength="2000"', 'Fine.');
    mountRichText(textarea);
    expect(submit(textarea.form!)).toBe(false);
  });
});
