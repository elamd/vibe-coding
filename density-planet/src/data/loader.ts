import * as THREE from 'three';
import type { DensityManifest, LoadedDataset, SurfaceProbeData } from './types';
import {
  decodeLogDensity,
  getTemporalBracket,
  sampleEquirectangular,
} from './scale';
import { findNearestCity, lookupCountry } from './atlas';

async function loadGrayscaleImageBytes(
  url: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  }
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = document.createElement('canvas');
  canvas.width = expectedWidth;
  canvas.height = expectedHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Unable to acquire 2D canvas context');

  ctx.drawImage(bitmap, 0, 0, expectedWidth, expectedHeight);
  bitmap.close();

  const rgba = ctx.getImageData(0, 0, expectedWidth, expectedHeight).data;
  const bytes = new Uint8Array(expectedWidth * expectedHeight);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = rgba[i * 4];
  }
  return bytes;
}

/**
 * Load the bundled HYDE 3.3 manifest, land mask, and all 31 density keyframe grids.
 */
export async function loadDensityDataset(
  onProgress?: (loaded: number, total: number) => void,
): Promise<LoadedDataset> {
  const baseUrl = `${import.meta.env.BASE_URL}data/`;
  const manifestResp = await fetch(`${baseUrl}manifest.json`);
  if (!manifestResp.ok) {
    throw new Error(`Failed to fetch dataset manifest: ${manifestResp.status}`);
  }
  const manifest = (await manifestResp.json()) as DensityManifest;
  const total = manifest.keyframes.length + 1;
  let completed = 0;
  const bump = () => {
    completed += 1;
    onProgress?.(completed, total);
  };

  const landMaskPromise = loadGrayscaleImageBytes(
    `${baseUrl}${manifest.landMaskFile}`,
    manifest.width,
    manifest.height,
  ).then((bytes) => {
    bump();
    return bytes;
  });

  // Load keyframes in parallel batches of 6 for snappy progressive progress
  const frames: Uint8Array[] = new Array(manifest.keyframes.length);
  const concurrency = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < manifest.keyframes.length) {
      const idx = cursor++;
      const kf = manifest.keyframes[idx];
      frames[idx] = await loadGrayscaleImageBytes(
        `${baseUrl}${kf.file}`,
        manifest.width,
        manifest.height,
      );
      bump();
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  const [landMask] = await Promise.all([landMaskPromise, ...workers]);

  return { manifest, frames, landMask };
}

/**
 * Build a Three.js single-channel DataTexture (RedFormat, LinearFilter) from a top-down equirectangular Uint8Array.
 * Note: Three.js DataTexture defaults to flipY = false (row 0 at bottom), whereas PNG row 0 is North Pole (top),
 * so we set flipY = true to match SphereGeometry UVs (v=1 at North Pole).
 */
export function createEquirectangularTexture(
  bytes: Uint8Array,
  width: number,
  height: number,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(bytes, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.flipY = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Probe exact surface telemetry (density, land/ocean, country, nearest city, 1800–2023 history sparkline)
 * at any (lat, lon) and fractional year.
 */
export function probeSurface(
  dataset: LoadedDataset,
  lat: number,
  lon: number,
  year: number,
  pinned: boolean,
): SurfaceProbeData {
  const { manifest, frames, landMask } = dataset;
  const { width, height, maxEncodedDensity, keyframes } = manifest;

  const landSample = sampleEquirectangular(landMask, width, height, lat, lon);
  const isLand = landSample >= 0.35;

  const { indexA, indexB, alpha } = getTemporalBracket(keyframes, year);
  const normA = sampleEquirectangular(frames[indexA], width, height, lat, lon);
  const normB = sampleEquirectangular(frames[indexB], width, height, lat, lon);
  const blendedNorm = normA * (1 - alpha) + normB * alpha;
  const density = isLand ? decodeLogDensity(blendedNorm, maxEncodedDensity) : 0;

  const countryName = lookupCountry(lat, lon);
  const nearestCity = isLand || countryName ? findNearestCity(lat, lon, 750) : null;

  const history = keyframes.map((kf, i) => {
    const norm = sampleEquirectangular(frames[i], width, height, lat, lon);
    return {
      year: kf.year,
      density: isLand ? decodeLogDensity(norm, maxEncodedDensity) : 0,
    };
  });

  return {
    lat,
    lon,
    density,
    isLand: isLand || countryName !== null,
    countryName,
    nearestCity,
    history,
    pinned,
  };
}
