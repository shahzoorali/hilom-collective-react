/**
 * The block catalog, frontend copy.
 *
 * MIRROR of backend/src/lib/cms-blocks.ts — the two packages have separate
 * builds and no shared module, so this duplication is deliberate. The backend
 * copy is the one that validates and sanitizes; this copy drives the admin
 * editor's property panel and the renderer's types. Adding a block type means
 * editing both files plus adding a component in BlockRenderer.tsx.
 */

export type FieldSpec =
  | { kind: 'text'; label: string; required?: boolean; multiline?: boolean }
  | { kind: 'richtext'; label: string }
  | { kind: 'media'; label: string; required?: boolean }
  | { kind: 'href'; label: string; required?: boolean }
  | { kind: 'select'; label: string; options: readonly string[]; default?: string }
  | { kind: 'boolean'; label: string }
  | { kind: 'textList'; label: string; itemLabel: string }
  | { kind: 'group'; label: string; fields: Record<string, FieldSpec> }
  | { kind: 'list'; label: string; itemLabel: string; fields: Record<string, FieldSpec> };

export interface BlockSpec {
  label: string;
  description: string;
  fields: Record<string, FieldSpec>;
}

/** What a `media` field stores. */
export interface MediaRef {
  id: string;
  url: string;
  alt: string;
}

export interface Cta {
  label?: string;
  href?: string;
  variant?: string;
}

const BACKGROUNDS = ['none', 'cream'] as const;
const BUTTON_VARIANTS = ['btn-primary', 'btn-accent', 'btn-ghost'] as const;

const ctaField: FieldSpec = {
  kind: 'group',
  label: 'Button',
  fields: {
    label: { kind: 'text', label: 'Button text' },
    href: { kind: 'href', label: 'Links to' },
    variant: { kind: 'select', label: 'Style', options: BUTTON_VARIANTS, default: 'btn-primary' },
  },
};

const backgroundField: FieldSpec = {
  kind: 'select',
  label: 'Background',
  options: BACKGROUNDS,
  default: 'none',
};

export const BLOCK_CATALOG: Record<string, BlockSpec> = {
  hero: {
    label: 'Hero',
    description: 'Page opener: optional badge, headline, lead paragraphs, optional button.',
    fields: {
      badge: { kind: 'text', label: 'Badge' },
      badgeColor: { kind: 'select', label: 'Badge colour', options: ['forest', 'ochre'], default: 'forest' },
      heading: { kind: 'text', label: 'Headline', required: true },
      lede: { kind: 'textList', label: 'Lead paragraphs', itemLabel: 'Paragraph' },
      emphasizeFirstLede: { kind: 'boolean', label: 'Emphasise the first paragraph' },
      cta: ctaField,
    },
  },
  fullWidthImage: {
    label: 'Full-width image',
    description: 'A single image spanning the content column.',
    fields: {
      image: { kind: 'media', label: 'Image', required: true },
    },
  },
  richText: {
    label: 'Rich text',
    description: 'Free-form headings and paragraphs.',
    fields: {
      html: { kind: 'richtext', label: 'Content' },
      background: backgroundField,
    },
  },
  split: {
    label: 'Text + image',
    description: 'Two columns: copy on one side, image on the other.',
    fields: {
      reverse: { kind: 'boolean', label: 'Image on the left' },
      narrow: { kind: 'boolean', label: 'Narrow text column' },
      badge: { kind: 'text', label: 'Badge' },
      heading: { kind: 'text', label: 'Heading' },
      headingLevel: { kind: 'select', label: 'Heading level', options: ['h1', 'h2'], default: 'h2' },
      html: { kind: 'richtext', label: 'Copy' },
      cta: ctaField,
      image: { kind: 'media', label: 'Image' },
      background: backgroundField,
    },
  },
  statGrid: {
    label: 'Statistics',
    description: 'A row of big numbers that count up when scrolled into view.',
    fields: {
      badge: { kind: 'text', label: 'Badge' },
      badgeColor: { kind: 'select', label: 'Badge colour', options: ['forest', 'ochre'], default: 'ochre' },
      heading: { kind: 'text', label: 'Heading' },
      items: {
        kind: 'list',
        label: 'Statistics',
        itemLabel: 'Stat',
        fields: {
          value: { kind: 'text', label: 'Value', required: true },
          caption: { kind: 'text', label: 'Caption', multiline: true },
        },
      },
      background: backgroundField,
    },
  },
  cardGrid: {
    label: 'Text cards',
    description: 'A grid of simple cards with a title and body.',
    fields: {
      heading: { kind: 'text', label: 'Heading' },
      subheading: { kind: 'text', label: 'Subheading' },
      items: {
        kind: 'list',
        label: 'Cards',
        itemLabel: 'Card',
        fields: {
          title: { kind: 'text', label: 'Title' },
          body: { kind: 'text', label: 'Body', multiline: true, required: true },
        },
      },
      background: backgroundField,
    },
  },
  panelGrid: {
    label: 'Panels',
    description: 'Side-by-side panels with a badge and a paragraph.',
    fields: {
      items: {
        kind: 'list',
        label: 'Panels',
        itemLabel: 'Panel',
        fields: {
          badge: { kind: 'text', label: 'Badge' },
          body: { kind: 'text', label: 'Body', multiline: true, required: true },
        },
      },
      background: backgroundField,
    },
  },
  imageCardGrid: {
    label: 'Image cards',
    description: 'Cards with a photo — used for services and events.',
    fields: {
      variant: { kind: 'select', label: 'Card shape', options: ['service', 'event'], default: 'service' },
      items: {
        kind: 'list',
        label: 'Cards',
        itemLabel: 'Card',
        fields: {
          image: { kind: 'media', label: 'Image' },
          title: { kind: 'text', label: 'Title', required: true },
          subtitle: { kind: 'text', label: 'Subtitle', multiline: true },
          desc: { kind: 'text', label: 'Description', multiline: true },
          meta: { kind: 'text', label: 'Date / time' },
          note: { kind: 'text', label: 'Highlighted note' },
          cta: ctaField,
        },
      },
      background: backgroundField,
    },
  },
  productGrid: {
    label: 'Course catalog',
    description: 'The live course list, pulled from the products API.',
    fields: {
      heading: { kind: 'text', label: 'Heading' },
      subheading: { kind: 'text', label: 'Subheading' },
      background: backgroundField,
    },
  },
  eventGrid: {
    label: 'Events list',
    description:
      'The live, managed events list (Admin → Events) — upcoming events first, then a Past Events section. Individual events are not edited here.',
    fields: {
      heading: { kind: 'text', label: 'Heading' },
      background: backgroundField,
    },
  },
  ctaBanner: {
    label: 'Call to action',
    description: 'Centred closing banner.',
    fields: {
      badge: { kind: 'text', label: 'Badge' },
      heading: { kind: 'text', label: 'Heading', required: true },
      lede: { kind: 'text', label: 'Lead paragraph', multiline: true },
      cta: ctaField,
      background: backgroundField,
    },
  },
  communityForm: {
    label: 'Community signup form',
    description:
      'The existing signup form, which emails the team. Its fields are fixed in code; only the surrounding copy is editable.',
    fields: {},
  },
  form: {
    label: 'Custom form',
    description: 'Renders a form defined under Admin → Forms.',
    fields: {
      formSlug: { kind: 'text', label: 'Form slug', required: true },
      heading: { kind: 'text', label: 'Heading' },
    },
  },
};

export type BlockType = keyof typeof BLOCK_CATALOG;

export interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
}

/** A new block starts with the catalog's defaults filled in, so adding one
 *  never produces an invisible, empty section. */
export function emptyBlock(type: string): Block {
  const spec = BLOCK_CATALOG[type];
  const props: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    if (field.kind === 'select' && field.default) props[name] = field.default;
    if (field.kind === 'list' || field.kind === 'textList') props[name] = [];
  }
  return { id: `b-${crypto.randomUUID()}`, type, props };
}
