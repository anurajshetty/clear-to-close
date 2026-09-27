// Clear to Close — client home 100% below-card section.
//
// APPROVED mockup screen 10 "Home at 100% · realtor triumph" (Sept 26, 2026).
// Below the top card:
//   - the checklist collapses to one tappable row ("{N} of {N} steps
//     complete · View") that expands inline to the full read-only list;
//   - "Leave {Name} a review" (gold) and "Share {Name}'s profile" buttons;
//   - the line "Know someone buying or selling? Send them your realtor."
//
// REVIEW (wired Sept 2026 branding release): the buyer/seller home screens
// pass an opener for the profile stream's ReviewSheet as
// `onLeaveReviewPress`. When absent, the review button stays inert.
//
// Share opens the native share sheet with the message version of the
// approved share copy (see src/lib/shareCopy.ts + src/lib/share.ts).
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Card } from './ui';
import { ReadOnlyChecklist } from './Checklist';
import { firstNameOf } from '../lib/pace';
import { profileUrlFor } from '../lib/shareCopy';
import { shareRealtorProfile } from '../lib/share';
import type { RealtorProfile } from '../lib/types';
import type { StepT } from '../lib/types';
import { colors } from '../theme';

const GOLD_FROM = '#E8A93D';
const GOLD_TO = '#D98E2B';

/** Gold gradient button (mockup .btn.gold). */
function GoldButton({
  title,
  onPress,
  testID,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.goldBtn, pressed && { opacity: 0.88 }]}
    >
      <Svg
        style={StyleSheet.absoluteFill}
        width="100%"
        height="100%"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <Defs>
          <LinearGradient id="triumphGold" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={GOLD_FROM} />
            <Stop offset="1" stopColor={GOLD_TO} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="100" fill="url(#triumphGold)" />
      </Svg>
      <Text style={styles.goldBtnText}>{title}</Text>
    </Pressable>
  );
}

/** Ghost button (mockup .btn.ghost). */
function GhostButton({
  title,
  onPress,
  testID,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.ghostBtn, pressed && { opacity: 0.75 }]}
    >
      <Text style={styles.ghostBtnText}>{title}</Text>
    </Pressable>
  );
}

/**
 * The 100% checklist: one tappable row that expands inline to the full
 * read-only list. Collapsed by default.
 */
export function CollapsibleChecklist({ steps }: { steps: StepT[] }) {
  const [expanded, setExpanded] = useState(false);
  const n = steps.length;
  return (
    <View testID="triumph-checklist">
      <Card style={styles.collapsedCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? `Hide the ${n} completed steps` : `View the ${n} completed steps`
          }
          onPress={() => setExpanded((v) => !v)}
          testID="triumph-checklist-toggle"
          style={styles.collapsedRow}
        >
          <View style={styles.collapsedLeft}>
            <View style={styles.collapsedCheck}>
              <Text style={styles.collapsedCheckMark}>✓</Text>
            </View>
            <Text style={styles.collapsedTitle}>{`${n} of ${n} steps complete`}</Text>
          </View>
          <Text style={styles.collapsedToggle}>{expanded ? 'Hide ∧' : 'View ∨'}</Text>
        </Pressable>
      </Card>
      {expanded ? (
        <View style={styles.expandedList} testID="triumph-checklist-expanded">
          <ReadOnlyChecklist steps={steps} />
        </View>
      ) : null}
    </View>
  );
}

export type ClientTriumphSectionProps = {
  steps: StepT[];
  profile: RealtorProfile | null;
  /** The client's name (from this device's link) — signs the share email. */
  clientName: string;
  /** Days from today to the target close date — feeds "N days early". */
  daysToClose: number;
  /** The realtor's id — feeds the public profile URL in share copy. */
  realtorId?: string;
  /**
   * Opens the profile stream's ReviewSheet (wired by the buyer/seller home
   * screens). When absent, the review button stays inert.
   */
  onLeaveReviewPress?: () => void;
};

export function ClientTriumphSection({
  steps,
  profile,
  clientName,
  daysToClose,
  realtorId,
  onLeaveReviewPress,
}: ClientTriumphSectionProps) {
  const [shareNote, setShareNote] = useState<string | null>(null);
  const name = (profile?.name ?? '').trim();
  const first = firstNameOf(name) || 'your realtor';

  const onShare = async () => {
    setShareNote(null);
    const outcome = await shareRealtorProfile({
      realtorName: name,
      realtyGroup: profile?.realty_group ?? null,
      dreLicense: profile?.dreLicense ?? null,
      yearsExperience: profile?.yearsExperience ?? null,
      rating: profile?.rating ?? null,
      tagline: (profile?.about ?? '').trim() || null,
      stepCount: steps.length,
      daysToClose,
      profileUrl: profileUrlFor(realtorId),
      clientName,
    });
    if (outcome === 'copied') {
      setShareNote('Copied to clipboard');
    }
  };

  return (
    <View testID="triumph-section">
      <CollapsibleChecklist steps={steps} />

      <View style={styles.btnWrap}>
        <GoldButton
          title={`Leave ${first} a review`}
          accessibilityLabel={`Leave ${name} a review`}
          testID="triumph-review"
          onPress={() => {
            onLeaveReviewPress?.();
          }}
        />
      </View>
      <View style={styles.btnWrap}>
        <GhostButton
          title={`Share ${first}'s profile`}
          accessibilityLabel={`Share ${name}'s profile`}
          testID="triumph-share"
          onPress={onShare}
        />
      </View>
      {shareNote ? (
        <Text style={styles.shareNote} testID="triumph-share-note">
          {shareNote}
        </Text>
      ) : null}

      <Text style={styles.referral} testID="triumph-referral">
        {'Know someone buying or selling?\nSend them your realtor.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  collapsedCard: {
    marginBottom: 14,
  },
  collapsedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  collapsedLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  collapsedCheck: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsedCheckMark: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  collapsedTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
    marginLeft: 10,
  },
  collapsedToggle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent,
  },
  expandedList: {
    marginTop: -6,
    marginBottom: 14,
  },
  btnWrap: {
    marginBottom: 12,
  },
  goldBtn: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    minHeight: 52,
  },
  goldBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  ghostBtn: {
    borderRadius: 12,
    backgroundColor: '#EDE7DA',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    minHeight: 52,
  },
  ghostBtnText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  shareNote: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    marginTop: -4,
    marginBottom: 8,
  },
  referral: {
    fontSize: 12,
    color: '#8A7F6E',
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 12,
  },
});
