import type { Filters } from './api';

export function withoutFilter(filters: Filters, key: string): Filters {
  const { [key]: _, ...rest } = filters;
  return rest;
}

/** Choosing the active value again removes it. The empty string is a real value (Direct/None). */
export function toggledFilter(filters: Filters, key: string, value: string): Filters {
  return filters[key] === value ? withoutFilter(filters, key) : { ...filters, [key]: value };
}
