import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redirectUriOrigin } from '../src/redirect-uri.js';

for (const [value, expected] of [
  ['javascript:', null],
  ['', null],
  ['#frag', null],
  ['https://x/cb#', 'https://x'],
  ['https://evil.com;attacker.example/cb', null],
  ['https://evil.com"attacker.example/cb', null],
  ["https://evil.com'attacker.example/cb", null],
  ['https://evil.com,attacker.example/cb', null],
  ['https://evil.com；script-src/cb', null],
  ['https://evil.com＂attacker/cb', null],
  ['https://[::1]/cb', 'https://[::1]'],
]) {
  test(`redirectUriOrigin(${JSON.stringify(value)})`, () => {
    assert.equal(redirectUriOrigin(value), expected);
  });
}
