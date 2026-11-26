import type {
  PluginContext,
  RGBAColor,
  ShapeFootprintCell,
  ShapePlugin,
  ShapeVertex,
  SpawnOptions,
  SpawnResult,
} from '../../engine/types.ts';
import { spawnVertexFaceShape } from './compositeShape.ts';

/**
 * Example Custom Shape Plugin: Vertex-Face Square.
 * Built solely from its 4 corner vertices (no filled interior pixels),
 * rendered as a triangulated CRT phosphor face with glowing edges.
 */
export class SquarePlugin implements ShapePlugin {
  readonly id = 'square';
  readonly name = 'Square';
  readonly category = 'shape' as const;
  readonly description = '4-vertex square face body with rigid rotation, mass, and edge collisions.';
  readonly hotkey = '2';
  readonly defaultColor: RGBAColor = { r: 1.0, g: 0.76, b: 0.22, a: 1.0 }; // Phosphor amber
  enabled = true;

  private readonly vertices: ShapeVertex[];

  constructor(sideInVirtualPixels = 5) {
    const h = Math.max(1, sideInVirtualPixels) * 0.5;
    // Counter-clockwise 4 corner vertices
    this.vertices = [
      { x: -h, y: -h },
      { x: h, y: -h },
      { x: h, y: h },
      { x: -h, y: h },
    ];
  }

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
        defaultDensity: 1.35,
        defaultRestitution: 0.22,
        defaultFriction: 0.58,
        defaultBonded: true,
      },
      options,
    );
  }
}
