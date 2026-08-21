/**
 * Translates the CMS block catalog into a Puck config.
 *
 * The catalog in cms/blocks.ts stays the source of truth for what a block
 * contains — this file only maps each FieldSpec onto Puck's equivalent field
 * type, and points Puck's `render` at the same components BlockRenderer uses on
 * the live site. Adding a block type still means editing the catalog (and its
 * backend mirror) plus adding a component; nothing needs adding here.
 *
 * Two field kinds deliberately use Puck's `custom` escape hatch rather than a
 * built-in:
 *
 *  - `media`, because picking an image has to go through our own S3-backed
 *    library (MediaPickerModal), not a URL text box.
 *  - `richtext`, because Puck's built-in richtext field stores its own value
 *    shape, while the backend sanitizes and stores an HTML string. Keeping our
 *    editor keeps the stored format — and therefore the server-side sanitizer —
 *    exactly as it was.
 */
import type { Config, Field } from '@puckeditor/core';
import { BLOCK_CATALOG, type FieldSpec, type MediaRef } from '../../cms/blocks';
import { BLOCK_COMPONENTS } from '../../cms/BlockRenderer';
import MediaField from './MediaField';
import RichTextEditor from './RichTextEditor';
import TextListField from './TextListField';

type Props = Record<string, unknown>;

function toPuckField(spec: FieldSpec, adminKey: string): Field {
  switch (spec.kind) {
    case 'text':
      return spec.multiline
        ? { type: 'textarea', label: spec.label }
        : { type: 'text', label: spec.label };

    case 'href':
      return { type: 'text', label: spec.label, placeholder: '/community or https://…' };

    case 'select':
      return {
        type: 'select',
        label: spec.label,
        options: spec.options.map((option) => ({ label: option, value: option })),
      };

    case 'boolean':
      return {
        type: 'radio',
        label: spec.label,
        options: [
          { label: 'No', value: false },
          { label: 'Yes', value: true },
        ],
      };

    case 'richtext':
      return {
        type: 'custom',
        label: spec.label,
        render: ({ value, onChange }) => (
          <RichTextEditor value={typeof value === 'string' ? value : ''} onChange={onChange} />
        ),
      };

    case 'media':
      return {
        type: 'custom',
        label: spec.label,
        render: ({ value, onChange }) => (
          <MediaField
            adminKey={adminKey}
            value={value as MediaRef | undefined}
            onChange={onChange}
          />
        ),
      };

    case 'textList':
      // Puck arrays hold objects, but this field stores a plain string[] that
      // the backend validates as such. A custom field keeps the stored shape.
      return {
        type: 'custom',
        label: spec.label,
        render: ({ value, onChange }) => (
          <TextListField
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={onChange}
            itemLabel={spec.itemLabel}
          />
        ),
      };

    case 'group':
      return {
        type: 'object',
        label: spec.label,
        objectFields: toPuckFields(spec.fields, adminKey),
      };

    case 'list':
      return {
        type: 'array',
        label: spec.label,
        arrayFields: toPuckFields(spec.fields, adminKey),
        defaultItemProps: defaultProps(spec.fields),
        getItemSummary: (item: Props, index?: number) =>
          // Whatever reads most like a name for this row, so the collapsed list
          // says "Ginhawa Kits" rather than "Item 4".
          String(item?.title ?? item?.value ?? item?.badge ?? `${spec.itemLabel} ${(index ?? 0) + 1}`),
      };
  }
}

function toPuckFields(fields: Record<string, FieldSpec>, adminKey: string): Record<string, Field> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, spec]) => [name, toPuckField(spec, adminKey)]),
  );
}

/** Defaults so a freshly dragged-in block renders something visible rather than
 *  an empty section the editor then has to hunt for. */
function defaultProps(fields: Record<string, FieldSpec>): Props {
  const props: Props = {};
  for (const [name, spec] of Object.entries(fields)) {
    if (spec.kind === 'select' && spec.default) props[name] = spec.default;
    if (spec.kind === 'list' || spec.kind === 'textList') props[name] = [];
    if (spec.kind === 'text' && spec.required) props[name] = spec.label;
  }
  return props;
}

/**
 * Built per-session rather than as a module constant: the media field needs the
 * admin key to talk to the library API, and that only exists once someone has
 * signed in.
 */
export function createPuckConfig(adminKey: string): Config {
  const components = Object.fromEntries(
    Object.entries(BLOCK_CATALOG).map(([type, spec]) => {
      const Component = BLOCK_COMPONENTS[type];
      return [
        type,
        {
          label: spec.label,
          fields: toPuckFields(spec.fields, adminKey),
          defaultProps: defaultProps(spec.fields),
          // `id` and `puck` are Puck's own additions to props; the block
          // components ignore anything they don't know about, so they are
          // harmless to pass straight through.
          render: (props: Props) => (Component ? <Component props={props} /> : null),
        },
      ];
    }),
  );

  return { components } as Config;
}
