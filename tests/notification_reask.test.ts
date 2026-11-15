// notification_reask.test.ts — Notification Re-Ask (approved design,
// Nov 14, 2026): source pins for the PushGate sheet rewrite, the
// contextual trigger wiring, and the shared profile Notifications row.
// The eligibility/state matrix itself lives in push.test.ts.
import { assert, summary } from './assert';

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };
const fs = require('fs');
const path = require('path');

function findRepoRoot(): string {
  const rel = path.join('src', 'lib', 'push.ts');
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, rel))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
const ROOT = findRepoRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function main(): void {
  const push = read('src/lib/push.ts');
  const gate = read('src/components/PushGate.tsx');

  // ---- push.ts: the ask-once API is gone, replaced by the re-ask state.
  assert(!push.includes('shouldShowPrePrompt'), 'push: ask-once client eligibility removed');
  assert(!push.includes('shouldShowRealtorPrePrompt'), 'push: ask-once realtor eligibility removed');
  assert(push.includes('timedAskEligible'), 'push: timed re-ask eligibility exists');
  assert(push.includes('contextualAskEligible'), 'push: contextual eligibility exists');
  assert(push.includes('notifyContextualPushAsk'), 'push: contextual trigger bus exists');
  assert(push.includes('ctc:pushask:realtor') && push.includes('ctc:pushask:client'),
    'push: per-role re-ask storage keys are namespaced');

  // ---- PushGate: eligibility + two-state button + final-ask tertiary.
  assert(gate.includes('timedAskEligible'), 'gate: timed sheets use the re-ask eligibility');
  assert(gate.includes('contextualAskEligible'), 'gate: contextual sheets use the contextual eligibility');
  assert(gate.includes('onContextualPushAsk'), 'gate: subscribes to contextual triggers');
  assert(
    gate.includes('Notifications are turned off for Clear to Close in your device Settings.'),
    'gate: denied state adds the Settings line verbatim',
  );
  assert(gate.includes('Open Settings') && gate.includes('Linking.openSettings()'),
    'gate: denied primary is Open Settings -> Linking.openSettings()');
  assert(gate.includes("Don't ask again") && gate.includes('push-dont-ask-again'),
    "gate: the final ask carries the Don't ask again tertiary");
  assert(gate.includes('isFinalAsk'), 'gate: tertiary is gated on the final ask');
  // Timed sheets keep the existing approved copy + button label.
  assert(gate.includes('Get notified the moment a client joins an escrow, leaves a review, or submits an intake. Nothing important slips by.'),
    'gate: realtor timed copy unchanged');
  assert(gate.includes("timed ? 'Allow'") && gate.includes('title={primaryTitle}'),
    'gate: timed primary keeps the approved Allow label');
  // Contextual copy, verbatim from the approved spec.
  // The spec's invite copy carries an em dash; Anuraj's standing
  // no-user-facing-em-dash rule (enforced by the em_dash_sweep test)
  // wins, so the dash ships as a colon — flagged to the coordinator
  // with the build report as a one-character deviation.
  assert(
    gate.includes('Your invite is on its way: turn on notifications so you know the moment your team joins and starts checking off steps.'),
    'gate: invite contextual copy (em dash rendered as a colon per the standing rule)',
  );
  assert(
    gate.includes("You're in! Turn on notifications so you know the moment your realtor checks off a step."),
    'gate: code-join contextual copy verbatim',
  );
  assert(gate.includes(": 'Turn on notifications'") && gate.includes('title={primaryTitle}'),
    'gate: contextual primary label verbatim');

  // ---- Trigger call sites: AFTER the success states, never blocking them.
  const team = read('app/team/[id].tsx');
  const inviteToast = team.indexOf("showToast('Invite sent.')");
  const inviteNotify = team.indexOf("notifyContextualPushAsk('realtor-invite')");
  assert(inviteNotify >= 0, 'team screen: invite success fires the contextual trigger');
  assert(inviteToast >= 0 && inviteNotify > inviteToast,
    'team screen: the trigger follows the Invite sent success state');

  const redeem = read('app/redeem.tsx');
  const joinNotify = redeem.indexOf("notifyContextualPushAsk('client-code-join')");
  assert(joinNotify >= 0, 'redeem: a fresh code-join fires the contextual trigger');
  const alreadyReturn = redeem.indexOf('if (alreadyLinked)');
  assert(alreadyReturn >= 0 && joinNotify > alreadyReturn,
    'redeem: the trigger sits past the already-linked early return (re-redeem never fires it)');

  // ---- Sign-up / first-login trigger (amendment, Nov 14, 2026).
  assert(push.includes('signupAskEligible'), 'push: signup eligibility exists');
  assert(push.includes('recordSignupAskShown'), 'push: signup recording exists');
  assert(gate.includes('signupAskEligible'), 'gate: the signup attempt uses its stricter eligibility');
  assert(gate.includes('recordSignupAskShown'), 'gate: a shown signup ask records count + cooldown');
  assert(gate.includes('pendingSignup'), 'gate: the signup ask waits for the deal-list landing');
  const login = read('app/login.tsx');
  assert(login.includes("notifyContextualPushAsk('realtor-signup')"),
    'login: an explicit login fires the signup trigger');
  const signup = read('app/signup.tsx');
  assert(signup.includes("notifyContextualPushAsk('realtor-signup')"),
    'signup: a sign-up completion fires the signup trigger');
  const layout = read('app/_layout.tsx');
  assert(!layout.includes("realtor-signup"),
    'layout: session restore never fires the signup trigger');

  // ---- Shared profile row: ONE component, both profile surfaces.
  const rowPath = path.join(ROOT, 'src', 'components', 'NotificationRow.tsx');
  assert(fs.existsSync(rowPath), 'row: the shared NotificationRow component exists');
  if (fs.existsSync(rowPath)) {
    const row = read('src/components/NotificationRow.tsx');
    assert(row.includes('testID="notifications-row"'), 'row: carries the notifications-row testID');
    assert(row.includes('Notifications'), 'row: label is Notifications');
    assert(row.includes('Off · Turn on'), 'row: off status copy is "Off · Turn on"');
    assert(row.includes('getPushPermission'), 'row: reads live permission');
    assert(row.includes('useFocusEffect') && row.includes('AppState'),
      'row: status re-checks on focus and on foreground');
    assert(row.includes('Linking.openSettings()'), 'row: denied/on taps deep-link to Settings');
    assert(row.includes('requestPushPermission'), 'row: undetermined tap runs the system prompt');
    assert(row.includes('registerRealtorPushToken') && row.includes('registerPushToken'),
      'row: a fresh grant registers the role token (self-heal)');
    // Auditor condition 3: the row's availability is UNCONDITIONAL —
    // it must not consult the ask state at all, so it stays present
    // and functional at the cap, with the stop flag set, and in the
    // denied state. Independence from the state machine is the pin.
    assert(
      !row.includes('readPushAskState') && !row.includes('dontAskAgain') && !row.includes('PUSH_ASK_CAP'),
      'row: never reads the ask state (available at cap / stop / denied alike)',
    );
    assert(!row.includes('timedAskEligible') && !row.includes('contextualAskEligible'),
      'row: no eligibility gate of any kind');
  }
  // Condition 4: fired flags are written at SHOW time, never on
  // dismissal — the Not now handler must record nothing.
  {
    const start = gate.indexOf('const onNotNow');
    const body = start >= 0 ? gate.slice(start, start + 400) : '';
    assert(
      body !== '' &&
        !/record\w*AskShown\(/.test(body) &&
        !body.includes('markDontAskAgain('),
      'gate: Not now records nothing (asks are recorded at show time only)',
    );
    assert(gate.includes('recordTimedAskShown') && gate.includes('recordContextualAskShown'),
      'gate: timed + contextual asks record at show time');
  }
  const realtorProfile = read('app/profile-update.tsx');
  assert(realtorProfile.includes("from '../src/components/NotificationRow'") ||
    realtorProfile.includes('components/NotificationRow'),
    'realtor profile: imports the shared row');
  assert(realtorProfile.includes('<NotificationRow'), 'realtor profile: renders the shared row');
  assert(
    realtorProfile.indexOf('<NotificationRow') > realtorProfile.indexOf('change-password-open') &&
      realtorProfile.indexOf('<NotificationRow') < realtorProfile.indexOf('logout-row'),
    'realtor profile: the row sits between Change password and Log out (no existing row reordered)',
  );
  const clientProfile = read('app/client/profile.tsx');
  assert(clientProfile.includes('<NotificationRow'), 'client profile: renders the shared row');
  assert(
    !clientProfile.includes('Notifications are off. Turn them on in Settings to get step updates.'),
    'client profile: the old denied-only hint is superseded by the row',
  );

  summary('notification_reask.test.ts');
}

main();
