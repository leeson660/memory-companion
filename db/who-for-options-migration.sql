-- Migration: allow the "As a gift for someone else" option on the waitlist.
-- Run in the Supabase SQL editor BEFORE deploying the matching api/join-waitlist.js.
-- Only the allowed values of the who_for check change. No columns are added or removed.
-- 'both' stays allowed so older rows still satisfy the constraint.

alter table public.waitlist
  drop constraint if exists waitlist_who_for_check;

alter table public.waitlist
  add constraint waitlist_who_for_check check (
    who_for is null or who_for in ('me', 'parent_or_grandparent', 'gift', 'both')
  );

-- Sanity check: should return 0 rows.
-- select count(*) from public.waitlist
-- where who_for is not null and who_for not in ('me', 'parent_or_grandparent', 'gift', 'both');
