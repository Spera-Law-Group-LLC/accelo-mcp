import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redirectUriOrigin } from '../src/redirect-uri.js';

for (const [value, expected] of [
  ['javascript:', null],
  ['', null],
  ['#frag', null],
  ['https://x/cb#', 'https://x'],
]) {
  test(`redirectUriOrigin(${JSON.stringify(value)})`, () => {
    assert.equal(redirectUriOrigin(value), expected);
  });
}
