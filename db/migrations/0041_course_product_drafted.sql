-- Auto-draft-on-sync (see admin.syncCourses) keyed "already handled?" off the
-- presence of a product_courses link. Deleting an unwanted auto-drafted product
-- drops that link, so the next sync recreated the ₱0 hidden draft — deleted
-- courses kept coming back "to default".
--
-- This column records that we have already offered a draft for a course, once.
-- The draft step stamps it after creating the draft and skips any course that
-- already carries it, so a deliberately deleted draft stays deleted. Clearing
-- this value (manually) re-arms the auto-draft for that course.
alter table public.courses
  add column if not exists product_drafted_at timestamptz;

-- Backfill: any course already linked to a product has plainly been drafted for
-- already, so lock it in rather than waiting for the next sync to stamp it.
update public.courses c
   set product_drafted_at = now()
 where product_drafted_at is null
   and exists (
     select 1 from public.product_courses pc
      where pc.moodle_course_id = c.moodle_course_id
   );
