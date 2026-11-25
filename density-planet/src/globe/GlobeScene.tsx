import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type {
  CameraBookmark,
  HotspotCallout,
  LoadedDataset,
  OverlayOptions,
  ScaleMode,
} from '../data/types';
import { latLonToVec3 } from '../data/geo';
import type { LodTierId } from './blockGrid';
import { DensityGlobe } from './DensityGlobe';

interface CameraTarget {
  lat: number;
  lon: number;
  distance: number;
  nonce: number;
}

interface CameraRigProps {
  target: CameraTarget | null;
  autoRotate: boolean;
  isUserInteractingRef: React.MutableRefObject<boolean>;
}

function CameraRig({ target, autoRotate, isUserInteractingRef }: CameraRigProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const animRef = useRef<{
    active: boolean;
    startPos: THREE.Vector3;
    endPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    progress: number;
  }>({
    active: false,
    startPos: new THREE.Vector3(),
    endPos: new THREE.Vector3(),
    startTarget: new THREE.Vector3(),
    progress: 1,
  });

  // Position initial camera over Afro-Eurasia (22°N, 48°E) on mount
  useEffect(() => {
    const initial = latLonToVec3(22, 48, 3.05);
    camera.position.copy(initial);
    camera.lookAt(0, 0, 0);
  }, [camera]);

  // Trigger smooth spherical fly-to and smoothly re-center any pan offset on bookmark/hotspot click
  useEffect(() => {
    if (!target) return;
    const currentTarget = controlsRef.current
      ? controlsRef.current.target.clone()
      : new THREE.Vector3();
    animRef.current = {
      active: true,
      startPos: camera.position.clone().sub(currentTarget),
      endPos: latLonToVec3(target.lat, target.lon, target.distance),
      startTarget: currentTarget,
      progress: 0,
    };
  }, [target, camera]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    const anim = animRef.current;

    if (anim.active) {
      anim.progress = Math.min(1, anim.progress + delta * 1.45);
      // Cubic ease-out
      const ease = 1 - Math.pow(1 - anim.progress, 3);

      // Spherical slerp along direction + smooth distance blend so camera orbits smoothly around globe
      const startDir = anim.startPos.clone().normalize();
      const endDir = anim.endPos.clone().normalize();
      const angle = startDir.angleTo(endDir);
      let interpDir: THREE.Vector3;

      if (angle < 1e-4) {
        interpDir = endDir;
      } else {
        const sinA = Math.sin(angle);
        const wA = Math.sin((1 - ease) * angle) / sinA;
        const wB = Math.sin(ease * angle) / sinA;
        interpDir = startDir.multiplyScalar(wA).add(endDir.multiplyScalar(wB)).normalize();
      }

      const dist = THREE.MathUtils.lerp(anim.startPos.length(), anim.endPos.length(), ease);
      const nextTarget = anim.startTarget.clone().multiplyScalar(1 - ease);
      if (controls) {
        controls.target.copy(nextTarget);
      }
      camera.position.copy(interpDir.multiplyScalar(dist)).add(nextTarget);
      camera.lookAt(nextTarget);
      controls?.update();

      if (anim.progress >= 1) {
        anim.active = false;
      }
      return;
    }

    // Clamp screen-space pan radius so the globe stays comfortably reachable
    if (controls && controls.target.lengthSq() > 1.85 * 1.85) {
      const clamped = controls.target.clone().setLength(1.85);
      const correction = clamped.sub(controls.target);
      controls.target.add(correction);
      camera.position.add(correction);
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan
      screenSpacePanning
      panSpeed={0.85}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      }}
      enableDamping
      dampingFactor={0.07}
      rotateSpeed={0.55}
      zoomSpeed={0.85}
      minDistance={1.22}
      maxDistance={5.2}
      autoRotate={autoRotate && !animRef.current.active && !isUserInteractingRef.current}
      autoRotateSpeed={0.38}
      onStart={() => {
        isUserInteractingRef.current = true;
        animRef.current.active = false;
      }}
      onEnd={() => {
        isUserInteractingRef.current = false;
      }}
    />
  );
}

interface GlobeSceneProps {
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
  cameraTarget: CameraTarget | null;
  onHoverCoords: (coords: { lat: number; lon: number } | null) => void;
  onClickCoords: (coords: { lat: number; lon: number }) => void;
  isCompactViewport: boolean;
}

export type { CameraTarget, CameraBookmark };

export function GlobeScene({
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
  cameraTarget,
  onHoverCoords,
  onClickCoords,
  isCompactViewport,
}: GlobeSceneProps) {
  const isUserInteractingRef = useRef(false);

  return (
    <div
      className="absolute inset-0 h-full w-full"
      onContextMenu={(e) => e.preventDefault()}
    >
      <Canvas
        dpr={isCompactViewport ? [1, 1.5] : [1, 2]}
        camera={{ fov: 42, near: 0.05, far: 100, position: [2.1, 1.15, -1.95] }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
      >
        <color attach="background" args={['#030612']} />

        <Stars
          radius={38}
          depth={30}
          count={isCompactViewport ? 1400 : 2800}
          factor={2.6}
          saturation={0.2}
          fade
          speed={0.35}
        />

        <DensityGlobe
          dataset={dataset}
          yearRef={yearRef}
          displayYear={displayYear}
          scaleMode={scaleMode}
          elevation={elevation}
          overlays={overlays}
          pinnedCoords={pinnedCoords}
          activeHotspots={activeHotspots}
          hotspotSlotRefs={hotspotSlotRefs}
          lodTier={lodTier}
          onLodTierChange={onLodTierChange}
          onHoverCoords={onHoverCoords}
          onClickCoords={onClickCoords}
        />

        <CameraRig
          target={cameraTarget}
          autoRotate={overlays.autoRotate}
          isUserInteractingRef={isUserInteractingRef}
        />

        <EffectComposer multisampling={isCompactViewport ? 0 : 4}>
          <Bloom
            mipmapBlur
            luminanceThreshold={0.92}
            luminanceSmoothing={0.28}
            intensity={isCompactViewport ? 0.55 : 0.78}
          />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
