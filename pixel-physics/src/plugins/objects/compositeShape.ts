import type {
  PluginContext,
  PropertyPlugin,
  RGBAColor,
  ShapeVertex,
  SpawnOptions,
  SpawnResult,
} from '../../engine/types.ts';

/**
 * Shared helper for custom polygonal shape plugins (Square, Circle, or user-defined shapes).
 * Instead of filling the interior with pixels, allocates only the polygon's CCW vertices
 * and creates a bonded rigid-ish face body whose mass & inertia are derived directly
 * from the polygon's vertex geometry and the active virtual pixel size N.
 */
export function spawnVertexFaceShape(
  ctx: PluginContext,
  params: {
    pluginId: string;
    vertices: ShapeVertex[];
    defaultColor: RGBAColor;
    defaultDensity?: number;
    defaultRestitution?: number;
    defaultFriction?: number;
    defaultBonded?: boolean;
  },
  options: SpawnOptions,
): SpawnResult {
  const { store, registry, bounds, virtualPixelSize } = ctx;
  const massPlugin = registry.get<PropertyPlugin>('mass');
  const density = options.density ?? params.defaultDensity ?? 1.25;
  const vertexMass = massPlugin?.computeForVirtualPixelSize
    ? massPlugin.computeForVirtualPixelSize(virtualPixelSize, density)
    : density * virtualPixelSize * virtualPixelSize;

  const baseColor = options.color ?? params.defaultColor;
  const bonded = options.bonded ?? params.defaultBonded ?? true;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  for (const v of params.vertices) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
  }

  const centerX = Math.min(
    bounds.width - maxX * virtualPixelSize,
    Math.max(-minX * virtualPixelSize, options.x),
  );
  const centerY = Math.max(bounds.groundHeight - minY * virtualPixelSize, options.y);

  const pixelIndices: number[] = [];
  const localOffsets = new Float32Array(params.vertices.length * 2);

  for (let i = 0; i < params.vertices.length; i++) {
    const v = params.vertices[i]!;
    const idx = store.allocatePixel({
      x: centerX + v.x * virtualPixelSize,
      y: centerY + v.y * virtualPixelSize,
      vx: options.vx ?? 0,
      vy: options.vy ?? 0,
      mass: vertexMass,
      density,
      restitution: params.defaultRestitution ?? 0.24,
      friction: params.defaultFriction ?? 0.52,
      color: baseColor,
      bodyId: -1,
    });

    if (idx === -1) break;
    pixelIndices.push(idx);
    localOffsets[i * 2] = v.x;
    localOffsets[i * 2 + 1] = v.y;
  }

  if (pixelIndices.length === 0) {
    return { pixelIndices: [], bodyId: -1 };
  }

  if (bonded && pixelIndices.length >= 3) {
    const trimmedOffsets =
      pixelIndices.length === params.vertices.length
        ? localOffsets
        : localOffsets.slice(0, pixelIndices.length * 2);

    const body = store.createBondedBody({
      pluginId: params.pluginId,
      x: centerX,
      y: centerY,
      vx: options.vx ?? 0,
      vy: options.vy ?? 0,
      localOffsets: trimmedOffsets,
      pixelIndices,
      virtualPixelSize,
      color: baseColor,
      density,
      restitution: params.defaultRestitution ?? 0.24,
      friction: params.defaultFriction ?? 0.52,
    });

    return { pixelIndices, bodyId: body.id };
  }

  return { pixelIndices, bodyId: -1 };
}
