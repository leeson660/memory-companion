-- Migration: add "who is this for" and gift reservations to the waitlist table.
-- Run in the Supabase SQL editor BEFORE deploying the matching api/join-waitlist.js.
-- Review first: the unique constraint name below is a guess at the default name.
-- Check it under Table Editor > waitlist > Constraints and adjust if different.

-- 1. New columns
alter table public.waitlist
  add column if not exists type text not null default 'waitlist',
  add column if not exists who_for text,
  add column if not exists recipient_first_name text,
  add column if not exists relationship text;

-- 2. Allowed values (keeps bad data out even if the API changes)
alter table public.waitlist
  drop constraint if exists waitlist_type_check,
  add constraint waitlist_type_check check (type in ('waitlist', 'gift'));

alter table public.waitlist
  drop constraint if exists waitlist_who_for_check,
  add constraint waitlist_who_for_check check (
    who_for is null or who_for in ('me', 'parent_or_grandparent', 'both')
  );

alter table public.waitlist
  drop constraint if exists waitlist_relationship_check,
  add constraint waitlist_relationship_check check (
    relationship is null or relationship in ('Mum', 'Dad', 'Nan', 'Grandad', 'Other')
  );

-- 3. Email uniqueness applies to waitlist sign-ups only.
--    A giver may already be on the waitlist, and may reserve more than one gift.
--    Replace the existing unique-on-email constraint with a partial unique index.
alter table public.waitlist drop constraint if exists waitlist_email_key;

create unique index if not exists waitlist_email_waitlist_unique
  on public.waitlist (email)
  where type = 'waitlist';

-- 4. Every existing row came from the waitlist form, so the default covers them.
--    Sanity check: should return 0 rows once the migration is applied.
-- select count(*) from public.waitlist where type not in ('waitlist', 'gift');
