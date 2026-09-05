# Curve — visual design reference

Source: Dribbble shot `551202bd6e508ea989595496227f1c92.png`, 3200 × 14060 px.
The shot is a **2× export of a ~1529 px-wide page** sitting on a light-grey backdrop.
All measurements below are given **at 1× (divide the raw pixel values by 2)**.

## Frame

| Thing | Raw px | 1× |
|---|---|---|
| Canvas | 3200 × 14060 | 1600 × 7030 |
| Page card, left/right edge | x 74 → 3131 | 37 → 1565 (page width **1529**) |
| Page card, top / bottom | y 64 → 13960 | 32 → 6980 |
| Backdrop | `#DBDBDB` | — |

The page is a rounded rectangle floating on grey — treat the grey as presentation
chrome, not part of the design. Page horizontal padding is **~40** to the outer
content edge (logo starts at 154 raw = 77).

## Palette

| Token | Hex | Use |
|---|---|---|
| `forest` | `#143F26` | Hero bg, footer bg, section bg, all headings, primary button fill, body copy on light |
| `cream` | `#ECF6E2` | Text on forest, primary-button-on-forest fill |
| `sand` | `#F1F5E9` | Testimonial card fill, portrait card fill, soft section blocks |
| `lime` | `#DCF3A9` | Calculate button, expertise chips, BMI "healthy" band |
| `white` | `#FFFFFF` | Page body, cards |
| `peach` | `#FFEFD0` | BMI "overweight" band |
| `clay` | `#C87A7A` | BMI "obese" band |
| `sage` | `#93B071` / `#CDD6BB` | Expert portrait backdrops, muted illustration |
| `backdrop` | `#DBDBDB` | Mockup ground only |

Two accents only — deep forest + lime — with cream/sand as the neutral warm greys.
There is no true grey in the UI; every "grey" is a desaturated green.

## Type

- **Display / headings:** a bold geometric-humanist grotesk (Hanken Grotesk / Gilroy
  family look — tight apertures, single-storey `g`, heavy weight 700). Always forest
  on light, cream on forest.
- **Body / UI:** a neutral grotesk (Inter / Söhne look), 400–500.
- Hero H1 ≈ **86/0.95**, centred, two lines, sentence case with a full stop.
- Section H2 ≈ **44–48/1.15**, bold. Sometimes centred ("Trusted by 30,000 members
  globally", "Meet your team of experts"), sometimes left in a 2-col split.
- Large statement copy (the "At Curve, we believe…" block) ≈ **34/1.35**, forest, in a
  ~1100-wide measure, with a small `● Curve` eyebrow in the left rail.
- Body ≈ **16–18/1.5**. Captions/disclaimers ≈ **13–14 italic**.

## Layout system

- Section rhythm: ~120–160 vertical padding at 1×; full-bleed colour blocks
  (forest ↔ white) with **no rounding** — they run edge-to-edge inside the page card.
- Two grids in play:
  1. **Rail + content** — a ~200-wide left rail (eyebrow label, filter checkboxes)
     and the real content starting at x ≈ 189 (1×).
  2. **3-up card grid** — cards **271 wide, 17 gutter** (raw 542 / 34), right-aligned
     to content edge 1412.
- Media is treated as large soft-cornered blocks: hero photo radius **~16**, expert
  portraits and testimonial cards **~12**, buttons **~8**.

## Components

**Nav** — transparent over the hero. Logo (figure glyph + wordmark "Curve", cream),
left-aligned links with chevrons on `Treatment` and `Learn`; right side a
cream-outlined ghost `Login` pill and a solid cream `Check your eligibility` pill.
Height ≈ 100 at 1×.

**Hero** — forest with a faint dotted texture (subtle lighter dots on a ~40 grid),
centred H1 + subcopy + a small cream `Get Started` button, then a wide photo that
breaks out below and overlaps the section boundary. A white floating card is inset
over the photo containing a full-width forest `Check your eligibility` button and a
line of italic reassurance copy with a small lime money-back glyph.

**Stat strip** — 4 columns separated by thin 1px vertical rules; big number ≈ 40 bold
near-black, label 15 grey-green underneath.

**Feature split** — image left (soft grey backdrop, radius 12), copy right: H2, 2-line
intro, then a checklist of 3 items with filled forest circle-check icons, then a
bordered accordion row (`Wondering what the treatments are called?` + chevron).

**BMI section** — forest block. Left: bold 2-line H2, small copy, and a white
calculator card (radius 12, generous padding): two labelled numeric inputs side by
side, a small underlined `change to pounds` link, a full-width lime `Calculate`
button, a result line, and a 4-band segmented BMI meter with a circular sand knob at
the far left. Italic legal note under it with one bold inline link. Right: a photo in
a sage-tinted rounded card. Section closes with a centred cream `Check your
eligibility` button.

**Testimonials** — alternating halves: photo one side (with a circular translucent
play button dead-centre) and a sand panel the other, holding a name label and a
quote in ~22/1.5. Panel and image share one rounded rectangle silhouette. Below, a
centred sand `Explore results` button with a hairline border.

**Expert directory** — centred H2 + subhead, then rail-of-checkbox-filters
("Search by:", "Support style:", "Expertise:") on the left and a 3×2 white card grid
on the right. Each card: portrait on a sage backdrop, bold name, a hairline rule,
italic role, then lime pill chips (~14, radius full), then a bold `View profile →`.
Grid ends with a centred `Show more experts ⌄`.

**Footer** — forest. Four zones: brand + bold 3-line CTA headline + cream
`Check your eligibility` button + `eucalyptus` sub-brand lockup; contact column with
small lime icons and a country selector with a flag; two link columns with `›`
chevrons; a large low-contrast sage figure illustration bleeding behind the middle;
social circles on the right. A hairline rule, then a 2-column legal row.

## Rules worth copying

1. Only two brand colours; everything else is warm off-white. Lime is used **only**
   for the moment of action or a taxonomy chip — never for large surfaces.
2. Full-bleed colour blocks alternate forest/white; cards, not sections, get radii.
3. Every CTA is the same phrase (`Check your eligibility`) repeated at each scroll
   depth, restyled to fit the block it sits in.
4. Headings are heavy and tight; body is light and airy. The contrast in weight, not
   size, carries the hierarchy.
5. Photography is always warm, candid, and cropped close; portraits are colour-keyed
   to a single sage backdrop so the grid reads as one system.

---

## How this was applied to Hilom

The layout grammar above was adopted wholesale; the colour and type were not.
Hilom keeps Libre Baskerville over Montserrat and its own Forest / Leaf / Ochre
/ Cream palette. The role mapping:

| Curve role | Hilom token |
|---|---|
| forest (bands, footer, headings) | `--forest-deep` `#1F4229`, one step below brand Forest so a full-bleed block does not read muddy |
| cream (type + buttons on dark) | `--on-forest` `#F7EFDB`, `--cream` `#F3E6C8` |
| sand (soft panels on white) | `--sand` `#FAF4E6` |
| lime (the action colour) | `--ochre` `#F2A429`, still rationed to one use per band |
| sage (portrait grounds) | `--leaf` `#7FA468` |

Implementation lives in two places:

- **`frontend/src/index.css`**, in the `cv-` layer at the end of the file —
  bands, hero, breakout image, statement rail, stat strip, feature split, tick
  list, disclosure row, quote panels, the directory rail + person cards, chips,
  and the dark header and four-zone footer.
- **`frontend/src/cms/BlockRenderer.tsx`**, where every CMS block became a
  full-bleed band. This is the part that actually changes the live site: the
  public pages are CMS-rendered, so restyling the blocks re-skinned every
  published page without migrating any content. The `background` prop gained
  `white` / `sand` / `forest` alongside `cream`; the old `none` still resolves
  to white.

The JSX pages in `frontend/src/pages` that `CmsOrFallback` falls back to were
moved onto the same classes so a published page and its fallback match.

Two substitutions were deliberate:

- Curve's BMI calculator became a **routing card**, not a score. Hilom is not a
  diagnostic service, so the card asks where someone wants to begin and sends
  them there; the reference's banded meter is reused as a path indicator.
- Curve's expert filter rail is built only from **specialties two or more
  facilitators share**. Hilom's specialties are free text, and a rail built from
  all of them would be a wall of near-duplicate one-offs.
