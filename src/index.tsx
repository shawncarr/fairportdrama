import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import { baseLayout } from '~/layouts/BaseLayout';
import { actorMiddleware } from '~/middleware/actor';
import { createAuth } from '~/lib/auth';
import { home } from '~/routes/home';

const app = new Hono<AppEnv>();

// Auth routes are mounted before the actor middleware and the layout: they
// return JSON and redirects, not pages, and must not depend on a session they
// are in the middle of establishing.
app.all('/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));

app.use('*', actorMiddleware);
app.use('*', baseLayout);

app.route('/', home);

export default app;
