// Clear to Close — per-side invite sheet: name → Create code → big code + Copy.
// Faithful to APPROVED mockup 01 · Escrow tracker v1, device ⑨.
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { store } from '../lib/store-instance';
import type { ClientRole } from '../lib/types';
import { Field, Kicker, PrimaryButton, Sheet } from './ui';
import { colors } from '../theme';

export function InviteSheet({
  visible,
  side,
  address,
  escrowId,
  onClose,
  onCreated,
}: {
  visible: boolean;
  side: ClientRole;
  address: string;
  escrowId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [phase, setPhase] = useState<'name' | 'code'>('name');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);

  const label = side === 'buyer' ? 'Buyer' : 'Seller';
  const noun = side === 'buyer' ? 'buyer' : 'seller';

  // Reset to the name phase every time the sheet opens.
  useEffect(() => {
    if (visible) {
      setPhase('name');
      setName('');
      setCode('');
      setCreating(false);
    }
  }, [visible, side]);

  const handleClose = () => {
    setPhase('name');
    setName('');
    setCode('');
    setCreating(false);
    onClose();
  };

  const create = async () => {
    const partyName = name.trim();
    if (!partyName || creating) return;
    setCreating(true);
    try {
      const invite = await store.createInvite(escrowId, side, partyName);
      setCode(invite.code);
      setPhase('code');
      onCreated();
    } catch (err) {
      console.warn('createInvite failed', err);
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(code);
    } catch (err) {
      console.warn('clipboard failed', err);
    }
    handleClose();
  };

  return (
    <Sheet visible={visible} onClose={handleClose}>
      {phase === 'name' ? (
        <View>
          <Kicker>
            {label} invite · {address}
          </Kicker>
          <Text style={styles.h3}>Invite the {noun}</Text>
          <Text style={styles.hint}>
            Name the invite first. Their name becomes part of the code.
          </Text>
          <Field
            label={label === 'Buyer' ? "Buyer's name" : "Seller's name"}
            value={name}
            onChangeText={setName}
            placeholder={`${label}'s name`}
          />
          <Text style={styles.hint}>
            They’ll enter this exact name with the code. It has to match.
          </Text>
          <View style={styles.btnWrap}>
            <PrimaryButton
              title={creating ? 'Creating…' : 'Create code'}
              onPress={create}
              disabled={name.trim().length === 0 || creating}
            />
          </View>
        </View>
      ) : (
        <View>
          <Kicker>
            {label} invite · {address}
          </Kicker>
          <Text style={styles.bigCode}>{code}</Text>
          <Text style={styles.hintCenter}>
            Share this code with them. It works once.
          </Text>
          <View style={styles.btnWrap}>
            <PrimaryButton title="Copy" onPress={copy} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  h3: {
    fontSize: 19,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 8,
  },
  hint: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.body,
    marginTop: 6,
  },
  hintCenter: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.body,
    marginTop: 10,
    textAlign: 'center',
  },
  bigCode: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 8,
    color: colors.ink,
    textAlign: 'center',
    marginTop: 18,
  },
  btnWrap: {
    marginTop: 16,
  },
});
