// sharecopy.test.ts — REGRESSION: "Share {Name}'s profile" copy builders
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
  buildShareEmail,
  buildShareMessage,
  profileUrlFor,
  type ShareCopyInput,
} from '../src/lib/shareCopy';

declare const process: { exitCode?: number };

const FULL: ShareCopyInput = {
  realtorName: 'Maya Sharma',
  realtyGroup: 'Compass Realty',
  dreLicense: '01998877',
  yearsExperience: '9',
  avgDaysToClose: '21',
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
          '9 years · 21 avg days to close · ★★★★★\n' +
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
      body.includes('9 years · 21 avg days to close\n'),
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
      avgDaysToClose: null,
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
    { ...FULL, yearsExperience: '', avgDaysToClose: null, tagline: '', profileUrl: '', clientName: '' },
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

  summary('sharecopy');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
