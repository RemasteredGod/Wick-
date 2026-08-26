# Monetising the site

A strategy for selling the left and right gutters of `usewick.lol` as sponsor
space, and an honest account of what stands in the way.

Written 2026-08-27, against the site as it exists at `d227a58`.

## The short version

Sell **one** rail, **direct**, **self-hosted**, **flat monthly**, **no
JavaScript**. Not two rails, not a network, not CPM.

Every constraint that leads to that conclusion is a real property of this
codebase or this audience, not a preference. They are set out below so the next
person to consider this does not have to rediscover them.

## What the inventory actually is

The site is one centred column: `.wrap { max-width: 860px }`. What is left over
is the sellable space.

| Viewport | Gutter each side | Verdict |
|---|---|---|
| 1920px | ~530px | Two rails fit comfortably |
| 1440px | ~290px | One 240px rail fits |
| 1280px | ~210px | One narrow rail, tight |
| ≤1180px | ~0px | Nothing fits |
| Mobile | none | Nothing fits |

**A large share of your audience sees no gutter at all.** Laptops at 1280–1440
are the common case for developers, and that is one rail at best. Any pricing
built on "two skyscrapers" is pricing inventory that mostly is not there.

Recommended unit: **one 240 × 400 rail on the right, above 1180px**, sticky to
the viewport, hidden below the breakpoint. One good slot sells for more than two
mediocre ones, and two ads flanking an 860px column reads as a 2005 web portal.

## The three things that rule out conventional ads

### 1. The Content-Security-Policy

`server/http.ts` sends this on every HTML response:

```
default-src 'none'; style-src 'unsafe-inline'; img-src 'self';
base-uri 'none'; form-action 'none'
```

AdSense, Carbon, BuySellAds programmatic and every real-time-bidding network
require, at minimum, third-party `script-src`, third-party `img-src`, and
usually `frame-src` and `connect-src`. Taking those on means the site goes from
"cannot be made to execute anything" to "executes whatever a bidder ships
today". That is not a tuning change; it is the removal of the property that
makes these pages safe to serve to strangers.

**A self-hosted static creative needs none of it.** You upload the image, it
ships from your origin, `img-src 'self'` already permits it, and the CSP is
untouched.

### 2. The privacy position is the asset

`PRIVACY.md` currently promises, on a live page:

> The pages have no analytics, cookies, client-side application, or third-party
> assets.

The audience is people who installed a usage tracker *specifically because* it
does not phone home. Putting a tracking network on the board would contradict a
published promise, and it would do so in front of the exact population most
likely to notice.

It would also not work: this audience runs content blockers at a rate somewhere
north of 60%. Network ads would be blocked, unmeasured, and resented.

### 3. There is no traffic yet

`/board` currently reads "No submissions in this period yet." Ad revenue is
impressions × rate. There are no impressions.

**This document is a plan for when there is an audience, not a plan for
now.** Selling a rail today means selling something worth approximately nothing,
and doing it badly the first time poisons the second attempt.

## What to sell instead

The model that fits is the one Read the Docs, Daring Fireball and EthicalAds
use: **direct-sold, static, context-only sponsorship**.

- **One sponsor at a time.** A single named supporter reads as an endorsement;
  a rotating slot reads as an ad unit.
- **You host the creative.** A PNG or SVG under `public/`, or better, a text
  block you typeset yourself in the site's own type.
- **No tracking of any kind.** No pixel, no click ID, no redirect through a
  counter. The sponsor gets a link and a month.
- **Flat monthly rate.** CPM requires measurement, measurement requires
  tracking, tracking is off the table. Sell time, not impressions.
- **Disclose it.** A `Sponsor` label in the same monospace eyebrow style as
  everything else. Never make it look like content.

### What a sponsor is actually buying

Be able to state this in one line before selling anything:

> *N* developers who use Claude heavily enough to install a tool that measures
> it, on a page they visit to compare themselves to each other.

That is a genuinely good audience — high-intent, technical, employed. It is
worth real money *per reader*, which is what makes a small-but-real number
sellable at a flat rate that a CPM calculation would never justify.

### Rate card, when the time comes

Anchor on a plausible flat rate rather than a CPM, and publish the traffic
number you are basing it on. Suggested starting shape:

| Tier | What it is | Anchor |
|---|---|---|
| Text sponsor | One line, site type, on `/board` and `/u/*` | Entry price |
| Rail sponsor | 240×400 static image, right rail, all pages | ~3× text |
| Launch/takeover | Rail plus a line on `/` for a week | Negotiated |

Do not publish a rate until you can publish a traffic number honestly. A
made-up one is found out in the first invoice cycle.

## Implementation sketch

Small, and it stays inside the existing architecture.

### 1. The slot is data, not markup

Add a module beside the renderers — sponsors are content, and content that
changes monthly should not require a code review to change:

```
leaderboard/sponsor.ts
  export interface Sponsor {
    name: string;
    href: string;
    /** Path under public/, so img-src 'self' covers it. */
    image?: string;
    /** One line, used when there is no image. */
    line: string;
    /** ISO day the placement ends. Past it, nothing renders. */
    until: string;
  }
  export function currentSponsor(today: string): Sponsor | null
```

`until` matters more than it looks: an expired placement that keeps rendering is
a sponsor getting free inventory and a page telling readers something untrue.
Make expiry the default behaviour rather than a reminder in a calendar.

### 2. The rail goes in `page()`

One element, one rule set, in the shell's existing `<style>`:

```css
.rail{position:fixed;top:120px;right:max(16px,calc(50vw - 640px));
width:240px;display:flex;flex-direction:column;gap:8px}
.rail__label{font-family:var(--mono);font-size:9.5px;letter-spacing:.13em;
text-transform:uppercase;color:var(--ghost)}
.rail img{width:100%;height:auto;border-radius:10px;border:1px solid var(--line)}
@media(max-width:1180px){.rail{display:none}}
```

`right: max(16px, calc(50vw - 640px))` parks it just outside the 860px column
and stops it colliding as the window narrows. `display:none` below the
breakpoint is the whole responsive story — nothing reflows into the content
column, which is the failure mode that makes sidebar ads unbearable on laptops.

### 3. Caching is already right

`/board` is `s-maxage=60`, profiles `s-maxage=30`. A monthly sponsor changes far
more slowly than either, so the existing edge cache serves the placement for
free. **Do not** make the slot per-viewer to rotate sponsors — that gives up the
cache the whole site is built around, for a feature nobody asked for.

### 4. What to test

The repo's habit is to test the promise, not the markup:

- an expired `until` renders nothing
- the creative's `src` is same-origin — a third-party URL must fail the test,
  not the CSP at runtime
- the label renders whenever the slot does, so it can never read as content
- no page gains a `<script>`

## The honest part

**Ads are probably not the best way to monetise this**, and the plan above
should be weighed against two alternatives already latent in the repo:

- **Paid renames.** ADR 0007 designed this and the copy for it was written and
  then removed. A dollar to choose your own board name is a purchase that
  requires no audience scale to be worth building, and it is aligned with the
  product rather than bolted onto it.
- **A paid extension tier.** The projection engine is the thing people would pay
  for. History beyond 90 days, multiple accounts, export — none of that needs a
  website audience at all.

Ad inventory pays for a site's hosting. This site's hosting is currently free.
The rail is worth building when the board has an audience worth naming to a
sponsor, and not before — and if the first sponsor is someone whose product this
audience would resent, the correct answer is to leave the gutter empty.

## Decision checklist

Before selling anything:

- [ ] `/board` has enough traffic that you can state a number without
      embarrassment
- [ ] You are willing to write the number publicly on a rate page
- [ ] `PRIVACY.md` is amended to describe the slot, in the same plain terms as
      the rest of it
- [ ] The creative is self-hosted and the CSP is unchanged
- [ ] The slot is labelled, and expires on its own
- [ ] You would be comfortable with this specific sponsor appearing beside your
      own name on the board
