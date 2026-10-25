// Clear to Close — property details model (Oct 25, 2026 packet).
//
// Optional facts about the property itself (bedrooms, bathrooms,
// square footage, lot size + unit, property type, year built, listed
// price), stored on the escrow (migration 0048), entered on the
// escrow form's optional section, and shown as ONE compact line under
// the address on the realtor escrow page and the client views. Only
// non-empty fields render; all empty means no line at all.
//
// Pure logic only (no React): covered by tests/property_details.test.ts.

import type { Escrow, LotUnit, PropertyDetails, PropertyType } from './types';

export const EMPTY_PROPERTY_DETAILS: PropertyDetails = {
  bedrooms: null,
  bathrooms: null,
  sqft: null,
  lotSize: null,
  lotUnit: 'sqft',
  propertyType: '',
  yearBuilt: null,
  listedPrice: null,
};

export const PROPERTY_TYPE_OPTIONS: { label: string; value: Exclude<PropertyType, ''> }[] = [
  { label: 'Single-family', value: 'single_family' },
  { label: 'Condo', value: 'condo' },
  { label: 'Townhouse', value: 'townhouse' },
  { label: 'Multi-family', value: 'multi_family' },
  { label: 'Land', value: 'land' },
  { label: 'Other', value: 'other' },
];

export function propertyTypeLabel(v: PropertyType): string {
  return PROPERTY_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? '';
}

export const LOT_UNIT_OPTIONS: { label: string; value: LotUnit }[] = [
  { label: 'Sq ft', value: 'sqft' },
  { label: 'Acres', value: 'acres' },
];

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asPropertyType(v: unknown): PropertyType {
  return PROPERTY_TYPE_OPTIONS.some((o) => o.value === v) ? (v as PropertyType) : '';
}

/** The details carried on an Escrow (flat optional fields). */
export function propertyDetailsOf(e: Escrow): PropertyDetails {
  return {
    bedrooms: asNumber(e.bedrooms),
    bathrooms: asNumber(e.bathrooms),
    sqft: asNumber(e.sqft),
    lotSize: asNumber(e.lotSize),
    lotUnit: e.lotUnit === 'acres' ? 'acres' : 'sqft',
    propertyType: asPropertyType(e.propertyType),
    yearBuilt: asNumber(e.yearBuilt),
    listedPrice: asNumber(e.listedPrice),
  };
}

/**
 * The details from a server-shaped record (escrows row or the
 * get_client_view escrow payload — snake_case keys, values possibly
 * strings when a numeric column serializes as text). Defensive: any
 * absent or malformed value maps to the empty default.
 */
export function propertyDetailsFromRow(row: Record<string, unknown>): PropertyDetails {
  const num = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  return {
    bedrooms: num(row.bedrooms),
    bathrooms: num(row.bathrooms),
    sqft: num(row.sqft),
    lotSize: num(row.lot_size),
    lotUnit: row.lot_unit === 'acres' ? 'acres' : 'sqft',
    propertyType: asPropertyType(row.property_type),
    yearBuilt: num(row.year_built),
    listedPrice: num(row.listed_price),
  };
}

/** True when at least one displayable field is set. */
export function hasPropertyDetails(d: PropertyDetails): boolean {
  return (
    d.bedrooms != null ||
    d.bathrooms != null ||
    d.sqft != null ||
    d.lotSize != null ||
    d.propertyType !== '' ||
    d.yearBuilt != null ||
    d.listedPrice != null
  );
}

/** Form input parse: strips $ / commas / spaces; '' or junk maps to null (every field is optional — nothing blocks the save). */
export function parsePropertyNumber(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Form prefill text for a stored value: plain number, no separators. */
export function propertyNumberText(v: number | null): string {
  return v == null ? '' : String(v);
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Decimal without trailing zeros: 2.5 -> "2.5", 3 -> "3", 0.25 -> "0.25". */
function fmtDecimal(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export interface PropertyLineRun {
  text: string;
  strong: boolean;
}
export interface PropertyLineSegment {
  runs: PropertyLineRun[];
}

const run = (text: string, strong = false): PropertyLineRun => ({ text, strong });

/**
 * The compact display line as segments (joined with " · " by the
 * renderer), in the approved order: bd, ba, sq ft, lot, type, built,
 * listed. Values render strong; labels plain. Null when nothing is set.
 */
export function propertyLineSegments(d: PropertyDetails): PropertyLineSegment[] | null {
  const segs: PropertyLineSegment[] = [];
  if (d.bedrooms != null) segs.push({ runs: [run(fmtInt(d.bedrooms), true), run(' bd')] });
  if (d.bathrooms != null) segs.push({ runs: [run(fmtDecimal(d.bathrooms), true), run(' ba')] });
  if (d.sqft != null) segs.push({ runs: [run(fmtInt(d.sqft), true), run(' sq ft')] });
  if (d.lotSize != null) {
    const v = d.lotUnit === 'acres' ? `${fmtDecimal(d.lotSize)} acres` : `${fmtInt(d.lotSize)} sq ft`;
    segs.push({ runs: [run('Lot '), run(v, true)] });
  }
  if (d.propertyType !== '') segs.push({ runs: [run(propertyTypeLabel(d.propertyType), true)] });
  if (d.yearBuilt != null) segs.push({ runs: [run('Built '), run(String(d.yearBuilt), true)] });
  if (d.listedPrice != null) segs.push({ runs: [run('Listed '), run(`$${fmtInt(d.listedPrice)}`, true)] });
  return segs.length > 0 ? segs : null;
}

/** The same line as plain text (confirmation summary, tests). */
export function formatPropertyLine(d: PropertyDetails): string | null {
  const segs = propertyLineSegments(d);
  if (!segs) return null;
  return segs.map((s) => s.runs.map((r) => r.text).join('')).join(' · ');
}
