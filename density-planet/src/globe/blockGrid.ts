import * as THREE from 'three';
import { latLonToVec3 } from '../data/geo';
import { sampleEquirectangular } from '../data/scale';

export type LodTierId = 0 | 1 | 2;

export interface LodTierConfig {
  id: LodTierId;
  label: string;
  stepDeg: number;
  /** Footprint averaging radius in HYDE texture texels (0 = exact native 0.25° sample) */
  sampleRadiusTexels: number;
  /** Scales tower height relative to smaller block footprint so zoomed-in blocks stay well-proportioned */
  heightScale: number;
  /** Width fraction of each cell pitch (leaves crisp architectural gaps between blocks) */
  footprintRatio: number;
}

export const LOD_TIERS: readonly [LodTierConfig, LodTierConfig, LodTierConfig] = [
  {
    id: 0,
    label: '1.05° MACRO',
    stepDeg: 1.05,
    sampleRadiusTexels: 2.0,
    heightScale: 1.08,
    footprintRatio: 0.78,
  },
  {
    id: 1,
    label: '0.58° REGIONAL',
    stepDeg: 0.58,
    sampleRadiusTexels: 1.0,
    heightScale: 0.88,
    footprintRatio: 0.80,
  },
  {
    id: 2,
    label: '0.26° METRO',
    stepDeg: 0.26,
    sampleRadiusTexels: 0.0,
    heightScale: 0.66,
    footprintRatio: 0.82,
  },
] as const;

/**
 * Hysteresis LOD selector driven by camera-to-globe distance so zooming back and forth
 * across thresholds never flickers.
 */
export function selectLodTier(distance: number, current: LodTierId): LodTierId {
  if (current === 0) {
    if (distance < 1.82) return 2;
    if (distance < 2.50) return 1;
    return 0;
  }
  if (current === 1) {
    if (distance < 1.82) return 2;
    if (distance > 2.68) return 0;
    return 1;
  }
  // current === 2
  if (distance > 2.68) return 0;
  if (distance > 1.98) return 1;
  return 2;
}

export interface LandBlockGrid {
  count: number;
  /** Per-instance equirectangular UV coordinates (length = count * 2) */
  cellUvs: Float32Array;
  /** Per-instance 4x4 placement matrices orienting unit box (+Z outward, base at z=0) onto sphere */
  matrices: Float32Array;
  /** Angular footprint width in world units */
  cellFootprint: number;
}

export interface SphericalCapFilter {
  /** Normalized direction from globe center toward camera */
  centerDir: THREE.Vector3;
  /** Minimum dot(cellDir, centerDir) to include (e.g. cos(66°) ≈ 0.407 covers full visible hemisphere) */
  minCosAngle: number;
}

/**
 * Generate an equal-area latitude/longitude block grid over land cells on a unit sphere.
 * Each latitude band scales its longitude step by 1 / cos(lat) so blocks stay uniformly square
 * from the equator to high latitudes with zero polar bunching.
 */
export function buildEqualAreaLandCells(
  landMask: Uint8Array,
  width: number,
  height: number,
  stepDeg = 0.72,
  globeRadius = 1.0,
  footprintRatio = 0.78,
  capFilter?: SphericalCapFilter,
): LandBlockGrid {
  const stepRad = (stepDeg * Math.PI) / 180;
  const cellFootprint = stepRad * globeRadius * footprintRatio;

  const coords: { lat: number; lon: number; u: number; v: number }[] = [];
  const tmpDir = new THREE.Vector3();

  for (let lat = -60; lat <= 78; lat += stepDeg) {
    const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const nCols = Math.max(8, Math.round((360 * cosLat) / stepDeg));
    const dLon = 360 / nCols;

    for (let c = 0; c < nCols; c++) {
      const lon = -180 + (c + 0.5) * dLon;

      if (capFilter) {
        tmpDir.copy(latLonToVec3(lat, lon, 1.0));
        if (tmpDir.dot(capFilter.centerDir) < capFilter.minCosAngle) continue;
      }

      const land = sampleEquirectangular(landMask, width, height, lat, lon);
      if (land < 0.35) continue;

      const u = (lon + 180) / 360;
      const v = (lat + 90) / 180;
      coords.push({ lat, lon, u, v });
    }
  }

  const count = coords.length;
  const cellUvs = new Float32Array(count * 2);
  const matrices = new Float32Array(count * 16);

  writeBlockTransforms(coords, globeRadius, cellUvs, matrices);

  return { count, cellUvs, matrices, cellFootprint };
}

/**
 * Fill preallocated UV + matrix Float32Arrays in-place for a high-resolution spherical cap
 * (zero heap reallocation when orbiting in Tier 2 Metro mode).
 */
export function fillCapLandCellsIntoBuffers(
  landMask: Uint8Array,
  width: number,
  height: number,
  stepDeg: number,
  globeRadius: number,
  capFilter: SphericalCapFilter,
  outCellUvs: Float32Array,
  outMatrices: Float32Array,
  maxInstances: number,
): number {
  const pos = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const basis = new THREE.Matrix4();

  const cx = capFilter.centerDir.x;
  const cy = capFilter.centerDir.y;
  const cz = capFilter.centerDir.z;
  const minCos = capFilter.minCosAngle;

  let written = 0;

  for (let lat = -60; lat <= 78 && written < maxInstances; lat += stepDeg) {
    const latRad = (lat * Math.PI) / 180;
    const sinLat = Math.sin(latRad);
    const cosLatRaw = Math.cos(latRad);
    const cosLat = Math.max(0.15, cosLatRaw);
    const nCols = Math.max(8, Math.round((360 * cosLat) / stepDeg));
    const dLon = 360 / nCols;

    // Fast latitude-band reject: max possible dot product on this parallel is cosLat*sqrt(cx^2+cz^2) + sinLat*cy
    const horizLen = Math.hypot(cx, cz);
    if (cosLatRaw * horizLen + sinLat * cy < minCos) continue;

    const v = (lat + 90) / 180;

    for (let c = 0; c < nCols && written < maxInstances; c++) {
      const lon = -180 + (c + 0.5) * dLon;
      const lonRad = (lon * Math.PI) / 180;
      const nx = cosLatRaw * Math.cos(lonRad);
      const ny = sinLat;
      const nz = -cosLatRaw * Math.sin(lonRad);

      if (nx * cx + ny * cy + nz * cz < minCos) continue;

      const land = sampleEquirectangular(landMask, width, height, lat, lon);
      if (land < 0.35) continue;

      outCellUvs[written * 2] = (lon + 180) / 360;
      outCellUvs[written * 2 + 1] = v;

      normal.set(nx, ny, nz);
      pos.set(nx * globeRadius, ny * globeRadius, nz * globeRadius);

      east.crossVectors(worldUp, normal);
      if (east.lengthSq() < 1e-6) {
        east.set(1, 0, 0);
      } else {
        east.normalize();
      }
      north.crossVectors(normal, east).normalize();

      basis.makeBasis(east, north, normal);
      basis.setPosition(pos);
      basis.toArray(outMatrices, written * 16);
      written += 1;
    }
  }

  return written;
}

function writeBlockTransforms(
  coords: readonly { lat: number; lon: number; u: number; v: number }[],
  globeRadius: number,
  cellUvs: Float32Array,
  matrices: Float32Array,
): void {
  const pos = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const basis = new THREE.Matrix4();

  for (let i = 0; i < coords.length; i++) {
    const { lat, lon, u, v } = coords[i];
    cellUvs[i * 2] = u;
    cellUvs[i * 2 + 1] = v;

    pos.copy(latLonToVec3(lat, lon, globeRadius));
    normal.copy(pos).normalize();

    east.crossVectors(worldUp, normal);
    if (east.lengthSq() < 1e-6) {
      east.set(1, 0, 0);
    } else {
      east.normalize();
    }
    north.crossVectors(normal, east).normalize();

    basis.makeBasis(east, north, normal);
    basis.setPosition(pos);
    basis.toArray(matrices, i * 16);
  }
}
