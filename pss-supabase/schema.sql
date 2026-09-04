-- ============================================================================
-- FlyTAP PSS (demo) — Supabase Postgres schema
-- ----------------------------------------------------------------------------
-- The PSS is the external system that CREATES third-party bookings, transactions
-- and loyalty accrual. On INSERT into pss_bookings, the Edge Function in
-- ./edge-function signs the row (HMAC-SHA256) and POSTs it to the FlyTAP backend
-- at /api/pss/ingest — which lands it in SQLite (transaction record of truth) and
-- streams it to Adobe RT-CDP (identity stitching → segmentation → offers).
--
-- loyalty_id is the join key: it must equal a FlyTAP users.member_no
-- (e.g. PT-884512 = Daniel, PT-552037 = Sofia, DE-100294 = Lars) so CDP stitches
-- the PSS fragment onto the known web/loyalty profile.
-- ============================================================================

create table if not exists pss_members (
  loyalty_id   text primary key,                 -- == FlyTAP users.member_no
  email        text,
  full_name    text,
  tier         text,
  miles        integer default 0,
  created_at   timestamptz default now()
);

create table if not exists pss_bookings (
  id           bigint generated always as identity primary key,
  pss_ref      text unique not null default ('PSS-' || (extract(epoch from now())*1000)::bigint),
  event_type   text not null default 'booked',   -- booked | ancillary | checkin | cancel
  pnr          text,
  loyalty_id   text references pss_members(loyalty_id),
  email        text,
  full_name    text,
  origin       text,
  destination  text,
  travel_date  date,
  flight_no    text,
  seat         text,
  cabin        text default 'Economy',
  amount       numeric default 0,
  currency     text default 'EUR',
  miles_earned integer default 0,
  ancillaries  jsonb default '[]'::jsonb,         -- [{ "name": "Lounge access" }, ...]
  channel      text default 'PSS · Partner site',
  created_at   timestamptz default now()
);

create table if not exists pss_transactions (
  id           bigint generated always as identity primary key,
  pss_ref      text not null,
  booking_pnr  text,
  loyalty_id   text,
  amount       numeric not null,
  currency     text default 'EUR',
  category     text,                              -- flight | hotel | car | lounge | insurance
  created_at   timestamptz default now()
);

-- Seed the three demo members so PSS bookings stitch onto the live FlyTAP profiles.
insert into pss_members (loyalty_id, email, full_name, tier) values
  ('PT-884512', 'daniel.ferreira@consultmail.pt', 'Daniel Ferreira', 'Gold'),
  ('PT-552037', 'sofia.marques@familymail.pt',    'Sofia Marques',   'Silver'),
  ('DE-100294', 'lars.andersen@globalconsult.de', 'Lars Andersen',   'Platinum')
on conflict (loyalty_id) do nothing;

-- Example: a third-party booking for Daniel (triggers the high-value offer rule).
-- insert into pss_bookings (event_type, pnr, loyalty_id, email, origin, destination,
--   travel_date, flight_no, seat, amount, miles_earned, ancillaries, channel)
-- values ('booked','PSSX1A2','PT-884512','daniel.ferreira@consultmail.pt','OPO','LIS',
--   current_date + 14, 'TP1927', '4C', 540, 1200,
--   '[{"name":"Lounge access"},{"name":"Hotel — partner"}]'::jsonb, 'PSS · Partner site');
