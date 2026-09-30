// Clear to Close — shared escrow form sheet.
// The new-escrow form (approved mockup 01 · device ⑥, Sept 25 revision),
// shared by creation and editing (Sept 2026 edit round): the "Update escrow"
// sheet is field-identical to the new-escrow form, with every value
// pre-populated and editable. Side locking (Sept 28, 2026, Anuraj): the
// side picker is non-interactive in the edit flow (lockSide) — no more
// buyer↔seller switches after creation. The new-escrow flow is two-phase
// (confirmCreate): submit validates, then shows a confirmation summary
// ("Create escrow" / "Back to edit") instead of creating immediately.
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  DEFAULT_SIDE_SELECTION,
  nameFieldMode,
  selectionToSide,
  sideToSelection,
  toggleSide,
  type SideSelection,
} from '../lib/sidePicker';
import type { CreateEscrowInput, Escrow, Side, UpdateEscrowInput } from '../lib/types';
import { confirmSummaryRows } from '../lib/escrowConfirm';
import { Field, Kicker, PrimaryButton, SecondaryButton, Sheet } from '../components/ui';
import DateField from './DateField';
import { colors } from '../theme';

export interface EscrowFormInitial {
  address: string;
  side: Side;
  buyerName: string;
  sellerName: string;
  openDate: string;
  closeDate: string;
  /** Escrow lifecycle status: drives the key-dates lock (Sept 28, 2026). */
  status: Escrow['status'];
  /** Key dates (Sept 28, 2026): edit mode only — pre-populated, nullable. */
  inspectionDeadline: string | null;
  appraisalDeadline: string | null;
  loanApprovalDate: string | null;
}

export function escrowToInitial(e: Escrow): EscrowFormInitial {
  return {
    address: e.address,
    side: e.side,
    buyerName: e.buyerName ?? '',
    sellerName: e.sellerName ?? '',
    openDate: e.openDate,
    closeDate: e.closeDate,
    status: e.status,
    inspectionDeadline: e.inspectionDeadline ?? null,
    appraisalDeadline: e.appraisalDeadline ?? null,
    loanApprovalDate: e.loanApprovalDate ?? null,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function toMs(v: string): number {
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

type ErrorKey =
  | 'address'
  | 'buyerName'
  | 'sellerName'
  | 'openDate'
  | 'closeDate'
  | 'inspectionDeadline'
  | 'appraisalDeadline'
  | 'loanApprovalDate'
  | 'submit';
type Errors = Partial<Record<ErrorKey, string>>;

function FieldWrap({ error, children }: { error?: string; children: React.ReactNode }) {
  return (
    <View style={styles.fieldWrap}>
      {children}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

interface EscrowFormSheetProps {
  visible: boolean;
  onClose: () => void;
  kicker: string;
  title: string;
  submitLabel: string;
  savingLabel: string;
  /** null = create mode (empty form); provided = edit mode (pre-populated). */
  initial: EscrowFormInitial | null;
  onSubmit: (input: CreateEscrowInput) => Promise<Escrow>;
  onDone: (escrow: Escrow) => void;
  /** Rendered below the submit button (e.g. the "Cancel this escrow" danger action). */
  footer?: React.ReactNode;
  /**
   * Replaces the entire sheet body (Sept 28, 2026): the Update sheet's
   * "Cancel this escrow" confirmation renders here, INSIDE the already-open
   * Modal. iOS silently drops a second Modal presented while another is
   * visible (verified in react-native 0.86.3), so the confirmation must
   * never be a stacked Sheet of its own.
   */
  confirmBody?: React.ReactNode;
  /**
   * Side lock (Sept 28, 2026, Anuraj): when true, the side picker is
   * non-interactive and just displays the current side (including 'both'
   * for older dual-agency escrows). The side value submits unchanged —
   * no more buyer↔seller switches after creation. The edit and activate
   * flows pass this; the new-escrow flow does not.
   */
  lockSide?: boolean;
  /**
   * Two-phase create (Sept 28, 2026, Anuraj): when true, the form
   * validates on submit but then shows a confirmation screen summarizing
   * the entered data instead of creating immediately. "Create escrow"
   * performs the create; "Back to edit" returns to the form with all
   * values preserved. New-escrow flow only — update/activate keep their
   * direct save.
   */
  confirmCreate?: boolean;
  /**
   * Reactivation (Sept 28, 2026, lifecycle gate, Anuraj-approved): on
   * closed/cancelled escrows the locked Key dates section shows a
   * "Reactivate escrow" button that invokes this — the ONLY path that
   * reactivates an escrow. The main submit button never reactivates; it
   * saves ordinary edits via onSubmit (key dates stay locked/preserved).
   * Absent = the locked section shows no reactivate button.
   */
  onReactivate?: (input: CreateEscrowInput) => Promise<Escrow>;
}

export function EscrowFormSheet({
  visible,
  onClose,
  kicker,
  title,
  submitLabel,
  savingLabel,
  initial,
  onSubmit,
  onDone,
  footer,
  confirmBody,
  lockSide,
  confirmCreate,
  onReactivate,
}: EscrowFormSheetProps) {
  const [sel, setSel] = useState<SideSelection>(DEFAULT_SIDE_SELECTION);
  const [address, setAddress] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [openDate, setOpenDate] = useState('');
  const [closeDate, setCloseDate] = useState('');
  // Key dates (Sept 28, 2026): optional, edit mode only. '' = not set.
  const [inspectionDeadline, setInspectionDeadline] = useState('');
  const [appraisalDeadline, setAppraisalDeadline] = useState('');
  const [loanApprovalDate, setLoanApprovalDate] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  // Key-dates lifecycle lock (Sept 28, 2026, Anuraj): only an open escrow
  // can have key dates edited. On closed/cancelled escrows the section
  // renders locked with a "Reactivate escrow" button instead.
  const keyDatesEditable = !!initial && initial.status === 'open';
  // Two-phase create: the validated input waiting on the confirmation
  // screen. null = form is showing (or the flow skips confirmation).
  const [confirming, setConfirming] = useState<CreateEscrowInput | null>(null);

  // (Re)initialize when the sheet OPENS: create starts empty, edit starts
  // pre-populated from the escrow. Keyed on the open transition (not on
  // `initial` identity) so a parent re-render mid-edit can never wipe the
  // form — the parent builds a fresh `initial` object every render.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (!visible || wasVisible.current) {
      wasVisible.current = visible;
      return;
    }
    wasVisible.current = true;
    setSel(initial ? sideToSelection(initial.side) : DEFAULT_SIDE_SELECTION);
    setAddress(initial?.address ?? '');
    setBuyerName(initial?.buyerName ?? '');
    setSellerName(initial?.sellerName ?? '');
    setOpenDate(initial?.openDate ?? '');
    setCloseDate(initial?.closeDate ?? '');
    setInspectionDeadline(initial?.inspectionDeadline ?? '');
    setAppraisalDeadline(initial?.appraisalDeadline ?? '');
    setLoanApprovalDate(initial?.loanApprovalDate ?? '');
    setErrors({});
    setSaving(false);
    setConfirming(null);
  });

  const side = selectionToSide(sel);
  const dual = nameFieldMode(sel) === 'dual';

  const handleClose = () => {
    onClose();
  };

  const clear = (k: ErrorKey) =>
    setErrors((prev) => (prev[k] ? { ...prev, [k]: undefined } : prev));

  const validate = (): boolean => {
    const e: Errors = {};
    // Every required field gets its own inline message (Sept 2026): no
    // generic banner for validation failures. Sentence case, plain words.
    if (!address.trim()) e.address = 'Please enter the property address.';
    // The side picker always keeps one side selected (toggleSide guard), so
    // the side itself needs no error; the client-name wording follows the
    // field label ("Client name" single side vs "Buyer/Seller name" dual).
    if (sel.buy && !buyerName.trim()) {
      e.buyerName = dual
        ? "Please enter the buyer's name."
        : "Please enter the client's name.";
    }
    if (sel.sell && !sellerName.trim()) {
      e.sellerName = dual
        ? "Please enter the seller's name."
        : "Please enter the client's name.";
    }
    if (!openDate.trim()) {
      e.openDate = 'Please enter the escrow open date.';
    } else if (!isRealDate(openDate)) {
      e.openDate = 'Please use the format YYYY-MM-DD.';
    }
    if (!closeDate.trim()) {
      e.closeDate = 'Please enter the target close date.';
    } else if (!isRealDate(closeDate)) {
      e.closeDate = 'Please use the format YYYY-MM-DD.';
    } else if (isRealDate(openDate) && toMs(closeDate) < toMs(openDate)) {
      // The ONLY date rule (Sept 2026): the target close must not be before
      // the escrow open date. Equal is fine.
      e.closeDate = "The target close can't be before the opened date.";
    }
    // Key dates are optional — blank stays blank; a typed value must be a
    // real date. No ordering rules (the mockup defines none). Validated
    // only when the section is editable (open escrows); on closed or
    // cancelled escrows the section is locked and these stay untouched.
    if (keyDatesEditable) {
      if (inspectionDeadline.trim() && !isRealDate(inspectionDeadline)) {
        e.inspectionDeadline = 'Please use the format YYYY-MM-DD.';
      }
      if (appraisalDeadline.trim() && !isRealDate(appraisalDeadline)) {
        e.appraisalDeadline = 'Please use the format YYYY-MM-DD.';
      }
      if (loanApprovalDate.trim() && !isRealDate(loanApprovalDate)) {
        e.loanApprovalDate = 'Please use the format YYYY-MM-DD.';
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // The input carries the key dates too (Sept 28, 2026): UpdateEscrowInput
  // is a superset of CreateEscrowInput — the create flow's confirm screen
  // only reads the create fields, and createEscrow ignores the extras.
  const buildInput = (): UpdateEscrowInput => ({
    address: address.trim(),
    side,
    buyerName: sel.buy ? buyerName.trim() : undefined,
    sellerName: sel.sell ? sellerName.trim() : undefined,
    openDate,
    closeDate,
    // Key dates ride the same input (Sept 28, 2026): edit mode on open
    // escrows only — the create form never shows the section, so these
    // stay undefined there (undefined = preserve; the create path never
    // sends key dates). On closed/cancelled escrows the section is locked
    // and untouched, so the stored values are preserved. Blank = null
    // (clears a previously set date).
    inspectionDeadline:
      keyDatesEditable ? inspectionDeadline.trim() || null : undefined,
    appraisalDeadline:
      keyDatesEditable ? appraisalDeadline.trim() || null : undefined,
    loanApprovalDate:
      keyDatesEditable ? loanApprovalDate.trim() || null : undefined,
  });

  const performSave = async (input: CreateEscrowInput) => {
    setSaving(true);
    try {
      const done = await onSubmit(input);
      onDone(done);
    } catch (err) {
      console.warn('escrow form submit failed', err);
      setErrors((prev) => ({
        ...prev,
        // Synchronous writes (Sept 28, 2026): the store throws a
        // plain-language reason when the escrow is not confirmed on the
        // server — show it, so the realtor knows the save did not land.
        submit:
          err instanceof Error && err.message ? err.message : 'Could not save. Try again.',
      }));
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (saving || !validate()) return;
    const input = buildInput();
    // Two-phase create: validate now, but hold the input on the
    // confirmation screen — the real create happens on "Create escrow".
    if (confirmCreate && !confirming) {
      setConfirming(input);
      return;
    }
    await performSave(input);
  };

  // Reactivation (Sept 28, 2026, lifecycle gate): the locked Key dates
  // section's "Reactivate escrow" button. Validates the form, then invokes
  // onReactivate — the ONLY path that reactivates a closed/cancelled
  // escrow. The main submit button never takes this path.
  const reactivate = async () => {
    if (saving || !validate() || !onReactivate) return;
    const input = buildInput();
    setSaving(true);
    try {
      const done = await onReactivate(input);
      onDone(done);
    } catch (err) {
      console.warn('escrow reactivate failed', err);
      setErrors((prev) => ({
        ...prev,
        submit:
          err instanceof Error && err.message ? err.message : 'Could not reactivate. Try again.',
      }));
    } finally {
      setSaving(false);
    }
  };

  // The confirmation screen's "Create escrow" button: performs the held
  // create. A failure surfaces the submit error on the confirmation
  // screen, with "Back to edit" available.
  const confirmSave = async () => {
    if (saving || !confirming) return;
    await performSave(confirming);
  };

  const toggleCard = (
    which: 'buy' | 'sell',
    label: string,
    selected: boolean,
  ) => (
    <Pressable
      key={which}
      onPress={() => {
        setSel((prev) => toggleSide(prev, which));
        setErrors((p) => ({ ...p, buyerName: undefined, sellerName: undefined }));
      }}
      style={[styles.pick, selected && styles.pickSelected]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      testID={`side-${which}`}
    >
      <Text style={[styles.pickLabel, selected && styles.pickLabelSelected]}>
        {label}
      </Text>
    </Pressable>
  );

  // Locked side display (Sept 28, 2026, Anuraj): the edit/activate flows
  // show the current side with the same card styling but no interaction —
  // a View, not a Pressable, so there is no way to switch sides after
  // creation. Legacy 'both' escrows show both cards in the selected state.
  const lockedCard = (
    which: 'buy' | 'sell',
    label: string,
    selected: boolean,
  ) => (
    <View
      key={which}
      style={[styles.pick, selected && styles.pickSelected]}
      accessibilityRole="text"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      testID={`side-${which}-locked`}
    >
      <Text style={[styles.pickLabel, selected && styles.pickLabelSelected]}>
        {label}
      </Text>
    </View>
  );

  const renderSideRow = () => (
    <View style={styles.sideRow}>
      {lockSide ? (
        <>
          {lockedCard('buy', 'Buy side', sel.buy)}
          {lockedCard('sell', 'Sell side', sel.sell)}
        </>
      ) : (
        <>
          {toggleCard('buy', 'Buy side', sel.buy)}
          {toggleCard('sell', 'Sell side', sel.sell)}
        </>
      )}
    </View>
  );

  return (
    <Sheet visible={visible} onClose={handleClose}>
      {confirmBody ?? (confirming ? (
        <EscrowConfirmView
          kicker={kicker}
          input={confirming}
          saving={saving}
          savingLabel={savingLabel}
          submitError={errors.submit}
          onConfirm={confirmSave}
          onBackToEdit={() => setConfirming(null)}
        />
      ) : (
        <>
          <Kicker>{kicker}</Kicker>
          <Text style={styles.h2}>{title}</Text>

      <Text style={styles.label}>Which side are you representing?</Text>
      {renderSideRow()}

      <FieldWrap error={errors.address}>
        <Field
          label="Property address"
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            clear('address');
          }}
          placeholder="e.g. 4187 Oakmont Dr"
          testID="escrow-address"
        />
      </FieldWrap>

      {dual ? (
        <>
          <FieldWrap error={errors.buyerName}>
            <Field
              label="Buyer name"
              value={buyerName}
              onChangeText={(v) => {
                setBuyerName(v);
                clear('buyerName');
              }}
              placeholder="Buyer's name"
              testID="escrow-buyer-name"
            />
          </FieldWrap>
          <FieldWrap error={errors.sellerName}>
            <Field
              label="Seller name"
              value={sellerName}
              onChangeText={(v) => {
                setSellerName(v);
                clear('sellerName');
              }}
              placeholder="Seller's name"
              testID="escrow-seller-name"
            />
          </FieldWrap>
        </>
      ) : (
        <FieldWrap error={sel.buy ? errors.buyerName : errors.sellerName}>
          <Field
            label="Client name"
            value={sel.buy ? buyerName : sellerName}
            onChangeText={(v) => {
              if (sel.buy) {
                setBuyerName(v);
                clear('buyerName');
              } else {
                setSellerName(v);
                clear('sellerName');
              }
            }}
            placeholder="Client's name"
            testID="escrow-client-name"
          />
        </FieldWrap>
      )}

      <FieldWrap error={errors.openDate}>
        <DateField
          label="Escrow open date"
          value={openDate}
          onChange={(v) => {
            setOpenDate(v);
            clear('openDate');
          }}
          testID="escrow-open-date"
        />
      </FieldWrap>

      <FieldWrap error={errors.closeDate}>
        <DateField
          label="Target close date"
          value={closeDate}
          onChange={(v) => {
            setCloseDate(v);
            clear('closeDate');
          }}
          testID="escrow-close-date"
        />
      </FieldWrap>

      {/* Key dates (Sept 28, 2026, Anuraj-approved): optional section on the
          "Update escrow" sheet only — the New escrow sheet stays minimum
          input (initial == null in create mode). These feed the client
          KEY DATES card; the save is the same synchronous confirmed write
          as the rest of the sheet (server first, plain-language error on
          failure, local unchanged). On closed/cancelled escrows the section
          is LOCKED (lifecycle gate): the dates show read-only and a
          "Reactivate escrow" button stands in for the fields — only an open
          escrow can have key dates edited, and key-date edits never
          reactivate anything (the store throws as a backstop). */}
      {initial ? (
        keyDatesEditable ? (
          <>
            <Text style={styles.keyDatesLabel}>
              Key dates <Text style={styles.keyDatesOptional}>(optional)</Text>
            </Text>
            <Text style={styles.keyDatesSub}>These show on the client&apos;s Key dates card.</Text>

            <FieldWrap error={errors.inspectionDeadline}>
              <DateField
                label="Release contingency deadline"
                value={inspectionDeadline}
                onChange={(v) => {
                  setInspectionDeadline(v);
                  clear('inspectionDeadline');
                }}
                // Key-date clearing (Sept 28, 2026, Anuraj-approved): the ×
                // stages a blank; the submit maps blank to NULL through the
                // confirmed write path (never "saved" unconfirmed).
                onClear={() => {
                  setInspectionDeadline('');
                  clear('inspectionDeadline');
                }}
                testID="escrow-inspection-deadline"
              />
            </FieldWrap>

            <FieldWrap error={errors.appraisalDeadline}>
              <DateField
                label="Appraisal deadline"
                value={appraisalDeadline}
                onChange={(v) => {
                  setAppraisalDeadline(v);
                  clear('appraisalDeadline');
                }}
                onClear={() => {
                  setAppraisalDeadline('');
                  clear('appraisalDeadline');
                }}
                testID="escrow-appraisal-deadline"
              />
            </FieldWrap>

            <FieldWrap error={errors.loanApprovalDate}>
              <DateField
                label="Loan approval date"
                value={loanApprovalDate}
                onChange={(v) => {
                  setLoanApprovalDate(v);
                  clear('loanApprovalDate');
                }}
                onClear={() => {
                  setLoanApprovalDate('');
                  clear('loanApprovalDate');
                }}
                testID="escrow-loan-approval-date"
              />
            </FieldWrap>
          </>
        ) : (
          <>
            <Text style={styles.keyDatesLabel}>
              Key dates <Text style={styles.keyDatesOptional}>(locked)</Text>
            </Text>
            <Text style={styles.keyDatesSub}>
              Key dates can only be changed on an open escrow.
            </Text>
            <View style={styles.keyDatesLocked} testID="key-dates-locked">
              <View style={styles.keyDatesLockedRow}>
                <Text style={styles.keyDatesLockedLabel}>Closing date</Text>
                <Text style={styles.keyDatesLockedValue}>
                  {closeDate.trim() || 'Not set'}
                </Text>
              </View>
              <View style={styles.keyDatesLockedRow}>
                <Text style={styles.keyDatesLockedLabel}>Release contingency deadline</Text>
                <Text style={styles.keyDatesLockedValue}>
                  {inspectionDeadline.trim() || 'Not set'}
                </Text>
              </View>
              <View style={styles.keyDatesLockedRow}>
                <Text style={styles.keyDatesLockedLabel}>Appraisal deadline</Text>
                <Text style={styles.keyDatesLockedValue}>
                  {appraisalDeadline.trim() || 'Not set'}
                </Text>
              </View>
              <View style={styles.keyDatesLockedRow}>
                <Text style={styles.keyDatesLockedLabel}>Loan approval date</Text>
                <Text style={styles.keyDatesLockedValue}>
                  {loanApprovalDate.trim() || 'Not set'}
                </Text>
              </View>
            </View>
            <View style={styles.keyDatesLockedAction}>
              {onReactivate ? (
                <SecondaryButton
                  title={saving ? savingLabel : 'Reactivate escrow'}
                  onPress={reactivate}
                  disabled={saving}
                />
              ) : null}
            </View>
          </>
        )
      ) : null}

      {errors.submit ? <Text style={styles.submitError}>{errors.submit}</Text> : null}

      <View style={styles.submit}>
        <PrimaryButton
          title={saving ? savingLabel : submitLabel}
          onPress={submit}
          disabled={saving}
        />
      </View>

      {footer}
        </>
      ))}
    </Sheet>
  );
}
// Confirmation screen (Sept 28, 2026, Anuraj): the two-phase new-escrow
// flow holds the validated input here so the realtor reviews it before
// "Create escrow" performs the create. "Back to edit" returns to the form
// with every value preserved (form state is untouched).
function EscrowConfirmView({
  kicker,
  input,
  saving,
  savingLabel,
  submitError,
  onConfirm,
  onBackToEdit,
}: {
  kicker: string;
  input: CreateEscrowInput;
  saving: boolean;
  savingLabel: string;
  submitError?: string;
  onConfirm: () => void;
  onBackToEdit: () => void;
}) {
  return (
    <>
      <Kicker>{kicker}</Kicker>
      <Text style={styles.h2}>Confirm escrow</Text>
      <Text style={styles.confirmNote}>
        Please review the details before creating this escrow.
      </Text>

      {confirmSummaryRows(input).map((row) => (
        <View key={row.testID} style={styles.sumRow} testID={row.testID}>
          <Text style={styles.sumLabel}>{row.label}</Text>
          <Text style={styles.sumValue}>{row.value}</Text>
        </View>
      ))}

      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}

      <View style={styles.submit} testID="confirm-create-escrow">
        <PrimaryButton
          title={saving ? savingLabel : 'Create escrow'}
          onPress={onConfirm}
          disabled={saving}
        />
      </View>
      <View style={styles.backToEdit} testID="confirm-back-to-edit">
        <SecondaryButton
          title="Back to edit"
          onPress={onBackToEdit}
          disabled={saving}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  h2: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 6,
    marginBottom: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.body,
    marginTop: 16,
    marginBottom: 8,
  },
  // Key dates section header (mockup 01 · device ①): "Key dates (optional)"
  // label + quiet sub-line, sitting above the three date inputs.
  keyDatesLabel: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 20,
    marginBottom: 2,
  },
  keyDatesOptional: {
    fontWeight: '400',
    color: colors.muted,
  },
  keyDatesSub: {
    fontSize: 13,
    color: colors.muted,
    marginBottom: 4,
  },
  // Locked key-dates section (closed/cancelled escrows, Sept 28, 2026):
  // read-only rows + the "Reactivate escrow" action.
  keyDatesLocked: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  keyDatesLockedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  keyDatesLockedLabel: {
    fontSize: 14,
    color: colors.muted,
    flexShrink: 1,
    paddingRight: 12,
  },
  keyDatesLockedValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
  keyDatesLockedAction: {
    marginTop: 12,
  },
  sideRow: {
    flexDirection: 'row',
    gap: 10,
  },
  pick: {
    flex: 1,
    borderWidth: 2,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 62,
  },
  pickSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  pickLabel: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
  },
  pickLabelSelected: {
    color: colors.accent,
  },
  fieldWrap: {
    marginTop: 14,
  },
  error: {
    fontSize: 13,
    color: colors.red,
    marginTop: 6,
  },
  submitError: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.red,
    textAlign: 'center',
    marginTop: 14,
  },
  submit: {
    marginTop: 18,
  },
  backToEdit: {
    marginTop: 10,
  },
  // Confirmation summary rows (two-phase create): label/value pairs in the
  // form's existing type scale and colors — no new visual language.
  confirmNote: {
    fontSize: 14.5,
    color: colors.body,
    marginTop: 4,
    marginBottom: 6,
  },
  sumRow: {
    marginTop: 14,
  },
  sumLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.body,
    marginBottom: 4,
  },
  sumValue: {
    fontSize: 16,
    color: colors.ink,
  },
});
