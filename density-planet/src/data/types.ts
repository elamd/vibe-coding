export interface HotspotCallout {
  name: string;
  region: string;
  lat: number;
  lon: number;
  density: number;
}

export interface KeyframeMeta {
  year: number;
  file: string;
  worldPopulation: number;
  peakDensity: number;
  p995Density: number;
  hotspots: HotspotCallout[];
}

export interface DensityManifest {
  dataset: string;
  source: string;
  width: number;
  height: number;
  minYear: number;
  maxYear: number;
  maxEncodedDensity: number;
  landMaskFile: string;
  keyframes: KeyframeMeta[];
}

export interface LoadedDataset {
  manifest: DensityManifest;
  /** Normalized byte grids (length = width * height) for each keyframe, matching manifest.keyframes order */
  frames: Uint8Array[];
  /** Land mask bytes (length = width * height), 0 = ocean, 255 = land */
  landMask: Uint8Array;
}

export type ScaleMode = 'global-log' | 'relative';

export interface OverlayOptions {
  borders: boolean;
  callouts: boolean;
  graticule: boolean;
  autoRotate: boolean;
}

export interface CameraBookmark {
  id: string;
  label: string;
  shortLabel: string;
  lat: number;
  lon: number;
  distance: number;
  eraHint?: string;
}

export interface SurfaceProbeData {
  lat: number;
  lon: number;
  density: number;
  isLand: boolean;
  countryName: string | null;
  nearestCity: {
    name: string;
    country: string;
    distanceKm: number;
  } | null;
  /** Time series of density values across manifest.keyframes */
  history: { year: number; density: number }[];
  pinned: boolean;
}
