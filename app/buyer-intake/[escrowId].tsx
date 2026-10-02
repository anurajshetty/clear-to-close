// Clear to Close — Buyer intake form (Oct 1, 2026, Anuraj-approved
// mockup 08).
//
// New top-level route app/buyer-intake/[escrowId].tsx (never a sheet): the
// realtor's buyer intake for one buyer-side escrow. Mirrors
// app/tc-intake/[escrowId].tsx screen for screen — same header/footer
// pattern, same confirmed-write Save, same share-text Share (currently
// DISPLAYED values, unsaved edits included — never a server write).
//
// Edits live in local draft state until Save. Auto-fill seeds the draft
// from the profile + escrow (mockup ②); the "Auto-filled" pill marks
// seeded fields only while they still carry the seeded value.
//
// Locked escrows (closed/cancelled): the intake renders read-only rows,
// mirroring the TC intake locked precedent — the form can only be changed
// on an open escrow.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../src/lib/store-instance';
import {
  BackChevron,
  Field,
  Kicker,
  PrimaryButton,
  SecondaryButton,
  useKeyboardHeight,
} from '../../src/components/ui';
import DateField from '../../src/components/DateField';
import { BuyerIntakeSections } from '../../src/components/BuyerIntakeEntry';
import { YesNoSeg, YES_NO, LEASED_OWNED } from '../../src/components/YesNoSeg';
import {
  BUYER_INTAKE_MAX_BUYERS,
  autoFillBuyerIntake,
  buildBuyerIntakeShareText,
  checkBuyerIntakeMath,
  countBuyerIntake,
  emptyBuyerIntakeBuyer,
  type BuyerIntakeBuyer,
  type BuyerIntakeData,
  type BuyerYesNo,
  validateBuyerIntakeConditional,
} from '../../src/lib/buyerIntake';
import { shareText } from '../../src/lib/share';
import { colors, radius, type } from '../../src/theme';

export default function BuyerIntakeScreen() {
  const { escrowId } = useLocalSearchParams<{ escrowId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const [escrow, setEscrow] = useState<{
    address: string;
    status: string;
  } | null>(null);
  const [form, setForm] = useState<BuyerIntakeData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Inline field errors from the conditional required validation (Anuraj,
   * Oct 1, 2026): field key -> error copy. Set in onSave only, cleared on
   * edit. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Save toast (mirrors the TC intake pattern verbatim): brief
   * confirmation pill on every successful save, auto-dismissed. */
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  };
  /** The auto-fill seed captured on load: a pill shows only while the
   * field still carries its seeded value (mockup ②). */
  const seedRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const e = await store.getEscrow(escrowId);
      await store.refreshBuyerIntake(escrowId);
      const saved = await store.getBuyerIntake(escrowId);
      if (cancelled) return;
      setEscrow(e ? { address: e.address, status: e.status } : null);
      if (saved) {
        setForm(saved.data);
        seedRef.current = {};
      } else {
        const profile = await store.getProfile();
        const invites = await store.listInvites(escrowId);
        const buyerInvites = invites.filter((i) => i.role === 'buyer' && !i.revokedAt);
        const { data, seed } = autoFillBuyerIntake(
          profile ? { name: profile.name ?? '', email: profile.email ?? '' } : null,
          e ?? { buyerName: '', address: '', closeDate: '' },
          buyerInvites.map((i) => ({ partyName: i.partyName })),
        );
        setForm(data);
        seedRef.current = seed;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [escrowId]);

  const update = (patch: Partial<BuyerIntakeData>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setSaveError(null);
    // Errors clear on edit (standard): drop the error entries for the
    // fields being changed.
    setErrors((e) => {
      let changed = false;
      const next: Record<string, string> = { ...e };
      for (const k of Object.keys(patch)) {
        if (k in next) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : e;
    });
  };
  const updateBuyer = (i: number, patch: Partial<BuyerIntakeBuyer>) => {
    setForm((f) => {
      if (!f) return f;
      const buyers = f.buyers.map((b, bi) => (bi === i ? { ...b, ...patch } : b));
      return { ...f, buyers };
    });
    setSaveError(null);
  };
  const addBuyer = () => {
    setForm((f) =>
      f && f.buyers.length < BUYER_INTAKE_MAX_BUYERS
        ? { ...f, buyers: [...f.buyers, emptyBuyerIntakeBuyer()] }
        : f,
    );
  };

  /** The "Auto-filled" pill shows only while the field still carries the
   * value the app seeded it with (mockup ②). */
  const isAutoFilled = (key: string, value: string) => {
    const seed = seedRef.current[key];
    return !!seed && seed !== '' && value === seed;
  };

  const locked = !!escrow && (escrow.status === 'closed' || escrow.status === 'cancelled');
  const counts = useMemo(() => (form ? countBuyerIntake(form) : null), [form]);
  const mathNote = useMemo(() => (form ? checkBuyerIntakeMath(form) : null), [form]);
  const address = escrow?.address ?? '';

  const onSave = async () => {
    if (!form) return;
    // Conditional required validation (Anuraj, Oct 1, 2026): runs here
    // only, never while typing. All violations surface at once; save is
    // blocked until they are resolved.
    const violations = validateBuyerIntakeConditional(form);
    if (Object.keys(violations).length > 0) {
      setErrors(violations);
      return;
    }
    setErrors({});
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await store.saveBuyerIntake(escrowId, form);
      setForm(saved.data);
      // A saved intake is the realtor's own confirmed data — no seed pills.
      seedRef.current = {};
      showToast('Buyer intake saved.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the buyer intake.');
    } finally {
      setSaving(false);
    }
  };

  const onShare = () => {
    if (!form) return;
    shareText(buildBuyerIntakeShareText(form, address));
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: 24 + kb }]}
        keyboardShouldPersistTaps="handled"
      >
        <BackChevron label="Details" onPress={() => router.back()} />
        <Text style={styles.title}>Buyer intake</Text>
        <Text style={styles.sub}>{address} · Buyer side</Text>
        <Text style={styles.count} testID="buyer-intake-count">
          {counts ? (counts.complete ? 'Complete' : `${counts.filled} of ${counts.total} filled`) : '…'}
        </Text>

        {form === null ? (
          <Text style={styles.loading}>Loading…</Text>
        ) : locked ? (
          <>
            <Text style={styles.lockedNote}>
              The intake can only be changed on an open escrow.
            </Text>
            <BuyerIntakeSections data={form} fullAddress={address} />
          </>
        ) : (
          <>
            {/* Agent */}
            <View style={styles.section}>
              <Kicker>Agent</Kicker>
              <Field
                label="Agent's name"
                value={form.agentName}
                onChangeText={(t) => update({ agentName: t })}
                placeholder="Your full name"
                autoCapitalize="words"
                autoFilled={isAutoFilled('agentName', form.agentName)}
                testID="buyer-intake-agent-name"
              />
              <Field
                label="Agent's email"
                value={form.agentEmail}
                onChangeText={(t) => update({ agentEmail: t })}
                placeholder="name@email.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoFilled={isAutoFilled('agentEmail', form.agentEmail)}
                testID="buyer-intake-agent-email"
              />
            </View>

            {/* Buyers */}
            <View style={styles.section}>
              <Kicker>Buyers</Kicker>
              {form.buyers.map((b, i) => (
                <View key={i} style={styles.buyerBlock}>
                  <Text style={styles.buyerLabel}>Buyer {i + 1}</Text>
                  <Field
                    label="Name"
                    value={b.name}
                    onChangeText={(t) => updateBuyer(i, { name: t })}
                    placeholder="Full name"
                    autoCapitalize="words"
                    autoFilled={i === 0 && isAutoFilled('buyer1Name', b.name)}
                    testID={`buyer-intake-buyer-${i + 1}-name`}
                  />
                  <Field
                    label="Phone number"
                    value={b.phone}
                    onChangeText={(t) => updateBuyer(i, { phone: t })}
                    placeholder="(555) 000-0000"
                    keyboardType="phone-pad"
                    testID={`buyer-intake-buyer-${i + 1}-phone`}
                  />
                  <Field
                    label="Email address"
                    value={b.email}
                    onChangeText={(t) => updateBuyer(i, { email: t })}
                    placeholder="name@email.com"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    testID={`buyer-intake-buyer-${i + 1}-email`}
                  />
                </View>
              ))}
              {form.buyers.length < BUYER_INTAKE_MAX_BUYERS && (
                <Pressable
                  onPress={addBuyer}
                  style={({ pressed }) => [styles.addBuyer, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel="Add another buyer"
                  testID="buyer-intake-add-buyer"
                >
                  <Text style={styles.addBuyerText}>+ Add another buyer</Text>
                </Pressable>
              )}
            </View>

            {/* Offer terms */}
            <View style={styles.section}>
              <Kicker>Offer terms</Kicker>
              <Field
                label="Offer property address"
                value={form.offerAddress}
                onChangeText={(t) => update({ offerAddress: t })}
                placeholder="Property address"
                autoCapitalize="words"
                autoFilled={isAutoFilled('offerAddress', form.offerAddress)}
                testID="buyer-intake-offer-address"
              />
              <Field
                label="Purchase price"
                value={form.purchasePrice}
                onChangeText={(t) => update({ purchasePrice: t })}
                placeholder="$975,000"
                keyboardType="decimal-pad"
                testID="buyer-intake-purchase-price"
              />
              <View style={styles.row2}>
                <View style={styles.row2Col}>
                  <Field
                    label="Deposit"
                    value={form.deposit}
                    onChangeText={(t) => update({ deposit: t })}
                    placeholder="$25,000"
                    keyboardType="decimal-pad"
                    testID="buyer-intake-deposit"
                  />
                </View>
                <View style={styles.row2Col}>
                  <Field
                    label="Down payment"
                    value={form.downPayment}
                    onChangeText={(t) => update({ downPayment: t })}
                    placeholder="$195,000"
                    keyboardType="decimal-pad"
                    testID="buyer-intake-down-payment"
                  />
                </View>
              </View>
              <Field
                label="Loan amount"
                value={form.loanAmount}
                onChangeText={(t) => update({ loanAmount: t })}
                placeholder="$780,000"
                keyboardType="decimal-pad"
                testID="buyer-intake-loan-amount"
              />
              {mathNote && <Text style={styles.mathNote}>{mathNote}</Text>}
            </View>

            {/* Dates */}
            <View style={styles.section}>
              <Kicker>Dates</Kicker>
              <DateField
                label="Close of escrow"
                value={form.closeOfEscrow}
                onChange={(iso) => update({ closeOfEscrow: iso })}
                onClear={() => update({ closeOfEscrow: '' })}
                autoFilled={isAutoFilled('closeOfEscrow', form.closeOfEscrow)}
                testID="buyer-intake-close-date"
              />
              <DateField
                label="Possession date"
                value={form.possession}
                onChange={(iso) => update({ possession: iso })}
                onClear={() => update({ possession: '' })}
                testID="buyer-intake-possession-date"
              />
            </View>

            {/* Contingencies */}
            <View style={styles.section}>
              <Kicker>Contingencies</Kicker>
              <YesNoSeg
                label="Contingent on sale of buyer's property?"
                value={form.saleOfBuyersProperty}
                onChange={(v: string) => update({ saleOfBuyersProperty: v as BuyerYesNo })}
                options={YES_NO}
                testID="buyer-intake-sale-of-property"
              />
              <YesNoSeg
                label="Investigation contingency"
                value={form.investigation}
                onChange={(v: string) =>
                  update({ investigation: v as BuyerYesNo, investigationDays: v === 'yes' ? form.investigationDays : '' })
                }
                options={YES_NO}
                testID="buyer-intake-investigation"
              />
              {form.investigation === 'yes' && (
                <Field
                  label="Investigation period (days)"
                  value={form.investigationDays}
                  onChangeText={(t) => update({ investigationDays: t })}
                  placeholder="17"
                  keyboardType="numeric"
                  error={errors.investigationDays ?? null}
                  testID="buyer-intake-investigation-days"
                />
              )}
              <YesNoSeg
                label="Appraisal contingency"
                value={form.appraisal}
                onChange={(v: string) =>
                  update({ appraisal: v as BuyerYesNo, appraisalDays: v === 'yes' ? form.appraisalDays : '' })
                }
                options={YES_NO}
                testID="buyer-intake-appraisal"
              />
              {form.appraisal === 'yes' && (
                <Field
                  label="Appraisal period (days)"
                  value={form.appraisalDays}
                  onChangeText={(t) => update({ appraisalDays: t })}
                  placeholder="21"
                  keyboardType="numeric"
                  error={errors.appraisalDays ?? null}
                  testID="buyer-intake-appraisal-days"
                />
              )}
              <YesNoSeg
                label="Loan contingency"
                value={form.loan}
                onChange={(v: string) =>
                  update({ loan: v as BuyerYesNo, loanDays: v === 'yes' ? form.loanDays : '' })
                }
                options={YES_NO}
                testID="buyer-intake-loan"
              />
              {form.loan === 'yes' && (
                <Field
                  label="Loan period (days)"
                  value={form.loanDays}
                  onChangeText={(t) => update({ loanDays: t })}
                  placeholder="21"
                  keyboardType="numeric"
                  error={errors.loanDays ?? null}
                  testID="buyer-intake-loan-days"
                />
              )}
            </View>

            {/* Property details */}
            <View style={styles.section}>
              <Kicker>Property details</Kicker>
              <Field
                label="Personal property included / excluded"
                value={form.personalProperty}
                onChangeText={(t) => update({ personalProperty: t })}
                placeholder="Refrigerator, washer, dryer included."
                multiline
                testID="buyer-intake-personal-property"
              />
              <YesNoSeg
                label="Is there an HOA?"
                value={form.hoa}
                onChange={(v: string) =>
                  update({ hoa: v as BuyerYesNo, hoaAmount: v === 'yes' ? form.hoaAmount : '' })
                }
                options={YES_NO}
                testID="buyer-intake-hoa"
              />
              {form.hoa === 'yes' && (
                <Field
                  label="HOA amount ($ / month)"
                  value={form.hoaAmount}
                  onChangeText={(t) => update({ hoaAmount: t })}
                  placeholder="250"
                  keyboardType="decimal-pad"
                  error={errors.hoaAmount ?? null}
                  testID="buyer-intake-hoa-amount"
                />
              )}
              <YesNoSeg
                label="Solar?"
                value={form.solar}
                onChange={(v: string) =>
                  update({
                    solar: v as BuyerYesNo,
                    solarLeasedOwned: v === 'yes' ? form.solarLeasedOwned : '',
                    solarAmount: v === 'yes' ? form.solarAmount : '',
                  })
                }
                options={YES_NO}
                testID="buyer-intake-solar"
              />
              {form.solar === 'yes' && (
                <>
                  <YesNoSeg
                    label="Leased or owned?"
                    value={form.solarLeasedOwned}
                    onChange={(v: string) => update({ solarLeasedOwned: v as BuyerIntakeData['solarLeasedOwned'] })}
                    options={LEASED_OWNED}
                    error={errors.solarLeasedOwned ?? null}
                    testID="buyer-intake-solar-leased-owned"
                  />
                  <Field
                    label="Solar amount ($)"
                    value={form.solarAmount}
                    onChangeText={(t) => update({ solarAmount: t })}
                    placeholder="18,000"
                    keyboardType="decimal-pad"
                    error={errors.solarAmount ?? null}
                    testID="buyer-intake-solar-amount"
                  />
                </>
              )}
              <YesNoSeg
                label="Pool?"
                value={form.pool}
                onChange={(v: string) => update({ pool: v as BuyerYesNo })}
                options={YES_NO}
                testID="buyer-intake-pool"
              />
              <Field
                label="Home warranty company"
                value={form.warrantyCompany}
                onChangeText={(t) => update({ warrantyCompany: t })}
                placeholder="Fidelity National Home Warranty"
                autoCapitalize="words"
                testID="buyer-intake-warranty-company"
              />
              <Field
                label="Warranty terms"
                value={form.warrantyTerms}
                onChangeText={(t) => update({ warrantyTerms: t })}
                placeholder="1 year, $75 trade fee"
                testID="buyer-intake-warranty-terms"
              />
              <Field
                label="Warranty amount ($)"
                value={form.warrantyAmount}
                onChangeText={(t) => update({ warrantyAmount: t })}
                placeholder="650"
                keyboardType="decimal-pad"
                testID="buyer-intake-warranty-amount"
              />
            </View>
          </>
        )}
      </ScrollView>

      {/* Sticky footer: Save (confirmed write) + Share with TC (local share sheet). */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {saveError && (
          <Text style={styles.saveError} accessibilityRole="alert">
            {saveError}
          </Text>
        )}
        <View style={styles.footerBtns}>
          {!locked && (
            <View style={styles.footerBtn} testID="buyer-intake-save">
              <PrimaryButton
                title={saving ? 'Saving…' : 'Save'}
                onPress={onSave}
                disabled={saving || form === null}
              />
            </View>
          )}
          <View style={styles.footerBtn} testID="buyer-intake-share">
            <SecondaryButton title="Share with TC" onPress={onShare} />
          </View>
        </View>
      </View>
      {toastMsg && (
        <View style={styles.toast} testID="toast">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20 },
  title: {
    fontSize: type.title,
    fontWeight: '800',
    color: colors.ink,
    marginTop: 8,
  },
  sub: {
    fontSize: type.small,
    color: colors.muted,
    marginTop: 4,
  },
  count: {
    fontSize: type.small,
    fontWeight: '700',
    color: colors.accent,
    marginTop: 6,
    marginBottom: 4,
  },
  loading: {
    fontSize: type.body,
    color: colors.muted,
    marginTop: 24,
  },
  lockedNote: {
    fontSize: type.small,
    color: colors.muted,
    marginTop: 12,
    marginBottom: 16,
    lineHeight: 20,
  },
  section: { marginBottom: 8 },
  buyerBlock: { marginBottom: 4 },
  buyerLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 16,
    marginBottom: 4,
  },
  addBuyer: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  addBuyerText: {
    fontSize: type.body,
    fontWeight: '700',
    color: colors.accent,
  },
  row2: { flexDirection: 'row', gap: 12 },
  row2Col: { flex: 1 },
  mathNote: {
    fontSize: 13,
    color: colors.body,
    marginTop: 6,
    lineHeight: 18,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  footerBtns: {
    flexDirection: 'row',
    gap: 12,
  },
  footerBtn: { flex: 1 },
  saveError: {
    fontSize: type.small,
    color: colors.red,
    marginBottom: 8,
    lineHeight: 18,
  },
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 110,
    backgroundColor: colors.ink,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 14,
  },
});
