/**
 * Reviews: what a client may write, and how it is shown (0013, aggregates 0036).
 *
 * The rules that matter are all about *who may say what about whom*, so they
 * live here rather than in a handler: a review is a permanent, public statement
 * about a named practitioner, and the difference between "verified client" and
 * "anyone with an account" is the entire value of the feature.
 */
import { stripTags } from './sanitize.js';

export class ReviewError extends Error {}

/** Kept in step with `public.review_status` in 0013_payouts_reviews.sql. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface ReviewInput {
  rating: number;
  comment: string | null;
}

const MAX_COMMENT = 2000;

/**
 * Statuses a session must have reached before it can be reviewed.
 *
 * `completed` is the ordinary case — the sweep marks a session completed once
 * its time has passed. `no_show` is included deliberately and is the awkward
 * one: the client did not attend, was charged, and has an experience to report
 * that a facilitator would very much prefer they did not. Excluding it would
 * make the rating a measure of sessions that went well rather than of the
 * practice.
 *
 * Cancellations are excluded. Nothing happened, and a review of a session that
 * did not take place is a review of the cancellation policy.
 */
const REVIEWABLE_STATUSES = new Set(['completed', 'no_show']);

export function isReviewable(status: string): boolean {
  return REVIEWABLE_STATUSES.has(status);
}

/** Validates what a client submitted. */
export function validateReview(body: Record<string, unknown>): ReviewInput {
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ReviewError('Choose a rating from 1 to 5 stars');
  }

  const raw = typeof body.comment === 'string' ? stripTags(body.comment).trim() : '';
  if (raw.length > MAX_COMMENT) throw new ReviewError('That review is too long');

  return { rating, comment: raw || null };
}

/**
 * How a reviewer is named in public: "Maria C.", or "A client".
 *
 * Denormalized onto the review row (0013) so an approved review can be rendered
 * without joining back to a booking that holds the full email — which the RLS
 * grant on that table deliberately makes impossible anyway.
 *
 * First name and a surname initial is the convention people already expect from
 * marketplaces, and it is also the most that can be published without turning a
 * review into a statement about a named individual's use of a wellness service.
 * Anyone who gave no name at all is simply "A client"; inventing something from
 * their email address would publish the local part of it.
 */
export function reviewerLabel(clientName: string | null | undefined): string {
  const name = (clientName ?? '').trim();
  if (!name) return 'A client';

  const parts = name.split(/\s+/).filter(Boolean);
  const first = stripTags(parts[0] ?? '').slice(0, 40);
  if (!first) return 'A client';

  const surname = parts.length > 1 ? parts[parts.length - 1] : '';
  const initial = surname ? surname.replace(/[^\p{L}]/gu, '').charAt(0).toUpperCase() : '';

  return initial ? `${first} ${initial}.` : first;
}

export interface RatingSummary {
  /** Null when there are none — an average of nothing is not zero stars. */
  average: number | null;
  count: number;
}

/**
 * The public rating, from the running totals maintained in 0036.
 *
 * Rounded to one decimal at the edge rather than stored that way: the columns
 * are an exact integer sum and count, and the rounding is a presentation
 * choice that "4.9" makes and "4.85" might not.
 */
export function ratingSummary(row: {
  rating_count?: number | null;
  rating_sum?: number | null;
}): RatingSummary {
  const count = Math.max(0, Number(row.rating_count ?? 0));
  const sum = Math.max(0, Number(row.rating_sum ?? 0));
  if (count === 0) return { average: null, count: 0 };
  return { average: Math.round((sum / count) * 10) / 10, count };
}
