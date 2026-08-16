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
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.HILOM_API_BASE ?? 'https://api.hilomcollective.com';
const ADMIN_KEY = process.env.HILOM_ADMIN_KEY;
const SKIP_MEDIA = process.argv.includes('--skip-media');

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
    block('imageCardGrid', {
      variant: 'event',
      items: [
        {
          image: await getMedia('pages/event-1.png', ''),
          title: 'The Overloaded Mom Reset',
          subtitle: '(and How Partners Can Support) with St. Raphael Health Hub',
          desc: 'For moms who are always caring for everyone else, and rarely for themselves. This online workshop offers a space to pause, understand what your body and mind are going through, and learn practical, doable ways to feel supported, with partners invited to join in too.',
          meta: 'July 22, 2026 | 3:00–5:00 PM | Via Zoom',
        },
        {
          image: await getMedia('pages/event-2.jpeg', ''),
          title: 'Sacred Authority: Becoming the Author of Your Life',
          subtitle: 'A virtual session by Maude Labs, co-presented with The Authenticity Institute',
          desc: 'A 90-minute virtual session for founders, leaders, and purpose-driven individuals ready to reclaim their story and lead from authenticity, not expectation. Led by Dr. Katrina Gisbert-Tay.',
          meta: 'July 22, 2026 | 8:00–9:30 PM | Virtual',
          note: 'Use code: HILOM for 10% off',
        },
      ],
    }),
    joinTheMovement('btn-accent', '/community', 'Join Our Community', 'cream'),
  ];
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

async function main(): Promise<void> {
  const { pages } = await api<{ pages: { id: string; slug: string; title: string }[] }>('/admin/pages');
  const bySlug = new Map(pages.map((p) => [p.slug, p]));

  const builders: Record<string, () => Promise<unknown[]> | unknown[]> = {
    home: buildHome,
    about: buildAbout,
    services: buildServices,
    events: buildEvents,
    community: buildCommunity,
  };

  for (const [slug, build] of Object.entries(builders)) {
    const page = bySlug.get(slug);
    if (!page) {
      console.warn(`! no page row for "${slug}" — run db/seed/0002_seed_cms.sql first`);
      continue;
    }
    console.log(`\n${slug}:`);
    const blocks = await build();
    await api(`/admin/pages/${page.id}/draft`, { method: 'PUT', body: JSON.stringify({ blocks }) });
    console.log(`  wrote ${blocks.length} blocks to the draft`);
  }

  console.log(
    '\nDone. Nothing is live yet — open /admin → Pages, compare each preview against the ' +
      'current page, then press Publish.',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
