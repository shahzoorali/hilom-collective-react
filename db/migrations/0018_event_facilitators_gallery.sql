-- Facilitator bios and a photo gallery for events.
--
-- Both nullable-by-default JSONB columns, same shape as
-- events.registrant_fields (0016) and for the same reason: a facilitator
-- roster and a set of venue photos are per-event lists of structured records,
-- and there is no second table's worth of relational structure underneath
-- them worth a join for. Applies to any event, not only ticketed ones —
-- a listing-only workshop has a facilitator too — so these live on the base
-- table rather than gated behind ticketing_enabled.
--
-- Photos specifically need a real column because sanitizeRichText
-- (backend/src/lib/sanitize.ts) does not allow <img> in the free-text
-- description field, deliberately: layout comes from typed fields, not from
-- pasted markup, the same reasoning 0006_cms.sql's block model uses. A
-- facilitator photo or a venue shot is exactly the kind of image that needed
-- a real field instead.

alter table public.events
  add column if not exists facilitators jsonb not null default '[]'::jsonb,
  add column if not exists gallery      jsonb not null default '[]'::jsonb;

comment on column public.events.facilitators is
  'Array of {name, title, bio, photo_url, photo_alt}. Validated and sanitized in backend/src/lib/cms-events.ts.';
comment on column public.events.gallery is
  'Array of {url, alt}. Validated in backend/src/lib/cms-events.ts.';
