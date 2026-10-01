// Clear to Close — client home 100% below-card section.
//
// APPROVED mockup screen 10 "Home at 100% · realtor triumph" (Sept 26, 2026).
// Below the top card:
//   - the checklist collapses to one tappable row ("{N} of {N} steps
//     complete · View") that expands inline to the full read-only list;
//   - "Share {Name}'s profile" button;
//   - the line "Know someone buying or selling? Send them your realtor."
//
// REVIEW (Oct 2026, Anuraj): the in-app "Leave a review" button is REMOVED —
// replaced by the external review-links card (Google / realtor.com logos)
// that sits below the main client card. The in-app ReviewSheet entry is
// gone; server-side review RPCs and stored reviews stay dormant.
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

export type ClientTriumphSectionProps = {
  steps: StepT[];
  profile: RealtorProfile | null;
  /** Client role — drives step-explainer copy in the collapsed checklist. */
  role: ClientRole;
  /** The client's name (from this device's link) — signs the share email. */
  clientName: string;
  /** Days from today to the target close date — feeds "N days early". */
  daysToClose: number;
  /** The realtor's id — feeds the public profile URL in share copy. */
  realtorId?: string;
};

export function ClientTriumphSection({
  steps,
  profile,
  role,
  clientName,
  daysToClose,
  realtorId,
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
      <CollapsibleChecklist steps={steps} role={role} />

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
