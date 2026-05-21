---
name: Portal Client
description: "Calm Workshop — a self-serve client portal for OutreachOS outbound services. Warm-stone surfaces, slate-blue accent, neumorphic tactility, Nunito throughout."
colors:
  linen-cream: "#F5F5F4"
  walnut-ink: "#3A3530"
  walnut-mid: "#6A6058"
  walnut-soft: "#9A9088"
  slate-tide: "#4A6FA5"
  slate-tide-deep: "#3D5A87"
  terracotta-signal: "#B85450"
  spruce-positive: "#10B981"
  amber-prompt: "#F59E0B"
  paper-elevated: "#FFFFFF"
typography:
  display:
    fontFamily: "Nunito, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.5rem, 3vw, 1.875rem)"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Nunito, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.25rem, 2vw, 1.5rem)"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Nunito, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Nunito, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Nunito, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.12em"
rounded:
  sm: "12px"
  md: "14px"
  lg: "16px"
  xl: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.slate-tide}"
    textColor: "{colors.paper-elevated}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.slate-tide-deep}"
    textColor: "{colors.paper-elevated}"
  button-ghost:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.walnut-mid}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  button-ghost-active:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.slate-tide}"
  card-elevated:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.walnut-ink}"
    rounded: "{rounded.xl}"
    padding: "20px"
  card-elevated-sm:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.walnut-ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  card-well:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.walnut-mid}"
    rounded: "{rounded.sm}"
    padding: "12px 16px"
  input-recessed:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.walnut-ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  nav-pill:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.walnut-mid}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  nav-pill-active:
    backgroundColor: "{colors.linen-cream}"
    textColor: "{colors.slate-tide}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
---

# Design System: Portal Client

## 1. Overview

**Creative North Star: "Calm Workshop"**

The Portal Client surface should feel like a quiet workshop at the back of an outreach agency. Tools are within reach, surfaces are warm to the touch, the light is even, and nothing is shouting for attention. The visitor (the agency's paying B2B customer) walked in to check on work-in-progress, not to be impressed by the room. Every surface earns its presence by helping that visitor answer a single question: *"what is happening for my business right now, and what do I need to do next?"*

The system is built on three commitments. First, a **warm-stone palette** (`linen-cream` `#F5F5F4` as the universal canvas, `walnut-ink` `#3A3530` for text) replaces the cold grey-on-white default of generic SaaS. Second, **neumorphic tactility**: every primary surface is shaped by a paired warm dark shadow and a soft light highlight, so cards, buttons, and pills read as physical objects sitting on a linen tabletop rather than as flat rectangles painted on a screen. Third, a **single slate-blue accent** (`slate-tide` `#4A6FA5`) carries every clickable affordance the client cares about; the rest of the chrome stays in stone-and-walnut.

This system explicitly rejects: Bitrix/Amo-style multicoloured icon parades, generic SaaS-cream landing-page-as-dashboard aesthetics, AI-slop enterprise-blue-with-gradient-hero, and OpenAI-style black-and-neon — all called out in PRODUCT.md as anti-references for the client surface.

**Key Characteristics:**

- Warm, low-saturation palette (linen + walnut + slate)
- Neumorphic shadows as **material**, not as decoration
- Nunito throughout — friendly humanist sans, latin + cyrillic
- Slate-blue accent reserved for genuine actions only
- Generous radii (12-20px) — never sharp, never pill-overstated
- Density flexes via `.ui-density-compact` for heavy desktop pages

## 2. Colors

A warm, low-saturation palette built around `linen-cream` `#F5F5F4` as the only background. There is no white surface anywhere by default. Hex values are authoritative for tooling; OKLCH is given as the canonical perceptual reference.

### Primary

- **Slate Tide** (`#4A6FA5`, oklch(50% 0.078 254)): the single accent. Used for: primary button fills, active sidebar pill text, hover state of links inside lists, focus rings (at 25% alpha). It is reserved — if a screen has 5 slate-tide marks, 3 of them are wrong.
- **Slate Tide Deep** (`#3D5A87`, oklch(43% 0.08 254)): hover state of the primary button. Never used as a fill on its own.

### Neutral

- **Linen Cream** (`#F5F5F4`, oklch(96.4% 0.001 67)): the universal surface. Page background, card background, button-ghost background, input background. Warm rather than greenish or bluish; the slight warmth is the whole point.
- **Walnut Ink** (`#3A3530`, oklch(25% 0.012 67)): primary text on `linen-cream`. Not `#000`. Contrast ratio ≈ 12.7:1 against the background.
- **Walnut Mid** (`#6A6058`, oklch(45% 0.012 67)): secondary text (descriptions, captions, table body cells). Contrast ≈ 5.8:1.
- **Walnut Soft** (`#9A9088`, oklch(63% 0.012 67)): tertiary text (placeholders, labels, eyebrows, meta). Contrast ≈ 3.2:1 — passes WCAG AA for large text only; avoid on body copy.
- **Paper Elevated** (`#FFFFFF`, oklch(100% 0 0)): the only place pure white is permitted is for cards that re-host admin components inside the client portal (parser tables, base constructor) — these have to be readable as data surfaces and the neumorphic stone gets too low-contrast under them. Never use for primary client UI.

### Danger

- **Terracotta Signal** (`#B85450`, oklch(55% 0.135 25)): error messages, danger toasts, destructive button text. Warm and muted, not the standard `#dc2626` SaaS-red. Sits comfortably on `linen-cream` without screaming.

### Ad-hoc Accents (currently in code; quarantine zone)

These appear in the current dashboard's `MetricCard`, `QuickAction`, and `OnboardingChecklist` components. They are **not part of the system** — they're shipped reality that the system intends to shrink. Listed here for honesty, not for replication.

- **Spruce Positive** (`#10B981`): completion checkmarks, "kick off campaign" CTA on dashboard.
- **Amber Prompt** (`#F59E0B`): "fill the brief" CTA icon, sparkles in onboarding header.
- Plus: `#3B82F6` (Base icon), `#F97316` (Sequences icon), `#8B5CF6` / `#7C3AED` (gradient ends), `#F43F5E` (reply-rate metric icon), `#6366F1` (RU/EN toggle).

### Named Rules

**The Single Slate Rule.** Slate Tide is the only chromatic accent in chrome (nav, buttons, focus, active states). Anything coloured outside that role — orange icons, gradient buttons, rainbow metric cards — is legacy and gets unified during redesign work.

**The No-White-Background Rule.** The page is `linen-cream`. The card is `linen-cream`. The input is `linen-cream`. The button ghost is `linen-cream`. Depth is conveyed by shadow, not by colour swap. The only allowed `#FFFFFF` is the admin-component bridge (Paper Elevated above) and that's a known exception, not a pattern to reach for.

**The Warm-Neutral Rule.** No `#000`, no `#fff` for type. Text is always walnut. The 0.012 chroma on the neutral ramp ties everything back to the warm hue and makes the palette read as a single material.

## 3. Typography

**Display / Body Font:** Nunito (Google Fonts, subsets: latin, cyrillic). Loaded via `next/font/google` in `app/src/app/client/layout.tsx` with `display: 'swap'`.

**Character:** Nunito is a humanist sans with rounded terminals — it carries the "friendly and alive" tone PRODUCT.md asks for without slipping into Comic-Sans cuteness. Used uniformly across hierarchy; weight (400 / 700 / 800) and size do the differentiation. There is no mono, no display serif, no second face.

### Hierarchy

- **Display** (`800`, `clamp(1.5rem, 3vw, 1.875rem)`, `1.15`): hero on `/client/dashboard`. One per page, never more.
- **Headline** (`800`, `clamp(1.25rem, 2vw, 1.5rem)`, `1.2`): page H1 on every other client route (`/client`, `/client/leads`, `/client/replies`). Often paired with an inline icon.
- **Title** (`700`, `1rem`, `1.3`): section heading inside a card (`<h2>` for "Quick actions", "Last campaigns", checklist title).
- **Body** (`400`, `0.875rem`, `1.55`): descriptions, table cells, paragraph copy. Cap line length at 65-75ch in long-form sections (briefs, support, reports).
- **Label** (`700`, `0.625rem` (10px), `1.3`, `letter-spacing: 0.12em`, uppercase): eyebrows above sections, table headers, metric card labels, navigation group titles. The wide-tracking-uppercase is the project's signature for chrome text.

### Named Rules

**The One-Face Rule.** No second typeface. If something needs differentiation, it gets it through weight (400 → 700 → 800) or letter-spacing (the label treatment), never through a switch to Inter / Geist / Mono.

**The Wide-Label Rule.** Whenever you write a small uppercase label, it is `text-[10px] font-bold uppercase tracking-[0.12em]`, walnut-soft colour. This pattern is used in: sidebar group headers, metric labels, eyebrows. It is the same recipe everywhere — do not invent a 9px alternative or drop the tracking.

## 4. Elevation

The system is **explicitly neumorphic**: depth is conveyed by paired shadows, not by tonal layering or single-direction drops. A surface sits on the linen tabletop because a warm dark shadow falls down-and-right of it and a soft white highlight catches up-and-left. The same surface, inverted (inset), reads as carved into the tabletop instead of resting on it. This is the dominant material of the system.

Light direction is fixed: **upper-left source**. Dark shadows fall to the lower-right (positive offsets); highlights rise to the upper-left (negative offsets). Inverting that direction breaks the illusion immediately.

### Shadow Vocabulary

All shadows use the warm shadow pair: `--cp-shadow-d: rgba(150, 140, 130, 0.60)` (warm grey-brown, the "dark") and `--cp-shadow-l: rgba(255, 255, 255, 0.94)` (almost pure highlight). Hex of the dark approximates `oklch(63% 0.012 67) / 0.6`.

- **Outset Lifted** (`box-shadow: 6px 6px 14px var(--cp-shadow-d), -6px -6px 14px var(--cp-shadow-l)`): the primary `.neu-card`. Used for hero, dashboard sections, large content containers.
- **Outset Resting** (`box-shadow: 4px 4px 10px var(--cp-shadow-d), -4px -4px 10px var(--cp-shadow-l)`): the compact `.neu-sm`. Metric cards, quick-action items, smaller list cards.
- **Outset Button** (`box-shadow: 3px 3px 8px var(--cp-shadow-d), -2px -2px 6px var(--cp-shadow-l)`): the `.neu-btn` at rest. Asymmetric — the highlight is slightly tighter than the shadow to keep the button feeling decisive rather than floating.
- **Inset Carved** (`box-shadow: inset 2px 2px 5px var(--cp-shadow-d), inset -2px -2px 5px var(--cp-shadow-l)`): the `.neu-inset` / `.neu-well` / `.neu-input` / active `.neu-pill`. Reads as recessed into the surface; used for fields, wells, and selected states.
- **Press-Down** (`box-shadow: inset 2px 2px 5px rgba(0, 0, 0, 0.15)`): the `.neu-btn:active`. The button gets pushed in — same gesture as a physical key.
- **Hover Lift** (`.neu-flat:hover` → `3px 3px 8px / -3px -3px 8px`): a flat surface receives a small outset on hover. Used sparingly; most surfaces are committed to a resting state.
- **Accent Glow** (`box-shadow: 0 2px 8px rgba(74, 111, 165, 0.35)`): the gradient primary buttons in parser/admin contexts have a soft slate-tide glow underneath. This is leakage from admin styling and is not part of the canonical button vocabulary — listed for completeness.
- **White Card Lift** (`box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 18px rgba(0,0,0,0.05)`): the admin-bridge white cards (parser tables, brief sections) use a conventional drop shadow because they explicitly break out of the neumorphic system.

### Named Rules

**The Material Rule.** Shadows are material, not decoration. A shadow appears because a surface exists at that position; it never appears for emphasis, drama, or "polish". If you can remove the shadow without changing the user's mental model of the surface, the shadow shouldn't be there.

**The Light-from-Upper-Left Rule.** Always. Dark to lower-right, highlight to upper-left. Reversing this is forbidden — it instantly reads as broken even when the user can't articulate why.

## 5. Components

### Buttons

- **Shape:** medium radius (14px, `rounded.md`) for the primary; small radius (12px, `rounded.sm`) for the ghost / pill variants.
- **Primary** (`.neu-btn`): `slate-tide` background, white text, Outset Button shadow at rest, Press-Down on `:active`. Padding `10px 18px`, font-weight `600-700`, transition `all 0.2s ease`. Hover deepens to `slate-tide-deep` and tightens the shadow (`1px 1px 4px / -1px -1px 4px`) — the button "settles" rather than lifts.
- **Ghost** (`.neu-pill` at rest): `linen-cream` background, walnut-mid text, no shadow. Used for: language toggle, log-out button in header, sidebar links, secondary actions.
- **Ghost Active** (`.neu-pill.active`): same surface, slate-tide text, Inset Carved shadow. Reads as "pressed in and held" — the active nav state.
- **Hover (ghost)**: receives the Outset Resting shadow.

### Cards

- **Card Elevated** (`.neu-card`): `linen-cream` background, `rounded.xl` (20px), Outset Lifted shadow, padding `p-5 / p-6` (20-24px) on desktop, `p-5 sm:p-6` responsive. Used for hero sections, large feature blocks, the onboarding checklist container.
- **Card Elevated Small** (`.neu-sm`): same colour, `rounded.lg` (16px), Outset Resting shadow, padding `p-3 sm:p-5`. Used for metric tiles, quick-action rows that aren't the primary CTA.
- **Card Well** (`.neu-well`): `linen-cream` with Inset Carved shadow, `rounded.sm` (12px). Used for inline contextual containers (the "error" inset on the campaigns page, secondary information wells).
- **Hover behavior** (`.neu-flat:hover`): rest cards do not lift on hover by default. The `.neu-flat` modifier opts a surface in. List rows use `.neu-row` instead — background tint, no shadow change.
- **Internal Padding:** card content uses `space-y-4` to `space-y-8` for vertical rhythm; horizontal padding follows the `p-{4|5|6|8}` Tailwind scale. Compact density mode (`.ui-density-compact`) collapses these to `p-{1.5|2}` on desktop ≥768px.

### Inputs / Fields

- **Style** (`.neu-input`): `linen-cream` background, no visible border, Inset Carved shadow at rest, `rounded.md` (14px), walnut-ink text. The recessed shadow signals "you can type here" without a border line.
- **Focus:** retains the inset, adds a slate-tide ring `0 0 0 2px rgba(74,111,165,0.25)`. No border colour change.
- **Placeholder:** walnut-soft.
- **Admin overrides:** inside admin components reused in the client portal, inputs switch to white background + 1px hairline border (`rgba(180,173,164,0.3)`) + soft inset of `0 1px 3px rgba(0,0,0,0.04)`. This bridge style is intentional but is the only inputs context outside the neumorphic rule.

### Navigation

- **Sidebar** (`ClientSidebar`): sticky 250-270px column, group headings in the **Wide-Label** treatment, items as `.neu-pill` with `truncate` text. Active item gets `.neu-pill.active` (inset + slate-tide text). The sidebar lives inside an `aside` with `direction: rtl` wrapper to push its scrollbar to the inner edge — content overrides back to `direction: ltr`.
- **Mobile drawer** (`ClientMobileDrawer`): replaces the sidebar below `md`; uses the same `.neu-pill` items.
- **Header:** sticky, sits inside a `.neu-card` to lift it from the scroll. Currently carries: drawer-toggle (mobile), the "Portal" wordmark, RU/EN toggle, sign-out pill.

### List Rows

- **Style** (`.neu-row`): no shadow, no background at rest, walnut-ink text. Hover adds `background: rgba(180, 173, 164, 0.1)` (a tint of the warm shadow colour). Used in dashboard recent-campaigns list, campaign table body, leads/replies rows.
- **Separators:** thin warm-grey `1px solid rgba(180,173,164,0.15)` borderTop between rows inside a `.neu-card`. There is **no** dividing line between the outermost card edge and the first row.

### Loading / Empty States

- **Spinner:** `.neu-spinner` — 24×24 ring with `--cp-shadow-d` track and `--cp-accent` arc. Always paired with text ("Загружаем кампании…").
- **Progress bar (indeterminate):** linear gradient `slate-tide → #7C3AED` sliding inside a 6px-tall warm-grey track. Used for long fetches with unknown ETAs.
- **Empty state:** `.neu-card` centred, icon at top in `walnut-soft`, bold title in `walnut-ink`, soft description in `walnut-mid`, single `.neu-btn` CTA. The "Кампаний пока нет" pattern is the canonical empty state.

## 6. Do's and Don'ts

### Do

- **Do** use `linen-cream` `#F5F5F4` as the page surface and every primary container surface. Depth is shadow's job, not colour's.
- **Do** restrict colour-as-meaning to `slate-tide` (action / active), `terracotta-signal` (danger), and `spruce-positive` (genuine completion). Everything else is walnut.
- **Do** put all shadows on the upper-left light source (dark to lower-right, highlight to upper-left).
- **Do** apply the **Wide-Label** treatment (`text-[10px] font-bold uppercase tracking-[0.12em] walnut-soft`) to every chrome label without exception.
- **Do** use Nunito at three weights (400 / 700 / 800) and nothing else.
- **Do** keep buttons honest: a primary action is one slate-tide pill on the screen, not three. If you find yourself wanting two primaries, you have a hierarchy problem, not a button problem.
- **Do** pair every spinner / progress with a sentence describing what's happening ("Загружаем кампании…", "Загружено 47 из 120 кампаний") — see PRODUCT.md "Клиент видит результат, а не процесс".
- **Do** keep tables dense but warm: walnut-mid body text, walnut-ink for numeric emphasis, no zebra striping (the hover tint is enough).

### Don't

- **Don't** use `background-clip: text` with a gradient for the "Portal" wordmark or any other text. Gradient text is decorative, never meaningful — pull the wordmark back to a solid `slate-tide` or `walnut-ink` and let weight carry it. (Currently violated in `app/src/app/client/layout.tsx` line 90-95.)
- **Don't** decorate cards with `border-left: 3px solid <color>` or `border-top: 3px solid <color>` as a "tag" or "category" stripe. The neumorphic shadow already separates the card; the stripe is a side-stripe anti-pattern. (Currently violated in `QuickAction` and `MetricCard` — to be refactored during redesign.)
- **Don't** assign a different colour to every metric / quick-action icon. Five rainbow icons in a row is a Bitrix/Amo CRM reflex called out in PRODUCT.md anti-references. Use the **Single Slate Rule**: one accent, used sparingly.
- **Don't** introduce `linear-gradient(...)` fills on buttons as decoration. The asymmetric Outset Button shadow + the `slate-tide-deep` hover is the entire button visual language. (Currently violated in parser-context buttons inside `.client-portal`.)
- **Don't** use `#000` for text or `#fff` for surfaces. Walnut-ink + linen-cream. The 0.012 chroma on neutrals is what makes the palette feel like a single warm material.
- **Don't** invert the light direction (highlight to lower-right, shadow to upper-left). The system breaks instantly even if the viewer can't name what's wrong.
- **Don't** mix neumorphic and flat-with-conventional-drop-shadow components inside the same surface. The admin-bridge white cards are a known exception; outside that exception, commit to one elevation language per screen.
- **Don't** chase glassmorphism, hero-metric templates ("2,847 ↗ +12% ▲"), gradient hero banners, or sidebar-icon-explosions. These are the AI-slop enterprise-dashboard anti-reference from PRODUCT.md — they have no place in the Calm Workshop.
- **Don't** copy the OpenAI / Anthropic dark-yellow palette into the client product. That palette lives on the marketing landing (`landing/index.html`) and stays there. The client product is warm-stone + slate, not black + neon.
- **Don't** wrap inline copy in vague apologies ("Пожалуйста, обратите внимание", "К сожалению, произошла ошибка"). PRODUCT.md asks for the voice of a calm colleague — see the **Тёплый профессионализм** principle there.
- **Don't** invent a 9px label, a 13px body, or a sharp 8px-radius card. Stay inside the published scales (`rounded.{sm,md,lg,xl}`, `spacing.{xs..2xl}`, the typography levels above). If you genuinely need a new step, add it to the system first.
