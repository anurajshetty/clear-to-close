// Clear to Close — default step templates, from the approved mockups.

export interface StepTemplate {
  t: string;
  s: string;
}

export const BUY_STEPS: StepTemplate[] = [
  { t: 'Escrow open', s: 'See the time tracker card above.' },
  { t: 'Earnest money wired', s: 'Within 3 days of open.' },
  { t: 'Property inspection scheduled', s: '' },
  { t: 'Appraisal scheduled', s: '' },
  { t: 'Homeowners insurance quote', s: '' },
  { t: "Seller's disclosure / HOA docs received", s: '' },
  { t: 'Signed loan docs', s: '' },
  { t: 'Release contingencies', s: '' },
  { t: 'Review closing disclosure', s: '' },
  { t: 'Schedule final walkthrough', s: '' },
  { t: 'Close escrow', s: '' },
  { t: 'Record deal', s: '' },
  { t: 'Get keys', s: 'Hand over the keys. Done.' },
];

export const SELL_STEPS: StepTemplate[] = [
  { t: 'Escrow open', s: 'See the time tracker card above.' },
  { t: 'Wire received', s: 'Earnest money from the buyer.' },
  { t: 'Property inspection scheduled', s: '' },
  { t: 'Appraisal scheduled', s: '' },
  { t: 'Seller disclosure due', s: '' },
  { t: 'Order home warranty', s: '' },
  { t: 'Contingency release', s: '' },
  { t: 'Signed closing docs', s: '' },
  { t: 'Schedule utilities', s: 'Final meter reads and shut-off dates.' },
  { t: 'Final walkthrough scheduled', s: '' },
  { t: 'Close escrow', s: '' },
  { t: 'Record deed', s: '' },
];
