/**
 * Pre-session intake forms: the question definitions a facilitator writes, and
 * the answers a client gives (0032).
 *
 * Split out from `facilitator-input.ts` because both halves live here and they
 * have to agree. The definition side is written by a facilitator on their
 * service editor; the answer side is written by a client at booking time and
 * again if they come back to edit it. A "required" that the definition means
 * and the answering path does not enforce is worse than no required at all —
 * the facilitator believes they have screened someone they have not.
 *
 * Answers carry a copy of the label they were answering. See 0032: an answered
 * intake is a document, and a facilitator rewriting their form next month must
 * not retroactively change what a client was asked.
 */
import { stripTags } from './sanitize.js';

export class IntakeError extends Error {}

export const INTAKE_QUESTION_TYPES = ['text', 'longtext', 'choice', 'checkbox'] as const;
export type IntakeQuestionType = (typeof INTAKE_QUESTION_TYPES)[number];

export interface IntakeQuestion {
  /**
   * Stable within one service's form, and the key an answer joins on. Assigned
   * by the editor rather than by position, so inserting a question above
   * another does not silently re-point every answer already given.
   */
  id: string;
  label: string;
  /** Optional clarification shown under the field. */
  help: string | null;
  type: IntakeQuestionType;
  required: boolean;
  /** Only meaningful for `choice`. */
  options: string[];
}

export interface IntakeAnswer {
  id: string;
  /** The question as it was asked, snapshotted. */
  label: string;
  value: string;
}

/** Deliberately small. An intake is a screening form, not a survey. */
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 12;
const MAX_ANSWER_LENGTH = 2000;

/** Slug-ish, so an id is readable in a stored answer document. */
function questionId(value: unknown, index: number): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const cleaned = raw.replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  // Positional only as a last resort — see the note on `id` above for why
  // position is a poor identity.
  return cleaned || `q${index + 1}`;
}

/**
 * Validates a facilitator's form definition.
 *
 * Rejects rather than repairs, with two exceptions that are corrections rather
 * than changes of meaning: a duplicate id is suffixed (two questions sharing an
 * id would make one of them unanswerable), and options are dropped for types
 * that have none.
 */
export function validateIntakeQuestions(value: unknown): IntakeQuestion[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new IntakeError('Intake questions must be a list');
  if (value.length > MAX_QUESTIONS) {
    throw new IntakeError(`An intake form can have at most ${MAX_QUESTIONS} questions`);
  }

  const seen = new Set<string>();

  return value.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;

    const label = typeof item.label === 'string' ? stripTags(item.label).trim() : '';
    if (!label) throw new IntakeError('Every intake question needs a label');
    if (label.length > 200) throw new IntakeError('An intake question is too long (max 200)');

    const type = typeof item.type === 'string' ? item.type : 'text';
    if (!(INTAKE_QUESTION_TYPES as readonly string[]).includes(type)) {
      throw new IntakeError(`Unknown intake question type "${type}"`);
    }

    let id = questionId(item.id, index);
    // Suffixed rather than rejected: ids are generated from labels in the
    // editor, so two questions called "Anything else?" collide through no
    // fault of the person typing them.
    while (seen.has(id)) id = `${id.slice(0, 36)}-${seen.size + 1}`;
    seen.add(id);

    const options =
      type === 'choice'
        ? (Array.isArray(item.options) ? item.options : [])
            .map((option) => (typeof option === 'string' ? stripTags(option).trim().slice(0, 120) : ''))
            .filter(Boolean)
            .slice(0, MAX_OPTIONS)
        : [];

    if (type === 'choice' && options.length < 2) {
      throw new IntakeError(`"${label}" is a multiple-choice question, so it needs at least two options`);
    }

    return {
      id,
      label,
      help: typeof item.help === 'string' && item.help.trim() ? stripTags(item.help).trim().slice(0, 300) : null,
      type: type as IntakeQuestionType,
      required: item.required === true,
      options,
    };
  });
}

/**
 * Validates a client's answers against the form as it stands.
 *
 * Driven by the *questions*, not by the submitted body: anything the client
 * sends that does not correspond to a question is discarded rather than
 * stored, so the answer document cannot be used as arbitrary storage on
 * someone else's booking, and cannot accumulate answers to questions that no
 * longer exist.
 *
 * `enforceRequired` is false when a booking is being made without the form
 * having been shown — a facilitator entering a client by hand, say. Blocking
 * that booking on questions nobody was asked would make the intake a reason
 * sessions cannot be created, which is not what it is for; the booking is
 * simply recorded as having no intake yet.
 */
export function validateIntakeAnswers(
  questions: IntakeQuestion[],
  value: unknown,
  enforceRequired = true,
): IntakeAnswer[] {
  const submitted = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const item = (entry ?? {}) as Record<string, unknown>;
      if (typeof item.id !== 'string') continue;
      submitted.set(item.id, typeof item.value === 'string' ? item.value : '');
    }
  } else if (value && typeof value === 'object') {
    // Also accept a plain { questionId: answer } object, which is the shape a
    // form naturally produces.
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      submitted.set(key, typeof entry === 'string' ? entry : entry === true ? 'yes' : entry === false ? 'no' : '');
    }
  }

  const answers: IntakeAnswer[] = [];

  for (const question of questions) {
    const raw = (submitted.get(question.id) ?? '').trim();

    let cleaned = stripTags(raw).slice(0, MAX_ANSWER_LENGTH);

    if (question.type === 'checkbox') {
      // Anything truthy-looking is a yes; everything else, including an
      // unchecked box that submits nothing at all, is a no. A checkbox has no
      // "unanswered" state to represent.
      cleaned = /^(yes|true|on|1|checked)$/i.test(cleaned) ? 'yes' : 'no';
    } else if (question.type === 'choice' && cleaned && !question.options.includes(cleaned)) {
      throw new IntakeError(`"${cleaned}" is not one of the options for "${question.label}"`);
    }

    const isBlank = question.type === 'checkbox' ? cleaned === 'no' : cleaned === '';

    if (enforceRequired && question.required && isBlank) {
      throw new IntakeError(
        question.type === 'checkbox'
          ? `Please confirm: ${question.label}`
          : `Please answer: ${question.label}`,
      );
    }

    // Unanswered optional questions are omitted rather than stored empty, so
    // the facilitator's view shows what was said and not a wall of blanks. A
    // checkbox is the exception: "no" is an answer.
    if (isBlank && question.type !== 'checkbox') continue;

    answers.push({ id: question.id, label: question.label, value: cleaned });
  }

  return answers;
}

/** Whether a form asks anything at all — the gate for showing it. */
export function hasIntake(questions: IntakeQuestion[] | null | undefined): boolean {
  return Array.isArray(questions) && questions.length > 0;
}

/**
 * Reads the column back into a usable shape.
 *
 * Anything malformed becomes an empty form rather than throwing. This runs on
 * the booking path, and the alternative to a safe fallback is a client unable
 * to book at all because of a bad row in a jsonb column — a much worse failure
 * than an intake that briefly asks nothing.
 */
export function parseIntakeQuestions(value: unknown): IntakeQuestion[] {
  try {
    return validateIntakeQuestions(value);
  } catch {
    return [];
  }
}
