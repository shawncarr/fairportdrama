import { describe, expect, it } from 'vitest';
import { SHOW_COMPANY, SHOW_COMPANY_LABEL } from '~/db/schema/content';

describe('show companies', () => {
  it('gives every company a display label', () => {
    for (const slug of Object.values(SHOW_COMPANY)) {
      expect(SHOW_COMPANY_LABEL[slug]).toBeTruthy();
    }
  });

  it('never leaks a slug as display text', () => {
    for (const [slug, label] of Object.entries(SHOW_COMPANY_LABEL)) {
      expect(label).not.toBe(slug);
    }
  });
});
