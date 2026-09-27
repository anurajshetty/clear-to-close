// Clear to Close — shared realtor profile form.
//
// The single approved profile form, reused by profile setup (01·⑬),
// onboarding profile creation (㉒), and profile update (㉕). Field order
// (Anuraj, Sept 2026): 1. Profile pic, 2. Banner image, 3. Full name,
// 4. Email, 5. Phone, 6. Broker, 7. About, 8. Years of experience,
// 9. Areas served, 10. License number. Buttons and headers belong to the
// screens; this component owns the fields only.

import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import { deleteLegacyPhotoFile, saveManagedBanner, saveManagedPhoto } from '../lib/photoFile';
import { bannerSizeHint } from '../lib/bannerSize';
import { Field } from './ui';
import { initialsOf } from './ui';
import { PhotoCropper, type CropKind } from './PhotoCropper';
import { colors } from '../theme';

export interface ProfileDraft {
  name: string;
  /** Optional email (Sept 2026) — free text, kept on the realtor side only. */
  email: string;
  /** Optional realty group / brokerage (Sept 2026) — free text, no validation. */
  realty_group: string;
  photoUri: string | null;
  /** Optional banner image (Sept 2026) — one managed file, same pattern as the photo. */
  banner_image: string | null;
  about: string;
  yearsExperience: string;
  areasServed: string;
  phone: string;
  dreLicense: string;
}

export const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  name: '',
  email: '',
  realty_group: '',
  photoUri: null,
  banner_image: null,
  about: '',
  yearsExperience: '',
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

// Profile-photo size cap (Sept 2026, automatic — no user prompt): the crop
// editor downscales the cropped result so its long edge is at most 1024px,
// saved as JPEG at ~0.8 quality, targeting ≤ ~1MB. Both the signup profile
// step and the edit-profile "Change photo" flow share this form, so both
// get it. See src/lib/cropMath.ts (MAX_CROP_EDGE).

interface CropJob {
  uri: string;
  width?: number;
  height?: number;
  kind: CropKind;
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

  // Crop editor (Sept 2026, Anuraj-approved): after picking, the raw image
  // opens in the cropper BEFORE anything is saved. Use photo / Use banner
  // crops + downscales and lands here for the managed-file save below.
  const [cropJob, setCropJob] = useState<CropJob | null>(null);

  const pickBanner = async () => {
    setBannerError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // No native editing: our own crop editor (wide rectangle frame) runs
      // before saving.
      allowsEditing: false,
      // Full quality here: we crop + JPEG-compress ourselves below.
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    const asset = res.assets[0];
    setCropJob({ uri: asset.uri, width: asset.width, height: asset.height, kind: 'banner' });
  };

  const pickPhoto = async () => {
    setPhotoError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // No native editing: our own crop editor (circular frame) runs before
      // saving.
      allowsEditing: false,
      // Full quality here: we crop + JPEG-compress ourselves below.
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    const asset = res.assets[0];
    setCropJob({ uri: asset.uri, width: asset.width, height: asset.height, kind: 'photo' });
  };

  const onCropUse = async (croppedUri: string) => {
    const job = cropJob;
    setCropJob(null);
    if (!job) return;
    try {
      if (job.kind === 'photo') {
        const previous = value.photoUri;
        // Single managed file (Sept 2026): the final image is copied to one
        // fixed location, overwriting the previous photo, so files never pile up.
        const managed = await saveManagedPhoto(croppedUri);
        // Drop the stale file from the previous pick, if any (the old flow
        // stored unique cache URIs). The managed file itself was overwritten,
        // never deleted.
        await deleteLegacyPhotoFile(previous);
        onChange({ photoUri: managed });
      } else {
        const managed = await saveManagedBanner(croppedUri);
        onChange({ banner_image: managed });
      }
    } catch {
      if (job.kind === 'photo') {
        setPhotoError('Couldn’t use that photo. Try a different one.');
      } else {
        setBannerError('Couldn’t use that image. Try a different one.');
      }
    }
  };

  const onCropRetake = () => {
    const kind = cropJob?.kind;
    setCropJob(null);
    // Re-open the picker so the realtor can choose a different image.
    if (kind === 'photo') void pickPhoto();
    else if (kind === 'banner') void pickBanner();
  };

  const set = (key: keyof ProfileDraft) => (text: string) => onChange({ [key]: text } as Partial<ProfileDraft>);

  return (
    <View>
      {/* 1. Profile pic */}
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

      {/* 2. Banner image */}
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
      {/* 3. Full name */}
      <Field label="Full name" value={value.name} onChangeText={set('name')} placeholder="e.g. Maya Chen" />
      {nameError ? <Text style={styles.nameError}>{nameError}</Text> : null}
      {/* 4. Email */}
      <Field
        label="Email (optional)"
        value={value.email}
        onChangeText={set('email')}
        placeholder="e.g. maya@compass.com"
        keyboardType="email-address"
        autoCapitalize="none"
      />
      {/* 5. Phone */}
      <Field
        label="Phone (optional)"
        value={value.phone}
        onChangeText={set('phone')}
        placeholder="Used by the Call and Text buttons on your client profile"
        keyboardType="phone-pad"
      />
      {/* 6. Broker */}
      <Field
        label="Broker (optional)"
        value={value.realty_group}
        onChangeText={set('realty_group')}
        placeholder="e.g. Compass Realty"
      />
      {/* 7. About */}
      <Field
        label="About"
        value={value.about}
        onChangeText={set('about')}
        placeholder="Tell clients about yourself"
        multiline
      />
      {/* 8. Years of experience */}
      <Field
        label="Years of experience"
        value={value.yearsExperience}
        onChangeText={set('yearsExperience')}
        placeholder="e.g. 12"
      />
      {/* 9. Areas served */}
      <Field
        label="Areas served"
        value={value.areasServed}
        onChangeText={set('areasServed')}
        placeholder="e.g. Santa Clarita, Valencia"
      />
      {/* 10. License number */}
      <Field
        label="License number (optional)"
        value={value.dreLicense}
        onChangeText={set('dreLicense')}
        placeholder="e.g. 01992736"
      />
      {cropJob ? (
        <PhotoCropper
          visible
          imageUri={cropJob.uri}
          imageWidth={cropJob.width}
          imageHeight={cropJob.height}
          kind={cropJob.kind}
          onUse={onCropUse}
          onCancel={() => setCropJob(null)}
          onRetake={onCropRetake}
        />
      ) : null}
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
