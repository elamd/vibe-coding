import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CameraBookmark,
  HotspotCallout,
  LoadedDataset,
  OverlayOptions,
  ScaleMode,
} from './data/types';
import { loadDensityDataset, probeSurface } from './data/loader';
import { formatDensity, interpolateGlobalStats } from './data/scale';
import { GlobeScene, type CameraTarget } from './globe/GlobeScene';
import { LOD_TIERS, type LodTierId } from './globe/blockGrid';
import { GlobalReadout } from './ui/GlobalReadout';
import { ControlDrawer } from './ui/ControlDrawer';
import { SurfaceProbeCard } from './ui/SurfaceProbeCard';
import { TimelineDock } from './ui/TimelineDock';
import { LoadingOverlay } from './ui/LoadingOverlay';

const BASE_YEARS_PER_SECOND = 24;

export function App() {
  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, total: 40 });
  const [loadError, setLoadError] = useState<string | null>(null);

  // Open on 2023 for immediate visual impact; Play rewinds to 1800 and plays forward
  const yearRef = useRef<number>(2023);
  const [displayYear, setDisplayYear] = useState<number>(2023);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [speed, setSpeed] = useState<number>(1);

  const [scaleMode, setScaleMode] = useState<ScaleMode>('global-log');
  const [elevation, setElevation] = useState<number>(1.15);
  const [overlays, setOverlays] = useState<OverlayOptions>({
    borders: true,
    callouts: true,
    graticule: true,
    autoRotate: true,
  });

  const [hoverCoords, setHoverCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [pinnedCoords, setPinnedCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [cameraTarget, setCameraTarget] = useState<CameraTarget | null>(null);
  const [activeBookmarkId, setActiveBookmarkId] = useState<string | null>('global');
  const [lodTier, setLodTier] = useState<LodTierId>(0);
  const hotspotSlotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [isCompactViewport, setIsCompactViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );

  // Track responsive viewport breakpoint
  useEffect(() => {
    const onResize = () => setIsCompactViewport(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Load HYDE 3.3 static data bundle
  useEffect(() => {
    let cancelled = false;
    loadDensityDataset((loaded, total) => {
      if (!cancelled) setLoadProgress({ loaded, total });
    })
      .then((loaded) => {
        if (cancelled) return;
        yearRef.current = loaded.manifest.maxYear;
        setDisplayYear(loaded.manifest.maxYear);
        setDataset(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Smooth RAF playback loop driving yearRef at full framerate + updating HUD cleanly
  useEffect(() => {
    if (!isPlaying || !dataset) return;
    const { minYear, maxYear } = dataset.manifest;
    let rafId = 0;
    let lastTs = performance.now();
    let lastHudSync = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;

      const next = yearRef.current + dt * BASE_YEARS_PER_SECOND * speed;
      if (next >= maxYear) {
        yearRef.current = maxYear;
        setDisplayYear(maxYear);
        setIsPlaying(false);
        return;
      }

      yearRef.current = Math.max(minYear, next);
      if (now - lastHudSync >= 40) {
        lastHudSync = now;
        setDisplayYear(yearRef.current);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, speed, dataset]);

  const handleTogglePlay = useCallback(() => {
    if (!dataset) return;
    const { minYear, maxYear } = dataset.manifest;
    setIsPlaying((prev) => {
      if (prev) return false;
      // If sitting at 2023 (or nearly there), rewind cleanly to 1800 and animate forward
      if (yearRef.current >= maxYear - 0.5) {
        yearRef.current = minYear;
        setDisplayYear(minYear);
      }
      return true;
    });
  }, [dataset]);

  const handleRewind = useCallback(() => {
    if (!dataset) return;
    setIsPlaying(false);
    yearRef.current = dataset.manifest.minYear;
    setDisplayYear(dataset.manifest.minYear);
  }, [dataset]);

  const handleScrub = useCallback((nextYear: number) => {
    setIsPlaying(false);
    yearRef.current = nextYear;
    setDisplayYear(nextYear);
  }, []);

  const handleToggleOverlay = useCallback((key: keyof OverlayOptions) => {
    setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleSelectBookmark = useCallback((bm: CameraBookmark) => {
    setActiveBookmarkId(bm.id);
    setCameraTarget({
      lat: bm.lat,
      lon: bm.lon,
      distance: bm.distance,
      nonce: Date.now(),
    });
  }, []);

  const handleSelectHotspot = useCallback((hs: HotspotCallout) => {
    setActiveBookmarkId(null);
    setPinnedCoords({ lat: hs.lat, lon: hs.lon });
    setOverlays((prev) => ({ ...prev, autoRotate: false }));
    setCameraTarget({
      lat: hs.lat,
      lon: hs.lon,
      distance: 1.62,
      nonce: Date.now(),
    });
  }, []);

  const handleClickCoords = useCallback((coords: { lat: number; lon: number }) => {
    setPinnedCoords(coords);
    setOverlays((prev) => ({ ...prev, autoRotate: false }));
  }, []);

  // Keyboard shortcuts: Space (Play/Pause), Arrows (Step), Escape (Unpin)
  useEffect(() => {
    if (!dataset) return;
    const { minYear, maxYear } = dataset.manifest;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 5;
        handleScrub(Math.min(maxYear, Math.round(yearRef.current) + step));
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 5;
        handleScrub(Math.max(minYear, Math.round(yearRef.current) - step));
      } else if (e.code === 'Escape') {
        setPinnedCoords(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dataset, handleTogglePlay, handleScrub]);

  const globalStats = useMemo(() => {
    if (!dataset) return null;
    return interpolateGlobalStats(
      dataset.manifest.keyframes,
      displayYear,
      dataset.manifest.maxEncodedDensity,
    );
  }, [dataset, displayYear]);

  const activeProbe = useMemo(() => {
    if (!dataset) return null;
    const target = pinnedCoords ?? hoverCoords;
    if (!target) return null;
    return probeSurface(dataset, target.lat, target.lon, displayYear, pinnedCoords !== null);
  }, [dataset, pinnedCoords, hoverCoords, displayYear]);

  const activeHotspots = useMemo(() => {
    if (!dataset || !globalStats) return [];
    const { bracket } = globalStats;
    const chosenIdx = bracket.alpha >= 0.5 ? bracket.indexB : bracket.indexA;
    return dataset.manifest.keyframes[chosenIdx].hotspots;
  }, [dataset, globalStats]);

  if (!dataset || !globalStats) {
    return (
      <LoadingOverlay
        loaded={loadProgress.loaded}
        total={loadProgress.total}
        error={loadError}
      />
    );
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#030612]">
      {/* Full-bleed 3D WebGL2 Orbital Globe */}
      <GlobeScene
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
        onLodTierChange={setLodTier}
        cameraTarget={cameraTarget}
        onHoverCoords={setHoverCoords}
        onClickCoords={handleClickCoords}
        isCompactViewport={isCompactViewport}
      />

      {/* Screen-projected 3D Hotspot Callouts (zero React portals, 60fps direct transform) */}
      <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((slotIdx) => {
          const hs = activeHotspots[slotIdx] ?? null;
          return (
            <button
              key={slotIdx}
              ref={(el) => {
                hotspotSlotRefs.current[slotIdx] = el;
              }}
              type="button"
              onClick={() => hs && handleSelectHotspot(hs)}
              style={{ opacity: 0, position: 'absolute', left: 0, top: 0 }}
              className="cursor-pointer whitespace-nowrap rounded-md border border-amber-300/45 bg-[#04091a]/88 px-2 py-0.5 text-left text-[10px] leading-tight text-amber-100 shadow-lg backdrop-blur-md transition-colors hover:border-amber-200 hover:bg-[#081230]/95"
            >
              <div className="font-semibold tracking-wide text-amber-200">{hs?.name ?? ''}</div>
              <div className="font-mono-tech text-[9px] text-cyan-200/90">
                {hs ? `${formatDensity(hs.density)}/km²` : ''}
              </div>
            </button>
          );
        })}
      </div>

      {/* Focused Telemetry Cockpit HUD */}
      <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-3 sm:p-5">
        {/* Top Row: Left Readout + Probe, Right Controls */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-2.5">
            <GlobalReadout
              year={displayYear}
              worldPopulation={globalStats.worldPopulation}
              baselinePop={dataset.manifest.keyframes[0].worldPopulation}
              baselineYear={dataset.manifest.minYear}
              peakDensity={globalStats.peakDensity}
              scaleMode={scaleMode}
              lodLabel={LOD_TIERS[lodTier].label}
              isCompact={isCompactViewport}
            />
            <SurfaceProbeCard
              probe={activeProbe}
              currentYear={displayYear}
              onUnpin={() => setPinnedCoords(null)}
            />
          </div>

          <ControlDrawer
            scaleMode={scaleMode}
            onScaleModeChange={setScaleMode}
            elevation={elevation}
            onElevationChange={setElevation}
            overlays={overlays}
            onToggleOverlay={handleToggleOverlay}
            defaultOpen={!isCompactViewport}
          />
        </div>

        {/* Bottom Dock: Sector Bookmarks + Linear 1800–2023 Scrubber */}
        <TimelineDock
          minYear={dataset.manifest.minYear}
          maxYear={dataset.manifest.maxYear}
          year={displayYear}
          isPlaying={isPlaying}
          speed={speed}
          activeBookmarkId={activeBookmarkId}
          onTogglePlay={handleTogglePlay}
          onRewind={handleRewind}
          onScrub={handleScrub}
          onSpeedChange={setSpeed}
          onSelectBookmark={handleSelectBookmark}
        />
      </div>
    </main>
  );
}

export default App;
