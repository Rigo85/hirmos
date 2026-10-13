import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareRestoredDatabase } from './prepare-restored.mjs';

test('restore preparation rejects production, unrelated and unconfirmed targets before connecting', async () => {
  for (const [name, confirmation] of [['hirmos','hirmos'],['other','other'],
    ['hirmos_restore_fixture',undefined],['hirmos_restore_fixture','hirmos_restore_other']]) {
    await assert.rejects(prepareRestoredDatabase(`postgres://fixture:synthetic@127.0.0.1:1/${name}`,confirmation),/RESTORE_TARGET_NOT_CONFIRMED/);
  }
});
