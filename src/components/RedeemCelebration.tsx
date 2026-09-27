// Clear to Close — client redeem celebration (approved "Redeem celebration B",
// realtor-branding mockup v1 · Sept 26, 2026).
//
// A brand-teal celebration card shown right after a client redeems their
// invite code: gold "Congratulations, {client name}" kicker, "Your escrow is open!" headline,
// the realtor's photo (initials avatar when none), "<name> has got this.",
// reassuring body copy, and the "<name> / <realty group> · DRE #<number>"
// byline (name and DRE only when no group is set; hidden when neither is
// present). Confetti falls once on mount (~2.5s, ease-out) and a confetti
// burst pops up from the bottom edge of the card when the celebration
// appears (Anuraj's call, Sept 2026); both animations are skipped when the
// OS reduced-motion setting is on. Both animations are the shared
// ConfettiLayer / ConfettiBurst from src/components/Confetti.tsx (one
// implementation reused everywhere — no local copies). Pure React Native +
// react-native-svg (already linked everywhere) — identical on iOS and web,
// no new native modules.
//
// Copy rules: the realtor is referred to by name only (no gendered pronouns);
// no em dashes in user-facing copy.
import React, { useEffect, useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { store } from '../lib/store-instance';
import type { ClientRole, RealtorProfile } from '../lib/types';
import { celebrationKicker } from '../lib/shareCopy';
import { ConfettiBurst, ConfettiLayer } from './Confetti';
import { PrimaryButton, TextLink, initialsOf } from './ui';

// Brand-teal gradient from the approved mockup (160deg).
const TEAL_FROM = '#175E54';
const TEAL_MID = '#0F443C';
const TEAL_TO = '#0B332D';
const GOLD = '#F5C66B';

function CelebrationCard({
  clientName,
  name,
  photoUri,
  realtyGroup,
  dreLicense,
}: {
  clientName: string;
  name: string;
  photoUri: string | null;
  realtyGroup: string;
  dreLicense: string;
}) {
  const [cardSize, setCardSize] = useState({ w: 0, h: 0 });
  // "<name> / <realty group> · DRE #<number>"; name and DRE only when there
  // is no group set — never a dangling separator. Hidden entirely when
  // neither group nor DRE is present (the name already shows above).
  let byline: string | null = name;
  if (realtyGroup) byline += ` / ${realtyGroup}`;
  const dre = dreLicense.trim();
  if (dre) byline += ` · DRE #${dre}`;
  if (byline === name) byline = null;
  return (
    <View
      style={styles.card}
      testID="redeem-celebration-card"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setCardSize({ w: width, h: height });
      }}
    >
      {/* Brand-teal gradient backdrop (react-native-svg is already linked). */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id="redeemCelebrate" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={TEAL_FROM} />
            <Stop offset="60%" stopColor={TEAL_MID} />
            <Stop offset="100%" stopColor={TEAL_TO} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#redeemCelebrate)" rx="22" />
      </Svg>
      <ConfettiLayer cardHeight={cardSize.h} testID="redeem-confetti" />
      <ConfettiBurst cardWidth={cardSize.w} cardHeight={cardSize.h} testID="redeem-confetti-burst" />
      <View style={styles.cardContent}>
        <Text style={styles.kicker}>{celebrationKicker(clientName)}</Text>
        <Text style={styles.headline}>
          Your escrow{'\n'}is open!
        </Text>
        <View style={styles.avatarRow}>
          {photoUri ? (
            <Image
              source={{ uri: photoUri }}
              style={styles.avatar}
              accessibilityLabel={`Photo of ${name}`}
            />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarInitials}>{initialsOf(name)}</Text>
            </View>
          )}
        </View>
        <Text style={styles.reassure}>{name} has got this.</Text>
        <Text style={styles.body}>
          Every inspection, signature, and deadline, handled for you. {name} will keep you
          posted at every step.
        </Text>
        {byline ? <Text style={styles.byline}>{byline}</Text> : null}
      </View>
    </View>
  );
}

/**
 * The redeem-success screen: celebration card, then "View my escrow",
 * then "Not your escrow? Start over". The realtor's profile is the one
 * attached to the escrow being redeemed (linked-first, local fallback).
 */
export function RedeemCelebration({
  escrowId,
  role,
  clientName,
  onViewEscrow,
  onStartOver,
}: {
  escrowId: string;
  role: ClientRole;
  /** The redeemed invite's party name (server-validated at redeem time). */
  clientName: string;
  onViewEscrow: () => void;
  onStartOver: () => void;
}) {
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      let p: RealtorProfile | null = null;
      try {
        p = await store.getClientProfile(escrowId);
        if (!p) {
          // Warm the linked-profile cache from the cloud client view, then
          // retry once — the realtor's profile travels with the view.
          try {
            if (role === 'buyer') await store.getBuyerView(escrowId);
            else if (role === 'seller') await store.getSellerView(escrowId);
            else await store.getTcView(escrowId);
          } catch {
            // Offline or cloud unreachable: fall through to the fallback.
          }
          p = await store.getClientProfile(escrowId);
        }
      } catch {
        p = null;
      }
      if (active) {
        setProfile(p);
        setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [escrowId, role]);

  if (!ready) {
    return <Text style={styles.loading}>Loading…</Text>;
  }

  // Last-resort fallback when no realtor profile is reachable at all:
  // generic, name-only, no gendered pronouns.
  const name = profile?.name?.trim() || 'Your realtor';
  // The realty group field is canonical snake_case `realty_group`; older
  // saved profiles may carry the legacy camelCase or brokerage keys.
  // The store normalizes a missing field to an empty string, so pick the
  // first non-empty value rather than nullish-coalescing.
  const nonEmpty = (...vals: unknown[]): string => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const realtyGroup = nonEmpty(
    (profile as { realty_group?: unknown } | null)?.realty_group,
    (profile as { realtyGroup?: unknown } | null)?.realtyGroup,
    (profile as { brokerage?: unknown } | null)?.brokerage,
  );

  return (
    <>
      <CelebrationCard
        clientName={clientName}
        name={name}
        photoUri={profile?.photoUri ?? null}
        realtyGroup={realtyGroup}
        dreLicense={profile?.dreLicense ?? ''}
      />
      <View style={styles.cta}>
        <PrimaryButton title="View my escrow" onPress={onViewEscrow} />
      </View>
      <TextLink title="Not your escrow? Start over" onPress={onStartOver} />
    </>
  );
}

const styles = StyleSheet.create({
  loading: { fontSize: 15, color: '#8A8175', textAlign: 'center', marginTop: 40 },
  card: { marginTop: 6, borderRadius: 22, overflow: 'hidden' },
  cardContent: {
    paddingVertical: 26,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  kicker: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: GOLD,
  },
  headline: {
    fontSize: 26,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 32,
  },
  avatarRow: { marginTop: 14, alignItems: 'center' },
  avatar: { width: 58, height: 58, borderRadius: 29, borderWidth: 3, borderColor: '#FFFFFF' },
  avatarFallback: {
    backgroundColor: '#2E8B7A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  reassure: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    marginTop: 10,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: '#D9E8E2',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 21,
  },
  byline: { fontSize: 13, color: '#BFD4CC', marginTop: 14, textAlign: 'center' },
  cta: { marginTop: 18 },
});
