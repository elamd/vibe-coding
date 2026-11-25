import type { KeyframeMeta } from './types';

export interface TemporalBracket {
  indexA: number;
  indexB: number;
  alpha: number;
}

/**
 * Find the two adjacent keyframes bracketing `year` and linear blend alpha in [0, 1].
 */
export function getTemporalBracket(keyframes: readonly KeyframeMeta[], year: number): TemporalBracket {
  if (keyframes.length === 0) {
    throw new Error('Keyframes array must not be empty');
  }
  if (keyframes.length === 1 || year <= keyframes[0].year) {
    return { indexA: 0, indexB: 0, alpha: 0 };
  }
  const last = keyframes.length - 1;
  if (year >= keyframes[last].year) {
    return { indexA: last, indexB: last, alpha: 0 };
  }

  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].year <= year) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const yA = keyframes[lo].year;
  const yB = keyframes[hi].year;
  const span = yB - yA;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (year - yA) / span)) : 0;
  return { indexA: lo, indexB: hi, alpha };
}

/**
 * Encode raw population density (people / km²) to normalized log1p value in [0, 1].
 */
export function encodeLogDensity(density: number, maxEncodedDensity: number): number {
  if (density <= 0 || maxEncodedDensity <= 0) return 0;
  const norm = Math.log1p(density) / Math.log1p(maxEncodedDensity);
  return Math.max(0, Math.min(1, norm));
}

/**
 * Decode normalized log1p byte value [0..1] back to people / km².
 */
export function decodeLogDensity(norm01: number, maxEncodedDensity: number): number {
  if (norm01 <= 0 || maxEncodedDensity <= 0) return 0;
  const clamped = Math.max(0, Math.min(1, norm01));
  return Math.expm1(clamped * Math.log1p(maxEncodedDensity));
}

/**
 * Compute interpolated global telemetry metrics at an arbitrary fractional year.
 */
export function interpolateGlobalStats(
  keyframes: readonly KeyframeMeta[],
  year: number,
  maxEncodedDensity: number,
): {
  worldPopulation: number;
  peakDensity: number;
  relativeNormRef: number;
  bracket: TemporalBracket;
} {
  const bracket = getTemporalBracket(keyframes, year);
  const a = keyframes[bracket.indexA];
  const b = keyframes[bracket.indexB];
  const t = bracket.alpha;

  // Exponential interpolation for population totals, linear in log-space for density peaks
  const worldPopulation =
    a.worldPopulation > 0 && b.worldPopulation > 0
      ? Math.exp(Math.log(a.worldPopulation) * (1 - t) + Math.log(b.worldPopulation) * t)
      : a.worldPopulation * (1 - t) + b.worldPopulation * t;

  const peakNormA = encodeLogDensity(a.peakDensity, maxEncodedDensity);
  const peakNormB = encodeLogDensity(b.peakDensity, maxEncodedDensity);
  const peakDensity = decodeLogDensity(peakNormA * (1 - t) + peakNormB * t, maxEncodedDensity);

  const refA = Math.max(0.15, encodeLogDensity(a.p995Density, maxEncodedDensity));
  const refB = Math.max(0.15, encodeLogDensity(b.p995Density, maxEncodedDensity));
  const relativeNormRef = refA * (1 - t) + refB * t;

  return { worldPopulation, peakDensity, relativeNormRef, bracket };
}

/**
 * Bilinearly sample a 0..255 equirectangular grid at (lat, lon) returning normalized [0, 1].
 * Row 0 = +90°N, row H-1 = -90°S; Col 0 = -180°W, col W-1 = +180°E.
 */
export function sampleEquirectangular(
  grid: Uint8Array,
  width: number,
  height: number,
  latDeg: number,
  lonDeg: number,
): number {
  const wrappedLon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  const clampedLat = Math.max(-90, Math.min(90, latDeg));

  const fx = ((wrappedLon + 180) / 360) * width - 0.5;
  const fy = ((90 - clampedLat) / 180) * height - 0.5;

  const x0 = ((Math.floor(fx) % width) + width) % width;
  const x1 = (x0 + 1) % width;
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)));
  const y1 = Math.max(0, Math.min(height - 1, y0 + 1));

  const tx = fx - Math.floor(fx);
  const ty = Math.max(0, Math.min(1, fy - y0));

  const v00 = grid[y0 * width + x0] / 255;
  const v10 = grid[y0 * width + x1] / 255;
  const v01 = grid[y1 * width + x0] / 255;
  const v11 = grid[y1 * width + x1] / 255;

  const top = v00 * (1 - tx) + v10 * tx;
  const bot = v01 * (1 - tx) + v11 * tx;
  return top * (1 - ty) + bot * ty;
}

/**
 * Format large population count (e.g. 8,045,000,000 -> "8.05B", 989,000,000 -> "989M").
 */
export function formatPopulation(pop: number): string {
  if (pop >= 1e9) return `${(pop / 1e9).toFixed(2)}B`;
  if (pop >= 1e6) return `${(pop / 1e6).toFixed(0)}M`;
  if (pop >= 1e3) return `${(pop / 1e3).toFixed(1)}K`;
  return Math.round(pop).toString();
}

/**
 * Format density value in people / km².
 */
export function formatDensity(density: number): string {
  if (density < 0.05) return '0';
  if (density < 10) return density.toFixed(1);
  if (density < 1000) return Math.round(density).toLocaleString('en-US');
  return Math.round(density).toLocaleString('en-US');
}

/**
 * Describe historical era label for HUD telemetry badge.
 */
export function getEraLabel(year: number): string {
  if (year < 1550) return 'AGE OF EXPLORATION';
  if (year < 1650) return 'COLUMBIAN EXCHANGE';
  if (year < 1760) return 'EARLY MODERN ERA';
  if (year < 1840) return 'EARLY INDUSTRIAL';
  if (year < 1880) return 'STEAM & RAIL EXPANSION';
  if (year < 1920) return 'SECOND INDUSTRIAL AGE';
  if (year < 1950) return 'MID-CENTURY TRANSITION';
  if (year < 1980) return 'POST-WAR DEMOGRAPHIC SURGE';
  if (year < 2005) return 'GLOBAL URBANIZATION';
  return 'MEGACITY EPOCH';
}
