#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "netCDF4>=1.7.0",
#   "numpy>=2.0.0",
#   "pillow>=11.0.0",
# ]
# ///
"""
Preprocess HYDE 3.3 Baseline `population_density.nc` into compact static assets
for the density-planet 3D WebGL globe.

Outputs:
  public/data/manifest.json
  public/data/land_mask.png        (1440x720 grayscale PNG)
  public/data/frames/{year}.png    (31 keyframes, 1440x720 log1p uint8 grayscale PNGs)
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import netCDF4 as nc
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
NC_PATH = ROOT / "scripts" / ".hyde_cache" / "population_density.nc"
OUT_DIR = ROOT / "public" / "data"
FRAMES_DIR = OUT_DIR / "frames"

TARGET_YEARS = [
    1492,
    1500, 1600, 1700, 1720, 1740, 1760, 1780,
    1800, 1810, 1820, 1830, 1840, 1850, 1860, 1870, 1880, 1890,
    1900, 1910, 1920, 1930, 1940, 1950,
    1955, 1960, 1965, 1970, 1975, 1980, 1985, 1990, 1995, 2000,
    2005, 2010, 2015, 2020, 2023,
]

BLOCK = 3  # 2160x4320 (5 arc-min) -> 720x1440 (0.25 deg)
EARTH_RADIUS_KM = 6371.0088

# Major historical and modern reference centers for naming extracted HYDE peaks
REFERENCE_CENTERS = [
    ("Tokyo", "Japan", 35.68, 139.69),
    ("Osaka–Kansai", "Japan", 34.69, 135.50),
    ("Seoul", "South Korea", 37.57, 126.98),
    ("Shanghai / Yangtze", "China", 31.23, 121.47),
    ("Beijing–Tianjin", "China", 39.90, 116.41),
    ("Pearl River Delta", "China", 23.00, 113.50),
    ("North China Plain", "China", 35.20, 115.20),
    ("Sichuan Basin", "China", 30.57, 104.07),
    ("Wuhan", "China", 30.59, 114.31),
    ("Taipei", "Taiwan", 25.03, 121.57),
    ("Delhi", "India", 28.61, 77.21),
    ("Ganges Plain", "India", 25.80, 83.20),
    ("Kolkata / Bengal", "India", 22.57, 88.36),
    ("Mumbai", "India", 19.08, 72.88),
    ("Chennai", "India", 13.08, 80.27),
    ("Bengaluru", "India", 12.97, 77.59),
    ("Kerala Coast", "India", 10.10, 76.30),
    ("Dhaka", "Bangladesh", 23.81, 90.41),
    ("Lahore / Punjab", "Pakistan", 31.55, 74.36),
    ("Karachi", "Pakistan", 24.86, 67.01),
    ("Jakarta / Java", "Indonesia", -6.50, 107.60),
    ("East Java", "Indonesia", -7.30, 112.60),
    ("Manila", "Philippines", 14.60, 120.98),
    ("Ho Chi Minh City", "Vietnam", 10.82, 106.63),
    ("Red River Delta", "Vietnam", 20.95, 105.85),
    ("Bangkok", "Thailand", 13.76, 100.50),
    ("Singapore", "Singapore", 1.35, 103.82),
    ("London", "United Kingdom", 51.51, -0.13),
    ("Manchester–Midlands", "United Kingdom", 53.30, -2.00),
    ("Dublin", "Ireland", 53.35, -6.26),
    ("Paris", "France", 48.86, 2.35),
    ("Low Countries", "Belgium / Netherlands", 51.50, 4.60),
    ("Ruhr Valley", "Germany", 51.45, 7.01),
    ("Berlin", "Germany", 52.52, 13.41),
    ("Po Valley / Milan", "Italy", 45.46, 9.50),
    ("Naples", "Italy", 40.85, 14.27),
    ("Madrid", "Spain", 40.42, -3.70),
    ("Moscow", "Russia", 55.76, 37.62),
    ("St. Petersburg", "Russia", 59.93, 30.36),
    ("Istanbul", "Turkey", 41.01, 28.98),
    ("Tehran", "Iran", 35.69, 51.39),
    ("Cairo / Nile Delta", "Egypt", 30.04, 31.24),
    ("Alexandria", "Egypt", 31.20, 29.92),
    ("Lagos", "Nigeria", 6.52, 3.38),
    ("Kano", "Nigeria", 12.00, 8.59),
    ("Freetown", "Sierra Leone", 8.48, -13.23),
    ("Kinshasa", "DR Congo", -4.44, 15.27),
    ("Lake Victoria", "East Africa", -0.60, 33.40),
    ("Johannesburg", "South Africa", -26.20, 28.05),
    ("New York", "United States", 40.71, -74.01),
    ("Los Angeles", "United States", 34.05, -118.24),
    ("Chicago", "United States", 41.88, -87.63),
    ("Mexico City", "Mexico", 19.43, -99.13),
    ("São Paulo", "Brazil", -23.55, -46.63),
    ("Rio de Janeiro", "Brazil", -22.91, -43.17),
    ("Buenos Aires", "Argentina", -34.60, -58.38),
    ("Lima", "Peru", -12.05, -77.04),
    ("Bogotá", "Colombia", 4.71, -74.07),
]


def haversine_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(a))))


def label_hotspot(lat: float, lon: float) -> tuple[str, str]:
    best_name, best_region, best_deg = None, None, 1e9
    for name, region, clat, clon in REFERENCE_CENTERS:
        d = haversine_deg(lat, lon, clat, clon)
        if d < best_deg:
            best_deg = d
            best_name, best_region = name, region
    if best_name is not None and best_deg <= 5.5:
        return best_name, best_region
    lat_s = f"{abs(lat):.1f}°{'N' if lat >= 0 else 'S'}"
    lon_s = f"{abs(lon):.1f}°{'E' if lon >= 0 else 'W'}"
    return f"Cluster {lat_s} {lon_s}", best_region or "Global"


def extract_hotspots(
    grid: np.ndarray,
    count: int = 6,
    min_sep_deg: float = 17.0,
) -> list[dict]:
    """
    Extract top geographically separated metro density peaks from a 720x1440 north-up grid
    using true 5x5 local maxima so all world regions compete fairly.
    """
    h, w = grid.shape
    # Smooth with a 3x3 kernel so broad metropolitan cores win over isolated 1-pixel coastal spikes
    p = np.pad(grid, ((1, 1), (1, 1)), mode="wrap")
    smoothed = (
        p[:-2, :-2] + p[:-2, 1:-1] + p[:-2, 2:]
        + p[1:-1, :-2] + 2.0 * p[1:-1, 1:-1] + p[1:-1, 2:]
        + p[2:, :-2] + p[2:, 1:-1] + p[2:, 2:]
    ) / 10.0

    # Find 5x5 local maxima across the entire globe
    pad2 = np.pad(smoothed, ((2, 2), (2, 2)), mode="wrap")
    local_max = np.ones_like(smoothed, dtype=bool)
    for dr in range(-2, 3):
        for dc in range(-2, 3):
            if dr == 0 and dc == 0:
                continue
            neighbor = pad2[2 + dr : 2 + dr + h, 2 + dc : 2 + dc + w]
            local_max &= smoothed >= neighbor

    # Exclude polar artifacts and tiny uninhabited noise
    local_max &= smoothed > 25.0
    rows, cols = np.nonzero(local_max)
    scores = smoothed[rows, cols]
    order = np.argsort(scores)[::-1]

    chosen: list[dict] = []
    for i in order:
        if len(chosen) >= count:
            break
        r = int(rows[i])
        c = int(cols[i])
        lat = 90.0 - (r + 0.5) * (180.0 / h)
        lon = -180.0 + (c + 0.5) * (360.0 / w)

        if any(haversine_deg(lat, lon, ch["lat"], ch["lon"]) < min_sep_deg for ch in chosen):
            continue

        r0, r1 = max(0, r - 1), min(h, r + 2)
        c0, c1 = max(0, c - 1), min(w, c + 2)
        peak_val = float(np.max(grid[r0:r1, c0:c1]))
        name, region = label_hotspot(lat, lon)
        chosen.append(
            {
                "name": name,
                "region": region,
                "lat": round(lat, 2),
                "lon": round(lon, 2),
                "density": round(peak_val, 1),
            }
        )
    return chosen


def compute_native_cell_areas_km2(lats: np.ndarray, n_lon: int) -> np.ndarray:
    """Exact spherical trapezoid area (km²) per latitude row for a regular lat/lon grid."""
    dlat = abs(float(lats[1] - lats[0]))
    dlon_rad = math.radians(360.0 / n_lon)
    lat_north = np.radians(np.clip(lats + dlat / 2.0, -90.0, 90.0))
    lat_south = np.radians(np.clip(lats - dlat / 2.0, -90.0, 90.0))
    band_area = (EARTH_RADIUS_KM ** 2) * dlon_rad * np.abs(np.sin(lat_north) - np.sin(lat_south))
    return band_area.astype(np.float64)


def downsample_3x3(raw: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Downsample 2160x4320 array with NaN/negative oceans into 720x1440:
      - density: spatial average across the 3x3 cell (suppresses single-sliver coastal 100k caps
        while preserving true 0.25°-scale metropolitan densities)
      - land_mask: bool where at least 2 of 9 subcells are valid land
    """
    h, w = raw.shape
    oh, ow = h // BLOCK, w // BLOCK
    reshaped = raw.reshape(oh, BLOCK, ow, BLOCK)
    valid = np.isfinite(reshaped) & (reshaped >= 0.0)
    valid_count = valid.sum(axis=(1, 3))
    # Cap HYDE's internal 100k micro-sliver ceiling to 35k before 3x3 spatial mean
    clean = np.where(valid, np.minimum(reshaped, 35000.0), 0.0)
    density = clean.sum(axis=(1, 3)) / (BLOCK * BLOCK)
    land_mask = valid_count >= 2
    density = np.where(land_mask, density, 0.0)
    return density.astype(np.float32), land_mask


def main() -> None:
    if not NC_PATH.exists():
        raise FileNotFoundError(
            f"HYDE 3.3 NetCDF file not found at {NC_PATH}. "
            "Download population_density.nc from Utrecht University HYDE 3.3 Baseline."
        )

    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    ds = nc.Dataset(NC_PATH)
    time_var = ds.variables["time"]
    dates = nc.num2date(
        time_var[:], units=time_var.units, calendar=getattr(time_var, "calendar", "standard")
    )
    year_to_idx = {int(d.year): i for i, d in enumerate(dates)}

    lats = np.asarray(ds.variables["lat"][:], dtype=np.float64)
    lons = np.asarray(ds.variables["lon"][:], dtype=np.float64)
    flip_lat = bool(lats[0] < lats[-1])
    print(
        f"Loaded HYDE 3.3 NetCDF: lat [{lats[0]:.3f}..{lats[-1]:.3f}] flip_lat={flip_lat}, "
        f"lon [{lons[0]:.3f}..{lons[-1]:.3f}]"
    )

    ordered_lats = lats[::-1] if flip_lat else lats
    row_areas = compute_native_cell_areas_km2(ordered_lats, len(lons))

    popd_var = ds.variables["population_density"]
    avail_years = sorted(year_to_idx.keys())

    def load_raw_slice(year: int) -> np.ndarray:
        """Load a native HYDE slice, or geometrically interpolate between bracketing slices (e.g. 1492 from 1400 & 1500)."""
        if year in year_to_idx:
            raw_ma = popd_var[year_to_idx[year], :, :]
            raw = np.ma.filled(raw_ma, np.nan).astype(np.float32)
            raw[raw < 0] = np.nan
            return raw[::-1, :] if flip_lat else raw

        lo_years = [y for y in avail_years if y < year]
        hi_years = [y for y in avail_years if y > year]
        if not lo_years or not hi_years:
            raise ValueError(f"Year {year} is outside available HYDE range")
        y0, y1 = lo_years[-1], hi_years[0]
        t = (year - y0) / (y1 - y0)
        print(f"  Interpolating {year} from native HYDE slices {y0} and {y1} (t={t:.3f})")
        r0 = load_raw_slice(y0)
        r1 = load_raw_slice(y1)
        valid = np.isfinite(r0) & np.isfinite(r1)
        out = np.full_like(r0, np.nan)
        out[valid] = np.expm1(
            np.log1p(r0[valid]) * (1.0 - t) + np.log1p(r1[valid]) * t
        )
        return out

    # Clear stale frames before regenerating
    for old_png in FRAMES_DIR.glob("*.png"):
        old_png.unlink()

    selected_years = TARGET_YEARS
    grids: list[tuple[int, np.ndarray, float, float, float]] = []
    combined_land: np.ndarray | None = None
    global_peak = 0.0

    for year in selected_years:
        raw = load_raw_slice(year)

        # Cap micro-sliver artifacts on native integration too so world pop tracks UN/HYDE totals closely
        valid_native = np.isfinite(raw) & (raw > 0)
        row_sums = np.where(valid_native, np.minimum(raw, 35000.0), 0.0).sum(
            axis=1, dtype=np.float64
        )
        world_pop = float((row_sums * row_areas).sum())

        grid, land_mask = downsample_3x3(raw)
        if combined_land is None:
            combined_land = land_mask.copy()
        else:
            combined_land |= land_mask

        peak_density = float(np.max(grid))
        nonzero = grid[grid > 0.1]
        p995 = float(np.percentile(nonzero, 99.5)) if nonzero.size > 0 else 10.0
        global_peak = max(global_peak, peak_density)

        grids.append((year, grid, world_pop, peak_density, p995))

    assert combined_land is not None
    max_encoded = float(math.ceil(global_peak / 1000.0) * 1000.0)
    log_denom = math.log1p(max_encoded)
    print(f"Global 0.25° peak density: {global_peak:,.1f}/km² -> maxEncodedDensity={max_encoded:,.0f}")

    land_img = Image.fromarray((combined_land.astype(np.uint8) * 255), mode="L")
    land_path = OUT_DIR / "land_mask.png"
    land_img.save(land_path, format="PNG", optimize=True)

    keyframes_meta: list[dict] = []
    total_bytes = land_path.stat().st_size

    for year, grid, world_pop, peak_density, p995 in grids:
        norm = np.clip(np.log1p(grid) / log_denom, 0.0, 1.0)
        encoded = np.rint(norm * 255.0).astype(np.uint8)
        encoded[~combined_land] = 0

        rel_file = f"frames/{year}.png"
        out_path = OUT_DIR / rel_file
        Image.fromarray(encoded, mode="L").save(out_path, format="PNG", optimize=True)
        total_bytes += out_path.stat().st_size

        hotspots = extract_hotspots(grid, count=6, min_sep_deg=17.0)
        keyframes_meta.append(
            {
                "year": year,
                "file": rel_file,
                "worldPopulation": round(world_pop),
                "peakDensity": round(peak_density, 1),
                "p995Density": round(p995, 1),
                "hotspots": hotspots,
            }
        )
        if year in (1492, 1600, 1700, 1800, 1900, 1950, 2000, 2023):
            hs_names = ", ".join(f"{h['name']} ({h['density']:.0f})" for h in hotspots)
            print(f"  {year}: pop={world_pop/1e9:.2f}B peak={peak_density:,.0f}/km² | {hs_names}")

    manifest = {
        "dataset": "HYDE 3.3 Baseline",
        "source": "PBL Netherlands Environmental Assessment Agency & Utrecht University (Klein Goldewijk et al., 2023)",
        "width": 1440,
        "height": 720,
        "minYear": selected_years[0],
        "maxYear": selected_years[-1],
        "maxEncodedDensity": max_encoded,
        "landMaskFile": "land_mask.png",
        "keyframes": keyframes_meta,
    }
    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    total_bytes += manifest_path.stat().st_size

    print(f"\nWrote {len(keyframes_meta)} keyframes + land_mask.png + manifest.json")
    print(f"Total static data bundle size: {total_bytes / (1024 * 1024):.2f} MB")


if __name__ == "__main__":
    main()
