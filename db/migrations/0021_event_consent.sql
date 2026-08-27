-- Per-event medical disclaimer and liability/participation consent.
--
-- The registration form (frontend/src/pages/EventRegister.tsx) needs two
-- pieces of admin-written copy that a registrant must actively acknowledge
-- before checkout:
--
--   * medical_disclaimer_html — the "we are not liable for undisclosed
--     medical or psychological conditions" notice. Especially relevant for
--     retreats with psychological/emotional content.
--   * liability_consent_html  — the event participation / assumption-of-risk
--     consent (release of liability, photography, house rules, etc.).
--
-- Both are optional. An event with either column null simply does not show
-- that block or its checkbox, so every event that predates this column keeps
-- working unchanged. Stored as sanitized rich text, the same way terms_html
-- (migration 0016) is.
alter table public.events add column if not exists medical_disclaimer_html text;
alter table public.events add column if not exists liability_consent_html text;
