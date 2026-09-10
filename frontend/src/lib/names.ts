/**
 * How to address a facilitator by their short name.
 *
 * `display_name` is a single free-text field, so the first word is not always
 * the name someone answers to: "Miss Kayce" is billed that way but is Kayce to
 * her clients, and the same goes for "Dr.", "Coach", "Ate", "Kuya". Greeting
 * her as "Miss" is worse than using the full name, so honorifics are dropped
 * before the first word is taken.
 *
 * The list is deliberately closed. Guessing at anything beyond a known
 * honorific risks eating a real first name, and being over-formal is a much
 * cheaper mistake than calling someone by a title.
 */
const HONORIFICS = new Set([
  'miss',
  'ms',
  'mrs',
  'mr',
  'mx',
  'dr',
  'doc',
  'prof',
  'professor',
  'sir',
  'madam',
  'ma’am',
  "ma'am",
  'coach',
  'chef',
  'atty',
  'engr',
  'rev',
  'fr',
  'ate',
  'kuya',
  'tita',
  'tito',
  'teacher',
  'tchr',
]);

/**
 * The name to use mid-sentence — "Kayce", not "Miss".
 *
 * `override` is the facilitator's own `short_name` (0042): when they have set
 * one it wins outright, and the heuristic below is only the fallback for the
 * rows — the large majority — that leave it blank.
 */
export function shortName(displayName: string, override?: string | null): string {
  const chosen = override?.trim();
  if (chosen) return chosen;

  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return displayName;

  // Only ever strip a leading honorific, and never the last word: "Miss Kayce"
  // becomes "Kayce", but someone whose whole display name is "Coach" stays
  // "Coach" rather than becoming an empty greeting.
  const isHonorific = (w: string) => HONORIFICS.has(w.toLowerCase().replace(/\.$/, ''));
  let i = 0;
  while (i < words.length - 1 && isHonorific(words[i] as string)) i++;

  return words[i] as string;
}
