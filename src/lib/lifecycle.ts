// Clear to Close — escrow lifecycle helpers.
// Per-side close semantics (approved mockup 01, Sept 2026): closing is per
// side — a dual-agency escrow closes its buyer and seller sides
// independently. Unchecking any step in a closed side moves that side back
// to Active. The escrow-level `status` is derived: 'closed' only when every
// side of the escrow is closed.
import type { ClientRole, Escrow, Side } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today's date as a local 'YYYY-MM-DD' (never UTC-shifted). */
export function todayLocalISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** The closed-at date for one side, or null when that side is active. */
export function sideClosedAt(e: Escrow, role: ClientRole): string | null {
  const d = role === 'buyer' ? e.buyerClosedAt : e.sellerClosedAt;
  return typeof d === 'string' ? d : null;
}

/** Whether one checklist side is closed. */
export function isSideClosed(e: Escrow, role: ClientRole): boolean {
  return sideClosedAt(e, role) !== null;
}

/**
 * Whether the whole escrow reads as closed on the deal list: single-side
 * escrows are closed when their side is closed; dual-agency escrows are
 * closed only when BOTH sides are closed. Pure per-side-date logic — used by
 * applyDerivedStatus, so it must NOT consult e.status (that would make the
 * derived status self-reinforcing and unchecking could never reopen).
 */
export function isEscrowClosed(e: Escrow): boolean {
  if (e.side === 'buy') return isSideClosed(e, 'buyer');
  if (e.side === 'sell') return isSideClosed(e, 'seller');
  return isSideClosed(e, 'buyer') && isSideClosed(e, 'seller');
}

/**
 * Deal-list row predicate: closed by per-side dates, or a legacy 'closed'
 * status (rows closed before per-side dates existed). Legacy rows keep their
 * status until the next step mutation, which normalizes them to the new
 * model via applyDerivedStatus.
 */
export function isClosedRow(e: Escrow): boolean {
  return e.status === 'closed' || isEscrowClosed(e);
}

/** The role list that carries checklists for an escrow side. */
export function sideRoles(side: Side): ClientRole[] {
  if (side === 'buy') return ['buyer'];
  if (side === 'sell') return ['seller'];
  return ['buyer', 'seller'];
}

/**
 * Recompute the derived escrow-level status from the per-side closed dates.
 * Call after any close/reopen mutation, before persist().
 */
export function applyDerivedStatus(e: Escrow): void {
  e.status = isEscrowClosed(e) ? 'closed' : 'open';
}

/** "2026-09-25" -> "Sep 25, 2026" (mockup: "Closed Sep 25, 2026."). */
export function formatClosedDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

/**
 * The display date for a closed escrow's "Closed" chip/indicator: the later
 * of the two sides' close dates on dual agency, the side's own date
 * otherwise.
 */
export function closedDisplayDate(e: Escrow): string | null {
  const dates = [e.buyerClosedAt, e.sellerClosedAt].filter(
    (d): d is string => d !== null,
  );
  if (dates.length === 0) return null;
  return dates.sort()[dates.length - 1];
}
