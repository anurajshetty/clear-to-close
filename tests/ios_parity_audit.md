# Clear to Close — iOS Parity Audit (Sept 27, 2026)

**Scope:** every change shipped Sept 25–27, verified for NATIVE (iOS) correctness —
not just web/export-green. Worktree `wt/ios-parity` off `origin/main @ cc0339b`
(boot-converge release included). `npx tsc --noEmit` clean; `bash tests/run.sh`
green (see counts in the ship report).

Anuraj's installed binary predates ALL of these releases, so everything below
lands on his next `eas build`.

---

## (a) VERIFIED native-OK

1. **Cropper (tap threshold, drag pan, slider isolation, cover-scale start).**
   `src/components/PhotoCropper.tsx` uses RN `onTouchStart/Move/End` responder
   props (not pointer events) — native-correct on iOS. Tap-threshold no-op,
   pinch tracking, and slider-touch isolation (`controlTouches` set) are all in
   the gesture handlers; `touchAction: 'none'` is applied web-only
   (lines 482, 558). Geometry is pure `src/lib/cropMath.ts` (unit-tested).
   Initial zoom = `coverScale` (maximum image in frame, not zoomed in).
   Evidence: code read + `tests/photo_cropper.test.ts` green.
2. **PHPicker flow.** `ProfileForm.tsx` calls `launchImageLibraryAsync` with
   `allowsEditing: false`; on non-cancel the raw asset goes straight into our
   crop editor — no app-side confirmation after the system picker.
   Evidence: code read (lines 111–135).
3. **Photo/banner media convergence.** `src/lib/mediaUpload.ts` reads native
   files via `expo-file-system/legacy` and `data:` URIs via fetch; uploads with
   `upsert: true` to one fixed Storage path; stamps `?v=<timestamp>` on every
   successful upload. Fingerprinting + failed-upload retry live in the push
   paths. Evidence: code read + `tests/media_upload.test.ts` green.
4. **Managed photo/banner files.** `src/lib/photoFile.ts` guards every
   `localStorage` access behind `Platform.OS === 'web'`; native copies into
   the Documents directory under one fixed filename.
   Evidence: code read.
5. **Close-revoke immediate drain.** `syncedStore.closeEscrow` enqueues
   `revokeClientLink` ops then calls `drainOutboxNow()` immediately
   (non-blocking) — no app restart needed. Failures stay queued for boot
   drain. Evidence: code read (`syncedStore.ts` ~678–696) +
   `tests/close_revoke_converges.test.ts` green.
6. **Account-isolation logout wipe.** `clearLocalAccountData` drops profile
   cache, escrows, invites, links, cloud-view entries, outbox, sync errors,
   and managed media (native files via `expo-file-system` deleteAsync +
   web localStorage keys); `auth.signOut` additionally clears the client
   link and outbox as an identity-boundary backstop. Device-scoped state
   (role, device id, push-asked) is retained by design.
   Evidence: code read (`syncedStore.ts` ~487–522, `auth.ts` ~513–545).
7. **Client top-card timeline + viewport fit.** Pure `useWindowDimensions` +
   token math (`src/lib/topCard.ts` height ladder roomy/compact/ultra) —
   platform-independent, no web APIs. Evidence: code read +
   `tests/topcard_timeline.test.ts` green.
8. **RLS silent no-op guard.** Pure data layer: upserts request returned rows
   and throw `SyncNotAppliedError` on zero affected rows; ownership-mismatch
   ops stay queued without burning attempts. Platform-independent.
   Evidence: `tests/sync_chain_broad.test.ts` green.
9. **Sync-failure error bar (logic).** `SyncErrorBar` is pure React Native;
   records persist in KV (AsyncStorage on native) across restarts, clear on
   retry, wipe on logout; renders realtor-role only. Push-failure paths
   (`pushRevokeNow`/`pushLinkRevokeNow`) carry the not-applied guard.
   Evidence: `tests/sync_failure_ui.test.ts` (1900 assertions) green.
   UI note: the bar needed a top safe-area inset on iOS — fixed, see (b)1.
10. **Boot/foreground converge.** `pullProfileFromCloud` now converges the
    server row on boot/login; `refreshProfile`/`refreshClientView` run on
    foreground via `AppState` (native-correct listener). Conflict care:
    queued dirty ops win, missing server row never wipes local, offline fails
    open, and the profile edit screen never wipes in-progress typing
    (`editedRef` guard). Evidence: `tests/profile_boot_converge.test.ts`
    (failed pre-fix, green post-fix) + `tests/client_refresh_foreground.test.ts`.
11. **Session storage.** `src/lib/supabase.ts`: native uses AsyncStorage,
    web uses localStorage, chosen by platform at client creation — no
    cross-wiring. `auth.detectPlatform()` keys off `window.document`
    presence. Evidence: code read.
12. **Push wiring.** `src/lib/push.ts` + `PushGate.tsx`: every entry point
    no-ops on web (`loadNotifications()` returns null); permission pre-prompt
    is ask-once per device. Evidence: code read + `tests/push.test.ts` green.
    NOTE: token registration is inert until `extra.eas.projectId` exists —
    see (c).
13. **Keyboard avoidance in shared Sheet.** `src/components/ui.tsx`:
    web tracks `visualViewport`, iOS tracks `Keyboard` events, Android is
    skipped (OS resizes). All `window` uses are web-gated.
    Evidence: code read.
14. **Native date picker.** `DateField.tsx` renders
    `@react-native-community/datetimepicker` inline on iOS (never a popup);
    web resolves to `DateField.web.tsx` (native date input). Evidence: code
    read. Requires the new native module — see (c).
15. **Drag-reorder checklist.** Web-only DOM work (`document`, `window`
    touchmove prevention) is gated behind `Platform.OS === 'web'`; native
    uses the gesture system untouched; grip arms drag on long-press only.
    Evidence: code read (`Checklist.tsx` ~112–175).

---

## (b) NEEDS NATIVE-ONLY FIX — built in this worktree

1. **SyncErrorBar rendered under the iPhone notch.** The bar is mounted in
   `app/_layout.tsx` above the router stack with no screen chrome of its own,
   so on iOS the red bar sat under the notch/status bar (web was fine).
   Fix: `useSafeAreaInsets()` pads the bar's top (`paddingTop: 10 + insets.top`);
   on web the inset is 0, so the same code is safe on both platforms.
   Files: `src/components/SyncErrorBar.tsx`,
   `tests/sync_error_bar_safe_area.test.ts` (new, wired into `tests/run.sh`),
   `LEARNINGS.md` entry ("Root-level overlays ignore the notch").
   Not merged, not shipped.

No other native-only code fixes were required.

---

## (c) BLOCKED ON ANURAJ — in order

1. **`eas build --platform ios`** (fresh binary). His installed app predates
   every release in this audit — including the native date-picker module
   (`@react-native-community/datetimepicker`), which does not exist in his
   current binary. Web testing cannot cover it.
2. **`eas submit --platform ios`** → TestFlight, then install on his iPhone.
3. **Apple Push Key for push notifications.** `registerPushToken()` is inert
   until `extra.eas.projectId` exists in `app.json` (`eas init` sets it during
   the build flow); without it the client logs "missing EAS projectId" and
   skips. After the build, the server-side push path (DB trigger → pg_net →
   `send-client-push` Edge Function → Expo Push API) needs its deploy
   confirmation, and the Apple Push Key must be configured in the Expo
   dashboard for production pushes.
4. **On-device verification** (only he can do): cropper zoomed-out start /
   tap no-op / real-drag pan / isolated smooth slider; profile-photo and
   banner update on the client after refresh; account A → logout → account B
   isolation; explicit close → foregrounded client lands on the dead-link
   screen; red error bar appears on a failed save (airplane-mode test) with
   Retry; top-card timeline fits the viewport without scrolling on his
   iPhone; native date picker on the escrow forms; push received with the
   app foregrounded, backgrounded, and killed.
5. **Supabase migrations still unconfirmed** (his dashboard step):
   `0013_invite_role.sql`, `0016_profile_email.sql`,
   `0017_client_view_profile_fields.sql` (the last one gates the server-side
   email-privacy fix).

---

## Assumptions (not findings)

- **Assumption (high confidence):** no `SafeAreaProvider` at the root is fine —
  every screen already uses `SafeAreaView` from `react-native-safe-area-context`
  v5 without a provider, and the native module supplies `initialWindowMetrics`
  on iOS. Would be refuted if the installed app shows zero top insets on any
  screen; Anuraj's iPhone test (c4) confirms.
- **Assumption (high confidence):** `expo-image-picker` without its config
  plugin is safe on iOS because it presents PHPicker (out-of-process, no photo
  library permission / `NSPhotoLibraryUsageDescription` required). Would be
  refuted by a crash on picker open in the fresh build; if so, add the plugin
  with a usage description.
- **Assumption (medium confidence):** `getSupabase()` (hardcoded 'native' kind,
  AsyncStorage-backed) shares the session with the auth client's kind-keyed
  client on web, because both use the same default storage key
  (`sb-<ref>-auth-token`) over the same underlying localStorage. Only the
  public-profile and review-hook paths use it; would be refuted by a web
  session working in auth flows but failing on the public realtor page.
