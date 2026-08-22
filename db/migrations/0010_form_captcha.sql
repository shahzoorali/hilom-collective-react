-- Per-form reCAPTCHA toggle, editable in Admin -> Forms.
--
-- Defaults to true: every form built after this migration is protected
-- unless an admin deliberately opts it out, rather than needing an admin to
-- remember to turn protection on for each new form.
alter table public.forms
  add column if not exists requires_captcha boolean not null default true;

comment on column public.forms.requires_captcha is
  'Whether /forms/{slug}/submissions requires a verified reCAPTCHA token. Toggled in Admin -> Forms.';
