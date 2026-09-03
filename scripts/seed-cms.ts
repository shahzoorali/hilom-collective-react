/**
 * Fills the seeded CMS pages with the copy the site shows today.
 *
 *   HILOM_API_BASE=https://api.hilomcollective.com \
 *   HILOM_ADMIN_KEY=... npx tsx scripts/seed-cms.ts
 *
 * Run db/seed/0002_seed_cms.sql first — that creates the page rows and the
 * menus. This script uploads the bundled page images to the media bucket and
 * then writes each page's DRAFT blocks through the admin API.
 *
 * It publishes nothing. Every page stays a draft until someone opens the admin,
 * compares the preview against the live page, and presses Publish — which is
 * also the moment CmsOrFallback stops serving the hardcoded React page.
 *
 * Re-running it overwrites the drafts and re-uploads the images, so it is safe
 * to run again after editing the copy below, but it will create duplicate media
 * rows (S3 keys are uuid-prefixed). Pass --skip-media to reuse whatever is
 * already in the library by filename instead.
 *
 * Pass one or more page slugs to seed only those, leaving every other page's
 * draft untouched — `npx tsx scripts/seed-cms.ts privacy-policy`. Without a
 * slug it seeds all of them, including the two sample events. `events` is only
 * seeded when named explicitly or when no filter is given.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.HILOM_API_BASE ?? 'https://api.hilomcollective.com';
const ADMIN_KEY = process.env.HILOM_ADMIN_KEY;
const SKIP_MEDIA = process.argv.includes('--skip-media');
/** Positional args = the slugs to seed. Empty means "all of them". */
const ONLY_SLUGS = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--')));

if (!ADMIN_KEY) {
  console.error('HILOM_ADMIN_KEY is not set. Read it from Secrets Manager: hilom/admin-api-key');
  process.exit(1);
}

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src', 'assets');

interface MediaRef {
  id: string;
  url: string;
  alt: string;
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

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Uploads one bundled asset and returns the block-ready media reference. */
async function upload(relativePath: string, alt: string): Promise<MediaRef> {
  const filename = path.basename(relativePath);
  const contentType = CONTENT_TYPES[path.extname(filename).toLowerCase()];
  if (!contentType) throw new Error(`No content type known for ${filename}`);

  const bytes = await readFile(path.join(ASSETS, relativePath));

  const { uploadUrl, key } = await api<{ uploadUrl: string; key: string }>('/admin/media/upload-url', {
    method: 'POST',
    body: JSON.stringify({ filename, contentType, bytes: bytes.length }),
  });

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!put.ok) throw new Error(`Upload of ${filename} failed (${put.status})`);

  const { media } = await api<{ media: { id: string; url: string } }>('/admin/media', {
    method: 'POST',
    body: JSON.stringify({ key, filename, alt }),
  });

  console.log(`  uploaded ${filename}`);
  return { id: media.id, url: media.url, alt };
}

async function reuse(relativePath: string): Promise<MediaRef | undefined> {
  const stem = path.basename(relativePath, path.extname(relativePath));
  const { media } = await api<{ media: { id: string; url: string; filename: string; alt: string | null }[] }>(
    `/admin/media?q=${encodeURIComponent(stem)}`,
  );
  const found = media[0];
  return found ? { id: found.id, url: found.url, alt: found.alt ?? '' } : undefined;
}

const getMedia = async (relativePath: string, alt: string): Promise<MediaRef | undefined> =>
  SKIP_MEDIA ? reuse(relativePath) : upload(relativePath, alt);

let counter = 0;
const block = (type: string, props: Record<string, unknown>) => ({
  id: `seed-${++counter}`,
  type,
  props,
});

/** The "Join The Movement" band that closes every page on the live site. */
const joinTheMovement = (
  variant: 'btn-accent' | 'btn-primary',
  href: string,
  label: string,
  background?: string,
) =>
  block('ctaBanner', {
    badge: 'Join The Movement',
    heading: "There's a place for you here.",
    lede:
      "Whether you're seeking support, want to bring Hilom to your community, or believe in this work, " +
      "we'd love to hear from you.",
    cta: { label, href, variant },
    ...(background ? { background } : {}),
  });

async function buildHome() {
  return [
    block('hero', {
      heading: 'Paghilom. Para sa lahat.',
      lede: [
        'A wellness platform rooted in Filipino life.',
        'Hilom Collective is a holistic wellness platform that makes healing simple, accessible, and rooted in everyday Filipino life.',
      ],
      emphasizeFirstLede: true,
      cta: { label: 'Join Our Community', href: '/community', variant: 'btn-accent' },
    }),
    block('fullWidthImage', { image: await getMedia('home/hilom-hero-image-1280x720.png', '') }),
    block('statGrid', {
      badge: 'The Reality',
      badgeColor: 'ochre',
      heading: "Most Filipinos need support. But often, they don't know where to find it.",
      items: [
        { value: '35.9%', caption: 'of Filipinos avoid mental health support due to stigma or shame' },
        { value: '40%', caption: "cite high cost as the #1 reason they don't seek wellness services" },
        { value: '80%', caption: 'of Filipinos with mental health challenges never seek formal help' },
      ],
    }),
    block('split', {
      badge: 'What We Do',
      heading: 'We meet you where you are.',
      html:
        '<p>Through content, courses, and community, Hilom gives everyday Filipinos the tools to rest, ' +
        'reflect, and reconnect. On your phone, in your neighborhood, at your own pace.</p>',
      cta: { label: 'Learn More About Us', href: '/about', variant: 'btn-primary' },
      image: await getMedia('home/hilom-whatwedo.png', ''),
      background: 'cream',
    }),
    block('cardGrid', {
      background: 'cream',
      items: [
        {
          title: 'Learn',
          body: 'Bite-sized wellness content on social media. Honest, practical, and in the language we actually speak.',
        },
        {
          title: 'Grow',
          body: 'Self-paced courses on emotional literacy, journaling, and calm practices. Affordable for everyone.',
        },
        {
          title: 'Connect',
          body: 'Hilom Circles and Ginhawa Kits bringing community healing into homes, schools, and barangays.',
        },
      ],
    }),
    block('split', {
      reverse: true,
      badge: 'What We Do',
      heading: 'Everyone deserves care.',
      cta: { label: 'Our Services', href: '/services', variant: 'btn-primary' },
      image: await getMedia('home/hilom-whoishilomfor.png', ''),
    }),
    block('productGrid', {
      heading: 'Grow at your own pace',
      subheading: 'Buy once, keep access for good — no subscription, no expiry.',
      background: 'cream',
    }),
    joinTheMovement('btn-accent', '/community', 'Join Our Community'),
  ];
}

async function buildAbout() {
  return [
    block('split', {
      narrow: true,
      headingLevel: 'h1',
      heading: 'A wellness platform for everyday Filipinos',
      html:
        '<p>Hilom Collective is a living space for healing, a <em>pamana</em> (inheritance) that grows with every act of care.</p>' +
        '<p>We are an accessible, people-first holistic health and wellness platform offering pathways to health that are simple, inclusive, and rooted in everyday life.</p>' +
        '<p>We believe that when wellness is made sincere and grounded, it becomes something we can learn, live, and pass on from this generation to the next.</p>',
      image: await getMedia('pages/about-hero.jpg', ''),
    }),
    block('panelGrid', {
      background: 'cream',
      items: [
        {
          badge: 'Our Mission',
          body: 'To make holistic health and wellness a lived, everyday practice for Filipinos; simple, sincere, and sustainable enough to be passed on across generations.',
        },
        {
          badge: 'Our Vision',
          body: 'To become a nationally recognized wellness platform known for accessibility, cultural integrity, and community-rooted healing.',
        },
      ],
    }),
    block('cardGrid', {
      heading: 'In 5 years, Hilom Collective will be:',
      items: [
        { body: 'A trusted digital and in-person space for Filipino-centered healing' },
        {
          body: 'A provider of Ginhawa (Relief) Kits, Hilom (Healing) Journals, and Pahinga (Rest) Sessions in homes, schools, and barangays',
        },
        { body: 'The go-to platform for local wellness leaders to connect, share, and co-heal' },
        { body: 'A safe space for intergenerational conversations around rest, resilience, and renewal' },
      ],
    }),
    block('richText', {
      background: 'cream',
      html:
        '<h2>Why do we want to create this brand?</h2>' +
        '<p>To make holistic wellness a lasting part of Filipino life, passed from one generation to the next and embraced by all.</p>' +
        '<p>To offer tools, spaces, and rituals that help people pause, reconnect, and heal together.</p>' +
        '<h2>Who will benefit the most?</h2>' +
        '<p>Filipinos who are underserved by mainstream wellness; those seeking breathing room, reconnection, emotional clarity, and small, doable steps toward healing for themselves and the ones they love.</p>',
    }),
    joinTheMovement('btn-accent', '/community', 'Join Our Community'),
  ];
}

async function buildServices() {
  return [
    block('hero', {
      badge: 'Our Services',
      badgeColor: 'ochre',
      heading: 'Healing That Meets You Where You Are',
      lede: [
        'At Hilom Collective, we believe wellness should be accessible, culturally rooted, and woven into everyday life. Our services are designed to create meaningful impact at every stage of the journey, from individual reflection to community healing.',
      ],
    }),
    block('fullWidthImage', { image: await getMedia('pages/services-hero.jpg', '') }),
    block('imageCardGrid', {
      variant: 'service',
      items: [
        {
          image: await getMedia('pages/services-corporate.jpg', ''),
          title: 'Hilom Learning',
          subtitle: 'Online wellness education for individuals and teams.',
          desc: 'Self-paced courses designed to build emotional intelligence, resilience, and practical wellbeing skills.',
          cta: { label: 'Explore Courses', href: '/courses', variant: 'btn-primary' },
        },
        {
          image: await getMedia('pages/services-community.png', ''),
          title: 'Corporate & Academe Learning',
          subtitle: 'Evidence-informed learning experiences for workplaces and educational institutions.',
          desc: 'Workshops, leadership development, student wellbeing, faculty training, and team experiences.',
          cta: { label: 'Request a Proposal', href: '/community', variant: 'btn-primary' },
        },
        {
          image: await getMedia('pages/services-learning.png', ''),
          title: 'Community Partnerships',
          subtitle: 'Collaborate with us to make wellness more accessible.',
          desc: 'We work with LGUs, NGOs, foundations, and community organizations to co-create meaningful wellness initiatives.',
          cta: { label: 'Partner With Us', href: '/community', variant: 'btn-primary' },
        },
        {
          image: await getMedia('pages/services-kits.jpg', ''),
          title: 'Ginhawa Kits',
          subtitle: 'Thoughtfully designed wellness tools that support learning beyond the workshop.',
          desc: 'Reflection cards, activity kits, and resources that help people practice wellness in everyday life.',
          cta: { label: 'Shop Ginhawa Kits', href: '/community', variant: 'btn-primary' },
        },
      ],
    }),
    joinTheMovement('btn-accent', '/community', 'Join Our Community', 'cream'),
  ];
}

async function buildEvents() {
  return [
    block('hero', { heading: 'Upcoming Events' }),
    // Individual events are no longer authored as block items — they are
    // managed rows (Admin → Events) that this block renders live, sorted into
    // Upcoming and Past. See seedEvents() below for the two events that used
    // to be hand-authored here.
    block('eventGrid', {}),
    joinTheMovement('btn-accent', '/community', 'Join Our Community', 'cream'),
  ];
}

/**
 * The two events that used to be authored directly into the Events page's
 * blocks become real rows in the `events` table instead — this is what makes
 * the new eventGrid block have something to show. Both are already in the
 * past relative to today, so seeding them is also the easiest way to prove
 * the Past Events split actually works on real data.
 *
 * Published immediately (unlike page blocks, which stay draft until
 * reviewed): these rows are inert until the Events page's own draft — which
 * now points at the eventGrid block — is itself published.
 */
async function seedEvents(): Promise<void> {
  const image1 = await getMedia('pages/event-1.png', '');
  const image2 = await getMedia('pages/event-2.jpeg', '');

  const events = [
    {
      title: 'The Overloaded Mom Reset',
      subtitle: '(and How Partners Can Support) with St. Raphael Health Hub',
      description:
        '<p>For moms who are always caring for everyone else, and rarely for themselves. This online workshop offers a space to pause, understand what your body and mind are going through, and learn practical, doable ways to feel supported, with partners invited to join in too.</p>',
      image: image1,
      location: 'Via Zoom',
      starts_at: '2026-07-22T15:00:00+08:00',
      ends_at: '2026-07-22T17:00:00+08:00',
      status: 'published',
    },
    {
      title: 'Sacred Authority: Becoming the Author of Your Life',
      subtitle: 'A virtual session by Maude Labs, co-presented with The Authenticity Institute',
      description:
        '<p>A 90-minute virtual session for founders, leaders, and purpose-driven individuals ready to reclaim their story and lead from authenticity, not expectation. Led by Dr. Katrina Gisbert-Tay.</p>',
      image: image2,
      location: 'Virtual',
      starts_at: '2026-07-22T20:00:00+08:00',
      ends_at: '2026-07-22T21:30:00+08:00',
      note: 'Use code: HILOM for 10% off',
      status: 'published',
    },
  ];

  // Idempotent on title, unlike the page draft writes above (which simply
  // overwrite): events are individual rows, not one blob to replace, so
  // re-running this script must not create duplicates every time.
  const { events: existing } = await api<{ events: { title: string }[] }>('/admin/events');
  const existingTitles = new Set(existing.map((e) => e.title));

  for (const eventInput of events) {
    if (existingTitles.has(eventInput.title)) {
      console.log(`  skipped (already exists): ${eventInput.title}`);
      continue;
    }
    await api('/admin/events', { method: 'POST', body: JSON.stringify(eventInput) });
    console.log(`  event: ${eventInput.title}`);
  }
}

function buildCommunity() {
  return [
    block('hero', {
      heading: 'Join Our Community',
      lede: [
        'Be the first to hear about upcoming courses, workshops, wellness gatherings, and new offerings from Hilom Collective.',
      ],
    }),
    // The form itself is fixed in code and still emails the team via SES; only
    // the copy around it is editable.
    block('communityForm', {}),
    joinTheMovement('btn-primary', '/courses', 'Browse Courses', 'cream'),
  ];
}

/**
 * The Privacy Policy, one `richText` block per numbered section so an admin can
 * edit or reorder a single clause without scrolling through the whole document.
 * Must stay in sync with frontend/src/pages/PrivacyPolicy.tsx, which is what
 * visitors see until this page is published.
 */
function buildPrivacyPolicy(): unknown[] {
  const section = (html: string, background?: string) =>
    block('richText', background ? { html, background } : { html });

  const list = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

  return [
    section(
      '<h1>Privacy Policy</h1>' +
        '<p>Hilom Collective Website &amp; Learning Management System (LMS)</p>' +
        '<p><strong>Effective Date:</strong> May 19, 2026<br /><strong>Last Updated:</strong> May 19, 2026</p>' +
        '<p>Welcome to <a href="https://hilomcollective.com">Hilom Collective</a> (“Hilom Collective,” “we,” “our,” or “us”).</p>' +
        '<p>Hilom Collective is committed to protecting your privacy and ensuring transparency in how we collect, use, store, and safeguard your personal information across our website, Learning Management System (LMS), community platforms, wellness programs, events, and digital services.</p>' +
        '<p>By accessing or using our website, LMS, or related services, you agree to the terms outlined in this Privacy Policy.</p>',
    ),
    section(
      '<h2>1. Information We Collect</h2>' +
        '<p>We may collect the following types of information:</p>' +
        '<h3>A. Personal Information</h3>' +
        '<p>Information you voluntarily provide, including:</p>' +
        list(
          'Full name',
          'Email address',
          'Mobile number',
          'Date of birth',
          'Gender or pronouns (optional)',
          'Billing or payment details',
          'Wellness interests and preferences',
          'LMS account credentials',
          'Uploaded assignments, reflections, or learning outputs',
          'Event registration details',
          'Community participation information',
        ) +
        '<h3>B. Automatically Collected Information</h3>' +
        '<p>When you use our website or LMS, we may automatically collect:</p>' +
        list(
          'IP address',
          'Browser type',
          'Device information',
          'Operating system',
          'Website usage behavior',
          'Login timestamps',
          'Pages visited',
          'Cookies and analytics data',
        ) +
        '<h3>C. Sensitive Wellness Information</h3>' +
        '<p>Some courses, coaching services, or wellness assessments may involve personal reflections or wellness-related information.</p>' +
        '<p>Hilom Collective does <strong>not</strong> provide medical diagnosis, psychiatric treatment, or emergency healthcare services. Any wellness information voluntarily shared by users will be treated with reasonable confidentiality and used solely for educational, coaching, or community-support purposes.</p>' +
        '<p>We encourage users not to share highly sensitive medical or personal information unless necessary.</p>',
      'cream',
    ),
    section(
      '<h2>2. How We Use Your Information</h2>' +
        '<p>We may use your information to:</p>' +
        list(
          'Create and manage your LMS account',
          'Deliver courses, programs, and wellness content',
          'Personalize your learning experience',
          'Process payments and registrations',
          'Communicate updates, reminders, and announcements',
          'Improve website functionality and user experience',
          'Analyze engagement and learning outcomes',
          'Provide customer support',
          'Ensure platform security and fraud prevention',
          'Comply with legal obligations',
        ),
    ),
    section(
      '<h2>3. Cookies &amp; Analytics</h2>' +
        '<p>Our website and LMS may use cookies, analytics tools, and similar technologies to improve user experience and understand platform performance.</p>' +
        '<p>These tools may help us:</p>' +
        list(
          'Remember user preferences',
          'Track website traffic',
          'Measure course engagement',
          'Improve accessibility and usability',
        ) +
        '<p>Users may disable cookies through their browser settings; however, some features may not function properly.</p>',
      'cream',
    ),
    section(
      '<h2>4. Sharing of Information</h2>' +
        '<p>Hilom Collective does not sell personal data.</p>' +
        '<p>We may share information only with:</p>' +
        list(
          'Trusted service providers and technology partners',
          'Payment processors',
          'LMS hosting providers',
          'Email and communication platforms',
          'Legal authorities when required by law',
          'Business partners involved in program delivery (with appropriate safeguards)',
        ) +
        '<p>All third-party providers are expected to maintain reasonable security and confidentiality standards.</p>',
    ),
    section(
      '<h2>5. Data Retention</h2>' +
        '<p>We retain personal information only for as long as necessary to:</p>' +
        list(
          'Provide our services',
          'Maintain educational records',
          'Comply with legal obligations',
          'Resolve disputes',
          'Enforce agreements',
        ) +
        '<p>Users may request deletion of their account and personal information, subject to applicable legal and operational requirements.</p>',
      'cream',
    ),
    section(
      '<h2>6. Data Security</h2>' +
        '<p>Hilom Collective implements reasonable administrative, technical, and organizational measures to protect user information from unauthorized access, disclosure, misuse, or loss.</p>' +
        '<p>However, no online platform or transmission method can guarantee absolute security.</p>' +
        '<p>Users are responsible for maintaining the confidentiality of their account credentials.</p>',
    ),
    section(
      '<h2>7. User Rights</h2>' +
        '<p>Depending on applicable laws, users may have the right to:</p>' +
        list(
          'Access their personal information',
          'Request correction of inaccurate information',
          'Request deletion of personal data',
          'Withdraw consent',
          'Object to certain forms of processing',
          'Request a copy of stored data',
        ) +
        '<p>Requests may be submitted through our official contact channels.</p>',
      'cream',
    ),
    section(
      '<h2>8. Children’s Privacy</h2>' +
        '<p>Hilom Collective does not knowingly collect personal information from children under the age required by applicable law without parental or guardian consent.</p>' +
        '<p>If we become aware that information from a minor has been collected improperly, we will take reasonable steps to delete it.</p>',
    ),
    section(
      '<h2>9. Third-Party Links &amp; Platforms</h2>' +
        '<p>Our website or LMS may contain links to third-party websites, applications, or wellness resources.</p>' +
        '<p>Hilom Collective is not responsible for the privacy practices, policies, or content of third-party services.</p>' +
        '<p>Users are encouraged to review the privacy policies of external platforms they access.</p>',
      'cream',
    ),
    section(
      '<h2>10. Community Guidelines &amp; User Content</h2>' +
        '<p>Users participating in forums, discussions, group coaching, or community spaces within the LMS should understand that:</p>' +
        list(
          'Shared content may be visible to other participants',
          'Respectful and ethical communication is expected',
          'Users remain responsible for the content they voluntarily post or share',
        ) +
        '<p>Hilom Collective reserves the right to moderate or remove harmful, abusive, discriminatory, or inappropriate content.</p>',
    ),
    section(
      '<h2>11. Compliance with Philippine Data Privacy Laws</h2>' +
        '<p>Hilom Collective aims to comply with applicable provisions of the National Privacy Commission and the Data Privacy Act of 2012.</p>' +
        '<p>Users located outside the Philippines acknowledge that their information may be processed and stored in jurisdictions where our technology providers operate.</p>',
      'cream',
    ),
    section(
      '<h2>12. Changes to This Privacy Policy</h2>' +
        '<p>Hilom Collective may update this Privacy Policy periodically to reflect operational, legal, or technological changes.</p>' +
        '<p>Updated versions will be posted on our website with a revised “Last Updated” date.</p>' +
        '<p>Continued use of our services after updates constitutes acceptance of the revised policy.</p>',
    ),
    section(
      '<h2>13. Contact Information</h2>' +
        '<p>For questions, requests, or concerns regarding this Privacy Policy or your personal data, you may contact:</p>' +
        '<p><strong>Hilom Collective</strong><br />Email: <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a><br />Website: <a href="https://hilomcollective.com">Hilom Collective Official Website</a></p>',
      'cream',
    ),
    section(
      '<h2>14. Disclaimer</h2>' +
        '<p>Hilom Collective provides wellness education, community learning, coaching support, and holistic development resources.</p>' +
        '<p>Our content and programs are not intended to replace professional medical, psychiatric, legal, or financial advice. Users are encouraged to consult qualified professionals when appropriate.</p>',
    ),
  ];
}

async function main(): Promise<void> {
  const { pages } = await api<{ pages: { id: string; slug: string; title: string }[] }>('/admin/pages');
  const bySlug = new Map(pages.map((p) => [p.slug, p]));

  const builders: Record<string, () => Promise<unknown[]> | unknown[]> = {
    home: buildHome,
    about: buildAbout,
    services: buildServices,
    events: buildEvents,
    community: buildCommunity,
    'privacy-policy': buildPrivacyPolicy,
  };

  const wanted = (slug: string) => ONLY_SLUGS.size === 0 || ONLY_SLUGS.has(slug);

  const unknownSlugs = [...ONLY_SLUGS].filter((s) => !(s in builders) && s !== 'events');
  if (unknownSlugs.length) {
    console.error(`Unknown slug(s): ${unknownSlugs.join(', ')}. Known: ${Object.keys(builders).join(', ')}`);
    process.exit(1);
  }

  // The sample events are their own rows, not a page draft, so they only get
  // written when explicitly asked for or on a full run — a targeted
  // `privacy-policy` seed must not resurrect them.
  if (wanted('events')) {
    console.log('\nevents:');
    await seedEvents();
  }

  for (const [slug, build] of Object.entries(builders)) {
    if (!wanted(slug)) continue;
    const page = bySlug.get(slug);
    if (!page) {
      console.warn(`! no page row for "${slug}" — run the db/seed/*.sql files first`);
      continue;
    }
    console.log(`\n${slug}:`);
    const blocks = await build();
    await api(`/admin/pages/${page.id}/draft`, { method: 'PUT', body: JSON.stringify({ blocks }) });
    console.log(`  wrote ${blocks.length} blocks to the draft`);
  }

  console.log(
    '\nDone. The two seeded events are published rows (Admin → Events) but invisible until the ' +
      'Events page itself is published. Nothing else is live yet either — open /admin → Pages, ' +
      'compare each preview against the current page, then press Publish.',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
