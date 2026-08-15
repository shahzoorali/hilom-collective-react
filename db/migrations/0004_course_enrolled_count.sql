-- Phase 5 addendum — live enrolled-student count.
--
-- Deliberately synced from Moodle (core_enrol_get_enrolled_users) rather than
-- derived from our own orders table: Moodle enrollment includes test/manual
-- enrollments made directly in Moodle admin, not just buyers who purchased
-- through our checkout, and the product page should match what course staff
-- see in Moodle.
alter table public.courses
  add column if not exists enrolled_count integer;
