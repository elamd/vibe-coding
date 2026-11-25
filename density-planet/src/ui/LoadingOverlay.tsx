interface LoadingOverlayProps {
  loaded: number;
  total: number;
  error: string | null;
}

export function LoadingOverlay({ loaded, total, error }: LoadingOverlayProps) {
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#030612] px-6">
      <div className="hud-panel w-full max-w-md rounded-2xl p-6 text-center">
        <div className="flex items-center justify-center gap-2">
          <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.9)]" />
          <span className="font-mono-tech text-xs font-bold tracking-[0.26em] text-cyan-200">
            DENSITY PLANET
          </span>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-left text-xs text-rose-200">
            <div className="font-mono-tech font-semibold text-rose-300">TELEMETRY LOAD ERROR</div>
            <p className="mt-1 text-rose-100/90">{error}</p>
          </div>
        ) : (
          <>
            <p className="mt-3 font-mono-tech text-[11px] text-slate-300">
              DECODING HYDE 3.3 POPULATION GRIDS ({loaded} / {total || 32})
            </p>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-900 border border-cyan-500/20">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-amber-300 transition-all duration-150"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-2 font-mono-tech text-[10px] text-slate-500">
              1492 – 2023 CE · 0.25° GLOBAL DENSITY BLOCKS
            </div>
          </>
        )}
      </div>
    </div>
  );
}
