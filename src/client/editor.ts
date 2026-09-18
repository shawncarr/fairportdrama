/// <reference lib="dom" />
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
    // `after` collides with the HTMLRewriter `Element` type this project also
    // has in global scope; `insertAdjacentElement` is DOM-only, so it does not.
    textarea.insertAdjacentElement('afterend', note);
    return null;
  }

  const frame = document.createElement('div');
  frame.className =
    'rounded-lg border border-neutral-300 bg-white focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500';
  const host = document.createElement('div');
  frame.appendChild(host);
  textarea.insertAdjacentElement('afterend', frame);

  // A hidden required control blocks submit with a message nobody can see,
  // so the requirement is dropped here rather than enforced invisibly.
  textarea.hidden = true;
  textarea.required = false;

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

  return { editor, textarea };
}

// A module script runs after the document is parsed, so every field exists.
// Under test the document is empty at import time and this finds nothing.
for (const textarea of document.querySelectorAll<HTMLTextAreaElement>('textarea[data-rich]')) {
  mountRichText(textarea);
}
