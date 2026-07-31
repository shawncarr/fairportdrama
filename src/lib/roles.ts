/**
 * Display names for member roles, carried over from the Astro site's
 * roleDisplayNames map.
 *
 * Roles are stored as free strings rather than a database enum, so unknown
 * values are possible. Rather than rendering a raw `tech_crew`, an unrecognised
 * role is title-cased, which degrades to something readable instead of
 * something broken.
 */
const ROLE_DISPLAY_NAMES: Record<string, string> = {
  actor: 'Actor',
  tech_crew: 'Tech Crew',
  stage_manager: 'Stage Manager',
  director: 'Director',
  assistant_director: 'Assistant Director',
  choreographer: 'Choreographer',
  music_director: 'Music Director',
  music_pit: 'Music',
  costume: 'Costumes',
  lighting: 'Lighting',
  sound: 'Sound',
  set_design: 'Set Design',
  props: 'Props',
  makeup: 'Makeup',
  publicity: 'Publicity',
  officer: 'Club Officer',
};

export function roleDisplayName(role: string): string {
  return (
    ROLE_DISPLAY_NAMES[role] ??
    role
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}
