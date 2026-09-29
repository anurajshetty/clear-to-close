// Clear to Close — "Share {Name}'s profile" invocation.
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
import { buildShareMessage, type ShareCopyInput } from './shareCopy';

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
