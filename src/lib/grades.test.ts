import { describe, expect, it } from 'vitest';
import {
  ADVANCING_GRADES,
  GRADES,
  gradePlural,
  isGrade,
  nextGrade,
  ROSTER_GRADE_ORDER,
  schoolYearLabel,
  schoolYearStart,
} from './grades';

describe('the grade ladder', () => {
  it('moves each student year up one and graduates seniors', () => {
    expect(nextGrade('Freshman')).toBe('Sophomore');
    expect(nextGrade('Sophomore')).toBe('Junior');
    expect(nextGrade('Junior')).toBe('Senior');
    expect(nextGrade('Senior')).toBe('Alumni');
  });

  it('leaves alumni and faculty where they are', () => {
    // Not "maps to itself": null is what the rollover skips on, so a faculty
    // member is never rewritten and never counted as advanced.
    expect(nextGrade('Alumni')).toBeNull();
    expect(nextGrade('Faculty')).toBeNull();
  });

  it('skips a grade it has never heard of rather than guessing', () => {
    expect(nextGrade('Postgraduate')).toBeNull();
    expect(nextGrade('')).toBeNull();
  });

  it('terminates: following the ladder always reaches a grade that stops', () => {
    for (const start of GRADES) {
      let grade: string = start;
      let steps = 0;
      while (nextGrade(grade) !== null) {
        grade = nextGrade(grade)!;
        expect(++steps).toBeLessThan(GRADES.length);
      }
      expect(grade).toMatch(/Alumni|Faculty/);
    }
  });

  it('advances exactly the four student years', () => {
    expect([...ADVANCING_GRADES]).toEqual(['Freshman', 'Sophomore', 'Junior', 'Senior']);
  });
});

describe('directory sections', () => {
  it('runs oldest to youngest, with faculty last and alumni absent', () => {
    expect([...ROSTER_GRADE_ORDER]).toEqual([
      'Senior',
      'Junior',
      'Sophomore',
      'Freshman',
      'Faculty',
    ]);
    // Alumni have their own page; listing them here would render them twice.
    expect(ROSTER_GRADE_ORDER).not.toContain('Alumni');
  });

  it('pluralises every grade, including the irregular one', () => {
    expect(gradePlural('Freshman')).toBe('Freshmen');
    expect(gradePlural('Senior')).toBe('Seniors');
    expect(gradePlural('Faculty')).toBe('Faculty');
    expect(gradePlural('Alumni')).toBe('Alumni');
  });

  it('passes through an unknown grade rather than dropping the heading', () => {
    expect(gradePlural('Everyone else')).toBe('Everyone else');
  });
});

describe('which school year a date falls in', () => {
  it('names the year by the calendar year it starts in', () => {
    expect(schoolYearStart(new Date('2026-09-15T00:00:00Z'))).toBe(2026);
    expect(schoolYearStart(new Date('2027-02-15T00:00:00Z'))).toBe(2026);
  });

  it('turns over in July, so the rollover can be run over the summer', () => {
    expect(schoolYearStart(new Date('2026-06-30T23:59:59Z'))).toBe(2025);
    expect(schoolYearStart(new Date('2026-07-01T00:00:00Z'))).toBe(2026);
  });

  it('labels a year as a span', () => {
    expect(schoolYearLabel(2026)).toBe('2026–2027');
  });
});

describe('the grade vocabulary', () => {
  it('accepts what is in use and rejects anything else', () => {
    expect(isGrade('Senior')).toBe(true);
    expect(isGrade('senior')).toBe(false);
    expect(isGrade('Postgraduate')).toBe(false);
  });
});
