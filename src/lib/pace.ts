// Clear to Close — client top-card status-pill logic (pure, unit-tested).
//
// One pill state lives on the client home top card (approved
// client-home-card sample, Anuraj, Sept 2026):
//  - completion (100% checklist): 5+ days left -> "Checklist complete with {N}
//    days to spare. {Name} has you ahead of schedule." Fewer than 5 -> the
//    unchanged "Congratulations, your checklist is complete".
// The ahead-of-pace pill is GONE (Anuraj's call, Sept 2026): no pace pill,
// no pace logic anywhere.

export function firstNameOf(name: string): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export type CompletionPill =
  | { variant: 'spare'; text: string }
  | { variant: 'done'; text: string }
  | null;

export function completionPill(args: {
  done: number;
  total: number;
  daysToClose: number;
  name: string;
}): CompletionPill {
  const { done, total, daysToClose, name } = args;
  if (!(total > 0) || done !== total) return null;
  if (daysToClose >= 5) {
    const first = firstNameOf(name);
    // No name on the profile: drop the name clause rather than leaving a
    // blank ("  has you..."). Second person keeps it pronoun-free.
    const tail = first ? `${first} has you ahead of schedule.` : `You're ahead of schedule.`;
    return {
      variant: 'spare',
      text: `Checklist complete with ${daysToClose} days to spare. ${tail}`,
    };
  }
  // Unchanged existing copy for the under-5-days case.
  return { variant: 'done', text: 'Congratulations, your checklist is complete' };
}
