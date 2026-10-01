// Clear to Close — buyer intake read-only sections (Oct 1, 2026,
// Anuraj-approved mockup 08, device ③).
//
// Thin wrapper over the shared IntakeSections renderer
// (src/components/TcIntakeEntry.tsx): the TC's read-only buyer-details
// page and the realtor's LOCKED buyer intake form render the exact same
// sections, label + value rows, and muted "Not provided" treatment as the
// TC intake — one renderer, no divergent copies.
import React from 'react';
import { IntakeSections } from './TcIntakeEntry';
import { buildBuyerIntakeSections, type BuyerIntakeData } from '../lib/buyerIntake';

export function BuyerIntakeSections({
  data,
  fullAddress,
}: {
  data: BuyerIntakeData;
  fullAddress: string;
}) {
  return <IntakeSections sections={buildBuyerIntakeSections(data, fullAddress)} />;
}
