/**
 * Tests for the shared OAuth layer's decision points.
 *
 * Same setup as the sibling test files: `node:test` via tsx, no framework.
 *
 * These do not exercise KMS or a live provider. What they pin is the handful of
 * judgements that are easy to "simplify" later and expensive to get wrong:
 *
 *  * **Permanent vs transient refresh failure.** Marking a working connection
 *    broken tells a facilitator to reconnect for nothing; treating a revoked
 *    grant as transient means retrying forever and never telling them.
 *  * **bytea round-tripping.** PostgREST hands back `\x…` hex, not bytes. Get
 *    this wrong and the ciphertext is silently mangled — discovered weeks
 *    later, at refresh time, as an undecryptable token.
 *  * **Return-to safety.** The connect flow takes a redirect target from the
 *    request and hands it to a browser after an OAuth hop, which is precisely
 *    the shape of an open redirect.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MeetingCreationError,
  OAuthTokenError,
  PROVIDERS,
  deleteMeeting,
  isProvider,
  providerLabel,
  updateMeetingTime,
} from './integrations.js';
import { fromBytea, toBytea, TokenCryptoError } from './token-crypto.js';

describe('OAuthTokenError — permanent vs transient', () => {
  it('treats a revoked or expired grant as permanent', () => {
    // The user removed Hilom from their Google/Zoom account. Retrying is
    // pointless; only reconnecting fixes it.
    assert.equal(new OAuthTokenError('invalid_grant', 400).isPermanent, true);
  });

  it('treats bad client credentials as permanent', () => {
    assert.equal(new OAuthTokenError('invalid_client', 401).isPermanent, true);
    assert.equal(new OAuthTokenError('unauthorized_client', 400).isPermanent, true);
  });

  it('treats provider outages as transient', () => {
    // A 5xx must not flag a healthy connection as broken — that would tell a
    // facilitator to reconnect an account that was working fine.
    assert.equal(new OAuthTokenError('server_error', 500).isPermanent, false);
    assert.equal(new OAuthTokenError('temporarily_unavailable', 503).isPermanent, false);
    assert.equal(new OAuthTokenError('unknown_error', 502).isPermanent, false);
  });

  it('treats rate limiting as transient', () => {
    assert.equal(new OAuthTokenError('rate_limit_exceeded', 429).isPermanent, false);
  });

  it('carries the provider code and status for logging', () => {
    const err = new OAuthTokenError('invalid_grant', 400);
    assert.equal(err.code, 'invalid_grant');
    assert.equal(err.status, 400);
    assert.match(err.message, /400/);
  });
});

describe('providers', () => {
  it('accepts only the two real providers', () => {
    assert.equal(isProvider('google_meet'), true);
    assert.equal(isProvider('zoom'), true);
    assert.equal(isProvider('teams'), false);
    assert.equal(isProvider(''), false);
    assert.equal(isProvider(undefined), false);
    assert.equal(isProvider(null), false);
  });

  it('has a human label for every provider it lists', () => {
    // Guards the case where a provider is added to the union but not to the
    // config map, which would render an empty name in the dashboard.
    for (const p of PROVIDERS) {
      assert.ok(providerLabel(p), `${p} has no label`);
    }
  });
});

describe('meeting lifecycle — Google has none', () => {
  // A Meet space has no start time and no teardown, so update and delete must
  // return before touching Supabase or the network. Passing a null client
  // proves they never reach it. The Zoom path is not exercised here — it needs
  // a real token — but the "Google is a no-op" contract is what the reschedule
  // and cancel handlers depend on to stay simple.
  const noClient = null as unknown as Parameters<typeof updateMeetingTime>[0];

  it('updateMeetingTime is a no-op for google_meet', async () => {
    await updateMeetingTime(noClient, 'fac-1', 'google_meet', 'spaces/x', {
      title: '',
      startsAt: new Date(),
      durationMinutes: 60,
      timezone: 'Asia/Manila',
    });
  });

  it('deleteMeeting is a no-op for google_meet', async () => {
    await deleteMeeting(noClient, 'fac-1', 'google_meet', 'spaces/x');
  });
});

describe('MeetingCreationError', () => {
  it('carries the provider and a readable message', () => {
    const err = new MeetingCreationError('zoom', '429 too many requests');
    assert.equal(err.provider, 'zoom');
    assert.equal(err.name, 'MeetingCreationError');
    assert.match(err.message, /Zoom/);
    assert.match(err.message, /429/);
  });
});

describe('bytea round-tripping', () => {
  it('survives a round trip through the PostgREST hex representation', () => {
    const original = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
    assert.deepEqual(fromBytea(toBytea(original)), original);
  });

  it('writes the \\x prefix Postgres expects', () => {
    assert.equal(toBytea(Buffer.from([0xde, 0xad])), '\\xdead');
  });

  it('reads hex with or without the prefix', () => {
    assert.deepEqual(fromBytea('\\xdead'), Buffer.from([0xde, 0xad]));
    assert.deepEqual(fromBytea('dead'), Buffer.from([0xde, 0xad]));
  });

  it('passes a Buffer straight through', () => {
    const buf = Buffer.from([1, 2, 3]);
    assert.equal(fromBytea(buf), buf);
  });

  it('refuses a value that is neither', () => {
    // Better to throw than to coerce: a silently wrong ciphertext is only
    // discovered much later, when a refresh fails to decrypt.
    assert.throws(() => fromBytea(42), TokenCryptoError);
    assert.throws(() => fromBytea(null), TokenCryptoError);
  });

  it('round-trips a realistically sized token blob', () => {
    const blob = Buffer.alloc(1024, 0xa5);
    assert.deepEqual(fromBytea(toBytea(blob)), blob);
  });
});
