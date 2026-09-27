// Clear to Close — name helpers (pure, unit-tested).
//
// The pace/completion pills are GONE (Anuraj's call, Sept 2026): no pace
// pill, no completion pill, no pace logic anywhere. firstNameOf remains
// for share/review copy.

export function firstNameOf(name: string): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}
