// app_config.test.ts — the client app link resolution chain (Oct 20, 2026).
//
// The invite-share link comes from the app_config table (migration
// 0043) so it can flip to the App Store URL without a rebuild. The
// chain under test: a validated config value is used; non-https or
// malformed values are ignored; fetch failures and missing rows fall
// back to the built-in CLIENT_APP_LINK constant.
import { assert, summary } from './assert';
import {
  getClientAppLink,
  isValidClientAppLink,
  refreshClientAppLink,
  resetClientAppLinkCache,
} from '../src/lib/appConfig';
import { CLIENT_APP_LINK, inviteSharePayload } from '../src/lib/shareCopy';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  // --- validation ------------------------------------------------------------
  assert(isValidClientAppLink('https://example.com/get'), 'https URL is valid');
  assert(isValidClientAppLink('  https://example.com/x  '), 'surrounding whitespace is tolerated');
  assert(!isValidClientAppLink('http://example.com/x'), 'plain http is rejected');
  assert(!isValidClientAppLink('not a url'), 'malformed value is rejected');
  assert(!isValidClientAppLink(''), 'empty value is rejected');
  assert(!isValidClientAppLink(null), 'null is rejected');
  assert(!isValidClientAppLink(undefined), 'undefined is rejected');
  assert(!isValidClientAppLink(42), 'non-string is rejected');
  assert(!isValidClientAppLink('javascript:alert(1)'), 'non-https scheme is rejected');

  // --- fallback chain ----------------------------------------------------------
  resetClientAppLinkCache();
  assert(getClientAppLink() === CLIENT_APP_LINK, 'no cache -> built-in fallback constant');
  const storeLink = 'https://anurajshetty.github.io/clear-to-close/get';
  const used = await refreshClientAppLink(async () => storeLink);
  assert(used === storeLink && getClientAppLink() === storeLink, 'config value is used when present and valid');

  const afterBad = await refreshClientAppLink(async () => 'http://insecure.example/x');
  assert(afterBad === storeLink, 'non-https config value is ignored (cache stands)');
  resetClientAppLinkCache();
  const badFresh = await refreshClientAppLink(async () => '::::');
  assert(badFresh === CLIENT_APP_LINK, 'malformed config value -> fallback');
  const missing = await refreshClientAppLink(async () => null);
  assert(missing === CLIENT_APP_LINK, 'missing row -> fallback');
  const failed = await refreshClientAppLink(async () => {
    throw new Error('offline');
  });
  assert(failed === CLIENT_APP_LINK, 'fetch failure -> fallback');

  // --- the payload consumes the resolved link ----------------------------------
  resetClientAppLinkCache();
  await refreshClientAppLink(async () => storeLink);
  const payload = inviteSharePayload(
    { clientName: 'Tim Okafor', realtorFirst: 'Maya', code: 'ABC123' },
    getClientAppLink(),
  );
  assert(payload.url === storeLink, 'share payload uses the config-provided link');
  resetClientAppLinkCache();

  summary('app_config');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
