import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { formatShowDates, hasClosed } from './dates';

const perf = (date: string, time = '7:30 PM') => ({ date, time });

describe('formatShowDates', () => {
  it('returns an empty string when there are no performances', () => {
    expect(formatShowDates([])).toBe('');
  });

  it('formats a single performance as one date', () => {
    expect(formatShowDates([perf('2026-03-05')])).toBe('Mar 5, 2026');
  });

  it('condenses a run within one month', () => {
    expect(
      formatShowDates([perf('2026-03-05'), perf('2026-03-06'), perf('2026-03-07')]),
    ).toBe('March 5-7, 2026');
  });

  it('spans months when the run crosses a boundary', () => {
    expect(formatShowDates([perf('2026-02-27'), perf('2026-03-01')])).toBe(
      'Feb 27 - Mar 1, 2026',
    );
  });

  // Two performances on one evening and matinee day must not read as a range.
  it('collapses multiple performances on the same date', () => {
    expect(formatShowDates([perf('2026-03-05', '2:00 PM'), perf('2026-03-05')])).toBe(
      'Mar 5, 2026',
    );
  });

  it('does not depend on the input being sorted', () => {
    expect(formatShowDates([perf('2026-03-07'), perf('2026-03-05')])).toBe(
      'March 5-7, 2026',
    );
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
