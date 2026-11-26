import type {
  PluginContext,
  PropertyPlugin,
  RGBAColor,
  ShapeFootprintCell,
  ShapePlugin,
  SpawnOptions,
  SpawnResult,
} from '../../engine/types.ts';

/**
 * Base Pixel Object Plugin.
 * Spawns a single virtual pixel (N×N screen pixels) with mass computed via MassPlugin.
 */
export class PixelPlugin implements ShapePlugin {
  readonly id = 'pixel';
  readonly name = 'Pixel';
  readonly category = 'shape' as const;
  readonly description = 'Single virtual pixel object affected by gravity, mass, and solid collisions.';
  readonly hotkey = '1';
  readonly defaultColor: RGBAColor = { r: 0.28, g: 0.96, b: 0.88, a: 1.0 };
  enabled = true;

  getFootprint(): ShapeFootprintCell[] {
    return [{ gx: 0, gy: 0, brightness: 1.0 }];
  }

  spawn(ctx: PluginContext, options: SpawnOptions): SpawnResult {
    const { store, registry, virtualPixelSize } = ctx;
    const massPlugin = registry.get<PropertyPlugin>('mass');
    const density = options.density ?? 1.0;
    const mass = massPlugin?.computeForVirtualPixelSize
      ? massPlugin.computeForVirtualPixelSize(virtualPixelSize, density)
      : density * virtualPixelSize * virtualPixelSize;

    // Subtle phosphor hue/luminance variation so stacked pixels stay visually distinct
    const jitter = (Math.random() - 0.5) * 0.14;
    const base = options.color ?? this.defaultColor;
    const color: RGBAColor = {
      r: Math.min(1, Math.max(0.08, base.r + jitter * 0.4)),
      g: Math.min(1, Math.max(0.25, base.g + jitter)),
      b: Math.min(1, Math.max(0.25, base.b - jitter * 0.5)),
      a: base.a,
    };

    const idx = store.allocatePixel({
      x: options.x,
      y: options.y,
      vx: options.vx ?? (Math.random() - 0.5) * 14,
      vy: options.vy ?? 0,
      mass,
      density,
      restitution: 0.3,
      friction: 0.48,
      color,
      bodyId: -1,
    });

    return {
      pixelIndices: idx !== -1 ? [idx] : [],
      bodyId: -1,
    };
  }
}
