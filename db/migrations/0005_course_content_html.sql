-- Phase 5 addendum — "Learner Guide" content synced from course content.
--
-- Some courses author their public-facing intro text directly on the course
-- page (as Label activities in a section) rather than in the Course summary
-- setting. `summary` stays the settings field; `content_html` holds the
-- concatenated Label activity HTML from core_course_get_contents. The
-- frontend prefers content_html when present, falling back to summary.
alter table public.courses
  add column if not exists content_html text;
