// Clear to Close — shared realtor profile form.
//
// The single approved profile form, reused by profile setup (01·⑬),
// onboarding profile creation (㉒), and profile update (㉕): photo, about,
// years of experience, deals closed, areas served, optional DRE/license,
// plus full name and phone. Buttons and headers belong to the screens;
// this component owns the fields only.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import { Field } from './ui';
import { initialsOf } from './ui';
import { colors } from '../theme';

export interface ProfileDraft {
  name: string;
  photoUri: string | null;
  about: string;
  yearsExperience: string;
  dealsClosed: string;
  areasServed: string;
  phone: string;
  dreLicense: string;
}

export const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  name: '',
  photoUri: null,
  about: '',
  yearsExperience: '',
  dealsClosed: '',
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

export function ProfileForm({ value, onChange, nameError }: ProfileFormProps) {
  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!res.canceled && res.assets && res.assets[0]?.uri) {
      onChange({ photoUri: res.assets[0].uri });
    }
  };

  const set = (key: keyof ProfileDraft) => (text: string) => onChange({ [key]: text } as Partial<ProfileDraft>);

  return (
    <View>
      <View style={styles.photoRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value.photoUri ? 'Change profile photo' : 'Add profile photo'}
          onPress={pickPhoto}
          style={[styles.photoBtn, value.photoUri && styles.photoBtnPicked]}
        >
          {value.photoUri ? (
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

      <Field label="Full name" value={value.name} onChangeText={set('name')} placeholder="e.g. Maya Chen" />
      {nameError ? <Text style={styles.nameError}>{nameError}</Text> : null}
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
        label="Deals closed"
        value={value.dealsClosed}
        onChangeText={set('dealsClosed')}
        placeholder="e.g. 240"
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
});
