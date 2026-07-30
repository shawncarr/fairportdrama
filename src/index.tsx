import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import { baseLayout } from '~/layouts/BaseLayout';
import { actorMiddleware } from '~/middleware/actor';

const app = new Hono<AppEnv>();

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
