import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistrationAsk, missingForSubmit } from './registration-ask.js';

describe('parseRegistrationAsk', () => {
  it('returns null when the body does not mention registration', () => {
    assert.equal(parseRegistrationAsk({ title: 'x' }), null);
  });

  it('clears everything for an empty mode', () => {
    assert.equal(parseRegistrationAsk({ proposed_registration: '' })?.proposed_registration, null);
  });

  it('drops price, places and deadline for a listing', () => {
    const r = parseRegistrationAsk({ proposed_registration: 'listing', proposed_price_centavos: 500, proposed_capacity: 4 });
    assert.equal(r?.proposed_registration, 'listing');
    assert.equal(r?.proposed_price_centavos, null);
    assert.equal(r?.proposed_capacity, null);
  });

  it('keeps a hilom ask', () => {
    const r = parseRegistrationAsk({
      proposed_registration: 'hilom',
      proposed_price_centavos: 250000,
      proposed_capacity: 15,
      proposed_registration_closes_on: '2026-11-01',
    });
    assert.deepEqual(r, {
      proposed_registration: 'hilom',
      proposed_price_centavos: 250000,
      proposed_capacity: 15,
      proposed_registration_closes_on: '2026-11-01',
    });
  });

  it('rejects a free price, bad places, a bad date and an unknown mode', () => {
    assert.throws(() => parseRegistrationAsk({ proposed_registration: 'hilom', proposed_price_centavos: 0 }));
    assert.throws(() => parseRegistrationAsk({ proposed_registration: 'hilom', proposed_capacity: 0 }));
    assert.throws(() => parseRegistrationAsk({ proposed_registration: 'hilom', proposed_registration_closes_on: 'soon' }));
    assert.throws(() => parseRegistrationAsk({ proposed_registration: 'free' }));
  });
});

describe('missingForSubmit', () => {
  it('needs price and places for hilom, and a link for listing', () => {
    const none = { proposed_price_centavos: null, proposed_capacity: null };
    assert.deepEqual(missingForSubmit({ proposed_registration: 'hilom', ...none }), ['a price', 'how many places']);
    assert.deepEqual(missingForSubmit({ proposed_registration: 'listing', ...none, link_url: null }), ['a registration link']);
    assert.deepEqual(missingForSubmit({ proposed_registration: null, ...none }), []);
  });
});
