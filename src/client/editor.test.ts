/// <reference lib="dom" />
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
  ])('leaves a %s field holding %j alone and says why', (profile, source) => {
    const textarea = setup(`data-rich="${profile}" required`, source);

    expect(mountRichText(textarea)).toBeNull();
    expect(textarea.hidden).toBe(false);
    expect(textarea.required).toBe(true);
    expect(textarea.value).toBe(source);
    expect(document.body.textContent).toContain("formatting the editor can't show");
  });
});
