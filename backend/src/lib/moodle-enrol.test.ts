/**
 * Tests for enrollment idempotency — the rule that a retry of a partly
 * fulfilled order must converge instead of failing forever.
 *
 * Same setup as the sibling test files: `node:test` via tsx, no framework.
 *
 * The case these pin down was a real production failure (2026-08-17). A bundle
 * fans out to several courses; once any one of them was enrolled, the batched
 * call collided on it, the whole request failed, and every subsequent retry
 * failed the same way — so a buyer who had paid never received the remaining
 * courses. The tests below are less about the helper's string matching than
 * about that invariant: an already-enrolled course must never block the ones
 * that are still missing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MoodleClient, MoodleError, isAlreadyEnrolledError } from './moodle.js';

/** The shape Moodle actually returns when the enrolment INSERT collides. */
const duplicateError = () =>
  new MoodleError(
    'dmlwriteexception',
    "Error writing to database (Duplicate entry '26-50' for key 'mdl_userenro_enruse_uix'\n" +
      'INSERT INTO mdl_user_enrolments (enrolid,status,userid) VALUES(?,?,?))',
  );

/**
 * A client whose `call` is replaced, so nothing leaves the process. Returns the
 * courseids seen plus a hook to make chosen courses fail.
 */
function stubClient(fail: (courseid: number) => Error | undefined = () => undefined) {
  const client = new MoodleClient('test-token', 'https://www.example.invalid');
  const enrolled: number[] = [];

  client.call = async (wsfunction: string, params: Record<string, unknown> = {}) => {
    assert.equal(wsfunction, 'enrol_manual_enrol_users');
    const enrolments = params.enrolments as Array<{ courseid: number }>;
    // The fix is per-course calls; a batch would silently reintroduce the bug.
    assert.equal(enrolments.length, 1, 'expected one course per call');
    const { courseid } = enrolments[0]!;
    const err = fail(courseid);
    if (err) throw err;
    enrolled.push(courseid);
    return null as never;
  };

  return { client, enrolled };
}

describe('isAlreadyEnrolledError', () => {
  it('recognises a collision on the user-enrolment unique index', () => {
    assert.equal(isAlreadyEnrolledError(duplicateError()), true);
  });

  it('reads debuginfo as well as the message', () => {
    const err = new MoodleError('dmlwriteexception', 'Error writing to database', "key 'mdl_userenro_enruse_uix'");
    assert.equal(isAlreadyEnrolledError(err), true);
  });

  it('does not swallow an unrelated Moodle failure', () => {
    assert.equal(isAlreadyEnrolledError(new MoodleError('invalidtoken', 'Invalid token')), false);
    // A duplicate on some *other* table is a real bug, not an enrolment we can
    // assume already exists.
    const other = new MoodleError('dmlwriteexception', "Duplicate entry 'x' for key 'mdl_user_username_uix'");
    assert.equal(isAlreadyEnrolledError(other), false);
  });

  it('does not treat arbitrary thrown values as already-enrolled', () => {
    assert.equal(isAlreadyEnrolledError(new Error('mdl_userenro_enruse_uix')), false);
    assert.equal(isAlreadyEnrolledError('mdl_userenro_enruse_uix'), false);
    assert.equal(isAlreadyEnrolledError(undefined), false);
  });
});

describe('enrolUser — a retry must finish what it started', () => {
  it('enrols every course of a bundle', async () => {
    const { client, enrolled } = stubClient();
    await client.enrolUser(42, [10, 15, 16]);
    assert.deepEqual(enrolled, [10, 15, 16]);
  });

  it('completes the missing courses when one is already enrolled', async () => {
    // The production case: course 10 landed on the first attempt, 15 and 16 did
    // not. The retry must deliver 15 and 16 rather than dying on 10.
    const { client, enrolled } = stubClient((id) => (id === 10 ? duplicateError() : undefined));
    await client.enrolUser(42, [10, 15, 16]);
    assert.deepEqual(enrolled, [15, 16]);
  });

  it('is a no-op when every course is already enrolled', async () => {
    const { client, enrolled } = stubClient(() => duplicateError());
    await client.enrolUser(42, [10, 15, 16]);
    assert.deepEqual(enrolled, []);
  });

  it('still throws on a genuine failure', async () => {
    const { client } = stubClient((id) =>
      id === 15 ? new MoodleError('invalidtoken', 'Invalid token') : undefined,
    );
    await assert.rejects(() => client.enrolUser(42, [10, 15, 16]), /Invalid token/);
  });

  it('does nothing, and calls nothing, for an empty course list', async () => {
    const { client, enrolled } = stubClient(() => {
      throw new Error('should not have called Moodle');
    });
    await client.enrolUser(42, []);
    assert.deepEqual(enrolled, []);
  });
});
