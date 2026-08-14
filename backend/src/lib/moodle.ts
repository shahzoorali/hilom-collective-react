/**
 * Moodle Web Services REST client.
 *
 * Only the functions the integration token is actually permitted to call are
 * exposed here. Verified permitted (2026-08-14): core_course_get_courses,
 * core_course_get_courses_by_field, core_user_get_users_by_field,
 * core_user_create_users, core_user_update_users, enrol_manual_enrol_users,
 * enrol_manual_unenrol_users, core_enrol_get_users_courses.
 *
 * NOT permitted: core_webservice_get_site_info, core_enrol_get_enrolled_users.
 * Don't reach for those without widening the service in Moodle admin first.
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
   * Enrolls a user into one or more courses in a single call. No `timeend` is
   * sent, which Moodle treats as permanent access.
   *
   * roleid 5 is the stock "Student" archetype.
   */
  async enrolUser(userid: number, courseIds: number[], roleid = 5): Promise<void> {
    if (courseIds.length === 0) return;
    await this.call<null>('enrol_manual_enrol_users', {
      enrolments: courseIds.map((courseid) => ({ roleid, userid, courseid })),
    });
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
}
