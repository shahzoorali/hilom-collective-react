/**
 * Where a fulfilled order should send the buyer. Shared by fulfillment (which
 * emails this link) and the order-status endpoint (which the processing
 * screen's "Start learning" button uses) so the two never drift apart.
 */
const MOODLE_URL = 'https://www.learn.hilomcollective.com';

/**
 * A single-course purchase deep-links straight to that course. A bundle
 * (courseIds.length > 1) has no one "right" course to land on, so it goes to
 * the dashboard, which lists everything the buyer is enrolled in.
 */
export function accessUrl(courseIds: number[]): string {
  if (courseIds.length === 1) return `${MOODLE_URL}/course/view.php?id=${courseIds[0]}`;
  return `${MOODLE_URL}/my/`;
}
