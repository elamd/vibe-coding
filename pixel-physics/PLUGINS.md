# Writing Plugins for Pixel Physics

Everything in Pixel Physics—`Mass`, `Gravity`, `Collision`, `Ground`, `Pixel`, `Square`, `Circle`, and each of the three simulation `Solvers`—is built on one unified `PluginObject` interface in [types.ts](src/engine/types.ts).

## Two-Tier Architecture

1. **Tier 2 (Pure TypeScript / CPU)**: Implement `ShapePlugin`, `ForcePlugin`, `PropertyPlugin`, `InteractionPlugin`, or `SolverPlugin` in plain TypeScript. No shader code is required—state syncs automatically with the GPU buffers.
2. **Tier 1 (GPU TSL Compute)**: Optionally implement `createTSLComputeNode(tslCtx)` on any plugin to attach a Three.js Shading Language (`three/tsl`) compute pass directly to the shared GPU storage buffers (`posStorage`, `velStorage`, `renderPosStorage`, `colorStorage`, `metaStorage`).

## Example: Creating a Custom Vertex-Face Shape Plugin

Composite shapes do **not** fill their interiors with pixels—define counter-clockwise (`CCW`) vertices in virtual-pixel grid units, and the engine builds a triangulated glowing CRT face mesh + full polygon edge/SAT physics from those vertices automatically:

```ts
import type {
  PluginContext,
  ShapeFootprintCell,
  ShapePlugin,
  ShapeVertex,
  SpawnOptions,
  SpawnResult,
} from '../engine/types.ts';
import { spawnVertexFaceShape } from './objects/compositeShape.ts';

export class TrianglePlugin implements ShapePlugin {
  readonly id = 'triangle';
  readonly name = 'Triangle';
  readonly category = 'shape' as const;
  readonly description = '3-vertex triangular face body.';
  readonly hotkey = '4';
  readonly defaultColor = { r: 1.0, g: 0.35, b: 0.72, a: 1.0 };
  enabled = true;

  // Counter-clockwise vertices in virtual-pixel grid units
  private readonly vertices: ShapeVertex[] = [
    { x: -2.5, y: -2.0 },
    { x: 2.5, y: -2.0 },
    { x: 0.0, y: 2.5 },
  ];

  getVertices(): ShapeVertex[] {
    return this.vertices;
  }

  getFootprint(): ShapeFootprintCell[] {
    return this.vertices.map((v) => ({ gx: v.x, gy: v.y }));
  }

  spawn(ctx: PluginContext, options: SpawnOptions): SpawnResult {
    return spawnVertexFaceShape(
      ctx,
      {
        pluginId: this.id,
        vertices: this.vertices,
        defaultColor: this.defaultColor,
        defaultBonded: true,
      },
      options,
    );
  }
}
```

Then register it in [src/plugins/index.ts](src/plugins/index.ts):

```ts
engine.registerPlugin(new TrianglePlugin());
```

The HUD automatically picks up any registered `ShapePlugin` button and hotkey, renders its vertex outline in the reticle, triangulates its glowing CRT face from its vertices, and computes its mass/inertia from the active `N×N` virtual pixel resolution.
