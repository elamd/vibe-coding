import { describe, expect, it } from 'vitest';
import {
  decodeLogDensity,
  encodeLogDensity,
  formatDensity,
  formatPopulation,
  getTemporalBracket,
  interpolateGlobalStats,
  sampleEquirectangular,
} from './scale';
import { formatCoords, haversineKm, latLonToVec3, vec3ToLatLon } from './geo';
import { findNearestCity, lookupCountry } from './atlas';
import {
  buildEqualAreaLandCells,
  fillCapLandCellsIntoBuffers,
  selectLodTier,
} from '../globe/blockGrid';
import * as THREE from 'three';
import type { KeyframeMeta } from './types';

describe('geo coordinate conversions', () => {
  it('round-trips cardinal and arbitrary lat/lon coordinates', () => {
    const cases = [
      { lat: 0, lon: 0 },
      { lat: 35.68, lon: 139.69 }, // Tokyo
      { lat: 40.71, lon: -74.01 }, // NYC
      { lat: -33.87, lon: 151.21 }, // Sydney
      { lat: 51.51, lon: -0.13 }, // London
      { lat: -23.55, lon: -46.63 }, // Sao Paulo
    ];
    for (const c of cases) {
      const v = latLonToVec3(c.lat, c.lon, 1.5);
      const back = vec3ToLatLon(v.x, v.y, v.z);
      expect(back.lat).toBeCloseTo(c.lat, 5);
      expect(back.lon).toBeCloseTo(c.lon, 5);
    }
  });

  it('matches Three.js SphereGeometry handedness (East is -Z at prime meridian)', () => {
    const prime = latLonToVec3(0, 0, 1);
    const east90 = latLonToVec3(0, 90, 1);
    const west90 = latLonToVec3(0, -90, 1);
    expect(prime.x).toBeCloseTo(1, 6);
    expect(prime.z).toBeCloseTo(0, 6);
    expect(east90.z).toBeCloseTo(-1, 6);
    expect(west90.z).toBeCloseTo(1, 6);
  });

  it('computes accurate great-circle distance and formatted coordinates', () => {
    // Tokyo to Osaka ~ 400 km
    const d = haversineKm(35.68, 139.69, 34.69, 135.5);
    expect(d).toBeGreaterThan(380);
    expect(d).toBeLessThan(420);
    expect(formatCoords(35.68, 139.69)).toBe('35.68°N  139.69°E');
    expect(formatCoords(-33.87, -74.01)).toBe('33.87°S  74.01°W');
  });
});

describe('density encoding, interpolation, and grid sampling', () => {
  it('round-trips log1p density encoding across 5 orders of magnitude', () => {
    const maxD = 50000;
    for (const val of [0, 1, 15, 250, 4200, 35000]) {
      const enc = encodeLogDensity(val, maxD);
      const dec = decodeLogDensity(enc, maxD);
      expect(dec).toBeCloseTo(val, 4);
    }
  });

  it('brackets temporal keyframes accurately including edges', () => {
    const kfs: KeyframeMeta[] = [
      { year: 1800, file: 'a', worldPopulation: 1e9, peakDensity: 5000, p995Density: 200, hotspots: [] },
      { year: 1900, file: 'b', worldPopulation: 1.6e9, peakDensity: 12000, p995Density: 400, hotspots: [] },
      { year: 2023, file: 'c', worldPopulation: 8e9, peakDensity: 40000, p995Density: 1200, hotspots: [] },
    ];
    expect(getTemporalBracket(kfs, 1750)).toEqual({ indexA: 0, indexB: 0, alpha: 0 });
    expect(getTemporalBracket(kfs, 1850)).toEqual({ indexA: 0, indexB: 1, alpha: 0.5 });
    expect(getTemporalBracket(kfs, 2023)).toEqual({ indexA: 2, indexB: 2, alpha: 0 });

    const mid = interpolateGlobalStats(kfs, 1850, 50000);
    // Geometric mean of 1B and 1.6B ~ 1.265B
    expect(mid.worldPopulation).toBeCloseTo(Math.sqrt(1e9 * 1.6e9), -5);
    expect(mid.relativeNormRef).toBeGreaterThan(0.15);
  });

  it('bilinearly samples equirectangular grids with longitude wrap-around', () => {
    const w = 4;
    const h = 2;
    // Top row (+45°N): [0, 100, 200, 100]
    // Bottom row (-45°S): [0, 0, 0, 0]
    const grid = new Uint8Array([0, 100, 200, 100, 0, 0, 0, 0]);
    // Col 2 center is lon = -180 + (2.5 / 4) * 360 = +45°E, row 0 center is lat = +45°N
    expect(sampleEquirectangular(grid, w, h, 45, 45)).toBeCloseTo(200 / 255, 5);
    expect(sampleEquirectangular(grid, w, h, -45, 45)).toBeCloseTo(0, 5);
  });

  it('formats population and density strings cleanly', () => {
    expect(formatPopulation(8_046_000_000)).toBe('8.05B');
    expect(formatPopulation(989_000_000)).toBe('989M');
    expect(formatDensity(0.01)).toBe('0');
    expect(formatDensity(3.46)).toBe('3.5');
    expect(formatDensity(14250)).toBe('14,250');
  });
});

describe('offline atlas country & city lookup', () => {
  it('identifies major countries and oceans', () => {
    expect(lookupCountry(35.68, 139.69)).toBe('Japan');
    expect(lookupCountry(48.86, 2.35)).toBe('France');
    expect(lookupCountry(28.61, 77.21)).toBe('India');
    // Middle of Pacific Ocean
    expect(lookupCountry(0, -140)).toBeNull();
  });

  it('finds nearest world city within radius', () => {
    const nearTokyo = findNearestCity(35.5, 139.6);
    expect(nearTokyo?.name).toBe('Tokyo');
    expect(nearTokyo?.distanceKm).toBeLessThan(30);
    expect(findNearestCity(0, -140, 500)).toBeNull();
  });
});

describe('equal-area block grid builder', () => {
  it('generates valid land-only block instances with normalized UVs and finite transforms', () => {
    const w = 36;
    const h = 18;
    // Only northern hemisphere land (top half = 255, bottom half = 0)
    const mask = new Uint8Array(w * h);
    mask.fill(255, 0, (w * h) / 2);

    const grid = buildEqualAreaLandCells(mask, w, h, 10, 1.0);
    expect(grid.count).toBeGreaterThan(50);
    expect(grid.cellUvs.length).toBe(grid.count * 2);
    expect(grid.matrices.length).toBe(grid.count * 16);

    for (let i = 0; i < grid.count; i++) {
      const u = grid.cellUvs[i * 2];
      const v = grid.cellUvs[i * 2 + 1];
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThan(0.45); // northern hemisphere
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isFinite(grid.matrices[i * 16 + 12])).toBe(true);
    }
  });

  it('selects LOD tiers with clean hysteresis across zoom distances', () => {
    expect(selectLodTier(3.05, 0)).toBe(0);
    expect(selectLodTier(2.58, 0)).toBe(0); // hysteresis holds 0 until < 2.50
    expect(selectLodTier(2.40, 0)).toBe(1);
    expect(selectLodTier(2.58, 1)).toBe(1); // hysteresis holds 1 until > 2.68
    expect(selectLodTier(1.75, 1)).toBe(2);
    expect(selectLodTier(1.90, 2)).toBe(2); // hysteresis holds 2 until > 1.98
    expect(selectLodTier(2.10, 2)).toBe(1);
    expect(selectLodTier(2.85, 2)).toBe(0);
  });

  it('fills spherical-cap high-res buffers cleanly without exceeding capacity', () => {
    const w = 36;
    const h = 18;
    const mask = new Uint8Array(w * h).fill(255);
    const maxCap = 500;
    const uvs = new Float32Array(maxCap * 2);
    const mats = new Float32Array(maxCap * 16);
    const count = fillCapLandCellsIntoBuffers(
      mask,
      w,
      h,
      5,
      1.0,
      { centerDir: new THREE.Vector3(1, 0, 0), minCosAngle: 0.5 },
      uvs,
      mats,
      maxCap,
    );
    expect(count).toBeGreaterThan(20);
    expect(count).toBeLessThanOrEqual(maxCap);
    // All points in +X cap should have x > 0
    for (let i = 0; i < count; i++) {
      expect(mats[i * 16 + 12]).toBeGreaterThan(0.45);
    }
  });
});
