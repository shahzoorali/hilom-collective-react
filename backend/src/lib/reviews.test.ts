/**
 * Tests for the review rules (0013, aggregates 0036).
 *
 * `node:test` via tsx, matching the sibling test files.
 *
 * A review is a permanent public statement about a named practitioner, so the
 * rules worth pinning are about what may be said and how much of the reviewer
 * is published — not about form validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReview,
  reviewerLabel,
  isReviewable,
  ratingSummary,
  ReviewError,
  isAttendanceReviewable,
  reviewConflictTarget,
} from './reviews.js';

describe('isReviewable — which sessions may be reviewed', () => {
  it('allows a session that took place', () => {
    assert.equal(isReviewable('completed'), true);
  });

  /**
   * The awkward one, and deliberate. The client did not attend, was charged,
   * and has an experience to report that a facilitator would prefer they did
   * not. Excluding it would make the rating a measure of sessions that went
   * well rather than of the practice.
   */
  it('allows a no-show', () => {
    assert.equal(isReviewable('no_show'), true);
  });

  it('refuses a session that has not happened yet', () => {
    assert.equal(isReviewable('confirmed'), false);
    assert.equal(isReviewable('pending_payment'), false);
  });

  it('refuses a cancellation — that would review the refund policy', () => {
    assert.equal(isReviewable('cancelled_by_client'), false);
    assert.equal(isReviewable('cancelled_by_facilitator'), false);
    assert.equal(isReviewable('refunded'), false);
  });
});

describe('validateReview', () => {
  it('accepts a rating with a comment', () => {
    const r = validateReview({ rating: 5, comment: '  Genuinely helpful.  ' });
    assert.equal(r.rating, 5);
    assert.equal(r.comment, 'Genuinely helpful.');
  });

  it('accepts a rating with no comment', () => {
    assert.equal(validateReview({ rating: 3 }).comment, null);
    assert.equal(validateReview({ rating: 3, comment: '   ' }).comment, null);
  });

  it('refuses a rating outside one to five', () => {
    for (const rating of [0, 6, -1, 2.5, 'five', null, undefined]) {
      assert.throws(() => validateReview({ rating }), ReviewError, `accepted ${String(rating)}`);
    }
  });

  it('strips markup out of a comment', () => {
    const r = validateReview({ rating: 4, comment: '<script>alert(1)</script>Lovely' });
    assert.doesNotMatch(r.comment ?? '', /</);
  });

  it('refuses a comment longer than the column allows', () => {
    assert.throws(() => validateReview({ rating: 4, comment: 'x'.repeat(2001) }), ReviewError);
  });
});

describe('reviewerLabel — how much of a reviewer is published', () => {
  it('gives a first name and a surname initial', () => {
    assert.equal(reviewerLabel('Maria Cruz'), 'Maria C.');
  });

  it('uses the last part as the surname, not the second', () => {
    assert.equal(reviewerLabel('Maria Isabel Cruz Santos'), 'Maria S.');
  });

  it('gives just the first name when there is only one', () => {
    assert.equal(reviewerLabel('Maria'), 'Maria');
  });

  /**
   * Never derived from the email. Falling back to the local part would publish
   * an address fragment beside a statement about someone's use of a wellness
   * service, which is precisely what this function exists to avoid.
   */
  it('falls back to a generic label rather than inventing one', () => {
    assert.equal(reviewerLabel(null), 'A client');
    assert.equal(reviewerLabel(''), 'A client');
    assert.equal(reviewerLabel('   '), 'A client');
  });

  it('handles a surname with no letters in it', () => {
    // "Maria ???" should not produce "Maria ." with an empty initial.
    assert.equal(reviewerLabel('Maria 123'), 'Maria');
  });

  it('handles a non-Latin name without dropping it', () => {
    assert.equal(reviewerLabel('María Ángeles'), 'María Á.');
  });
});

describe('ratingSummary', () => {
  it('averages from the exact integer totals', () => {
    assert.deepEqual(ratingSummary({ rating_count: 4, rating_sum: 19 }), { average: 4.8, count: 4 });
  });

  /**
   * The distinction the whole card layout depends on. A new facilitator with no
   * reviews must not render as zero stars — that would make them look worse
   * than a badly-reviewed one.
   */
  it('has no average when there are no reviews', () => {
    assert.deepEqual(ratingSummary({ rating_count: 0, rating_sum: 0 }), { average: null, count: 0 });
    assert.deepEqual(ratingSummary({}), { average: null, count: 0 });
  });

  it('rounds to one decimal', () => {
    assert.equal(ratingSummary({ rating_count: 3, rating_sum: 13 }).average, 4.3);
  });

  it('is never worse than nothing on a nonsense row', () => {
    const summary = ratingSummary({ rating_count: -5, rating_sum: -20 });
    assert.equal(summary.count, 0);
    assert.equal(summary.average, null);
  });
});

// ---------------------------------------------------------------------------
// Reviewing things other than a 1:1 session (0050)
// ---------------------------------------------------------------------------

describe('isAttendanceReviewable', () => {
  const past = '2026-01-01T10:00:00Z';
  const pastEnd = '2026-01-01T12:00:00Z';
  const now = new Date('2026-06-01T00:00:00Z');

  it('a confirmed registration for a finished event can be reviewed', () => {
    assert.equal(isAttendanceReviewable('confirmed', pastEnd, past, now), true);
  });

  it('completed counts too — the sweep marks attendance after the fact', () => {
    assert.equal(isAttendanceReviewable('completed', pastEnd, past, now), true);
  });

  it('an event that has not happened yet cannot be reviewed', () => {
    const future = '2026-12-01T10:00:00Z';
    assert.equal(isAttendanceReviewable('confirmed', null, future, now), false);
  });

  it('ends_at decides, not starts_at — a two-day retreat is not reviewable on day one', () => {
    // Mid-retreat: it started yesterday and ends tomorrow.
    const midway = new Date('2026-06-02T00:00:00Z');
    assert.equal(
      isAttendanceReviewable('confirmed', '2026-06-03T00:00:00Z', '2026-06-01T00:00:00Z', midway),
      false,
    );
  });

  it('a one-day event with no ends_at falls back to starts_at', () => {
    assert.equal(isAttendanceReviewable('confirmed', null, past, now), true);
  });

  it('judged on the clock, not on a status', () => {
    // An event is marked `completed` by a sweep. The hour between it ending
    // and the sweep running is still an hour in which someone has a
    // legitimate opinion about it, so `confirmed` plus a past date is enough.
    assert.equal(isAttendanceReviewable('confirmed', pastEnd, past, now), true);
  });

  it('a lapsed hold cannot be reviewed — they never paid and never came', () => {
    assert.equal(isAttendanceReviewable('expired', pastEnd, past, now), false);
    assert.equal(isAttendanceReviewable('pending_payment', pastEnd, past, now), false);
  });

  it('a cancelled place cannot be reviewed — nothing happened', () => {
    assert.equal(isAttendanceReviewable('cancelled', pastEnd, past, now), false);
  });

  it('an unparseable date is not reviewable rather than throwing', () => {
    assert.equal(isAttendanceReviewable('confirmed', null, 'not-a-date', now), false);
  });
});

describe('reviewConflictTarget', () => {
  // 0050 replaced the unique constraint on booking_id with three partial
  // unique indexes. PostgREST has to be told which one an upsert targets, and
  // naming the wrong one would insert a second review instead of revising the
  // first.
  it('names the column for each subject', () => {
    assert.equal(reviewConflictTarget({ booking_id: 'b1' }), 'booking_id');
    assert.equal(reviewConflictTarget({ event_registration_id: 'e1' }), 'event_registration_id');
    assert.equal(reviewConflictTarget({ class_registration_id: 'c1' }), 'class_registration_id');
  });
});
