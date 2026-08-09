import { jsxRenderer } from 'hono/jsx-renderer';
import { html, raw } from 'hono/html';
import { Header } from '~/components/Header';
import { Footer } from '~/components/Footer';
import { newsletterScript } from '~/components/NewsletterForm';
import {
  DEFAULT_OG_IMAGE,
  SITE_DESCRIPTION,
  SITE_NAME,
  organizationSchema,
} from '~/lib/seo';

declare module 'hono' {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: {
        title?: string;
        description?: string;
        image?: string;
        type?: 'website' | 'article' | 'event';
        publishedDate?: string;
        modifiedDate?: string;
      },
    ): Response;
  }
}

export const baseLayout = jsxRenderer(({ children, ...props }, c) => {
  const title = props.title ?? 'Home';
  const description = props.description ?? SITE_DESCRIPTION;
  const image = props.image ?? DEFAULT_OG_IMAGE;
  const type = props.type ?? 'website';

  const siteUrl = c.env.SITE_URL;
  const canonical = new URL(new URL(c.req.url).pathname, siteUrl).toString();
  // Omitted rather than emitted as a broken URL when there is no image.
  const fullImageUrl = image ? new URL(image, siteUrl).toString() : null;
  const fullTitle = `${title} | ${SITE_NAME}`;

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="canonical" href={canonical} />

        <title>{fullTitle}</title>
        <meta name="title" content={fullTitle} />
        <meta name="description" content={description} />

        <meta property="og:type" content={type === 'article' ? 'article' : 'website'} />
        <meta property="og:url" content={canonical} />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={description} />
        {fullImageUrl && <meta property="og:image" content={fullImageUrl} />}
        <meta property="og:site_name" content={SITE_NAME} />
        {props.publishedDate && (
          <meta property="article:published_time" content={props.publishedDate} />
        )}
        {props.modifiedDate && (
          <meta property="article:modified_time" content={props.modifiedDate} />
        )}

        <meta
          property="twitter:card"
          content={fullImageUrl ? 'summary_large_image' : 'summary'}
        />
        <meta property="twitter:url" content={canonical} />
        <meta property="twitter:title" content={fullTitle} />
        <meta property="twitter:description" content={description} />
        {fullImageUrl && <meta property="twitter:image" content={fullImageUrl} />}

        <script type="application/ld+json">
          {raw(JSON.stringify(organizationSchema(siteUrl)))}
        </script>

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@600;700;800&display=swap"
          rel="stylesheet"
        />

        <link rel="stylesheet" href="/static/global.css" />
      </head>
      <body class="min-h-screen flex flex-col">
        <a href="#main-content" class="skip-link">
          Skip to main content
        </a>

        <Header path={new URL(c.req.url).pathname} />

        <main id="main-content" class="flex-1">
          {children}
        </main>

        <Footer year={new Date().getUTCFullYear()} />

        {newsletterScript()}
      </body>
    </html>
  );
});

/**
 * `html` is re-exported so page-level inline scripts can be written without
 * dangerouslySetInnerHTML, matching how the Astro site used `is:inline`.
 */
export { html };
