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
 * Example Custom Shape Plugin: Vertex-Face Circle.
 * Built solely from its perimeter vertices (no filled interior pixels),
 * rendered as a triangulated CRT phosphor face that rolls and bounces.
 */
export class CirclePlugin implements ShapePlugin {
  readonly id = 'circle';
  readonly name = 'Circle';
  readonly category = 'shape' as const;
  readonly description = 'Perimeter-vertex circle face body that rolls, collides, and bounces.';
  readonly hotkey = '3';
  readonly defaultColor: RGBAColor = { r: 0.56, g: 1.0, b: 0.36, a: 1.0 }; // Phosphor lime
  enabled = true;

  private readonly vertices: ShapeVertex[];

  constructor(radiusInVirtualPixels = 3, segments = 20) {
    const r = Math.max(1, radiusInVirtualPixels);
    const count = Math.max(8, Math.round(segments));
    const verts: ShapeVertex[] = [];

    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2;
      verts.push({
        x: Math.cos(theta) * r,
        y: Math.sin(theta) * r,
      });
    }
    this.vertices = verts;
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
        defaultDensity: 1.15,
        defaultRestitution: 0.42,
        defaultFriction: 0.4,
        defaultBonded: true,
      },
      options,
    );
  }
}
