// Clear to Close — shared realtor profile form.
//
// The single approved profile form, reused by profile setup (01·⑬),
// onboarding profile creation (㉒), and profile update (㉕): photo, full
// name, optional realty group, about, years of experience, average days to
// close, areas served, optional DRE/license, plus phone. Buttons and headers
// belong to the screens; this component owns the fields only.

import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { deleteLegacyPhotoFile, saveManagedBanner, saveManagedPhoto } from '../lib/photoFile';
import { bannerSizeHint } from '../lib/bannerSize';
import { Field } from './ui';
import { initialsOf } from './ui';
import { colors } from '../theme';

export interface ProfileDraft {
  name: string;
  /** Optional realty group / brokerage (Sept 2026) — free text, no validation. */
  realty_group: string;
  photoUri: string | null;
  /** Optional banner image (Sept 2026) — one managed file, same pattern as the photo. */
  banner_image: string | null;
  about: string;
  yearsExperience: string;
  /** Average days to close (Sept 2026) — free text, no validation. */
  avgDaysToClose: string;
  areasServed: string;
  phone: string;
  dreLicense: string;
}

export const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  name: '',
  realty_group: '',
  photoUri: null,
  banner_image: null,
  about: '',
  yearsExperience: '',
  avgDaysToClose: '',
  areasServed: '',
  phone: '',
  dreLicense: '',
};

interface ProfileFormProps {
  value: ProfileDraft;
  onChange: (patch: Partial<ProfileDraft>) => void;
  /** Inline error shown under the Full name field (㉕ "Required" state). */
  nameError?: string | null;
}

function CameraIcon() {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M4 8h3l2-3h6l2 3h3v12H4z"
        stroke="#8A8177"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={13} r={3.4} stroke="#8A8177" strokeWidth={1.8} />
    </Svg>
  );
}

// Profile-photo size cap (Sept 2026, automatic — no user prompt): at pick
// time the long edge is scaled to at most 1024px and the image is saved as
// JPEG at ~0.8 quality, targeting ≤ ~1MB. Both the signup profile step and
// the edit-profile "Change photo" flow share this form, so both get it.
const MAX_PHOTO_EDGE = 1024;

async function cappedPhotoUri(
  uri: string,
  width?: number,
  height?: number,
): Promise<string> {
  let w = width ?? 0;
  let h = height ?? 0;
  if (!w || !h) {
    // Best-effort dimension lookup for pickers that omit them.
    const size = await new Promise<{ width: number; height: number } | null>(
      (resolve) => {
        Image.getSize(
          uri,
          (sw, sh) => resolve({ width: sw, height: sh }),
          () => resolve(null),
        );
      },
    );
    if (!size) return uri;
    w = size.width;
    h = size.height;
  }
  const longEdge = Math.max(w, h);
  const actions: { resize: { width: number; height: number } }[] =
    longEdge > MAX_PHOTO_EDGE
      ? [
          {
            resize: {
              width: Math.round((w * MAX_PHOTO_EDGE) / longEdge),
              height: Math.round((h * MAX_PHOTO_EDGE) / longEdge),
            },
          },
        ]
      : [];
  const out = await manipulateAsync(uri, actions, {
    compress: 0.8,
    format: SaveFormat.JPEG,
  });
  return out.uri;
}

export function ProfileForm({ value, onChange, nameError }: ProfileFormProps) {
  // A saved photo URI can go stale (e.g. a dead file/blob URI). Fall back
  // to initials rather than rendering a broken image; resets per URI.
  const [photoBroken, setPhotoBroken] = useState(false);
  useEffect(() => {
    setPhotoBroken(false);
  }, [value.photoUri]);
  // Quiet inline error when a picked image genuinely can't be processed.
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Banner image (Sept 2026): same pick + downscale pipeline as the photo,
  // stored as one managed file (profile-banner.jpg) that is overwritten on
  // every pick. No legacy-file cleanup: banners never existed before, so
  // there is nothing stale to drop.
  const [bannerBroken, setBannerBroken] = useState(false);
  useEffect(() => {
    setBannerBroken(false);
  }, [value.banner_image]);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const pickBanner = async () => {
    setBannerError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      // Full quality here: we resize + JPEG-compress ourselves below.
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    const asset = res.assets[0];
    try {
      const capped = await cappedPhotoUri(asset.uri, asset.width, asset.height);
      const managed = await saveManagedBanner(capped);
      onChange({ banner_image: managed });
    } catch {
      setBannerError('Couldn’t use that image. Try a different one.');
    }
  };

  const pickPhoto = async () => {
    setPhotoError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      // Full quality here: we resize + JPEG-compress ourselves below.
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    const asset = res.assets[0];
    try {
      const capped = await cappedPhotoUri(asset.uri, asset.width, asset.height);
      const previous = value.photoUri;
      // Single managed file (Sept 2026): the final image is copied to one
      // fixed location, overwriting the previous photo, so files never pile up.
      const managed = await saveManagedPhoto(capped);
      // Drop the stale file from the previous pick, if any (the old flow
      // stored unique cache URIs). The managed file itself was overwritten,
      // never deleted.
      await deleteLegacyPhotoFile(previous);
      onChange({ photoUri: managed });
    } catch {
      setPhotoError('Couldn’t use that photo. Try a different one.');
    }
  };

  const set = (key: keyof ProfileDraft) => (text: string) => onChange({ [key]: text } as Partial<ProfileDraft>);

  return (
    <View>
      <Field label="Full name" value={value.name} onChangeText={set('name')} placeholder="e.g. Maya Chen" />
      {nameError ? <Text style={styles.nameError}>{nameError}</Text> : null}
      <Field
        label="Realty group"
        value={value.realty_group}
        onChangeText={set('realty_group')}
        placeholder="e.g. Compass Realty"
      />
      <View style={styles.photoRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value.photoUri ? 'Change profile photo' : 'Add profile photo'}
          onPress={pickPhoto}
          style={[styles.photoBtn, value.photoUri && styles.photoBtnPicked]}
        >
          {value.photoUri && !photoBroken ? (
            <Image
              source={{ uri: value.photoUri }}
              style={styles.photoImg}
              onError={() => setPhotoBroken(true)}
            />
          ) : value.photoUri ? (
            <Text style={styles.photoInitials}>{initialsOf(value.name)}</Text>
          ) : (
            <CameraIcon />
          )}
        </Pressable>
        <View style={styles.photoText}>
          <Text style={styles.photoLabel}>
            {value.photoUri ? 'Change photo' : 'Add photo'}
          </Text>
          <Text style={styles.photoSub}>
            Square works best. Shown to every client.
          </Text>
        </View>
      </View>
      {photoError ? <Text style={styles.photoError}>{photoError}</Text> : null}

      <View style={styles.photoRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value.banner_image ? 'Change banner image' : 'Add banner image'}
          onPress={pickBanner}
          style={[styles.bannerBtn, value.banner_image && styles.photoBtnPicked]}
        >
          {value.banner_image && !bannerBroken ? (
            <Image
              source={{ uri: value.banner_image }}
              style={styles.bannerImg}
              onError={() => setBannerBroken(true)}
            />
          ) : (
            <CameraIcon />
          )}
        </Pressable>
        <View style={styles.photoText}>
          <Text style={styles.photoLabel}>
            {value.banner_image ? 'Change banner' : 'Add banner image'}
          </Text>
          <Text style={styles.photoSub}>{bannerSizeHint()}</Text>
        </View>
      </View>
      {bannerError ? <Text style={styles.photoError}>{bannerError}</Text> : null}
      <Field
        label="About"
        value={value.about}
        onChangeText={set('about')}
        placeholder="Tell clients about yourself"
        multiline
      />
      <Field
        label="Years of experience"
        value={value.yearsExperience}
        onChangeText={set('yearsExperience')}
        placeholder="e.g. 12"
      />
      <Field
        label="Avg days to close"
        value={value.avgDaysToClose}
        onChangeText={set('avgDaysToClose')}
        placeholder="e.g. 21"
      />
      <Field
        label="Areas served"
        value={value.areasServed}
        onChangeText={set('areasServed')}
        placeholder="e.g. Santa Clarita, Valencia"
      />
      <Field
        label="DRE / license number (optional)"
        value={value.dreLicense}
        onChangeText={set('dreLicense')}
        placeholder="e.g. 01992736"
      />
      <Field
        label="Phone (optional)"
        value={value.phone}
        onChangeText={set('phone')}
        placeholder="Shown as a tap-to-call row on your client profile"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  photoRow: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
    marginTop: 18,
  },
  photoBtn: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.photoBorder,
    backgroundColor: colors.inputBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoBtnPicked: {
    borderStyle: 'solid',
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  photoInitials: {
    fontSize: 28,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  photoImg: {
    width: 84,
    height: 84,
    borderRadius: 42,
  },
  bannerBtn: {
    width: 112,
    height: 64,
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.photoBorder,
    backgroundColor: colors.inputBg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  bannerImg: {
    width: 112,
    height: 64,
    borderRadius: 10,
  },
  photoText: {
    flex: 1,
  },
  photoLabel: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.ink,
  },
  photoSub: {
    fontSize: 13,
    color: colors.muted,
    lineHeight: 18.2,
    marginTop: 2,
  },
  nameError: {
    fontSize: 13,
    fontWeight: '600',
    color: '#D44',
    marginTop: 6,
    marginBottom: -10,
  },
  photoError: {
    fontSize: 13,
    fontWeight: '600',
    color: '#D44',
    marginTop: 6,
    marginBottom: 2,
  },
});
