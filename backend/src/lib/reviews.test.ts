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
import { validateReview, reviewerLabel, isReviewable, ratingSummary, ReviewError } from './reviews.js';

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
