import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import { baseLayout } from '~/layouts/BaseLayout';
import { actorMiddleware } from '~/middleware/actor';
import { createAuth } from '~/lib/auth';

const app = new Hono<AppEnv>();

// Auth routes are mounted before the actor middleware and the layout: they
// return JSON and redirects, not pages, and must not depend on a session they
// are in the middle of establishing.
app.all('/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));

app.use('*', actorMiddleware);
app.use('*', baseLayout);

app.get('/', (c) =>
  c.render(
    <section class="mx-auto max-w-3xl px-4 py-16">
      <h1 class="font-display text-4xl text-primary-600">Fairport Drama Club</h1>
      <p class="mt-4 text-neutral-700">
        Scaffold is live. Pages are ported in sequence from the archived Astro
        site.
      </p>
    </section>,
    { title: 'Home' },
  ),
);

export default app;
