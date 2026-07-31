import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import { getDb, getNewsPost, getPublishedNews, getSpiritWear } from '~/db/queries';
import { IMAGE_VARIANT, imageUrl } from '~/lib/images';
import { formatDate } from '~/lib/dates';

export const miscRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- news

miscRoutes.get('/news', async (c) => {
  const posts = await getPublishedNews(getDb(c.env.DB));

  return c.render(
    <div class="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">News</h1>
      <p class="text-neutral-600 mb-10">
        Auditions, achievements, and updates from the Drama Club.
      </p>

      {posts.length === 0 ? (
        <p class="text-neutral-600">No news has been posted yet. Check back soon.</p>
      ) : (
        <div class="space-y-8">
          {posts.map((post) => (
            <article class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
              <time class="text-xs uppercase tracking-wide text-neutral-500">
                {formatDate(post.publishedAt)}
              </time>
              <h2 class="font-display text-xl font-semibold text-neutral-900 mt-2 mb-2">
                <a href={`/news/${post.id}`} class="hover:text-primary-600">
                  {post.title}
                </a>
              </h2>
              <p class="text-neutral-600">{post.excerpt}</p>
            </article>
          ))}
        </div>
      )}
    </div>,
    { title: 'News', description: 'News and announcements from the Fairport Drama Club.' },
  );
});

miscRoutes.get('/news/:slug', async (c) => {
  const post = await getNewsPost(getDb(c.env.DB), c.req.param('slug'));
  if (!post) return c.notFound();

  const image = imageUrl(post.featuredImageId, IMAGE_VARIANT.Hero);

  return c.render(
    <article class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-16">
      <a href="/news" class="text-sm text-primary-600 hover:text-primary-700">
        &larr; All news
      </a>

      <time class="block text-xs uppercase tracking-wide text-neutral-500 mt-6">
        {formatDate(post.publishedAt)}
      </time>
      <h1 class="font-display text-4xl font-bold text-neutral-900 mt-2 mb-6">
        {post.title}
      </h1>

      {image && <img src={image} alt="" class="w-full rounded-xl mb-8" />}

      {/* Markdown rendering is deferred: the news collection is empty, so
          there is no content to render and no way to verify a renderer
          against real posts yet. */}
      <div class="prose prose-neutral max-w-none whitespace-pre-wrap text-neutral-800">
        {post.bodyMd}
      </div>
    </article>,
    { title: post.title, description: post.excerpt, type: 'article', publishedDate: post.publishedAt },
  );
});

// ---------------------------------------------------------------- spirit wear

miscRoutes.get('/spiritwear', async (c) => {
  const items = await getSpiritWear(getDb(c.env.DB));

  return c.render(
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">Spirit Wear</h1>
      <p class="text-neutral-600 mb-10 max-w-2xl">
        Show your support. Proceeds go directly to funding our productions.
      </p>

      {items.length === 0 ? (
        <p class="text-neutral-600">No items are available right now.</p>
      ) : (
        <div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((item) => {
            const image = imageUrl(item.imageId, IMAGE_VARIANT.Gallery);
            return (
              <div class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-hidden">
                <div class="aspect-square bg-neutral-100">
                  {image && (
                    <img
                      src={image}
                      alt={item.name}
                      loading="lazy"
                      class="w-full h-full object-cover"
                    />
                  )}
                </div>
                <div class="p-4">
                  {item.isFeatured && (
                    <span class="inline-block mb-2 px-2 py-0.5 rounded-full bg-accent-100 text-accent-800 text-xs font-medium">
                      Featured
                    </span>
                  )}
                  <h2 class="font-medium text-neutral-900">{item.name}</h2>
                  <p class="text-sm text-neutral-600 mt-1">{item.description}</p>
                  <p class="font-display font-semibold text-primary-600 mt-3">
                    ${(item.priceCents / 100).toFixed(2)}
                  </p>
                  {item.sizes.length > 0 && (
                    <p class="text-xs text-neutral-500 mt-2">
                      Sizes: {item.sizes.join(', ')}
                    </p>
                  )}
                  {item.colors.length > 0 && (
                    <p class="text-xs text-neutral-500">Colors: {item.colors.join(', ')}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>,
    { title: 'Spirit Wear', description: 'Fairport Drama Club apparel and accessories.' },
  );
});
