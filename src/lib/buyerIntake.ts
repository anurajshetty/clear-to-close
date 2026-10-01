// Clear to Close — Buyer intake v1 (Oct 1, 2026, Anuraj-approved mockup 08).
//
// The realtor fills this once per buyer-side escrow; the TC reads it
// (in-app read-only view or the realtor's manual share). Buyer and seller
// client views never see any of it.
//
// This module is the SINGLE sectioned-intake model shared by three
// consumers: the realtor's plain-text share builder, the TC read-only
// details page, and the completion counter. No divergent copies. It mirrors
// src/lib/tcIntake.ts field for field in structure (normalize / count /
// describe-status / sections / share text / side-gating), so the two
// intakes stay consistent.
//
// Pure logic only (no React): fully covered by tests/buyer_intake.test.ts.

import { formatTcIntakeDate } from './tcIntake';
import type { Escrow } from './types';

/** A Yes/No answer; '' = unanswered (nothing is assumed — mockup rule). */
export type BuyerYesNo = '' | 'yes' | 'no';

export interface BuyerIntakeBuyer {
  name: string;
  phone: string;
  email: string;
}

export interface BuyerIntakeData {
  // Agent
  agentName: string;
  agentEmail: string;
  // Buyers: 1..3 visible blocks.
  buyers: BuyerIntakeBuyer[];
  // Offer terms
  /** The intake's own address value (editable text input, Anuraj Oct 1 —
   * unlike the TC intake's shown-never-typed address, this one is typed). */
  offerAddress: string;
  purchasePrice: string;
  /** Plain amount field (Anuraj, Oct 1): explicitly NOT linked to the
   * "Earnest money wired" checklist item — no cross-referencing. */
  deposit: string;
  downPayment: string;
  loanAmount: string;
  // Dates (both optional)
  /** YYYY-MM-DD or ''. */
  closeOfEscrow: string;
  /** YYYY-MM-DD or ''. */
  possession: string;
  // Contingencies
  saleOfBuyersProperty: BuyerYesNo;
  investigation: BuyerYesNo;
  /** Number of days; counted only when investigation === 'yes'. */
  investigationDays: string;
  appraisal: BuyerYesNo;
  /** Number of days; counted only when appraisal === 'yes'. */
  appraisalDays: string;
  loan: BuyerYesNo;
  /** Number of days; counted only when loan === 'yes'. */
  loanDays: string;
  // Property details
  personalProperty: string;
  hoa: BuyerYesNo;
  hoaAmount: string;
  solar: BuyerYesNo;
  solarLeasedOwned: '' | 'leased' | 'owned';
  solarAmount: string;
  pool: BuyerYesNo;
  warrantyCompany: string;
  warrantyTerms: string;
  warrantyAmount: string;
}

/** Maximum buyer blocks (mockup ②, same cap as sellers on the TC form). */
export const BUYER_INTAKE_MAX_BUYERS = 3;

export function emptyBuyerIntakeBuyer(): BuyerIntakeBuyer {
  return { name: '', phone: '', email: '' };
}

export function emptyBuyerIntake(): BuyerIntakeData {
  return {
    agentName: '',
    agentEmail: '',
    buyers: [emptyBuyerIntakeBuyer()],
    offerAddress: '',
    purchasePrice: '',
    deposit: '',
    downPayment: '',
    loanAmount: '',
    closeOfEscrow: '',
    possession: '',
    saleOfBuyersProperty: '',
    investigation: '',
    investigationDays: '',
    appraisal: '',
    appraisalDays: '',
    loan: '',
    loanDays: '',
    personalProperty: '',
    hoa: '',
    hoaAmount: '',
    solar: '',
    solarLeasedOwned: '',
    solarAmount: '',
    pool: '',
    warrantyCompany: '',
    warrantyTerms: '',
    warrantyAmount: '',
  };
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asYesNo(v: unknown): BuyerYesNo {
  return v === 'yes' || v === 'no' ? v : '';
}

function asBuyer(v: unknown): BuyerIntakeBuyer {
  const b = (v ?? {}) as Record<string, unknown>;
  return { name: asText(b.name), phone: asText(b.phone), email: asText(b.email) };
}

/**
 * Defensive coercion of untrusted JSON (server jsonb) into the intake shape.
 * Unknown/mistyped values fall back to empty — a corrupt row renders
 * "Not provided", never crashes.
 */
export function normalizeBuyerIntake(raw: unknown): BuyerIntakeData {
  const d = (raw ?? {}) as Record<string, unknown>;
  const buyersRaw = Array.isArray(d.buyers) ? d.buyers : [];
  const buyers = buyersRaw.slice(0, BUYER_INTAKE_MAX_BUYERS).map(asBuyer);
  if (buyers.length === 0) buyers.push(emptyBuyerIntakeBuyer());
  const slo = d.solarLeasedOwned;
  return {
    agentName: asText(d.agentName),
    agentEmail: asText(d.agentEmail),
    buyers,
    offerAddress: asText(d.offerAddress),
    purchasePrice: asText(d.purchasePrice),
    deposit: asText(d.deposit),
    downPayment: asText(d.downPayment),
    loanAmount: asText(d.loanAmount),
    closeOfEscrow: asText(d.closeOfEscrow),
    possession: asText(d.possession),
    saleOfBuyersProperty: asYesNo(d.saleOfBuyersProperty),
    investigation: asYesNo(d.investigation),
    investigationDays: asText(d.investigationDays),
    appraisal: asYesNo(d.appraisal),
    appraisalDays: asText(d.appraisalDays),
    loan: asYesNo(d.loan),
    loanDays: asText(d.loanDays),
    personalProperty: asText(d.personalProperty),
    hoa: asYesNo(d.hoa),
    hoaAmount: asText(d.hoaAmount),
    solar: asYesNo(d.solar),
    solarLeasedOwned: slo === 'leased' || slo === 'owned' ? slo : '',
    solarAmount: asText(d.solarAmount),
    pool: asYesNo(d.pool),
    warrantyCompany: asText(d.warrantyCompany),
    warrantyTerms: asText(d.warrantyTerms),
    warrantyAmount: asText(d.warrantyAmount),
  };
}

/**
 * Completion count, mirroring the mockup's recount(): every VISIBLE Yes/No
 * group counts 1 when answered, every VISIBLE text input counts 1 when
 * non-empty. Hidden conditional blocks and hidden buyer blocks do not
 * count. With one buyer block and no Yes answers the total is 23
 * (the mockup's "5 of 23 filled" for the auto-filled draft).
 */
export function countBuyerIntake(data: BuyerIntakeData): {
  filled: number;
  total: number;
  complete: boolean;
} {
  let total = 0;
  let filled = 0;
  const yn = (v: BuyerYesNo) => {
    total++;
    if (v === 'yes' || v === 'no') filled++;
  };
  const tx = (v: string) => {
    total++;
    if (v.trim() !== '') filled++;
  };
  tx(data.agentName);
  tx(data.agentEmail);
  for (const b of data.buyers) {
    tx(b.name);
    tx(b.phone);
    tx(b.email);
  }
  tx(data.offerAddress);
  tx(data.purchasePrice);
  tx(data.deposit);
  tx(data.downPayment);
  tx(data.loanAmount);
  tx(data.closeOfEscrow);
  tx(data.possession);
  yn(data.saleOfBuyersProperty);
  yn(data.investigation);
  if (data.investigation === 'yes') tx(data.investigationDays);
  yn(data.appraisal);
  if (data.appraisal === 'yes') tx(data.appraisalDays);
  yn(data.loan);
  if (data.loan === 'yes') tx(data.loanDays);
  tx(data.personalProperty);
  yn(data.hoa);
  if (data.hoa === 'yes') tx(data.hoaAmount);
  yn(data.solar);
  if (data.solar === 'yes') {
    tx(data.solarLeasedOwned);
    tx(data.solarAmount);
  }
  yn(data.pool);
  tx(data.warrantyCompany);
  tx(data.warrantyTerms);
  tx(data.warrantyAmount);
  return { filled, total, complete: total > 0 && filled === total };
}

/**
 * Entry-row status line (mockup ①): "Not started" until anything is saved,
 * then "X of Y filled", then "Complete".
 */
export function describeBuyerIntakeStatus(data: BuyerIntakeData | null): {
  text: string;
  started: boolean;
  complete: boolean;
} {
  if (!data) return { text: 'Not started', started: false, complete: false };
  const { filled, total, complete } = countBuyerIntake(data);
  if (complete) return { text: 'Complete', started: true, complete: true };
  return { text: `${filled} of ${total} filled`, started: true, complete: false };
}

/**
 * Realtor entry-row visibility (mockup ①): buyer-side escrows only —
 * single-role buyer escrows and the buyer tab of dual-agency escrows.
 * Seller-side never renders it. Mirrors showTcIntakeForRealtorSide.
 */
export function showBuyerIntakeForRealtorSide(
  side: 'buy' | 'sell' | 'both',
  tab: 'buyer' | 'seller',
): boolean {
  if (side === 'buy') return true;
  if (side === 'both') return tab === 'buyer';
  return false;
}

/** TC card visibility (mockup ④): buyer-side escrows only. */
export function showBuyerDetailsForTcView(buyerSidePresent: boolean): boolean {
  return buyerSidePresent;
}

/**
 * Soft math check (Anuraj, Oct 1): when purchase price, down payment, and
 * loan amount are ALL filled, the price should equal down + loan. Returns
 * the gentle inline note when they disagree, null otherwise. Warning only —
 * the form never blocks saving.
 */
export function checkBuyerIntakeMath(data: BuyerIntakeData): string | null {
  const parse = (s: string): number | null => {
    const n = parseFloat(s.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && s.trim() !== '' ? n : null;
  };
  const price = parse(data.purchasePrice);
  const down = parse(data.downPayment);
  const loan = parse(data.loanAmount);
  if (price === null || down === null || loan === null) return null;
  if (Math.abs(price - (down + loan)) < 0.005) return null;
  return 'Purchase price does not match down payment plus loan amount. Worth a second look.';
}

const NOT_PROVIDED = 'Not provided';

function ynText(v: BuyerYesNo): string {
  if (v === 'yes') return 'Yes';
  if (v === 'no') return 'No';
  return '';
}

export interface BuyerIntakeRow {
  label: string;
  value: string;
  /** False renders the muted "Not provided" treatment. */
  provided: boolean;
}

export interface BuyerIntakeSection {
  title: string;
  rows: BuyerIntakeRow[];
}

function row(label: string, value: string): BuyerIntakeRow {
  const v = value.trim();
  return { label, value: v === '' ? NOT_PROVIDED : v, provided: v !== '' };
}

/**
 * The sectioned intake model, mirroring the mockup's device-③ summary
 * field for field. Consumed by the TC read-only page (multi-line values)
 * and the share-text builder (values joined to one line).
 */
export function buildBuyerIntakeSections(
  data: BuyerIntakeData,
  fullAddress: string,
): BuyerIntakeSection[] {
  const money = (v: string) => {
    const t = v.trim();
    if (t === '') return '';
    return t.startsWith('$') ? t : `$${t}`;
  };
  const contingencyValue = (v: BuyerYesNo, days: string): string => {
    if (v === 'yes') {
      const d = days.trim();
      return d !== '' ? `Yes, ${d} days` : 'Yes';
    }
    if (v === 'no') return 'No';
    return '';
  };
  const hoaValue =
    data.hoa === 'yes'
      ? `Yes${data.hoaAmount.trim() !== '' ? `, ${money(data.hoaAmount)}/month` : ''}`
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
          money(data.solarAmount),
        ].filter(Boolean)
      : [];
  const solarValue =
    data.solar === 'yes' ? solarParts.join(', ') : data.solar === 'no' ? 'No' : '';

  const agentRows: BuyerIntakeRow[] = [
    row('Name', data.agentName),
    row('Email', data.agentEmail),
  ];

  const buyerRows: BuyerIntakeRow[] = data.buyers.map((b, i) => {
    const parts = [b.name.trim(), b.phone.trim(), b.email.trim()].filter(Boolean);
    return row(`Buyer ${i + 1}`, parts.join('\n'));
  });

  const offerRows: BuyerIntakeRow[] = [
    row('Property', data.offerAddress),
    row('Purchase price', money(data.purchasePrice)),
    row('Deposit', money(data.deposit)),
    row('Down payment', money(data.downPayment)),
    row('Loan amount', money(data.loanAmount)),
  ];

  const dateRows: BuyerIntakeRow[] = [
    row('Close of escrow', formatTcIntakeDate(data.closeOfEscrow)),
    row('Possession', formatTcIntakeDate(data.possession)),
  ];

  const contingencyRows: BuyerIntakeRow[] = [
    row("Sale of buyer's property", ynText(data.saleOfBuyersProperty)),
    row('Investigation', contingencyValue(data.investigation, data.investigationDays)),
    row('Appraisal', contingencyValue(data.appraisal, data.appraisalDays)),
    row('Loan', contingencyValue(data.loan, data.loanDays)),
  ];

  const warrantyParts = [data.warrantyCompany.trim(), data.warrantyTerms.trim(), money(data.warrantyAmount)].filter(
    Boolean,
  );

  const detailsRows: BuyerIntakeRow[] = [
    row('Personal property', data.personalProperty),
    row('HOA', hoaValue),
    row('Solar', solarValue),
    row('Pool', ynText(data.pool)),
    row('Warranty', warrantyParts.join('\n')),
  ];

  return [
    { title: 'Agent', rows: agentRows },
    { title: 'Buyers', rows: buyerRows },
    { title: 'Offer terms', rows: offerRows },
    { title: 'Dates', rows: dateRows },
    { title: 'Contingencies', rows: contingencyRows },
    { title: 'Property details', rows: detailsRows },
  ];
}

/**
 * The plain-text handoff (mockup ③), built from the currently displayed
 * form values. Sectioned, "Not provided" for unfilled values. This is a
 * local share-sheet payload — never a server write.
 */
export function buildBuyerIntakeShareText(data: BuyerIntakeData, fullAddress: string): string {
  const lines: string[] = [];
  lines.push(`Buyer intake · ${fullAddress}`);
  lines.push('');
  for (const sec of buildBuyerIntakeSections(data, fullAddress)) {
    lines.push(sec.title);
    for (const r of sec.rows) {
      lines.push(`${r.label}: ${r.value.replace(/\n/g, ', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Auto-fill seed for a fresh draft (mockup ②): agent name + email from the
 * realtor profile, Buyer 1 name from escrow.buyerName (falling back to the
 * first buyer invite's party name), offer address and close-of-escrow from
 * the escrow. Everything stays editable. Returns the seeded data plus the
 * seed values themselves so the screen can show the "Auto-filled" pill
 * only while a field still carries its seeded value.
 */
export function autoFillBuyerIntake(
  profile: { name: string; email: string } | null,
  escrow: Pick<Escrow, 'buyerName' | 'address' | 'closeDate'>,
  buyerInvites: { partyName: string }[],
): { data: BuyerIntakeData; seed: Record<string, string> } {
  const data = emptyBuyerIntake();
  const seed: Record<string, string> = {};
  const setSeed = (key: string, value: string) => {
    if (value.trim() !== '') seed[key] = value;
  };
  if (profile) {
    if (profile.name.trim() !== '') {
      data.agentName = profile.name.trim();
      setSeed('agentName', data.agentName);
    }
    if (profile.email.trim() !== '') {
      data.agentEmail = profile.email.trim();
      setSeed('agentEmail', data.agentEmail);
    }
  }
  const buyerName =
    (escrow.buyerName ?? '').trim() !== ''
      ? (escrow.buyerName ?? '').trim()
      : (buyerInvites[0]?.partyName ?? '').trim();
  if (buyerName !== '') {
    data.buyers[0].name = buyerName;
    setSeed('buyer1Name', buyerName);
  }
  if (escrow.address.trim() !== '') {
    data.offerAddress = escrow.address.trim();
    setSeed('offerAddress', data.offerAddress);
  }
  if (escrow.closeDate.trim() !== '') {
    data.closeOfEscrow = escrow.closeDate.trim();
    setSeed('closeOfEscrow', data.closeOfEscrow);
  }
  return { data, seed };
}
