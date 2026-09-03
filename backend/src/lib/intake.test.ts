/**
 * Tests for pre-session intake (0032).
 *
 * `node:test` via tsx, matching the sibling test files.
 *
 * The rules worth pinning are the ones a facilitator will *rely* on. An intake
 * form for wellness work is often screening — "are you pregnant", "do you have
 * a heart condition" — so a required question that is not actually required
 * leaves someone believing they have checked something they have not. That is
 * a different class of bug from a form field being wrong, and it is what most
 * of these assert.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIntakeQuestions,
  validateIntakeAnswers,
  parseIntakeQuestions,
  hasIntake,
  IntakeError,
} from './intake.js';

const questions = validateIntakeQuestions([
  { id: 'goals', label: 'What would you like from this session?', type: 'longtext', required: true },
  { id: 'health', label: 'Anything I should know about your health?', type: 'text' },
  {
    id: 'experience',
    label: 'Have you done breathwork before?',
    type: 'choice',
    options: ['Never', 'Once or twice', 'Regularly'],
    required: true,
  },
  { id: 'consent', label: 'I understand this is not medical treatment', type: 'checkbox', required: true },
]);

describe('validateIntakeQuestions — the facilitator writing the form', () => {
  it('keeps the fields the answering side needs', () => {
    assert.equal(questions.length, 4);
    assert.equal(questions[0]!.id, 'goals');
    assert.equal(questions[0]!.required, true);
    assert.deepEqual(questions[2]!.options, ['Never', 'Once or twice', 'Regularly']);
  });

  it('refuses a question with no label', () => {
    assert.throws(() => validateIntakeQuestions([{ type: 'text' }]), IntakeError);
  });

  it('refuses an unknown question type rather than silently coercing it', () => {
    assert.throws(() => validateIntakeQuestions([{ label: 'X', type: 'signature' }]), IntakeError);
  });

  it('refuses a multiple choice with fewer than two options', () => {
    assert.throws(
      () => validateIntakeQuestions([{ label: 'Pick', type: 'choice', options: ['Only one'] }]),
      IntakeError,
    );
  });

  it('separates colliding ids instead of making one question unanswerable', () => {
    // Ids are derived from labels in the editor, so two "Anything else?"
    // questions collide through no fault of the person typing them.
    const both = validateIntakeQuestions([
      { id: 'notes', label: 'Anything else?', type: 'text' },
      { id: 'notes', label: 'Anything else?', type: 'text' },
    ]);
    assert.notEqual(both[0]!.id, both[1]!.id);
  });

  it('drops options from types that do not have them', () => {
    const [q] = validateIntakeQuestions([{ label: 'Name', type: 'text', options: ['a', 'b'] }]);
    assert.deepEqual(q!.options, []);
  });

  it('strips markup out of a label', () => {
    const [q] = validateIntakeQuestions([{ label: '<b>Goals</b><script>x</script>', type: 'text' }]);
    assert.doesNotMatch(q!.label, /</);
  });

  it('caps the form at a screening form, not a survey', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ label: `Q${i}`, type: 'text' }));
    assert.throws(() => validateIntakeQuestions(many), IntakeError);
  });
});

describe('validateIntakeAnswers — the client filling it in', () => {
  const complete = {
    goals: 'To sleep better',
    health: '',
    experience: 'Once or twice',
    consent: 'yes',
  };

  it('accepts a complete set and snapshots the label with each answer', () => {
    const answers = validateIntakeAnswers(questions, complete);
    const goals = answers.find((a) => a.id === 'goals');
    assert.equal(goals?.value, 'To sleep better');
    // The label travels with the answer so a later rewrite of the form cannot
    // change what this person was asked. See 0032.
    assert.equal(goals?.label, 'What would you like from this session?');
  });

  it('refuses to proceed with a required question unanswered', () => {
    assert.throws(
      () => validateIntakeAnswers(questions, { ...complete, goals: '   ' }),
      (err: unknown) => err instanceof IntakeError && /What would you like/.test(err.message),
    );
  });

  it('treats an unticked required checkbox as unanswered', () => {
    // The consent case: a form that accepted this would record agreement to
    // something nobody agreed to.
    assert.throws(() => validateIntakeAnswers(questions, { ...complete, consent: '' }), IntakeError);
    assert.throws(() => validateIntakeAnswers(questions, { ...complete, consent: 'no' }), IntakeError);
  });

  it('records a ticked checkbox as a yes and an optional untick as a no', () => {
    const optional = validateIntakeQuestions([{ id: 'news', label: 'Send me notes', type: 'checkbox' }]);
    assert.deepEqual(validateIntakeAnswers(optional, { news: 'on' })[0]!.value, 'yes');
    // Not omitted: for a checkbox, "no" is an answer rather than a blank.
    assert.deepEqual(validateIntakeAnswers(optional, {})[0]!.value, 'no');
  });

  it('refuses a choice that is not one of the options', () => {
    assert.throws(
      () => validateIntakeAnswers(questions, { ...complete, experience: 'Expert' }),
      IntakeError,
    );
  });

  it('omits unanswered optional questions rather than storing blanks', () => {
    const answers = validateIntakeAnswers(questions, complete);
    assert.equal(
      answers.some((a) => a.id === 'health'),
      false,
    );
  });

  /**
   * The answer document must not become arbitrary storage on someone else's
   * booking, and must not accumulate answers to questions that no longer
   * exist. Both follow from iterating the questions rather than the body.
   */
  it('discards anything that does not correspond to a question', () => {
    const answers = validateIntakeAnswers(questions, {
      ...complete,
      injected: 'x'.repeat(5000),
      admin: 'true',
    });
    assert.deepEqual(
      answers.map((a) => a.id).sort(),
      ['consent', 'experience', 'goals'],
    );
  });

  it('accepts the array shape as well as the object shape', () => {
    const answers = validateIntakeAnswers(questions, [
      { id: 'goals', value: 'To sleep better' },
      { id: 'experience', value: 'Regularly' },
      { id: 'consent', value: 'yes' },
    ]);
    assert.equal(answers.length, 3);
  });

  it('strips markup out of an answer', () => {
    const [answer] = validateIntakeAnswers(
      validateIntakeQuestions([{ id: 'x', label: 'X', type: 'text' }]),
      { x: '<img src=x onerror=alert(1)>hello' },
    );
    assert.doesNotMatch(answer!.value, /</);
  });

  it('can skip required questions where nobody was shown the form', () => {
    // A facilitator entering a client by hand: blocking the booking on
    // questions the client was never asked would make intake a reason sessions
    // cannot be created.
    const answers = validateIntakeAnswers(questions, {}, false);
    assert.equal(answers.some((a) => a.id === 'goals'), false);
  });
});

describe('reading the column back', () => {
  it('treats a malformed value as no form rather than throwing', () => {
    // This runs on the booking path. The alternative to a safe fallback is a
    // client unable to book at all because of one bad jsonb row.
    assert.deepEqual(parseIntakeQuestions('not a form'), []);
    assert.deepEqual(parseIntakeQuestions([{ type: 'text' }]), []);
  });

  it('knows when there is nothing to ask', () => {
    assert.equal(hasIntake([]), false);
    assert.equal(hasIntake(null), false);
    assert.equal(hasIntake(questions), true);
  });
});
