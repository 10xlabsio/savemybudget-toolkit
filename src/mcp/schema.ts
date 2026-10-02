// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * Validates tool arguments against the JSON Schema subset the tool catalogue uses — type (or a list of types),
 * properties, required, additionalProperties:false, items, maxItems, enum, minimum, maximum, maxLength.
 * No coercion: "7" is not an integer. Returns the first problem as a sentence, or null.
 */
type Schema = Record<string, any>;

function typeOk(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

export function argumentError(value: unknown, schema: Schema, path = 'arguments'): string | null {
  const types: string[] | null = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types && !types.some((t) => typeOk(value, t))) return `${path} must be ${types.join(' or ')}.`;

  if (typeOk(value, 'object') && (schema.properties || schema.required || schema.additionalProperties === false)) {
    const obj = value as Record<string, unknown>;
    const props: Schema = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) return `${path}.${key} is required.`;
    for (const [key, item] of Object.entries(obj)) {
      if (!Object.hasOwn(props, key)) {
        if (schema.additionalProperties === false) return `${path} contains an unsupported field (${key.slice(0, 40)}).`;
        continue;
      }
      const err = argumentError(item, props[key], `${path}.${key}`);
      if (err) return err;
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items (at most ${schema.maxItems}).`;
    if (schema.items) for (const item of value) { const err = argumentError(item, schema.items, `${path}[]`); if (err) return err; }
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}.`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  }
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long (at most ${schema.maxLength} characters).`;
  return null;
}
