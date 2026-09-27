// Clear to Close — "Leave a review" sheet (approved branding mockup screen 11).
//
// Star rating (1-5) + one line of text. "Post review" saves; when the client
// already has a review (existingReview), the sheet opens in edit mode with
// their stars/text prefilled, the button becomes "Save changes", and a quiet
// "Delete review" row appears with a confirmation step.
//
// MERGE-LEAD CONTRACT (screen-10 wiring, top-card branch): render
//   <ReviewSheet visible={...} realtorName={profile.name}
//     realtorPhotoUri={profile.photoUri} existingReview={myReview}
//     busy={saving} error={saveError}
//     onSubmit={({stars, text}) => ...saveReview...}
//     onDelete={() => ...deleteReview...} onClose={...} />
// The parent owns the saveReview / deleteReview calls (src/lib/cloudSync)
// and feeds back busy + error. Copy: realtor by name only, no pronouns,
// no em dashes.
import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PrimaryButton, Sheet, initialsOf } from './ui';
import { colors, radius } from '../theme';

const GOLD = '#E8A93D';
const STAR_OFF = '#D8CFBE';
export const MAX_REVIEW_TEXT = 280;

export interface ExistingReview {
  id: string;
  stars: number;
  text: string;
}

export interface ReviewSheetProps {
  visible: boolean;
  realtorName: string;
  realtorPhotoUri?: string | null;
  /** When set, the sheet opens in edit mode for this review. */
  existingReview?: ExistingReview | null;
  busy?: boolean;
  error?: string | null;
  onSubmit: (r: { stars: number; text: string }) => void;
  /** Shown only in edit mode. */
  onDelete?: () => void;
  onClose: () => void;
}

function firstNameOf(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '');
}

function Stars({
  value,
  onPick,
}: {
  value: number;
  onPick: (n: number) => void;
}) {
  return (
    <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel="Star rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable
          key={n}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === n }}
          accessibilityLabel={`${n} star${n === 1 ? '' : 's'}`}
          onPress={() => onPick(n)}
          style={({ pressed }) => [styles.starHit, pressed && { opacity: 0.7 }]}
        >
          <Text style={[styles.star, { color: n <= value ? GOLD : STAR_OFF }]}>
            ★
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ReviewSheet({
  visible,
  realtorName,
  realtorPhotoUri,
  existingReview,
  busy,
  error,
  onSubmit,
  onDelete,
  onClose,
}: ReviewSheetProps) {
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Opening (re)starts from the existing review in edit mode, blank for new.
  useEffect(() => {
    if (visible) {
      setStars(existingReview?.stars ?? 0);
      setText(existingReview?.text ?? '');
      setConfirmDelete(false);
    }
  }, [visible, existingReview]);

  const firstName = firstNameOf(realtorName);
  const editing = !!existingReview;
  const canPost = stars >= 1 && stars <= 5 && !busy;

  return (
    <Sheet visible={visible} onClose={onClose} dragToDismiss>
      <View style={styles.grabber} />
      <View style={styles.head}>
        {realtorPhotoUri ? (
          <Image source={{ uri: realtorPhotoUri }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarInitials}>{initialsOf(realtorName)}</Text>
          </View>
        )}
        <Text style={styles.title}>
          {firstName ? `How was ${firstName}?` : 'How was your realtor?'}
        </Text>
        <Text style={styles.sub}>
          {realtorName
            ? `Your review shows on ${realtorName}'s public profile.`
            : 'Your review shows on the public profile.'}
        </Text>
      </View>

      <Stars value={stars} onPick={setStars} />
      <Text style={styles.hint}>Tap a star to rate</Text>

      <TextInput
        value={text}
        onChangeText={(t) => setText(t.slice(0, MAX_REVIEW_TEXT))}
        placeholder="One line about your experience…"
        placeholderTextColor={colors.muted}
        multiline
        maxLength={MAX_REVIEW_TEXT}
        editable={!busy}
        style={styles.input}
        accessibilityLabel="One line about your experience"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.postRow}>
        <PrimaryButton
          title={busy ? 'Saving…' : editing ? 'Save changes' : 'Post review'}
          disabled={!canPost}
          onPress={() => onSubmit({ stars, text: text.trim() })}
        />
      </View>

      {editing && onDelete ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={confirmDelete ? 'Confirm delete review' : 'Delete review'}
          disabled={busy}
          onPress={() => {
            if (confirmDelete) onDelete();
            else setConfirmDelete(true);
          }}
          style={({ pressed }) => [styles.deleteRow, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.deleteText}>
            {confirmDelete ? 'Tap again to confirm delete' : 'Delete review'}
          </Text>
        </Pressable>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grabber: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#D8CFBE',
    alignSelf: 'center',
    marginBottom: 16,
  },
  head: { alignItems: 'center' },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarFallback: {
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: { fontSize: 20, fontWeight: '800', color: colors.accent },
  title: { fontSize: 21, fontWeight: '800', color: colors.ink, marginTop: 10 },
  sub: { fontSize: 13, color: colors.muted, marginTop: 6, textAlign: 'center' },
  stars: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 14,
  },
  starHit: { paddingHorizontal: 6, paddingVertical: 4, minWidth: 48, alignItems: 'center' },
  star: { fontSize: 38 },
  hint: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 4,
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#D8CFBE',
    borderRadius: radius.input,
    padding: 14,
    marginTop: 14,
    minHeight: 96,
    fontSize: 14,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  error: { fontSize: 13, color: colors.red, marginTop: 10, textAlign: 'center' },
  postRow: { marginTop: 14 },
  deleteRow: { marginTop: 14, paddingVertical: 10, alignItems: 'center' },
  deleteText: { fontSize: 14, fontWeight: '700', color: colors.red },
});
