// Clear to Close — profile share/referral invocation.
//
// Opens the native share sheet with the message version of the approved
// share copy:
//   - iOS / Android: React Native's Share sheet.
//   - Web: navigator.share when available.
//   - Fallback (desktop web without navigator.share): copies the message to
//     the clipboard instead — never a dead button, never a throw.
//
// Returns what happened so the button can confirm ("Copied to clipboard").
import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  buildShareMessage,
  inviteSharePayload,
  type InviteShareInput,
  type ShareCopyInput,
} from './shareCopy';
import { getClientAppLink } from './appConfig';

export type ShareOutcome = 'shared' | 'copied' | 'dismissed' | 'unavailable';

export async function shareRealtorProfile(input: ShareCopyInput): Promise<ShareOutcome> {
  const message = buildShareMessage(input);
  try {
    if (Platform.OS === 'web') {
      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & {
        share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
      }) : undefined;
      if (nav?.share) {
        await nav.share({ text: message });
        return 'shared';
      }
      // Graceful fallback: clipboard.
      await Clipboard.setStringAsync(message);
      return 'copied';
    }
    const result = await Share.share({ message });
    return result.action === Share.sharedAction ? 'shared' : 'dismissed';
  } catch {
    // User dismissed the sheet (AbortError), clipboard denied, etc.
    return 'unavailable';
  }
}

/**
 * Generic plain-text share (Sept 29, 2026, TC intake mockup ③): shares any
 * already-built message payload with the same platform strategy —
 * native Share sheet, navigator.share on web, clipboard fallback — and
 * never throws: user dismissal, clipboard denial, or any other failure
 * resolves to an outcome instead.
 */
export async function shareText(message: string): Promise<ShareOutcome> {
  try {
    if (Platform.OS === 'web') {
      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & {
        share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
      }) : undefined;
      if (nav?.share) {
        await nav.share({ text: message });
        return 'shared';
      }
      // Graceful fallback: clipboard.
      await Clipboard.setStringAsync(message);
      return 'copied';
    }
    const result = await Share.share({ message });
    return result.action === Share.sharedAction ? 'shared' : 'dismissed';
  } catch {
    // User dismissed the sheet (AbortError), clipboard denied, etc.
    return 'unavailable';
  }
}

/**
 * Invite-code share (Anuraj, Oct 20, 2026): the approved message plus the
 * app link as the payload's separate url field — on iOS, Share.share's
 * { message, url } shape is what makes Messages render the link as a
 * preview card (the Muse referral pattern). Web keeps the same strategy
 * (navigator.share with text + url); the clipboard fallback copies the
 * message WITH the link appended, so a paste loses nothing.
 */
export async function shareInviteCode(input: InviteShareInput): Promise<ShareOutcome> {
  const { message, url } = inviteSharePayload(input, getClientAppLink());
  try {
    if (Platform.OS === 'web') {
      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & {
        share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
      }) : undefined;
      if (nav?.share) {
        await nav.share({ text: message, url });
        return 'shared';
      }
      await Clipboard.setStringAsync(`${message}\n${url}`);
      return 'copied';
    }
    const result = await Share.share({ message, url });
    return result.action === Share.sharedAction ? 'shared' : 'dismissed';
  } catch {
    return 'unavailable';
  }
}
