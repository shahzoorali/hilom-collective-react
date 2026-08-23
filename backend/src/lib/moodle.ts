/**
 * Moodle Web Services REST client.
 *
 * Only the functions the integration token is actually permitted to call are
 * exposed here. Verified permitted (2026-08-15): core_course_get_courses,
 * core_course_get_courses_by_field, core_user_get_users_by_field,
 * core_user_create_users, core_user_update_users, enrol_manual_enrol_users,
 * enrol_manual_unenrol_users, core_enrol_get_users_courses,
 * core_enrol_get_enrolled_users, core_course_get_contents.
 *
 * NOT permitted: core_webservice_get_site_info.
 * Don't reach for that without widening the service in Moodle admin first.
 */

/** Must include `www` — the bare host 301-redirects and drops POST bodies. */
const DEFAULT_MOODLE_URL = 'https://www.learn.hilomcollective.com';

export interface MoodleCourse {
  id: number;
  shortname: string;
  fullname: string;
  summary: string;
  format: string;
  visible: number;
}

interface MoodleOverviewFile {
  filename: string;
  fileurl: string;
  mimetype: string;
}

interface MoodleCourseWithFiles extends MoodleCourse {
  overviewfiles?: MoodleOverviewFile[];
}

export interface MoodleUser {
  id: number;
  username: string;
  email: string;
  firstname: string;
  lastname: string;
  auth: string;
  suspended: boolean;
}

/**
 * Moodle returns HTTP 200 even for failures, signalling errors with an
 * `exception`/`errorcode` body instead. Every response must be checked.
 */
export class MoodleError extends Error {
  constructor(
    readonly errorcode: string,
    message: string,
    readonly debuginfo?: string,
  ) {
    super(message);
    this.name = 'MoodleError';
  }
}

/**
 * True when a failed enrolment write means "this user is already enrolled in
 * this course", which for fulfillment purposes is success, not failure.
 *
 * `mdl_userenro_enruse_uix` is the unique index on (enrolid, userid), so a
 * collision on it says the exact row we were trying to create already exists.
 * Matched on the index name rather than on `errorcode` because Moodle reports
 * this as a generic `dmlwriteexception` — the same code it uses for unrelated
 * write failures that must keep throwing.
 *
 * Seen in production on 2026-08-17: an enrolment that had already landed was
 * re-sent by the retry consumer and the write collided. Moodle usually updates
 * rather than inserts for an existing enrolment, so the likely trigger is a
 * race between the webhook and a retry running concurrently — both observing
 * "not enrolled" before either commits. Tolerating the collision is correct
 * either way; the row we wanted is there.
 */
export function isAlreadyEnrolledError(err: unknown): boolean {
  if (!(err instanceof MoodleError)) return false;
  return `${err.message} ${err.debuginfo ?? ''}`.includes('mdl_userenro_enruse_uix');
}

export class MoodleClient {
  private readonly endpoint: string;

  constructor(
    private readonly token: string,
    baseUrl: string = process.env.MOODLE_URL ?? DEFAULT_MOODLE_URL,
  ) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/webservice/rest/server.php`;
  }

  /**
   * Moodle's REST endpoint takes no JSON — nested structures are flattened into
   * form keys like `enrolments[0][userid]`.
   */
  private static flatten(value: unknown, prefix: string, out: URLSearchParams): void {
    if (Array.isArray(value)) {
      value.forEach((v, i) => MoodleClient.flatten(v, `${prefix}[${i}]`, out));
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        MoodleClient.flatten(v, `${prefix}[${k}]`, out);
      }
    } else if (value !== undefined) {
      out.append(prefix, String(value));
    }
  }

  async call<T>(wsfunction: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = new URLSearchParams({
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: 'json',
    });
    for (const [key, value] of Object.entries(params)) {
      MoodleClient.flatten(value, key, body);
    }

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new MoodleError('http_error', `Moodle returned HTTP ${res.status} for ${wsfunction}`);
    }

    const data = (await res.json()) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data) && 'errorcode' in data) {
      const err = data as { errorcode: string; message?: string; debuginfo?: string };
      throw new MoodleError(err.errorcode, err.message ?? `Moodle error on ${wsfunction}`, err.debuginfo);
    }
    return data as T;
  }

  /** Course 1 is the site-level pseudo-course (`format: site`) and is filtered out. */
  async getCourses(): Promise<MoodleCourse[]> {
    const courses = await this.call<MoodleCourse[]>('core_course_get_courses');
    return courses.filter((c) => c.format !== 'site');
  }

  /**
   * Like getCourses(), but via core_course_get_courses_by_field (empty field =
   * all courses), which is the only permitted call that also returns
   * `overviewfiles` — the course image set on the course edit form.
   *
   * `fileurl` on each overview file requires the WS token appended as a query
   * param to load; the caller must fetch it server-side and never forward that
   * URL to the frontend, since it would leak the token.
   */
  async getCoursesWithImages(): Promise<MoodleCourseWithFiles[]> {
    const { courses } = await this.call<{ courses: MoodleCourseWithFiles[] }>(
      'core_course_get_courses_by_field',
      { field: '', value: '' },
    );
    return courses.filter((c) => c.format !== 'site');
  }

  /** Appends the WS token so a protected pluginfile.php URL becomes fetchable. */
  authenticatedFileUrl(fileurl: string): string {
    return `${fileurl}${fileurl.includes('?') ? '&' : '?'}token=${this.token}`;
  }

  async getUserByEmail(email: string): Promise<MoodleUser | undefined> {
    const users = await this.call<MoodleUser[]>('core_user_get_users_by_field', {
      field: 'email',
      values: [email],
    });
    return users[0];
  }

  async createUser(user: {
    username: string;
    email: string;
    firstname: string;
    lastname: string;
    auth?: string;
  }): Promise<{ id: number; username: string }> {
    // auth: 'oauth2' so the account is owned by the Cognito identity and has no
    // local password to guess. Moodle rejects a password field for oauth2 users.
    const created = await this.call<Array<{ id: number; username: string }>>('core_user_create_users', {
      users: [{ ...user, auth: user.auth ?? 'oauth2' }],
    });
    const first = created[0];
    if (!first) throw new MoodleError('create_failed', `core_user_create_users returned no user for ${user.email}`);
    return first;
  }

  /**
   * Enrolls a user into one or more courses. No `timeend` is sent, which
   * Moodle treats as permanent access.
   *
   * One call per course, not one batched call for all of them. A batch is a
   * single Moodle request, so one course failing takes the whole request down
   * with it — and the courses that would have succeeded do not land. That made
   * a partially-fulfilled bundle unrecoverable: course 17 fans out to 10, 15
   * and 16, and once any one of them was enrolled, every retry re-sent all
   * three, collided on the one that had succeeded, and the buyer never got the
   * rest. Per-course means a collision costs that course and nothing else.
   *
   * An already-enrolled course is swallowed rather than thrown, so a retry of
   * a partly-completed order converges on "fully enrolled" instead of failing
   * forever. See `isAlreadyEnrolledError`.
   *
   * roleid 5 is the stock "Student" archetype.
   */
  async enrolUser(userid: number, courseIds: number[], roleid = 5): Promise<void> {
    for (const courseid of courseIds) {
      try {
        await this.call<null>('enrol_manual_enrol_users', {
          enrolments: [{ roleid, userid, courseid }],
        });
      } catch (err) {
        if (!isAlreadyEnrolledError(err)) throw err;
        console.warn(`[moodle.enrolUser] user ${userid} already enrolled in ${courseid}; treating as success`);
      }
    }
  }

  /** Used by the Phase 8 manual refund-revoke flow. */
  async unenrolUser(userid: number, courseIds: number[]): Promise<void> {
    if (courseIds.length === 0) return;
    await this.call<null>('enrol_manual_unenrol_users', {
      enrolments: courseIds.map((courseid) => ({ userid, courseid })),
    });
  }

  async getUserCourses(userid: number): Promise<MoodleCourse[]> {
    return this.call<MoodleCourse[]>('core_enrol_get_users_courses', { userid });
  }

  /**
   * Live enrolled-student count for a course, straight from Moodle rather than
   * derived from our own `orders` (which only reflects buyers who went through
   * our checkout — not test/manual enrollments made directly in Moodle admin).
   */
  async getEnrolledCount(courseid: number): Promise<number> {
    const users = await this.call<unknown[]>('core_enrol_get_enrolled_users', { courseid });
    return users.length;
  }

  /**
   * Concatenates the HTML of every Label activity across a course's sections —
   * the "Learner Guide" intro/instructions block some courses author directly
   * on the course page rather than in the Course summary setting. Deliberately
   * skips every other activity type (SCORM, quiz, url, resource, ...): those
   * are gated learning content or links into the platform, not marketing copy
   * that belongs on the public product page.
   */
  async getLabelContent(courseid: number): Promise<string | null> {
    const sections = await this.call<
      { modules: { modname: string; description?: string }[] }[]
    >('core_course_get_contents', { courseid });

    const html = sections
      .flatMap((s) => s.modules)
      .filter((m) => m.modname === 'label' && m.description)
      .map((m) => m.description as string)
      .join('\n');

    return html || null;
  }
}
