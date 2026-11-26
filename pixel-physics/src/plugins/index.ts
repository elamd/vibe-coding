import type { PhysicsEngine } from '../engine/PhysicsEngine.ts';
import { CollisionPlugin } from './forces/CollisionPlugin.ts';
import { GravityPlugin } from './forces/GravityPlugin.ts';
import { CirclePlugin } from './objects/CirclePlugin.ts';
import { GroundPlugin } from './objects/GroundPlugin.ts';
import { PixelPlugin } from './objects/PixelPlugin.ts';
import { SquarePlugin } from './objects/SquarePlugin.ts';
import { MassPlugin } from './properties/MassPlugin.ts';
import { CellularAutomatonSolverPlugin } from './solvers/CellularAutomatonSolverPlugin.ts';
import { ContinuousSolverPlugin } from './solvers/ContinuousSolverPlugin.ts';
import { GridSnapSolverPlugin } from './solvers/GridSnapSolverPlugin.ts';

/**
 * Registers all built-in core plugins and example custom shape plugins.
 * Third-party plugins can be added directly via `engine.registerPlugin(myPlugin)`.
 */
export function registerDefaultPlugins(engine: PhysicsEngine): void {
  // 1. Properties
  engine.registerPlugin(new MassPlugin());

  // 2. Forces & Interactions
  engine.registerPlugin(new GravityPlugin(-980));
  engine.registerPlugin(new CollisionPlugin());

  // 3. Scene Objects
  engine.registerPlugin(new GroundPlugin());

  // 4. Simulation Solvers (3 swappable modes)
  engine.registerPlugin(new ContinuousSolverPlugin());
  engine.registerPlugin(new GridSnapSolverPlugin());
  engine.registerPlugin(new CellularAutomatonSolverPlugin());

  // 5. Spawnable Shape / Entity Plugins
  engine.registerPlugin(new PixelPlugin());
  engine.registerPlugin(new SquarePlugin(5));
  engine.registerPlugin(new CirclePlugin(3));
}

export {
  MassPlugin,
  GravityPlugin,
  CollisionPlugin,
  GroundPlugin,
  PixelPlugin,
  SquarePlugin,
  CirclePlugin,
  ContinuousSolverPlugin,
  GridSnapSolverPlugin,
  CellularAutomatonSolverPlugin,
};
