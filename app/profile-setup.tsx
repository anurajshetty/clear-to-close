// Clear to Close — realtor profile setup (one profile per realtor, shown to every client).
// Faithful to APPROVED mockup 01 · device 13. DRE/license field intentionally omitted (HELD).
import React, { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { store } from '../src/lib/store-instance';
import { Field, Kicker, PrimaryButton } from '../src/components/ui';
import { initialsOf } from '../src/components/RealtorCard';
import { colors } from '../src/theme';

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

export default function ProfileSetup() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [yearsExperience, setYearsExperience] = useState('');
  const [dealsClosed, setDealsClosed] = useState('');
  const [areasServed, setAreasServed] = useState('');
  const [phone, setPhone] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      store
        .getProfile()
        .then((p) => {
          if (!p || !active) return;
          setName(p.name ?? '');
          setAbout(p.about ?? '');
          setYearsExperience(p.yearsExperience ?? '');
          setDealsClosed(p.dealsClosed ?? '');
          setAreasServed(p.areasServed ?? '');
          setPhone(p.phone ?? '');
          setPhotoUri(p.photoUri ?? null);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!res.canceled && res.assets && res.assets[0]?.uri) {
      setPhotoUri(res.assets[0].uri);
    }
  };

  const onSave = async () => {
    if (!name.trim()) {
      Alert.alert('Add your name', "Clients see your name on their home view.");
      return;
    }
    setSaving(true);
    try {
      await store.saveProfile({
        name: name.trim(),
        photoUri,
        about,
        yearsExperience,
        dealsClosed,
        areasServed,
        phone,
      });
      router.back();
    } catch {
      Alert.alert('Could not save', 'Please try again.');
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Kicker>Realtor profile</Kicker>
      <Text style={styles.h2}>Your profile</Text>
      <Text style={styles.desc}>
        One profile, shown on every client&apos;s home view. Keep it professional
        and brief.
      </Text>

      <View style={styles.photoRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={photoUri ? 'Change profile photo' : 'Add profile photo'}
          onPress={pickPhoto}
          style={[styles.photoBtn, photoUri && styles.photoBtnPicked]}
        >
          {photoUri ? (
            <Text style={styles.photoInitials}>{initialsOf(name)}</Text>
          ) : (
            <CameraIcon />
          )}
        </Pressable>
        <View style={styles.photoText}>
          <Text style={styles.photoLabel}>
            {photoUri ? 'Change photo' : 'Add photo'}
          </Text>
          <Text style={styles.photoSub}>
            Square works best. Shown to every client.
          </Text>
        </View>
      </View>

      <Field label="Full name" value={name} onChangeText={setName} placeholder="e.g. Maya Chen" />
      <Field
        label="About"
        value={about}
        onChangeText={setAbout}
        placeholder="Tell clients about yourself"
        multiline
      />
      <Field
        label="Years of experience"
        value={yearsExperience}
        onChangeText={setYearsExperience}
        placeholder="e.g. 12"
      />
      <Field
        label="Deals closed"
        value={dealsClosed}
        onChangeText={setDealsClosed}
        placeholder="e.g. 240"
      />
      <Field
        label="Areas served"
        value={areasServed}
        onChangeText={setAreasServed}
        placeholder="e.g. Santa Clarita, Valencia"
      />
      <Field
        label="Phone (optional)"
        value={phone}
        onChangeText={setPhone}
        placeholder="For Call / Message buttons"
      />

      <View style={styles.saveWrap}>
        <PrimaryButton title={saving ? 'Saving…' : 'Save profile'} onPress={onSave} disabled={saving} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  h2: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.26,
    marginTop: 6,
  },
  desc: {
    fontSize: 14,
    color: colors.body,
    lineHeight: 21.7,
    marginTop: 8,
  },
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
  saveWrap: {
    marginTop: 20,
  },
});
