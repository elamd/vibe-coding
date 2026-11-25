import type { ScaleMode } from '../data/types';
import { formatDensity, formatPopulation, getEraLabel } from '../data/scale';

interface GlobalReadoutProps {
  year: number;
  worldPopulation: number;
  baselinePop: number;
  baselineYear: number;
  peakDensity: number;
  scaleMode: ScaleMode;
  lodLabel: string;
  isCompact: boolean;
}

export function GlobalReadout({
  year,
  worldPopulation,
  baselinePop,
  baselineYear,
  peakDensity,
  scaleMode,
  lodLabel,
  isCompact,
}: GlobalReadoutProps) {
  const displayYear = Math.round(year);
  const era = getEraLabel(displayYear);
  const growthMultiple = baselinePop > 0 ? worldPopulation / baselinePop : 1;

  return (
    <div className="hud-panel pointer-events-auto rounded-xl px-3.5 py-3 sm:px-4 sm:py-3.5 w-[240px] sm:w-[292px]">
      {/* Header badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.9)]" />
          <h1 className="text-[11px] font-bold tracking-[0.22em] text-cyan-200">
            DENSITY PLANET
          </h1>
        </div>
        <span className="font-mono-tech rounded border border-cyan-400/25 bg-cyan-950/50 px-1.5 py-0.5 text-[9px] tracking-wider text-cyan-300/90">
          HYDE 3.3
        </span>
      </div>

      {/* Year & Era */}
      <div className="mt-2 flex items-baseline justify-between border-b border-cyan-500/15 pb-2">
        <div className="font-mono-tech text-3xl sm:text-4xl font-bold tracking-tight text-amber-100 drop-shadow-[0_0_16px_rgba(251,191,36,0.35)]">
          {displayYear}
        </div>
        <div className="text-right">
          <div className="font-mono-tech text-[9px] font-semibold tracking-[0.16em] text-amber-300/90">
            {era}
          </div>
          <div className="font-mono-tech text-[9px] text-slate-400">
            {scaleMode === 'global-log' ? 'GLOBAL LOG' : 'ERA RELATIVE'} · {lodLabel}
          </div>
        </div>
      </div>

      {/* Key metrics */}
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <div>
          <div className="font-mono-tech text-[9px] tracking-[0.14em] text-slate-400">
            WORLD POP
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-mono-tech text-lg font-semibold text-cyan-100">
              {formatPopulation(worldPopulation)}
            </span>
            <span
              className="font-mono-tech text-[10px] text-cyan-400/80"
              title={`Multiple vs ${baselineYear}`}
            >
              {growthMultiple.toFixed(1)}×
            </span>
          </div>
        </div>
        <div>
          <div className="font-mono-tech text-[9px] tracking-[0.14em] text-slate-400">
            PEAK DENSITY
          </div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className="font-mono-tech text-lg font-semibold text-amber-200">
              {formatDensity(peakDensity)}
            </span>
            <span className="font-mono-tech text-[9px] text-slate-400">/km²</span>
          </div>
        </div>
      </div>

      {/* Density Color Ramp Legend */}
      {!isCompact && (
        <div className="mt-3 pt-2 border-t border-cyan-500/15">
          <div className="flex items-center justify-between font-mono-tech text-[9px] text-slate-400 mb-1">
            <span>DENSITY (PEOPLE / KM²)</span>
            <span className="text-cyan-300/80">LOG₁₀</span>
          </div>
          <div
            className="h-2 w-full rounded-full"
            style={{
              background:
                'linear-gradient(90deg, #0e1b3a 0%, #0b416b 18%, #0ea5c6 42%, #3ee3f5 62%, #f59e0b 82%, #fef9c3 100%)',
            }}
          />
          <div className="mt-1 flex justify-between font-mono-tech text-[9px] text-slate-400">
            <span>0</span>
            <span>10</span>
            <span>100</span>
            <span>1K</span>
            <span>10K+</span>
          </div>
        </div>
      )}
    </div>
  );
}
