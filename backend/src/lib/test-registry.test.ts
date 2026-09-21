import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Asserts every test file in this directory is actually run.
 *
 * `npm test` names each file explicitly because this repo is on Node 20, where
 * `--test` does not accept glob patterns — they arrived in Node 21. The cost
 * of that list is that adding a test file and forgetting to register it means
 * the tests silently do not run, and a green suite reports on code nothing
 * touched. That is worse than a missing test, because it looks like coverage.
 *
 * This happened immediately: payout-domain.test.ts was written, the suite
 * reported 313 passing, and not one of its assertions had executed.
 *
 * Delete this the day the runtime moves to Node 22+ and the script can take
 * `src/lib/*.test.ts` directly.
 */
test('every *.test.ts in src/lib is registered in the npm test script', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = readFileSync(join(here, '..', '..', 'package.json'), 'utf8');
  const script = (JSON.parse(pkg).scripts?.test ?? '') as string;

  const onDisk = readdirSync(here).filter((f) => f.endsWith('.test.ts'));
  const missing = onDisk.filter((f) => !script.includes(`src/lib/${f}`));

  assert.deepEqual(
    missing,
    [],
    `These test files exist but are never run. Add them to "test" in backend/package.json:\n  ${missing.join('\n  ')}`,
  );
});
