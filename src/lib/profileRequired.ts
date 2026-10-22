// Clear to Close — required profile fields (Anuraj, Oct 14, 2026;
// broker amended Oct 22, 2026 — see below).
//
// Full name, Email, and Phone are REQUIRED on the profile form:
// an empty (trimmed) value shows the inline "Required" error under the
// field and blocks the save — the same pattern Full name always had,
// extended to the fields Anuraj marked on his annotated screenshot
// ("Those marked fields cannot be optional"). Email and phone ALSO
// carry basic format validation (Amendment 3, Oct 14, 2026 — see
// below). License number and the review links stay optional.
//
// Oct 22, 2026 (Anuraj): Broker is OPTIONAL again — a deliberate
// reversal of the Oct 14 call for this field only. With Team Access,
// Associates and TCs hold their own accounts and may not belong to a
// brokerage, so a broker value cannot be demanded of every profile.
//
// The parent screens own the validation state (they pass the errors into
// ProfileForm, exactly like nameError); this helper is the single shared
// computation they all use, so the three screens can never drift.
// Onboarding's Skip path never calls it — skipping does not validate.

export type RequiredProfileField = 'name' | 'email' | 'phone';

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
// well-formed, or the save is blocked with a format error. Validation
// only — values are stored and displayed exactly as typed, never
// reformatted.

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
    // Broker is optional (Oct 22, 2026): the field stays in the shape
    // (parents pass it through to the form) but never carries an error.
    broker: null,
  };
}

/** True when any field carries an error (the save must block). */
export function hasProfileFieldErrors(errors: ProfileFieldErrors): boolean {
  return errors.name !== null || errors.email !== null || errors.phone !== null;
}

// --- Email pre-fill (Anuraj, Oct 22, 2026) ----------------------------------
// The profile contact Email pre-fills with the signed-in account's
// email whenever the STORED profile email is empty (most importantly
// on profile-create, where the draft otherwise starts empty). A
// stored email always wins, returned exactly as stored; the result
// is a one-time initial value — the field stays fully editable, and
// nothing syncs between the login email and the contact email after.

export function prefillProfileEmail(
  storedEmail: string | null | undefined,
  sessionEmail: string | null | undefined,
): string {
  if (storedEmail && storedEmail.trim()) return storedEmail;
  if (sessionEmail && sessionEmail.trim()) return sessionEmail;
  return '';
}
