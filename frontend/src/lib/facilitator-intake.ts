/**
 * The option lists behind the facilitator application form.
 *
 * Kept here rather than inline in the form for one specific reason: the three
 * support tracks are also the three cards on the "work with Hilom" marketing
 * page. Those two lists must say the same thing — an applicant who ticks
 * "Build & Launch" because of what the marketing page promised, and then finds
 * the form describing something else, has been misled by a copy-paste. One
 * source, rendered twice.
 *
 * Slugs are the stored value and are load-bearing: they are written to
 * `facilitators.support_needed` / `.program_status` and validated against the
 * matching allowlists in backend/src/lib/facilitator-input.ts. Labels and
 * blurbs are copy and can change freely; **slugs cannot** without a migration
 * of existing rows. Changing one is a data change, not a text change.
 */

export type SupportTrack = 'design' | 'build_launch' | 'live_experiences';

export interface SupportTrackOption {
  value: SupportTrack;
  /** The "01" / "02" / "03" on the marketing cards. */
  number: string;
  name: string;
  /** The applicant-voice headline: "I want to bring my course online." */
  question: string;
  includes: string[];
  bestFor: string;
  /** Engagement shape and commercials, shown in bold under each card. */
  commercials: string;
}

export const SUPPORT_TRACKS: SupportTrackOption[] = [
  {
    value: 'design',
    number: '01',
    name: 'Design with Hilom',
    question: 'I need help shaping my expertise into a learning experience.',
    includes: [
      'Clarity Session',
      'Course Blueprint + Design Matrix',
      'Learning Design / Content Review',
      'LMS Build / Setup',
    ],
    bestFor:
      'Facilitators who want Hilom’s L&D expertise but will execute or deliver the program themselves.',
    commercials: 'Fee-for-service',
  },
  {
    value: 'build_launch',
    number: '02',
    name: 'Build & Launch with Hilom',
    question: 'I want to bring my course online.',
    includes: [
      'Commercial viability check',
      'Course architecture + Design Matrix',
      'Instructional design + content review',
      'Standard LMS build + QA',
      'Pricing + launch support',
      'Monthly performance review',
    ],
    bestFor:
      'Facilitators who want Hilom as their learning and platform partner from development through launch and growth.',
    commercials: '6-week development journey · 6-month minimum partnership',
  },
  {
    value: 'live_experiences',
    number: '03',
    name: 'Create Live Experiences',
    question: 'I want to create a workshop or retreat.',
    includes: [
      'Experience concept + participant outcomes',
      'Program flow + activities',
      'Venue + costing support',
      'Pricing + registration',
      'Launch + marketing support',
      'GO / NO-GO + operations',
      'Post-event review',
    ],
    bestFor:
      'Facilitators who want to turn their practice into repeatable workshops, retreats, or live experiences.',
    commercials: 'Workshops: 6+ weeks · Retreats: 8–12+ weeks',
  },
];

export type ProgramStatus =
  | 'existing_program_online'
  | 'idea_to_course'
  | 'workshop_live'
  | 'retreat'
  | 'scale_existing'
  | 'not_sure';

export interface ProgramStatusOption {
  value: ProgramStatus;
  label: string;
  /** Rendered under the label — this is what makes the options distinguishable. */
  detail: string;
}

export const PROGRAM_STATUSES: ProgramStatusOption[] = [
  {
    value: 'existing_program_online',
    label: 'I have an existing program and want to put it online.',
    detail:
      'Turn an existing workshop, framework, or program into a structured self-paced course.',
  },
  {
    value: 'idea_to_course',
    label: 'I have an idea and want help developing it into a course.',
    detail: 'Build the learning structure, content flow, activities, and assessments with Hilom.',
  },
  {
    value: 'workshop_live',
    label: 'I want to create a workshop or live experience.',
    detail: 'Develop a virtual or face-to-face workshop from concept through launch.',
  },
  {
    value: 'retreat',
    label: 'I want to create a retreat.',
    detail:
      'Develop a more immersive experience including program design, venue, costing, participant journey, and launch.',
  },
  {
    value: 'scale_existing',
    label: 'I already have a workshop/program and want help bringing it to more people.',
    detail:
      'Hilom helps assess how it could be repeated, packaged, marketed, or offered to corporate, academic, or community audiences.',
  },
  {
    value: 'not_sure',
    label: 'I’m not sure yet — I want Hilom’s recommendation.',
    detail:
      'We look at your expertise, audience, existing materials, and goals and recommend the strongest starting point.',
  },
];

export type ContactMethod = 'email' | 'phone' | 'instagram' | 'whatsapp';

export const CONTACT_METHODS: { value: ContactMethod; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'instagram', label: 'Instagram DM' },
  { value: 'whatsapp', label: 'WhatsApp' },
];

/** Which contact methods need a phone number before the form will submit. */
export const CONTACT_METHODS_NEEDING_PHONE = new Set<ContactMethod>(['phone', 'whatsapp']);

export type YearsExperience = 'under_1' | '1_3' | '3_5' | '5_plus';

export const YEARS_EXPERIENCE: { value: YearsExperience; label: string }[] = [
  { value: 'under_1', label: 'Less than 1 year' },
  { value: '1_3', label: '1–3 years' },
  { value: '3_5', label: '3–5 years' },
  { value: '5_plus', label: '5+ years' },
];

export type ReferralSource =
  | 'instagram'
  | 'friend_colleague'
  | 'hilom_facilitator'
  | 'event_workshop'
  | 'search'
  | 'other';

/**
 * `other` carries a free-text box.
 *
 * The alternative — a plain text field — was rejected because the first real
 * application answered this with a person's name, and a column of names cannot
 * be counted. A select keeps the common answers aggregatable while still
 * giving "Veronica sent me" somewhere to go.
 */
export const REFERRAL_SOURCES: { value: ReferralSource; label: string }[] = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'friend_colleague', label: 'A friend or colleague' },
  { value: 'hilom_facilitator', label: 'A Hilom facilitator' },
  { value: 'event_workshop', label: 'An event or workshop' },
  { value: 'search', label: 'Search' },
  { value: 'other', label: 'Other' },
];

/**
 * What happens after an application is submitted.
 *
 * Shown on the thank-you screen, and lifted from the "What happens after
 * today" section of Hilom's facilitator deck so that someone who saw the deck
 * and someone who only ever saw the website are told the same three outcomes,
 * in the same order, in the same words.
 *
 * The third one is deliberately not softened. "Not right now" is a real
 * outcome, and an applicant who is told up front that it exists is not left
 * reading silence as a yes.
 */
export const NEXT_STEPS: { number: string; name: string; detail: string }[] = [
  {
    number: '01',
    name: 'Proceed',
    detail:
      'There’s a strong fit. We’ll confirm the pathway, partnership terms, and schedule Kick-Off.',
  },
  {
    number: '02',
    name: 'Develop further',
    detail:
      'There’s potential, but the offering needs more clarity or development before Kick-Off.',
  },
  {
    number: '03',
    name: 'Not right now',
    detail: 'The opportunity may not be the right fit or timing for Hilom today.',
  },
];

/** The happy path, as a single line. */
export const NEXT_STEPS_PATHWAY = 'Proceed → Agreement → Kick-Off';

export const NEXT_STEPS_CLOSING =
  'Whatever the next step, we want it to be thoughtful, clear, and valuable for both you and the Collective.';

/** Labels for the admin review screen, which stores slugs and shows words. */
export const labelFor = <T extends string>(
  options: { value: T; label?: string; name?: string }[],
  value: T | null | undefined,
): string => {
  if (!value) return '—';
  const found = options.find((o) => o.value === value);
  return found?.label ?? found?.name ?? value;
};
