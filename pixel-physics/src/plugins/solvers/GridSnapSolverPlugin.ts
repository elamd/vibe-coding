import type { PluginContext, SolverPlugin } from '../../engine/types.ts';
import { stepContinuousPhysics } from './ContinuousSolverPlugin.ts';

/**
 * Mode 2: Hybrid Solver Plugin.
 * Runs continuous 2D momentum/mass physics underneath while snapping
 * rendered pixel coordinates to the N×N virtual pixel grid.
 */
export class GridSnapSolverPlugin implements SolverPlugin {
  readonly id = 'solver-grid-snap';
  readonly name = 'Grid-Snap Solver';
  readonly category = 'solver' as const;
  readonly description = 'Continuous physics underneath with visuals quantized to the N×N virtual pixel grid.';
  readonly modeId = 'grid-snap' as const;
  readonly label = 'Grid-Snap';
  readonly snapVisualsToGrid = true;
  enabled = true;

  step(ctx: PluginContext, dt: number): void {
    stepContinuousPhysics(ctx, dt, 2);
  }
}
