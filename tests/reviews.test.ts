// reviews.test.ts — client reviews + rating (Sept 2026).
//
// Contract:
//   * Reviews are per-realtor, server-side (reviews table keyed by realtor
//     id); profile.rating = average of that realtor's own review stars,
//     null when there are no reviews.
//   * Ownership is keyed on the client-link id (no client login; the
//     client_links device binding is the identity). The app only ever calls
//     the upsert_review / delete_review RPCs — verified here by RPC name +
//     params against a mock client.
//   * The realtor's own profile push (toProfileRow) never carries reviews
//     or rating, so it can never clobber the server-side aggregates.
//   * Legacy profiles backfill to reviews: [] / rating: null.
//   * deals_closed never surfaces on the profile (Anuraj, Sept 2026).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import {
  computeRating,
  deleteReview,
  fromProfileRow,
  getPublicProfile,
  mapClientViewRpc,
  saveReview,
  toProfileRow,
} from '../src/lib/cloudSync';
import type { Review } from '../src/lib/types';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function review(id: string, stars: number, name = 'Priya Nair'): Review {
  return { id, clientName: name, stars, text: 'Great work', createdAt: '2026-09-26T10:00:00.000Z' };
}

/** Mock cloud client capturing rpc() calls. */
function mockRpc(handler: (fn: string, params: Record<string, unknown>) => unknown) {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: async (fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      return { data: handler(fn, params), error: null };
    },
  };
}

async function main(): Promise<void> {
  // 1. rating math ---------------------------------------------------------
  assert(computeRating([]) === null, 'no reviews -> null rating');
  assert(computeRating(undefined) === null, 'undefined reviews -> null rating');
  assert(computeRating([review('a', 5)]) === 5, 'single 5-star review -> 5');
  assert(computeRating([review('a', 5), review('b', 4)]) === 4.5, 'average of 5 and 4 -> 4.5');
  assert(
    Math.abs(computeRating([review('a', 5), review('b', 5), review('c', 4)])! - 14 / 3) < 1e-9,
    'average of 5,5,4 -> 14/3',
  );

  // 2. fromProfileRow: reviews parsing + rating --------------------------------
  const withArray = fromProfileRow({
    name: 'Maya',
    reviews: [review('a', 5), review('b', 3)],
    rating: 4,
  });
  assert(withArray.reviews.length === 2 && withArray.reviews[0].id === 'a', 'reviews array parses');
  assert(withArray.rating === 4, 'stored rating passes through');

  const withJson = fromProfileRow({ name: 'Maya', reviews: JSON.stringify([review('a', 5)]) });
  assert(withJson.reviews.length === 1, 'reviews JSON string parses');
  assert(withJson.rating === 5, 'missing rating recomputes from reviews');

  const legacy = fromProfileRow({ name: 'Old' });
  assert(Array.isArray(legacy.reviews) && legacy.reviews.length === 0, 'missing reviews -> []');
  assert(legacy.rating === null, 'missing reviews -> null rating');

  const withDeals = fromProfileRow({ name: 'Maya', deals_closed: '99' });
  assert(!('dealsClosed' in withDeals), 'deals_closed never surfaces on the profile');

  // 3. toProfileRow: the realtor's push never carries reviews/rating ---------
  const row = toProfileRow('uid-1', {
    name: 'Maya', photoUri: null, about: '', yearsExperience: '9', avgDaysToClose: '21',
    areasServed: '', phone: '', dreLicense: '', realty_group: '', banner_image: null,
    reviews: [review('a', 5)], rating: 5,
  }) as Record<string, unknown>;
  assert(!('reviews' in row) && !('rating' in row), 'push payload excludes reviews + rating');
  assert(row.avg_days_to_close === '21', 'push payload carries avg_days_to_close');

  // 4. mapClientViewRpc: reviews + my_review_id --------------------------------
  const cv = mapClientViewRpc({
    ok: true,
    escrow: { id: 'eid', address: 'A', city: 'C', close_date: '2026-11-25' },
    buyer_steps: [],
    profile: { name: 'Maya', reviews: [review('a', 5)], rating: 5 },
    my_review_id: 'a',
  });
  assert(cv.ok === true, 'client view ok');
  assert(cv.profile!.reviews.length === 1, 'client view profile carries reviews');
  assert(cv.profile!.rating === 5, 'client view profile carries rating');
  assert(cv.view!.myReviewId === 'a', 'my_review_id maps for edit-mode entry');

  const cvNone = mapClientViewRpc({
    ok: true,
    escrow: { id: 'eid', address: 'A', city: 'C', close_date: '2026-11-25' },
    buyer_steps: [],
    profile: { name: 'Maya', reviews: [], rating: null },
    my_review_id: null,
  });
  assert(cvNone.view!.myReviewId === null, 'no own review -> null myReviewId');
  assert(cvNone.profile!.rating === null, 'no reviews -> null rating');

  // 5. saveReview: RPC contract ------------------------------------------------
  const saver = mockRpc((fn) => {
    assert(fn === 'upsert_review', 'save calls upsert_review');
    return {
      ok: true, review_id: 'r1',
      reviews: [review('r1', 5)], rating: 5,
    };
  });
  const saved = await saveReview(saver as never, { linkId: 'link-1', stars: 5, text: '  Great  ' });
  assert(saved.ok && saved.reviewId === 'r1', 'save returns the review id');
  assert(saved.reviews.length === 1 && saved.rating === 5, 'save returns updated reviews + rating');
  assert(saver.calls[0].params.p_link_id === 'link-1', 'save passes the link id (ownership key)');
  assert(saver.calls[0].params.p_stars === 5, 'save passes stars');
  assert(saver.calls[0].params.p_text === 'Great', 'save trims text');
  assert(saver.calls[0].params.p_review_id === null, 'new review sends null review id');

  const edited = await saveReview(saver as never, {
    linkId: 'link-1', stars: 4, text: 'Good', reviewId: 'r1',
  });
  assert(edited.ok, 'edit path ok');
  assert(saver.calls[1].params.p_review_id === 'r1', 'edit passes the review id');

  const badStars = await saveReview(saver as never, { linkId: 'link-1', stars: 0, text: '' });
  assert(!badStars.ok && saver.calls.length === 2, 'stars outside 1-5 never reach the RPC');

  // 6. deleteReview: RPC contract ----------------------------------------------
  const deleter = mockRpc((fn) => {
    assert(fn === 'delete_review', 'delete calls delete_review');
    return { ok: true, reviews: [], rating: null };
  });
  const deleted = await deleteReview(deleter as never, { linkId: 'link-1', reviewId: 'r1' });
  assert(deleted.ok && deleted.reviews.length === 0, 'delete returns empty reviews');
  assert(deleted.rating === null, 'deleting the last review -> null rating');
  assert(deleter.calls[0].params.p_link_id === 'link-1', 'delete passes the link id');
  assert(deleter.calls[0].params.p_review_id === 'r1', 'delete passes the review id');

  // 7. getPublicProfile: RPC contract -------------------------------------------
  const pub = mockRpc((fn) => {
    assert(fn === 'get_public_profile', 'public page calls get_public_profile');
    return {
      ok: true,
      profile: {
        name: 'Maya Sharma', photo_url: null, about: 'I answer my phone.',
        years_experience: '9', avg_days_to_close: '21', areas_served: 'SCV',
        dre_license: '01998877', realty_group: 'Compass Realty', banner_image: null,
        reviews: [review('a', 5)], rating: 5,
      },
    };
  });
  const got = await getPublicProfile(pub as never, 'realtor-uuid-1');
  assert(got !== null && got.profile.name === 'Maya Sharma', 'public profile resolves');
  assert(got !== null && got.profile.reviews.length === 1, 'public profile carries reviews');
  assert(got !== null && got.profile.rating === 5, 'public profile carries rating');
  assert(pub.calls[0].params.p_realtor_id === 'realtor-uuid-1', 'public read passes the realtor id');
  assert((await getPublicProfile(null, 'x')) === null, 'unconfigured client -> null');

  // 8. legacy local backfill ----------------------------------------------------
  const kv = memoryKV();
  await kv.setItem(
    'ctc:profile',
    JSON.stringify({ name: 'Old', yearsExperience: '5' }),
  );
  const store = createStore(kv);
  const p = await store.getProfile();
  assert(p !== null && Array.isArray(p.reviews) && p.reviews.length === 0, 'legacy backfills reviews []');
  assert(p !== null && p.rating === null, 'legacy backfills rating null');
  assert(p !== null && p.avgDaysToClose === '', 'legacy backfills avgDaysToClose');

  summary('reviews');
}

main().catch((e) => {
  console.error('reviews.test failed:', e);
  process.exitCode = 1;
});
