/**
 * Admin → Footer.
 *
 * The footer as an ordered list of widgets, with a live preview underneath
 * that renders the real `SiteFooter` — the same component every page renders,
 * so what is on screen here is what visitors get.
 *
 * Separate from Admin → Menus even though a footer column can *be* a menu: a
 * menu is a list of links reused in several places, while this is the footer's
 * own composition — how many columns there are, what kind each one is, and the
 * small print underneath. The `menu` widget is what connects the two, so legal
 * links stay edited in exactly one place.
 *
 * The save replaces the whole footer, matching the menu editor. Until someone
 * saves for the first time there is no row at all and the site renders
 * `DEFAULT_FOOTER` — which is what this screen loads, so a first edit starts
 * from the footer that is actually live rather than from nothing.
 */
import { useEffect, useState } from 'react';
import { adminGetSiteSettings, adminGetMenus, adminSaveSiteSetting, type AdminMenu } from '../../lib/cms';
import SiteFooter from '../../components/SiteFooter';
import {
  coerceFooter,
  emptyWidget,
  DEFAULT_FOOTER,
  FOOTER_WIDGET_TYPES,
  type FooterLink,
  type FooterSettings,
  type FooterWidget,
} from '../../lib/footer';

const WIDGET_LABEL: Record<FooterWidget['type'], string> = {
  brand: 'Brand & call to action',
  links: 'Link list',
  menu: 'Menu',
  contact: 'Contact',
  text: 'Text',
};

const blankLink = (): FooterLink => ({ label: '', href: '/', target: 'self' });

export default function FooterTab({ adminKey }: { adminKey: string }) {
  const [footer, setFooter] = useState<FooterSettings | null>(null);
  const [menus, setMenus] = useState<AdminMenu[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addType, setAddType] = useState<FooterWidget['type']>('links');

  useEffect(() => {
    adminGetSiteSettings(adminKey)
      .then((settings) => setFooter(settings.footer ? coerceFooter(settings.footer) : DEFAULT_FOOTER))
      .catch((err: Error) => setError(err.message));
    adminGetMenus(adminKey).then(setMenus).catch(() => setMenus([]));
  }, [adminKey]);

  const update = (index: number, changes: Partial<FooterWidget>) =>
    setFooter((f) =>
      f
        ? {
            ...f,
            widgets: f.widgets.map((w, i) =>
              i === index ? ({ ...w, ...changes } as FooterWidget) : w,
            ),
          }
        : f,
    );

  const move = (index: number, by: number) =>
    setFooter((f) => {
      if (!f) return f;
      const target = index + by;
      if (target < 0 || target >= f.widgets.length) return f;
      const widgets = [...f.widgets];
      [widgets[index], widgets[target]] = [widgets[target], widgets[index]];
      return { ...f, widgets };
    });

  const remove = (index: number) =>
    setFooter((f) => (f ? { ...f, widgets: f.widgets.filter((_, i) => i !== index) } : f));

  const add = () =>
    setFooter((f) =>
      f
        ? {
            ...f,
            // Ids only have to be unique within the footer, and they are what
            // keeps a row's inputs attached to it across a reorder.
            widgets: [...f.widgets, emptyWidget(addType, `w${Date.now().toString(36)}`)],
          }
        : f,
    );

  async function save() {
    if (!footer) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const settings = await adminSaveSiteSetting(adminKey, 'footer', footer);
      setFooter(coerceFooter(settings.footer));
      setNotice('Footer saved — live on the site now.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the footer');
    } finally {
      setBusy(false);
    }
  }

  if (!footer) {
    return error ? <div className="alert alert-error">{error}</div> : <div className="spinner" aria-label="Loading" />;
  }

  /** The link-list editor, shared by the `links` widget and contact socials. */
  const linkRows = (
    items: FooterLink[],
    onChange: (next: FooterLink[]) => void,
    labelHint: string,
  ) => (
    <>
      {items.map((item, i) => (
        <div className="row" key={i} style={{ gap: '0.4rem', marginBottom: '0.4rem', alignItems: 'center' }}>
          <input
            aria-label="Label"
            placeholder={labelHint}
            value={item.label}
            onChange={(e) =>
              onChange(items.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))
            }
            style={{ flex: '1 1 8rem' }}
          />
          <input
            aria-label="Link"
            placeholder="/about or https://…"
            value={item.href}
            onChange={(e) =>
              onChange(items.map((l, j) => (j === i ? { ...l, href: e.target.value } : l)))
            }
            style={{ flex: '2 1 12rem' }}
          />
          <select
            aria-label="Opens in"
            value={item.target}
            onChange={(e) =>
              onChange(
                items.map((l, j) =>
                  j === i ? { ...l, target: e.target.value as FooterLink['target'] } : l,
                ),
              )
            }
          >
            <option value="self">Same tab</option>
            <option value="blank">New tab</option>
          </select>
          <button
            type="button"
            className="btn btn-ghost small"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            aria-label="Remove link"
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost small" onClick={() => onChange([...items, blankLink()])}>
        + Add link
      </button>
    </>
  );

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Footer</h2>
        <button
          type="button"
          className="btn btn-accent small"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save footer'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <p className="small muted">
        Columns run left to right in the order below. A <strong>Menu</strong> column renders a menu
        from <a className="linklike" href="/admin/menus">Menus</a> — the place to edit legal and
        platform links, so they stay in one place.
      </p>

      {footer.widgets.map((widget, index) => (
        <div className="panel" key={widget.id} style={{ marginBottom: '0.85rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <strong>
              {WIDGET_LABEL[widget.type]}
              {'title' in widget && widget.title ? ` — ${widget.title}` : ''}
            </strong>
            <div className="row" style={{ gap: '0.3rem' }}>
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label="Move column left"
              >
                ←
              </button>
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() => move(index, 1)}
                disabled={index === footer.widgets.length - 1}
                aria-label="Move column right"
              >
                →
              </button>
              <button type="button" className="btn btn-ghost small" onClick={() => remove(index)}>
                Remove
              </button>
            </div>
          </div>

          {widget.type === 'brand' && (
            <>
              <p className="small muted" style={{ marginTop: '0.4rem' }}>
                The logo is fixed — it is the site's, not the footer's.
              </p>
              <label className="field">
                <span>Closing line</span>
                {/* A textarea, not an input: the headline is a short lockup
                    that is usually broken across two lines ("Paghilom." /
                    "Para sa lahat."), and a single-line input gives no way to
                    place that break. */}
                <textarea
                  rows={2}
                  value={widget.headline}
                  onChange={(e) => update(index, { headline: e.target.value })}
                />
                <small className="muted">Press Enter to break the line.</small>
              </label>
              <div className="two-col">
                <label className="field">
                  <span>Button label</span>
                  <input
                    value={widget.cta_label}
                    onChange={(e) => update(index, { cta_label: e.target.value })}
                    placeholder="Join our community"
                  />
                </label>
                <label className="field">
                  <span>Button link</span>
                  <input
                    value={widget.cta_href}
                    onChange={(e) => update(index, { cta_href: e.target.value })}
                    placeholder="/community"
                  />
                </label>
              </div>
              <p className="small muted">Leave either blank to drop the button.</p>
            </>
          )}

          {widget.type === 'links' && (
            <>
              <label className="field">
                <span>Column heading</span>
                <input value={widget.title} onChange={(e) => update(index, { title: e.target.value })} />
              </label>
              {linkRows(widget.links, (links) => update(index, { links }), 'About Hilom')}
            </>
          )}

          {widget.type === 'menu' && (
            <div className="two-col">
              <label className="field">
                <span>Column heading</span>
                <input value={widget.title} onChange={(e) => update(index, { title: e.target.value })} />
              </label>
              <label className="field">
                <span>Menu</span>
                <select
                  value={widget.menu_key}
                  onChange={(e) => update(index, { menu_key: e.target.value })}
                >
                  {menus.length === 0 && <option value={widget.menu_key}>{widget.menu_key}</option>}
                  {menus.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label} ({m.items.length})
                    </option>
                  ))}
                </select>
                <small className="muted">Edited in Menus, shown here.</small>
              </label>
            </div>
          )}

          {widget.type === 'contact' && (
            <>
              <label className="field">
                <span>Column heading</span>
                <input value={widget.title} onChange={(e) => update(index, { title: e.target.value })} />
              </label>
              <div className="two-col">
                <label className="field">
                  <span>Email</span>
                  <input
                    value={widget.email}
                    onChange={(e) => update(index, { email: e.target.value })}
                    placeholder="kumusta@hilomcollective.com"
                  />
                </label>
                <label className="field">
                  <span>Location</span>
                  <input
                    value={widget.address}
                    onChange={(e) => update(index, { address: e.target.value })}
                    placeholder="Metro Manila, Philippines"
                  />
                </label>
              </div>
              <p className="small" style={{ margin: '0 0 0.3rem' }}>
                <strong>Social icons</strong>{' '}
                <span className="muted">— the label is what shows in the circle (f, ig, tt).</span>
              </p>
              {linkRows(widget.socials, (socials) => update(index, { socials }), 'ig')}
            </>
          )}

          {widget.type === 'text' && (
            <>
              <label className="field">
                <span>Column heading</span>
                <input value={widget.title} onChange={(e) => update(index, { title: e.target.value })} />
              </label>
              <label className="field">
                <span>Text</span>
                <textarea
                  rows={4}
                  value={widget.text}
                  onChange={(e) => update(index, { text: e.target.value })}
                />
                <small className="muted">Blank lines start a new paragraph. No HTML.</small>
              </label>
            </>
          )}
        </div>
      ))}

      <div className="row" style={{ gap: '0.5rem', alignItems: 'center', marginBottom: '1.25rem' }}>
        <select
          value={addType}
          onChange={(e) => setAddType(e.target.value as FooterWidget['type'])}
          aria-label="Column type to add"
        >
          {FOOTER_WIDGET_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost small" onClick={add}>
          + Add column
        </button>
        <span className="small muted">
          {FOOTER_WIDGET_TYPES.find((t) => t.value === addType)?.hint}
        </span>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Small print</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          The lines under the columns. Up to four; blank ones are dropped.
        </p>
        {[0, 1, 2, 3].map((i) => (
          <input
            key={i}
            aria-label={`Small print line ${i + 1}`}
            value={footer.legal_lines[i] ?? ''}
            onChange={(e) =>
              setFooter((f) => {
                if (!f) return f;
                const legal_lines = [...f.legal_lines];
                legal_lines[i] = e.target.value;
                return { ...f, legal_lines };
              })
            }
            style={{ width: '100%', marginBottom: '0.4rem' }}
          />
        ))}
      </div>

      {/* The real footer, from the unsaved draft. Menus come from the admin
          list, which includes hidden items — a preview showing a link the site
          will not render would be worse than none, so they are filtered out
          here the same way the public endpoint filters them. */}
      <h3>Preview</h3>
      <div className="admin-preview-frame">
        <SiteFooter
          settings={footer}
          menus={Object.fromEntries(
            menus.map((m) => [
              m.key,
              m.items.filter((i) => i.visible).map((i) => ({ ...i, children: [] })),
            ]),
          )}
        />
      </div>
    </>
  );
}
