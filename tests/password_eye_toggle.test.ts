// Clear to Close — password show/hide eye toggle (Anuraj, Sept 2026).
//
// Every password field gets the approved eye icon inside the field,
// toggling secureTextEntry. Coverage:
//   - app/login.tsx + app/signup.tsx use the shared Field with
//     secureTextEntry -> Field's toggle covers both.
//   - src/components/ChangePasswordSheet.tsx PasswordField has its own
//     eye toggle (approved mockup).
//   - app/reset-password.tsx reuses ChangePasswordSheet's PasswordField.
// Structural pin (components import react-native and cannot run in node):
// assert the sources wire the toggle.
import { assert, summary } from './assert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
declare const process: { env: Record<string, string | undefined> };

const fs = require('fs');
const path: { join(...p: string[]): string } = require('path');

const root = process.env.CTC_REPO_ROOT ?? path.join('..');
const ui = fs.readFileSync(path.join(root, 'src/components/ui.tsx'), 'utf8');
const login = fs.readFileSync(path.join(root, 'app/login.tsx'), 'utf8');
const signup = fs.readFileSync(path.join(root, 'app/signup.tsx'), 'utf8');
const changePw = fs.readFileSync(
  path.join(root, 'src/components/ChangePasswordSheet.tsx'),
  'utf8',
);
const recovery = fs.readFileSync(path.join(root, 'app/reset-password.tsx'), 'utf8');

// The shared Field renders an eye toggle exactly for password fields.
assert(
  /secureTextEntry=\{isPassword && !shown\}/.test(ui),
  'Field: secureTextEntry toggles with the shown state',
);
assert(
  /onPress=\{\(\) => setShown\(\(s\) => !s\)\}/.test(ui),
  'Field: eye button flips the shown state',
);
assert(
  ui.includes("accessibilityLabel={shown ? 'Hide password' : 'Show password'}"),
  'Field: eye button has an accessible Show/Hide label',
);
assert(
  /\{isPassword \? \(\s*<Pressable/.test(ui),
  'Field: the eye toggle renders only on password fields',
);
assert(
  /export function EyeIcon/.test(ui),
  'ui.tsx exports the shared EyeIcon',
);

// Login + signup password fields go through the shared Field.
assert(
  login.includes('secureTextEntry') && login.includes('<Field'),
  'login: password field uses the shared Field with secureTextEntry',
);
assert(
  signup.includes('secureTextEntry') && signup.includes('<Field'),
  'signup: password field uses the shared Field with secureTextEntry',
);

// One EyeIcon definition: the change-password sheet reuses the shared one.
assert(
  !/function EyeIcon/.test(changePw),
  'ChangePasswordSheet: no divergent EyeIcon copy (uses the shared one)',
);
assert(
  changePw.includes("from './ui'") && /EyeIcon/.test(changePw),
  'ChangePasswordSheet: imports the shared EyeIcon',
);
assert(
  /secureTextEntry=\{!shown\}/.test(changePw),
  'ChangePasswordSheet: its password fields keep their own eye toggle',
);

// The recovery screen reuses the change-password field component.
assert(
  recovery.includes("from '../src/components/ChangePasswordSheet'") &&
    recovery.includes('PasswordField'),
  'reset-password: reuses ChangePasswordSheet PasswordField (eye toggle included)',
);

summary('password_eye_toggle');
