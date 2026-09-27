// pace.test.ts — REGRESSION: client top-card status pill (approved
// client-home-card sample, Anuraj, Sept 2026).
//
// The ahead-of-pace pill is GONE (Anuraj's call, Sept 2026): no pace pill,
// no pace logic anywhere. This suite covers what remains:
// completionPill: 100% + 5 or more days left -> the "days to spare" pill;
// 100% with fewer -> the unchanged "Congratulations, your checklist is
// complete". Anything else -> no pill.
//
// Run with TZ=America/Los_Angeles (see tests/run.sh) for DST-safe day math.
import { assert, summary } from './assert';
import { completionPill, firstNameOf } from '../src/lib/pace';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
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
