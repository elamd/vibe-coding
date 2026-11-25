import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type {
  HotspotCallout,
  LoadedDataset,
  OverlayOptions,
  ScaleMode,
} from '../data/types';
import { createEquirectangularTexture } from '../data/loader';
import { buildGraticuleGeometry, buildVectorGlobeGeometries } from '../data/atlas';
import {
  encodeLogDensity,
  interpolateGlobalStats,
  sampleEquirectangular,
} from '../data/scale';
import { latLonToVec3, vec3ToLatLon } from '../data/geo';
import {
  LOD_TIERS,
  buildEqualAreaLandCells,
  fillCapLandCellsIntoBuffers,
  selectLodTier,
  type LodTierId,
} from './blockGrid';
import {
  ATMOSPHERE_FRAGMENT_SHADER,
  ATMOSPHERE_VERTEX_SHADER,
  BASE_GLOBE_FRAGMENT_SHADER,
  BASE_GLOBE_VERTEX_SHADER,
  BLOCK_FRAGMENT_SHADER,
  BLOCK_VERTEX_SHADER,
} from './shaders';

interface DensityGlobeProps {
  dataset: LoadedDataset;
  yearRef: React.MutableRefObject<number>;
  displayYear: number;
  scaleMode: ScaleMode;
  elevation: number;
  overlays: OverlayOptions;
  pinnedCoords: { lat: number; lon: number } | null;
  activeHotspots: HotspotCallout[];
  hotspotSlotRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  lodTier: LodTierId;
  onLodTierChange: (tier: LodTierId) => void;
  onHoverCoords: (coords: { lat: number; lon: number } | null) => void;
  onClickCoords: (coords: { lat: number; lon: number }) => void;
}

const GLOBE_RADIUS = 1.0;
const MAX_METRO_INSTANCES = 65000;
const METRO_CAP_MIN_COS = Math.cos((68 * Math.PI) / 180); // 68° cap covers full visible hemisphere at zoom-in
const METRO_REBUILD_ANGLE_RAD = (11 * Math.PI) / 180;

function computeBlockTopRadius(
  dataset: LoadedDataset,
  lat: number,
  lon: number,
  year: number,
  scaleMode: ScaleMode,
  elevation: number,
  lodTier: LodTierId,
): number {
  const { manifest, frames } = dataset;
  const { bracket, relativeNormRef } = interpolateGlobalStats(
    manifest.keyframes,
    year,
    manifest.maxEncodedDensity,
  );
  const a = sampleEquirectangular(frames[bracket.indexA], manifest.width, manifest.height, lat, lon);
  const b = sampleEquirectangular(frames[bracket.indexB], manifest.width, manifest.height, lat, lon);
  let d = a * (1 - bracket.alpha) + b * bracket.alpha;
  if (scaleMode === 'relative') {
    d = Math.min(1, d / Math.max(relativeNormRef, 0.15));
  }
  const activeMask = THREE.MathUtils.smoothstep(d, 0.05, 0.12);
  const heightScale = LOD_TIERS[lodTier].heightScale;
  return GLOBE_RADIUS + (0.0035 + Math.pow(d, 1.75) * 0.22 * elevation * heightScale) * activeMask;
}

interface HotspotPinProps {
  slotIdx: number;
  hotspot: HotspotCallout | null;
  visible: boolean;
  peakRadius: number;
  hotspotSlotRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
}

function HotspotPin({
  slotIdx,
  hotspot,
  visible,
  peakRadius,
  hotspotSlotRefs,
}: HotspotPinProps) {
  const { camera, size } = useThree();
  const groupRef = useRef<THREE.Group>(null);

  const lat = hotspot?.lat ?? 0;
  const lon = hotspot?.lon ?? 0;

  const { basePos, tipPos, lineGeom, normalDir } = useMemo(() => {
    const dir = latLonToVec3(lat, lon, 1.0).normalize();
    const base = dir.clone().multiplyScalar(peakRadius + 0.004);
    const tip = dir.clone().multiplyScalar(peakRadius + 0.052);
    const geom = new THREE.BufferGeometry().setFromPoints([base, tip]);
    return { basePos: base, tipPos: tip, lineGeom: geom, normalDir: dir };
  }, [lat, lon, peakRadius]);

  useEffect(() => {
    return () => lineGeom.dispose();
  }, [lineGeom]);

  const tmpCam = useMemo(() => new THREE.Vector3(), []);
  const tmpProj = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const el = hotspotSlotRefs.current[slotIdx];
    const active = visible && hotspot !== null;

    if (!active) {
      if (groupRef.current) groupRef.current.visible = false;
      if (el) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
      }
      return;
    }

    tmpCam.copy(camera.position).normalize();
    const facing = normalDir.dot(tmpCam);
    const pinVisible = facing > 0.16;
    if (groupRef.current) groupRef.current.visible = pinVisible;

    if (!el) return;
    tmpProj.copy(tipPos).project(camera);
    const inFront = tmpProj.z >= -1 && tmpProj.z <= 1;
    const opacity = inFront ? THREE.MathUtils.smoothstep(facing, 0.22, 0.42) : 0;

    if (opacity > 0.01) {
      const x = (tmpProj.x * 0.5 + 0.5) * size.width;
      const y = (-tmpProj.y * 0.5 + 0.5) * size.height;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.opacity = opacity.toFixed(3);
      el.style.pointerEvents = opacity > 0.45 ? 'auto' : 'none';
    } else {
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      <lineSegments geometry={lineGeom}>
        <lineBasicMaterial color="#fde68a" transparent opacity={0.78} depthWrite={false} />
      </lineSegments>
      <mesh position={basePos}>
        <sphereGeometry args={[0.0055, 10, 10]} />
        <meshBasicMaterial color="#fef08a" toneMapped={false} />
      </mesh>
    </group>
  );
}

interface PinnedReticleProps {
  lat: number;
  lon: number;
  peakRadius: number;
}

function PinnedReticle({ lat, lon, peakRadius }: PinnedReticleProps) {
  const ringRef = useRef<THREE.Mesh>(null);

  const { pos, quat, lineGeom } = useMemo(() => {
    const dir = latLonToVec3(lat, lon, 1.0).normalize();
    const surface = dir.clone().multiplyScalar(peakRadius + 0.005);
    const beaconTop = dir.clone().multiplyScalar(peakRadius + 0.08);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const geom = new THREE.BufferGeometry().setFromPoints([surface, beaconTop]);
    return { pos: surface, quat: q, lineGeom: geom };
  }, [lat, lon, peakRadius]);

  useEffect(() => {
    return () => lineGeom.dispose();
  }, [lineGeom]);

  useFrame(({ clock }) => {
    if (!ringRef.current) return;
    const pulse = 1.0 + Math.sin(clock.elapsedTime * 3.8) * 0.16;
    ringRef.current.scale.setScalar(pulse);
  });

  return (
    <group>
      <mesh ref={ringRef} position={pos} quaternion={quat}>
        <ringGeometry args={[0.014, 0.019, 32]} />
        <meshBasicMaterial
          color="#fbbf24"
          side={THREE.DoubleSide}
          transparent
          opacity={0.95}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      <mesh position={pos} quaternion={quat}>
        <ringGeometry args={[0.026, 0.029, 32]} />
        <meshBasicMaterial
          color="#38bdf8"
          side={THREE.DoubleSide}
          transparent
          opacity={0.6}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={lineGeom}>
        <lineBasicMaterial color="#fbbf24" transparent opacity={0.9} depthWrite={false} />
      </lineSegments>
    </group>
  );
}

export function DensityGlobe({
  dataset,
  yearRef,
  displayYear,
  scaleMode,
  elevation,
  overlays,
  pinnedCoords,
  activeHotspots,
  hotspotSlotRefs,
  lodTier,
  onLodTierChange,
  onHoverCoords,
  onClickCoords,
}: DensityGlobeProps) {
  const { camera } = useThree();
  const baseMatRef = useRef<THREE.ShaderMaterial>(null);

  const macroMeshRef = useRef<THREE.InstancedMesh>(null);
  const regionalMeshRef = useRef<THREE.InstancedMesh>(null);
  const metroMeshRef = useRef<THREE.InstancedMesh>(null);

  const macroMatRef = useRef<THREE.ShaderMaterial>(null);
  const regionalMatRef = useRef<THREE.ShaderMaterial>(null);
  const metroMatRef = useRef<THREE.ShaderMaterial>(null);

  const activeTierRef = useRef<LodTierId>(lodTier);
  const lodTransitionRef = useRef<number>(1.0);
  const lastMetroCenterRef = useRef<THREE.Vector3 | null>(null);
  const tmpCamDir = useMemo(() => new THREE.Vector3(), []);

  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverTsRef = useRef(0);

  // Build GPU DataTextures once per loaded dataset
  const { frameTextures, landTexture } = useMemo(() => {
    const { width, height } = dataset.manifest;
    const fTex = dataset.frames.map((bytes) => createEquirectangularTexture(bytes, width, height));
    const lTex = createEquirectangularTexture(dataset.landMask, width, height);
    return { frameTextures: fTex, landTexture: lTex };
  }, [dataset]);

  useEffect(() => {
    return () => {
      for (const t of frameTextures) t.dispose();
      landTexture.dispose();
    };
  }, [frameTextures, landTexture]);

  // Prebuild Tier 0 (1.05° Macro) & Tier 1 (0.58° Regional) global land block grids
  // plus preallocated Tier 2 (0.26° Metro) dynamic cap buffers
  const { macroGrid, macroGeom, regionalGrid, regionalGeom, metroGeom, metroUvAttr } = useMemo(() => {
    const { width, height } = dataset.manifest;

    const t0 = LOD_TIERS[0];
    const g0 = buildEqualAreaLandCells(
      dataset.landMask,
      width,
      height,
      t0.stepDeg,
      GLOBE_RADIUS,
      t0.footprintRatio,
    );
    const geom0 = new THREE.BoxGeometry(g0.cellFootprint, g0.cellFootprint, 1.0);
    geom0.translate(0, 0, 0.5);
    geom0.setAttribute('aCellUv', new THREE.InstancedBufferAttribute(g0.cellUvs, 2));

    const t1 = LOD_TIERS[1];
    const g1 = buildEqualAreaLandCells(
      dataset.landMask,
      width,
      height,
      t1.stepDeg,
      GLOBE_RADIUS,
      t1.footprintRatio,
    );
    const geom1 = new THREE.BoxGeometry(g1.cellFootprint, g1.cellFootprint, 1.0);
    geom1.translate(0, 0, 0.5);
    geom1.setAttribute('aCellUv', new THREE.InstancedBufferAttribute(g1.cellUvs, 2));

    const t2 = LOD_TIERS[2];
    const footprint2 = ((t2.stepDeg * Math.PI) / 180) * GLOBE_RADIUS * t2.footprintRatio;
    const geom2 = new THREE.BoxGeometry(footprint2, footprint2, 1.0);
    geom2.translate(0, 0, 0.5);
    const uvAttr2 = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_METRO_INSTANCES * 2),
      2,
    );
    uvAttr2.setUsage(THREE.DynamicDrawUsage);
    geom2.setAttribute('aCellUv', uvAttr2);

    return {
      macroGrid: g0,
      macroGeom: geom0,
      regionalGrid: g1,
      regionalGeom: geom1,
      metroGeom: geom2,
      metroUvAttr: uvAttr2,
    };
  }, [dataset.landMask, dataset.manifest]);

  useEffect(() => {
    return () => {
      macroGeom.dispose();
      regionalGeom.dispose();
      metroGeom.dispose();
    };
  }, [macroGeom, regionalGeom, metroGeom]);

  // Upload static matrices for Tier 0 & Tier 1 and configure Tier 2 mesh
  useEffect(() => {
    if (macroMeshRef.current) {
      macroMeshRef.current.instanceMatrix.array.set(macroGrid.matrices);
      macroMeshRef.current.instanceMatrix.needsUpdate = true;
      macroMeshRef.current.frustumCulled = false;
    }
    if (regionalMeshRef.current) {
      regionalMeshRef.current.instanceMatrix.array.set(regionalGrid.matrices);
      regionalMeshRef.current.instanceMatrix.needsUpdate = true;
      regionalMeshRef.current.frustumCulled = false;
    }
    if (metroMeshRef.current) {
      metroMeshRef.current.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      metroMeshRef.current.count = 0;
      metroMeshRef.current.frustumCulled = false;
      lastMetroCenterRef.current = null;
    }
  }, [macroGrid, regionalGrid]);

  // Build vector coastlines, borders, and orbital graticule flush on the smooth base sphere
  const { coastlines, borders, graticule } = useMemo(() => {
    const vec = buildVectorGlobeGeometries(GLOBE_RADIUS + 0.0025);
    const grat = buildGraticuleGeometry(GLOBE_RADIUS + 0.0012);
    return { coastlines: vec.coastlines, borders: vec.borders, graticule: grat };
  }, []);

  useEffect(() => {
    return () => {
      coastlines.dispose();
      borders.dispose();
      graticule.dispose();
    };
  }, [coastlines, borders, graticule]);

  const initialNormRef = encodeLogDensity(
    dataset.manifest.keyframes[dataset.manifest.keyframes.length - 1].p995Density,
    dataset.manifest.maxEncodedDensity,
  );
  const texelSize = useMemo(
    () => new THREE.Vector2(1 / dataset.manifest.width, 1 / dataset.manifest.height),
    [dataset.manifest.width, dataset.manifest.height],
  );

  const baseUniforms = useMemo(
    () => ({
      uTexA: { value: frameTextures[frameTextures.length - 1] },
      uTexB: { value: frameTextures[frameTextures.length - 1] },
      uLandMask: { value: landTexture },
      uAlpha: { value: 0 },
      uRelativeMode: { value: scaleMode === 'relative' ? 1.0 : 0.0 },
      uRelativeNormRef: { value: initialNormRef },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameTextures, landTexture],
  );

  const makeBlockUniforms = (tierIdx: LodTierId) => ({
    uTexA: { value: frameTextures[frameTextures.length - 1] },
    uTexB: { value: frameTextures[frameTextures.length - 1] },
    uAlpha: { value: 0 },
    uElevation: { value: elevation },
    uRelativeMode: { value: scaleMode === 'relative' ? 1.0 : 0.0 },
    uRelativeNormRef: { value: initialNormRef },
    uTexelSize: { value: texelSize },
    uSampleRadius: { value: LOD_TIERS[tierIdx].sampleRadiusTexels },
    uLodHeightScale: { value: LOD_TIERS[tierIdx].heightScale },
    uLodTransition: { value: 1.0 },
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const macroUniforms = useMemo(() => makeBlockUniforms(0), [frameTextures, texelSize]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const regionalUniforms = useMemo(() => makeBlockUniforms(1), [frameTextures, texelSize]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const metroUniforms = useMemo(() => makeBlockUniforms(2), [frameTextures, texelSize]);

  // Update dynamic LOD selection, metro cap population, and GPU shader uniforms every frame
  useFrame((_, delta) => {
    const camDist = camera.position.length();
    const nextTier = selectLodTier(camDist, activeTierRef.current);

    if (nextTier !== activeTierRef.current) {
      activeTierRef.current = nextTier;
      lodTransitionRef.current = 0.62;
      onLodTierChange(nextTier);
    }

    // Smooth pop-in scale when transitioning between LOD tiers
    if (lodTransitionRef.current < 1.0) {
      lodTransitionRef.current = Math.min(1.0, lodTransitionRef.current + delta * 4.5);
    }

    // Toggle mesh visibility directly in WebGL (zero React lag)
    if (macroMeshRef.current) macroMeshRef.current.visible = activeTierRef.current === 0;
    if (regionalMeshRef.current) regionalMeshRef.current.visible = activeTierRef.current === 1;
    if (metroMeshRef.current) metroMeshRef.current.visible = activeTierRef.current === 2;

    // When in Tier 2 (0.26° Metro), keep the visible hemisphere cap filled with native-res blocks
    if (activeTierRef.current === 2 && metroMeshRef.current) {
      tmpCamDir.copy(camera.position).normalize();
      const needsRebuild =
        !lastMetroCenterRef.current ||
        lastMetroCenterRef.current.angleTo(tmpCamDir) > METRO_REBUILD_ANGLE_RAD;

      if (needsRebuild) {
        if (!lastMetroCenterRef.current) {
          lastMetroCenterRef.current = tmpCamDir.clone();
        } else {
          lastMetroCenterRef.current.copy(tmpCamDir);
        }

        const count = fillCapLandCellsIntoBuffers(
          dataset.landMask,
          dataset.manifest.width,
          dataset.manifest.height,
          LOD_TIERS[2].stepDeg,
          GLOBE_RADIUS,
          { centerDir: lastMetroCenterRef.current, minCosAngle: METRO_CAP_MIN_COS },
          metroUvAttr.array as Float32Array,
          metroMeshRef.current.instanceMatrix.array as Float32Array,
          MAX_METRO_INSTANCES,
        );

        metroMeshRef.current.count = count;
        metroUvAttr.needsUpdate = true;
        metroMeshRef.current.instanceMatrix.needsUpdate = true;
      }
    }

    const { bracket, relativeNormRef } = interpolateGlobalStats(
      dataset.manifest.keyframes,
      yearRef.current,
      dataset.manifest.maxEncodedDensity,
    );
    const texA = frameTextures[bracket.indexA];
    const texB = frameTextures[bracket.indexB];
    const relMode = scaleMode === 'relative' ? 1.0 : 0.0;

    const baseMat = baseMatRef.current;
    if (baseMat) {
      baseMat.uniforms.uTexA.value = texA;
      baseMat.uniforms.uTexB.value = texB;
      baseMat.uniforms.uAlpha.value = bracket.alpha;
      baseMat.uniforms.uRelativeMode.value = relMode;
      baseMat.uniforms.uRelativeNormRef.value = relativeNormRef;
    }

    const activeMat =
      activeTierRef.current === 0
        ? macroMatRef.current
        : activeTierRef.current === 1
          ? regionalMatRef.current
          : metroMatRef.current;

    if (activeMat) {
      activeMat.uniforms.uTexA.value = texA;
      activeMat.uniforms.uTexB.value = texB;
      activeMat.uniforms.uAlpha.value = bracket.alpha;
      activeMat.uniforms.uElevation.value = elevation;
      activeMat.uniforms.uRelativeMode.value = relMode;
      activeMat.uniforms.uRelativeNormRef.value = relativeNormRef;
      activeMat.uniforms.uLodTransition.value = lodTransitionRef.current;
    }
  });

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const now = performance.now();
    if (now - lastHoverTsRef.current < 32) return;
    lastHoverTsRef.current = now;
    const p = e.point;
    onHoverCoords(vec3ToLatLon(p.x, p.y, p.z));
  };

  const handlePointerOut = () => {
    onHoverCoords(null);
  };

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (pointerDownRef.current) {
      const dx = e.clientX - pointerDownRef.current.x;
      const dy = e.clientY - pointerDownRef.current.y;
      if (Math.hypot(dx, dy) > 6) return;
    }
    const p = e.point;
    onClickCoords(vec3ToLatLon(p.x, p.y, p.z));
  };

  const pinnedPeakRadius = useMemo(() => {
    if (!pinnedCoords) return GLOBE_RADIUS;
    return computeBlockTopRadius(
      dataset,
      pinnedCoords.lat,
      pinnedCoords.lon,
      displayYear,
      scaleMode,
      elevation,
      lodTier,
    );
  }, [dataset, pinnedCoords, displayYear, scaleMode, elevation, lodTier]);

  return (
    <group>
      {/* Smooth deep-indigo orbital base sphere (also handles clean surface raycasting) */}
      <mesh
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
      >
        <sphereGeometry args={[GLOBE_RADIUS, 128, 64]} />
        <shaderMaterial
          ref={baseMatRef}
          vertexShader={BASE_GLOBE_VERTEX_SHADER}
          fragmentShader={BASE_GLOBE_FRAGMENT_SHADER}
          uniforms={baseUniforms}
        />
      </mesh>

      {/* LOD Tier 0: 1.05° Macro Global Blocks (zoomed out) */}
      <instancedMesh
        ref={macroMeshRef}
        args={[macroGeom, undefined, macroGrid.count]}
        raycast={() => null}
      >
        <shaderMaterial
          ref={macroMatRef}
          vertexShader={BLOCK_VERTEX_SHADER}
          fragmentShader={BLOCK_FRAGMENT_SHADER}
          uniforms={macroUniforms}
          toneMapped={false}
        />
      </instancedMesh>

      {/* LOD Tier 1: 0.58° Regional Blocks (medium orbit) */}
      <instancedMesh
        ref={regionalMeshRef}
        args={[regionalGeom, undefined, regionalGrid.count]}
        visible={false}
        raycast={() => null}
      >
        <shaderMaterial
          ref={regionalMatRef}
          vertexShader={BLOCK_VERTEX_SHADER}
          fragmentShader={BLOCK_FRAGMENT_SHADER}
          uniforms={regionalUniforms}
          toneMapped={false}
        />
      </instancedMesh>

      {/* LOD Tier 2: 0.26° Metro Native-Resolution Blocks (close zoom, dynamic hemisphere cap) */}
      <instancedMesh
        ref={metroMeshRef}
        args={[metroGeom, undefined, MAX_METRO_INSTANCES]}
        visible={false}
        raycast={() => null}
      >
        <shaderMaterial
          ref={metroMatRef}
          vertexShader={BLOCK_VERTEX_SHADER}
          fragmentShader={BLOCK_FRAGMENT_SHADER}
          uniforms={metroUniforms}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Crisp vector coastlines */}
      <lineSegments geometry={coastlines} renderOrder={2}>
        <lineBasicMaterial color="#38bdf8" transparent opacity={0.38} depthWrite={false} />
      </lineSegments>

      {/* Subtle toggleable country borders */}
      {overlays.borders && (
        <lineSegments geometry={borders} renderOrder={3}>
          <lineBasicMaterial color="#7dd3fc" transparent opacity={0.20} depthWrite={false} />
        </lineSegments>
      )}

      {/* Faint orbital lat/lon graticule */}
      {overlays.graticule && (
        <lineSegments geometry={graticule} renderOrder={1}>
          <lineBasicMaterial color="#38bdf8" transparent opacity={0.09} depthWrite={false} />
        </lineSegments>
      )}

      {/* Atmospheric Fresnel limb halo */}
      <mesh scale={1.15}>
        <sphereGeometry args={[GLOBE_RADIUS, 64, 48]} />
        <shaderMaterial
          vertexShader={ATMOSPHERE_VERTEX_SHADER}
          fragmentShader={ATMOSPHERE_FRAGMENT_SHADER}
          side={THREE.BackSide}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Dynamic evolving top-hotspot 3D pins + screen-projected HUD callouts */}
      {[0, 1, 2, 3, 4, 5].map((slotIdx) => {
        const hs = activeHotspots[slotIdx] ?? null;
        return (
          <HotspotPin
            key={slotIdx}
            slotIdx={slotIdx}
            hotspot={hs}
            visible={overlays.callouts}
            hotspotSlotRefs={hotspotSlotRefs}
            peakRadius={
              hs
                ? computeBlockTopRadius(
                    dataset,
                    hs.lat,
                    hs.lon,
                    displayYear,
                    scaleMode,
                    elevation,
                    lodTier,
                  )
                : GLOBE_RADIUS
            }
          />
        );
      })}

      {/* Pinned orbital reticle */}
      {pinnedCoords && (
        <PinnedReticle
          lat={pinnedCoords.lat}
          lon={pinnedCoords.lon}
          peakRadius={pinnedPeakRadius}
        />
      )}
    </group>
  );
}
