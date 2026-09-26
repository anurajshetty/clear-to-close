-- Clear to Close 0006: allow the 'cancelled' escrow status.
-- The deal-list edit/cancel round (Sept 2026) moves cancelled escrows into a
-- dedicated "Cancelled escrows" section; the status must round-trip through
-- the cloud sync. History is never rewritten — this alters the constraint in
-- place.
alter table escrows drop constraint escrows_status_check;
alter table escrows add constraint escrows_status_check
  check (status in ('open', 'closed', 'cancelled'));
