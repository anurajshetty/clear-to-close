// sharecopy.test.ts — REGRESSION: profile share/referral copy builders
// (APPROVED mockup "Share summary — approved copy spec", Sept 2026).
//
// Both versions are built dynamically from the realtor profile + escrow.
// Copy rules under test: realtor by name only (no gendered pronouns), no
// em dashes, no deals-closed count anywhere, rating segment dropped when
// profile.rating is null (no reviews), "N days early" only when 5+ days
// remain (else "ahead of schedule"), profile URL contract
// https://anurajshetty.github.io/clear-to-close/realtor/<realtor-id>.
import { assert, summary } from './assert';
import {
  buildInviteShareMessage,
  buildShareEmail,
  buildShareMessage,
  CLIENT_APP_LINK,
  inviteSharePayload,
  profileUrlFor,
  type ShareCopyInput,
} from '../src/lib/shareCopy';

declare const require: any;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

const FULL: ShareCopyInput = {
  realtorName: 'Maya Sharma',
  realtyGroup: 'Compass Realty',
  dreLicense: '01998877',
  yearsExperience: '9',
  rating: 5,
  tagline: 'I answer my phone.',
  stepCount: 14,
  daysToClose: 27,
  profileUrl: profileUrlFor('realtor-123'),
  clientName: 'Tim',
};

const NO_PRONOUNS = /\b(she|her|hers|he|him|his)\b/i;

async function main(): Promise<void> {
  // --- profile URL contract ------------------------------------------------
  assert(
    profileUrlFor('realtor-123') ===
      'https://anurajshetty.github.io/clear-to-close/realtor/realtor-123',
    'profile URL follows the contract',
  );
  assert(profileUrlFor('') === '', 'empty realtor id -> empty URL');
  assert(profileUrlFor(null) === '', 'null realtor id -> empty URL');

  // --- message version: the approved example, pronoun-free -----------------
  {
    const msg = buildShareMessage(FULL);
    assert(
      msg ===
        '🏡 My realtor Maya Sharma just got us closed, 27 days early! ' +
          'Compass Realty (DRE #01998877) · ★★★★★ from clients.\n' +
          'See the profile: https://anurajshetty.github.io/clear-to-close/realtor/realtor-123',
      `message version exact (got ${JSON.stringify(msg)})`,
    );
  }

  // --- email version: the approved example, pronoun-free --------------------
  {
    const { subject, body } = buildShareEmail(FULL);
    assert(subject === 'My realtor just got us home, meet Maya Sharma', `subject exact (got ${JSON.stringify(subject)})`);
    assert(
      body ===
        'Hi,\n' +
          '\n' +
          'I just closed my escrow with Maya Sharma and could not recommend Maya Sharma more highly. ' +
          'Maya completed all 14 steps and got us closed 27 days ahead of schedule.\n' +
          '\n' +
          'Maya Sharma, Compass Realty (DRE #01998877)\n' +
          '"I answer my phone."\n' +
          '9 years · ★★★★★\n' +
          '\n' +
          'See the profile: https://anurajshetty.github.io/clear-to-close/realtor/realtor-123\n' +
          '\n' +
          '- Tim',
      `email body exact (got ${JSON.stringify(body)})`,
    );
  }

  // --- null rating (no reviews): rating segment dropped, never "0 stars" ---
  {
    const msg = buildShareMessage({ ...FULL, rating: null });
    assert(
      msg ===
        '🏡 My realtor Maya Sharma just got us closed, 27 days early! ' +
          'Compass Realty (DRE #01998877).\n' +
          'See the profile: https://anurajshetty.github.io/clear-to-close/realtor/realtor-123',
      `null rating drops the stars segment (got ${JSON.stringify(msg)})`,
    );
    const { body } = buildShareEmail({ ...FULL, rating: null });
    assert(
      body.includes('9 years\n'),
      `null rating drops stars from the stats line (got ${JSON.stringify(body)})`,
    );
    assert(!body.includes('★'), 'no stars rendered when rating is null');
  }

  // --- days-early variants --------------------------------------------------
  {
    const msg = buildShareMessage({ ...FULL, daysToClose: 3 });
    assert(
      msg.startsWith('🏡 My realtor Maya Sharma just got us closed ahead of schedule!'),
      `under-5-days says "ahead of schedule" (got ${JSON.stringify(msg.slice(0, 80))})`,
    );
    const { body } = buildShareEmail({ ...FULL, daysToClose: 3 });
    assert(
      body.includes('got us closed ahead of schedule.'),
      'email under-5-days says "ahead of schedule"',
    );
  }
  {
    const msg = buildShareMessage({ ...FULL, daysToClose: null });
    assert(
      msg.startsWith('🏡 My realtor Maya Sharma just got us closed ahead of schedule!'),
      'unknown daysToClose says "ahead of schedule"',
    );
  }

  // --- missing group/DRE: no dangling separators ----------------------------
  {
    const msg = buildShareMessage({ ...FULL, realtyGroup: '', dreLicense: '' });
    assert(
      msg.startsWith('🏡 My realtor Maya Sharma just got us closed, 27 days early! ★★★★★ from clients.'),
      `no group/DRE -> stars segment only (got ${JSON.stringify(msg.slice(0, 110))})`,
    );
    const { body } = buildShareEmail({ ...FULL, realtyGroup: '', dreLicense: '' });
    assert(body.includes('\nMaya Sharma\n'), 'email name line has no dangling separator');
  }
  {
    const msg = buildShareMessage({ ...FULL, realtyGroup: '', dreLicense: '01998877' });
    assert(
      msg.includes('! DRE #01998877 ·'),
      `DRE without group renders bare (got ${JSON.stringify(msg.slice(0, 110))})`,
    );
  }

  // --- missing years/avg/tagline/url/client: lines drop cleanly -------------
  {
    const { body } = buildShareEmail({
      ...FULL,
      yearsExperience: '',
      rating: null,
      tagline: '',
    });
    assert(!body.includes('years'), 'empty years drops the years segment');
    assert(!body.includes('avg days'), 'null avg drops the avg segment');
    assert(!body.includes('"'), 'empty tagline drops the quote line');
  }
  {
    const msg = buildShareMessage({ ...FULL, profileUrl: '' });
    assert(!msg.includes('See the profile'), 'empty URL drops the profile line');
    const { body } = buildShareEmail({ ...FULL, profileUrl: '', clientName: '' });
    assert(!body.includes('See the profile'), 'email: empty URL drops the profile line');
    assert(!body.endsWith('- '), 'empty client name drops the signature');
  }
  {
    const { body } = buildShareEmail({ ...FULL, yearsExperience: '1' });
    assert(body.includes('1 year ·'), 'singular "1 year"');
  }

  // --- copy rules across every variant ---------------------------------------
  const variants: string[] = [];
  const bases: ShareCopyInput[] = [
    FULL,
    { ...FULL, rating: null },
    { ...FULL, realtyGroup: '', dreLicense: '' },
    { ...FULL, daysToClose: 2 },
    { ...FULL, yearsExperience: '', rating: null, tagline: '', profileUrl: '', clientName: '' },
  ];
  for (const b of bases) {
    variants.push(buildShareMessage(b));
    const e = buildShareEmail(b);
    variants.push(e.subject, e.body);
  }
  for (const v of variants) {
    assert(!NO_PRONOUNS.test(v), `no gendered pronouns (${JSON.stringify(v.slice(0, 60))}…)`);
    assert(!v.includes('—') && !v.includes('–'), `no em/en dashes (${JSON.stringify(v.slice(0, 60))}…)`);
    assert(!/deal/i.test(v), `no deals-closed count (${JSON.stringify(v.slice(0, 60))}…)`);
  }

  // --- invite share (Anuraj, Oct 20, 2026 — approved verbatim) --------------
  assert(
    CLIENT_APP_LINK === 'https://anurajshetty.github.io/clear-to-close/redeem',
    'client app link is the /redeem deep path (SPA-fallback boot-verified)',
  );
  const inviteMsg = buildInviteShareMessage({
    clientName: 'Tim Okafor',
    realtorFirst: 'Maya',
    code: 'ABC123',
  });
  assert(
    inviteMsg ===
      'Hi Tim Okafor, Maya is sharing your escrow with you on Clear to Close. ' +
        'Download the app and enter your one-time code:\nCode: ABC123',
    'invite share message is the approved string, verbatim',
  );
  assert(
    !inviteMsg.includes(CLIENT_APP_LINK),
    'invite message carries NO inline link (the link rides the url field)',
  );
  const payload = inviteSharePayload({ clientName: 'Tim Okafor', realtorFirst: 'Maya', code: 'ABC123' });
  assert(payload.message === inviteMsg, 'invite payload message is the built message');
  assert(payload.url === CLIENT_APP_LINK, 'invite payload url field carries the app link (iOS preview card)');
  // share.ts actually sends the split payload on native (source pin: the
  // module is not node-importable, so its wiring is pinned as text).
  const shareSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'share.ts'), 'utf8');
  assert(shareSrc.includes('Share.share({ message, url })'), 'native invite share passes { message, url }');
  assert(shareSrc.includes('nav.share({ text: message, url })'), 'web invite share passes text + url');
  assert(shareSrc.includes('shareInviteCode'), 'shareInviteCode is the invite entry point');

  // --- link-preview metadata (Oct 20, 2026): the exported page must carry
  // OG tags or Messages renders the shared link bare. In SPA ("single")
  // export mode the shell comes from the Expo config template (no OG
  // support; +html.tsx applies only to static/server output), so the
  // tags are injected post-export by tools/inject_og_tags.js, wired
  // into the sanctioned export:web script. Title + plain description
  // come from app.json web.name / web.description via the template.
  // The exported dist/index.html is grep-verified in the shipping bar.
  const ogSrc = fs.readFileSync(path.join(process.cwd(), 'tools', 'inject_og_tags.js'), 'utf8');
  assert(ogSrc.includes('<meta property="og:title" content="Clear to Close">'), 'injector: og:title');
  assert(
    ogSrc.includes(
      'Your escrow, step by step. Clear to Close keeps you and your realtor connected and up to date, from accepted offer to closing.',
    ),
    'injector: og:description is the approved app description, verbatim',
  );
  assert(
    ogSrc.includes('<meta property="og:image" content="https://anurajshetty.github.io/clear-to-close/app-icon.png">'),
    'injector: og:image is the app icon at its stable public URL',
  );
  assert(ogSrc.includes('<meta name="twitter:card" content="summary">'), 'injector: twitter:card summary');
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert(
    String(pkg.scripts['export:web']).includes('node tools/inject_og_tags.js'),
    'export:web runs the OG injector after the export',
  );
  const appJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'app.json'), 'utf8'));
  assert(appJson.expo.web.name === 'Clear to Close', 'app.json web.name drives the spaced page title');
  assert(
    String(appJson.expo.web.description).includes('Your escrow, step by step.'),
    'app.json web.description carries the approved description',
  );
  assert(
    fs.existsSync(path.join(process.cwd(), 'public', 'app-icon.png')),
    'public/app-icon.png exists (served unhashed at the og:image URL)',
  );

  summary('sharecopy');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
