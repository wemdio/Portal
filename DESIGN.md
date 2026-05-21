---
name: Portal Client
description: "Decisive editorial dark for the OutreachOS client portal — pure-near-black surfaces, paper-white invisible accent, hairline structure, Inter + JetBrains Mono."
colors:
  ink: "#0a0a0a"
  surface-rest: "#111213"
  surface-elev: "#18191c"
  surface-active: "#1f2023"
  divider: "#1f2023"
  divider-strong: "#2a2b2f"
  paper: "#fafafa"
  paper-mute: "#a1a1a3"
  paper-faint: "#6c6c70"
  amber-active: "#f5a623"
  red-attention: "#e5484d"
  green-go: "#46a758"
  grey-quiet: "#6c6c70"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.75rem, 3vw, 2.25rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.25rem, 2vw, 1.5rem)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.02em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.paper-mute}"
    textColor: "{colors.ink}"
  button-secondary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-ghost:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-mute}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-rest}"
    textColor: "{colors.paper}"
  input-field:
    backgroundColor: "{colors.surface-rest}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card-container:
    backgroundColor: "{colors.surface-rest}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    padding: "20px"
  nav-item:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-mute}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  nav-item-active:
    backgroundColor: "{colors.surface-elev}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  status-tag-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.amber-active}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
---

# Design System: Portal Client

## 1. Overview

**Creative North Star: "Decisive Editorial Dark"**

The Portal Client surface is a serious tool for serious people. The visitor — a B2B founder, sales lead, or marketer who pays the agency real money — opens the portal between two client calls. They want one answer in one glance: *what is happening for my business right now, and what do I do next?* The room is dark, the type is precise, the colour stays in the data and not in the chrome. Nothing decorates; everything informs.

The system is built on four commitments. First, **a near-black base** (`ink` `#0a0a0a`) with a three-step surface ramp — every container earns its depth through a 1-2% lightness step, not a shadow. Second, an **invisible accent**: the chrome speaks in paper-white (`#fafafa`) on ink; the primary action is the brightest object on the screen because it is *white*, not because it is *coloured*. Third, **status colours are data, not decoration** — amber for in-progress, red for at-risk, green for on-track, grey for todo. They appear as 6px dots and short text-tags, never as filled card backgrounds. Fourth, **typography carries hierarchy** — Inter for everything human, JetBrains Mono for everything technical, with editorial numbering (`02 → Сегодня требуют внимания`) marking sections in the same way a scientific paper labels its figures.

This system explicitly rejects: neon/CRT/hacker-terminal aesthetics that the OpenAI/Anthropic admin-tool reflex defaults to (`#0A0A0A` + neon-lime + ASCII mockups); the warm-stone neumorphic baseline we worked through previously (linen-cream + walnut + double-shadow — a valid system, but a different one); generic SaaS-cream marketing-template land (cream backgrounds, violet accents, hero-metric blocks); and Bitrix/Amo rainbow CRM noise.

**Key Characteristics:**

- Pure-near-black base, paper-white text — no warm tint, no chromatic chrome
- Hairlines instead of shadows; depth lives in the 1-2% lightness step between surfaces
- Inter + JetBrains Mono, both with full Cyrillic — no third typeface
- Status colours used only as semantics; never as decoration
- Editorial numbering for sections in mono — a signature touch borrowed from publishing
- Sharp radii (4-12px) — never pillowed, never overly rounded
- Dark-only — no light theme in this iteration

## 2. Colors

A neutral dark ramp with paper-white as the only voice in chrome. Hex values are authoritative; OKLCH is the canonical perceptual reference.

### Primary

Paper-white is the **only chrome voice**. It carries every interactive affordance the client cares about — primary button fill, active nav state, link colour, focus ring. There is no "brand colour" in the chrome.

- **Paper** (`#fafafa`, oklch(98% 0 0)): primary text on `ink`. Primary button background (white-on-black, like Linear marketing CTAs). Focus ring colour. Contrast against `ink` ≈ 19.5:1.

### Neutral

- **Ink** (`#0a0a0a`, oklch(8% 0 0)): the universal surface — page background, sidebar background, default container background. Not pure `#000000`; the 8% lightness softens it just enough that screen glare on long sessions doesn't bite.
- **Surface Rest** (`#111213`, oklch(12% 0 0)): a card, panel, or elevated container at rest. One step lighter than `ink`. Used for grouping content visibly without putting a border on it.
- **Surface Elev** (`#18191c`, oklch(15% 0.002 250)): the hover/active state of a surface. Also: dropdown panels, modal sheets, command palette.
- **Surface Active** (`#1f2023`, oklch(18% 0.002 250)): pressed / selected state. Same value as `divider` deliberately — pressed surfaces read as carved by becoming the divider colour.
- **Divider** (`#1f2023`, oklch(18% 0.002 250)): hairline separator between rows, sections, cells. Renders as a barely-visible 1px line on ink — enough to give a table structure without weight.
- **Divider Strong** (`#2a2b2f`, oklch(22% 0.003 250)): rare emphasis hairline — at the top of a section, around a focused input.
- **Paper Mute** (`#a1a1a3`, oklch(67% 0 0)): secondary text — descriptions, table cells, captions. Contrast against `ink` ≈ 8.2:1.
- **Paper Faint** (`#6c6c70`, oklch(48% 0.002 250)): tertiary text — eyebrows, placeholders, editorial numbering, time stamps. Contrast against `ink` ≈ 4.6:1 (passes WCAG AA for body, brushes the edge for labels).

### Status (data colours, not chrome)

Used exclusively as 6px dots, short text-tags (`АКТИВНА` in mono), and the leading icon of a per-row indicator. **Never as a background fill of a card or stripe.** These four colours together are the only chromatic accents permitted anywhere in the client product.

- **Amber Active** (`#f5a623`, oklch(72% 0.135 70)): in-progress, in-flight, pending review. Long-running things that are not stuck.
- **Red Attention** (`#e5484d`, oklch(60% 0.185 25)): at-risk, stuck, error, destructive action. Use for things that need the user *today*, not informationally.
- **Green Go** (`#46a758`, oklch(65% 0.15 142)): on-track, sent, success, completed. Earned positive, not decorative.
- **Grey Quiet** (`#6c6c70`, oklch(48% 0.002 250)): todo, paused, archived, neutral. Equal to `paper-faint` deliberately — a status without colour is *grey*, not absent.

### Named Rules

**The Invisible Accent Rule.** The chrome has no chromatic colour. Buttons, links, active states, focus rings are paper-white. Colour appears only inside the **status vocabulary**: amber, red, green, grey, as semantic indicators of data. If you reach for "the brand colour" — there isn't one in this system. The brand voice is in copy and density, not in hue.

**The Status-as-Data Rule.** A colour exists on screen because data has a status. If you can remove the colour without changing what the user understands about the data underneath, the colour is decoration — delete it. There are no "filled cards" with semantic background tint, no "category" colour stripes, no rainbow icons.

**The No-Warm-Tint Rule.** The neutral ramp is pure cool grey (chroma ≤0.003). No warm-stone, no linen-cream, no walnut. Warmth lives in the copy and in the spacing, not in the colour.

## 3. Typography

**Display / Body Font:** Inter (Google Fonts, subsets: latin, cyrillic, cyrillic-ext). Variable font, weights 400/500/600/700/800.

**Technical / Mono Font:** JetBrains Mono (Google Fonts, subsets: latin, cyrillic). Variable font, weights 400/500.

Both loaded via `next/font/google` in `app/src/app/client/layout.tsx` with `display: 'swap'`. No third typeface. The variable-font setup means subsetting and font-feature-settings (`ss01`, `cv11` if relevant) can be tuned without re-loading.

**Character:** Inter is the workhorse — neutral, geometric, high x-height, dense kerning at body sizes. It does not have a personality; that is exactly the point. JetBrains Mono carries the editorial signature: section numbers, status tags, file paths, IDs, timestamps. Wherever there is "a thing the machine names rather than a human reads", the mono carries it.

### Hierarchy

- **Display** (`700`, `clamp(1.75rem, 3vw, 2.25rem)`, `1.1`, `letter-spacing: -0.02em`): page-level hero on a landing-style screen inside the product (analytics overview, a dedicated detail page). Used sparingly — most screens don't need a display.
- **Headline** (`600`, `clamp(1.25rem, 2vw, 1.5rem)`, `1.2`, `letter-spacing: -0.015em`): page H1 on every standard route (`/client/dashboard`, `/client/replies`). Often paired with a metadata line in `paper-mute` below.
- **Title** (`600`, `0.9375rem` (15px), `1.35`): section heading inside a card or a row block — "Сегодня требуют внимания" body text.
- **Body** (`400`, `0.8125rem` (13px), `1.55`): primary reading text — descriptions, table cells, paragraphs. Cap line length at 65-75ch in long-form sections. Smaller than the previous Calm Workshop body (14px) because tool-grade dark systems compress density.
- **Label** (`500`, `0.6875rem` (11px), `1.3`, `letter-spacing: 0.02em`, **JetBrains Mono**): editorial-numbering eyebrows, status tags, table column headers, technical IDs. Mono, not uppercase by default — uppercase is reserved for the `status-tag` variant.

### Named Rules

**The Editorial-Numbering Rule.** Sections inside the product are introduced with a numbered eyebrow in JetBrains Mono, paper-faint, with a right-pointing arrow as separator: `02 → Сегодня требуют внимания`. The arrow `→` (U+2192) is not a hyphen, not an em-dash; it is the editorial-figure separator borrowed from scientific publication conventions. Section numbers are local to the page (a dashboard has its own 01/02/03), not global.

**The Mono-for-Tech Rule.** Anything the machine names rather than the human reads goes in JetBrains Mono: campaign IDs (`CMP-2703`), file paths, status tags (`АКТИВНА`, `ПАУЗА`), timestamps in compact form (`14:32`), numeric counters where alignment matters. Russian text in mono is allowed and looks correct because JetBrains Mono has full cyrillic. Status tags that *are* mono get uppercase (`АКТИВНА` not `Активна`); body mono stays mixed-case.

**The One-Family Rule.** Inter + JetBrains Mono — no third typeface. No serif, no display-serif italics, no script. If a layout needs a third voice, the answer is **weight, size, or mono**, not a new family.

**The Sharp-Type Rule.** Type uses negative letter-spacing at display and headline scale (`-0.02em` / `-0.015em`); body letter-spacing is `0`. Mono labels use slight positive tracking (`0.02em`) to compensate for the slab terminals. Never use positive tracking on display sans (it weakens the silhouette).

## 4. Elevation

The system is **explicitly flat**. There are no `box-shadow` declarations anywhere except for `focus-visible` halos. Depth is conveyed by the 1-2% lightness step between `ink` (`#0a0a0a`) → `surface-rest` (`#111213`) → `surface-elev` (`#18191c`) → `surface-active` (`#1f2023`), and by hairline `1px solid` dividers in `divider` colour (`#1f2023`).

A card sits on the page because its background is one step lighter than the page, not because it casts a shadow. A row is separated from its neighbour by a hairline, not by a gap. A hovered row tints darker (`surface-elev`), not lighter.

### Hairline Vocabulary

- **Section Divider** (`1px solid #1f2023`, full-width inside a container, vertical or horizontal): separates major sections inside a card or a page region.
- **Row Divider** (`1px solid #1f2023`, between sibling rows in a list): separates adjacent rows in a `list-row` group. The first row has no top divider; subsequent rows have `border-top`.
- **Focused Field Border** (`1px solid #2a2b2f` at rest → `1px solid #fafafa` on `:focus-visible`): inputs and selects get a hairline border at rest and a paper-white border when focused. No focus glow.
- **Focus Ring** (`0 0 0 2px #fafafa` at 30% alpha, offset by `0 0 0 4px #0a0a0a` for double-track on layered surfaces): the *only* `box-shadow` in the system, applied on `:focus-visible` for interactive elements.

### Named Rules

**The Hairline-Not-Shadow Rule.** Depth is the difference between two adjacent surface colours, not a `box-shadow`. If you reach for `box-shadow` outside of `:focus-visible`, ask first whether a 1-step surface lightness change does the same job. It almost always does.

**The No-Glow Rule.** No `box-shadow` for hover. No `box-shadow` for active. No `box-shadow` for elevation. The only allowed shadow is the focus-ring, and it is `0 0 0 2px` plus an offset — a hard ring, not a soft glow.

## 5. Components

### Buttons

- **Shape:** `rounded.md` (6px) — sharp but not razor-cornered. The primary action is the brightest object on the screen because it is *paper*, not because it is coloured.
- **Primary** (`ds-btn-primary`): `paper` background (`#fafafa`), `ink` text (`#0a0a0a`), padding `8px 14px`, font Inter 500 13px. On `:hover`: background steps to `paper-mute` (`#a1a1a3`). On `:focus-visible`: paper background + focus ring. On `:active`: background `paper-mute`, no displacement (no translateY trickery). Used for the single primary CTA per screen.
- **Secondary** (`ds-btn-secondary`): `ink` background, `paper` text, `1px solid #2a2b2f` hairline border, same padding and font as primary. On `:hover`: background `surface-rest`. The "I want to take an action but not the single most important one" button.
- **Ghost** (`ds-btn-ghost`): no background, no border, `paper-mute` text, same padding. On `:hover`: background `surface-rest`, text `paper`. The "I'm here just for completeness" button — close, dismiss, cancel.

### Status Tag

Used to indicate the state of a row item: campaign status, lead status, request status. Always: mono, uppercase, paired with a 6px dot of the same semantic colour.

- **Shape:** `rounded.sm` (4px) wrapper, but visually it's "dot + text" not a pill.
- **Composition:** `<span><span class="dot" style="background:{color}"/> ТЕКСТ</span>`
- **Active variant:** dot `#f5a623` + text `#f5a623`, font JetBrains Mono 500 11px uppercase.
- **Attention variant:** dot `#e5484d` + text `#e5484d`.
- **Go variant:** dot `#46a758` + text `#46a758`.
- **Quiet variant:** dot `#6c6c70` + text `#a1a1a3` (the *only* place the dot and text colour differ — quiet status is muted text with muted dot, not "bright muted" mixed).

### List Rows

The dominant pattern in this system. Used for: campaigns list, replies list, leads list, request list, log list. Replaces cards-with-content in 90% of cases.

- **Style** (`ds-list-row`): no background at rest, padding `12px 16px` (compact) or `14px 20px` (comfortable), text body 13px. Rows are siblings inside a `card-container`; first row has no top border, subsequent rows have `border-top: 1px solid #1f2023`.
- **Hover:** background `surface-elev` (`#18191c`), text remains `paper`. Cursor `pointer`.
- **Active / Pressed:** background `surface-active` (`#1f2023`).
- **Focus:** focus ring (paper 30% double-track).
- **Composition:** leading status dot (optional) → main column with title + meta sublabel → trailing actions (timestamp in mono, arrow icon). Touch target ≥44px on mobile.

### Editorial Eyebrow

Section header above a list-row group, a card, or a content block.

- **Style:** font JetBrains Mono 500 11px, colour `paper-faint` (`#6c6c70`), letter-spacing `0.02em`, margin-bottom 12px.
- **Format:** `NN → Section Name` — two-digit local index, arrow separator, title in normal case (not uppercase).
- **Example:** `02 → Сегодня требуют внимания`, `03 → Кампании`. Numbers are page-local, not global.

### Card Container

Used to group list-rows or section content. **Not** used as a decoration around individual items.

- **Style** (`ds-card`): `surface-rest` background (`#111213`), `rounded.lg` (8px), no border, no shadow, padding 0 (rows manage their own padding) or `20px` (when wrapping non-row content). The 1-step lightness lift from `ink` is the entire separation device.

### Inputs

- **Style** (`ds-input`): `surface-rest` background, `1px solid #2a2b2f` hairline border, `paper` text, `paper-faint` placeholder, padding `8px 12px`, `rounded.md` (6px), font Inter 400 13px.
- **Focus:** border becomes `#fafafa` (paper). Background unchanged. No glow.
- **Disabled:** background `ink`, text `paper-faint`, border `divider`.
- **Error:** border `#e5484d`, helper text below in same colour 12px.

### Navigation

- **Sidebar items** (`ds-nav-item`): inline-flex, padding `6px 10px`, `rounded.sm` (4px), font Inter 500 13px, colour `paper-mute` at rest. Hover: background `surface-rest`, colour `paper`. Active: background `surface-elev`, colour `paper`. No bullet, no icon-square, no chromatic accent.
- **Group labels** (`ds-nav-group`): editorial eyebrow style — JetBrains Mono 11px, `paper-faint`, margin around `12px 4px`. Use page-local numbering when groups feel like distinct concerns (`01 → Старт`, `02 → Мониторинг`, `03 → Архив`). If groups don't naturally number, drop the number and just leave the title.

### Focus Indicator (system-wide)

Every interactive element exposes `:focus-visible` with a double-track paper ring: `box-shadow: 0 0 0 2px rgba(250, 250, 250, 0.3), 0 0 0 4px #0a0a0a`. The inner 2px is paper at 30% alpha; the outer 4px is `ink` so the ring reads on top of any surface colour (rest, elev, active). Never a coloured focus glow.

## 6. Do's and Don'ts

### Do

- **Do** use `ink` `#0a0a0a` as the page background everywhere. Cards lift one step to `surface-rest`; hover lifts another step to `surface-elev`. Three steps total.
- **Do** speak in `paper` (`#fafafa`) for chrome — primary buttons, active nav, links, focus ring. Status colours stay in dots and short tags only.
- **Do** apply the **Editorial Eyebrow Rule** to every section above a card or row group: `NN → Title` in JetBrains Mono `paper-faint`. This is the system's signature.
- **Do** use Inter at four weights (400 / 500 / 600 / 700) and JetBrains Mono at two (500 / 600). No third family.
- **Do** keep status compact: 6px dot + uppercase mono tag (`АКТИВНА`). Status never fills a card background.
- **Do** prefer list-rows over cards-with-content. A dashboard is a stack of titled row-groups, not a grid of decorative cards.
- **Do** localise every label — `1234 отправлено` not `1234 sent`. JetBrains Mono has full cyrillic and renders Russian uppercase correctly.
- **Do** make focus visible everywhere. Double-track paper ring on `:focus-visible` is the standard. Never `outline: none` without a replacement.
- **Do** use the arrow `→` (U+2192) as the editorial separator. Hyphens for compound words (`OutreachOS-кампания`); commas, colons, periods for sentence punctuation.

### Don't

- **Don't** introduce `box-shadow` outside `:focus-visible`. Depth comes from the surface ramp, not glow.
- **Don't** use neon yellow `#E8FF59`, lime green, or any other "AI-tool" reflex accent in the product chrome. That palette lives on the landing only. PRODUCT.md Anti-reference 4.
- **Don't** use `#000000` for any surface or `#ffffff` for any text. The 2% offset (`#0a0a0a` / `#fafafa`) is what makes long sessions tolerable.
- **Don't** apply chromatic colour to chrome — no purple primary buttons, no blue links, no rainbow nav indicators. The chrome speaks paper-white only.
- **Don't** apply `border-left: Npx solid <color>` or any side-stripe accent as a tag. Status is a dot + mono tag, not a colour stripe.
- **Don't** use `background-clip: text` with a gradient anywhere. No gradient text, ever, even on wordmarks.
- **Don't** use `gradient` fills on buttons. White-on-black is the entire primary CTA visual language.
- **Don't** carry forward any `.neu-*` class or `--cp-*` token from the previous Calm Workshop iteration. The pivot is decisive — neumorphic warm-stone is archived in `.impeccable/legacy-design.md`, not extended.
- **Don't** introduce a third typeface, a script, or a serif italic. Inter + JetBrains Mono. The temptation to add Instrument Serif for "warmth" is a marketing-page move; the product doesn't need it.
- **Don't** decorate cards with rainbow per-row icons (`#3B82F6` blue + `#F59E0B` amber + `#10B981` green). That is the Bitrix/Amo reflex from PRODUCT.md Anti-reference 1.
- **Don't** chase glassmorphism, blur surfaces, or "frosted" effects. The system is flat by doctrine.
- **Don't** invent rounded corners larger than `rounded.xl` (12px). Sharp readability beats pillowed softness — the previous Calm Workshop's 20px card radius doesn't belong in this language.
- **Don't** mix this system with leftover `.client-portal` `.neu-*` styles. When migrating a screen, fully rewrite its chrome to the new tokens; don't leave half-neumorphic, half-editorial surfaces.
- **Don't** use the editorial-numbering pattern as decoration (sprinkling `FIG 0.X` on screens that don't need section markers). The numbering only earns its place when the page has 2+ distinct section concerns the user navigates between.
