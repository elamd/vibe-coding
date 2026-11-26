import type { PluginContext, SolverPlugin } from '../../engine/types.ts';
import { syncBodyPixels } from '../forces/CollisionPlugin.ts';

/**
 * Shared continuous 2D physics integrator used by both Continuous
 * and Grid-Snap (Hybrid) solver plugins.
 */
export function stepContinuousPhysics(ctx: PluginContext, dt: number, substeps = 2): void {
  const { store, registry } = ctx;
  const forces = registry.getForces().filter((f) => f.enabled);
  const interactions = registry.getInteractions().filter((it) => it.enabled);
  const subDt = dt / substeps;
  const linearDamping = Math.pow(0.996, subDt * 60);
  const angularDamping = Math.pow(0.985, subDt * 60);

  for (let s = 0; s < substeps; s++) {
    // 1. Apply forces & integrate loose pixels
    for (let i = 0; i < store.highWaterMark; i++) {
      if (store.active[i] === 0) continue;
      if (store.bodyId[i] !== -1) continue;

      for (let f = 0; f < forces.length; f++) {
        forces[f]!.applyToPixel?.(ctx, i, subDt);
      }

      const i2 = i * 2;
      store.vel[i2] = store.vel[i2]! * linearDamping;
      store.vel[i2 + 1] = store.vel[i2 + 1]! * linearDamping;
      store.pos[i2] = store.pos[i2]! + store.vel[i2]! * subDt;
      store.pos[i2 + 1] = store.pos[i2 + 1]! + store.vel[i2 + 1]! * subDt;
    }

    // 2. Apply forces & integrate bonded rigid-ish bodies
    for (const body of store.bodies.values()) {
      for (let f = 0; f < forces.length; f++) {
        forces[f]!.applyToBody?.(ctx, body, subDt);
      }
      body.vx *= linearDamping;
      body.vy *= linearDamping;
      body.omega *= angularDamping;
      body.x += body.vx * subDt;
      body.y += body.vy * subDt;
      body.angle += body.omega * subDt;
      syncBodyPixels(ctx, body);
    }

    // 3. Resolve all registered interactions (solid collisions, ground, walls)
    for (let k = 0; k < interactions.length; k++) {
      interactions[k]!.resolveInteractions(ctx, subDt);
    }
  }
}

/**
 * Mode 1: Continuous 2D Particle + Bonded Cluster Solver Plugin.
 */
export class ContinuousSolverPlugin implements SolverPlugin {
  readonly id = 'solver-continuous';
  readonly name = 'Continuous Solver';
  readonly category = 'solver' as const;
  readonly description = 'Smooth continuous 2D particle and bonded-body physics.';
  readonly modeId = 'continuous' as const;
  readonly label = 'Continuous';
  readonly snapVisualsToGrid = false;
  enabled = true;

  step(ctx: PluginContext, dt: number): void {
    stepContinuousPhysics(ctx, dt, 2);
  }
}
