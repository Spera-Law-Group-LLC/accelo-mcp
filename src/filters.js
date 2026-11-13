import { z } from 'zod';

const scalarSchema = z.union([z.string(), z.number()]);
const arraySchema = z.array(scalarSchema).min(1);
export const structuredFilterSchema = z.record(z.union([
  z.string(),
  z.number(),
  z.boolean(),
  arraySchema,
  z.record(arraySchema),
]));

export class FilterValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'FilterValidationError';
  }
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const VALUE_PATTERN = /^[A-Za-z0-9_.@-]{1,128}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateKey(key) {
  if (!KEY_PATTERN.test(key)) throw new FilterValidationError('Filter keys must be lowercase Accelo identifiers.');
}

function scalar(value) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new FilterValidationError('Filter values must be strings, numbers, or booleans.');
  }
  const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
  if (!VALUE_PATTERN.test(text)) throw new FilterValidationError('Filter value contains unsupported characters.');
  return text;
}

function renderEntries(obj) {
  if (!isPlainObject(obj)) {
    throw new FilterValidationError('Filters must be non-empty plain objects.');
  }
  const keys = Reflect.ownKeys(obj);
  if (keys.length === 0) throw new FilterValidationError('Filters must be non-empty plain objects.');
  return keys.map((key) => {
    if (typeof key !== 'string') throw new FilterValidationError('Filter keys must be strings.');
    validateKey(key);
    const value = obj[key];
    let rendered;
    if (Array.isArray(value)) {
      if (value.length === 0) throw new FilterValidationError('Filter arrays must not be empty.');
      rendered = value.map(scalar).join(',');
    } else if (isPlainObject(value)) {
      rendered = renderEntries(value);
    } else {
      rendered = scalar(value);
    }
    return `${key}(${rendered})`;
  }).join(',');
}

export function buildFilters(obj) {
  const result = renderEntries(obj);
  if (result.length > 500) throw new FilterValidationError('Filter expression must not exceed 500 characters.');
  return result;
}
