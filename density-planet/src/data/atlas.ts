import * as THREE from 'three';
import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import countriesAtlas from 'world-atlas/countries-110m.json';
import { latLonToVec3, haversineKm } from './geo';
import { WORLD_CITIES } from './cities';

type CountryProps = { name?: string };
type Ring = [number, number][];

interface CountryPolygonIndex {
  name: string;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  polygons: Ring[][];
}

const topology = countriesAtlas as unknown as Topology<{
  countries: GeometryCollection<CountryProps>;
  land: GeometryCollection;
}>;

let cachedCountryIndex: CountryPolygonIndex[] | null = null;

function buildCountryIndex(): CountryPolygonIndex[] {
  if (cachedCountryIndex) return cachedCountryIndex;
  const fc = feature(topology, topology.objects.countries);
  const items: CountryPolygonIndex[] = [];

  for (const feat of fc.features) {
    const name = feat.properties?.name;
    if (!name || !feat.geometry) continue;

    const polygons: Ring[][] = [];
    if (feat.geometry.type === 'Polygon') {
      polygons.push(feat.geometry.coordinates as Ring[]);
    } else if (feat.geometry.type === 'MultiPolygon') {
      for (const poly of feat.geometry.coordinates) {
        polygons.push(poly as Ring[]);
      }
    }

    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const poly of polygons) {
      const outer = poly[0];
      if (!outer) continue;
      for (const [lon, lat] of outer) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }

    items.push({ name, minLon, maxLon, minLat, maxLat, polygons });
  }

  cachedCountryIndex = items;
  return items;
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    // Skip antimeridian wrap artifacts (>180 deg jump)
    if (Math.abs(xi - xj) > 180) continue;

    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon: number, lat: number, polygon: Ring[]): boolean {
  if (polygon.length === 0 || !pointInRing(lon, lat, polygon[0])) return false;
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(lon, lat, polygon[h])) return false;
  }
  return true;
}

/**
 * Offline point-in-polygon lookup returning the Natural Earth country name at (lat, lon).
 */
export function lookupCountry(lat: number, lon: number): string | null {
  const index = buildCountryIndex();
  for (const item of index) {
    if (lat < item.minLat || lat > item.maxLat) continue;
    // Handle antimeridian-crossing countries (e.g. Fiji, Russia)
    const crossesDateLine = item.maxLon - item.minLon > 180;
    if (!crossesDateLine && (lon < item.minLon || lon > item.maxLon)) continue;

    for (const poly of item.polygons) {
      if (pointInPolygon(lon, lat, poly)) {
        return item.name;
      }
    }
  }
  return null;
}

/**
 * Find the nearest city in the offline gazetteer within `maxDistanceKm`.
 */
export function findNearestCity(
  lat: number,
  lon: number,
  maxDistanceKm = 750,
): { name: string; country: string; distanceKm: number } | null {
  let best: { name: string; country: string; distanceKm: number } | null = null;
  for (const city of WORLD_CITIES) {
    const dist = haversineKm(lat, lon, city.lat, city.lon);
    if (dist <= maxDistanceKm && (!best || dist < best.distanceKm)) {
      best = { name: city.name, country: city.country, distanceKm: dist };
    }
  }
  return best;
}

/**
 * Convert GeoJSON MultiLineString coordinate arcs into a flat Float32Array of paired 3D line segments
 * suitable for THREE.LineSegments on a sphere of given radius.
 */
function multiLineToSegmentPositions(lines: [number, number][][], radius: number): Float32Array {
  let segmentCount = 0;
  for (const line of lines) {
    if (line.length > 1) segmentCount += line.length - 1;
  }

  const positions = new Float32Array(segmentCount * 6);
  let offset = 0;

  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [lonA, latA] = line[i];
      const [lonB, latB] = line[i + 1];
      // Skip antimeridian seams
      if (Math.abs(lonA - lonB) > 180) continue;

      const a = latLonToVec3(latA, lonA, radius);
      const b = latLonToVec3(latB, lonB, radius);

      positions[offset++] = a.x;
      positions[offset++] = a.y;
      positions[offset++] = a.z;
      positions[offset++] = b.x;
      positions[offset++] = b.y;
      positions[offset++] = b.z;
    }
  }

  return positions.subarray(0, offset);
}

/**
 * Build Three.js BufferGeometries for coastlines and internal country borders.
 */
export function buildVectorGlobeGeometries(radius = 1.003): {
  coastlines: THREE.BufferGeometry;
  borders: THREE.BufferGeometry;
} {
  const coastMesh = mesh(topology, topology.objects.land);
  const borderMesh = mesh(topology, topology.objects.countries, (a, b) => a !== b);

  const coastPos = multiLineToSegmentPositions(
    coastMesh.coordinates as [number, number][][],
    radius,
  );
  const borderPos = multiLineToSegmentPositions(
    borderMesh.coordinates as [number, number][][],
    radius + 0.0005,
  );

  const coastlines = new THREE.BufferGeometry();
  coastlines.setAttribute('position', new THREE.BufferAttribute(coastPos, 3));

  const borders = new THREE.BufferGeometry();
  borders.setAttribute('position', new THREE.BufferAttribute(borderPos, 3));

  return { coastlines, borders };
}

/**
 * Build a subtle lat/lon orbital graticule BufferGeometry (every 30° lat, 30° lon).
 */
export function buildGraticuleGeometry(radius = 1.0015): THREE.BufferGeometry {
  const pts: number[] = [];
  const step = 3;

  // Parallels (latitude lines)
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += step) {
      const a = latLonToVec3(lat, lon, radius);
      const b = latLonToVec3(lat, lon + step, radius);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }

  // Meridians (longitude lines)
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -84; lat < 84; lat += step) {
      const a = latLonToVec3(lat, lon, radius);
      const b = latLonToVec3(lat + step, lon, radius);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geom;
}
