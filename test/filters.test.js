import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFilters, FilterValidationError } from '../src/filters.js';

test('buildFilters serializes supported scalar, array, nested, and boolean values', () => {
  assert.equal(buildFilters({ standing: 'active' }), 'standing(active)');
  assert.equal(buildFilters({ status: [1, 2] }), 'status(1,2)');
  assert.equal(buildFilters({ owner: { staff: [17, 13] } }), 'owner(staff(17,13))');
  assert.equal(buildFilters({ enabled: true, archived: false }), 'enabled(yes),archived(no)');
});

test('buildFilters rejects filter syntax injection in values and keys', () => {
  for (const value of ['open(', 'open)', 'open,closed', 'two words']) {
    assert.throws(() => buildFilters({ standing: value }), FilterValidationError);
  }
  for (const key of ['Status', 'bad-key', 'bad.key', '1status']) {
    assert.throws(() => buildFilters({ [key]: 'active' }), FilterValidationError);
  }
  assert.throws(() => buildFilters({ owner: { 'Staff': [17] } }), FilterValidationError);
  assert.throws(() => buildFilters({ [Symbol('status')]: 'active' }), FilterValidationError);
  assert.throws(() => buildFilters({ status: [] }), FilterValidationError);
});

test('buildFilters caps the complete expression at 500 characters', () => {
  const filters = Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [`field_${index}`, 'a'.repeat(128)])
  );
  assert.throws(() => buildFilters(filters), FilterValidationError);
});
