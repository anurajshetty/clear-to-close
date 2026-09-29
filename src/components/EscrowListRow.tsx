// Clear to Close — multi-escrow list row (shared).
// One row per escrow: realtor profile photo (initials + teal fallback),
// address + city, Buyer/Seller/TC badge, realtor name, In progress /
// Completed pill. Completed rows render dimmed and read-only.
// Built once and reused by the client escrow-list screen (Sept 28, 2026,
// Anuraj-approved mockup 01 · screen 16).
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, type } from '../theme';
import type { EscrowListEntry } from '../lib/escrowList';

const BADGE_STYLE: Record<string, { color: string; backgroundColor: string }> = {
  buyer: { color: colors.accent, backgroundColor: colors.accentSoft },
  seller: { color: '#7A5A1E', backgroundColor: '#F3E8D2' },
  tc: { color: '#4A6E5C', backgroundColor: '#E3EFE8' },
};

function roleLabel(role: string): string {
  if (role === 'tc') return 'TC';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function EscrowListRow({
  entry,
  onOpen,
}: {
  entry: EscrowListEntry;
  onOpen: () => void;
}) {
  const badge = BADGE_STYLE[entry.link.role] ?? BADGE_STYLE.buyer;
  const completed = entry.state === 'completed';
  return (
    <Pressable
      style={[styles.row, completed && styles.rowCompleted]}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Open escrow: ${entry.summary.address}, ${entry.summary.city}. ${roleLabel(entry.link.role)}, ${completed ? 'completed' : 'in progress'}, with ${entry.realtorName}.${completed ? ' Read-only.' : ''}`}
    >
      {entry.realtorPhoto ? (
        <Image source={{ uri: entry.realtorPhoto }} style={styles.photo} />
      ) : (
        <View style={styles.photoFallback} accessibilityRole="image" accessibilityLabel={`${entry.realtorName} profile`}>
          <Text style={styles.photoInitials}>{entry.realtorInitials}</Text>
        </View>
      )}
      <View style={styles.text}>
        <View style={styles.top}>
          <Text style={styles.address} numberOfLines={2}>
            {entry.summary.address}
          </Text>
          <Text style={[styles.badge, { color: badge.color, backgroundColor: badge.backgroundColor }]}>
            {roleLabel(entry.link.role)}
          </Text>
        </View>
        <Text style={styles.city} numberOfLines={1}>
          {entry.summary.city}
        </Text>
        <View style={styles.meta}>
          <Text style={styles.realtorName} numberOfLines={1}>
            {entry.realtorName}
          </Text>
          <Text style={[styles.statusPill, completed && styles.statusPillCompleted]}>
            {completed ? 'Completed' : 'In progress'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(231,224,211,.7)',
    borderRadius: 16,
    padding: 14,
    marginTop: 12,
    minHeight: 76,
  },
  // Completed rows: readable, read-only, slightly dimmed (approved spec).
  rowCompleted: { opacity: 0.62 },
  photo: { width: 44, height: 44, borderRadius: 22, marginRight: 12 },
  photoFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginRight: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoInitials: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
  text: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  address: {
    flex: 1,
    color: colors.ink,
    fontWeight: '700',
    fontSize: type.step,
    lineHeight: 21,
    marginRight: 8,
  },
  badge: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.88,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 9,
    marginTop: 2,
  },
  city: { color: colors.body, fontSize: type.body, marginTop: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  realtorName: { color: colors.body, fontSize: type.body, fontWeight: '600', marginRight: 10, flexShrink: 1 },
  statusPill: {
    fontSize: 12.5,
    fontWeight: '700',
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  // Completed pill sits quietly on the dimmed row.
  statusPillCompleted: { color: colors.muted, backgroundColor: '#EFEAE0' },
});
