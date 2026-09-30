// Clear to Close — TC intake v1 (Sept 29, 2026, Anuraj-approved mockup 04).
//
// The realtor fills this once per listing-side escrow; the TC reads it
// (in-app read-only view or the realtor's manual share). Buyer and seller
// client views never see any of it.
//
// This module is the SINGLE sectioned-intake model shared by three
// consumers: the realtor's plain-text share builder, the TC read-only
// details page, and the completion counter. No divergent copies.
//
// Pure logic only (no React): fully covered by tests/tc_intake.test.ts.

/** A Yes/No answer; '' = unanswered (nothing is assumed — mockup rule). */
export type TcYesNo = '' | 'yes' | 'no';

export interface TcIntakeSeller {
  name: string;
  phone: string;
  email: string;
}

export interface TcIntakeData {
  // Property
  ownerOccupied: TcYesNo;
  inTrust: TcYesNo;
  trustName: string;
  /** YYYY-MM-DD or ''. */
  trustDate: string;
  /** Comma-separated. */
  trusteeNames: string;
  /** Comma-separated. */
  trusteeEmails: string;
  // Sellers: 1..3 visible blocks.
  sellers: TcIntakeSeller[];
  // Listing terms
  listPrice: string;
  /** YYYY-MM-DD or ''. */
  contractBegin: string;
  /** YYYY-MM-DD or ''. */
  contractEnd: string;
  /** YYYY-MM-DD or ''. */
  mlsDate: string;
  buyingAnother: TcYesNo;
  homeOfChoice: TcYesNo;
  // Commission
  totalPct: string;
  buyerPct: string;
  /** Prefilled brokerage defaults; editable. */
  tcFee: string;
  /** Prefilled brokerage defaults; editable. */
  brokerFee: string;
  // Property details
  personalProperty: string;
  hoa: TcYesNo;
  hoaAmount: string;
  solar: TcYesNo;
  solarLeasedOwned: '' | 'leased' | 'owned';
  solarAmount: string;
  solarCompany: string;
  pool: TcYesNo;
  // Vendors
  escrowCompany: string;
  titleCompany: string;
  nhdCompany: string;
  warrantyCompany: string;
  warrantyAmount: string;
}

/** Brokerage defaults (Anuraj, Sept 29, 2026): prefilled, editable. */
export const TC_FEE_DEFAULT = '500';
export const BROKER_FEE_DEFAULT = '995';

/** Maximum seller blocks (mockup ②). */
export const TC_INTAKE_MAX_SELLERS = 3;

export function emptyTcIntakeSeller(): TcIntakeSeller {
  return { name: '', phone: '', email: '' };
}

export function emptyTcIntake(): TcIntakeData {
  return {
    ownerOccupied: '',
    inTrust: '',
    trustName: '',
    trustDate: '',
    trusteeNames: '',
    trusteeEmails: '',
    sellers: [emptyTcIntakeSeller()],
    listPrice: '',
    contractBegin: '',
    contractEnd: '',
    mlsDate: '',
    buyingAnother: '',
    homeOfChoice: '',
    totalPct: '',
    buyerPct: '',
    tcFee: TC_FEE_DEFAULT,
    brokerFee: BROKER_FEE_DEFAULT,
    personalProperty: '',
    hoa: '',
    hoaAmount: '',
    solar: '',
    solarLeasedOwned: '',
    solarAmount: '',
    solarCompany: '',
    pool: '',
    escrowCompany: '',
    titleCompany: '',
    nhdCompany: '',
    warrantyCompany: '',
    warrantyAmount: '',
  };
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asYesNo(v: unknown): TcYesNo {
  return v === 'yes' || v === 'no' ? v : '';
}

function asSeller(v: unknown): TcIntakeSeller {
  const s = (v ?? {}) as Record<string, unknown>;
  return { name: asText(s.name), phone: asText(s.phone), email: asText(s.email) };
}

/**
 * Defensive coercion of untrusted JSON (server jsonb) into the intake shape.
 * Unknown/mistyped values fall back to empty — a corrupt row renders
 * "Not provided", never crashes.
 */
export function normalizeTcIntake(raw: unknown): TcIntakeData {
  const d = (raw ?? {}) as Record<string, unknown>;
  const sellersRaw = Array.isArray(d.sellers) ? d.sellers : [];
  const sellers = sellersRaw.slice(0, TC_INTAKE_MAX_SELLERS).map(asSeller);
  if (sellers.length === 0) sellers.push(emptyTcIntakeSeller());
  const slo = d.solarLeasedOwned;
  return {
    ownerOccupied: asYesNo(d.ownerOccupied),
    inTrust: asYesNo(d.inTrust),
    trustName: asText(d.trustName),
    trustDate: asText(d.trustDate),
    trusteeNames: asText(d.trusteeNames),
    trusteeEmails: asText(d.trusteeEmails),
    sellers,
    listPrice: asText(d.listPrice),
    contractBegin: asText(d.contractBegin),
    contractEnd: asText(d.contractEnd),
    mlsDate: asText(d.mlsDate),
    buyingAnother: asYesNo(d.buyingAnother),
    homeOfChoice: asYesNo(d.homeOfChoice),
    totalPct: asText(d.totalPct),
    buyerPct: asText(d.buyerPct),
    // Fee defaults apply only when the field is ABSENT (a brand-new
    // intake) — never to an explicit blank. If the realtor clears the fee
    // and saves, the blank survives normalization and counts unfilled;
    // silently re-filling the default would undo their edit.
    tcFee: d.tcFee === undefined || d.tcFee === null ? TC_FEE_DEFAULT : asText(d.tcFee),
    brokerFee: d.brokerFee === undefined || d.brokerFee === null ? BROKER_FEE_DEFAULT : asText(d.brokerFee),
    personalProperty: asText(d.personalProperty),
    hoa: asYesNo(d.hoa),
    hoaAmount: asText(d.hoaAmount),
    solar: asYesNo(d.solar),
    solarLeasedOwned: slo === 'leased' || slo === 'owned' ? slo : '',
    solarAmount: asText(d.solarAmount),
    solarCompany: asText(d.solarCompany),
    pool: asYesNo(d.pool),
    escrowCompany: asText(d.escrowCompany),
    titleCompany: asText(d.titleCompany),
    nhdCompany: asText(d.nhdCompany),
    warrantyCompany: asText(d.warrantyCompany),
    warrantyAmount: asText(d.warrantyAmount),
  };
}

/**
 * Completion count, mirroring the mockup's recount(): every VISIBLE Yes/No
 * group counts 1 when answered, every VISIBLE text input counts 1 when
 * non-empty. Hidden conditional blocks and hidden seller blocks do not
 * count. Prefilled fees count as filled (they are real values).
 */
export function countTcIntake(data: TcIntakeData): {
  filled: number;
  total: number;
  complete: boolean;
} {
  let total = 0;
  let filled = 0;
  const yn = (v: TcYesNo) => {
    total++;
    if (v === 'yes' || v === 'no') filled++;
  };
  const tx = (v: string) => {
    total++;
    if (v.trim() !== '') filled++;
  };
  yn(data.ownerOccupied);
  yn(data.inTrust);
  if (data.inTrust === 'yes') {
    tx(data.trustName);
    tx(data.trustDate);
    tx(data.trusteeNames);
    tx(data.trusteeEmails);
  }
  for (const s of data.sellers) {
    tx(s.name);
    tx(s.phone);
    tx(s.email);
  }
  tx(data.listPrice);
  tx(data.contractBegin);
  tx(data.contractEnd);
  tx(data.mlsDate);
  yn(data.buyingAnother);
  if (data.buyingAnother === 'yes') yn(data.homeOfChoice);
  tx(data.totalPct);
  tx(data.buyerPct);
  tx(data.tcFee);
  tx(data.brokerFee);
  tx(data.personalProperty);
  yn(data.hoa);
  if (data.hoa === 'yes') tx(data.hoaAmount);
  yn(data.solar);
  if (data.solar === 'yes') {
    tx(data.solarLeasedOwned);
    tx(data.solarAmount);
    tx(data.solarCompany);
  }
  yn(data.pool);
  tx(data.escrowCompany);
  tx(data.titleCompany);
  tx(data.nhdCompany);
  tx(data.warrantyCompany);
  tx(data.warrantyAmount);
  return { filled, total, complete: total > 0 && filled === total };
}

/**
 * Entry-row status line (mockup ①): "Not started" until anything is saved,
 * then "X of Y filled", then "Complete".
 */
export function describeTcIntakeStatus(data: TcIntakeData | null): {
  text: string;
  started: boolean;
  complete: boolean;
} {
  if (!data) return { text: 'Not started', started: false, complete: false };
  const { filled, total, complete } = countTcIntake(data);
  if (complete) return { text: 'Complete', started: true, complete: true };
  return { text: `${filled} of ${total} filled`, started: true, complete: false };
}

/**
 * Realtor entry-row visibility (mockup ①): listing-side escrows only —
 * single-role seller escrows and the seller tab of dual-agency escrows.
 * Buyer-side never renders it.
 */
export function showTcIntakeForRealtorSide(
  side: 'buy' | 'sell' | 'both',
  tab: 'buyer' | 'seller',
): boolean {
  if (side === 'sell') return true;
  if (side === 'both') return tab === 'seller';
  return false;
}

/** TC card visibility (mockup ④): listing-side escrows only. */
export function showTcDetailsForTcView(sellerSidePresent: boolean): boolean {
  return sellerSidePresent;
}

/** "Jan 12, 2020" from "2020-01-12"; '' when empty or invalid. */
export function formatTcIntakeDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return '';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const year = Number(m[1]);
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return '';
  return `${months[mo - 1]} ${day}, ${year}`;
}

const NOT_PROVIDED = 'Not provided';

function ynText(v: TcYesNo): string {
  if (v === 'yes') return 'Yes';
  if (v === 'no') return 'No';
  return '';
}

export interface TcIntakeRow {
  label: string;
  value: string;
  /** False renders the muted "Not provided" treatment. */
  provided: boolean;
}

export interface TcIntakeSection {
  title: string;
  rows: TcIntakeRow[];
}

function row(label: string, value: string): TcIntakeRow {
  const v = value.trim();
  return { label, value: v === '' ? NOT_PROVIDED : v, provided: v !== '' };
}

/**
 * The sectioned intake model, mirroring the mockup's buildSummary field
 * for field. Consumed by the TC read-only page (multi-line values) and
 * the share-text builder (values joined to one line).
 */
export function buildTcIntakeSections(
  data: TcIntakeData,
  fullAddress: string,
): TcIntakeSection[] {
  const contract = [formatTcIntakeDate(data.contractBegin), formatTcIntakeDate(data.contractEnd)]
    .filter(Boolean)
    .join(' - ');
  const fee =
    data.tcFee.trim() !== '' && data.brokerFee.trim() !== ''
      ? `$${data.tcFee.trim()} + $${data.brokerFee.trim()}`
      : '';
  const hoaValue =
    data.hoa === 'yes'
      ? `Yes${data.hoaAmount.trim() !== '' ? `, ${data.hoaAmount.trim()}/mo` : ''}`
      : data.hoa === 'no'
        ? 'No'
        : '';
  const solarParts =
    data.solar === 'yes'
      ? [
          data.solarLeasedOwned === 'leased'
            ? 'Leased'
            : data.solarLeasedOwned === 'owned'
              ? 'Owned'
              : 'Yes',
          data.solarAmount.trim(),
          data.solarCompany.trim(),
        ].filter(Boolean)
      : [];
  const solarValue = data.solar === 'yes' ? solarParts.join(', ') : data.solar === 'no' ? 'No' : '';
  const warranty = [data.warrantyCompany.trim(), data.warrantyAmount.trim()]
    .filter(Boolean)
    .join(', ');

  const propertyRows: TcIntakeRow[] = [
    row('Owner occupied', ynText(data.ownerOccupied)),
    row('In a trust', ynText(data.inTrust)),
  ];
  if (data.inTrust === 'yes') {
    propertyRows.push(
      row('Trust name', data.trustName),
      row('Trustees', data.trusteeNames),
      row('Trustee emails', data.trusteeEmails),
    );
  }

  const sellerRows: TcIntakeRow[] = data.sellers.map((s, i) => {
    const parts = [s.name.trim(), s.phone.trim(), s.email.trim()].filter(Boolean);
    return row(`Seller ${i + 1}`, parts.join('\n'));
  });

  const termsRows: TcIntakeRow[] = [
    row('List price', data.listPrice),
    row('Contract', contract),
    row('Active on MLS', formatTcIntakeDate(data.mlsDate)),
    row('Buying another home', ynText(data.buyingAnother)),
  ];
  if (data.buyingAnother === 'yes') {
    termsRows.push(row('Home of choice contingency', ynText(data.homeOfChoice)));
  }

  return [
    { title: `Property · ${fullAddress}`, rows: propertyRows },
    { title: 'Sellers', rows: sellerRows },
    { title: 'Listing terms', rows: termsRows },
    {
      title: 'Commission',
      rows: [
        row('Your total', data.totalPct.trim() !== '' ? `${data.totalPct.trim()}%` : ''),
        row("Buyer's agent offer", data.buyerPct.trim() !== '' ? `${data.buyerPct.trim()}%` : ''),
        row('TC / Broker fee', fee),
      ],
    },
    {
      title: 'Property details',
      rows: [
        row('Personal property', data.personalProperty),
        row('HOA', hoaValue),
        row('Solar', solarValue),
        row('Pool', ynText(data.pool)),
      ],
    },
    {
      title: 'Vendors',
      rows: [
        row('Escrow', data.escrowCompany),
        row('Title', data.titleCompany),
        row('NHD', data.nhdCompany),
        row('Home warranty', warranty),
      ],
    },
  ];
}

/**
 * The plain-text handoff (mockup ③), built from the currently displayed
 * form values. Sectioned, "Not provided" for unfilled values. This is a
 * local share-sheet payload — never a server write.
 */
export function buildTcIntakeShareText(data: TcIntakeData, fullAddress: string): string {
  const lines: string[] = [];
  for (const sec of buildTcIntakeSections(data, fullAddress)) {
    lines.push(sec.title);
    for (const r of sec.rows) {
      lines.push(`${r.label}: ${r.value.replace(/\n/g, ', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
