import { useState } from 'react';
import {
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Globe2,
  MapPin,
  Grid3x3,
  RotateCw,
} from 'lucide-react';
import type { OverlayOptions, ScaleMode } from '../data/types';

interface ControlDrawerProps {
  scaleMode: ScaleMode;
  onScaleModeChange: (mode: ScaleMode) => void;
  elevation: number;
  onElevationChange: (val: number) => void;
  overlays: OverlayOptions;
  onToggleOverlay: (key: keyof OverlayOptions) => void;
  defaultOpen: boolean;
}

export function ControlDrawer({
  scaleMode,
  onScaleModeChange,
  elevation,
  onElevationChange,
  overlays,
  onToggleOverlay,
  defaultOpen,
}: ControlDrawerProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="hud-panel pointer-events-auto rounded-xl w-[230px] sm:w-[258px] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left transition-colors hover:bg-cyan-400/5"
      >
        <span className="flex items-center gap-2 font-mono-tech text-[10px] font-semibold tracking-[0.18em] text-cyan-200">
          <SlidersHorizontal className="h-3.5 w-3.5 text-cyan-400" />
          TELEMETRY CONTROLS
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        )}
      </button>

      {open && (
        <div className="border-t border-cyan-500/15 px-3.5 py-3 space-y-3.5">
          {/* Scale Mode */}
          <div>
            <div className="font-mono-tech text-[9px] tracking-[0.16em] text-slate-400 mb-1.5">
              SCALE NORMALIZATION
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-950/70 p-1 border border-cyan-500/15">
              <button
                type="button"
                onClick={() => onScaleModeChange('global-log')}
                className={`rounded-md px-2 py-1 font-mono-tech text-[10px] font-medium transition-all ${
                  scaleMode === 'global-log'
                    ? 'bg-cyan-500/25 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.45)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Global Log
              </button>
              <button
                type="button"
                onClick={() => onScaleModeChange('relative')}
                className={`rounded-md px-2 py-1 font-mono-tech text-[10px] font-medium transition-all ${
                  scaleMode === 'relative'
                    ? 'bg-amber-500/25 text-amber-100 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.45)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Era Relative
              </button>
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-slate-400">
              {scaleMode === 'global-log'
                ? 'Fixed 1492–2023 ceiling — shows absolute global eruption.'
                : 'Normalized to each era’s 99.5th percentile — reveals relative centers.'}
            </p>
          </div>

          {/* Block Height Slider */}
          <div>
            <div className="flex items-center justify-between font-mono-tech text-[9px] tracking-[0.16em] text-slate-400 mb-1">
              <span>BLOCK ELEVATION</span>
              <span className="text-amber-200">{elevation.toFixed(2)}×</span>
            </div>
            <input
              type="range"
              min={0}
              max={2.2}
              step={0.05}
              value={elevation}
              onChange={(e) => onElevationChange(parseFloat(e.target.value))}
              aria-label="Block Elevation"
              className="orbital-slider w-full"
            />
          </div>

          {/* Overlay toggles */}
          <div>
            <div className="font-mono-tech text-[9px] tracking-[0.16em] text-slate-400 mb-1.5">
              ORBITAL OVERLAYS
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <OverlayToggleButton
                active={overlays.borders}
                onClick={() => onToggleOverlay('borders')}
                icon={<Globe2 className="h-3 w-3" />}
                label="Borders"
              />
              <OverlayToggleButton
                active={overlays.callouts}
                onClick={() => onToggleOverlay('callouts')}
                icon={<MapPin className="h-3 w-3" />}
                label="Hotspots"
              />
              <OverlayToggleButton
                active={overlays.graticule}
                onClick={() => onToggleOverlay('graticule')}
                icon={<Grid3x3 className="h-3 w-3" />}
                label="Graticule"
              />
              <OverlayToggleButton
                active={overlays.autoRotate}
                onClick={() => onToggleOverlay('autoRotate')}
                icon={<RotateCw className="h-3 w-3" />}
                label="Auto-Orbit"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-cyan-500/10 font-mono-tech text-[9px] text-slate-500">
            Source: HYDE 3.3 · Utrecht Univ. / PBL
          </div>
        </div>
      )}
    </div>
  );
}

interface OverlayToggleButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function OverlayToggleButton({ active, onClick, icon, label }: OverlayToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 font-mono-tech text-[10px] transition-all ${
        active
          ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
          : 'border-slate-700/60 bg-slate-900/50 text-slate-400 hover:border-slate-600 hover:text-slate-200'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
