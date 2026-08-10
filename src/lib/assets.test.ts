import { describe, expect, it } from 'vitest';
import { organizationSchema } from './seo';
// Imported through the bundler rather than read with node:fs. The project
// targets workerd and deliberately has no node types: adding them so a test
// could stat a file would also let a Worker route reference node APIs and
// typecheck cleanly right up until it failed in production.
import favicon from '../../public/favicon.svg?raw';
import logo from '../../public/images/logo.png?raw';

/**
 * Static files the markup promises.
 *
 * The favicon was left behind in the move off Astro: every page linked
 * /favicon.svg and nothing served it, which shows as a blank browser tab
 * rather than as an error anywhere. The structured data made the same promise
 * about a logo that had never existed in either project. The import is the
 * existence check - if a file goes missing, this module fails to resolve.
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
  it('claims a logo', () => {
    const schema = organizationSchema('https://fairportdrama.com') as { logo?: string };
    expect(schema.logo).toBe('https://fairportdrama.com/images/logo.png');
  });

  it('claims one that is actually shipped', () => {
    // The property previously pointed at a file that did not exist, so the
    // markup every crawler reads advertised a 404. Claiming and shipping are
    // asserted together because separately either one looks fine.
    expect(logo.length).toBeGreaterThan(1000);
  });
});
