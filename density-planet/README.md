# DENSITY PLANET

Interactive 3D orbital globe visualizing **global human population density from 1492 to 2023 CE** built on real **HYDE 3.3** gridded historical data.

## Highlights

- **Equal-Area 3D Population Blocks (GLSL + InstancedMesh)**: Uniformly square blocks across all land latitudes rendered in a single GPU-driven draw call with directional face shading, glowing cyan-to-amber-gold top caps, and selective bloom.
- **Smooth GPU Temporal Interpolation**: 39 keyframes (`1492` interpolated from HYDE's `1400`/`1500` slices, `1500–1700` centennial, `1720–1780` 20-year, `1800–1950` decadal, `1955–2020` 5-yearly, plus `2023`) at `0.25°` (`1440×720`) log-quantized resolution, continuously interpolated on the GPU along a linear timeline.
- **Scale & Elevation Controls**: Fixed global logarithmic scale by default (showing the 1492 baseline erupting into 2023 megacities), plus a HUD toggle for per-year relative normalization and an interactive block elevation slider.
- **Focused Telemetry Cockpit**:
  - Live Year, World Population, and Peak Density readouts.
  - Hover or click anywhere on the globe to probe local coordinates, country, nearest city, current density, and a **1492–2023 local trajectory sparkline** (clicking pins an orbital reticle that tracks live during playback).
  - Dynamic top-hotspot callouts evolving across eras and curated orbital camera sector bookmarks.
  - Keyboard shortcuts: `Space` (Play/Pause), `←` / `→` (step ±5 yrs, `Shift` ±1 yr), `Esc` (unpin reticle).

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm test      # Vitest unit suite (geo math, log encoding, temporal bracketing, offline atlas)
npm run build # TypeScript typecheck + Vite production bundle
```

## Reproducing the HYDE 3.3 Data Pipeline

Download `population_density.nc` from the Utrecht University / PBL **HYDE 3.3 Baseline** NetCDF archive into `scripts/.hyde_cache/population_density.nc`, then run:

```bash
npm run data:build
# or: uv run scripts/build_hyde_data.py
```

This regenerates `public/data/manifest.json`, `public/data/land_mask.png`, and `public/data/frames/{year}.png`.

## Data Attribution

- **HYDE 3.3**: Klein Goldewijk, K., Beusen, A., Doelman, J., and Stehfest, E. (PBL Netherlands Environmental Assessment Agency & Utrecht University).
- **Coastlines & Country Borders**: Natural Earth via `world-atlas`.
