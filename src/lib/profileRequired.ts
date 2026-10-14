// Clear to Close — required profile fields (Anuraj, Oct 14, 2026).
//
// Full name, Email, Phone, and Broker are REQUIRED on the profile form:
// an empty (trimmed) value shows the inline "Required" error under the
// field and blocks the save — the same pattern Full name always had,
// extended to the three fields Anuraj marked on his annotated screenshot
// ("Those marked fields cannot be optional"). Email and phone ALSO carry
// basic format validation (Amendment 3, Oct 14, 2026 — see below); broker
// stays non-empty-only. License number and the review links stay
// optional.
//
// The parent screens own the validation state (they pass the errors into
// ProfileForm, exactly like nameError); this helper is the single shared
// computation they all use, so the three screens can never drift.
// Onboarding's Skip path never calls it — skipping does not validate.

export type RequiredProfileField = 'name' | 'email' | 'phone' | 'broker';

/** The draft fields the required check reads (structural — no form import). */
export interface RequiredProfileInput {
  name: string;
  email: string;
  phone: string;
  realty_group: string;
}

/**
 * Which required fields are empty (whitespace-only counts as empty), in
 * form order. An empty result means the profile may save.
 */
export function missingRequiredProfileFields(
  input: RequiredProfileInput,
): RequiredProfileField[] {
  const missing: RequiredProfileField[] = [];
  if (!input.name.trim()) missing.push('name');
  if (!input.email.trim()) missing.push('email');
  if (!input.phone.trim()) missing.push('phone');
  if (!input.realty_group.trim()) missing.push('broker');
  return missing;
}

/** The inline error text for a field, given the missing-fields result. */
export function requiredErrorFor(
  missing: RequiredProfileField[],
  field: RequiredProfileField,
): string | null {
  return missing.includes(field) ? 'Required' : null;
}

// --- Format validation (Anuraj, Oct 14, 2026 — Amendment 3) -----------------
// On top of the required rule: a NON-empty email/phone must also be
// well-formed, or the save is blocked with a format error. Broker stays
// non-empty-only. Validation only — values are stored and displayed
// exactly as typed, never reformatted.

/**
 * Basic email shape: no spaces, exactly one @, a non-empty local part,
 * and a domain containing a dot. Deliberately not a full RFC check.
 */
export function isValidProfileEmail(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || /\s/.test(v)) return false;
  const parts = v.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && domain.length > 0 && domain.includes('.');
}

/**
 * US phone shape: strip spaces, dashes, parentheses, and a leading +;
 * the remainder must be all digits — 10 digits, or 11 beginning with 1.
 */
export function isValidProfilePhone(value: string): boolean {
  const digits = value.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return false;
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/** Email field error: empty -> "Required"; malformed -> the format error. */
export function profileEmailError(value: string): string | null {
  if (!value.trim()) return 'Required';
  return isValidProfileEmail(value) ? null : 'Enter a valid email address';
}

/** Phone field error: empty -> "Required"; malformed -> the format error. */
export function profilePhoneError(value: string): string | null {
  if (!value.trim()) return 'Required';
  return isValidProfilePhone(value) ? null : 'Enter a valid phone number';
}

/** Every field's error for a draft (null = fine), in one pass. */
export interface ProfileFieldErrors {
  name: string | null;
  email: string | null;
  phone: string | null;
  broker: string | null;
}

export function profileFieldErrors(input: RequiredProfileInput): ProfileFieldErrors {
  const missing = missingRequiredProfileFields(input);
  return {
    name: requiredErrorFor(missing, 'name'),
    email: profileEmailError(input.email),
    phone: profilePhoneError(input.phone),
    broker: requiredErrorFor(missing, 'broker'),
  };
}

/** True when any field carries an error (the save must block). */
export function hasProfileFieldErrors(errors: ProfileFieldErrors): boolean {
  return errors.name !== null || errors.email !== null || errors.phone !== null || errors.broker !== null;
}
