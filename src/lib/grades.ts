/**
 * Grades, and what happens to them when the school year turns over.
 *
 * `members.grade` describes the present, so it goes stale on its own every
 * June - the roster carried 2025-2026 grades well into the following August.
 * There is no graduation year to derive it from (the column is empty for all
 * but one member), so the grade stays hand-maintained and the rollover is one
 * deliberate action instead of 128 edits.
 */
/** The grades already in use, plus the two non-student values. */
export const GRADES = [
  'Freshman',
  'Sophomore',
  'Junior',
  'Senior',
  'Alumni',
  'Faculty',
] as const;

export type Grade = (typeof GRADES)[number];

export const isGrade = (v: string): v is Grade => (GRADES as readonly string[]).includes(v);

/** Section order on the public directory. Alumni have their own page. */
export const ROSTER_GRADE_ORDER: readonly Grade[] = [
  'Senior',
  'Junior',
  'Sophomore',
  'Freshman',
  'Faculty',
];

const PLURALS: Record<Grade, string> = {
  Freshman: 'Freshmen',
  Sophomore: 'Sophomores',
  Junior: 'Juniors',
  Senior: 'Seniors',
  Alumni: 'Alumni',
  Faculty: 'Faculty',
};

export const gradePlural = (grade: string): string =>
  PLURALS[grade as Grade] ?? grade;

/**
 * Where each grade goes when the year advances.
 *
 * Alumni and Faculty are deliberately absent rather than mapped to themselves:
 * a missing entry means "not a student year, leave alone", which is also what
 * makes a grade the roster has never seen safe to skip.
 */
const NEXT_GRADE: Partial<Record<Grade, Grade>> = {
  Freshman: 'Sophomore',
  Sophomore: 'Junior',
  Junior: 'Senior',
  Senior: 'Alumni',
};

export const nextGrade = (grade: string): Grade | null =>
  NEXT_GRADE[grade as Grade] ?? null;

/** Grades the rollover would move, in the order they are displayed. */
export const ADVANCING_GRADES: readonly Grade[] = GRADES.filter((g) => nextGrade(g) !== null);

/**
 * The school year a date falls in, named by the calendar year it starts in:
 * August 2026 and February 2027 are both the 2026-2027 year.
 *
 * July is the cutoff rather than September so that the rollover can be run
 * over the summer, before anyone is back in the building.
 */
export function schoolYearStart(now: Date): number {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? year : year - 1;
}

export const schoolYearLabel = (start: number): string => `${start}–${start + 1}`;
