// latest.test.ts — REGRESSION: client home "LATEST FROM {NAME}" card
// (APPROVED mockup screen 7 updated, Sept 2026).
//
// The card sits directly below the top card, above the checklist, and is
// ALWAYS visible: the single most recent realtor action — forward AND
// backward moves (neutral wording, no blame) — or the "{Name} opened your
// escrow" fallback when no step has been checked off yet.
//
// relativeTime buckets: "just now" (<5 min), "Xm ago", "Xh ago",
// "Yesterday", "Xd ago", then "Mar 3" ("Mar 3, 2025" across years).
//
// "today" is computed at runtime via nowMs so no date in this file goes
// stale. Run with TZ=America/Los_Angeles (see tests/run.sh) for
// deterministic calendar-day math.
import { assert, summary } from './assert';
import { latestModel } from '../src/lib/latest';
import { relativeTime } from '../src/lib/dates';
import type { StepT } from '../src/lib/types';

declare const process: { exitCode?: number };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function step(id: string, title: string, done: boolean, atMs: number | null): StepT {
  return {
    id,
    title,
    subtitle: '',
    done,
    custom: false,
    order: 0,
    completedAt: atMs == null ? null : new Date(atMs).toISOString(),
  };
}

const NO_DASH = /[\u2013\u2014]/;
const PRONOUN = /\b(she|her|hers|he|him|his)\b/i;

function copyClean(...parts: string[]): boolean {
  return parts.every((p) => !NO_DASH.test(p) && !PRONOUN.test(p));
}

async function main(): Promise<void> {
  // Fixed local noon: calendar-day assertions stay deterministic.
  const now = new Date();
  const nowMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();

  // --- stamped forward action -------------------------------------------
  {
    const m = latestModel({
      lastAction: { kind: 'checked', stepTitle: 'Home inspection', at: new Date(nowMs - 2 * HOUR).toISOString() },
      steps: [],
      realtorName: 'Maya Sharma',
      nowMs,
    });
    assert(m.kicker === 'LATEST FROM MAYA', `kicker uses first name uppercased (got ${m.kicker})`);
    assert(m.lead === 'Checked off', `forward lead (got ${m.lead})`);
    assert(m.stepTitle === 'Home inspection', 'step title carried');
    assert(m.time === '2h ago', `relative time (got ${m.time})`);
    assert(m.icon === 'check', 'forward move gets the green check');
    assert(copyClean(m.kicker, m.lead, m.stepTitle ?? '', m.time), 'no dashes or pronouns');
  }

  // --- stamped backward action: neutral wording, neutral icon -----------
  {
    const m = latestModel({
      lastAction: { kind: 'reopened', stepTitle: 'Appraisal', at: new Date(nowMs - 25 * MIN).toISOString() },
      steps: [],
      realtorName: 'Maya Sharma',
      nowMs,
    });
    assert(m.lead === 'Reopened', `backward lead is neutral (got ${m.lead})`);
    assert(m.stepTitle === 'Appraisal', 'reopened step title carried');
    assert(m.time === '25m ago', `relative time (got ${m.time})`);
    assert(m.icon === 'reopen', 'backward move gets the neutral icon, not the green check');
    assert(m.kicker === 'LATEST FROM MAYA', 'kicker unchanged on backward moves');
    assert(copyClean(m.kicker, m.lead, m.stepTitle ?? '', m.time), 'no dashes or pronouns');
  }

  // --- derived from completed_at when no stamp exists --------------------
  {
    const m = latestModel({
      steps: [
        step('a', 'Escrow open', true, nowMs - 9 * DAY),
        step('b', 'Home inspection', true, nowMs - 2 * DAY),
        step('c', 'Appraisal', false, null),
      ],
      realtorName: 'Maya Sharma',
      nowMs,
    });
    assert(m.lead === 'Checked off' && m.stepTitle === 'Home inspection',
      `picks the latest completed_at (got ${m.lead} ${m.stepTitle})`);
    assert(m.time === '2d ago', `relative time (got ${m.time})`);
    assert(m.icon === 'check', 'derived checkoff gets the green check');
  }

  // --- fallback: nothing checked off ------------------------------------
  {
    const m = latestModel({
      steps: [step('a', 'Escrow open', false, null)],
      realtorName: 'Maya Sharma',
      openedAt: new Date(nowMs - 5 * DAY).toISOString(),
      nowMs,
    });
    assert(m.lead === 'Maya opened your escrow', `fallback lead (got ${m.lead})`);
    assert(m.stepTitle === null, 'fallback carries no step title');
    assert(m.time === '5d ago', `fallback relative time (got ${m.time})`);
    assert(copyClean(m.kicker, m.lead, m.time), 'no dashes or pronouns');
  }

  // --- fallback with no name on the profile ------------------------------
  {
    const m = latestModel({
      steps: [],
      realtorName: '',
      openedAt: new Date(nowMs - 3 * DAY).toISOString(),
      nowMs,
    });
    assert(m.kicker === 'LATEST FROM YOUR REALTOR', `nameless kicker (got ${m.kicker})`);
    assert(m.lead === 'Your realtor opened your escrow', `nameless fallback (got ${m.lead})`);
    assert(copyClean(m.kicker, m.lead, m.time), 'no dashes or pronouns');
  }

  // --- relativeTime buckets ----------------------------------------------
  assert(relativeTime(new Date(nowMs - 2 * MIN).toISOString(), nowMs) === 'just now', 'just now < 5 min');
  assert(relativeTime(new Date(nowMs - 4 * MIN - 59000).toISOString(), nowMs) === 'just now', 'just now boundary');
  assert(relativeTime(new Date(nowMs - 5 * MIN).toISOString(), nowMs) === '5m ago', '5m ago');
  assert(relativeTime(new Date(nowMs - 59 * MIN).toISOString(), nowMs) === '59m ago', '59m ago');
  assert(relativeTime(new Date(nowMs - 1 * HOUR).toISOString(), nowMs) === '1h ago', '1h ago');
  assert(relativeTime(new Date(nowMs - 23 * HOUR).toISOString(), nowMs) === '23h ago', '23h ago');
  // 26h ago from local noon lands on the previous calendar day.
  assert(relativeTime(new Date(nowMs - 26 * HOUR).toISOString(), nowMs) === 'Yesterday', 'Yesterday');
  assert(relativeTime(new Date(nowMs - 3 * DAY).toISOString(), nowMs) === '3d ago', '3d ago');
  assert(relativeTime(new Date(nowMs - 6 * DAY).toISOString(), nowMs) === '6d ago', '6d ago');

  // --- always visible with old timestamps: calendar date, never hidden ---
  {
    const old = new Date(nowMs - 40 * DAY);
    const expected =
      `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][old.getMonth()]} ${old.getDate()}` +
      (old.getFullYear() === new Date(nowMs).getFullYear() ? '' : `, ${old.getFullYear()}`);
    assert(relativeTime(old.toISOString(), nowMs) === expected,
      `40 days ago renders as a date (got ${relativeTime(old.toISOString(), nowMs)})`);
    const m = latestModel({
      lastAction: { kind: 'checked', stepTitle: 'Escrow open', at: old.toISOString() },
      steps: [],
      realtorName: 'Maya Sharma',
      nowMs,
    });
    assert(m.time === expected && m.lead === 'Checked off', 'old actions still render the card');
  }
  {
    // Across years: "Mar 3, 2025" style.
    const then = new Date(nowMs - 400 * DAY);
    const label = relativeTime(then.toISOString(), nowMs);
    assert(/, \d{4}$/.test(label), `cross-year date carries the year (got ${label})`);
  }

  // --- future / garbage input never blanks the card ----------------------
  assert(relativeTime(new Date(nowMs + HOUR).toISOString(), nowMs) === 'just now', 'future reads just now');
  assert(relativeTime('not-a-date', nowMs) === 'just now', 'unparseable reads just now');

  summary('latest');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
