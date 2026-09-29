// toast_dismiss.test.ts — "Added to your escrows." stuck-toast regression
// (Anuraj-reported from his own testing, Sept 28, 2026).
//
// Root cause: on the multi-escrow client list the dismiss setTimeout was
// armed in the SAME useEffect that consumed the `added` route param.
// Consuming the param re-rendered the screen, the effect re-ran, and its
// cleanup (clearTimeout) cancelled the dismiss timer — the toast appeared
// and never left, stuck over the header.
//
// The fix moves the timer into ToastTimer (src/lib/toast.ts), which the
// screen drives: only show()/dismiss() ever touch the armed timer, so the
// param-consumption re-render can no longer cancel it. The toast is also a
// Pressable now (was pointerEvents="none"), so a tap dismisses it.
//
// Part 1 drives the real ToastTimer with a manual clock: visible ->
// auto-dismissed after the timeout, tap dismisses immediately, re-show
// re-arms. Part 2 pins the screen wiring structurally (the RN component
// cannot run in node): the old self-cancelling pattern is gone and the
// tap-to-dismiss Pressable is present.
import { assert, summary } from './assert';
import { ToastTimer, TOAST_DISMISS_MS } from '../src/lib/toast';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const fs = require('fs');
const path: { join(...p: string[]): string } = require('path');

// ---- manual clock -------------------------------------------------------
interface Armed {
  cb: () => void;
  ms: number;
  cancelled: boolean;
}
function manualClock(): {
  armed: Armed[];
  schedule: (cb: () => void, ms: number) => () => void;
  fire: (i: number) => void;
} {
  const armed: Armed[] = [];
  const schedule = (cb: () => void, ms: number) => {
    const a: Armed = { cb, ms, cancelled: false };
    armed.push(a);
    return () => {
      a.cancelled = true;
    };
  };
  const fire = (i: number) => {
    if (!armed[i].cancelled) armed[i].cb();
  };
  return { armed, schedule, fire };
}

async function main(): Promise<void> {
  assert(TOAST_DISMISS_MS === 3000, 'auto-dismiss delay is ~3 seconds');

  // visible -> auto-dismissed after the timeout
  {
    const { armed, schedule, fire } = manualClock();
    const t = new ToastTimer(schedule);
    assert(t.visible === false, 'toast starts hidden');
    t.show();
    assert(t.visible === true, 'show() makes the toast visible');
    assert(
      armed.length === 1 && armed[0].ms === TOAST_DISMISS_MS,
      'show() arms the dismiss timer at ~3s',
    );
    fire(0);
    assert(t.visible === false, 'toast auto-dismisses when the timer fires');
  }

  // tap dismisses immediately and neutralises the pending timer
  {
    const { armed, schedule, fire } = manualClock();
    const t = new ToastTimer(schedule);
    t.show();
    t.dismiss(); // the tap
    assert(t.visible === false, 'tap dismisses the toast immediately');
    assert(armed[0].cancelled === true, 'tap cancels the pending dismiss timer');
    fire(0); // the stale timer must not resurface anything
    assert(t.visible === false, 'stale timer cannot reshow the toast');
  }

  // re-show re-arms: a second redeem's toast is not killed early by the
  // first toast's timer
  {
    const { armed, schedule, fire } = manualClock();
    const t = new ToastTimer(schedule);
    t.show();
    t.show();
    assert(armed[0].cancelled === true, 're-show cancels the previous timer');
    fire(0);
    assert(t.visible === true, 'old timer cannot hide the re-shown toast');
    fire(1);
    assert(t.visible === false, 're-armed timer still auto-dismisses');
  }

  // The regression core: unrelated state churn (the `added` param
  // consumption that re-rendered the screen and re-ran the old effect) must
  // not cancel the armed dismiss timer — only show()/dismiss() touch it.
  {
    const { armed, schedule, fire } = manualClock();
    const t = new ToastTimer(schedule);
    const seen: boolean[] = [];
    const unsub = t.subscribe((v) => seen.push(v));
    t.show();
    // ...param consumed, screen re-renders, effects re-run: nothing here
    // touches the timer.
    assert(armed[0].cancelled === false, 'unrelated churn leaves the timer armed');
    fire(0);
    assert(t.visible === false, 'toast still auto-dismisses after the churn');
    assert(seen.join(',') === 'true,false', 'subscribers see show then hide');
    unsub();
    t.show();
    assert(seen.length === 2, 'unsubscribed listener is not called again');
  }

  // ---- structural pins on app/client/escrows.tsx -------------------------
  const root = process.env.CTC_REPO_ROOT ?? path.join('..');
  const screen: string = fs.readFileSync(
    path.join(root, 'app/client/escrows.tsx'),
    'utf8',
  );

  assert(
    screen.includes('new ToastTimer()') && screen.includes('addedToast.show()'),
    'escrows list drives the toast through ToastTimer (timer out of the param effect)',
  );
  assert(
    !/setTimeout\(\(\) => setShowAddedToast\(false\)/.test(screen),
    'old self-cancelling pattern (dismiss timer armed next to setParams) is gone',
  );
  assert(
    screen.includes('<Pressable') &&
      /onPress=\{\(\) => addedToast\.dismiss\(\)\}/.test(screen),
    'toast is a Pressable with tap-to-dismiss',
  );
  assert(
    !screen.includes('pointerEvents="none"'),
    'toast no longer swallows touches via pointerEvents="none"',
  );
  assert(screen.includes('testID="added-toast"'), 'toast carries testID="added-toast"');
  assert(
    screen.includes('Added to your escrows.'),
    'approved toast copy is unchanged',
  );

  summary('toast_dismiss');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
