// Clear to Close — client home 100% celebration pieces.
//
// APPROVED mockup screen 10 "Home at 100% · realtor triumph" (Sept 26, 2026),
// rearranged Oct 14, 2026 (Anuraj): at 100% (not cancelled) the two
// celebration actions move to the TOP of the home, directly below the top
// card, both on SOLID completion gold (the 100% ring / timeline gold):
//   - ShareProfileCard — a proper Card holding the "Refer {Name} to
//     friends & family" action (check-green filled button, white label)
//     and the referral line;
//   - the review-links card (src/components/ReviewLinksCard.tsx),
//     directly below it.
// The collapsible checklist ("{N} of {N} steps complete") stays at the
// bottom where the triumph section was (ClientTriumphSection below).
//
// REVIEW (Oct 2026, Anuraj): the in-app "Leave a review" button is REMOVED —
// replaced by the external review-links card (Google / Other logos).
// The in-app ReviewSheet entry is gone; server-side review RPCs and
// stored reviews stay dormant.
//
// Share opens the native share sheet with the message version of the
// approved share copy (see src/lib/shareCopy.ts + src/lib/share.ts).
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card } from './ui';
import { ReadOnlyChecklist } from './Checklist';
import { firstNameOf } from '../lib/pace';
import { profileUrlFor } from '../lib/shareCopy';
import { shareRealtorProfile } from '../lib/share';
import type { RealtorProfile, StepT, ClientRole } from '../lib/types';
import { colors } from '../theme';

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
export function CollapsibleChecklist({ steps, role }: { steps: StepT[]; role: ClientRole }) {
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
          <ReadOnlyChecklist steps={steps} role={role} />
        </View>
      ) : null}
    </View>
  );
}

export type ShareProfileCardProps = {
  profile: RealtorProfile | null;
  /** The client's name (from this device's link) — signs the share email. */
  clientName: string;
  /** Days from today to the target close date — feeds "N days early". */
  daysToClose: number;
  /** The realtor's id — feeds the public profile URL in share copy. */
  realtorId?: string;
  /** Checklist length — feeds the share copy's step count. */
  stepCount: number;
};

/**
 * The 100% share card (Oct 14, 2026): a solid-gold Card directly below
 * the top card holding the refer action, the "Copied to clipboard" note,
 * and the referral line. Treatment shared with the review-links card.
 */
export function ShareProfileCard({
  profile,
  clientName,
  daysToClose,
  realtorId,
  stepCount,
}: ShareProfileCardProps) {
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
      stepCount,
      daysToClose,
      profileUrl: profileUrlFor(realtorId),
      clientName,
    });
    if (outcome === 'copied') {
      setShareNote('Copied to clipboard');
    }
  };

  return (
    <Card style={styles.celebrationCard} testID="share-profile-card">
      <GhostButton
        title={`Refer ${first} to friends & family`}
        accessibilityLabel={`Refer ${name} to friends & family`}
        testID="triumph-share"
        onPress={onShare}
      />
      {shareNote ? (
        <Text style={styles.shareNote} testID="triumph-share-note">
          {shareNote}
        </Text>
      ) : null}

      <Text style={styles.referral} testID="triumph-referral">
        {'Know someone buying or selling?\nSend them your realtor.'}
      </Text>
    </Card>
  );
}

export type ClientTriumphSectionProps = {
  steps: StepT[];
  /** Client role — drives step-explainer copy in the collapsed checklist. */
  role: ClientRole;
};

/**
 * What remains at the bottom of the 100% home: the collapsible checklist
 * alone. (The share block moved up into ShareProfileCard, Oct 14, 2026.)
 */
export function ClientTriumphSection({ steps, role }: ClientTriumphSectionProps) {
  return (
    <View testID="triumph-section">
      <CollapsibleChecklist steps={steps} role={role} />
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
  // The celebration treatment (Oct 14, 2026): SOLID completion gold —
  // the same gold as the top card's 100% ring / timeline fill — shared
  // with the review-links card so the two 100% actions read as a pair.
  // Spacing ownership: this card owns the gap BELOW it (marginBottom
  // 14, the pair rhythm) — the review card under it has no top margin,
  // so Refer -> review is 14, and when no review links exist Refer ->
  // LATEST FROM is the same 14 (Anuraj, Oct 14, 2026).
  celebrationCard: {
    marginTop: 14,
    marginBottom: 14,
    backgroundColor: colors.gold,
  },
  ghostBtn: {
    borderRadius: 12,
    // Check-green filled button (colors.accent — the completed-check
    // token) so the action pops on the solid-gold card; white label.
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    minHeight: 52,
  },
  ghostBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  shareNote: {
    fontSize: 12.5,
    color: colors.ink,
    textAlign: 'center',
    marginTop: 8,
  },
  referral: {
    fontSize: 12,
    color: colors.ink,
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 12,
  },
});
