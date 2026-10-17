/** Novel usage-sample validation (0007 §7), extracted from novel.ts. */

import type { NovelUsageSample, ValidationError } from './novel-model.js'


/** Usage sampling ring size (0007 §7 W0): the store keeps only the most
 *  recent samples per novel so run state stays finite and lossless. */
export const USAGE_SAMPLE_LIMIT = 50

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Structural validation of one usage sample (0007 §7): every numeric value
 * must be a non-negative integer so the persisted record stays JSON-lossless
 * (no NaN/Infinity can survive JSON serialization) and audit arithmetic is
 * well-defined. Mirrors validateRunBudgets' field-error style.
 */
export function validateUsageSample(sample: NovelUsageSample): ValidationError[] {
  const errors: ValidationError[] = []
  const s = sample as unknown as Record<string, unknown>
  if (typeof s.recordedAt !== 'string' || s.recordedAt.trim() === '') {
    errors.push({ field: 'recordedAt', message: 'recordedAt must be a non-empty string' })
  }
  if (!isNonNegativeInteger(s.turn)) {
    errors.push({ field: 'turn', message: 'turn must be a non-negative integer' })
  }
  errors.push(...validateSampleCounts(s.toolBytes, 'toolBytes'))
  if (s.writerOutputChars !== undefined && !isNonNegativeInteger(s.writerOutputChars)) {
    errors.push({ field: 'writerOutputChars', message: 'writerOutputChars must be a non-negative integer' })
  }
  if (s.usage !== undefined) {
    errors.push(...validateSampleCounts(s.usage, 'usage'))
  }
  return errors
}

/** Shared shape check for the numeric maps of a usage sample. */
function validateSampleCounts(value: unknown, field: string): ValidationError[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field, message: `${field} must be an object of numbers` }]
  }
  const errors: ValidationError[] = []
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (!isNonNegativeInteger(count)) {
      errors.push({ field: `${field}.${key}`, message: `${field}.${key} must be a non-negative integer` })
    }
  }
  return errors
}
