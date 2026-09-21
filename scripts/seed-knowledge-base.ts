/**
 * Seeds the help centre with its starting set of 60 articles.
 *
 *   HILOM_API_BASE=https://api.hilomcollective.com \
 *   HILOM_ADMIN_KEY=... npx tsx scripts/seed-knowledge-base.ts
 *
 * Add `--publish` to publish everything it writes. **Without that flag every
 * article lands as a draft**, which is the default on purpose: these are
 * written from the code — the refund ladder in `booking-domain.ts`, the
 * enrollment flow, the payout arithmetic — and the parts that describe *tone*
 * and *promise* rather than mechanism deserve a human read before they are the
 * official answer under the company's name.
 *
 * Re-running is safe. Articles and sections are matched by slug and updated
 * rather than duplicated, so this file is the source of truth for the starting
 * set and can be re-run after edits here. It does **not** delete anything, so
 * an article written in the admin is never clobbered by a re-run — but note
 * that editing an article in the admin and then re-running this script *will*
 * overwrite that edit. Once the content lives in the admin, retire the script
 * rather than keeping two sources.
 *
 * Terminology is deliberate and should stay consistent if you edit these:
 *   * "Hilom LMS" — never "Moodle", which is the implementation.
 *   * "SSO" / "sign in with Hilom" — never "Cognito".
 *   * "facilitator" — never "coach", "therapist" or "practitioner", none of
 *     which the platform claims about anyone.
 *
 * Accuracy notes, so an edit does not quietly make a promise the code will not
 * keep. Every one of these was read out of the source, not assumed:
 *   * Cancellation tiers are **per service** (0027). The facilitator sets them;
 *     the platform default is full refund at 24h and half at 12h. Articles say
 *     "your facilitator sets this, and the exact hours are shown before you
 *     confirm and again before you cancel" rather than naming 24/12 as a rule.
 *   * Cancelling a session booked from a **package** returns the credit and
 *     refunds nothing — the money was for the block, not the hour (0035).
 *   * A facilitator or admin cancellation is **always** a full refund.
 *   * The reschedule window is the same as the full-refund window.
 *   * A slot is held for **20 minutes** while payment completes.
 *   * Course access is **permanent** — no expiry.
 *   * Refunds and payouts are moved **by hand**; nothing here promises an
 *     automatic reversal or a same-day transfer.
 *
 * Added with group classes, facilitator-submitted events and reviews beyond
 * 1:1 sessions (0048-0050):
 *   * A group class's **minimum joiners is advisory**. Nothing in the code
 *     reads it to make a decision — a class below its minimum runs, and no
 *     cancellation or refund is triggered by a low turnout. Articles must not
 *     imply otherwise; clients read "runs with 3+" as a threshold unless told
 *     plainly that it is not.
 *   * **Maximum joiners is real.** The class sells out there.
 *   * A class seat is held for **20 minutes**, the same as a 1:1 slot, and a
 *     free class skips checkout entirely.
 *   * **One place per person per date.** Bringing someone means a second
 *     account and a second place.
 *   * A facilitator cancelling a class date is **always a full refund**,
 *     whatever the notice, and the facilitator's own cancellation tiers do not
 *     apply to it. The refund is issued **by hand** — the articles say "allow a
 *     few working days, chase after a week", which is a promise support has to
 *     be able to keep.
 *   * A client **cannot cancel their own class place**; there is no endpoint
 *     for it. They contact the facilitator.
 *   * A facilitator's event proposal is **invisible to everyone** until an
 *     admin approves it. There is no half-published state. Price, capacity and
 *     payment plans are set by Hilom, never by the proposer.
 *   * After approval a host may edit **only the joining link and
 *     instructions** — never the title, date or description, which are what
 *     attendees bought.
 *   * Reviews of 1:1s, events and classes all feed **one** rating per
 *     facilitator. There is no per-format score.
 *   * Only an event with a facilitator host can be reviewed. A Hilom-run event
 *     collects no rating, because there is no profile to attach it to.
 */
const API_BASE = process.env.HILOM_API_BASE ?? 'https://api.hilomcollective.com';
const ADMIN_KEY = process.env.HILOM_ADMIN_KEY;
const PUBLISH = process.argv.includes('--publish');

if (!ADMIN_KEY) {
  console.error('HILOM_ADMIN_KEY is not set. Read it from Secrets Manager: hilom/admin-api-key');
  process.exit(1);
}

type Kind = 'guide' | 'troubleshooting';
type Audience = 'client' | 'facilitator' | 'both';

interface SeedArticle {
  slug: string;
  title: string;
  summary: string;
  kind: Kind;
  audience: Audience;
  tags: string[];
  body: string;
}

interface SeedSection {
  slug: string;
  name: string;
  description: string;
  icon: string;
  articles: SeedArticle[];
}

interface KbCategory {
  id: string;
  slug: string;
  name: string;
  position: number;
}

interface KbArticle {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const SECTIONS: SeedSection[] = [
  // =========================================================================
  {
    slug: 'getting-started',
    name: 'Getting Started',
    description: 'Your account, and how Hilom fits together.',
    icon: 'compass',
    articles: [
      {
        slug: 'what-is-hilom-collective',
        title: 'What Hilom Collective offers',
        summary: 'Courses, one-to-one sessions, and live events — and how they differ.',
        kind: 'guide',
        audience: 'both',
        tags: ['basics'],
        body: `Hilom Collective offers three different things. They work differently, so it is worth knowing which one you are looking at.

## Courses

Self-paced online courses you buy once and work through in your own time. Course material lives on **Hilom LMS**, our learning platform. Once you have bought a course it is yours permanently — there is no expiry and no subscription.

## Sessions with a facilitator

One-to-one time with a facilitator you choose. You pick a person, pick a time from the slots they have open, and meet them online at that time. Some facilitators offer a free introductory call so you can see whether they are a good fit before paying for anything.

## Events

Live sessions, workshops and gatherings with a set date. You register for a place rather than booking a private time.

> Facilitators are independent practitioners who offer their work through Hilom. They set their own services, prices, hours and cancellation terms.

## Which one do I want?

- You want to work through something on your own schedule → a **course**
- You want someone to work with you directly → a **session**
- You want to join something happening at a set time → an **event**

You can use all three with one account.`,
      },
      {
        slug: 'creating-your-account',
        title: 'Creating your account and signing in',
        summary: 'How sign-in works, and why your course platform uses the same login.',
        kind: 'guide',
        audience: 'both',
        tags: ['account', 'sso'],
        body: `You need an account to buy a course, book a session, or register for an event.

## Creating an account

Choose **Join our community** or **Log in** in the site header. You will be asked for your email address and a password. You will receive a verification email — open it and follow the link to finish setting up.

If you buy a course before creating an account, one is created for you using the email you paid with. Check that inbox for a message telling you how to set your password.

## Signing in

Hilom uses single sign-on (SSO). That means one set of credentials works everywhere:

- The main Hilom Collective site, for bookings, events and receipts
- **Hilom LMS**, where your course material lives

You do not need a separate password for the learning platform. When you open a course, you are signed in automatically using the account you already have.

## Use the same email everywhere

The most common cause of "my course isn't showing up" is buying with one email address and signing in with another. If you have more than one address, pick one and use it consistently.

> If you think you have ended up with two accounts, contact us and we will merge them. Do not create a third.`,
      },
      {
        slug: 'your-account-dashboard',
        title: 'Your account dashboard',
        summary: 'Where to find your bookings, event registrations, receipts and details.',
        kind: 'guide',
        audience: 'client',
        tags: ['account'],
        body: `Once you are signed in, your account is at [hilomcollective.com/account](/account). It has a few sections.

## Overview

A summary of what is active — upcoming sessions, courses you own, and anything that needs your attention.

## Bookings

Every session you have booked, upcoming and past. This is where you:

- Join a session when it is time
- Reschedule or cancel
- Message your facilitator
- Fill in an intake form if your facilitator has asked for one
- Leave a review after a session
- See how many sessions are left in a package

## Registrations

Your event registrations, and the receipt for each one.

## Payments

Everything you have paid for, with receipts you can open or print.

## Details

Your name, email and contact information.

> Course material is not here — it lives on **Hilom LMS**. There is a link to it from your account and from the site header.`,
      },
    ],
  },

  // =========================================================================
  {
    slug: 'courses',
    name: 'Courses',
    description: 'Buying courses and getting into Hilom LMS.',
    icon: 'book',
    articles: [
      {
        slug: 'how-courses-work',
        title: 'How courses and bundles work',
        summary: 'What you get when you buy a course, and where the material lives.',
        kind: 'guide',
        audience: 'client',
        tags: ['courses'],
        body: `A course is self-paced. You buy it once, and you work through it whenever suits you.

## Where the material lives

Course content is on **Hilom LMS**, our learning platform. It is a separate site from the main one, but it uses the same sign-in — you do not need another password.

## What you get

- Every lesson in the course, available immediately
- Permanent access, with no expiry
- Your progress saved as you go, so you can stop and come back

## Single courses and bundles

Some products are a **single course**. Others are a **bundle** — one purchase that gives you access to several related courses at once, usually for less than buying them separately.

When you buy a bundle you are enrolled in each of the courses it contains. They appear separately in Hilom LMS, and you can work through them in any order.

## Before you buy

The course page lists what is included. If you are not sure whether a course or a bundle is right for you, ask us before buying — it is easier than sorting out a refund afterwards.`,
      },
      {
        slug: 'buying-a-course',
        title: 'Buying a course',
        summary: 'What happens at checkout, and what to expect afterwards.',
        kind: 'guide',
        audience: 'client',
        tags: ['courses', 'payment'],
        body: `## Buying

1. Open the course you want from [Courses](/courses)
2. Choose **Buy** or **Enrol**
3. Enter your details and pay

Payment is handled by PayMongo, our payment provider. You can pay by card and by the other methods shown at checkout.

## What happens next

Once your payment succeeds, three things happen, usually within a minute:

- Your order is recorded
- You are enrolled in the course on **Hilom LMS**
- You get a confirmation email with a link to start

If you did not have an account, one is created for you using the email you paid with.

> Use the same email you sign in with. Paying with one address and signing in with another is the single most common reason a course does not appear.

## If it takes longer than a few minutes

Your payment is recorded before enrolment is attempted, so a course that has not appeared is a delay, not a loss. See [I paid but my course isn't there](/help/courses/paid-but-course-missing).`,
      },
      {
        slug: 'course-bundles',
        title: 'Buying a bundle',
        summary: 'What a bundle actually enrols you in, and where to find each course.',
        kind: 'guide',
        audience: 'client',
        tags: ['courses'],
        body: `A bundle is one purchase that gives you several courses.

## What you are enrolled in

When you buy a bundle, you are enrolled in **each course the bundle contains** — not in a single combined course. Each one appears separately in **Hilom LMS**, with its own lessons and its own progress.

This sometimes surprises people who go looking for one course named after the bundle and do not find it. What you are looking for is the individual courses listed on the bundle's page.

## Working through it

There is no set order unless the course descriptions say otherwise. Start wherever makes sense for you.

## Access

The same as any course: permanent, with no expiry, for every course in the bundle.

> If you already own one of the courses in a bundle, contact us before buying — we can tell you whether the bundle still makes sense for you.`,
      },
      {
        slug: 'getting-into-your-course',
        title: 'Getting into your course',
        summary: 'How to open Hilom LMS and find what you bought.',
        kind: 'guide',
        audience: 'client',
        tags: ['courses', 'sso'],
        body: `Course material lives on **Hilom LMS**.

## Getting there

- Use the link in your confirmation email, or
- Choose **Login to Hilom Learning Hub** in the site header, or
- Open your [account overview](/account) and follow the link to your course

## Signing in

You are signed in automatically with the account you already use on the main site. You do not need a separate password.

The first time you go across, you may be asked to confirm — that is the two sites handing your session over to each other.

## Finding your course

Once you are in, your courses are listed on your dashboard. If you bought a bundle, each course it contains appears separately.

## If it does not work

- [I can't sign in to Hilom LMS](/help/courses/cant-sign-in-to-hilom-lms)
- [I paid but my course isn't there](/help/courses/paid-but-course-missing)`,
      },
      {
        slug: 'how-long-you-keep-access',
        title: 'How long you keep access',
        summary: 'Permanently. There is no expiry and no subscription.',
        kind: 'guide',
        audience: 'client',
        tags: ['courses'],
        body: `Course access is **permanent**.

There is no expiry date, no renewal, and no subscription. Once you have bought a course it stays in your account and you can come back to it whenever you like — a week later or two years later.

## What that means in practice

- You can work at whatever pace suits you
- You can stop and restart without losing progress
- Nothing lapses if you do not log in for a while

## The only exceptions

- If a purchase is refunded, access is removed along with it
- Very occasionally a course is retired and replaced. If that happens to something you own, we will tell you and make sure you keep access to the replacement

> We do not remove course access to encourage you to re-buy anything. If a course you own has disappeared, that is a fault — tell us and we will fix it.`,
      },
      {
        slug: 'paid-but-course-missing',
        title: "I paid but my course isn't there",
        summary: 'What to check first, and what to send us if it is still missing.',
        kind: 'troubleshooting',
        audience: 'client',
        tags: ['courses', 'payment'],
        body: `Your payment is recorded before enrolment is attempted, so if you have been charged, your purchase exists. Getting the course onto your account is something we can always complete by hand.

## Check these first

1. **Give it a few minutes.** Enrolment usually completes within a minute, but it can take longer.
2. **Check the email address.** Are you signed in with the same address you paid with? This is by far the most common cause. Your receipt shows which address was used.
3. **Sign out and back in.** On **Hilom LMS**, sign out fully and sign in again — an older session may not show a new enrolment.
4. **Check the whole dashboard.** If you bought a bundle, look for the individual courses it contains rather than the bundle name.

## If it is still missing

Contact us with:

- The email address you paid with
- The date of purchase and the course name
- Your receipt or order number, if you have it

Send that to [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com) and we will complete the enrolment manually. You will not be asked to pay again.

> Do not buy the course a second time to try to fix this. That creates a second charge we then have to refund.`,
      },
      {
        slug: 'cant-sign-in-to-hilom-lms',
        title: "I can't sign in to Hilom LMS",
        summary: 'What to try when the learning platform will not let you in.',
        kind: 'troubleshooting',
        audience: 'client',
        tags: ['courses', 'sso'],
        body: `**Hilom LMS** uses the same sign-in as the main site, so if you can sign in to one you should be able to sign in to the other.

## Try these in order

1. **Start from the main site.** Sign in at [hilomcollective.com](/) first, then use the **Login to Hilom Learning Hub** link in the header. Going directly to the learning platform can leave you at a login screen you do not have separate credentials for.
2. **Use the same email everywhere.** If you have more than one address, use the one your courses were bought with.
3. **Clear the old session.** Sign out on both sites, close the tab, and sign in again from the main site.
4. **Try a private window.** This rules out a stale cookie or an extension interfering.
5. **Check for a verification email.** A new account has to be verified before it can sign in.

## Do not create a second account

If sign-in is failing, making a new account with a different email will not help — your courses are attached to the first one, and you will then have two accounts to untangle.

## Still stuck

Email [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com) with the email address you are trying to use and, if you can, a screenshot of what you are seeing. Tell us which of the steps above you have tried.`,
      },
      {
        slug: 'course-progress-not-saving',
        title: 'My progress or a lesson is not loading',
        summary: 'Video will not play, progress is not saving, or a lesson looks blank.',
        kind: 'troubleshooting',
        audience: 'client',
        tags: ['courses'],
        body: `## Progress not saving

Progress is saved as you go, but it needs your session to still be active.

1. Make sure you are still signed in — a long gap can end the session
2. Finish a lesson properly rather than closing the tab mid-way
3. Reload the course page and check whether the lesson is now marked complete

If progress is being lost repeatedly, tell us which course and lesson.

## A lesson will not load or a video will not play

1. **Reload the page.** Most of the time this is all it takes.
2. **Try a different browser.** Chrome, Firefox and Safari are all supported.
3. **Turn off extensions.** Ad blockers and privacy extensions sometimes block embedded video.
4. **Check your connection.** Video needs a steady connection more than a fast one.
5. **Try another device.** If it works elsewhere, the problem is local to the first one.

## What to send us

If none of that helps, email [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com) with:

- The course and lesson name
- What you see instead of the lesson — a screenshot is ideal
- Your browser and device`,
      },
    ],
  },

  // =========================================================================
  {
    slug: 'sessions',
    name: 'Sessions & Booking',
    description: 'Booking, rescheduling, and joining your sessions.',
    icon: 'calendar',
    articles: [
      {
        slug: 'booking-a-session',
        title: 'Booking a session',
        summary: 'Choosing a facilitator and a time, and what happens after you pay.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking'],
        body: `## Choosing a facilitator

Browse [Facilitators](/facilitators) to see who is available. Each profile shows what they offer, how they work, their rates, and what other clients have said.

Take your time here. If a facilitator offers a free introductory call, that is the cheapest way to find out whether they are right for you.

## Booking

1. Open the facilitator's profile and choose a service
2. Pick a time from the slots shown
3. Enter your details and pay

Only times the facilitator is genuinely free are shown. The slots already account for their working hours, the gaps they keep between sessions, how far ahead they need notice, and anything already booked.

> Your slot is held for **20 minutes** while you complete payment. If payment is not finished in that time the slot is released for someone else.

## Times are shown in your timezone

Slots are shown in your own timezone, taken from your browser. Your confirmation email shows your time first, with your facilitator's beside it.

## After you book

You will get a confirmation email with the date, time and joining details, plus a calendar invitation. The session also appears under [your bookings](/account/bookings).`,
      },
      {
        slug: 'intro-calls',
        title: 'Free introductory calls',
        summary: 'A short, free conversation to see whether a facilitator is right for you.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking'],
        body: `Many facilitators offer a short introductory call at no cost.

## What it is for

It is a conversation to see whether you and the facilitator are a good fit — not a session. Expect to talk about what you are looking for and how they work, and to come away knowing whether you want to book properly.

## How to book one

If a facilitator offers one, it appears among their services and is marked as free. Book it the same way as any other session; you will not be asked to pay.

## One per facilitator

You can take one introductory call with each facilitator. If you want to speak to three different facilitators before choosing, that is completely reasonable and you can.

If you want to speak to the same facilitator again before committing, book a paid session or message them.

## Cancelling

Nothing was charged, so there is nothing to refund. Please still cancel if you cannot make it — the time goes back into their calendar for someone else.`,
      },
      {
        slug: 'session-packages',
        title: 'Multi-session packages',
        summary: 'Buying several sessions at once, and how the credits work.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking', 'payment'],
        body: `Some facilitators sell a block of sessions together rather than one at a time.

## What you are buying

A package is a **right to schedule**, not a set of appointments. When you buy one:

- You pay once, for the whole block
- **Nothing is scheduled yet**
- You book each session individually, whenever you are ready

This is the part that surprises people. If you buy a package and then wait for a calendar invitation, you will be waiting — the next step is yours.

## Booking your sessions

Go to [your bookings](/account/bookings). Your package is shown there with the number of sessions remaining. Book each one from your facilitator's available times as you go.

## Cancelling a session from a package

Cancelling returns the session **to your package** rather than refunding money. You keep the credit and can book it again whenever you like.

That is why cancelling a package session does not put anything back on your card — the money was for the block, not for that particular hour.

> If you want to cancel the whole package rather than one session from it, contact us. That is handled by hand.`,
      },
      {
        slug: 'intake-forms',
        title: 'Intake forms before your session',
        summary: 'Why your facilitator may ask you to fill in a form, and where to find it.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking'],
        body: `Some facilitators ask you to fill in a short form before your first session.

## Why

It is usually one of two things: understanding what you want to work on so the first session is not spent on background, or checking something that affects whether the work is safe and appropriate for you.

## Where to find it

Go to [your bookings](/account/bookings) and open the session. If there is a form to fill in, it is there.

Your reminder email will also mention it if it is still outstanding.

## Answer honestly

Where a question is asked for safety reasons, an incomplete answer is worse than an awkward one. Your facilitator is the only person who sees your answers.

## Changing your answers

You can update your answers up until the session. If something changes afterwards, tell your facilitator directly — [message them](/help/sessions/messaging-your-facilitator) rather than editing a form they have already read.`,
      },
      {
        slug: 'rescheduling-your-session',
        title: 'Rescheduling your session',
        summary: 'Moving a session to a new time, and the notice you need to give.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking'],
        body: `## How to reschedule

1. Go to [your bookings](/account/bookings)
2. Open the session you want to move
3. Choose **Reschedule** and pick a new time

Nothing is charged again. The new time comes from the same availability as any other booking, so you are only offered slots your facilitator is genuinely free for.

## The notice period

You can reschedule up until your facilitator's cut-off. That cut-off is set per service, and the exact figure is shown to you on the booking and in the reschedule screen.

If **Reschedule** is not offered, you are inside the cut-off.

## Inside the cut-off

Message your facilitator through [your bookings](/account/bookings). They can offer you a new time directly, and many will — but that is their call, not an entitlement, and it depends on their calendar.

## After rescheduling

Both of you get an email confirming the new time, and your calendar entry updates rather than a second one appearing.`,
      },
      {
        slug: 'a-suggested-new-time',
        title: 'When your facilitator suggests a new time',
        summary: 'What to do when you are asked to move a session you have booked.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking'],
        body: `Sometimes a facilitator needs to move a session and offers you a new time.

## Nothing moves until you accept

This is the important part. A suggested time is a **request**, not a change. Your original booking stays exactly where it is until you accept.

If you ignore the email, your session goes ahead at the time you originally booked.

## Accepting or declining

Go to [your bookings](/account/bookings) and open the session. You will see the current time, the suggested time, and any note your facilitator added.

- **Accept** and the session moves. Nothing is charged again.
- **Decline** and your session stays exactly as booked.

Declining is a completely reasonable thing to do. You booked a time; you are allowed to keep it.

## If neither time works

Decline, then message your facilitator to find something that does. You can also cancel under the normal terms — see [cancelling and refunds](/help/sessions/cancelling-and-refunds).`,
      },
      {
        slug: 'cancelling-and-refunds',
        title: 'Cancelling a session and what you get back',
        summary: 'How to cancel, and how much is refunded depending on notice.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking', 'refunds'],
        body: `## How to cancel

1. Go to [your bookings](/account/bookings)
2. Open the session
3. Choose **Cancel**

Before you confirm, you are told exactly what will be refunded. That figure is the one that will actually be applied.

## How much you get back

It depends on how much notice you give. Your facilitator sets the thresholds for each service, so they vary — but the shape is always the same:

- Cancel **early** and you are refunded in full
- Cancel **closer to the session** and you are refunded part of it
- Cancel **very close to the session** and there is no refund

The exact hours are shown on the service before you book, and again before you confirm the cancellation. They are never a surprise.

> The reason for the last tier is simple: an hour that is given up at short notice usually cannot be filled by someone else, and your facilitator has kept it free.

## Sessions from a package

Cancelling returns the session to your package instead of refunding money — you keep the credit. See [multi-session packages](/help/sessions/session-packages).

## Free introductory calls

Nothing was charged, so nothing is refunded. Please still cancel so the time is released.

## When the money arrives

Refunds are processed by hand rather than automatically. Allow a few working days for it to reach your account, and longer for it to appear on a card statement. If it has not arrived after that, [contact us](/help/help/contacting-support).`,
      },
      {
        slug: 'when-your-facilitator-cancels',
        title: 'When your facilitator cancels',
        summary: 'You are refunded in full, whatever the notice.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking', 'refunds'],
        body: `Facilitators are people with lives, and occasionally one has to cancel.

## You are refunded in full

If your facilitator cancels, you get **all of your money back**, regardless of how much notice was given. The tiered amounts that apply when you cancel do not apply here.

If the session came from a package, the credit goes back to your package.

## What happens

- You get an email telling you the session is cancelled
- The entry is removed from your calendar
- The refund is started

Refunds are processed by hand, so allow a few working days.

## Booking again

Your facilitator's availability is unchanged, so you can book a new time whenever you like. If they cancelled because they are away, their calendar will show that.

If you would rather see someone else, that is entirely reasonable — browse [Facilitators](/facilitators).

## If a facilitator cancels repeatedly

Tell us. We would rather know.`,
      },
      {
        slug: 'joining-your-session',
        title: 'Joining your session',
        summary: 'Where the meeting link is and when to expect it.',
        kind: 'guide',
        audience: 'client',
        tags: ['booking', 'meetings'],
        body: `Sessions happen online unless your facilitator has told you otherwise.

## Where the link is

The joining link is in three places:

- Your confirmation email
- Your reminder email the day before
- The session in [your bookings](/account/bookings)

The link in your bookings is always current, so if you have several emails about a session that has moved, use that one.

## Before you start

- Join a couple of minutes early
- Check your microphone and camera
- Find somewhere you will not be interrupted
- Use headphones if you can — it makes a real difference for both of you

## If there is no link

Some facilitators send joining details themselves rather than using an automatic link. If your booking says so, expect a message from them.

If you are close to the session and still have nothing, see [there's no meeting link](/help/sessions/no-meeting-link).

## If you are running late

Message your facilitator through your booking. They will usually wait, but the session still ends at its scheduled time.`,
      },
      {
        slug: 'messaging-your-facilitator',
        title: 'Messaging your facilitator',
        summary: 'How to reach them without swapping personal contact details.',
        kind: 'guide',
        audience: 'both',
        tags: ['messaging'],
        body: `Every booking has a message thread attached to it.

## Where it is

Open the session in [your bookings](/account/bookings). The conversation is on the booking itself, so it stays attached to the session it is about.

Facilitators reach it the same way, from their own dashboard.

## Why message here rather than by email

Neither of you has to hand over a personal address, and the whole conversation stays with the session — so when you are looking back at what was agreed, it is where you would expect it to be.

## Notifications

When someone writes, the other person gets an email containing the message itself, so you can read it without opening the site. Several messages sent in quick succession arrive as one email rather than several.

## What to use it for

- Practical things: running late, a change of circumstances, joining trouble
- Asking whether a different time might be possible
- Anything you want a record of

## What not to use it for

It is not monitored by Hilom, and it is not the place for anything urgent or for a crisis. If you need help immediately, contact a local emergency or crisis service.`,
      },
      {
        slug: 'leaving-a-review',
        title: 'Leaving a review',
        summary: 'How reviews work, what is shown publicly, and how to change yours.',
        kind: 'guide',
        audience: 'client',
        tags: ['reviews'],
        body: `After a session you will be asked how it went. Reviews help the next person decide.

## Leaving one

You can review three kinds of thing, and each is reached from where it lives:

- **A 1:1 session** — [your bookings](/account/bookings), open the past session
- **A group class** — [your account](/account/bookings), under **Group classes**
- **An event** — [your registrations](/account/registrations), open the event

Leave a rating and a few words. You can review each one once.

All three feed the **same rating** on that facilitator's profile. There is not a separate score for workshops and for 1:1s — the rating is of the person, and someone deciding whether to book them is served by one solid number rather than two thin ones.

We ask once and do not chase it. If you would rather not, that is fine.

## Some things cannot be reviewed

A session that was cancelled, because nothing happened. And an **event run by Hilom rather than by a facilitator** — there is no individual profile for the rating to land on. See [Reviewing an event](/help/events/reviewing-an-event).

## What is shown publicly

- Your **first name and last initial** — never your full name and never your email
- Your rating and your words
- Nothing else about you

## Reviews are read before they appear

Every review is read by us before it goes on a profile. That is to catch abuse and personal details, not to remove criticism. An honest, critical, fair review is exactly what the system is for, and it will be published.

## Changing or removing yours

You can change or remove your review at any time from the same place.

## If something went seriously wrong

A review is not the right channel for a safeguarding concern or anything that felt unsafe. [Contact us directly](/help/help/contacting-support) — we want to know, and we will take it seriously.`,
      },
      {
        slug: 'no-confirmation-email',
        title: "I didn't get a confirmation or reminder email",
        summary: 'Your booking is fine — here is how to check it and fix the email.',
        kind: 'troubleshooting',
        audience: 'both',
        tags: ['booking', 'email'],
        body: `A missing email does not mean a missing booking. The two are recorded separately, and the booking is the part that counts.

## Check the booking exists

Go to [your bookings](/account/bookings). If the session is listed, it is confirmed, and the joining details are there. You do not need the email.

## Why the email may not have arrived

1. **Check spam and promotions.** This is the usual answer.
2. **Search your inbox** for "Hilom" rather than scrolling — the email may be filed somewhere unexpected.
3. **Check the address on your account.** Open [your details](/account/details) and confirm it is right and current.
4. **Check with your email provider.** Work addresses in particular sometimes block outside senders.

## Add us to your contacts

Adding \`kumusta@hilomcollective.com\` to your contacts makes it much more likely that reminders arrive in your inbox.

## Still nothing

Tell us the email address on your account and roughly when you booked, and we will check whether the message was sent and what happened to it.`,
      },
      {
        slug: 'no-meeting-link',
        title: "There's no meeting link for my session",
        summary: 'Where to look, and what to do if there is genuinely nothing.',
        kind: 'troubleshooting',
        audience: 'both',
        tags: ['booking', 'meetings'],
        body: `## Check the booking first

Open the session in [your bookings](/account/bookings). The link there is always the current one — more reliable than an email, especially if the session has been moved.

## Some facilitators send links themselves

Not every session uses an automatically created link. If your booking says your facilitator will send joining details, expect a message from them rather than a link on the page.

## If there is nothing and the session is soon

**Message your facilitator through the booking.** They are told when an automatic link could not be created, so they may already be sorting it out — but a message from you makes sure.

Do this as soon as you notice rather than waiting until the session starts.

## If the link does not work

- Copy it into a different browser
- Check whether it wants you to sign in to a video service you are already signed in to with another account
- Try a private window

## If you missed a session because of this

Tell us. A session missed because there was no way to join is not a session you should be charged for, and we will sort it out.`,
      },
      {
        slug: 'session-time-looks-wrong',
        title: 'My session time looks wrong',
        summary: 'How timezones are handled, and what to check if something looks off.',
        kind: 'troubleshooting',
        audience: 'both',
        tags: ['booking', 'timezones'],
        body: `Times are shown in **your** timezone, taken from your browser or device when you booked.

## Every time we show you carries its zone

Confirmations and reminders show your time first and your facilitator's beside it, each labelled. If a time appears without a zone anywhere, tell us — that is a fault.

## Common causes of a mismatch

1. **Your device clock or timezone is wrong.** Check your system settings — everything follows from this.
2. **You booked while travelling,** or on a device set to a different zone from the one you will use.
3. **A daylight-saving change** falls between booking and the session. The gap between two zones is not fixed across the year.
4. **You are comparing a calendar entry to the site.** Your calendar app applies its own zone, which may not match your device.

## What to trust

[Your bookings](/account/bookings) is the authoritative version, shown in your current timezone. If your calendar and the site disagree, the site is right.

## If it is still wrong

Message your facilitator to confirm the time you both think it is — a two-line exchange beats turning up an hour out. Then tell us, with what you see and what you expected.`,
      },
      {
        slug: 'group-classes',
        title: 'Group classes',
        summary: 'Joining a class several people attend at once, and what the joiner numbers mean.',
        kind: 'guide',
        audience: 'client',
        tags: ['classes', 'booking'],
        body: `A group class is one session several people attend together, online or in a room. It is a different thing from a 1:1 session: the time is already set, there is a cap on how many can come, and you are joining a group rather than booking someone's hour.

## Finding one

Group classes appear on a facilitator's profile, under **Group classes**, with the next few dates and how many places are left on each. Pick a date and choose **Join**.

## Booking a place

You will need to be signed in. A place is held for **20 minutes** while you pay, which is long enough for a QR payment to clear. If you do not finish paying in that time the place goes back to the pool and you can try again.

Free classes have no payment step — your place is confirmed straight away.

You can hold one place per date. If you want to bring someone, they need their own account and their own place.

## What "runs with 3+" means

Some classes show a minimum, like *runs with 3+*. That is the facilitator telling you the number they had in mind, and nothing more.

**It is not a threshold that cancels the class.** A class with fewer people than its minimum still goes ahead. Nothing is called off automatically and no refund is triggered by a low turnout. If a class is ever cancelled it is because the facilitator decided to cancel it, and you will be told.

## Joining on the day

For an online class the joining link is on [your account](/account/bookings), under **Group classes**, once your place is confirmed. It is never on the public page — only people who have a place can see it.

For a class in a room, the venue is on the class listing and in your confirmation.

## Afterwards

Once the class has happened you can leave a review of the facilitator from the same place. See [Leaving a review](/help/sessions/leaving-a-review).`,
      },
      {
        slug: 'if-a-class-is-cancelled',
        title: 'If a group class is cancelled',
        summary: 'What happens to your place and your money when a class is called off.',
        kind: 'troubleshooting',
        audience: 'client',
        tags: ['classes', 'refunds'],
        body: `Sometimes a facilitator has to call off a date. Here is what happens.

## Your place

The class is marked cancelled and your place is released. You do not need to do anything, and you are not charged again.

You will see it on [your account](/account/bookings) under **Group classes**, marked cancelled, with what you are owed.

## Your money

**You get a full refund.** A facilitator cancelling a class is always a full refund, whatever the notice — the same rule as when a facilitator cancels a 1:1 session.

Refunds at Hilom are issued **by a person, not automatically**. That is worth saying plainly, because it is the part that does not work the way an online purchase usually does: nothing reverses the moment the class is cancelled. Allow a few working days for it to reach the card or account you paid from.

If it has not arrived within a week, [email us](/help/help/contacting-support) and we will find it.

## A class that was free

Nothing was charged, so there is nothing to refund.

## If you would rather rebook than be refunded

Message the facilitator. If they are running the class again, they may be able to move you onto another date — but that is a conversation with them, not something the site does. The refund happens either way unless you tell us otherwise.

## If you cannot make a date you booked

That is the other direction, and it works differently: contact the facilitator. A class place is not self-service cancellable, and whether you are refunded is theirs to decide.`,
      },
    ],
  },

  // =========================================================================
  {
    slug: 'events',
    name: 'Events',
    description: 'Registering for live events and workshops.',
    icon: 'ticket',
    articles: [
      {
        slug: 'finding-and-registering',
        title: 'Finding and registering for an event',
        summary: 'How to browse events and book a place.',
        kind: 'guide',
        audience: 'client',
        tags: ['events'],
        body: `Events are live sessions with a set date — workshops, gatherings and group sessions.

## Finding one

Browse [Events](/events). Each listing shows the date, time, who is facilitating, what it covers, and the price.

## Registering

1. Open the event
2. Choose your ticket, if there is more than one type
3. Enter your details and pay

Free events still need registration so we know how many people to expect.

## After you register

You will get a confirmation email with the details and, where relevant, the joining link. Your registration also appears under [your registrations](/account/registrations).

## Places are limited

Most events have a cap. A place is yours once payment is complete — until then it is not held indefinitely, so if an event is filling up, do not leave checkout half-finished.

## Bringing someone

Register them separately with their own details, so they get their own joining details and we know who is attending.`,
      },
      {
        slug: 'your-event-registration',
        title: 'Managing your registration',
        summary: 'Finding your ticket, your receipt, and the joining details.',
        kind: 'guide',
        audience: 'client',
        tags: ['events'],
        body: `## Where it lives

Go to [your registrations](/account/registrations). Every event you have registered for is listed there, upcoming and past.

Open one to see:

- The date, time and joining details
- Your ticket
- Your receipt

## Joining an online event

The link is on the registration and in your confirmation email. The one on the registration is always current, so use that if the details have changed.

## If you cannot attend

Event terms vary — the event page says what applies. As a rule, the earlier you tell us the better the chance of a refund or a transfer.

Contact us rather than simply not turning up, particularly for small events where your place could go to someone else.

## Recordings

Some events are recorded and some are not; the event page says which. Where there is a recording, we will tell you how to reach it afterwards.`,
      },
      {
        slug: 'event-registration-problem',
        title: "My event registration didn't go through",
        summary: 'What to check when payment succeeded but the registration is missing.',
        kind: 'troubleshooting',
        audience: 'client',
        tags: ['events', 'payment'],
        body: `## Check your registrations first

Open [your registrations](/account/registrations). If the event is listed, you have a place — regardless of whether the email arrived.

## If it is not listed

1. **Check the email you used.** Registering with one address and signing in with another is the usual cause.
2. **Check whether you were actually charged.** Look at [your payments](/account/payments) and at your bank. A declined payment means the registration was never completed.
3. **Give it a few minutes** and reload.

## If you were charged but have no place

Contact us straight away, especially if the event is soon. Send:

- The email address you paid with
- The event name and date
- Your receipt or the amount and date of the charge

Email [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com). We will either confirm your place or refund you.

> Do not register a second time. That is a second charge to refund, and for a capped event it may take a place that someone else could have had.`,
      },
      {
        slug: 'reviewing-an-event',
        title: 'Reviewing an event you attended',
        summary: 'Leaving a review after an event, and why some events cannot be reviewed.',
        kind: 'guide',
        audience: 'client',
        tags: ['events', 'reviews'],
        body: `Once an event is over you can review the facilitator who ran it.

## Leaving one

Open the event on [your registrations](/account/registrations). Below the status you will find the review panel — a rating and a few words.

It counts towards that facilitator's rating in exactly the same way a 1:1 review does. There is one rating per facilitator, not one per format: someone deciding whether to book them is served by knowing how their workshops went too.

## Some events cannot be reviewed

If there is no review panel, one of two things is true and the page will say which.

**The event has not happened yet.** You can review it once it is over.

**The event was run by Hilom rather than by a facilitator.** Some events have no individual host — there is no profile for a rating to land on, so there is nothing to review. That is not a fault, and it does not mean we are not interested in how it went: [tell us directly](/help/help/contacting-support).

## Everything else works the same way

What is shown publicly, the fact that reviews are read before they appear, and how to change yours are all covered in [Leaving a review](/help/sessions/leaving-a-review).`,
      },
    ],
  },

  // =========================================================================
  {
    slug: 'payments',
    name: 'Payments & Refunds',
    description: 'How you pay, where receipts live, and how refunds work.',
    icon: 'card',
    articles: [
      {
        slug: 'how-you-can-pay',
        title: 'How you can pay',
        summary: 'Payment methods, currency, and card security.',
        kind: 'guide',
        audience: 'client',
        tags: ['payment'],
        body: `Payments are handled by **PayMongo**, our payment provider.

## What you can use

The methods available are shown at checkout. These typically include cards and the local payment options PayMongo supports. What is offered can vary by product.

## Currency

Prices are in Philippine pesos (PHP) unless a page says otherwise. If your card is in another currency, your bank converts it at their rate and may add a fee — that part is between you and your bank.

## Card security

Your card details go directly to PayMongo. **Hilom never sees or stores your card number.** We keep a record of what you bought and what it cost, not how you paid for it.

## When you are charged

Once, at the point of purchase. There are no subscriptions and nothing recurring, so nothing will be taken later without you doing something.

## Receipts

Every payment produces a receipt in [your payments](/account/payments).`,
      },
      {
        slug: 'finding-your-receipts',
        title: 'Finding your receipts',
        summary: 'Where receipts live and how to get one for expenses.',
        kind: 'guide',
        audience: 'client',
        tags: ['payment'],
        body: `## Where they are

Go to [your payments](/account/payments). Everything you have paid for is listed with a receipt you can open.

Event receipts also appear on the registration itself, under [your registrations](/account/registrations).

## What a receipt shows

- What you bought
- The amount and currency
- The date
- The payment reference

## Printing or saving one

Open the receipt and use your browser's print function. Most browsers can save to PDF from the same dialogue.

## For expenses or reimbursement

The receipt in your account is a valid record of payment. If your employer needs something more formal, or needs particular details on it, [tell us what is required](/help/help/contacting-support) and we will see what we can do.

## A payment you do not recognise

Check whether it might be under a different email address you use. If you still do not recognise it, contact us with the date and amount — do not wait.`,
      },
      {
        slug: 'refunds-explained',
        title: 'How refunds work',
        summary: 'Courses, sessions and events each work differently.',
        kind: 'guide',
        audience: 'client',
        tags: ['payment', 'refunds'],
        body: `Refunds work differently depending on what you bought.

## Sessions

Refunds depend on how much notice you give, and the thresholds are set by your facilitator per service. Cancel early and you are refunded in full; closer in, partly; very close, not at all. The exact amount is shown before you confirm.

If your **facilitator** cancels, you are refunded in full whatever the notice.

Full detail: [cancelling a session](/help/sessions/cancelling-and-refunds).

## Sessions from a package

Cancelling returns the session to your package rather than refunding money. See [multi-session packages](/help/sessions/session-packages).

## Courses

Course access is permanent and granted immediately, so course purchases are not automatically refundable. If something has gone wrong — you bought the wrong thing, you were charged twice, the course is not what was described — contact us. We would rather sort it out than have you stuck with something you cannot use.

## Events

Terms vary by event and are shown on the event page. Tell us as early as you can.

## How refunds are paid

By hand, back to the original payment method. Allow a few working days for us to process it and for your bank to post it — card statements are often the slowest part.

If a refund you were promised has not arrived after that, [chase us](/help/help/contacting-support). We would rather be asked.`,
      },
      {
        slug: 'payment-declined',
        title: 'My payment was declined',
        summary: 'Why cards get refused, and what to try next.',
        kind: 'troubleshooting',
        audience: 'client',
        tags: ['payment'],
        body: `A declined payment means no money moved. You have not been charged, and nothing has been booked.

## Common causes

1. **Your bank blocked it.** Online or international payments are often refused by default. A quick call or an approval in your banking app usually fixes it.
2. **A detail is wrong.** Card number, expiry, security code, or a billing address that does not match your bank's records.
3. **Insufficient funds**, or a daily limit reached.
4. **The card does not support online payments.** Some debit and prepaid cards do not.

## What to try

- Re-enter the details carefully
- Try a different card
- Try one of the other payment methods at checkout
- Contact your bank and ask why it was refused — they can see a reason we cannot

> If you tried several times, you may see several **pending** amounts on your account. Those are authorisations, not charges, and they fall away on their own. See [I think I was charged twice](/help/payments/charged-twice).

## If a slot was being held

A session slot is held for 20 minutes while you pay. If that ran out, the slot was released — book again once your payment method is working.

## Still failing

Tell us what you are buying, which method you tried, and any message you saw. We cannot see your bank's reason, but we can check things from our side.`,
      },
      {
        slug: 'charged-twice',
        title: 'I think I was charged twice',
        summary: 'Telling a real double charge from a pending authorisation.',
        kind: 'troubleshooting',
        audience: 'client',
        tags: ['payment', 'refunds'],
        body: `## Check whether it is pending

A failed or retried payment often leaves a **pending** amount on your account. That is your bank holding funds against an authorisation, not a charge. Pending amounts usually disappear within a few working days without anyone doing anything.

Look for the word "pending", "authorisation" or "hold" in your banking app.

## Check your payments

Open [your payments](/account/payments). If only one payment is listed there, only one was taken — whatever your bank is showing is likely a pending authorisation.

## If there really are two

If two completed payments show for the same thing, contact us. Send:

- The email address on your account
- The two amounts and their dates
- What you were buying

Email [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com).

We will refund the duplicate. Refunds are processed by hand, so allow a few working days, and a little longer for a card statement to catch up.

> Contact us before raising a chargeback with your bank. A chargeback takes weeks and can suspend your account while it is investigated; we can usually resolve it in a fraction of the time.`,
      },
    ],
  },

  // =========================================================================
  {
    slug: 'for-facilitators',
    name: 'For Facilitators',
    description: 'Running your practice on Hilom.',
    icon: 'leaf',
    articles: [
      {
        slug: 'applying-to-join',
        title: 'Applying to join as a facilitator',
        summary: 'What the application asks for and what happens after you send it.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['applying'],
        body: `Hilom is a curated roster rather than an open directory, so every application is read by a person.

## Applying

Fill in the form at [Facilitate with us](/facilitators/apply). You will be asked for:

- Who you are and how to reach you
- What you offer and who you work with
- Your background, training and any relevant credentials
- Supporting documents, where you have them

Take the scope-of-practice questions seriously. We check claims against credentials, and it is much better to describe your work accurately than to over-claim and be turned down for it.

## What happens next

1. **We read it.** This takes a little time — a person is doing it.
2. **We may come back with questions.**
3. **You are approved, or you are not.** Either way we tell you.

## If you are approved

You get access to your facilitator dashboard, where you set up your profile, services and availability. **You are not yet visible to clients** — see [going live](/help/for-facilitators/going-live).

## If you are not

We will say so. It is not always permanent — if it is about something that can change, you are welcome to apply again later.`,
      },
      {
        slug: 'setting-up-your-profile',
        title: 'Setting up your profile',
        summary: 'What clients see, and what makes a profile people actually book.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['profile'],
        body: `Your profile is where someone decides whether to book you. Give it a proper hour.

## Where to edit it

Your facilitator dashboard, under **Profile**.

## What to fill in

- **Photo.** A clear, warm, recent one of your face. Upload it straight from your phone or computer — or paste a link if it is already hosted somewhere. It is shown as a circle, so centre yourself. This matters more than people expect.
- **Headline.** One line on what you do and who for. Specific beats impressive.
- **Bio.** How you work, what a session is like, who you are a good fit for. Write to the person reading, not to a hiring panel.
- **Credentials and training.** Accurate and verifiable.
- **Specialties.** What you actually work with.
- **Languages** you can hold a session in.
- **Location and delivery.** Where you are, and whether you work online, in person, or both.
- **Scope note.** What you do *not* do. This is not a weakness; it is how the right people find you and the wrong enquiries stop arriving.

## Writing a bio that works

Say what someone can expect from an hour with you. Name the kinds of things you help with in plain words. Avoid jargon that only your training recognises.

> A short honest profile outperforms a long impressive one. People book someone who sounds like they will understand them.`,
      },
      {
        slug: 'creating-your-services',
        title: 'Creating your services',
        summary: 'Setting up what you offer, including intro calls and packages.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['services'],
        body: `A service is one thing someone can book. Most facilitators have between two and four.

## Creating one

Your dashboard, under **Services**. For each one, set:

- **Title and description.** What it is and who it is for.
- **Length**, in minutes.
- **Price.**
- **Scheduling rules** — see [setting your availability](/help/for-facilitators/setting-your-availability).
- **Cancellation terms** — see [your cancellation terms](/help/for-facilitators/your-cancellation-terms).
- **How you meet** — see [connecting your video account](/help/for-facilitators/connecting-your-video-account).

## Kinds of service

**Introductory call.** Free, short, and limited to one per client. The most effective thing you can offer: it lowers the barrier to a first conversation, and it lets you decline work that is not right for you before anyone has paid.

**Standard session.** Your ordinary paid session.

**Package.** A block of sessions sold together. The client buys the block and books each session as they go. See [selling packages](/help/for-facilitators/selling-packages).

## Keep the list short

Three clear services get booked more than eight overlapping ones. If you cannot explain the difference between two of them in a sentence, merge them.`,
      },
      {
        slug: 'selling-packages',
        title: 'Selling packages',
        summary: 'How packages are paid, and when you actually earn each session.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['services', 'money'],
        body: `A package is a block of sessions sold together — useful for structured work that only makes sense over several sessions.

## Setting one up

Create a service of the package kind. Set the number of sessions and the price for the whole block. A package needs at least two sessions.

## How the client experiences it

They pay once, and **nothing is scheduled**. They then book each session individually from your availability as they go.

## How you earn it

This is the part worth understanding: the package price is split across its sessions, and **you earn each share as that session is delivered** — not all of it on purchase.

The reason is protective on both sides. If a client takes two of six sessions and stops, you have earned two. Paying out all six on purchase would mean a refund later has to be clawed back from money you have already been sent.

## Cancellations

A client cancelling a package session gets the credit back, not money. Your hour is freed and their credit is restored.

## Pricing

Packages usually carry a modest discount against the same number of single sessions. That is a choice, not a requirement.`,
      },
      {
        slug: 'setting-your-availability',
        title: 'Setting your availability',
        summary: 'Working hours, gaps between sessions, notice, and how far ahead people can book.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['availability'],
        body: `Your availability decides which slots clients are offered. It is worth getting right early — an empty calendar is more often a configuration problem than a demand problem.

## Weekly hours

Set the hours you work on each day, in your own timezone. Clients see these converted to theirs.

## Per-service rules

Each service has its own:

- **Buffer.** Time kept free either side of a session, so you are not booked back to back.
- **Minimum notice.** How far ahead someone must book. Stops a stranger appearing in your calendar in twenty minutes.
- **Advance window.** How far into the future bookings can be made.
- **Daily cap.** The most sessions of this kind you will take in one day.

## Blackouts

Block out individual dates and times — a holiday, an appointment, a day you need clear.

## Check what clients actually see

The Availability tab has a **What clients see** panel that shows the real slots produced by your settings. Use it.

> If it shows nothing, the usual cause is two rules that are individually reasonable and jointly impossible — a long notice period with a short advance window, or a buffer that does not fit your working block. The panel will tell you which rule is emptying your week.`,
      },
      {
        slug: 'your-cancellation-terms',
        title: 'Your cancellation terms',
        summary: 'Setting the notice periods, and how they are actually applied.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['services', 'refunds'],
        body: `You set your own cancellation terms, per service.

## What you set

Two thresholds:

- **Full refund window.** Cancel with at least this much notice and the client is refunded in full.
- **Partial refund window.** Cancel with at least this much notice and the client is refunded part of it. Inside that, there is no refund.

The platform default is a full refund at 24 hours and a partial one at 12.

## What the client sees

The terms you set are shown on your service before booking, and again in the cancellation dialogue with the exact amount that will be refunded.

The wording clients read is generated from the same two numbers the refund is calculated from, so what you promise and what is paid cannot drift apart.

## The same window governs rescheduling

A client can reschedule up to your full-refund threshold. Inside it, they have to ask you — which comes to you as a message, and the decision is yours.

## Choosing your numbers

Longer windows protect your calendar; shorter ones are easier for clients to say yes to. Most facilitators sit between 24 and 48 hours. Think about how likely you are to fill a cancelled hour at short notice.

## When you cancel

Your client is refunded **in full**, whatever the notice. See [cancelling and no-shows](/help/for-facilitators/cancellations-and-no-shows).`,
      },
      {
        slug: 'going-live',
        title: 'Going live in the directory',
        summary: 'What publishing means and what to have ready first.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['profile'],
        body: `Being approved and being visible are two different things.

## Approved

You can sign in and set everything up. **Clients cannot see you or book you yet.**

## Published

Your profile is in the [directory](/facilitators), you appear in search, and clients can book you.

## What to have ready before you publish

- A complete profile with a photo, a real bio and accurate credentials
- At least one service, priced
- Availability set, with the **What clients see** panel showing actual slots
- A way to meet — a connected video account or a link of your own

We check these before publishing. It is not a formality: a published profile that cannot be booked wastes the visit of everyone who finds it.

## Asking to be published

Tell us when you are ready. We will look over your profile and publish it, or come back with the one or two things still missing.

You will get an email when you go live.

## Afterwards

You can keep editing. Changes appear straight away. If you need to step back temporarily, use [vacation mode](/help/for-facilitators/time-off) rather than deleting your services.`,
      },
      {
        slug: 'managing-your-bookings',
        title: 'Managing your bookings',
        summary: 'Your calendar, upcoming sessions, and what you can do to each one.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['bookings'],
        body: `Your dashboard's **Bookings** tab is your working calendar.

## What you see

Every session, upcoming and past, with the client, the service, the time in your timezone with theirs beside it, and the joining link.

## What you can do

- **Join** the session
- **Message the client**
- **Suggest a new time** — see [suggesting a new time](/help/for-facilitators/suggesting-a-new-time)
- **Cancel** — see [cancellations and no-shows](/help/for-facilitators/cancellations-and-no-shows)
- **Mark a no-show** after the fact
- **Read their intake answers**, if you use a form

## New bookings

You get an email as soon as one is made, with the client, the time in both zones, and the joining link. A calendar invitation comes with it.

## Reminders

Both you and your client get a reminder the day before.

## Keeping it in your own calendar

You can subscribe to a private feed so your Hilom sessions appear alongside everything else. See [your calendar feed](/help/for-facilitators/your-calendar-feed).`,
      },
      {
        slug: 'your-clients',
        title: 'Your clients and session notes',
        summary: 'Keeping a history and private notes for people you see more than once.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['clients'],
        body: `The **Clients** tab collects everything about one person in one place, rather than leaving each booking as an island.

## What it holds

- Every session you have had with them, with dates
- Every event of yours they attended
- A standing note about them, which you maintain
- Private notes per session

## Clients and attendees are counted separately

Someone who books you 1:1 and someone who came to one of your workshops both appear here, but the card keeps them apart — *3 sessions · 1 event* rather than a single total.

That is deliberate. They are not the same relationship, and a facilitator who writes to the whole list as though everyone on it were a regular 1:1 client will strike the wrong note with half of them.

## Your notes are private

Session notes are **yours**. Clients never see them, and they are not part of anything shown to anyone else.

Two facilitators seeing the same person keep entirely separate records. There is no shared client file.

## What to write

Whatever makes the next session better — what you covered, what to return to, what to avoid.

## Your responsibilities

These notes are personal data about a real person, and you are responsible for what you write:

- Write what is professionally necessary, not everything you can remember
- Assume you may one day have to justify a note to the person it is about
- Follow whatever your own professional body requires of you

> If you are bound by a professional code with its own record-keeping requirements, that code governs. This tab is a convenience, not a compliance system.`,
      },
      {
        slug: 'suggesting-a-new-time',
        title: 'Suggesting a new time',
        summary: 'How to ask a client to move a session you cannot make.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['bookings'],
        body: `If you need to move a session, you can offer the client a different time.

## It is a request, not a change

You cannot move a client's booked session yourself. You propose a time; **nothing changes until they accept**. Their original booking stands in the meantime.

This is deliberate. Moving someone's committed hour without their agreement is a different act from moving your own.

## How

Open the booking, choose to suggest a new time, pick one from your availability, and add a note explaining why. The note matters — "something has come up on the 14th" reads very differently from a bare request.

## What happens

- They get an email showing the current time, your suggested time, and your note
- They accept, and the session moves — nothing is charged again
- Or they decline, and the session stays as booked

You are told either way.

## If they decline

Their original time stands and you need another plan for it. Message them if a different time might work.

## If you genuinely cannot make it

Cancel. The client is refunded in full. See [cancellations and no-shows](/help/for-facilitators/cancellations-and-no-shows).`,
      },
      {
        slug: 'cancellations-and-no-shows',
        title: 'Cancelling a session and marking a no-show',
        summary: 'What happens to the money in each case.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['bookings', 'money'],
        body: `## When you cancel

The client is refunded **in full**, whatever the notice. The tiers you set apply to *their* cancellations, not yours.

You earn nothing from a session you cancel.

Cancel from the booking. Your client is emailed and the entry is removed from both calendars. Message them as well if there is anything worth saying.

## When the client cancels

They are refunded according to your terms. Where they are inside your windows, you keep the corresponding share.

## No-shows

If a client does not attend and did not cancel, mark the booking as a no-show.

**A no-show is still paid.** You kept the hour free and were there. Marking it correctly is what makes the payout right.

## Be fair about it

Before marking a no-show, check your messages — someone who emailed you an hour before with an emergency is a different case from someone who simply did not appear. You are free to cancel instead and refund them; that is your call.

> A no-show remains reviewable by the client. That is deliberate: excluding it would make ratings a measure of sessions that went well rather than of a practice.`,
      },
      {
        slug: 'earnings-and-payouts',
        title: 'Earnings and payouts',
        summary: 'How your share is calculated and when the money reaches you.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['money', 'payouts'],
        body: `## What you earn

Hilom takes a percentage of each session. Your rate is agreed with you and shown in your dashboard.

For each session:

- **Gross** — what the client paid
- minus **Hilom's platform fee**
- minus the **payment processing cost**
- = **your share**

The split is recorded on each booking at the time it is taken, so a later change to your rate never alters what you have already earned.

## When you earn it

When the session is **delivered**, not when it is booked. A future booking is not yet earnings. For a package, you earn each session's share as that session happens.

## The Earnings tab

Shows what you have earned this period and what is awaiting payout.

## Getting paid

Payouts are made by **bank transfer, by hand**, in batches. When one is sent you get an email showing the same arithmetic as your Earnings tab — gross, each deduction, and the amount transferred — plus a reference.

Bank transfers usually arrive within one to three working days.

## Your bank details

Under **Profile**. Keep them current: wrong details are the most common reason a payout is delayed.

## If a payout has not arrived

Give it three working days from the email, then reply to it. If your Earnings tab shows an amount awaiting payout for longer than a full cycle, ask us.

> Sessions you book in manually for someone who paid you directly earn **zero** through Hilom, by design — Hilom cannot pay out money it never collected.`,
      },
      {
        slug: 'connecting-your-video-account',
        title: 'Connecting your video account',
        summary: 'Google Meet, Zoom, or your own link — and why a backup matters.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['meetings'],
        body: `Every service needs a way for the client to join.

## Your options

**Google Meet** — connect your Google account and a meeting is created in it for each booking.

**Zoom** — connect your Zoom account and a meeting is scheduled for each booking. Rescheduling updates it; cancelling removes it.

**Your own link** — a room of your own that you reuse. Simplest, but the same link for everyone.

Set this per service, under **Connections** and on each service.

## Set a backup link

Even with an account connected, add a manual link to the service as a backup.

Automatic creation can fail — an expired connection, an outage at the provider. When it does and there is a backup, the booking simply uses it and nobody notices. Without one, you get an email telling you to send a link by hand before the session.

It costs a minute now and saves a scramble later.

## Check the connection

The **Connections** tab shows whether each account is still healthy. Connections expire, particularly if you change your password at the provider.

## If a connection breaks

See [my video account disconnected](/help/for-facilitators/video-account-disconnected).`,
      },
      {
        slug: 'time-off',
        title: 'Taking time off',
        summary: 'Vacation mode, blackouts, and sessions already booked in your break.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['availability'],
        body: `## Vacation mode

Set a date under **Profile** and no new bookings can be made up to it. Your profile stays visible, so you are not starting from nothing when you come back.

## Blackouts

For a single afternoon or a couple of days, block those dates on the Availability tab instead. Vacation mode is for a real break.

## Sessions already booked in your break

**This is the part to check.** Vacation mode stops *new* bookings. It does nothing about sessions already in that window.

Before you go, open your Bookings tab, look through the dates you will be away, and deal with anything already there — suggest a new time, or cancel with a full refund. Do it early enough that your client can rearrange.

## Coming back

Clear the vacation date, or let it pass. Your availability resumes as it was.

## Stepping back for longer

If you need an indefinite break, tell us and we can unpublish your profile. Your account, services and history are kept, and republishing later is simple.

> Do not delete your services to make yourself unbookable. Vacation mode does the same job without losing your setup.`,
      },
      {
        slug: 'your-calendar-feed',
        title: 'Your calendar feed',
        summary: 'Seeing Hilom sessions alongside the rest of your calendar.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['bookings'],
        body: `You can subscribe to a private feed of your confirmed sessions so they appear in whatever calendar you already use.

## Getting the link

Your dashboard, under **Bookings** or **Profile**, as a calendar subscription URL.

## Adding it

- **Google Calendar** — Other calendars → From URL
- **Apple Calendar** — File → New Calendar Subscription
- **Outlook** — Add calendar → Subscribe from web

Look for "subscribe" rather than "import". Importing takes a one-time copy that never updates.

## What it does

- New bookings appear
- Rescheduled sessions move
- Cancelled sessions are marked cancelled rather than silently vanishing

Calendar apps refresh subscriptions on their own schedule, often hourly, so it is not instant. **Your Bookings tab is always the authoritative version.**

## Keep the link private

It is signed and personal to you. Anyone who has it can see your session times and client names. Do not post it anywhere or share it.

If you think it has leaked, tell us and we will issue a new one.`,
      },
      {
        slug: 'video-account-disconnected',
        title: 'My video account disconnected',
        summary: 'Reconnecting Google or Zoom, and covering sessions in the meantime.',
        kind: 'troubleshooting',
        audience: 'facilitator',
        tags: ['meetings'],
        body: `Connections expire. It usually means a password change or a revoked permission at the provider, not a fault.

## Reconnect

1. Open **Connections** in your dashboard
2. Find the account marked as needing attention
3. Reconnect and approve the permissions again

## Cover the sessions in between

While the connection was down, bookings may have been made without a link. Check your upcoming sessions:

- If a session has a link, it is fine
- If it does not, message the client with joining details

You will have been emailed about any booking where link creation failed and there was no backup.

## Stop it mattering next time

**Add a backup link to each service.** When automatic creation fails and a backup exists, the booking uses it and nobody notices. This is the single most useful thing you can do here.

## If reconnecting fails

- Sign in to Google or Zoom directly first, then try again
- Try a private window, in case you are signed in to a different account
- Check that your provider account still has permission to create meetings

If it still will not connect, tell us which provider and what you see. In the meantime, set a manual link on your services so bookings keep working.`,
      },
      {
        slug: 'running-group-classes',
        title: 'Running group classes',
        summary: 'Setting up a class, putting dates on the calendar, and what the joiner numbers do.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['classes'],
        body: `A group class is one session several people attend together. Unlike a 1:1, you set the time and people join it.

## A class and its dates are two different things

**The class** is the offering — "Thursday morning breathwork" as a thing that exists. You write it once: the title, the description, how long it runs, the price, and how many people can come.

**A date** is one occurrence of it. You add these as you go, most often weekly.

The split matters because a date takes a copy of the class's price, capacity and joining link at the moment you schedule it. Editing the class afterwards changes what *future* dates will use — it does not move the ground under a date people have already paid for. That is deliberate: what someone bought in September should not change because you edited the class in November.

## Maximum joiners is a real cap

The class sells out at this number. Once it is reached, nobody else can join that date.

## Minimum joiners is not

The minimum is **a note to yourself**, shown to clients as *runs with 3+*. Nothing acts on it.

A class below its minimum still goes ahead. Nothing is cancelled, nobody is refunded, and no message is sent. If you want a thin class called off, you have to cancel it yourself — see [Cancelling a class date](/help/for-facilitators/cancelling-a-class-date).

This is worth being clear about with yourself before you set the number, because a client reading *runs with 3+* on a class with two people may well assume it is about to fall through. The page tells them plainly that it is not.

## Your joining link

For an online class, put your standing room link on the class. It goes out only to people who have paid and appears nowhere public.

## It blocks your 1:1 calendar

A scheduled class makes that time unbookable for 1:1 sessions automatically — you cannot be double-booked by a client while you are teaching.

The reverse is not enforced: you can schedule a class over a 1:1 you already have. The site assumes you know what you are doing and are about to move something.

## Taking a class off sale

**Take off sale** stops new people joining and hides it from your profile. Dates you have already scheduled **still go ahead** — people paid for those, and they are yours to teach or to cancel one by one.`,
      },
      {
        slug: 'cancelling-a-class-date',
        title: 'Cancelling a class date',
        summary: 'What happens to everyone on a class when you call it off — and what does not happen.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['classes', 'refunds'],
        body: `You can cancel any scheduled date from **Classes → Dates**.

## What it does

Everyone's place is released and the date is marked cancelled. They see that on their account, with what they are owed.

## What it does not do

**It does not refund anyone.** This is the part people get wrong, so it is worth reading twice.

Cancelling frees the seats. It does not move any money. Hilom refunds the people on that class by hand, and the screen tells you how many there are and how much is owed so that you know what you have just set in motion.

Nothing about the refund is automatic and nothing reverses at the moment you press cancel.

## They get everything back

A facilitator cancelling is **always a full refund**, whatever the notice. Your cancellation terms do not apply here — those govern a client cancelling a 1:1, not you calling off a class.

It comes out of what you are paid for that class, not out of Hilom's pocket.

## Give as much notice as you can

There is no notice rule and no penalty. There is a person who arranged their Thursday around this. Cancelling three weeks out and cancelling ninety minutes out are the same operation to the software and are not remotely the same thing to them.

## Say why

You are asked for a reason when you cancel. Write one. It is what the person reads, and "cancelled" with no explanation is the version that generates an email to support asking what happened.

## If you just want to stop offering the class

That is a different action — **Take off sale** on the class itself. It stops new people joining without touching dates that are already sold. See [Running group classes](/help/for-facilitators/running-group-classes).`,
      },
      {
        slug: 'proposing-an-event',
        title: 'Proposing an event',
        summary: 'Putting an event forward for Hilom to review, and what happens next.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['events'],
        body: `You can propose an event — a workshop, a retreat, a one-off — from **Events** in your dashboard. Hilom reviews it before it goes anywhere.

## Nothing is public until it is approved

This is the first thing to understand. A proposal is invisible to everyone except you and Hilom until an admin approves it. It is not on the events page, it is not on your profile, and its link does not work. There is no half-published state.

## Writing it

**Save draft** keeps what you have typed without putting it in front of anyone. Come back to it as many times as you like.

**Send to Hilom** hands it over for review. You need a title, a date and a description before you can send it.

Once it is sent you cannot edit it. That is so an admin is not reviewing something that changes underneath them.

## What you set, and what Hilom sets

You write the event: title, date, where, the description, the practical details, the poster.

Hilom sets **the ticket price, the capacity and the payment plans**. Those are not on your form. If you have a price in mind, put it in the description or send it with the proposal and it will be discussed.

## If changes are asked for

An admin can send it back with a note. You will see the note on the event in your dashboard, and the event becomes editable again. Edit it and send it back — it returns to the queue as a fresh submission.

## Once it is approved

It goes live on the events page and on your profile, and people can register.

From then on the title, date and description are **fixed**. They are what people are buying, and changing them after someone has paid changes what they bought. Ask an admin if something genuinely has to change.

What you can still edit yourself is the **joining link and joining instructions** — a corrected Zoom link two hours before the doors open should not need anybody's permission. See [Hosting an event](/help/for-facilitators/hosting-an-event).`,
      },
      {
        slug: 'hosting-an-event',
        title: 'Hosting an event',
        summary: 'Your roster, your joining link, and being told when someone signs up.',
        kind: 'guide',
        audience: 'facilitator',
        tags: ['events'],
        body: `When Hilom assigns you as the host of an event — one you [proposed](/help/for-facilitators/proposing-an-event) or one Hilom set up — it appears under **Events** in your dashboard.

## Who has registered

Open the event to see the roster: who has a place, who is still paying, and what each person answered on the registration form.

It is the same roster an admin sees, with the same figures. That is on purpose — if you email someone about a payment, you are reading the number the admin is reading, and the two of you cannot contradict each other in front of the person who paid.

## You are emailed when someone signs up

Every time a place is paid for you get a note: who registered, their email, and the running count against capacity.

It arrives when the payment clears, not when someone starts checking out — otherwise you would hear about sign-ups that never complete.

## Your joining link

You control the link people join on, and you can change it at any time, including after the event is published.

**Saving the link and sending it out are two separate actions.** Correcting a typo in your dial-in note should not email forty people. When you are ready for them to have it, use **Send joining details**.

The link is never public. It goes only to people whose place is confirmed.

## Your attendees show up in Clients

Anyone who attends an event you host appears in your **Clients** tab, alongside people who book you 1:1 — counted separately, so you can tell a workshop attendee from a client you see every fortnight. See [Your clients](/help/for-facilitators/your-clients).

## Reviews

Once the event is over, people who came can review you, and it counts towards the rating on your profile exactly as a 1:1 review does.

Only events with a facilitator host can be reviewed. An event Hilom ran itself has no profile for a rating to land on.`,
      },
    ],
  },

  // =========================================================================
  {
    slug: 'account',
    name: 'Account & Privacy',
    description: 'Your details, sign-in, and your data.',
    icon: 'user',
    articles: [
      {
        slug: 'updating-your-details',
        title: 'Updating your details',
        summary: 'Changing your name, contact details or email address.',
        kind: 'guide',
        audience: 'both',
        tags: ['account'],
        body: `## Name and contact details

Go to [your details](/account/details). Update and save.

Your name is used on bookings and receipts, and your first name and last initial appear on any review you leave.

## Facilitators

Your public profile is edited from your facilitator dashboard under **Profile**, not here. The two are separate: your account details are yours, your profile is what clients see.

## Changing your email address

Your email is your sign-in, and it links your courses, bookings and receipts — so this is not a field you can simply overwrite.

[Contact us](/help/help/contacting-support) from the address currently on the account, telling us the new one. We will move everything across so nothing is left behind on the old address.

> Do not create a new account under the new address. Your purchases stay with the old one, and you end up with two accounts to untangle.

## Timezone

Taken from your device rather than stored as a setting, so times follow you when you travel. If a time looks wrong, see [my session time looks wrong](/help/sessions/session-time-looks-wrong).`,
      },
      {
        slug: 'sign-in-problems',
        title: "I can't sign in",
        summary: 'Password resets, verification emails, and what to try first.',
        kind: 'troubleshooting',
        audience: 'both',
        tags: ['account', 'sso'],
        body: `## Reset your password

Use **Forgot password** on the sign-in screen. The reset email arrives within a few minutes — check spam.

## Check the email address

Sign in with the address you signed up with. If you have several, try the one your receipts were sent to.

## Verify a new account

A new account has to be verified before it can be used. Look for the verification email, including in spam. Ask us to resend it if you cannot find it.

## Clear a stuck session

1. Sign out fully
2. Close the tab
3. Open a private window and try again

This rules out a stale session, which is the cause more often than a wrong password.

## Extensions and blockers

Privacy extensions and strict blockers sometimes break sign-in. Try with them off, or in a private window.

## Do not create a second account

A new account under a different address will not have your courses, bookings or receipts. Get the original working instead.

## Still locked out

Email [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com) from the address on the account if you can, and tell us what you have tried and what you see. If you cannot reach that address any more, say so — we can verify you another way.`,
      },
      {
        slug: 'your-data-and-privacy',
        title: 'Your data and privacy',
        summary: 'What we hold, who can see it, and how to get a copy or have it deleted.',
        kind: 'guide',
        audience: 'both',
        tags: ['privacy'],
        body: `## What we hold

- **Your account**: name, email, contact details
- **What you bought**: courses, sessions, events, and receipts
- **Your bookings**: who with, when, and anything you wrote when booking
- **Your messages** with facilitators
- **Your course progress** on Hilom LMS

## What we do not hold

**Your card details.** Payments go directly to PayMongo. We keep a record of what you paid, not how.

## Who can see what

- **Your facilitator** sees your name and email, your bookings with them, anything you wrote when booking, your intake answers, and your messages
- **Other facilitators** see none of that. Records are not shared between them
- **Reviews** show your first name and last initial only

## Facilitators' private notes

Facilitators can keep private notes about their own clients. You do not see these, and they are not shared with any other facilitator. If you want to know what your facilitator holds about you, ask them.

## Getting a copy, or deletion

Email [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com) from the address on your account.

Deletion has consequences worth knowing: it removes your course access and your booking history. We also have to keep some financial records for as long as the law requires, so those are retained even when the rest is removed.

## Full policy

Our [Privacy Policy](/privacy-policy) is the authoritative version. This page is a plain-language summary of it.`,
      },
    ],
  },

  // =========================================================================
  {
    slug: 'help',
    name: 'Getting Help',
    description: 'Reaching us, and what to send.',
    icon: 'lifebuoy',
    articles: [
      {
        slug: 'contacting-support',
        title: 'Contacting support',
        summary: 'How to reach us and what to include so we can fix it quickly.',
        kind: 'guide',
        audience: 'both',
        tags: ['support'],
        body: `## How to reach us

Email [kumusta@hilomcollective.com](mailto:kumusta@hilomcollective.com).

We are a small team in the Philippines. We read everything and reply as quickly as we can, usually within a working day or two.

## What to include

The more of this you send, the faster we can help:

- **The email address on your account** — and if it might be a different one, say so
- **What you were trying to do**, and what happened instead
- **When** it happened
- **The order, booking or event** in question
- **A screenshot**, if there is anything to see. This helps more than any description
- **What you have already tried**

## Urgent things

Tell us in the subject line if a session or event is within the next few hours. We will prioritise it.

## What to contact us about directly

- A payment problem you cannot resolve from the articles here
- A booking or enrolment that has not appeared
- Anything that felt unsafe, or any concern about a facilitator
- A data request

## What we cannot do

- Tell you why your bank refused a card — only they can see that
- Reply on a facilitator's behalf. For anything about the work itself, [message them directly](/help/sessions/messaging-your-facilitator)

## Not for emergencies

Hilom is not a crisis service and this inbox is not monitored around the clock. If you need help immediately, contact a local emergency or crisis line.`,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const headers = {
  'x-admin-key': ADMIN_KEY,
  'Content-Type': 'application/json',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${body.error ?? 'failed'}`);
  }
  return res.json() as Promise<T>;
}

async function main() {
  const total = SECTIONS.reduce((n, s) => n + s.articles.length, 0);
  console.log(`[kb-seed] ${SECTIONS.length} sections, ${total} articles → ${API_BASE}`);
  console.log(`[kb-seed] Mode: ${PUBLISH ? 'PUBLISH' : 'draft only (pass --publish to publish)'}`);

  const { categories: existingSections } = await api<{ categories: KbCategory[] }>(
    '/admin/kb/categories',
  );
  const { articles: existingArticles } = await api<{ articles: KbArticle[] }>('/admin/kb/articles');

  const sectionBySlug = new Map(existingSections.map((c) => [c.slug, c]));
  const articleBySlug = new Map(existingArticles.map((a) => [a.slug, a]));

  let created = 0;
  let updated = 0;
  let published = 0;

  for (const [sectionIndex, section] of SECTIONS.entries()) {
    // Sections are spaced by ten so one can be slotted between two later
    // without renumbering the rest.
    const position = (sectionIndex + 1) * 10;

    let categoryId = sectionBySlug.get(section.slug)?.id;
    if (categoryId) {
      await api(`/admin/kb/categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: section.name,
          slug: section.slug,
          description: section.description,
          icon: section.icon,
          position,
        }),
      });
      console.log(`[kb-seed] section ~ ${section.slug}`);
    } else {
      const { category } = await api<{ category: KbCategory }>('/admin/kb/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: section.name,
          slug: section.slug,
          description: section.description,
          icon: section.icon,
          position,
        }),
      });
      categoryId = category.id;
      sectionBySlug.set(section.slug, category);
      console.log(`[kb-seed] section + ${section.slug}`);
    }

    for (const [articleIndex, article] of section.articles.entries()) {
      const payload = {
        title: article.title,
        slug: article.slug,
        category_id: categoryId,
        summary: article.summary,
        body: article.body,
        kind: article.kind,
        audience: article.audience,
        tags: article.tags,
        position: (articleIndex + 1) * 10,
      };

      const existing = articleBySlug.get(article.slug);
      let articleId: string;

      if (existing) {
        const { article: saved } = await api<{ article: KbArticle }>(
          `/admin/kb/articles/${existing.id}`,
          { method: 'PATCH', body: JSON.stringify(payload) },
        );
        articleId = saved.id;
        updated++;
        console.log(`[kb-seed]   ~ ${section.slug}/${article.slug}`);
      } else {
        const { article: saved } = await api<{ article: KbArticle }>('/admin/kb/articles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        articleId = saved.id;
        articleBySlug.set(article.slug, saved);
        created++;
        console.log(`[kb-seed]   + ${section.slug}/${article.slug}`);
      }

      if (PUBLISH) {
        await api(`/admin/kb/articles/${articleId}/publish`, { method: 'POST' });
        published++;
      }
    }
  }

  console.log(`\n[kb-seed] Created ${created}, updated ${updated}, published ${published}.`);
  if (!PUBLISH) {
    console.log('[kb-seed] Everything is a DRAFT. Review under Admin → Help Centre, then either');
    console.log('[kb-seed] publish each article there or re-run this script with --publish.');
  }
  console.log('[kb-seed] Done.');
}

main().catch((err) => {
  console.error('[kb-seed] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
