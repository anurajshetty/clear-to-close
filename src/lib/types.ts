// Clear to Close — core domain types.
// These contracts are shared across workstreams; do not change names/shapes.

export type Side = 'buy' | 'sell' | 'both';

export type ClientRole = 'buyer' | 'seller' | 'tc';

export interface StepT {
  id: string;
  title: string;
  subtitle: string;
  done: boolean;
  custom: boolean;
  order: number;
  completedAt: string | null;
  /**
   * Step explainer (Sept 28, 2026, Anuraj-approved): the realtor's optional
   * one-line "What does this step mean?" on custom steps, shown when the
   * client taps the row. Default steps resolve their one-liner from the
   * bundled inventory (src/lib/stepExplainers.ts) via templateKey below;
   * null/blank means the row does not expand. Cloud-synced (migration 0019).
   */
  explainer?: string | null;
  /**
   * Permanent template key (Sept 28, 2026, Anuraj): stamped from
   * StepTemplate.key at creation for default steps; null for custom steps.
   * The ONLY thing explainer resolution trusts — titles are realtor-editable
   * and are never used for lookup. Older steps backfill it by title match
   * (src/lib/steps.ts backfillTemplateKey). Cloud-synced (migration 0020).
   */
  templateKey?: string | null;
}

/**
 * A checklist side as drafted by edit mode (Sept 28, 2026): the full new
 * step list for one role. Steps keep their ids when unchanged; new steps
 * arrive without an id and the store mints one. Order is the array order.
 */
export interface ChecklistDraftStep {
  id?: string;
  title: string;
  subtitle?: string;
  done: boolean;
  custom: boolean;
  completedAt?: string | null;
  /**
   * Realtor-written explainer for a new custom step (the add-custom form's
   * optional "What does this step mean?"). Committed with the checklist
   * save; preserved from the previous step when the draft omits it.
   */
  explainer?: string | null;
  /**
   * Template key passthrough: preserved from the previous step when a draft
   * edits a default step, so a rename in edit mode keeps its explainer.
   */
  templateKey?: string | null;
}

/**
 * Result of a bulk checklist apply: the escrow plus the ids of steps the
 * edit removed, so the server effect can delete exactly those rows.
 */
export interface ApplyChecklistResult {
  escrow: Escrow;
  removedStepIds: string[];
}

/**
 * The single most recent realtor action on an escrow's checklist, stamped
 * on every check/uncheck. The client home's "LATEST FROM" card reflects
 * reality — forward AND backward moves (neutral wording, no blame). An
 * uncheck leaves no completedAt behind, so the action is recorded
 * explicitly (migration 0009 adds the escrows.last_action JSONB column).
 */
export interface RealtorAction {
  kind: 'checked' | 'reopened';
  stepTitle: string;
  /** ISO timestamp of the action. */
  at: string;
}

export interface Escrow {
  id: string;
  address: string;
  city: string;
  side: Side;
  buyerName: string | null;
  sellerName: string | null;
  openDate: string;
  closeDate: string;
  buyerSteps: StepT[];
  sellerSteps: StepT[];
  /** open | closed | cancelled ('cancelled' added for the deal-list edit/cancel round, Sept 2026). */
  status: 'open' | 'closed' | 'cancelled';
  /**
   * Per-side close dates (local 'YYYY-MM-DD'). Escrow lifecycle, Sept 2026:
   * closing is per side — dual-agency escrows close the buyer and seller
   * sides independently. `status` is derived: 'closed' only when every side
   * of the escrow is closed. Local-only (not cloud-synced); `status` still
   * syncs via the escrows row.
   */
  buyerClosedAt: string | null;
  sellerClosedAt: string | null;
  /**
   * Key dates (Sept 28, 2026, Anuraj-approved): realtor-entered on the
   * "Update escrow" sheet, shown read-only on the client KEY DATES card.
   * Local 'YYYY-MM-DD', null until the realtor sets one. Escrow-level
   * (not per side): both sides of a dual-agency escrow share them.
   * Cloud-synced (migration 0019). Optional on the type so snapshots and
   * fixtures written before this release still compile; createEscrow
   * always initializes them to null.
   */
  inspectionDeadline?: string | null;
  appraisalDeadline?: string | null;
  loanApprovalDate?: string | null;
  createdAt: string;
  /**
   * The most recent realtor check/uncheck on this escrow (see
   * RealtorAction). Optional: escrows created before the field existed
   * simply don't carry it.
   */
  lastAction?: RealtorAction | null;
}

export interface CreateEscrowInput {
  address: string;
  /**
   * Optional (Sept 28, 2026, Anuraj): the new/edit escrow form no longer
   * asks for a city. New escrows store ''. The DB column stays NOT NULL and
   * existing rows keep their city.
   */
  city?: string;
  side: Side;
  buyerName?: string;
  sellerName?: string;
  openDate: string;
  closeDate: string;
}

/**
 * Edit-round input (Sept 2026): same fields as creation — the "Update
 * escrow" sheet is field-identical to the new-escrow form, everything
 * editable including side switching. Status and steps are never touched by
 * an update.
 */
export interface UpdateEscrowInput {
  address: string;
  /** Optional: when omitted the stored city is preserved (see CreateEscrowInput). */
  city?: string;
  side: Side;
  buyerName?: string;
  sellerName?: string;
  openDate: string;
  closeDate: string;
  /**
   * Key dates (Sept 28, 2026): optional; when omitted the stored values are
   * preserved. Explicit null clears a previously set date. The New-escrow
   * form never sends these (minimum input) — edit flow only.
   */
  inspectionDeadline?: string | null;
  appraisalDeadline?: string | null;
  loanApprovalDate?: string | null;
}

export interface RealtorProfile {
  name: string;
  photoUri: string | null;
  /**
   * Public Supabase Storage URL of the profile photo (Sept 2026,
   * Anuraj-approved): uploaded on profile save so client devices can see it.
   * Null until the first successful upload. `photoUri` (the local managed
   * file) remains the offline source and the display fallback.
   */
  photoRemoteUrl: string | null;
  /**
   * Public Supabase Storage URL of the banner image (Sept 2026) — same
   * upload/fallback contract as photoRemoteUrl. `banner_image` (the local
   * managed file) remains the offline source and the display fallback.
   */
  bannerRemoteUrl: string | null;
  about: string;
  yearsExperience: string;
  /** Optional email (Sept 2026) — kept on the realtor side only. */
  email: string;
  areasServed: string;
  phone: string;
  /** Optional DRE / license number — shown on the client profile only if entered. */
  dreLicense: string;
  /**
   * Optional realty group / brokerage (Sept 2026) — shown on the branded
   * client surfaces per the approved branding mockups, e.g.
   * "Maya Sharma / Compass Realty · DRE #01998877". Empty for profiles
   * saved before the field existed. Field name is contractual (another
   * agent reads it by name).
   */
  realty_group: string;
  /**
   * Optional banner image (Sept 2026) — wide image shown behind the client
   * home top card. One managed file, overwritten on every pick (same
   * pattern as the profile photo); null when none. Field name is
   * contractual (another agent reads it by name).
   */
  banner_image: string | null;
  /** Client reviews, newest first (Sept 2026). */
  reviews: Review[];
  /**
   * Average of review stars, null when there are no reviews (Sept 2026).
   * Contractual: the share-copy builder reads profile.rating by name.
   */
  rating: number | null;
}

/** A client review of the realtor (Sept 2026). Stored on the realtor's profile. */
export interface Review {
  /** Stable id (uuid). */
  id: string;
  /** Display name of the client who wrote it. */
  clientName: string;
  /** 1–5. */
  stars: number;
  /** One line of text (may be empty). */
  text: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface Invite {
  id: string;
  code: string;
  escrowId: string;
  role: ClientRole;
  partyName: string;
  createdAt: string;
  revokedAt: string | null;
  redeemedAt: string | null;
}

export type RedeemResult =
  | { ok: true; escrowId: string; role: ClientRole; partyName: string; linkId: string }
  | { ok: false; error: 'invalid' | 'name_mismatch' | 'revoked' | 'already_used' | 'network' };

/**
 * The inviting realtor's public branding for the branded invite welcome
 * (Sept 2026). Returned by resolve_invite_realtor / store.resolveInviteRealtor.
 */
export interface InviteRealtor {
  name: string;
  photoUrl: string | null;
  realtyGroup: string;
  dreLicense: string;
  realtorId: string;
  /** The invite's role: 'tc' for transaction coordinator, otherwise client. */
  role: ClientRole;
}

export type ResolveInviteError = 'invalid' | 'already_used' | 'revoked' | 'unknown' | 'network';

export interface ClientLink {
  id: string;
  escrowId: string;
  inviteId: string;
  role: ClientRole;
  partyName: string;
  createdAt: string;
  /** Device this link is bound to (0002 device linking). Null until redeemed. */
  deviceId: string | null;
  /** Set when the invite is regenerated or revoked — the link is dead. */
  revokedAt: string | null;
}

/** The client link as persisted on this device (the access key to the escrow). */
export interface DeviceClientLink {
  linkId: string;
  escrowId: string;
  role: ClientRole;
  partyName: string;
  deviceId: string;
}

export interface ClientView {
  escrowId: string;
  role: ClientRole;
  address: string;
  city: string;
  daysToClose: number;
  done: number;
  total: number;
  steps: StepT[];
  upNext: StepT | null;
  /** The id of this link's own review, if it posted one (Sept 2026). */
  myReviewId: string | null;
  /**
   * Escrow open / target-close dates (local 'YYYY-MM-DD'). Feed the client
   * top card's days-left line and the share copy's close-day math. Optional:
   * older or cloud views may omit them.
   */
  openDate?: string;
  closeDate?: string;
  /**
   * Key dates (Sept 28, 2026, Anuraj-approved): feeds the client home's
   * read-only "KEY DATES" card. Carried by get_client_view (the RPC
   * serializes the escrow row, migration 0019). Optional: older cached
   * cloud views may omit them; the card then shows its empty state.
   */
  inspectionDeadline?: string | null;
  appraisalDeadline?: string | null;
  loanApprovalDate?: string | null;
  /**
   * The realtor's id (auth user id) behind this escrow — feeds the public
   * profile URL in "Share {Name}'s profile". Present on cloud-linked views
   * (the RPC returns the escrow row's user_id); absent on the local-only
   * build, where the share copy then omits the profile link.
   */
  realtorId?: string;
  /**
   * The most recent realtor action on this escrow's checklist — feeds the
   * client home's "LATEST FROM" card. Absent on escrows last touched before
   * the field existed; the card then derives from the steps' completed_at
   * timestamps.
   */
  lastAction?: RealtorAction | null;
  /**
   * When the escrow was created (ISO). Fallback timestamp for the
   * "LATEST FROM" card when no step has ever been checked off:
   * "{Name} opened your escrow · {relative time}".
   */
  openedAt?: string;
  /**
   * Escrow lifecycle status (Sept 2026, Anuraj's rule): feeds the review
   * gate — a client can leave a review only at 100% on a non-cancelled
   * escrow. Optional: older cached cloud views may omit it; an absent
   * status fails open (the gate only ever hides on an explicit
   * 'cancelled').
   */
  status?: 'open' | 'closed' | 'cancelled';
  /**
   * Server-side escrow updated_at (ISO). Drives the multi-escrow list
   * ordering (Sept 28, 2026, Anuraj-approved): in-progress first, then
   * completed; most-recently-updated first within each group. Absent on
   * older cached views — those sort as oldest.
   */
  updatedAt?: string;
}

/**
 * Transaction coordinator view (Sept 2026): on a both-side escrow the TC
 * sees BOTH checklists; on a single-side escrow the active side's. Each
 * active side reuses ClientView; an inactive side is null (never an empty
 * list that could be mistaken for "no steps").
 */
export interface TcView {
  escrowId: string;
  address: string;
  city: string;
  daysToClose: number;
  /** Buyer side, or null when the escrow has no buyer side. */
  buyer: ClientView | null;
  /** Seller side, or null when the escrow has no seller side. */
  seller: ClientView | null;
}
