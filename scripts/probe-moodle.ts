/**
 * Phase 2 verification script — proves the Moodle WS integration works against
 * production without going through AWS.
 *
 *   cd backend && npm run probe:moodle
 *
 * Reads MOODLE_WS_TOKEN (and optionally MOODLE_URL) from the environment.
 * Read-only by default. Pass --enrol-test <email> <courseId> to exercise the
 * write path, including the idempotency check the plan requires. That flag
 * enrolls a real user in production Moodle — use a throwaway address.
 */
import { MoodleClient, MoodleError } from '../backend/src/lib/moodle.js';

const token = process.env.MOODLE_WS_TOKEN;
if (!token) {
  console.error('MOODLE_WS_TOKEN is not set. Export it (or source .env) before running.');
  process.exit(1);
}

const moodle = new MoodleClient(token);

async function readOnlyChecks(): Promise<void> {
  const courses = await moodle.getCourses();
  console.log(`\ncourses (${courses.length}, site-level course filtered out):`);
  for (const c of courses) {
    console.log(`  ${String(c.id).padStart(3)}  ${c.visible ? 'visible' : 'hidden '}  ${c.shortname} — ${c.fullname}`);
  }

  const email = 'shahzoor@hilomcollective.com';
  const user = await moodle.getUserByEmail(email);
  console.log(`\nlookup ${email}: ${user ? `id=${user.id} auth=${user.auth}` : 'not found'}`);
}

/**
 * The plan requires confirming that enrolling the same user into the same
 * course twice neither errors nor duplicates. Moodle's manual enrolment plugin
 * is expected to treat the second call as a no-op role assignment.
 */
async function enrolIdempotencyCheck(email: string, courseId: number): Promise<void> {
  let user = await moodle.getUserByEmail(email);
  if (!user) {
    console.log(`creating ${email}...`);
    const created = await moodle.createUser({
      username: email.toLowerCase(),
      email,
      firstname: 'Test',
      lastname: 'Buyer',
    });
    console.log(`  created id=${created.id}`);
    user = await moodle.getUserByEmail(email);
  }
  if (!user) throw new Error(`user ${email} still not found after creation`);

  for (const attempt of [1, 2]) {
    try {
      await moodle.enrolUser(user.id, [courseId]);
      console.log(`enrol attempt ${attempt}: OK`);
    } catch (err) {
      const e = err as MoodleError;
      console.log(`enrol attempt ${attempt}: FAILED ${e.errorcode} — ${e.message}`);
    }
  }

  const enrolled = await moodle.getUserCourses(user.id);
  const matches = enrolled.filter((c) => c.id === courseId);
  console.log(`course ${courseId} appears ${matches.length}x in the user's course list (expect 1)`);
}

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--enrol-test');

await readOnlyChecks();

if (flagIndex !== -1) {
  const email = args[flagIndex + 1];
  const courseId = Number(args[flagIndex + 2]);
  if (!email || !Number.isInteger(courseId)) {
    console.error('usage: --enrol-test <email> <courseId>');
    process.exit(1);
  }
  console.log(`\n--- enrollment idempotency check: ${email} -> course ${courseId} ---`);
  await enrolIdempotencyCheck(email, courseId);
}
