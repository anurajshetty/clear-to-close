// Clear to Close — TC intake form (Sept 29, 2026, Anuraj-approved mockup
// 04, device ②).
//
// New top-level route app/tc-intake/[escrowId].tsx (never a sheet): the
// realtor's listing-details intake for one seller-side escrow. Edits live
// in local draft state until Save — Save is the confirmed-or-loud write
// (store.saveTcIntake: server first, local cache only on confirmation).
// Share uses the currently DISPLAYED values (unsaved edits included) and
// is a local share-sheet payload — never a server write.
//
// Locked escrows (closed/cancelled): the intake renders read-only rows
// with the "(locked)" treatment, mirroring the key-dates locked precedent
// — the form can only be changed on an open escrow.
import React, { useEffect, useRef, useState } from 'react';
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
import { TcIntakeSections } from '../../src/components/TcIntakeEntry';
import {
  TC_INTAKE_MAX_SELLERS,
  buildTcIntakeShareText,
  countTcIntake,
  emptyTcIntake,
  type TcIntakeData,
  type TcIntakeSeller,
  type TcYesNo,
} from '../../src/lib/tcIntake';
import { shareText } from '../../src/lib/share';
import type { Escrow } from '../../src/lib/types';
import { colors, radius, type } from '../../src/theme';

function emptySeller(): TcIntakeSeller {
  return { name: '', phone: '', email: '' };
}

/**
 * The Yes/No segmented control (mockup ②), built once here and reused for
 * every Yes/No field on this screen — no existing component matched the
 * mockup (per the Sept 29 brief, local to this screen file).
 */
function YesNoSeg({
  label,
  value,
  onChange,
  options,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  testID?: string;
}) {
  return (
    <View style={styles.segWrap} testID={testID}>
      <Text style={styles.segLabel}>{label}</Text>
      <View style={styles.seg} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const on = value === o.value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.label}
              onPress={() => onChange(o.value)}
              style={[styles.segBtn, on && styles.segBtnOn]}
            >
              <Text style={[styles.segBtnText, on && styles.segBtnTextOn]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const YES_NO = [
  { label: 'Yes', value: 'yes' },
  { label: 'No', value: 'no' },
];
const LEASED_OWNED = [
  { label: 'Leased', value: 'leased' },
  { label: 'Owned', value: 'owned' },
];

export default function TcIntakeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const params = useLocalSearchParams<{ escrowId: string }>();
  const escrowId = params.escrowId ?? '';

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [form, setForm] = useState<TcIntakeData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const e = await store.getEscrow(escrowId);
      // Converge the server's confirmed intake first (pure pull), then
      // seed the draft from the confirmed snapshot.
      await store.refreshTcIntake(escrowId);
      const saved = await store.getTcIntake(escrowId);
      if (cancelled) return;
      setEscrow(e);
      setForm(saved ? saved.data : emptyTcIntake());
    })();
    return () => {
      cancelled = true;
    };
  }, [escrowId]);

  const locked = !!escrow && escrow.status !== 'open';
  const address = escrow?.address?.trim() || 'This escrow';
  const counts = form ? countTcIntake(form) : { filled: 0, total: 0, complete: false };

  const update = (patch: Partial<TcIntakeData>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setSaveError(null);
  };
  const updateSeller = (index: number, patch: Partial<TcIntakeSeller>) => {
    setForm((f) => {
      if (!f) return f;
      const sellers = f.sellers.map((s, i) => (i === index ? { ...s, ...patch } : s));
      return { ...f, sellers };
    });
    setSaveError(null);
  };

  const onSave = async () => {
    if (saving || !form || locked) return;
    setSaveError(null);
    setSaving(true);
    try {
      await store.saveTcIntake(escrowId, form);
      showToast('TC intake saved.');
    } catch (err) {
      // Failed/offline save: the previously confirmed snapshot is
      // preserved untouched; the error is retryable via Save.
      setSaveError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save the TC intake. Check your connection and try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const onShare = async () => {
    if (!form) return;
    const outcome = await shareText(buildTcIntakeShareText(form, address));
    if (outcome === 'copied') showToast('Copied to clipboard');
    else if (outcome === 'unavailable') showToast("Couldn't share. Try again.");
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: 24 + kb }]}
        keyboardShouldPersistTaps="handled"
      >
        <BackChevron label="Details" onPress={() => router.back()} />
        <Text style={styles.title}>TC intake</Text>
        <Text style={styles.sub}>{address} · Seller side</Text>
        <Text style={styles.count} testID="tc-intake-count">
          {counts.complete ? 'Complete' : `${counts.filled} of ${counts.total} filled`}
        </Text>

        {form === null ? (
          <Text style={styles.loading}>Loading…</Text>
        ) : locked ? (
          <>
            <Text style={styles.lockedNote}>
              The intake can only be changed on an open escrow.
            </Text>
            <TcIntakeSections data={form} fullAddress={address} />
          </>
        ) : (
          <>
            {/* 1 · Property */}
            <Kicker>Property</Kicker>
            <YesNoSeg
              label="Owner occupied?"
              value={form.ownerOccupied}
              onChange={(v) => update({ ownerOccupied: v as TcYesNo })}
              options={YES_NO}
              testID="tc-owner-occupied"
            />
            <YesNoSeg
              label="Is the home in a trust?"
              value={form.inTrust}
              onChange={(v) => update({ inTrust: v as TcYesNo })}
              options={YES_NO}
              testID="tc-in-trust"
            />
            {form.inTrust === 'yes' && (
              <>
                <Field label="Trust name" value={form.trustName} onChangeText={(t) => update({ trustName: t })} testID="tc-trust-name" />
                <DateField
                  label="Trust date"
                  value={form.trustDate}
                  onChange={(d) => update({ trustDate: d })}
                  onClear={() => update({ trustDate: '' })}
                  testID="tc-trust-date"
                />
                <Field
                  label="Trustee names (comma separated)"
                  value={form.trusteeNames}
                  onChangeText={(t) => update({ trusteeNames: t })}
                  testID="tc-trustee-names"
                />
                <Field
                  label="Trustee emails (comma separated)"
                  value={form.trusteeEmails}
                  onChangeText={(t) => update({ trusteeEmails: t })}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  testID="tc-trustee-emails"
                />
              </>
            )}

            {/* 2 · Sellers */}
            <Kicker>Sellers</Kicker>
            {form.sellers.map((s, i) => (
              <View key={i} style={styles.sellerBlock}>
                <Text style={styles.sellerHead}>Seller {i + 1}</Text>
                <Field label="Name" value={s.name} onChangeText={(t) => updateSeller(i, { name: t })} autoCapitalize="words" testID={`tc-seller-${i}-name`} />
                <Field label="Phone" value={s.phone} onChangeText={(t) => updateSeller(i, { phone: t })} keyboardType="phone-pad" testID={`tc-seller-${i}-phone`} />
                <Field
                  label="Email"
                  value={s.email}
                  onChangeText={(t) => updateSeller(i, { email: t })}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  testID={`tc-seller-${i}-email`}
                />
              </View>
            ))}
            {form.sellers.length < TC_INTAKE_MAX_SELLERS && (
              <Pressable
                onPress={() => setForm((f) => (f ? { ...f, sellers: [...f.sellers, emptySeller()] } : f))}
                style={({ pressed }) => [styles.addSeller, pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel="Add another seller"
                testID="tc-add-seller"
              >
                <Text style={styles.addSellerText}>+ Add another seller</Text>
              </Pressable>
            )}

            {/* 3 · Listing terms */}
            <Kicker>Listing terms</Kicker>
            <Field label="List price" value={form.listPrice} onChangeText={(t) => update({ listPrice: t })} keyboardType="numeric" testID="tc-list-price" />
            <DateField label="Beginning contract date" value={form.contractBegin} onChange={(d) => update({ contractBegin: d })} onClear={() => update({ contractBegin: '' })} testID="tc-contract-begin" />
            <DateField label="Expiration date" value={form.contractEnd} onChange={(d) => update({ contractEnd: d })} onClear={() => update({ contractEnd: '' })} testID="tc-contract-end" />
            <DateField label="Active on MLS date" value={form.mlsDate} onChange={(d) => update({ mlsDate: d })} onClear={() => update({ mlsDate: '' })} testID="tc-mls-date" />
            <YesNoSeg
              label="Is seller purchasing another home?"
              value={form.buyingAnother}
              onChange={(v) => update({ buyingAnother: v as TcYesNo })}
              options={YES_NO}
              testID="tc-buying-another"
            />
            {form.buyingAnother === 'yes' && (
              <YesNoSeg
                label="Home of choice contingency?"
                value={form.homeOfChoice}
                onChange={(v) => update({ homeOfChoice: v as TcYesNo })}
                options={YES_NO}
                testID="tc-home-of-choice"
              />
            )}

            {/* 4 · Commission */}
            <Kicker>Commission</Kicker>
            <Field label="Realtor total %" value={form.totalPct} onChangeText={(t) => update({ totalPct: t })} keyboardType="decimal-pad" testID="tc-total-pct" />
            <Field label="Buyer's-agent offer %" value={form.buyerPct} onChangeText={(t) => update({ buyerPct: t })} keyboardType="decimal-pad" testID="tc-buyer-pct" />
            <Field label="TC fee" value={form.tcFee} onChangeText={(t) => update({ tcFee: t })} keyboardType="numeric" testID="tc-tc-fee" />
            <Field label="Broker fee" value={form.brokerFee} onChangeText={(t) => update({ brokerFee: t })} keyboardType="numeric" testID="tc-broker-fee" />

            {/* 5 · Property details */}
            <Kicker>Property details</Kicker>
            <Field label="Personal property included/excluded" value={form.personalProperty} onChangeText={(t) => update({ personalProperty: t })} testID="tc-personal-property" />
            <YesNoSeg label="HOA?" value={form.hoa} onChange={(v) => update({ hoa: v as TcYesNo })} options={YES_NO} testID="tc-hoa" />
            {form.hoa === 'yes' && (
              <Field label="HOA monthly amount" value={form.hoaAmount} onChangeText={(t) => update({ hoaAmount: t })} keyboardType="numeric" testID="tc-hoa-amount" />
            )}
            <YesNoSeg label="Solar?" value={form.solar} onChange={(v) => update({ solar: v as TcYesNo })} options={YES_NO} testID="tc-solar" />
            {form.solar === 'yes' && (
              <>
                <YesNoSeg label="Leased or owned?" value={form.solarLeasedOwned} onChange={(v) => update({ solarLeasedOwned: v as '' | 'leased' | 'owned' })} options={LEASED_OWNED} testID="tc-solar-lo" />
                <Field label="Solar amount" value={form.solarAmount} onChangeText={(t) => update({ solarAmount: t })} keyboardType="numeric" testID="tc-solar-amount" />
                <Field label="Solar company" value={form.solarCompany} onChangeText={(t) => update({ solarCompany: t })} testID="tc-solar-company" />
              </>
            )}
            <YesNoSeg label="Pool?" value={form.pool} onChange={(v) => update({ pool: v as TcYesNo })} options={YES_NO} testID="tc-pool" />

            {/* 6 · Vendors */}
            <Kicker>Vendors</Kicker>
            <Field label="Escrow company" value={form.escrowCompany} onChangeText={(t) => update({ escrowCompany: t })} testID="tc-escrow-company" />
            <Field label="Title company" value={form.titleCompany} onChangeText={(t) => update({ titleCompany: t })} testID="tc-title-company" />
            <Field label="NHD company" value={form.nhdCompany} onChangeText={(t) => update({ nhdCompany: t })} testID="tc-nhd-company" />
            <Field label="Home warranty company" value={form.warrantyCompany} onChangeText={(t) => update({ warrantyCompany: t })} testID="tc-warranty-company" />
            <Field label="Warranty amount" value={form.warrantyAmount} onChangeText={(t) => update({ warrantyAmount: t })} keyboardType="numeric" testID="tc-warranty-amount" />
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
            <View style={styles.footerBtn} testID="tc-intake-save">
              <PrimaryButton
                title={saving ? 'Saving…' : 'Save'}
                onPress={onSave}
                disabled={saving || form === null}
              />
            </View>
          )}
          <View style={styles.footerBtn} testID="tc-intake-share">
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
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  title: {
    fontSize: type.title,
    fontWeight: '800',
    color: colors.ink,
    marginTop: 8,
  },
  sub: {
    fontSize: type.small,
    color: colors.muted,
    marginTop: 2,
  },
  count: {
    fontSize: type.small,
    fontWeight: '700',
    color: colors.muted,
    marginTop: 2,
    marginBottom: 8,
  },
  loading: {
    fontSize: type.body,
    color: colors.muted,
    marginTop: 24,
  },
  lockedNote: {
    fontSize: type.small,
    color: colors.muted,
    marginBottom: 4,
  },
  sellerBlock: {
    marginBottom: 4,
  },
  sellerHead: {
    fontSize: type.small,
    fontWeight: '700',
    color: colors.body,
    marginTop: 4,
    marginBottom: 2,
  },
  addSeller: {
    minHeight: 44,
    justifyContent: 'center',
    marginBottom: 8,
  },
  addSellerText: {
    fontSize: type.body,
    fontWeight: '700',
    color: colors.accent,
  },
  segWrap: {
    marginBottom: 10,
  },
  segLabel: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.body,
    marginBottom: 6,
  },
  seg: {
    flexDirection: 'row',
    backgroundColor: colors.tabBg,
    borderRadius: radius.input,
    padding: 4,
    gap: 4,
  },
  segBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  segBtnOn: {
    backgroundColor: colors.card,
    shadowColor: '#1E190F',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  segBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.muted,
  },
  segBtnTextOn: {
    color: colors.ink,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  saveError: {
    fontSize: type.small,
    fontWeight: '600',
    color: colors.red,
    marginBottom: 8,
  },
  footerBtns: {
    flexDirection: 'row',
    gap: 12,
  },
  footerBtn: {
    flex: 1,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
