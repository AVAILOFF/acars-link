# Visual style specification

Source: the Claude Design canvas "ACARS for MSFS 2024", the "Design system" page. The values are in `tokens.css` and `fms.css`. The artboard sources are `artboards/*.dc.html` (HTML templates; read them as text, they do not render without the canvas runtime).

## 1. Concept

- **Shell** — dark graphite: top bar, tabs, status panels. Buttons are flat graphite `--btn` plates, radius 6, no outline.
- **Active** — a solid blue `--active` fill with white text (tab, segment, primary button). One selected element per group.
- **Content** — light `--sheet-*` sheets (radius 10): the message feed, scenarios, settings, forms.
- **FMS screen** — a separate system (`fms.css`): black background, green text only, B612 Mono.
- Colour only by meaning. Magenta / route blue / NOTAM are only for navigation semantics, not for UI states.
- No gradients, glow, decorative shadows. A shadow only on floating elements (menu, modal, tooltip).

## 2. Typography

System grotesque (`--font-ui`), `font-variant-numeric: tabular-nums` for time, flight levels, frequencies, weights.

| Role | Size / line height | Weight |
|---|---|---|
| title-lg | 22 / 28 | 600 |
| title (sheet heading, rows) | 17 / 22 | 600 |
| subtitle | 13 / 18 | 400, `--on-*-2` |
| control (buttons, tabs) | 15 / 20 | 500 |
| body | 15 / 20 | 400 |
| label-caps | 12 / 16 | 500, caps, +0.02em, `--on-sheet-2` |
| value | 17 / 22 | 500, tabular |
| FMS large / small | 15 / 21 and 12 / 21 | B612 Mono 400 |

Headings no larger than 22 px. A separate monospaced font is not needed in the UI — only on the FMS screen.

## 3. Grid and sizes

- 4 px step: 4 · 6 · 8 · 12 · 16 · 24 · 32.
- Control 34 (small 30), sheet row 44, two-line 64, top bar 52, bottom 48, icon button 40×40.
- Radii: 4 (FMS screen), 6 (controls), 10 (sheets, panels, modals), pill (ICAO chips).
- Default app window 1180×820 → the right/left column no wider than 360, the feed takes the rest. Below 1024 the columns stack into one.

## 4. Components (`DsComponents` artboard)

| Component | Sizes | Normal | Hover | Active/pressed | Focus | Disabled | Error |
|---|---|---|---|---|---|---|---|
| Shell button | h34, pad 0 14, r6 | `--btn`, white | `--btn-hover` | `--btn-pressed` | `--focus` | `--btn-disabled`, `--on-shell-off` | — |
| Primary button | same | `--active` 600 | `--active-hover` | `--active-pressed` | `--focus` | as above | — |
| Button on a sheet | same | `--sheet-btn`, `--on-sheet-1` | #E2E3E7 | #D6D8DD | `--focus` | `--on-sheet-off` | — |
| Danger (Stop) | same | `--btn`, text #FF7A70 | #4A3436 | `--warning` + white | `--focus` | as above | — |
| Tab | plate h34, gap 8, r6 | `--btn` | `--btn-hover` | `--active` | `--focus` | `--btn-disabled` | — |
| Switch | 44×26, knob 22 | track #4A505A | — | track `--ok` | `--focus` | track `--shell-2` | — |
| Segments | track `--field` r8, segment h30 r6 | transparent | — | `--active` | `--focus` | `--on-shell-off` | — |
| Field on a sheet | row 52, caps label on the left | `--on-sheet-1` 17 | — | — | inset 2px `--focus-ring` | `--on-sheet-off` | background `--warning-tint`, label/hint `--warning` |
| Field on the shell | h34 r6 `--field` | placeholder `--on-shell-3` | — | — | `--focus` | `--shell-2` | — |
| Sheet/table row | h44, line `--sheet-line` | `--sheet-row` | `--sheet-row-hover` | `--sheet-select` + inset 4px `--active` on the left | `--focus` | text `--on-sheet-off` | `--warning-tint` |
| ICAO chip | h26 pill | `--chip`, white 14/500 | — | — | — | #A3A7AF | — |
| Status pill | h22 r11 13/600 | light tone + dark text (VFR #E3F5EA/#1E7A43, IFR #FDF0DC/#8F5600, error #FDE7E5/#B3261E) | — | — | — | — | — |
| Banner | r8 `--shell-2`, pad 8 10 | dot/icon in the status colour + word (Info/Warning/Error) + `--btn` button h30 | — | — | — | — | — |
| Modal/sheet | r10 `--sheet-bg`, header 52 `--sheet-header`, title 17 centred, ✕ circle 30 #A3A7AF | shadow `--shadow-float`, backdrop rgb(0 0 0/.6) | — | — | focus trap, Esc | — | — |
| Tooltip | r8 `--btn`, 13/18, pad 8 10 | delay 400 ms | — | — | — | — | — |
| Loading | segments 8×6 r1, 4 px bar with an 18 knob, skeleton #ECEDF0 on a sheet | no spinners | — | — | — | — | — |

Status is always duplicated by a word, not only by colour. Indicator circles in the status row of the top bar are **not used** (user's decision) — the state is conveyed by the colour of the value text.

## 5. FMS screen (`fms.css`, `FmsWindow` artboard)

- Background `#000`, text `--fms-text`, secondary `--fms-text-dim`. There are no other colours on the screen.
- Width in characters = the profile's `FlightSummary.lineWidth` (24 / 27 / 30), not a fixed one.
- Hierarchy: large/small font, muted green, CDU syntax (`<PROMPT`, `PROMPT>`, `[ ]`, dashed separator).
- The frame around the screen is `--fms-bezel`; the labels on the frame are neutral (it is the casing, not the screen).
- Keyboard focus is a ring on the frame element, the screen is not recoloured.

## 6. Behaviour

- Notifications only in a banner above the content or in the bottom bar; they push the content, they do not cover it. No pop-up toasts.
- Data refresh: fixed column widths + tabular-nums, values do not "jump"; a new feed entry is highlighted with `--sheet-select` for 1 s; the scroll position is kept.
- Animation only functional (120–160 ms), disabled under `prefers-reduced-motion`.
- Focus: a double `--focus` ring on all interactive elements; order: top bar → tabs → left column → feed → pilot form.
