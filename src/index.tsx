import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import { baseLayout } from '~/layouts/BaseLayout';
import { actorMiddleware } from '~/middleware/actor';
import { createAuth } from '~/lib/auth';
import { home } from '~/routes/home';
import { showRoutes } from '~/routes/shows';
import { memberRoutes } from '~/routes/members';
import { miscRoutes } from '~/routes/misc';
import { apiRoutes } from '~/routes/api';
import { aboutRoutes } from '~/routes/about';
import { notFound, systemRoutes } from '~/routes/system';
import { adminRoutes } from '~/routes/admin';
import { adminCatalogRoutes } from '~/routes/admin-catalog';

const app = new Hono<AppEnv>();

// Auth routes are mounted before the actor middleware and the layout: they
// return JSON and redirects, not pages, and must not depend on a session they
// are in the middle of establishing.
app.all('/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));

app.use('*', actorMiddleware);

// After the actor middleware, not before. These endpoints are public and
// unauthenticated, but newsletter subscribe and unsubscribe are mutations, and
// every mutation is audited - which needs an actor. Mounted earlier they got
// `undefined` and the audit write threw.
app.route('/', apiRoutes);

app.route('/', adminRoutes);
app.route('/', adminCatalogRoutes);

app.use('*', baseLayout);

app.route('/', home);
app.route('/', showRoutes);
app.route('/', memberRoutes);
app.route('/', miscRoutes);
app.route('/', aboutRoutes);
app.route('/', systemRoutes);

app.notFound(notFound);

export default app;
