-- Phase 3 — seed products.
--
-- PRICES ARE PLACEHOLDERS. Nothing here has been confirmed against real Hilom
-- pricing — set the real values before Phase 6 test purchases mean anything.
--
-- Only Moodle courses 10, 15, 16, 17 and 18 are real. Courses 3 and 6 are hidden
-- and not sellable; course 1 is the Moodle site-level pseudo-course.
--
-- Course 17 (EI101_BUNDLE1, "The Breakthrough Bundle") is a bundle: buying it
-- enrols the buyer into courses 10, 15 and 16 — NOT into course 17 itself.
--
-- Idempotent: re-running updates the existing rows rather than duplicating them.

insert into public.products (name, slug, description, price_centavos, is_active)
values
  ('Module 1: Understand Yourself', 'module-1-understand-yourself',
   'The first module of How To Master Your Emotions.', 149900, true),
  ('Module 2: Build Resilience', 'module-2-build-resilience',
   'The second module of How To Master Your Emotions.', 149900, true),
  ('Module 3: Transform Your Life', 'module-3-transform-your-life',
   'The third module of How To Master Your Emotions.', 149900, true),
  ('The Breakthrough Bundle', 'breakthrough-bundle',
   'All three modules of How To Master Your Emotions at a bundle price.', 349900, true),
  ('How to Cook a Burger', 'how-to-cook-a-burger',
   'Test product used for end-to-end checkout and enrollment testing.', 9900, true)
on conflict (slug) do update set
  name           = excluded.name,
  description    = excluded.description,
  price_centavos = excluded.price_centavos,
  is_active      = excluded.is_active;

-- Product -> Moodle course mapping. The bundle is the only row set with more
-- than one course, and it is what makes bundle fulfillment work without any
-- bundle-specific code in the enrollment path.
insert into public.product_courses (product_id, moodle_course_id)
select p.id, c.moodle_course_id
from public.products p
join (values
  ('module-1-understand-yourself', 10),
  ('module-2-build-resilience',    15),
  ('module-3-transform-your-life', 16),
  ('breakthrough-bundle',          10),
  ('breakthrough-bundle',          15),
  ('breakthrough-bundle',          16),
  ('how-to-cook-a-burger',         18)
) as c(slug, moodle_course_id) on c.slug = p.slug
on conflict (product_id, moodle_course_id) do nothing;
