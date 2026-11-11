# ACARS Link logo — "Datalink"

An aircraft (white) and link arcs at the nose (`--active`) on a `--shell-1` plate, radius 14/64. Flat: no gradients or shadows (`spec.md`, §1).

| File | Where |
|---|---|
| `icon.svg` | app icon, 64 grid; sizes from 32 px |
| `icon-small.svg` | simplified (one arc, larger aircraft), 16 grid; for 16–24 px |
| `mark.svg` | mark without the plate in `currentColor` — top bar (`App.tsx`, 24 px) |

`pnpm icon` draws `apps/desktop/build/icon.ico` (16–256) and `icon.png` (512); `electron-builder.yml` takes them. After editing the SVG — regenerate.
