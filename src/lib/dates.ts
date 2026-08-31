import { DateTime } from 'luxon';

/** Performance dates are stored as bare ISO dates in the club's local zone. */
const ZONE = 'America/New_York';

export interface PerformanceLike {
  date: string;
  time: string;
}

/**
 * A run's dates, from its endpoints.
 *
 *   one date          -> "Mar 5, 2026"
 *   same month        -> "March 5-7, 2026"
 *   spanning months   -> "Feb 27 - Mar 1, 2026"
 *
 * Takes two dates rather than a schedule because the show cards render from
 * columns projected by the query, not from a per-card performance fetch.
 */
export function formatDateRange(first: string, last: string): string {
  const a = DateTime.fromISO(first, { zone: ZONE });
  const b = DateTime.fromISO(last, { zone: ZONE });

  if (first === last) return a.toLocaleString(DateTime.DATE_MED);
  if (a.month === b.month) return `${a.toFormat('MMMM d')}-${b.toFormat('d, yyyy')}`;
  return `${a.toFormat('MMM d')} - ${b.toFormat('MMM d, yyyy')}`;
}

/** A show announced before its schedule is locked still needs a date line. */
export const DATES_TBA = 'Dates to be announced';

export const showDateLine = (first: string | null, last: string | null): string =>
  first && last ? formatDateRange(first, last) : DATES_TBA;

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
