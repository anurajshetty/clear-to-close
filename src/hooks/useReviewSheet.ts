// Clear to Close — review sheet wiring for the client home triumph state
// (Sept 2026 branding release, merge-lead wiring).
//
// The 100% "Leave a review" button opens the profile stream's ReviewSheet.
// Reviews are server-side (SECURITY DEFINER RPCs); the device-bound client
// link is the identity, so no client login is needed.
import { useCallback, useMemo, useState } from 'react';
import { saveReview, deleteReview } from '../lib/cloudSync';
import { getSupabase } from '../lib/supabase';
import { auth } from '../lib/auth';
import type { ExistingReview } from '../components/ReviewSheet';
import type { ClientView, RealtorProfile } from '../lib/types';

function friendlyError(code: string | undefined): string {
  if (code === 'network') return 'Could not reach the server. Check your connection and try again.';
  if (code === 'stars') return 'Please pick a star rating.';
  if (code === 'invalid') return 'This review link is no longer valid. Ask your realtor for a new invite code.';
  return 'Something went wrong. Please try again.';
}

export function useReviewSheet(
  view: ClientView | null,
  profile: RealtorProfile | null,
  setProfile: (p: RealtorProfile) => void,
  setView: (v: ClientView) => void,
) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This link's own review, when it has posted one — opens the sheet in
  // edit mode.
  const existingReview: ExistingReview | null = useMemo(() => {
    const id = view?.myReviewId;
    if (!id || !profile) return null;
    const r = profile.reviews.find((x) => x.id === id);
    return r ? { id: r.id, stars: r.stars, text: r.text } : null;
  }, [view?.myReviewId, profile]);

  const openSheet = useCallback(() => {
    setError(null);
    setOpen(true);
  }, []);

  const closeSheet = useCallback(() => {
    if (!busy) {
      setError(null);
      setOpen(false);
    }
  }, [busy]);

  const submit = useCallback(
    async ({ stars, text }: { stars: number; text: string }) => {
      const client = getSupabase();
      const link = await auth.getClientLinkForEscrow(view?.escrowId ?? '').catch(() => null);
      if (!client || !link) {
        setError(friendlyError('network'));
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await saveReview(client, {
          linkId: link.linkId,
          stars,
          text,
          reviewId: view?.myReviewId ?? undefined,
        });
        if (!res.ok) {
          setError(friendlyError(res.error));
          return;
        }
        if (profile) {
          setProfile({ ...profile, reviews: res.reviews, rating: res.rating });
        }
        if (view) {
          setView({ ...view, myReviewId: res.reviewId ?? view.myReviewId });
        }
        setOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [view, profile, setProfile, setView],
  );

  const remove = useCallback(async () => {
    const client = getSupabase();
    const link = await auth.getClientLinkForEscrow(view?.escrowId ?? '').catch(() => null);
    const reviewId = view?.myReviewId;
    if (!client || !link || !reviewId) {
      setError(friendlyError('invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await deleteReview(client, { linkId: link.linkId, reviewId });
      if (!res.ok) {
        setError(friendlyError(res.error));
        return;
      }
      if (profile) {
        setProfile({ ...profile, reviews: res.reviews, rating: res.rating });
      }
      if (view) {
        setView({ ...view, myReviewId: null });
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }, [view, profile, setProfile, setView]);

  return { open, busy, error, existingReview, openSheet, closeSheet, submit, remove };
}
