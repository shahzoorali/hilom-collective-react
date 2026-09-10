import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shortName } from './names.js';

describe('shortName', () => {
  it('takes the first word of an ordinary name', () => {
    assert.equal(shortName('Crizy Austria'), 'Crizy');
  });

  it('skips an honorific so a title is never used as a name', () => {
    assert.equal(shortName('Miss Kayce'), 'Kayce');
    assert.equal(shortName('Dr. Elena Reyes'), 'Elena');
    assert.equal(shortName('Coach Mike'), 'Mike');
    assert.equal(shortName('Ate Bea Santos'), 'Bea');
  });

  it('keeps a lone word even when it looks like an honorific', () => {
    assert.equal(shortName('Coach'), 'Coach');
  });

  it('is unfazed by padding and empties', () => {
    assert.equal(shortName('  Miss   Kayce  '), 'Kayce');
    assert.equal(shortName(''), '');
  });

  it('takes an explicit override over anything the heuristic would pick', () => {
    assert.equal(shortName('Katherine Chua', 'Kat'), 'Kat');
    // Even when the heuristic would have been right, the override still wins.
    assert.equal(shortName('Crizy Austria', 'Cee'), 'Cee');
  });

  it('falls back to the heuristic when the override is blank or whitespace', () => {
    assert.equal(shortName('Miss Kayce', ''), 'Kayce');
    assert.equal(shortName('Miss Kayce', '   '), 'Kayce');
    assert.equal(shortName('Miss Kayce', null), 'Kayce');
    assert.equal(shortName('Miss Kayce', undefined), 'Kayce');
  });

  it('trims a set override', () => {
    assert.equal(shortName('Dr. Elena Reyes', '  Lena '), 'Lena');
  });
});
