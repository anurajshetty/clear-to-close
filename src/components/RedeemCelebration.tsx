// Clear to Close — client redeem celebration (approved "Redeem celebration B",
// realtor-branding mockup v1 · Sept 26, 2026).
//
// A brand-teal celebration card shown right after a client redeems their
// invite code: gold "WELCOME ABOARD" kicker, "Your escrow is open!" headline,
// the realtor's photo (initials avatar when none), "<name> has got this.",
// reassuring body copy, and the "<name> / <realty group> · DRE #<number>"
// byline (name and DRE only when no group is set; hidden when neither is
// present). Confetti falls once on mount (~2.5s, ease-out) and settles; the animation
// is skipped when the OS reduced-motion setting is on. Pure React Native +
// react-native-svg (already linked everywhere) — identical on iOS and web,
// no new native modules.
//
// Copy rules: the realtor is referred to by name only (no gendered pronouns);
// no em dashes in user-facing copy.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { store } from '../lib/store-instance';
import type { ClientRole, RealtorProfile } from '../lib/types';
import { PrimaryButton, TextLink, initialsOf } from './ui';

// Brand-teal gradient from the approved mockup (160deg).
const TEAL_FROM = '#175E54';
const TEAL_MID = '#0F443C';
const TEAL_TO = '#0B332D';
const GOLD = '#F5C66B';

const CONFETTI_COUNT = 16;
const CONFETTI_COLORS = ['#F5C66B', '#FFFFFF', '#5FBFAE', '#D9E8E2', '#E8A93D'];
// Ease-out fall, about 2.5s per the approved animation spec.
const CONFETTI_FALL_MS = 2500;

type ConfettiPiece = {
  /** Fraction of the card width (0..1) where the piece falls. */
  left: number;
  /** Fraction of the card height (0..1) where the piece settles. */
  finalY: number;
  size: number;
  color: string;
  circle: boolean;
  /** ms before this piece starts falling. */
  delay: number;
  /** degrees of rotation over the fall. */
  spin: number;
};

/** Deterministic pseudo-random so the layout is stable across renders. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePieces(): ConfettiPiece[] {
  const rand = mulberry32(20260926);
  return Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
    left: 0.04 + rand() * 0.92,
    finalY: 0.08 + rand() * 0.84,
    size: 6 + Math.round(rand() * 4),
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    circle: rand() > 0.5,
    delay: Math.round(rand() * 500),
    spin: Math.round((rand() - 0.5) * 240),
  }));
}

/**
 * Confetti that falls from the top of the card once and settles.
 * When the OS reduced-motion setting is on, pieces render in their settled
 * positions with no animation at all.
 */
function ConfettiLayer({ cardHeight }: { cardHeight: number }) {
  const pieces = useMemo(makePieces, []);
  const anims = useRef<Animated.Value[] | null>(null);
  if (anims.current === null) {
    anims.current = pieces.map(() => new Animated.Value(0));
  }
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (!active) return;
        const r = !!v;
        setReduced(r);
        if (r && anims.current) {
          // Skip the fall entirely: snap pieces to their settled positions.
          anims.current.forEach((a) => {
            a.stopAnimation();
            a.setValue(1);
          });
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (reduced || cardHeight <= 0 || !anims.current) return;
    const timers = anims.current.map((a, i) =>
      Animated.timing(a, {
        toValue: 1,
        duration: CONFETTI_FALL_MS,
        delay: pieces[i].delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    const all = Animated.parallel(timers);
    all.start();
    return () => {
      all.stop();
    };
  }, [reduced, cardHeight, pieces]);

  if (cardHeight <= 0) return null;

  return (
    <View style={styles.confetti} pointerEvents="none" testID="redeem-confetti">
      {pieces.map((p, i) => {
        const a = (anims.current as Animated.Value[])[i];
        const translateY = a.interpolate({
          inputRange: [0, 1],
          outputRange: [-30, p.finalY * cardHeight],
        });
        const rotate = a.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', `${p.spin}deg`],
        });
        return (
          <Animated.View
            key={i}
            testID="confetti-piece"
            style={[
              styles.piece,
              {
                left: `${Math.round(p.left * 100)}%`,
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
                borderRadius: p.circle ? p.size / 2 : 2,
                opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0, 0.95] }),
                transform: [{ translateY }, { rotate }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

function CelebrationCard({
  name,
  photoUri,
  realtyGroup,
  dreLicense,
}: {
  name: string;
  photoUri: string | null;
  realtyGroup: string;
  dreLicense: string;
}) {
  const [cardHeight, setCardHeight] = useState(0);
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
      onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
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
      <ConfettiLayer cardHeight={cardHeight} />
      <View style={styles.cardContent}>
        <Text style={styles.kicker}>WELCOME ABOARD</Text>
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
  onViewEscrow,
  onStartOver,
}: {
  escrowId: string;
  role: ClientRole;
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
            else await store.getSellerView(escrowId);
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
  confetti: StyleSheet.absoluteFill,
  piece: { position: 'absolute', top: 0 },
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
