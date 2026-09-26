// Clear to Close — new-escrow sheet.
// Faithful to APPROVED mockup 01 · device 6 (Sept 25 revision): the side picker
// is two multi-select toggle cards ("Buy side" / "Sell side", no subtext);
// selecting both = dual agency. The client-name field adapts: one "Client name"
// field for a single side, "Buyer name" + "Seller name" when both are picked.
// At least one side always stays selected (the last card cannot be toggled off).
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { store } from '../lib/store-instance';
import {
  DEFAULT_SIDE_SELECTION,
  nameFieldMode,
  selectionToSide,
  toggleSide,
  type SideSelection,
} from '../lib/sidePicker';
import { Field, Kicker, PrimaryButton, Sheet } from '../components/ui';
import { colors } from '../theme';

interface NewEscrowSheetProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
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

type ErrorKey = 'address' | 'buyerName' | 'sellerName' | 'openDate' | 'closeDate' | 'submit';
type Errors = Partial<Record<ErrorKey, string>>;

function FieldWrap({ error, children }: { error?: string; children: React.ReactNode }) {
  return (
    <View style={styles.fieldWrap}>
      {children}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export default function NewEscrowSheet({ visible, onClose, onCreated }: NewEscrowSheetProps) {
  const [sel, setSel] = useState<SideSelection>(DEFAULT_SIDE_SELECTION);
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [openDate, setOpenDate] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);

  const side = selectionToSide(sel);
  const dual = nameFieldMode(sel) === 'dual';

  const reset = () => {
    setSel(DEFAULT_SIDE_SELECTION);
    setAddress('');
    setCity('');
    setBuyerName('');
    setSellerName('');
    setOpenDate('');
    setCloseDate('');
    setErrors({});
    setSaving(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const clear = (k: ErrorKey) =>
    setErrors((prev) => (prev[k] ? { ...prev, [k]: undefined } : prev));

  const validate = (): boolean => {
    const e: Errors = {};
    if (!address.trim()) e.address = 'Enter the property address.';
    if (sel.buy && !buyerName.trim()) {
      e.buyerName = "Enter the buyer's name.";
    }
    if (sel.sell && !sellerName.trim()) {
      e.sellerName = "Enter the seller's name.";
    }
    if (!isRealDate(openDate)) e.openDate = 'Use YYYY-MM-DD.';
    if (!isRealDate(closeDate)) {
      e.closeDate = 'Use YYYY-MM-DD.';
    } else if (isRealDate(openDate) && toMs(closeDate) <= toMs(openDate)) {
      e.closeDate = 'Target close must be after the open date.';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (saving || !validate()) return;
    setSaving(true);
    try {
      const created = await store.createEscrow({
        address: address.trim(),
        city: city.trim(),
        side,
        buyerName: sel.buy ? buyerName.trim() : undefined,
        sellerName: sel.sell ? sellerName.trim() : undefined,
        openDate,
        closeDate,
      });
      onCreated(created.id);
      reset();
    } catch (err) {
      console.warn('createEscrow failed', err);
      setErrors((prev) => ({ ...prev, submit: 'Could not open the escrow. Try again.' }));
    } finally {
      setSaving(false);
    }
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
    >
      <Text style={[styles.pickLabel, selected && styles.pickLabelSelected]}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <Sheet visible={visible} onClose={handleClose}>
      <Kicker>New escrow</Kicker>
      <Text style={styles.h2}>Open escrow</Text>

      <Text style={styles.label}>Which side are you representing?</Text>
      <View style={styles.sideRow}>
        {toggleCard('buy', 'Buy side', sel.buy)}
        {toggleCard('sell', 'Sell side', sel.sell)}
      </View>

      <FieldWrap error={errors.address}>
        <Field
          label="Property address"
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            clear('address');
          }}
          placeholder="e.g. 4187 Oakmont Dr"
        />
      </FieldWrap>

      <FieldWrap>
        <Field
          label="City"
          value={city}
          onChangeText={setCity}
          placeholder="Valencia, CA 91355"
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
          />
        </FieldWrap>
      )}

      <FieldWrap error={errors.openDate}>
        <Field
          label="Escrow open date"
          value={openDate}
          onChangeText={(v) => {
            setOpenDate(v);
            clear('openDate');
          }}
          placeholder="YYYY-MM-DD"
        />
      </FieldWrap>

      <FieldWrap error={errors.closeDate}>
        <Field
          label="Target close date"
          value={closeDate}
          onChangeText={(v) => {
            setCloseDate(v);
            clear('closeDate');
          }}
          placeholder="YYYY-MM-DD"
        />
      </FieldWrap>

      {errors.submit ? <Text style={styles.submitError}>{errors.submit}</Text> : null}

      <View style={styles.submit}>
        <PrimaryButton
          title={saving ? 'Opening…' : 'Open escrow'}
          onPress={submit}
          disabled={saving}
        />
      </View>
    </Sheet>
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
});
