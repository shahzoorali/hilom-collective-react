/**
 * Recreates the two forms currently hosted on the old WordPress site
 * (wp.hilomcollective.com) as native forms in this app, so they can be
 * retired from the backup site once linked here:
 *
 *   - Facilitator Intake Form  (was /facilitate-with-us-2/)
 *   - 2027 Retreat Waitlist    (was /2027-retreat-waitlist/)
 *
 *   HILOM_API_BASE=https://api.hilomcollective.com \
 *   HILOM_ADMIN_KEY=... npx tsx scripts/seed-intake-forms.ts
 *
 * Creates (or updates, if already present) two rows under Admin → Forms, and
 * two new CMS pages — /facilitate-with-us and /retreat-waitlist — each with a
 * short intro plus a `form` block pointing at the matching form. Both pages
 * are written as drafts only: open Admin → Pages, compare the preview, and
 * press Publish when ready. Nothing is linked from Services or Events yet —
 * that's a manual step once the pages look right.
 *
 * File-upload fields from the WordPress originals (photo, certification
 * document) are dropped: this app's form system doesn't support attachments.
 * The math CAPTCHA on the retreat form is dropped too — submissions already
 * go through the honeypot + rate limit in backend/src/handlers/forms.ts.
 *
 * Re-running is safe: forms and pages are matched and updated by slug rather
 * than duplicated.
 */
const API_BASE = process.env.HILOM_API_BASE ?? 'https://api.hilomcollective.com';
const ADMIN_KEY = process.env.HILOM_ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error('HILOM_ADMIN_KEY is not set. Read it from Secrets Manager: hilom/admin-api-key');
  process.exit(1);
}

interface FormFieldDef {
  name: string;
  label: string;
  type: 'text' | 'email' | 'textarea' | 'checkboxGroup' | 'select';
  required: boolean;
  options?: string[];
  help?: string;
  half?: boolean;
}

interface AdminForm {
  id: string;
  slug: string;
  name: string;
  fields: FormFieldDef[];
  submit_label: string;
  success_message: string;
}

interface AdminPage {
  id: string;
  slug: string;
  title: string;
}

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { 'x-admin-key': ADMIN_KEY!, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${res.status}: ${body.error ?? 'failed'}`);
  }
  return res.json() as Promise<T>;
}

async function upsertForm(
  slug: string,
  name: string,
  fields: FormFieldDef[],
  submit_label: string,
  success_message: string,
): Promise<AdminForm> {
  const { forms } = await api<{ forms: AdminForm[] }>('/admin/forms');
  const existing = forms.find((f) => f.slug === slug);

  const base = existing ?? (await api<{ form: AdminForm }>('/admin/forms', {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
  })).form;

  const { form } = await api<{ form: AdminForm }>(`/admin/forms/${base.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, fields, submit_label, success_message }),
  });

  console.log(`  form "${slug}" ${existing ? 'updated' : 'created'} (${fields.length} fields)`);
  return form;
}

async function upsertPage(slug: string, title: string, blocks: unknown[]): Promise<AdminPage> {
  const { pages } = await api<{ pages: AdminPage[] }>('/admin/pages');
  const existing = pages.find((p) => p.slug === slug);

  const page = existing ?? (await api<{ page: AdminPage }>('/admin/pages', {
    method: 'POST',
    body: JSON.stringify({ title, slug }),
  })).page;

  await api(`/admin/pages/${page.id}/draft`, { method: 'PUT', body: JSON.stringify({ blocks }) });
  console.log(`  page "${slug}" ${existing ? 'updated' : 'created'} — still a DRAFT, review before publishing`);
  return page;
}

let counter = 0;
const block = (type: string, props: Record<string, unknown>) => ({ id: `seed-${++counter}`, type, props });

const FACILITATOR_FIELDS: FormFieldDef[] = [
  { name: 'first_name', label: 'First Name', type: 'text', required: true, half: true },
  { name: 'last_name', label: 'Last Name', type: 'text', required: true, half: true },
  {
    name: 'contact_method',
    label: 'Preferred Method of Contact',
    type: 'select',
    required: true,
    options: ['Email', 'Phone', 'Social Media'],
  },
  { name: 'email', label: 'Your Email Address', type: 'email', required: true },
  { name: 'social_handle', label: 'Your Social Media Handle/Link', type: 'text', required: true },
  {
    name: 'about_work',
    label: 'Briefly describe your expertise, coaching practice, workshop, or program',
    type: 'textarea',
    required: true,
    help: 'Whatever you currently teach or facilitate.',
  },
  {
    name: 'experience_length',
    label: 'How long have you been doing this work?',
    type: 'select',
    required: true,
    options: ['Just starting out', 'Less than 1 year', '1–3 years', '3–5 years', '5+ years'],
  },
  {
    name: 'support_needed',
    label: 'What kind of support do you need?',
    type: 'checkboxGroup',
    required: true,
    help: "Choose whichever applies. You're welcome to select more than one.",
    options: [
      'Putting my courses/programs online',
      'Curating my program',
      'Planning events/workshops',
    ],
  },
  {
    name: 'program_status',
    label: 'What do you have for your programs right now?',
    type: 'checkboxGroup',
    required: true,
    help: "Choose whichever applies. You're welcome to select more than one.",
    options: [
      'I already have a program — I just need it online',
      "I have an idea but haven't built it out yet",
      "I'm currently running events/workshops and want help scaling",
      "I'm just exploring what's possible",
    ],
  },
  {
    name: 'website',
    label: 'Website or Portfolio Link',
    type: 'text',
    required: false,
    help: 'Optional — include a link to your certification, affiliation, or work samples if you have one.',
  },
  {
    name: 'notes',
    label: "Is there anything else you'd like us to know?",
    type: 'textarea',
    required: false,
    help: 'Goals, timeline, questions — anything that helps us understand how to support you best.',
  },
  {
    name: 'heard_from',
    label: 'How did you hear about Hilom Collective?',
    type: 'select',
    required: true,
    options: ['Social Media (Instagram/Facebook/TikTok)', 'Referred by a friend/colleague', 'Newsletter', 'Other'],
  },
  {
    name: 'consent',
    label: 'Consent',
    type: 'checkboxGroup',
    required: true,
    options: ['I agree to the privacy policy.'],
  },
];

const RETREAT_FIELDS: FormFieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true, half: true },
  { name: 'email', label: 'Email Address', type: 'email', required: true, half: true },
  {
    name: 'interested_in',
    label: "I'm interested in:",
    type: 'checkboxGroup',
    required: true,
    options: ['January 2027 Retreat', 'April 2027 Retreat', 'Both Retreats', 'Other 2027 Retreats'],
  },
  {
    name: 'accommodation',
    label: 'Preferred Accommodation:',
    type: 'checkboxGroup',
    required: true,
    options: [
      'Shared Room (Roommate Assigned)',
      'Villa Type (Solo Bed, Shared Villa)',
      'Private Single Room',
      'Any/No Preference',
    ],
  },
  { name: 'message', label: 'Message', type: 'textarea', required: false },
];

async function main(): Promise<void> {
  console.log('forms:');
  await upsertForm(
    'facilitator-intake',
    'Facilitator Intake Form',
    FACILITATOR_FIELDS,
    'Submit',
    "Thank you for your interest in growing with Hilom Collective! We'll review your info and follow up with next steps soon.",
  );
  await upsertForm(
    'retreat-waitlist-2027',
    '2027 Retreat Waitlist',
    RETREAT_FIELDS,
    'Join the Waitlist',
    "You're on the list! We'll be in touch with early access and pricing as soon as registration opens.",
  );

  console.log('\npages:');
  await upsertPage('facilitate-with-us', 'Facilitate With Us', [
    block('hero', {
      heading: 'Facilitate With Us',
      lede: [
        'We help facilitators like you put your programs online, curate them for the right audience, ' +
          "and plan events and workshops so the people meant to be changed by your work can actually find you. " +
          "Fill out this short form and we'll follow up with next steps based on what you need.",
      ],
    }),
    block('form', { formSlug: 'facilitator-intake' }),
  ]);

  await upsertPage('retreat-waitlist', '2027 Retreat Waitlist', [
    block('hero', {
      heading: '2027 Retreats Waitlist',
      lede: [
        "We're bringing more Hilom Collective retreats to life in 2027 — immersive experiences designed " +
          'to help you reconnect, reset, and grow alongside a community that gets it.',
        'Spots are limited, so join the waitlist below to get early access, exclusive pricing, and first ' +
          'dibs when registration opens.',
      ],
    }),
    block('form', { formSlug: 'retreat-waitlist-2027' }),
  ]);

  console.log(
    '\nDone. Open /admin → Pages, review "Facilitate With Us" and "2027 Retreat Waitlist", and press ' +
      'Publish on each when ready. Once published they\'ll be live at /facilitate-with-us and ' +
      '/retreat-waitlist — link the Community Partnerships and Events sections to those instead of the ' +
      'wp.hilomcollective.com backup pages.',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
