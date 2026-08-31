import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { formatDateRange, hasClosed, showDateLine } from './dates';

const perf = (date: string, time = '7:30 PM') => ({ date, time });

describe('formatDateRange', () => {
  it('collapses a single date', () => {
    expect(formatDateRange('2026-03-05', '2026-03-05')).toBe('Mar 5, 2026');
  });

  it('keeps one month name when the run does not cross months', () => {
    expect(formatDateRange('2026-03-05', '2026-03-07')).toBe('March 5-7, 2026');
  });

  it('names both months when the run crosses one', () => {
    expect(formatDateRange('2026-02-27', '2026-03-01')).toBe('Feb 27 - Mar 1, 2026');
  });
});

describe('hasClosed', () => {
  const now: DateTime = DateTime.fromISO('2026-07-31T12:00:00', {
    zone: 'America/New_York',
  });

  it('is true once the final performance has passed', () => {
    expect(hasClosed([perf('2026-03-05'), perf('2026-03-07')], now)).toBe(true);
  });

  it('is false for a run still to come', () => {
    expect(hasClosed([perf('2026-11-13'), perf('2026-11-15')], now)).toBe(false);
  });

  // A show is still running on its closing night, not closed at midnight.
  it('is false during the final performance day itself', () => {
    expect(hasClosed([perf('2026-07-31')], now)).toBe(false);
  });

  it('is false when no performances are scheduled', () => {
    expect(hasClosed([], now)).toBe(false);
  });

  // The actual production data: flagged current, but closed months ago.
  it('detects the stale current-show flag on the real dataset', () => {
    const lightningThief = [perf('2026-03-05'), perf('2026-03-06'), perf('2026-03-07')];
    expect(hasClosed(lightningThief, now)).toBe(true);
  });
});

describe('showDateLine', () => {
  it('formats a range from the projected endpoints', () => {
    expect(showDateLine('2026-03-05', '2026-03-07')).toBe('March 5-7, 2026');
  });

  it('says so when a show has no dates yet', () => {
    expect(showDateLine(null, null)).toBe('Dates to be announced');
  });
});
