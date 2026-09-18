import { Editor, type Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import {
  RICH_TEXT_PROFILE,
  type RichTextProfile,
  safeUrl,
  unsupportedToken,
} from '~/lib/rich-text';
import boldIcon from './icons/bold.svg';
import heading2Icon from './icons/heading-2.svg';
import heading3Icon from './icons/heading-3.svg';
import italicIcon from './icons/italic.svg';
import linkIcon from './icons/link.svg';
import numbersIcon from './icons/list-ordered.svg';
import bulletsIcon from './icons/list.svg';
import redoIcon from './icons/redo-2.svg';
import quoteIcon from './icons/text-quote.svg';
import undoIcon from './icons/undo-2.svg';

/**
 * The admin's rich text editor.
 *
 * It enhances a `<textarea data-rich="full|basic">` rather than replacing the
 * form: the textarea stays in the form, hidden, and holds the markdown the
 * server receives. Without this script the textarea is simply visible.
 */

export interface MountedEditor {
  editor: Editor;
  textarea: HTMLTextAreaElement;
}

interface Tool {
  /** The button's accessible name and tooltip; the button shows only `icon`. */
  label: string;
  /** A Lucide SVG file from ./icons, imported as markup. */
  icon: string;
  /** `status` is the line under the editor, for anything the tool must say. */
  run: (editor: Editor, status: HTMLElement) => void;
  active?: (editor: Editor) => boolean;
  profiles: readonly RichTextProfile[];
}

const BOTH = [RICH_TEXT_PROFILE.Full, RICH_TEXT_PROFILE.Basic] as const;
const FULL_ONLY = [RICH_TEXT_PROFILE.Full] as const;

const LINK_RULE = 'Links must start with https://, http://, mailto:, or /.';

function promptForLink(editor: Editor, status: HTMLElement) {
  const previous = editor.getAttributes('link').href as string | undefined;
  const entered = window.prompt('Link address (leave empty to remove the link)', previous ?? 'https://');
  if (entered === null) return;
  if (entered.trim() === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  // Kept as typed rather than as safeUrl normalizes it, except for what the
  // markdown serializer writes into `[text](href)` unescaped: a space or a
  // parenthesis there would end the link early.
  const href = entered
    .trim()
    .replace(/[\s()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  if (safeUrl(href) === null) {
    status.textContent = LINK_RULE;
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

const TOOLS: Tool[] = [
  { label: 'Bold', icon: boldIcon, profiles: BOTH, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { label: 'Italic', icon: italicIcon, profiles: BOTH, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { label: 'Heading', icon: heading2Icon, profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
  { label: 'Subheading', icon: heading3Icon, profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive('heading', { level: 3 }) },
  { label: 'Bullets', icon: bulletsIcon, profiles: BOTH, run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
  { label: 'Numbers', icon: numbersIcon, profiles: BOTH, run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { label: 'Quote', icon: quoteIcon, profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
  { label: 'Link', icon: linkIcon, profiles: BOTH, run: promptForLink, active: (e) => e.isActive('link') },
  { label: 'Undo', icon: undoIcon, profiles: BOTH, run: (e) => e.chain().focus().undo().run() },
  { label: 'Redo', icon: redoIcon, profiles: BOTH, run: (e) => e.chain().focus().redo().run() },
];

const profileOf = (textarea: HTMLTextAreaElement): RichTextProfile =>
  textarea.dataset.rich === RICH_TEXT_PROFILE.Basic
    ? RICH_TEXT_PROFILE.Basic
    : RICH_TEXT_PROFILE.Full;

function extensionsFor(profile: RichTextProfile): Extensions {
  // Nodes a profile leaves out are not registered at all, so pasted content
  // using them is reduced to its text rather than smuggled in.
  const off = profile === RICH_TEXT_PROFILE.Basic ? false : undefined;
  const kit = StarterKit.configure({
    // Markdown has no underline, so it could not be saved.
    underline: false,
    heading: off,
    blockquote: off,
    code: off,
    codeBlock: off,
    strike: off,
    horizontalRule: off,
    link: {
      openOnClick: false,
      autolink: false,
      isAllowedUri: (url) => safeUrl(url) !== null,
    },
  });
  return profile === RICH_TEXT_PROFILE.Basic ? [kit, Markdown] : [kit, Image, Markdown];
}

export function mountRichText(textarea: HTMLTextAreaElement): MountedEditor | null {
  const profile = profileOf(textarea);

  if (unsupportedToken(textarea.value, profile) !== null) {
    const note = document.createElement('p');
    note.className = 'text-xs text-neutral-500 mt-1';
    note.textContent = "This text has formatting the editor can't show, so it opens as plain text.";
    textarea.after(note);
    return null;
  }

  const frame = document.createElement('div');
  frame.className =
    'rounded-lg border border-neutral-300 bg-white focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500';
  const host = document.createElement('div');
  frame.append(host);
  textarea.after(frame);

  const required = textarea.required;
  const limit = textarea.maxLength > 0 ? textarea.maxLength : null;

  // A hidden required control blocks submit with a message nobody can see,
  // so the requirement is dropped here; the submit check below takes over
  // enforcing it.
  textarea.hidden = true;
  textarea.required = false;

  const toolbar = document.createElement('div');
  toolbar.dataset.richToolbar = '';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Formatting');
  toolbar.className = 'flex flex-wrap gap-1 border-b border-neutral-200 p-1';
  frame.prepend(toolbar);

  const status = document.createElement('p');
  status.className = 'text-xs text-neutral-500 mt-1';
  status.setAttribute('aria-live', 'polite');
  frame.after(status);

  const tools = TOOLS.filter((t) => t.profiles.includes(profile)).map((tool) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', tool.label);
    button.title = tool.label;
    // The markup is a file shipped in ./icons, never author input. Only its
    // <svg> is kept, not the license comment and whitespace around it.
    const parsed = document.createElement('template');
    parsed.innerHTML = tool.icon;
    const svg = parsed.content.querySelector('svg')!;
    svg.setAttribute('class', 'h-4 w-4');
    svg.setAttribute('aria-hidden', 'true');
    button.append(svg);
    button.className =
      'p-1.5 rounded text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 aria-pressed:bg-neutral-200 aria-pressed:text-neutral-900';
    toolbar.append(button);
    return { tool, button };
  });

  const editor = new Editor({
    element: host,
    extensions: extensionsFor(profile),
    content: textarea.value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'prose prose-neutral max-w-none min-h-40 px-4 py-3 focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => {
      textarea.value = editor.getMarkdown();
    },
  });

  for (const { tool, button } of tools) {
    button.addEventListener('click', () => tool.run(editor, status));
  }
  const refresh = () => {
    for (const { tool, button } of tools) {
      if (tool.active) button.setAttribute('aria-pressed', String(tool.active(editor)));
    }
  };
  editor.on('transaction', refresh);
  refresh();

  const count = () => {
    if (limit === null) {
      // Nothing to count, but a message from a stopped submit is now stale.
      status.textContent = '';
      status.classList.remove('text-red-600');
      return;
    }
    const length = textarea.value.length;
    status.textContent = `${length.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}`;
    status.classList.toggle('text-red-600', length > limit);
  };
  editor.on('update', count);
  count();

  textarea.form?.addEventListener('submit', (event) => {
    const value = textarea.value;
    let problem: string | null = null;
    if (required && value.trim() === '') problem = "This can't be empty.";
    else if (limit !== null && value.length > limit) {
      const over = value.length - limit;
      problem = `This is ${over.toLocaleString('en-US')} character${over === 1 ? '' : 's'} over the limit.`;
    }
    if (problem === null) return;
    event.preventDefault();
    status.textContent = problem;
    status.classList.add('text-red-600');
    editor.commands.focus();
  });

  return { editor, textarea };
}

// A module script runs after the document is parsed, so every field exists.
// Under test the document is empty at import time and this finds nothing.
for (const textarea of document.querySelectorAll<HTMLTextAreaElement>('textarea[data-rich]')) {
  mountRichText(textarea);
}
