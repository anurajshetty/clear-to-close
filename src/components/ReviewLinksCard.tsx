// Clear to Close — review-links card (client home, Oct 2026).
//
// APPROVED mockup 07 "Review links v1" (Oct 2026). After the escrow closes,
// the client sees this card on the home: at 100% it sits directly below
// the solid-gold share-profile card (Oct 14, 2026 — the two celebration
// actions moved to the top together, both solid completion gold), above
// the LATEST FROM card: "Leave a review to {first}" on the
// left, the Google logo and the Other-link tile side by side on the
// right (with a small "or" between them when both show). One link set =
// one logo, both = both, none = no card. Tapping a
// logo opens the link in the EXTERNAL browser (Linking.openURL — Safari
// on iOS), never an in-app webview. (The second link was realtor.com-branded until Oct 14, 2026,
// when Anuraj made it a generic "Other" link with a star tile; the stored
// field keeps its name and existing links keep working.)
import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Card } from './ui';
import { reviewLinkTargets } from '../lib/reviewLinks';
import { firstNameOf } from '../lib/pace';
import type { RealtorProfile } from '../lib/types';
import { colors } from '../theme';

// Google multicolor "G" (official brand SVG, copied from the approved mockup).
function GoogleLogo() {
  return (
    <Svg viewBox="0 0 48 48" width={26} height={26}>
      <Path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.7-.4-3.9z"
      />
      <Path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <Path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <Path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41 35.4 44 30.2 44 24c0-1.3-.1-2.7-.4-3.9z"
      />
    </Svg>
  );
}

// "Other" review link tile mark: a generic gold star (the app's review
// gold) in the same bare-SVG treatment as the Google G. Replaced the
// realtor.com house badge Oct 14, 2026 when the link went generic.
function OtherReviewLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={26} height={26}>
      <Path
        fill="#E8A93D"
        d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
      />
    </Svg>
  );
}

/**
 * Opens a review link in the EXTERNAL browser. Extracted (not inline in the
 * Pressable) so the wiring is unit-testable without rendering.
 */
export function openReviewLink(url: string): void {
  void Linking.openURL(url);
}

export function ReviewLinksCard({
  profile,
}: {
  profile: Pick<RealtorProfile, 'name' | 'googleReviewLink' | 'realtorComReviewLink'> | null;
}) {
  const targets = profile ? reviewLinkTargets(profile) : [];
  if (targets.length === 0) return null;
  const first = firstNameOf((profile?.name ?? '').trim()) || 'your realtor';

  return (
    <Card style={styles.card} testID="review-links-card">
      <Text style={styles.text} testID="review-links-text">
        Leave a review to <Text style={styles.name}>{first}</Text>
      </Text>
      <View style={styles.logos}>
        {targets.map((t, i) => (
          <React.Fragment key={t.key}>
            {i > 0 ? (
              <Text style={styles.or} testID="review-links-or">
                or
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.key === 'google' ? 'Review on Google' : 'Review on other site'}
              testID={`review-link-${t.key}`}
              onPress={() => openReviewLink(t.url)}
              style={({ pressed }) => [styles.logoBtn, pressed && { opacity: 0.75 }]}
            >
              {t.key === 'google' ? <GoogleLogo /> : <OtherReviewLogo />}
            </Pressable>
          </React.Fragment>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    // No marginTop: the gap above this card is owned by the share card
    // above it (its marginBottom 14) — owning it here too would double
    // the junction to 28. The gap BELOW is this card's marginBottom 14
    // (bottom-margin ownership, like the top card and LatestFrom), so
    // review -> LATEST FROM equals Refer -> review. This card renders
    // only directly below the share card at 100%, so no other junction
    // moves (Anuraj, Oct 14, 2026).
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    // Match the mockup's review row: 12px gap between text and logos.
    columnGap: 12,
    // Celebration treatment (Oct 14, 2026): SOLID completion gold — the
    // same gold as the top card's 100% ring / timeline fill — shared with
    // the share-profile card above it.
    backgroundColor: colors.gold,
  },
  text: {
    flex: 1,
    fontSize: 15.5,
    lineHeight: 22,
    color: colors.ink,
  },
  name: {
    fontWeight: '800',
  },
  logos: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 10,
  },
  /** The "or" between the two tiles (only when both links are set). */
  or: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  // Mockup: 50x50 logo buttons (above the 44pt tap minimum).
  logoBtn: {
    width: 50,
    height: 50,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: '#E7E0D3',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
