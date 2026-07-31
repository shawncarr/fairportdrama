import { DateTime } from 'luxon';

/** Performance dates are stored as bare ISO dates in the club's local zone. */
const ZONE = 'America/New_York';

export interface PerformanceLike {
  date: string;
  time: string;
}

/**
 * Condenses a run of performances into a single readable range.
 *
 *   one date          -> "Mar 5, 2026"
 *   same month        -> "March 5-7, 2026"
 *   spanning months   -> "Feb 27 - Mar 1, 2026"
 */
export function formatShowDates(performances: PerformanceLike[]): string {
  if (performances.length === 0) return '';

  const unique = [...new Set(performances.map((p) => p.date))].sort();
  const first = DateTime.fromISO(unique[0]!, { zone: ZONE });
  const last = DateTime.fromISO(unique[unique.length - 1]!, { zone: ZONE });

  if (unique.length === 1) return first.toLocaleString(DateTime.DATE_MED);
  if (first.month === last.month) {
    return `${first.toFormat('MMMM d')}-${last.toFormat('d, yyyy')}`;
  }
  return `${first.toFormat('MMM d')} - ${last.toFormat('MMM d, yyyy')}`;
}

export const formatDate = (iso: string): string =>
  DateTime.fromISO(iso, { zone: ZONE }).toLocaleString(DateTime.DATE_FULL);

/**
 * Whether a show's final performance is in the past.
 *
 * The Astro site relied on a hand-maintained `isCurrent` flag, which drifted:
 * the spring 2026 production stayed flagged current for months after closing.
 * Deriving it from the schedule is what stops that recurring.
 */
export function hasClosed(
  performances: PerformanceLike[],
  now: DateTime = DateTime.now(),
): boolean {
  if (performances.length === 0) return false;
  const last = performances.map((p) => p.date).sort().at(-1)!;
  return DateTime.fromISO(last, { zone: ZONE }).endOf('day') < now.setZone(ZONE);
}
