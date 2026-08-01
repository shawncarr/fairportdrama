/// <reference lib="dom" />
/**
 * @vitest-environment happy-dom
 */
// The DOM lib is enabled for this file only. The project targets workerd,
// where `document` does not exist, so adding it to tsconfig would let a Worker
// route reference browser globals and typecheck cleanly right up until it
// failed in production.
import { beforeEach, describe, expect, it } from 'vitest';
import { PhotoGallery } from './PhotoGallery';

/**
 * The lightbox is the only interactive JavaScript on the public site, so it is
 * exercised rather than merely rendered: the markup and the inline script are
 * both produced by this component, and nothing else would catch them drifting
 * apart - a renamed id would leave the grid looking perfect and clicking dead.
 */

const PHOTOS = [
  { thumbUrl: '/i/a/gallery', fullUrl: '/i/a/hero' },
  { thumbUrl: '/i/b/gallery', fullUrl: '/i/b/hero' },
  { thumbUrl: '/i/c/gallery', fullUrl: '/i/c/hero' },
];

/** Renders the component and runs its inline script, as a browser would. */
async function mount(photos = PHOTOS, title = "Charlotte's Web") {
  const markup = await (PhotoGallery({ photos, showTitle: title }) as unknown as {
    toString(): Promise<string> | string;
  }).toString();

  document.body.innerHTML = String(markup);

  // The script is run explicitly rather than by inserting a <script> element:
  // happy-dom does not evaluate injected scripts, and relying on it to would
  // make this test depend on the environment instead of on the component. The
  // source is the component's own output, so what runs here is what ships.
  const source = document.querySelector('script')?.textContent ?? '';
  if (source.trim().length === 0) throw new Error('gallery script did not render');
  new Function(source)();

  return {
    lightbox: document.getElementById('lightbox')!,
    image: document.getElementById('lightbox-image') as HTMLImageElement,
    counter: document.getElementById('lightbox-counter')!,
    triggers: Array.from(
      document.querySelectorAll('.gallery-trigger'),
    ) as HTMLButtonElement[],
    close: document.getElementById('lightbox-close')!,
    prev: document.getElementById('lightbox-prev')!,
    next: document.getElementById('lightbox-next')!,
  };
}

const isOpen = (lightbox: Element) => !lightbox.classList.contains('hidden');

const press = (key: string) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('rendering', () => {
  it('renders one trigger per photo', async () => {
    const el = await mount();
    expect(el.triggers).toHaveLength(3);
  });

  it('names no one in the alt text', async () => {
    const el = await mount();
    const alts = el.triggers.map((t) => t.querySelector('img')!.getAttribute('alt'));

    // Alt text is generated from title and position. A caption or a member
    // name here would rebuild the face-to-name link the visibility system
    // exists to break.
    expect(alts).toEqual([
      "Charlotte's Web production photo 1 of 3",
      "Charlotte's Web production photo 2 of 3",
      "Charlotte's Web production photo 3 of 3",
    ]);
  });

  it('renders nothing at all for an empty gallery', () => {
    expect(PhotoGallery({ photos: [], showTitle: 'x' })).toBeNull();
  });

  it('starts closed', async () => {
    const el = await mount();
    expect(isOpen(el.lightbox)).toBe(false);
  });
});

describe('opening', () => {
  it('opens on the photo that was clicked, not the first one', async () => {
    const el = await mount();
    el.triggers[1]!.click();

    expect(isOpen(el.lightbox)).toBe(true);
    expect(el.image.getAttribute('src')).toBe('/i/b/hero');
    expect(el.counter.textContent).toBe('2 / 3');
  });

  it('shows the full-size image, not the grid thumbnail', async () => {
    const el = await mount();
    el.triggers[0]!.click();
    expect(el.image.getAttribute('src')).toBe('/i/a/hero');
  });

  it('locks background scrolling while open', async () => {
    const el = await mount();
    el.triggers[0]!.click();
    expect(document.body.style.overflow).toBe('hidden');
  });
});

describe('navigating', () => {
  it('steps forward and back', async () => {
    const el = await mount();
    el.triggers[0]!.click();

    el.next.click();
    expect(el.counter.textContent).toBe('2 / 3');
    el.prev.click();
    expect(el.counter.textContent).toBe('1 / 3');
  });

  it('wraps at both ends rather than dead-ending', async () => {
    const el = await mount();
    el.triggers[0]!.click();

    el.prev.click();
    expect(el.counter.textContent).toBe('3 / 3');
    el.next.click();
    expect(el.counter.textContent).toBe('1 / 3');
  });

  it('moves with the arrow keys', async () => {
    const el = await mount();
    el.triggers[0]!.click();

    press('ArrowRight');
    expect(el.counter.textContent).toBe('2 / 3');
    press('ArrowLeft');
    expect(el.counter.textContent).toBe('1 / 3');
  });

  it('keeps the alt text in step with the image', async () => {
    const el = await mount();
    el.triggers[0]!.click();
    el.next.click();
    expect(el.image.getAttribute('alt')).toBe("Charlotte's Web production photo 2 of 3");
  });
});

describe('closing', () => {
  it('closes on the close button and restores scrolling', async () => {
    const el = await mount();
    el.triggers[0]!.click();
    el.close.click();

    expect(isOpen(el.lightbox)).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape', async () => {
    const el = await mount();
    el.triggers[0]!.click();
    press('Escape');
    expect(isOpen(el.lightbox)).toBe(false);
  });

  it('closes when the backdrop is clicked but not the image', async () => {
    const el = await mount();
    el.triggers[0]!.click();

    el.image.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isOpen(el.lightbox)).toBe(true);

    el.lightbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isOpen(el.lightbox)).toBe(false);
  });

  it('ignores arrow keys once closed, so the page does not react invisibly', async () => {
    const el = await mount();
    el.triggers[0]!.click();
    press('Escape');

    press('ArrowRight');
    expect(el.counter.textContent).toBe('1 / 3');
  });
});
