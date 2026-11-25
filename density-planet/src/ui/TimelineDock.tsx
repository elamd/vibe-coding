import { Play, Pause, RotateCcw, Compass } from 'lucide-react';
import type { CameraBookmark } from '../data/types';
import { CAMERA_BOOKMARKS } from '../data/bookmarks';

interface TimelineDockProps {
  minYear: number;
  maxYear: number;
  year: number;
  isPlaying: boolean;
  speed: number;
  activeBookmarkId: string | null;
  onTogglePlay: () => void;
  onRewind: () => void;
  onScrub: (year: number) => void;
  onSpeedChange: (speed: number) => void;
  onSelectBookmark: (bookmark: CameraBookmark) => void;
}

const SPEEDS = [0.5, 1, 2, 4];
const TICK_YEARS = [1492, 1600, 1700, 1800, 1900, 2023];

export function TimelineDock({
  minYear,
  maxYear,
  year,
  isPlaying,
  speed,
  activeBookmarkId,
  onTogglePlay,
  onRewind,
  onScrub,
  onSpeedChange,
  onSelectBookmark,
}: TimelineDockProps) {
  const progressPct = ((year - minYear) / Math.max(1, maxYear - minYear)) * 100;

  return (
    <div className="pointer-events-auto mx-auto w-full max-w-[780px] space-y-2">
      {/* Curated Camera Bookmarks strip */}
      <div className="flex items-center justify-center gap-1.5 overflow-x-auto px-1 pb-0.5">
        <span className="hidden sm:inline-flex items-center gap-1 font-mono-tech text-[9px] tracking-[0.16em] text-slate-400 mr-1 shrink-0">
          <Compass className="h-3 w-3 text-cyan-400/80" />
          SECTORS
        </span>
        {CAMERA_BOOKMARKS.map((bm) => {
          const active = activeBookmarkId === bm.id;
          return (
            <button
              key={bm.id}
              type="button"
              onClick={() => onSelectBookmark(bm)}
              title={bm.eraHint ? `${bm.label} — ${bm.eraHint}` : bm.label}
              className={`shrink-0 rounded-full border px-2.5 py-1 font-mono-tech text-[10px] tracking-wider transition-all backdrop-blur-md ${
                active
                  ? 'border-amber-300/60 bg-amber-400/15 text-amber-100 shadow-[0_0_12px_rgba(251,191,36,0.2)]'
                  : 'border-cyan-400/20 bg-[#050b1c]/80 text-slate-300 hover:border-cyan-300/50 hover:text-cyan-100'
              }`}
            >
              {bm.shortLabel}
            </button>
          );
        })}
      </div>

      {/* Main Timeline Scrubber Bar */}
      <div className="hud-panel rounded-2xl px-3.5 py-2.5 sm:px-5 sm:py-3">
        <div className="flex items-center gap-2.5 sm:gap-3.5">
          {/* Play / Pause */}
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause timeline' : `Play timeline from ${minYear} to ${maxYear}`}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-amber-300/50 bg-amber-400/15 text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.25)] transition-all hover:bg-amber-400/25 hover:scale-105 active:scale-95"
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </button>

          {/* Rewind to baseline year */}
          <button
            type="button"
            onClick={onRewind}
            title={`Reset to ${minYear}`}
            aria-label={`Reset timeline to ${minYear}`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-slate-900/60 text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-100"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          {/* Linear Scrubber */}
          <div className="relative flex-1 pt-1 pb-3">
            <div className="relative flex items-center">
              {/* Illuminated progress underlay */}
              <div
                className="pointer-events-none absolute left-0 h-1 rounded-full bg-gradient-to-r from-cyan-400 via-sky-300 to-amber-300"
                style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
              />
              <input
                type="range"
                min={minYear}
                max={maxYear}
                step={0.1}
                value={year}
                onChange={(e) => onScrub(parseFloat(e.target.value))}
                aria-label="Timeline year scrubber"
                className="orbital-slider relative z-10 w-full"
              />
            </div>

            {/* Linear year tick marks */}
            <div className="pointer-events-none relative mt-1.5 h-3">
              {TICK_YEARS.map((tick) => {
                const leftPct = ((tick - minYear) / Math.max(1, maxYear - minYear)) * 100;
                const isLast = tick === maxYear;
                const isFirst = tick === minYear;
                return (
                  <span
                    key={tick}
                    className={`absolute font-mono-tech text-[9px] text-slate-400 ${
                      isFirst ? 'translate-x-0' : isLast ? '-translate-x-full' : '-translate-x-1/2'
                    }`}
                    style={{ left: `${leftPct}%` }}
                  >
                    {tick}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Speed Selector */}
          <div className="hidden sm:flex items-center gap-0.5 rounded-lg border border-cyan-500/20 bg-slate-950/70 p-0.5 shrink-0">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSpeedChange(s)}
                className={`rounded-md px-1.5 py-1 font-mono-tech text-[10px] transition-colors ${
                  speed === s
                    ? 'bg-cyan-500/25 text-cyan-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        {/* Subtle keyboard shortcut caption */}
        <div className="mt-1 hidden sm:flex items-center justify-between font-mono-tech text-[9px] text-slate-500">
          <span>SPACE Play/Pause · ←/→ Step · Left-drag Orbit · Right-drag Pan · Click to pin</span>
          <span>{minYear} → {maxYear} LINEAR TIMELINE</span>
        </div>
      </div>
    </div>
  );
}
