/**
 * Tests for `MoodleClient.updateUserName` — the self-service rename behind
 * PATCH /me/profile.
 *
 * Same setup as the sibling test files: `node:test` via tsx, no framework.
 *
 * What these pin down is the *shape of the request*, not the helper's arithmetic.
 * `core_user_update_users` writes whatever fields it is handed, and `email`,
 * `username` and `auth` are the ones that would break the OAuth2 link between a
 * Cognito identity and its Moodle account — silently, and in a way that only
 * surfaces the next time the buyer tries to sign in to a course they paid for.
 * The method exists precisely so that a rename cannot express those fields, so
 * the test asserts on the keys sent rather than only on the values.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MoodleClient } from './moodle.js';

/** A client whose `call` is captured, so nothing leaves the process. */
function stubClient() {
  const client = new MoodleClient('test-token', 'https://www.example.invalid');
  const calls: Array<{ wsfunction: string; params: Record<string, unknown> }> = [];

  client.call = async (wsfunction: string, params: Record<string, unknown> = {}) => {
    calls.push({ wsfunction, params });
    return null as never;
  };

  return { client, calls };
}

describe('MoodleClient.updateUserName', () => {
  it('sends the id and both name fields', async () => {
    const { client, calls } = stubClient();

    await client.updateUserName(42, 'Maria Clara', 'de los Santos');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.wsfunction, 'core_user_update_users');
    const users = calls[0]!.params.users as Array<Record<string, unknown>>;
    assert.deepEqual(users, [{ id: 42, firstname: 'Maria Clara', lastname: 'de los Santos' }]);
  });

  it('never sends email, username or auth', async () => {
    const { client, calls } = stubClient();

    await client.updateUserName(42, 'Ana', 'Reyes');

    const users = calls[0]!.params.users as Array<Record<string, unknown>>;
    const keys = Object.keys(users[0]!);
    assert.deepEqual(keys.sort(), ['firstname', 'id', 'lastname']);
    for (const forbidden of ['email', 'username', 'auth']) {
      assert.ok(!keys.includes(forbidden), `${forbidden} must not be writable by a rename`);
    }
  });
});
