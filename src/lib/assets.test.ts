import { describe, expect, it } from 'vitest';
import { organizationSchema } from './seo';
// Imported through the bundler rather than read with node:fs. The project
// targets workerd and deliberately has no node types: adding them so a test
// could stat a file would also let a Worker route reference node APIs and
// typecheck cleanly right up until it failed in production.
import favicon from '../../public/favicon.svg?raw';

/**
 * Static files the markup promises.
 *
 * The favicon was left behind in the move off Astro: every page linked
 * /favicon.svg and nothing served it, which shows as a blank browser tab
 * rather than as an error anywhere. The import itself is the existence check -
 * if the file goes missing, this module fails to resolve.
 */

describe('the favicon', () => {
  it('is a real image rather than a placeholder', () => {
    // og-default.jpg turned out to be eleven bytes of the word "placeholder",
    // so the size is worth asserting alongside the shape.
    expect(favicon.length).toBeGreaterThan(200);
    expect(favicon).toContain('<svg');
  });
});

describe('structured data', () => {
  it('claims no logo, since there is no logo file to claim', () => {
    const schema = organizationSchema('https://fairportdrama.com') as Record<string, unknown>;

    // It used to point at /images/logo.png, which never existed in either this
    // project or the Astro site it was copied from. Restoring the property
    // without adding the file would put a 404 back into the markup that every
    // crawler reads.
    expect(schema).not.toHaveProperty('logo');
  });
});
