import { Crosshair, Pin, X } from 'lucide-react';
import type { SurfaceProbeData } from '../data/types';
import { formatCoords } from '../data/geo';
import { formatDensity } from '../data/scale';

interface SurfaceProbeCardProps {
  probe: SurfaceProbeData | null;
  currentYear: number;
  onUnpin: () => void;
}

export function SurfaceProbeCard({ probe, currentYear, onUnpin }: SurfaceProbeCardProps) {
  if (!probe) {
    return (
      <div className="hud-panel pointer-events-none hidden sm:flex items-center gap-2 rounded-lg px-3 py-2 w-[292px] text-[11px] text-slate-400">
        <Crosshair className="h-3.5 w-3.5 text-cyan-400/75 shrink-0" />
        <span>Hover or click globe to probe local density</span>
      </div>
    );
  }

  const title = probe.countryName
    ? probe.countryName
    : probe.isLand
      ? 'Unassigned Territory'
      : 'Open Ocean';

  const subtitle = probe.nearestCity
    ? probe.nearestCity.distanceKm < 45
      ? `${probe.nearestCity.name}, ${probe.nearestCity.country}`
      : `~${Math.round(probe.nearestCity.distanceKm)} km from ${probe.nearestCity.name}`
    : probe.isLand
      ? 'Remote landmass'
      : 'Marine sector';

  const minYear = probe.history[0]?.year ?? 1492;
  const maxYear = probe.history[probe.history.length - 1]?.year ?? 2023;
  const baselineDensity = probe.history[0]?.density ?? 0;
  const maxHist = Math.max(1, ...probe.history.map((h) => h.density));
  const growthLabel =
    baselineDensity >= 1 && probe.density > 0
      ? `${(probe.density / baselineDensity).toFixed(1)}× vs ${minYear}`
      : null;

  // Build SVG sparkline path (log1p vertically so full historical trajectory is always legible)
  const svgW = 248;
  const svgH = 54;
  const padY = 5;
  const logMax = Math.log1p(Math.max(maxHist, 10));

  const points = probe.history.map((pt) => {
    const x = ((pt.year - minYear) / Math.max(1, maxYear - minYear)) * svgW;
    const normY = Math.log1p(pt.density) / logMax;
    const y = svgH - padY - normY * (svgH - padY * 2);
    return { x, y };
  });

  const linePath = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const areaPath =
    points.length > 1
      ? `${linePath} L ${svgW} ${svgH} L 0 ${svgH} Z`
      : '';

  const cursorX = ((currentYear - minYear) / Math.max(1, maxYear - minYear)) * svgW;
  const cursorNormY = Math.log1p(probe.density) / logMax;
  const cursorY = svgH - padY - cursorNormY * (svgH - padY * 2);

  return (
    <div
      className={`hud-panel ${
        probe.pinned ? 'hud-panel-amber' : ''
      } pointer-events-auto rounded-xl px-3.5 py-3 w-[256px] sm:w-[292px]`}
    >
      {/* Top status bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono-tech text-[9px] font-semibold tracking-[0.16em]">
          {probe.pinned ? (
            <>
              <Pin className="h-3 w-3 text-amber-300" />
              <span className="text-amber-300">PINNED RETICLE</span>
            </>
          ) : (
            <>
              <Crosshair className="h-3 w-3 text-cyan-400" />
              <span className="text-cyan-300">SURFACE PROBE</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono-tech text-[9px] text-slate-400">
            {formatCoords(probe.lat, probe.lon)}
          </span>
          {probe.pinned && (
            <button
              type="button"
              onClick={onUnpin}
              aria-label="Unpin surface probe"
              className="rounded p-0.5 text-slate-400 hover:bg-slate-800 hover:text-amber-200 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Location name */}
      <div className="mt-1.5">
        <div className="text-sm font-semibold text-slate-100 truncate">{title}</div>
        <div className="text-[11px] text-slate-400 truncate">{subtitle}</div>
      </div>

      {/* Density readout */}
      <div className="mt-2 flex items-baseline justify-between border-t border-cyan-500/15 pt-2">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono-tech text-xl font-bold text-amber-100">
            {formatDensity(probe.density)}
          </span>
          <span className="font-mono-tech text-[10px] text-slate-400">people / km²</span>
        </div>
        {growthLabel && (
          <span className="font-mono-tech text-[10px] text-cyan-300/90">{growthLabel}</span>
        )}
      </div>

      {/* 1800–2023 local density sparkline */}
      {probe.isLand && (
        <div className="mt-2.5">
          <div className="flex items-center justify-between font-mono-tech text-[9px] text-slate-400 mb-1">
            <span>LOCAL TRAJECTORY ({minYear}–{maxYear})</span>
            <span className="text-amber-200/80">PEAK {formatDensity(maxHist)}</span>
          </div>
          <div className="relative rounded-md bg-slate-950/75 border border-cyan-500/15 p-1">
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              className="w-full h-[54px] overflow-visible"
              aria-label={`Local population density sparkline ${minYear} to ${maxYear}`}
            >
              <defs>
                <linearGradient id="probeSparkFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {areaPath && <path d={areaPath} fill="url(#probeSparkFill)" />}
              {linePath && (
                <path
                  d={linePath}
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              )}
              {/* Current year vertical cursor */}
              <line
                x1={cursorX}
                y1={0}
                x2={cursorX}
                y2={svgH}
                stroke="#fbbf24"
                strokeWidth="1"
                strokeDasharray="2 2"
                opacity={0.85}
              />
              <circle
                cx={cursorX}
                cy={cursorY}
                r={3}
                fill="#fde68a"
                stroke="#060c1e"
                strokeWidth="1.2"
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
