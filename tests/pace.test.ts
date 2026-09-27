// pace.test.ts — REGRESSION: client top-card status pills (branding redesign,
// APPROVED mockup screens 7 + 9, Sept 2026).
//
// aheadOfPace: while the escrow is in progress, completion % (done/total) is
// compared against time-elapsed % (days since open / total open-to-close
// days). A 15+ point lead shows the gold "Ahead of pace" pill with
// daysAhead = round((completion% - elapsed%) * totalDays).
// completionPill: 100% + 5 or more days left -> the "days to spare" pill;
// 100% with fewer -> the unchanged "Congratulations, your checklist is
// complete".
//
// "today" is computed at runtime via nowMs so no date in this file goes stale.
// Run with TZ=America/Los_Angeles (see tests/run.sh) for DST-safe day math.
import { assert, summary } from './assert';
import { aheadOfPace, completionPill, firstNameOf, PACE_GAP_POINTS } from '../src/lib/pace';
import { localDateISO } from '../src/lib/dates';

declare const process: { exitCode?: number };

function isoPlusDays(nowMs: number, n: number): string {
  const d = new Date(nowMs);
  return localDateISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

async function main(): Promise<void> {
  const nowMs = Date.now();

  // --- aheadOfPace: the headline case -------------------------------------
  // 60-day timeline, 10 days elapsed (16.7%), 5 of 10 steps done (50%):
  // gap = 33.3 points -> ahead, daysAhead = round(0.333 * 60) = 20.
  {
    const r = aheadOfPace({
      done: 5,
      total: 10,
      openDate: isoPlusDays(nowMs, -10),
      closeDate: isoPlusDays(nowMs, 50),
      nowMs,
    });
    assert(r.kind === 'ahead' && r.daysAhead === 20, `ahead shown, 20 days (got ${JSON.stringify(r)})`);
  }

  // Exactly at the 15-point threshold -> shown.
  {
    // 100-day timeline, 5 elapsed (5%), 20 of 100 done (20%): gap = 15.
    const r = aheadOfPace({
      done: 20,
      total: 100,
      openDate: isoPlusDays(nowMs, -5),
      closeDate: isoPlusDays(nowMs, 95),
      nowMs,
    });
    assert(
      r.kind === 'ahead' && r.daysAhead === 15,
      `15-point gap shows, 15 days ahead (got ${JSON.stringify(r)})`,
    );
  }

  // Below the threshold -> hidden.
  {
    // 100-day timeline, 10 elapsed (10%), 20 of 100 done (20%): gap = 10.
    const r = aheadOfPace({
      done: 20,
      total: 100,
      openDate: isoPlusDays(nowMs, -10),
      closeDate: isoPlusDays(nowMs, 90),
      nowMs,
    });
    assert(r.kind === 'none', `10-point gap hidden (got ${JSON.stringify(r)})`);
  }

  // Behind schedule -> hidden.
  {
    const r = aheadOfPace({
      done: 1,
      total: 10,
      openDate: isoPlusDays(nowMs, -50),
      closeDate: isoPlusDays(nowMs, 10),
      nowMs,
    });
    assert(r.kind === 'none', `behind schedule hidden (got ${JSON.stringify(r)})`);
  }

  // 100% complete -> NEVER shown (the completion pill owns that state),
  // even with a huge gap.
  {
    const r = aheadOfPace({
      done: 10,
      total: 10,
      openDate: isoPlusDays(nowMs, -5),
      closeDate: isoPlusDays(nowMs, 95),
      nowMs,
    });
    assert(r.kind === 'none', `100% never shows ahead-of-pace (got ${JSON.stringify(r)})`);
  }

  // Degenerate timelines -> hidden, never a wrong number.
  {
    const same = isoPlusDays(nowMs, 30);
    const zero = aheadOfPace({ done: 5, total: 10, openDate: same, closeDate: same, nowMs });
    assert(zero.kind === 'none', `zero-day timeline hidden (got ${JSON.stringify(zero)})`);
    const neg = aheadOfPace({
      done: 5,
      total: 10,
      openDate: isoPlusDays(nowMs, 40),
      closeDate: isoPlusDays(nowMs, 30),
      nowMs,
    });
    assert(neg.kind === 'none', `negative timeline hidden (got ${JSON.stringify(neg)})`);
  }

  // Missing dates -> hidden.
  {
    const noClose = aheadOfPace({ done: 5, total: 10, openDate: isoPlusDays(nowMs, -10), nowMs });
    assert(noClose.kind === 'none', `missing closeDate hidden (got ${JSON.stringify(noClose)})`);
    const noOpen = aheadOfPace({ done: 5, total: 10, closeDate: isoPlusDays(nowMs, 50), nowMs });
    assert(noOpen.kind === 'none', `missing openDate hidden (got ${JSON.stringify(noOpen)})`);
  }

  // Malformed date -> hidden, never throws.
  {
    const bad = aheadOfPace({ done: 5, total: 10, openDate: 'not-a-date', closeDate: isoPlusDays(nowMs, 50), nowMs });
    assert(bad.kind === 'none', `malformed openDate hidden (got ${JSON.stringify(bad)})`);
  }

  // Empty checklist -> hidden.
  {
    const r = aheadOfPace({
      done: 0,
      total: 0,
      openDate: isoPlusDays(nowMs, -10),
      closeDate: isoPlusDays(nowMs, 50),
      nowMs,
    });
    assert(r.kind === 'none', `empty checklist hidden (got ${JSON.stringify(r)})`);
  }

  // Gap large but timeline tiny: daysAhead rounds to 0 -> hidden rather than
  // "0 days ahead of schedule".
  {
    // 2-day timeline, opened yesterday (50% elapsed), 2 of 3 done (66.7%):
    // gap = 16.7 -> daysAhead = round(0.167 * 2) = 0.
    const r = aheadOfPace({
      done: 2,
      total: 3,
      openDate: isoPlusDays(nowMs, -1),
      closeDate: isoPlusDays(nowMs, 1),
      nowMs,
    });
    assert(r.kind === 'none', `rounds-to-zero daysAhead hidden (got ${JSON.stringify(r)})`);
  }

  assert(PACE_GAP_POINTS === 15, 'threshold constant is 15 points');

  // --- completionPill ------------------------------------------------------
  {
    const spare = completionPill({ done: 14, total: 14, daysToClose: 27, name: 'Maya Sharma' });
    assert(
      spare?.variant === 'spare' &&
        spare.text === 'Checklist complete with 27 days to spare. Maya has you ahead of schedule.',
      `spare pill copy exact (got ${JSON.stringify(spare)})`,
    );
  }
  {
    const edge = completionPill({ done: 14, total: 14, daysToClose: 5, name: 'Maya Sharma' });
    assert(edge?.variant === 'spare', 'exactly 5 days left still earns the spare pill');
  }
  {
    const done_ = completionPill({ done: 14, total: 14, daysToClose: 4, name: 'Maya Sharma' });
    assert(
      done_?.variant === 'done' && done_.text === 'Congratulations, your checklist is complete',
      `under-5-days keeps the unchanged copy (got ${JSON.stringify(done_)})`,
    );
  }
  {
    const due = completionPill({ done: 14, total: 14, daysToClose: 0, name: 'Maya Sharma' });
    assert(due?.variant === 'done', 'due-today completion keeps the unchanged copy');
  }
  {
    const partial = completionPill({ done: 13, total: 14, daysToClose: 27, name: 'Maya Sharma' });
    assert(partial === null, 'in-progress checklist shows no completion pill');
  }
  {
    const empty = completionPill({ done: 0, total: 0, daysToClose: 27, name: 'Maya Sharma' });
    assert(empty === null, 'empty checklist shows no completion pill');
  }

  // Realtor referred by first name only — never a pronoun, never the surname.
  assert(firstNameOf('Maya Sharma') === 'Maya', 'first name extracted');
  assert(firstNameOf('  Maya  ') === 'Maya', 'first name trimmed');
  assert(firstNameOf('') === '', 'empty name -> empty first name');

  // Pre-open timeline: today before the open date must not count as ahead
  // (a negative elapsed % would otherwise inflate the gap). Regression:
  // 1/10 done (10%) with the open 5 days in the future previously read as
  // 10% ahead of a -5% elapsed timeline.
  {
    const preOpen = aheadOfPace({
      done: 1,
      total: 10,
      openDate: isoPlusDays(nowMs, 5),
      closeDate: isoPlusDays(nowMs, 105),
      nowMs,
    });
    assert(preOpen.kind === 'none', 'pre-open shows no ahead-of-pace pill');
  }

  // Missing realtor name: the spare copy drops the name clause cleanly
  // (no blank "  has you...", no pronoun).
  {
    const nameless = completionPill({ done: 14, total: 14, daysToClose: 27, name: '' });
    assert(
      nameless?.variant === 'spare' &&
        nameless.text === 'Checklist complete with 27 days to spare. You\'re ahead of schedule.',
      `nameless spare copy stays clean (got ${JSON.stringify(nameless)})`,
    );
  }

  summary('pace');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
