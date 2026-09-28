// Clear to Close — shared banner strip (realtor header strip, Anuraj,
// Sept 2026).
//
// Built ONCE and reused by two surfaces (UI-reuse standing rule): the
// client top card's banner strip (src/components/ClientTopCard.tsx) and
// the realtor home screen's banner section (app/index.tsx). One component
// means the realtor's header is a pixel-exact preview of what clients see
// and the two can never drift.
//
// Geometry comes from the approved samples via props: the client card
// passes the responsive topCardTokens; the realtor home passes the
// large-class tokens (banner 118, photo 88, photoRight 18, photoBorder 3,
// photoInitials 32).
//
// The banner is the realtor's synced banner image, cover-cropped; the
// brand-teal gradient strip is the fallback when no banner is uploaded.
// The photo sits on the strip's right side, vertically centered, with a
// white ring; tapping it calls onPhotoPress.
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { initialsOf } from './ui';

const AMBER = '#A86A12';
const AMBER_LIGHT = '#E0B34E';

/** Brand-teal gradient fallback for the banner strip when no banner is set. */
export function TealGradientFallback({ testID }: { testID?: string }) {
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      testID={testID}
    >
      <Defs>
        <LinearGradient id="topcardBannerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#0E3B36" />
          <Stop offset="55%" stopColor="#175E54" />
          <Stop offset="100%" stopColor="#2A7A6C" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill="url(#topcardBannerGrad)" />
    </Svg>
  );
}

/**
 * The realtor photo on the banner strip's right side (approved sample,
 * Anuraj, Sept 2026): the synced photo when available, otherwise the
 * amber-gold gradient circle with the realtor's initials.
 */
export function BannerPhoto({
  name,
  photoUri,
  size,
  borderWidth,
  initialsSize,
}: {
  name: string;
  photoUri: string | null;
  size: number;
  borderWidth: number;
  initialsSize: number;
}) {
  const inner = size - borderWidth * 2;
  return (
    <View
      style={[
        styles.photoRing,
        { width: size, height: size, borderRadius: size / 2, borderWidth },
      ]}
    >
      {photoUri ? (
        <Image
          source={{ uri: photoUri }}
          style={{ width: inner, height: inner, borderRadius: inner / 2 }}
        />
      ) : (
        <View style={{ width: inner, height: inner, borderRadius: inner / 2, overflow: 'hidden' }}>
          <Svg width={inner} height={inner} viewBox={`0 0 ${inner} ${inner}`}>
            <Defs>
              <LinearGradient id="topcardPhotoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <Stop offset="0%" stopColor={AMBER} />
                <Stop offset="100%" stopColor={AMBER_LIGHT} />
              </LinearGradient>
            </Defs>
            <Circle cx={inner / 2} cy={inner / 2} r={inner / 2} fill="url(#topcardPhotoGrad)" />
          </Svg>
          <View style={styles.photoInitialsWrap}>
            <Text style={[styles.photoInitials, { fontSize: initialsSize }]}>
              {initialsOf(name)}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

export interface BannerStripProps {
  /** Realtor's display name (initials fallback when no photo). */
  name: string;
  /** Synced banner URI; null renders the brand-teal gradient fallback. */
  bannerUri: string | null;
  /** Synced photo URI; null renders the initials circle. */
  photoUri: string | null;
  /** Strip height (client card: responsive token; realtor home: 118). */
  bannerHeight: number;
  /** Photo circle size (client card: responsive token; realtor home: 88). */
  photoSize: number;
  /** Photo's right offset (client card: responsive; realtor home: 18). */
  photoRight: number;
  /** White ring width (client card: responsive; realtor home: 3). */
  photoBorder: number;
  /** Initials font size inside the photo fallback circle. */
  initialsSize: number;
  /** Called when the photo is tapped; when absent the photo is not a button. */
  onPhotoPress?: () => void;
  /** Accessibility label for the photo button. */
  photoAccessibilityLabel: string;
  /** testIDs so each surface keeps its existing instrumentation. */
  stripTestID: string;
  bannerTestID: string;
  gradientTestID: string;
  photoTestID: string;
}

export function BannerStrip({
  name,
  bannerUri,
  photoUri,
  bannerHeight,
  photoSize,
  photoRight,
  photoBorder,
  initialsSize,
  onPhotoPress,
  photoAccessibilityLabel,
  stripTestID,
  bannerTestID,
  gradientTestID,
  photoTestID,
}: BannerStripProps) {
  const photo = (
    <BannerPhoto
      name={name}
      photoUri={photoUri}
      size={photoSize}
      borderWidth={photoBorder}
      initialsSize={initialsSize}
    />
  );
  return (
    <View style={[styles.bannerStrip, { height: bannerHeight }]} testID={stripTestID}>
      {bannerUri ? (
        <Image
          source={{ uri: bannerUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          testID={bannerTestID}
        />
      ) : (
        <TealGradientFallback testID={gradientTestID} />
      )}
      {onPhotoPress ? (
        <Pressable
          onPress={onPhotoPress}
          accessibilityRole="button"
          accessibilityLabel={photoAccessibilityLabel}
          style={[styles.photoBtn, { right: photoRight, transform: [{ translateY: -(photoSize / 2) }] }]}
          testID={photoTestID}
        >
          {photo}
        </Pressable>
      ) : (
        <View
          style={[styles.photoBtn, { right: photoRight, transform: [{ translateY: -(photoSize / 2) }] }]}
          testID={photoTestID}
        >
          {photo}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Banner header strip: the realtor's synced banner, cover-cropped, full
  // strip width; the brand-teal gradient is the fallback. The strip's
  // rounded top corners (client card) come from `overflow: hidden` on the
  // card above.
  bannerStrip: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#0E3B36',
  },
  // Realtor photo on the banner's right side: vertically centered on the
  // strip, white ring.
  photoBtn: {
    position: 'absolute',
    top: '50%',
  },
  photoRing: {
    borderColor: '#FFFFFF',
    backgroundColor: AMBER,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoInitialsWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoInitials: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
});
