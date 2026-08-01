import { html, raw } from 'hono/html';

export interface GalleryPhoto {
  /** Grid thumbnail. */
  thumbUrl: string;
  /** Larger image shown in the lightbox. */
  fullUrl: string;
}

/**
 * Production photo grid with a lightbox.
 *
 * Ported from the Astro component. Alt text is generated from the show title
 * and position - there are deliberately no captions and no names, because
 * naming who is in a photo would rebuild exactly the link between a face and a
 * student that the member visibility system exists to break.
 *
 * The script is inline and self-contained. It replaces the Astro version's
 * `astro:after-swap` listener with `pageswap`, since cross-document view
 * transitions re-run scripts on the new document anyway.
 */
export function PhotoGallery({
  photos,
  showTitle,
}: {
  photos: GalleryPhoto[];
  showTitle: string;
}) {
  if (photos.length === 0) return null;

  const alt = (i: number) => `${showTitle} production photo ${i + 1} of ${photos.length}`;

  return (
    <div class="photo-gallery">
      <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
        {photos.map((photo, i) => (
          <button
            type="button"
            class="gallery-trigger aspect-square rounded-lg overflow-hidden bg-neutral-200 hover:opacity-90 transition-opacity cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
            data-full={photo.fullUrl}
            data-index={i}
            aria-label={`View ${alt(i)}`}
          >
            <img
              src={photo.thumbUrl}
              alt={alt(i)}
              loading="lazy"
              class="w-full h-full object-cover"
            />
          </button>
        ))}
      </div>

      <div
        id="lightbox"
        class="fixed inset-0 z-50 hidden items-center justify-center bg-black/90 p-4"
        role="dialog"
        aria-modal="true"
        aria-label={`${showTitle} photo gallery`}
        tabindex={-1}
      >
        <button
          type="button"
          id="lightbox-close"
          class="absolute top-4 right-4 text-white text-3xl leading-none w-11 h-11 rounded-full hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white"
          aria-label="Close gallery"
        >
          &times;
        </button>
        <button
          type="button"
          id="lightbox-prev"
          class="absolute left-4 text-white text-4xl leading-none w-11 h-11 rounded-full hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white"
          aria-label="Previous photo"
        >
          &lsaquo;
        </button>
        <img id="lightbox-image" src="" alt="" class="max-h-[85vh] max-w-full object-contain" />
        <button
          type="button"
          id="lightbox-next"
          class="absolute right-4 text-white text-4xl leading-none w-11 h-11 rounded-full hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white"
          aria-label="Next photo"
        >
          &rsaquo;
        </button>
        <div
          id="lightbox-counter"
          class="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm"
        />
      </div>

      {html`
        <script>
          (function () {
            var gallery = document.querySelector('.photo-gallery');
            if (!gallery) return;

            var lightbox = document.getElementById('lightbox');
            var image = document.getElementById('lightbox-image');
            var counter = document.getElementById('lightbox-counter');
            var triggers = Array.prototype.slice.call(
              gallery.querySelectorAll('.gallery-trigger')
            );
            var sources = triggers.map(function (t) { return t.dataset.full; });
            var titles = ${raw(JSON.stringify(photos.map((_, i) => alt(i))))};
            var index = 0;
            var opener = null;

            function render() {
              image.src = sources[index];
              image.alt = titles[index];
              counter.textContent = index + 1 + ' / ' + sources.length;
            }

            function open(i) {
              index = i;
              opener = triggers[i];
              render();
              lightbox.classList.remove('hidden');
              lightbox.classList.add('flex');
              document.body.style.overflow = 'hidden';
              lightbox.focus();
            }

            function close() {
              lightbox.classList.add('hidden');
              lightbox.classList.remove('flex');
              document.body.style.overflow = '';
              // Focus goes back where it came from, so keyboard users are not
              // dropped at the top of the document.
              if (opener) opener.focus();
            }

            function step(by) {
              index = (index + by + sources.length) % sources.length;
              render();
            }

            triggers.forEach(function (trigger, i) {
              trigger.addEventListener('click', function () { open(i); });
            });

            document.getElementById('lightbox-close').addEventListener('click', close);
            document.getElementById('lightbox-prev').addEventListener('click', function () { step(-1); });
            document.getElementById('lightbox-next').addEventListener('click', function () { step(1); });

            lightbox.addEventListener('click', function (e) {
              if (e.target === lightbox) close();
            });

            document.addEventListener('keydown', function (e) {
              if (lightbox.classList.contains('hidden')) return;
              if (e.key === 'Escape') close();
              if (e.key === 'ArrowLeft') step(-1);
              if (e.key === 'ArrowRight') step(1);
            });
          })();
        </script>
      `}
    </div>
  );
}
