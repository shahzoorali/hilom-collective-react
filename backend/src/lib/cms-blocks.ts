/**
 * The CMS block catalog — the single source of truth for what a page can
 * contain and what each block's props look like.
 *
 * The catalog is declarative (a field spec per block type) rather than a set of
 * hand-written validators, because the admin editor generates its property
 * panel from exactly this shape. Adding a block type means adding one entry
 * here, one entry in the frontend mirror, and one renderer component.
 *
 * MIRROR: frontend/src/cms/blocks.ts holds the same catalog for the editor and
 * renderer. The two packages have separate builds and no shared module, so the
 * duplication is deliberate — keep them in sync when adding a block type.
 */
import { sanitizeRichText, stripTags } from './sanitize.js';

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
  /** Shown in the admin "add block" picker. */
  description: string;
  fields: Record<string, FieldSpec>;
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

/**
 * Every block type maps onto markup the site already uses (the `hero`,
 * `section`, `card`, `panel`, `split`, `grid` classes in index.css), so a
 * migrated page renders identically to the JSX page it replaced.
 */
export const BLOCK_CATALOG = {
  hero: {
    label: 'Hero',
    description: 'Page opener: optional badge, headline, one or more lead paragraphs, optional button.',
    fields: {
      badge: { kind: 'text', label: 'Badge' },
      badgeColor: { kind: 'select', label: 'Badge colour', options: ['forest', 'ochre'], default: 'forest' },
      heading: { kind: 'text', label: 'Headline', required: true },
      lede: { kind: 'textList', label: 'Lead paragraphs', itemLabel: 'Paragraph' },
      // The homepage's first lede line is bold and forest-coloured.
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
    description: 'Side-by-side panels with a badge and a paragraph (Mission / Vision).',
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
  ctaBanner: {
    label: 'Call to action',
    description: 'Centred closing banner ("There\'s a place for you here").',
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
      'The existing signup form, which emails the team via SES. Its fields are fixed in code; only the surrounding copy is editable.',
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
} as const satisfies Record<string, BlockSpec>;

export type BlockType = keyof typeof BLOCK_CATALOG;

export interface Block {
  /** Stable per-block id, so the editor can key and reorder without remounting. */
  id: string;
  type: BlockType;
  props: Record<string, unknown>;
}

export class BlockValidationError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceField(spec: FieldSpec, raw: unknown, path: string): unknown {
  switch (spec.kind) {
    case 'media': {
      // Stored as {id, url, alt} rather than a bare id: the renderer would
      // otherwise need a second request to resolve every image before it could
      // paint. The id is kept so "which pages use this image?" still works.
      if (!isPlainObject(raw)) return undefined;
      const url = typeof raw.url === 'string' ? raw.url : '';
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (!url || !id) return undefined;
      if (!/^https?:\/\//i.test(url)) throw new BlockValidationError(`${path}.url must be an https URL`);
      return { id, url, alt: stripTags(String(raw.alt ?? '')).slice(0, 500) };
    }
    case 'text':
    case 'href': {
      if (raw === undefined || raw === null || raw === '') {
        if (spec.kind === 'text' && spec.required) {
          throw new BlockValidationError(`${path} is required`);
        }
        return undefined;
      }
      if (typeof raw !== 'string') throw new BlockValidationError(`${path} must be a string`);
      // Plain-text fields are stripped, not escaped: they are rendered as text
      // nodes, and storing entity-escaped copy would double-escape on render.
      const value = stripTags(raw).slice(0, 4000);
      if (spec.kind === 'href') return sanitizeHref(value, path);
      return value;
    }
    case 'richtext': {
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== 'string') throw new BlockValidationError(`${path} must be a string`);
      return sanitizeRichText(raw.slice(0, 20000));
    }
    case 'select': {
      if (raw === undefined || raw === null || raw === '') return spec.default;
      if (typeof raw !== 'string' || !spec.options.includes(raw)) {
        throw new BlockValidationError(`${path} must be one of: ${spec.options.join(', ')}`);
      }
      return raw;
    }
    case 'boolean':
      return raw === undefined ? undefined : Boolean(raw);
    case 'textList': {
      if (raw === undefined || raw === null) return undefined;
      if (!Array.isArray(raw)) throw new BlockValidationError(`${path} must be a list`);
      return raw.slice(0, 50).map((v, i) => {
        if (typeof v !== 'string') throw new BlockValidationError(`${path}[${i}] must be a string`);
        return stripTags(v).slice(0, 4000);
      });
    }
    case 'group': {
      if (!isPlainObject(raw)) return undefined;
      const out = coerceFields(spec.fields, raw, path);
      // An entirely empty group (e.g. an unfilled button) is dropped rather than
      // stored as `{}`, so the renderer's `props.cta && ...` check works.
      return Object.keys(out).length > 0 ? out : undefined;
    }
    case 'list': {
      if (raw === undefined || raw === null) return [];
      if (!Array.isArray(raw)) throw new BlockValidationError(`${path} must be a list`);
      return raw.slice(0, 50).map((item, i) => {
        if (!isPlainObject(item)) throw new BlockValidationError(`${path}[${i}] must be an object`);
        return coerceFields(spec.fields, item, `${path}[${i}]`);
      });
    }
  }
}

function coerceFields(
  fields: Record<string, FieldSpec>,
  raw: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const value = coerceField(spec, raw[name], path ? `${path}.${name}` : name);
    // Unknown incoming keys are dropped here by construction: only catalog
    // fields are ever copied across.
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Blocks link to site paths or external URLs. `javascript:` and `data:` are the
 * two schemes that turn an href into script execution.
 */
function sanitizeHref(value: string, path: string): string {
  const trimmed = value.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) return trimmed;
  throw new BlockValidationError(
    `${path} must be a site path (/about), an https URL, or a mailto: link`,
  );
}

/**
 * Validates and normalizes a blocks array coming from the admin editor.
 * Returns the value to store: unknown fields removed, text stripped, rich text
 * sanitized. Throws BlockValidationError on anything structurally wrong.
 */
export function validateBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) throw new BlockValidationError('blocks must be an array');
  if (raw.length > 100) throw new BlockValidationError('a page cannot have more than 100 blocks');

  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) throw new BlockValidationError(`blocks[${i}] must be an object`);
    const type = entry.type;
    if (typeof type !== 'string' || !(type in BLOCK_CATALOG)) {
      throw new BlockValidationError(`blocks[${i}].type "${String(type)}" is not a known block type`);
    }
    const spec = BLOCK_CATALOG[type as BlockType];
    const props = isPlainObject(entry.props) ? entry.props : {};
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 64) : `b${i}-${Date.now()}`,
      type: type as BlockType,
      props: coerceFields(spec.fields, props, ''),
    };
  });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
export const FORM_FIELD_TYPES = ['text', 'email', 'textarea', 'checkboxGroup', 'select'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  /** For checkboxGroup / select. */
  options?: string[];
  /** Rendered under the field, e.g. a consent note. */
  help?: string;
  /** Two half-width fields sit on one row, matching the existing `.row` class. */
  half?: boolean;
}

export function validateFormFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) throw new BlockValidationError('fields must be an array');
  return raw.slice(0, 40).map((entry, i) => {
    if (!isPlainObject(entry)) throw new BlockValidationError(`fields[${i}] must be an object`);
    const type = String(entry.type ?? 'text');
    if (!FORM_FIELD_TYPES.includes(type as FormFieldType)) {
      throw new BlockValidationError(`fields[${i}].type "${type}" is not supported`);
    }
    const name = stripTags(String(entry.name ?? '')).trim();
    // The name becomes a JSON key in form_submissions.data, so keep it boring.
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(name)) {
      throw new BlockValidationError(
        `fields[${i}].name must start with a letter and contain only letters, digits, and underscores`,
      );
    }
    return {
      name,
      label: stripTags(String(entry.label ?? name)).slice(0, 200),
      type: type as FormFieldType,
      required: Boolean(entry.required),
      options: Array.isArray(entry.options)
        ? entry.options.slice(0, 40).map((o) => stripTags(String(o)).slice(0, 200))
        : undefined,
      help: entry.help ? stripTags(String(entry.help)).slice(0, 500) : undefined,
      half: Boolean(entry.half),
    };
  });
}
