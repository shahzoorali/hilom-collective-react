/**
 * The site footer, rendered from editable widgets.
 *
 * The four zones this replaces — brand and CTA, contact, an "Explore" list,
 * and the CMS-driven "More" menu — are now four widgets in the default value
 * (see `lib/footer.ts`), so nothing about the rendered footer changed when it
 * became editable. The class names are the ones the stylesheet already
 * carries: the grid it sits in is `cv-foot`, which is why a widget renders as
 * a bare `<div>` with a heading rather than bringing a wrapper of its own.
 *
 * Its own component, separate from `Layout`, so Admin → Footer can preview a
 * draft with the same code that renders the real thing.
 */
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import hilomLogo from '../assets/hilom-logo.png';
import type { FooterLink, FooterSettings, FooterWidget } from '../lib/footer';
import type { MenuLink } from '../lib/cms';

/** Internal paths stay client-side; external ones and mailto: leave the app. */
function FooterHref({
  href,
  target,
  children,
  className,
}: {
  href: string;
  target?: 'self' | 'blank';
  children: ReactNode;
  className?: string;
}) {
  if (target === 'blank' || !href.startsWith('/')) {
    return (
      <a href={href} className={className} target={target === 'blank' ? '_blank' : undefined} rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {children}
    </Link>
  );
}

/** A menu item, narrowed to the two fields the footer renders. */
const fromMenu = (item: MenuLink): FooterLink => ({
  label: item.label,
  href: item.href,
  target: item.target,
});

function LinkColumn({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      {title && <h3>{title}</h3>}
      <ul className="cv-foot__list">
        {links.map((link, i) => (
          <li key={`${link.label}-${i}`}>
            <FooterHref href={link.href} target={link.target}>{link.label}</FooterHref>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Widget({ widget, menus }: { widget: FooterWidget; menus: Record<string, MenuLink[]> }) {
  switch (widget.type) {
    case 'brand':
      return (
        <div className="cv-foot__cta">
          <img src={hilomLogo} alt="Hilom Collective" className="brand-logo" />
          {widget.headline && <p className="cv-foot__headline">{widget.headline}</p>}
          {widget.cta_label && widget.cta_href && (
            <FooterHref className="btn btn-primary" href={widget.cta_href}>
              {widget.cta_label}
            </FooterHref>
          )}
        </div>
      );

    case 'contact':
      return (
        <div>
          {widget.title && <h3>{widget.title}</h3>}
          <ul className="cv-foot__contact">
            {widget.email && (
              <li>
                <a href={`mailto:${widget.email}`}>{widget.email}</a>
              </li>
            )}
            {widget.address && (
              <li>
                <span>{widget.address}</span>
              </li>
            )}
          </ul>
          {widget.socials.length > 0 && (
            <div className="cv-social">
              {widget.socials.map((social, i) => (
                <a
                  key={`${social.label}-${i}`}
                  href={social.href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Hilom Collective on ${social.label}`}
                >
                  {social.label}
                </a>
              ))}
            </div>
          )}
        </div>
      );

    case 'links':
      return <LinkColumn title={widget.title} links={widget.links} />;

    case 'menu':
      // An unknown key renders an empty column rather than throwing — see the
      // note on menu_key in backend/src/lib/site-settings.ts.
      return <LinkColumn title={widget.title} links={(menus[widget.menu_key] ?? []).map(fromMenu)} />;

    case 'text':
      return (
        <div>
          {widget.title && <h3>{widget.title}</h3>}
          {/* Plain text, split on blank lines. Tags are stripped on save, so
              there is deliberately no HTML path here. */}
          {widget.text
            .split(/\n{2,}/)
            .filter(Boolean)
            .map((para, i) => (
              <p key={i} className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {para}
              </p>
            ))}
        </div>
      );

    default:
      return null;
  }
}

export default function SiteFooter({
  settings,
  menus,
}: {
  settings: FooterSettings;
  /** Every menu by key, for `menu` widgets. */
  menus: Record<string, MenuLink[]>;
}) {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="cv-foot">
          {settings.widgets.map((widget) => (
            <Widget key={widget.id} widget={widget} menus={menus} />
          ))}
        </div>

        <div className="cv-foot__legal">
          {settings.legal_lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </div>
    </footer>
  );
}
