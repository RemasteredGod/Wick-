# Design provenance

Where every token and identity asset came from.

The visual design was produced separately and delivered by the owner. Two
revisions are relevant: the original extension artboards documented below, and
the selected inert identity assets from the v3 delivery. The repository does
not publish the source archive or its private design-canvas/support material.

## Wick identity v3

The owner authorized only the upright mark and favicon identity from this
delivery. The recorded archive SHA-256 is
`86e94a19ca13d0e09ae64cf7f7b90407bb76ec6dcfb7cb9f0bdd793a88fadb29`.
The archive itself is not stored in the repository; the selected extracted
assets were re-hashed before integration.

| Selected asset | Repository destination | SHA-256 |
|---|---|---|
| Canonical regular mark | `src/assets/brand/v3/wick-mark.svg` | `e9b7faea5ea8015195fd7ce5c7ee6dd54116c8372d73348a870613001e19ef47` |
| SVG favicon | `public/favicon.svg` | `900541a20a0339f97c31933719ed8ae5ad3b5a89dc9a14632fcb11e70509f188` |
| 16px favicon | `public/favicon-16.png` | `e93dfd2ddbe7dbae9bac8175d9556fa1cfab6f58fe46c608d98c7da0b030c51d` |
| 32px favicon | `public/favicon-32.png` | `563590144d7db49c283df0013ef1bdc992755faa1dd106ea3c493c9b050046da` |
| Project-authored shared geometry | `brand/v3/geometry.json` | `33dcb2707abeff5304a980112bd872d1b9eb9d602eb540710e54162364dc2930` |

The regular mark has view box `0 0 36 102`, the exact supplied ember path,
and a body at `x=0`, `y=42`, `width=36`, `height=60`, `rx=18`. Its ember uses
`#e8a33d` to `#c96442`; its dedicated track is `#3f3c37`. The approved optical
build below 18px uses a 38%-wide, 58%-high capsule, the solid `#e8a33d` ember,
and the dedicated `#5f5b55` track. Icon tiles use the existing dark ground
`#141312`.

The supplied percentage-bearing images are brand specimens, not extension
state. Packaged extension icons are generated independently in the honest
UNKNOWN state: unlit ember, centred dash, and no bottom-anchored quota fill.
Once a reading exists, runtime fill remains quota **remaining**, anchored to the
bottom; status still determines its existing ok/warn/crit colour, and any
positive remainder receives at least one raster pixel. The 16px runtime icon
uses the optical build and solid ember; 32px and larger runtime icons use the
regular geometry and gradient. Constrained toolbar, popup and sidebar
placements remain approved exceptions to marketing clear-space guidance. The
128px manifest and notification raster is also an approved optical-fit
exception: its regular capsule intentionally reaches the bottom edge. Do not
add padding or redesign that supplied edge-to-edge placement.

The server-rendered site uses the canonical mark decoratively and marks it
`aria-hidden`; it declares the three exact same-origin favicon assets above.
No client script or broader site concept was introduced.

## Original extension design

The original archive is the source of the extension interface tokens below:

```
claude design/v1/Claude Tracker Telegram Extension.zip
```

This file exists so the mapping to `tokens.css` remains auditable. If a token
changes, update its row here in the same change.

**Last extracted: 2026-08-24, from the archive as delivered.**

## What is in the archive

| Entry | What it is |
|---|---|
| `Wick Extension.dc.html` | The spec artboard. 350 lines. Hero, then five numbered panels: 01 sidebar card (300px), 02 expanded panel (372px), 03 settings (400px), 04 Telegram messages (340px), 05 first run (340px), then a "Principles for v0.1" block. |
| `Wick In Context.dc.html` | The in-situ mockup. 264 lines. A mock claude.ai window with the Wick card injected into the sidebar, the expanded panel anchored beside it, and settings as a full-screen modal. |
| `uploads/*.png` ×5 | Reference screenshots pasted onto the canvas. See "Reference screenshots" below. |
| `.thumbnail` | WebP canvas preview. |

There is **no CSS file, no SVG, no font, and no JSON config** in the archive.
All styling is inline `style=""` attributes; all "assets" are CSS geometry.
Every value below was read out of those attributes.

Line references are `ext:N` for `Wick Extension.dc.html` and `ctx:N` for
`Wick In Context.dc.html`, pointing at the first occurrence.

## Colour

### Ground

| Token | Value | Source | Read from |
|---|---|---|---|
| `--wick-bg` | `#141312` | ext:13, ctx:12 | `body { background }` in both `<helmet>` blocks |
| `--wick-surface` | `#1e1d1b` | ext:85, ctx:47 | Expanded panel and settings card background |
| `--wick-surface-raised` | `#1c1b19` | ext:49, ctx:88 | Sidebar card container (01); composer in the mock |
| `--wick-surface-sunken` | `#171614` | ext:176, ctx:178 | Text input background in settings |
| `--wick-surface-alt` | `#212020` | ext:56 | The sidebar widget card in artboard 01 |
| `--wick-surface-inset` | `#232120` | ext:74, ctx:25 | Sidebar skeleton row |
| `--wick-surface-icon` | `#252321` | ext:88 | 26px rounded square behind the mark in the panel header |
| `--wick-surface-hover` | `#272522` | ext:157, ctx:162 | `style-hover` on footer buttons and links |

### Tracks and bars

| Token | Value | Source | Read from |
|---|---|---|---|
| `--wick-track` | `#332f2b` | ext:37, ctx:50 | Legacy progress track |
| `--wick-track-alt` | `#302e2b` | ext:56, ctx:57 | Bar track inside the injected sidebar card only |
| `--wick-mark-track` | `#3f3c37` | identity v3 | Dedicated regular mark track |
| `--wick-mark-track-small` | `#5f5b55` | identity v3 | Dedicated mark track below 18px |
| `--wick-mark-tile` | `#141312` | identity v3 | Opaque toolbar/packaged icon tile |
| `--wick-history-bar` | `#33312e` | ext:132, ctx:141 | Sparkline bars, days 1–5 |
| `--wick-history-bar-recent` | `#3c3a36` | ext:137, ctx:146 | Sparkline bar, yesterday |

`--wick-track` and `--wick-track-alt` differ by 3 in one channel and are used in
different surfaces. They are kept separate rather than merged, because
harmonising them would be exactly the kind of "improvement" `AGENTS.md`
forbids.

### Borders

| Token | Value | Source | Read from |
|---|---|---|---|
| `--wick-border-muted` | `#262421` | ext:35 | Hero explainer box, section rule |
| `--wick-border-card` | `#2a2825` | ext:51, ctx:47 | Injected sidebar card border |
| `--wick-border` | `#2b2926` | ext:86, ctx:35 | Panel dividers, header and footer rules |
| `--wick-border-card-alt` | `#2c2a27` | ext:49 | Sidebar card container (01) |
| `--wick-border-stat` | `#2f2d2a` | ext:116 | The three stat tiles |
| `--wick-border-panel` | `#302e2b` | ext:56, ctx:57 | Expanded panel outer border (spec artboard) |
| `--wick-border-input` | `#33312d` | ext:176, ctx:178 | Text inputs, unselected threshold chips |
| `--wick-border-pill` | `#35332f` | ext:30 | Hero metadata pills |
| `--wick-border-strong` | `#35322e` | ctx:107 | Expanded panel outer border (in-situ artboard) |
| `--wick-border-hover` | `#383530` | ctx:47 | `style-hover` on the injected sidebar card |
| `--wick-border-control` | `#3a3833` | ext:91, ctx:80 | Buttons, plan badge, first-run step circles |
| `--wick-border-focus` | `#4a4741` | ext:176, ctx:178 | `style-focus` on inputs; also unchecked checkbox borders |

`--wick-border-panel` and `--wick-border-strong` are the same element in two
artboards with different values. Both are kept; the popup uses
`--wick-border-strong`, matching the in-situ artboard. See "Conflicts" below.

### Text

| Token | Value | Source | Read from |
|---|---|---|---|
| `--wick-text` | `#f2efe9` | ext:18, ctx:18 | Root body colour |
| `--wick-text-primary` | `#e8e4dd` | ext:60, ctx:28 | Meter labels, button labels |
| `--wick-text-secondary` | `#c9c4bb` | ext:17, ctx:17 | Percentages, settings option labels, links |
| `--wick-text-tertiary` | `#b9b4ab` | ext:91, ctx:114 | Plan badge, gear icon |
| `--wick-text-muted` | `#a4a09a` | ext:28, ctx:73 | Hero body copy, skip button |
| `--wick-text-dim` | `#8a857d` | ext:26, ctx:36 | Reset lines, helper text, captions — the most-used text colour (33 uses) |
| `--wick-text-faint` | `#6f6a63` | ext:48, ctx:53 | Uppercase eyebrows, version string, chevron |
| `--wick-text-ghost` | `#57534d` | ctx:103 | The lowest-contrast caption in either artboard |

### State

| Token | Value | Source | Read from |
|---|---|---|---|
| `--wick-accent` | `#c96442` | ctx:227 | `accent` prop default in `Wick In Context` |
| `--wick-accent-fg` | `#171310` | ctx:219 | Text on the accent-filled Save button |
| `--wick-flame` | `#e8a33d` | ext:37, ctx:50 | The mark's flame, every instance |
| `--wick-ok` | `#6dcf8e` | ext:150, ctx:157 | "Connected" dot and label |
| `--wick-warn` | `#d99a2b` | ext:39, ctx:58 | The 82% weekly bar and its percentage |
| `--wick-warn-bg` | `#2a2113` | ext:113, ctx:138 | Forecast callout background |
| `--wick-warn-border` | `#4a3a18` | ext:113, ctx:138 | Forecast callout border |
| `--wick-warn-text` | `#e0b256` | ext:113, ctx:138 | Forecast callout body |
| `--wick-warn-text-strong` | `#f2c877` | ext:113, ctx:138 | The bolded date inside the forecast |

### Crit — **FLAG: invented**

The archive contains no above-90% state. Nothing red appears in either artboard.
These five values are derived, not extracted, and are the only invented colours
in the file.

**Derivation:** each is its warn counterpart converted to HSL with the hue set
to 358°, leaving saturation and lightness untouched. That keeps crit at exactly
the same weight and contrast as warn against `--wick-bg`, so the escalation
reads as a hue change rather than a jump in intensity, and it keeps crit clearly
apart from the clay accent (which is a desaturated 14°).

| Token | Value | Derived from |
|---|---|---|
| `--wick-crit` | `#d92b31` | `--wick-warn` `#d99a2b`, hsl(38, 70%, 51%) → hsl(358, 70%, 51%) |
| `--wick-crit-bg` | `#2a1314` | `--wick-warn-bg` `#2a2113` |
| `--wick-crit-border` | `#4a181a` | `--wick-warn-border` `#4a3a18` |
| `--wick-crit-text` | `#e0565b` | `--wick-warn-text` `#e0b256` |
| `--wick-crit-text-strong` | `#f2777b` | `--wick-warn-text-strong` `#f2c877` |

These need the owner's review. If they are wrong, replacing them is a one-line
change per row and no component needs to move.

### Support link

| Token | Value | Source | Read from |
|---|---|---|---|
| `--wick-support-bg` | `#241d19` | ext:220, ctx:214 | Ko-fi row background |
| `--wick-support-bg-hover` | `#2b221d` | ext:220, ctx:214 | Its `style-hover` |
| `--wick-support-border` | `#3f3129` | ext:220, ctx:214 | Its border |
| `--wick-support-text` | `#e6c3a8` | ext:221, ctx:214 | Its label |
| `--wick-support-meta` | `#9c7a63` | ext:222 | The `ko-fi.com/…` handle beside it |

### Overlay and shadow

| Token | Value | Source | Read from |
|---|---|---|---|
| `--wick-overlay` | `rgba(10,9,8,.6)` | ctx | Settings modal scrim |
| `--wick-shadow-panel` | `0 24px 60px rgba(0,0,0,.5)` | ext | Expanded panel and settings card |
| `--wick-shadow-panel-lg` | `0 30px 80px rgba(0,0,0,.65)` | ctx | Anchored panel in situ |
| `--wick-shadow-modal` | `0 40px 100px rgba(0,0,0,.7)` | ctx | Settings modal |

## Radius

All twelve values below appear verbatim in the archive. They are named by role
because the archive applies them by role, not as a scale.

| Token | Value | Where the archive uses it |
|---|---|---|
| `--wick-radius-bar` | `3px` | 3px progress bars; the mark's body at inline size |
| `--wick-radius-mark` | `4px` | Sparkline bars; the mark's body at hero size |
| `--wick-radius-bar-lg` | `5px` | 5px progress bars in the expanded panel |
| `--wick-radius-chip` | `6px` | Segmented-control chips |
| `--wick-radius-segment` | `7px` | Segmented-control track |
| `--wick-radius-row` | `8px` | Navigation rows, skeleton rows |
| `--wick-radius-control` | `9px` | Buttons, inputs, threshold chips — the most-used radius |
| `--wick-radius-callout` | `10px` | Forecast callout, stat tiles, injected sidebar card |
| `--wick-radius-card` | `12px` | Hero explainer box |
| `--wick-radius-panel-sm` | `14px` | Sidebar card container (01) |
| `--wick-radius-panel` | `16px` | Expanded panel, settings card |
| `--wick-radius-pill` | `999px` | Plan badge, hero pills, toggle track |
| `--wick-radius-flame` | `50% 50% 50% 0` | The flame's teardrop, on every instance of the mark |

## Type

| Token | Value | Notes |
|---|---|---|
| `--wick-font` | `'Helvetica Neue', Helvetica, Arial, sans-serif` | ext:18, ctx:18 |
| `--wick-font-mono` | `ui-monospace, Menlo, monospace` | 52 uses — every number, label and eyebrow |

`Georgia, serif` also appears in the archive (ctx:24, ctx:112) but only in the
mock claude.ai chrome — the "Assistant" wordmark and the greeting. It is host
page furniture, not a Wick typeface, and is deliberately not tokenised.

| Token | Value | Where |
|---|---|---|
| `--wick-size-micro` | `9.5px` | Sparkline day labels, message timestamps |
| `--wick-size-eyebrow` | `10.5px` | Uppercase section labels, stat tile captions |
| `--wick-size-meta` | `11px` | Sidebar meter labels, hero pills |
| `--wick-size-note` | `11.5px` | Reset lines, helper text |
| `--wick-size-label` | `12px` | The "Wick" wordmark in the sidebar card |
| `--wick-size-body` | `12.5px` | Default body size — 41 uses, the most common |
| `--wick-size-body-lg` | `13px` | Panel rows, buttons, settings labels |
| `--wick-size-row` | `13.5px` | Meter labels and percentages in the expanded panel |
| `--wick-size-title` | `14px` | Settings title; panel title in situ |
| `--wick-size-title-lg` | `15px` | Panel title in the spec artboard |
| `--wick-size-heading` | `17px` | First-run heading |
| `--wick-size-stat` | `19px` | Stat tile numbers |

Sizes `9px`, `10px` and `38px`/`40px` also occur in the archive but only in the
mock host chrome and the hero, neither of which Wick renders. They are not
tokenised.

Letter-spacing and line-height tokens map one-to-one onto the archive's values:
`-.02em`, `-.01em`, `.02em`, `.03em`, `.12em`, `.14em`, `.16em`, and `1.5`,
`1.55`, `1.6`.

## Space

`--wick-space-N` where `N` is the pixel value. Defined for exactly the values
the archive uses on Wick surfaces: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
14, 15, 16, 18, 20, 22, 26.

This is not a designed scale and does not pretend to be one — it is an
inventory. The archive was laid out by eye.

## Component metrics

| Token | Value | Source |
|---|---|---|
| `--wick-panel-width` | `372px` | Expanded panel, both artboards |
| `--wick-sidebar-card-width` | `300px` | Artboard 01 |
| `--wick-settings-width` | `400px` | Artboard 03 (the in-situ modal is `420px`; see Conflicts) |
| `--wick-bar-height` | `3px` | Sidebar card meters |
| `--wick-bar-height-lg` | `5px` | Expanded panel meters |
| `--wick-history-height` | `54px` | Sparkline, spec artboard |
| `--wick-history-height-sm` | `44px` | Sparkline, in situ |
| `--wick-mark-width` / `-height` | `5px` / `13px` | Inline mark |
| `--wick-mark-width-lg` / `-height-lg` | `7px` / `26px` | Hero mark |

## Motion

`--wick-transition: all .18s ease` — the only transition in the archive, used on
the settings toggle. Zeroed under `prefers-reduced-motion`, which the archive
does not address; that guard is ours.

`@keyframes wick-relaypulse` is defined in the `<helmet>` of both artboards and
**applied in neither**. It is carried over because it records design intent for
a live relay indicator. If M6 ships without using it, delete it.

## The mark

The original extension artboards used CSS geometry. Identity v3 supersedes that
shape with the owner-supplied upright SVG and the shared geometry documented at
the top of this file. Existing mark layout boxes remain unchanged so this
identity update does not reflow popup or injected content.

**Fill semantics remain unchanged.** The fill is quota remaining, not
consumption: `100 − max(utilization)` across known windows. Progress bars fill
as usage rises; the mark burns down. UNKNOWN is neither full nor empty and uses
an unlit ember plus a centred dash.

### Packaged extension icons

`public/icons/{16,32,48,128}.png` are deterministic, opaque-dark-tile,
UNKNOWN-state raster derivatives of `brand/v3/geometry.json`. The manifest and
action use all four sizes, and local notifications use the packaged 128px file.
The 128px capsule intentionally meets the lower image edge under the approved
manifest/notification optical-fit exception; this is tested and is not missing
clear-space padding.
`pnpm icons:generate` uses only Node built-ins; `pnpm verify:build` checks exact
source/build hashes, dimensions, paths, inert selected SVGs, and canonical
geometry.

## Thresholds

Colour state changes at **ok below 70%, warn 70–90%, crit above 90%**.

The archive does not state breakpoints. It shows one warn instance — the 82%
weekly bar in `--wick-warn` — which is consistent with a 70–90 warn band, and
shows no crit instance at all. The numbers above are therefore the project
default rather than an archive value, and the archive does not contradict them.

## Conflicts found in the archive

Resolved rather than silently picked. Each is recorded here so the choice can be
revisited.

**Accent.** `Wick Extension` defaults to `#4d8ff0` (blue); `Wick In Context`
defaults to `#c96442` (clay). Both offer the same four options
(`#c96442`, `#4d8ff0`, `#6dcf8e`, `#b78be0`). **Chose clay**, on the owner's
instruction: it is the in-situ artboard, the later of the two, and it matches
the archive's own "borrow, never brand" principle.

**On-accent foreground.** `#0d1218` on blue (ext:313) versus `#171310` on clay
(ctx:219). **Chose `#171310`**, following the accent.

**Panel border.** `#302e2b` (ext:85) versus `#35322e` (ctx:107) on the same
element. Both tokenised; the popup uses the in-situ value for consistency with
the accent choice.

**Settings width.** `400px` in artboard 03, `420px` for the in-situ modal.
Tokenised at `400px`; the modal difference is a canvas-layout artifact.

**Mark colour at low fill.** The hero's 14%-fill candle uses `--wick-warn`, but
the in-situ mark at 18% fill uses `--wick-accent` — while the same artboard's
82% bar is `--wick-warn`. The archive is internally inconsistent here. Wick
applies one threshold function to both bar and mark, so an 82%-used window makes
both warn.

**Licence.** The hero carries an `MIT` pill (ext:30). The project ships
AGPL-3.0-or-later. The pill is design copy on a panel Wick does not render.

**Telegram.** The settings card and first-run flow are built around a bot token
in `chrome.storage.local`, which `AGENTS.md` forbids. See
`docs/decisions/0002-telegram-relay-not-bot-token.md`.

## What was not carried over

**No light theme.** The archive is dark only. None was invented — the tokens are
declared unconditionally, with no `prefers-color-scheme` block.

**Telegram message colours.** `#17212b`, `#22303c`, `#2b5278`, `#cfe3f5`,
`#f0f4f8`, `#6b8398`, `#8fa7ba`, `#212121` (ext:225–260) belong to the mock
Telegram client in artboard 04. They are Telegram's palette illustrating what an
alert looks like on a phone. Wick does not render that surface.

**Mock host chrome.** `#191817`, `#1f1e1c`, `#201f1d`, `#efeae2`, `#d6d1c9`,
`#4d4944`, `#3a3835`, `#7d7871` and the Georgia face belong to the simulated
claude.ai window in `Wick In Context`. They are the backdrop the injected card
sits on, not Wick's own palette. `#7d7871` is borderline — it is used for host
sidebar labels only — and was left out on that basis.

**The alternate accents.** `#4d8ff0`, `#6dcf8e`, `#b78be0` are offered as prop
options in the canvas. Only `#6dcf8e` is tokenised, and only because it doubles
as the "connected" state colour.

## Files beyond the original scaffold

The brief's tree lists four popup components. Reproducing the archive needed a
few more, all additive:

| File | Why |
|---|---|
| `src/popup/components/Mark.tsx` | The mark is a component in its own right; both surfaces and, later, the toolbar renderer draw it. |
| `src/popup/components/GearIcon.tsx` | See deviation 6. |
| `src/popup/popup.css` | The popup shell. Panel frame styles that the injected panel does not share. |
| `src/popup/components/Settings.tsx` | Artboard 03, as a view in the popup and a modal in the injected panel. See deviation 3. |
| `src/popup/useWickState.ts` | The store, as a hook. Both surfaces read through it; neither fetches. |
| `src/styles/components.css` | Component styles shared by both surfaces. |
| `src/content/SidebarCard.tsx` | The injected card. Artboard 01. |
| `src/content/UsagePanel.tsx` | The panel the card opens, mounted in the main content frame. See deviation 4. |
| `src/content/panel.ts` | The one piece of state the two share. |
| `src/content/sidebar.css` | Their styles, inlined into both shadow roots. |
| `src/content/selectors.ts` | Every claude.ai DOM selector, in one file — the archive's own "selectors in one file" principle. |

`src/content/` imports its components from `src/popup/components/` so that both
surfaces render the same code. That import direction is odd to read and worth
revisiting if the sidebar grows; a shared `src/ui/` would be the fix.

## Reference screenshots

The five PNGs in `uploads/` are source material the owner pasted onto the
canvas, not deliverables:

| File | What it shows |
|---|---|
| `pasted-1787575193009-0.png` | An **earlier iteration of this design**, titled "Relay" rather than Wick, with a blue accent and an activity-pulse logo. Same layout, same copy, same numbers. Superseded by the artboards. |
| `pasted-1787575195384-0.png`, `-197878-0.png` | Screenshots of a **different, existing extension** — a competitor's usage panel and settings dialog. |
| `pasted-1787575209499-0.png`, `-482722-0.png` | Screenshots of the **real claude.ai sidebar**, which is the injection target for the content script. |

The competitor screenshots were treated as prior art to stay clear of, not as a
design input. Nothing in `tokens.css` or in any component derives from them. See
the clean-room rule in `AGENTS.md`.

## Deviations from the archive

Where the extension cannot reproduce the archive exactly, and why. Nothing here
was substituted silently.

1. **The v3 mark replaces the measured CSS shape.** Popup, injected content,
   toolbar rendering and site identity now use the supplied upright vector
   geometry. Existing popup/content SVG layout boxes are retained to avoid
   reflow.
2. **16px uses the approved optical build.** Below 18px the body is slightly
   wider and shorter, the ember is solid, and the dedicated small track is
   lighter. It is a supplied size-specific build, not a runtime approximation.
3. **Settings becomes a full-popup view.** A 400px card inside a 380px popup is
   not possible. In the popup, settings is a view rather than a modal. The
   injected panel keeps the modal.
4. **The anchored panel is repositioned, and mounted elsewhere.**
   `position:absolute; left:302px; top:186px` is measured against the canvas,
   not against a real page. In the content script the panel reads the injected
   card's bounding box and opens a fixed gap to its right, clamped to the
   viewport — which lands at left:302px against the archive's own 290px sidebar,
   and follows a real one the user has dragged wider.

   It is also mounted in the **main content frame** rather than in the sidebar.
   A sidebar is a scroll container, so a panel positioned out of one is clipped
   by it: the panel appeared to open *inside* the navigation, in a 300px column,
   which is the opposite of what the in-situ artboard draws. Two render roots
   are the cost; `src/content/panel.ts` is the boolean they share.
5. **Hero, principles block, and the Telegram phone mock are not built.** They
   are presentation surfaces on the canvas, not extension screens.
6. **The gear is drawn, not typed.** The archive uses the `⚙` character.
   Windows renders U+2699 through a colour emoji font, and `AGENTS.md` rules out
   emoji in the interface, so it is an inline SVG that inherits `currentColor`.
   Same silhouette, same size.
7. **Reset times are 24-hour.** `Resets Thursday, 09:00`, as the archive has it,
   rather than the locale default — which appends AM/PM under `en-US` and pushes
   the line past the width the design allows. Weekday and date still follow the
   user's locale.
8. **The stat trio and the sparkline labels are panel-only.** The in-situ
   artboard omits both from the floating panel, and that is reproduced: the
   popup gets the full strip with day labels, the injected panel gets the
   shorter unlabelled one.
9. **The plan badge is absent.** The archive badges `Max 5×` in the panel
   header. Nothing in `docs/protocol.md` reports which plan an account is on,
   and inventing one would be exactly the confident wrong number `AGENTS.md`
   rules out — so the badge is simply not rendered. The header layout is
   otherwise unchanged, and the badge style (`.wick-badge`) is kept for the day
   a plan field turns up.
10. **Settings takes a connect code, not a bot token.** The archive's Telegram
    group has a bot-token field and a chat-ID field, both stored in
    `chrome.storage.local`. That is an unscoped bearer credential in plain JSON
    on disk. Wick takes a short-lived connect code instead and exchanges it for
    a revocable per-user token, which is also why the "Send test" button is
    gone. See `docs/decisions/0002-telegram-relay-not-bot-token.md` and
    `0003-telegram-relay-design.md`.
11. **No Save button.** Every control writes through as it is touched, so a
    Save button could only offer the chance to lose a change by closing the
    popup — and a popup closes when you look away from it. The footer keeps the
    version line and becomes Done.
12. **Three raw pixel values, in the settings switch and checkbox.** The
    archive's toggle track is `34×19` with a `15px` knob, and the display
    checkbox is `15×15`. The space scale in `tokens.css` stops at 26 and is a
    spacing scale, not a control-size scale; putting fixed control dimensions
    into it would make it mean two things. They are literals in
    `components.css`, marked there, and are the only raw dimensions in the
    stylesheet.
