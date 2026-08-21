# Blog with prerendered SEO/social meta

## Context

The site has a CMS (pages, events, media, Puck editor) but no blog. Adding one is
mostly assembly — a post is a title, slug, cover image and a block body, and every
one of those systems already exists.

The part that is *not* assembly is discoverability. This is a client-rendered Vite
SPA on Amplify (`platform: WEB`, no SSR). Verified today: the built `index.html` has
a single hardcoded `<title>` and `description`, no `og:`/`twitter:` tags, and
`CmsPage` sets `document.title` in a `useEffect`. Pages get away with this — nobody
shares `/services` on LinkedIn. A blog does not: **social scrapers (Facebook,
LinkedIn, WhatsApp, Slack) do not execute JavaScript at all**, so every post would
share as "Hilom Collective — Learn. Reflect. Grow." with no image, and Google would
see one duplicate title across every post.

So this plan is a normal CMS feature plus one genuinely new capability: emitting
real per-post HTML `<head>` at build time.

Scope decided: categories (one per post) + tags (many), simple text byline with
optional photo, Puck blocks for the body, sitemap + robots.txt, related posts.
Explicitly **out**: RSS, scheduled publishing.

---

## The risk to settle first

`aws amplify get-app` shows exactly one custom rule:

```
source: </^[^.]+$|\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>
target: /index.html
status: 200
```

`/blog/my-post` contains no dot, so it matches, and Amplify may rewrite it to the
**root** `index.html` — silently discarding a prerendered `dist/blog/my-post/index.html`
and defeating the entire point. Whether an existing static file takes precedence over
a rewrite rule is the one assumption that can invalidate this approach, and I would
rather learn that in ten minutes than after building the feature.

**Spike (do this before anything else):**

1. Add `frontend/public/_spike/index.html` containing a unique marker string.
2. Push, let Amplify build.
3. `curl -s https://www.hilomcollective.com/_spike` and `.../_spike/`.
4. Marker present → static files win; proceed unchanged.
   SPA shell instead → apply the fallback below.
5. Delete the spike file either way.

**Fallback if the catch-all wins:** add an explicit rule *above* it mapping
`/blog/<*>` → `/blog/<*>/index.html` (status 200), or narrow the catch-all's regex to
exclude `/blog/`. Consequence worth accepting either way: a `/blog/*` URL with no
prerendered file 404s instead of loading the SPA — which is correct for a blog, since
every real post is prerendered.

---

## Prerender approach: head-only

`frontend/src/main.tsx` uses `createRoot`, not `hydrateRoot`, so any markup
prerendered into `#root` is thrown away on mount. Two options:

- **Inject only `<head>` (chosen).** Body stays empty, React boots exactly as today.
  Fixes social sharing completely, gives correct per-post titles/descriptions in
  search results, and touches zero runtime code.
- Switch to `hydrateRoot` + full SSR. Gets article text into the raw HTML, but means
  making every block SSR-safe and risking hydration mismatches across the whole site
  — a large change to the thing that currently works, for a marginal gain given
  Googlebot renders JS.

Head-only is the right trade here. If full-HTML content ever becomes necessary,
that is the "move to Next.js" conversation, not a patch to this script.

**`frontend/scripts/prerender.ts`** (Node, run via `tsx`):

> Deliberately inside `frontend/`, not the root `scripts/`. `amplify.yml` sets
> `appRoot: frontend` and runs `npm ci` there, but `tsx` is a devDependency of the
> **root** `package.json` only — a root-level script would run fine locally and fail
> the Amplify build with `tsx: not found`. So the script lives in the frontend
> workspace and `tsx` gets added to `frontend/package.json` devDependencies, keeping
> `appRoot` self-contained.

- Reads `frontend/dist/index.html` as a template.
- Fetches published content from `API_BASE` (`frontend/src/config.ts` already
  defaults to the production API, so no new build env var).
- For `/blog`, each `/blog/{slug}`, and each `/blog/category/{slug}`, writes
  `dist/<route>/index.html` with `<title>`, `description`, `canonical`,
  `og:*`/`twitter:*` (image = post cover from CloudFront), and Article JSON-LD.
- Writes `dist/sitemap.xml` covering published pages and posts.
- `frontend/public/robots.txt` is static (Vite copies it) and points at the sitemap.

**Wiring:** add a `postBuild` phase to `amplify.yml` (currently absent) running the
script — it executes after `vite build` and before artifacts are collected from
`dist`. Failure there fails the build loudly rather than silently shipping a site
with no meta.

---

## Schema — `db/migrations/0008_blog.sql`

Mirrors `0007_events.sql` (RLS shape, `set_updated_at` trigger) and reuses the
existing `public.page_status` enum rather than defining a third draft/published type.

- `categories` — `id`, `slug` unique, `name`, `description`, `position`.
- `posts` — `id`, `slug` unique, `title`, `excerpt`, cover image as the standard
  `image_id`/`image_url`/`image_alt` trio used by `events`, `author_name`,
  `author_image_url`, `category_id` FK (`on delete set null`), `tags text[]`,
  `seo_title`, `seo_description`, `status`, `published_at`, `draft_blocks`,
  `published_blocks`, timestamps.
- `post_revisions` — same shape as `page_revisions`, written on publish.

**Tags as `text[]` + GIN, not a join table.** Tags here are a flat label set with no
attributes of their own; a join table would add two queries and a migration for
something `where tags @> ARRAY['rest']` answers directly.

**Blocks stored as JSONB draft/published columns**, exactly like `pages` — the whole
point of choosing Puck for the body is that posts reuse that machinery unchanged.

RLS: anon reads `status = 'published'` only; `service_role` gets explicit grants
(bypassing RLS is not the same as having privileges — see `0002_rls.sql`).

---

## Backend

New handlers following the `events.ts` / `admin-events.ts` shape (one Lambda per
file, dispatch on path):

- `backend/src/handlers/posts.ts` — public. `GET /posts` (paginated, optional
  `category`/`tag` filters), `GET /posts/{slug}`, `GET /categories`. Related posts
  resolved server-side: same category, excluding self, newest first, falling back to
  recent posts when the category is thin.
- `backend/src/handlers/admin-posts.ts` — admin CRUD plus `draft`/`publish`/
  `unpublish`/`revisions`/`restore`, mirroring `admin-pages.ts`.
- `backend/src/lib/cms-posts.ts` — validation, reusing `sanitizeRichText`/`stripTags`
  from `backend/src/lib/sanitize.ts` and `validateBlocks` from `cms-blocks.ts`.
- `backend/src/lib/slug.ts` — add `blog` to `RESERVED_SLUGS` so a CMS page can never
  shadow the blog routes.

**Rebuild on publish.** Prerendered meta is only correct if publishing triggers a
rebuild, and CDK does not manage the Amplify app. Create an Amplify incoming webhook
once (console/CLI), store the URL in a new Secrets Manager secret
`hilom/amplify-build-hook`, and have `admin-posts.ts` publish/unpublish POST to it
fire-and-forget — a failed webhook must never fail a publish that already succeeded,
same reasoning as the revision-insert warning in `admin-pages.ts`.

Two consequences to state plainly rather than paper over: a post goes live ~2 minutes
after Publish, not instantly; and publishing three posts in a row queues three builds.
Both are acceptable for a blog; neither is acceptable silently, so the admin UI should
say "Publishing — live in a couple of minutes".

Infra (`infra/lib/hilom-backend-stack.ts`): two `makeFn` + `cmsRoutes` entries
following the events wiring, `supabaseSecret.grantRead` on both, `adminKeySecret`
plus the new build-hook secret granted to the admin function only.

---

## Frontend

- `frontend/src/lib/cms.ts` — public `getPosts`/`getPost`/`getCategories` and the
  admin CRUD wrappers, using the existing `apiFetch` + `adminInit` helpers.
- `frontend/src/pages/Blog.tsx` (list, paginated, category/tag filter) and
  `frontend/src/pages/BlogPost.tsx` (renders `<BlockRenderer blocks={post.blocks} />`,
  byline, cover, tags, related strip).
- `frontend/src/App.tsx` — add `/blog`, `/blog/:slug`, `/blog/category/:categorySlug`
  **above** the `/:slug` catch-all, inside `<Layout>`.

**Category as a real route, tags as a query filter.** Category pages get prerendered
and are worth indexing; prerendering every tag combination is a combinatorial mess
with little SEO value.

Client-side `document.title`/meta updates still happen on navigation (the prerendered
head only covers the initial load), so in-app navigation keeps titles correct.

### Reusing the Puck editor

`frontend/src/pages/admin/PageEditor.tsx` is currently bound to page endpoints
(`adminGetPage`, `adminSaveDraft`, `adminPublishPage`, `adminListRevisions`,
`adminRestoreRevision`). Rather than duplicating ~250 lines of Puck wiring:

Parameterize it with a **resource adapter** — an object supplying `load`,
`saveDraft`, `publish`, `unpublish`, `listRevisions`, `restoreRevision` plus display
labels — and pass the pages adapter or the posts adapter. `puckConfig.tsx`,
`MediaField`, `TextListField` and `RichTextEditor` are already generic and need no
change; posts get the same block catalog for free.

`frontend/src/pages/Admin.tsx` gains a **Posts** tab (`/admin/posts`,
`/admin/posts/:postId`) alongside Pages/Events, plus post metadata fields (excerpt,
cover, byline, category, tags, SEO overrides) around the block editor.

---

## Phasing

1. **Spike the Amplify rewrite question** — ten minutes, decides everything below.
2. Migration + backend handlers + infra wiring; verify with curl.
3. Frontend routes and rendering; verify against seeded posts.
4. PageEditor adapter refactor (prove Pages still works untouched), then the Posts tab.
5. Prerender script, `postBuild` phase, sitemap + robots.
6. Build webhook + publish trigger, last — it is the only piece that changes existing
   publish behavior.

---

## Verification

- **Spike:** `curl -s https://www.hilomcollective.com/_spike | grep MARKER`.
- **Backend:** `curl $API/posts` (published only), `curl -o /dev/null -w '%{http_code}'
  $API/admin/posts` → 401 without the key; RLS proven by querying `posts` with the
  publishable key and confirming drafts are invisible.
- **The actual point of this work** — raw HTML, no JS:
  `curl -s https://www.hilomcollective.com/blog/some-post | grep -E 'og:title|og:image|canonical'`
  must show post-specific values, not the site defaults. Also paste the URL into
  Slack/LinkedIn's post-inspector and confirm the card renders.
- **No regression:** existing pages still resolve (`/`, `/about`, `/events`), and the
  Pages editor still saves/publishes after the adapter refactor.
- **Sitemap:** `curl -s .../sitemap.xml` lists every published page and post.
- Frontend `npm run build` + `npx oxlint src`, backend `npm run typecheck`,
  `npx cdk diff` shows only the two new functions and their routes.
