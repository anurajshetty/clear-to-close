-- 0043_app_config.sql
--
-- Public app configuration (Oct 20, 2026): a small key/value table for
-- values that are PUBLIC by design and must be changeable without an
-- app release. First key: 'client_app_link' — the link invite shares
-- send clients to. The value ALWAYS points at a first-party link we
-- control (never a raw store URL — one shared link must serve iOS,
-- Android, and desktop): today it opens the web app; at store launch
-- the page behind it gains per-platform routing (iPhone -> App Store,
-- Android -> Play Store, desktop -> web app) and the config value may
-- not need to change at all.
--
-- This is deliberately NOT push_config: push_config holds sensitive
-- values (the push kill switch, the function URL, and the vault-stored
-- trigger secret's companions) and is service-role-only. app_config is
-- the public sibling — every value in it must be safe for anyone to
-- read, because anyone can.
--
-- Posture (auditor-reviewed pattern): RLS enabled; SELECT for anon +
-- authenticated (the share flow runs before/without a session too);
-- NO insert/update/delete policies and NO write grants for any client
-- role — writes happen only via the dashboard / service role. The app
-- additionally validates the value client-side (https URL or it is
-- ignored for the built-in fallback), so even a bad dashboard edit
-- cannot push clients to a non-https destination.

create table if not exists app_config (
  key text primary key,
  value text not null
);

insert into app_config (key, value)
values ('client_app_link', 'https://anurajshetty.github.io/clear-to-close/redeem')
on conflict (key) do nothing;

alter table app_config enable row level security;

drop policy if exists app_config_select_public on app_config;
create policy app_config_select_public on app_config
  for select to anon, authenticated
  using (true);

revoke all on app_config from anon, authenticated;
grant select on app_config to anon, authenticated;
