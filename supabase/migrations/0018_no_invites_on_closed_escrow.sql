-- 0018_no_invites_on_closed_escrow.sql
--
-- Invite lifecycle (Anuraj, Sept 28, 2026): no new invite codes may be
-- created on a closed or cancelled escrow, for any role (buyer, seller,
-- TC). Belt and suspenders behind the app-level gate (the app hides
-- invite creation on closed/cancelled escrows and store.createInvite
-- throws): the server rejects the insert too, so direct API access
-- cannot mint invites for a dead escrow.
--
-- regenerate_invite inserts a fresh row as well, so it is covered by the
-- same trigger — regenerating a code on a closed/cancelled escrow fails
-- there too. That path is unreachable from the app (close/cancel revokes
-- all invites, so there is nothing to regenerate), but the database
-- stays consistent even if a client gets clever.
create or replace function enforce_no_invites_on_closed_escrow()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from escrows where id = new.escrow_id;
  if v_status in ('closed', 'cancelled') then
    raise exception 'cannot create invites for a % escrow', v_status;
  end if;
  return new;
end;
$$;

drop trigger if exists invites_no_closed_escrow on invites;
create trigger invites_no_closed_escrow
  before insert on invites
  for each row
  execute function enforce_no_invites_on_closed_escrow();
