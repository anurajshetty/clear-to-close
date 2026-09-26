import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { store } from '../lib/store-instance';
import type { Side } from '../lib/types';
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

const SIDE_OPTIONS: { value: Side; label: string; hint: string }[] = [
  { value: 'buy', label: 'Buy side', hint: '13-step checklist' },
  { value: 'sell', label: 'Sell side', hint: '12-step checklist' },
  { value: 'both', label: 'Both sides', hint: '2 checklists' },
];

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
  const [side, setSide] = useState<Side>('buy');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [openDate, setOpenDate] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setSide('buy');
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
    if ((side === 'buy' || side === 'both') && !buyerName.trim()) {
      e.buyerName = "Enter the buyer's name.";
    }
    if ((side === 'sell' || side === 'both') && !sellerName.trim()) {
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
        buyerName: side === 'sell' ? undefined : buyerName.trim(),
        sellerName: side === 'buy' ? undefined : sellerName.trim(),
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

  return (
    <Sheet visible={visible} onClose={handleClose}>
      <Kicker>New escrow</Kicker>
      <Text style={styles.h2}>Open escrow</Text>

      <Text style={styles.label}>Which side are you representing?</Text>
      <View style={styles.sideRow}>
        {SIDE_OPTIONS.map((opt) => {
          const selected = side === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => {
                setSide(opt.value);
                setErrors((p) => ({ ...p, buyerName: undefined, sellerName: undefined }));
              }}
              style={[styles.pick, selected && styles.pickSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.pickLabel, selected && styles.pickLabelSelected]}>
                {opt.label}
              </Text>
              <Text style={styles.pickHint}>{opt.hint}</Text>
            </Pressable>
          );
        })}
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

      {side === 'both' ? (
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
        <FieldWrap error={side === 'buy' ? errors.buyerName : errors.sellerName}>
          <Field
            label={side === 'buy' ? 'Buyer name' : 'Seller name'}
            value={side === 'buy' ? buyerName : sellerName}
            onChangeText={(v) => {
              if (side === 'buy') {
                setBuyerName(v);
                clear('buyerName');
              } else {
                setSellerName(v);
                clear('sellerName');
              }
            }}
            placeholder={side === 'buy' ? "Buyer's name" : "Seller's name"}
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
    minHeight: 76,
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
  pickHint: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 3,
    textAlign: 'center',
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
