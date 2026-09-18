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
  label: string;
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
  const href = entered.trim();
  if (safeUrl(href) === null) {
    status.textContent = LINK_RULE;
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

const TOOLS: Tool[] = [
  { label: 'Bold', profiles: BOTH, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { label: 'Italic', profiles: BOTH, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { label: 'Heading', profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
  { label: 'Subheading', profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive('heading', { level: 3 }) },
  { label: 'Bullets', profiles: BOTH, run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
  { label: 'Numbers', profiles: BOTH, run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { label: 'Quote', profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
  { label: 'Link', profiles: BOTH, run: promptForLink, active: (e) => e.isActive('link') },
  { label: 'Undo', profiles: BOTH, run: (e) => e.chain().focus().undo().run() },
  { label: 'Redo', profiles: BOTH, run: (e) => e.chain().focus().redo().run() },
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

  // A hidden required control blocks submit with a message nobody can see,
  // so the requirement is dropped here rather than enforced invisibly.
  textarea.hidden = true;
  textarea.required = false;

  const toolbar = document.createElement('div');
  toolbar.dataset.richToolbar = '';
  toolbar.className = 'flex flex-wrap gap-1 border-b border-neutral-200 p-1';
  frame.prepend(toolbar);

  const status = document.createElement('p');
  status.className = 'text-xs text-neutral-500 mt-1';
  status.setAttribute('aria-live', 'polite');
  frame.after(status);

  const tools = TOOLS.filter((t) => t.profiles.includes(profile)).map((tool) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tool.label;
    button.className =
      'px-2 py-1 text-sm rounded text-neutral-700 hover:bg-neutral-100 aria-pressed:bg-neutral-200 aria-pressed:text-neutral-900';
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

  return { editor, textarea };
}

// A module script runs after the document is parsed, so every field exists.
// Under test the document is empty at import time and this finds nothing.
for (const textarea of document.querySelectorAll<HTMLTextAreaElement>('textarea[data-rich]')) {
  mountRichText(textarea);
}
