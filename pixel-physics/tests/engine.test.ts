import { describe, expect, test } from 'bun:test';
import { PhysicsEngine } from '../src/engine/PhysicsEngine.ts';
import { TSLComputePipeline } from '../src/engine/TSLComputePipeline.ts';
import type { ShapePlugin, ShapeVertex } from '../src/engine/types.ts';
import { registerDefaultPlugins } from '../src/plugins/index.ts';
import { spawnVertexFaceShape } from '../src/plugins/objects/compositeShape.ts';

function createEngine() {
  const engine = new PhysicsEngine({
    width: 800,
    height: 600,
    groundHeight: 28,
    virtualPixelSize: 8,
  });
  registerDefaultPlugins(engine);
  return engine;
}

describe('Pixel Physics Engine', () => {
  test('registers core plugins, 3 solvers, and example custom shapes', () => {
    const engine = createEngine();
    expect(engine.registry.get('mass')).toBeDefined();
    expect(engine.registry.get('gravity')).toBeDefined();
    expect(engine.registry.get('collision')).toBeDefined();
    expect(engine.registry.get('ground')).toBeDefined();
    expect(engine.registry.getSolvers().map((s) => s.modeId)).toEqual([
      'continuous',
      'grid-snap',
      'cellular',
    ]);
    expect(engine.registry.getShapes().map((s) => s.id)).toEqual(['pixel', 'square', 'circle']);
  });

  test('pixel falls under gravity and lands cleanly on the ground floor', () => {
    const engine = createEngine();
    const res = engine.spawnShape('pixel', { x: 400, y: 200, vx: 0, vy: 0 });
    expect(res.pixelIndices.length).toBe(1);
    const idx = res.pixelIndices[0]!;

    expect(engine.store.getChannel('mass')![idx]).toBe(64);

    for (let i = 0; i < 120; i++) {
      engine.step(1 / 60);
    }

    const expectedFloorY = 28 + 4; // groundHeight + virtualPixelSize/2
    expect(engine.store.pos[idx * 2 + 1]!).toBeCloseTo(expectedFloorY, 0);
    expect(engine.getVisiblePixelCount()).toBe(1);
  });

  test('heavier pixel transfers greater momentum to lighter pixel on collision', () => {
    const engine = createEngine();
    const heavy = engine.spawnShape('pixel', { x: 200, y: 300, vx: 180, vy: 0, density: 4.0 });
    const light = engine.spawnShape('pixel', { x: 207, y: 300, vx: 0, vy: 0, density: 1.0 });

    const hIdx = heavy.pixelIndices[0]!;
    const lIdx = light.pixelIndices[0]!;
    expect(engine.store.getChannel('mass')![hIdx]).toBe(256);
    expect(engine.store.getChannel('mass')![lIdx]).toBe(64);

    engine.step(1 / 60);

    expect(engine.store.vel[lIdx * 2]!).toBeGreaterThan(100);
    expect(engine.store.vel[hIdx * 2]!).toBeGreaterThan(0);
  });

  test('changing virtual pixel resolution updates existing mass and polygon bounds live in-place', () => {
    const engine = createEngine();
    const res = engine.spawnShape('pixel', { x: 400, y: 120, vx: 0, vy: 0, density: 1.0 });
    const idx = res.pixelIndices[0]!;
    const sq = engine.spawnShape('square', { x: 250, y: 120 });
    const sqBody = engine.store.bodies.get(sq.bodyId)!;
    const massAt8 = sqBody.totalMass;

    expect(engine.store.getChannel('mass')![idx]).toBe(64);

    engine.setVirtualPixelSize(16);
    expect(engine.virtualPixelSize).toBe(16);
    expect(engine.store.getChannel('mass')![idx]).toBe(256);
    // Area scales by 4× when N doubles from 8 to 16
    expect(sqBody.totalMass).toBeCloseTo(massAt8 * 4, 1);

    engine.setVirtualPixelSize(4);
    expect(engine.virtualPixelSize).toBe(4);
    expect(engine.store.getChannel('mass')![idx]).toBe(16);
    expect(sqBody.totalMass).toBeCloseTo(massAt8 * 0.25, 1);
  });

  test('Square and Circle use only vertices (no interior pixel fill) and convert live across all 3 modes', () => {
    const engine = createEngine();
    const sq = engine.spawnShape('square', { x: 300, y: 260 });
    const ci = engine.spawnShape('circle', { x: 500, y: 260 });

    expect(sq.bodyId).toBeGreaterThan(0);
    expect(ci.bodyId).toBeGreaterThan(0);
    // 4 corner vertices for Square, 20 perimeter vertices for Circle — zero interior pixel fill
    expect(sq.pixelIndices.length).toBe(4);
    expect(ci.pixelIndices.length).toBe(20);
    expect(engine.store.bodies.size).toBe(2);

    for (let i = 0; i < 60; i++) {
      engine.step(1 / 60);
    }
    expect(engine.store.bodies.size).toBe(2);
    const totalVertices = sq.pixelIndices.length + ci.pixelIndices.length;
    expect(engine.getVisiblePixelCount()).toBe(totalVertices);

    // Switch live to Grid-Snap — keeps bodies
    engine.setSimulationMode('grid-snap');
    engine.step(1 / 60);
    expect(engine.store.bodies.size).toBe(2);
    expect(engine.getVisiblePixelCount()).toBe(totalVertices);

    // Switch live to Cellular Automaton — dissolves vertex bodies & preserves every vertex pixel
    engine.setSimulationMode('cellular');
    expect(engine.store.bodies.size).toBe(0);
    expect(engine.getVisiblePixelCount()).toBe(totalVertices);

    for (let i = 0; i < 60; i++) {
      engine.step(1 / 60);
    }
    expect(engine.getVisiblePixelCount()).toBe(totalVertices);

    // Switch back to Continuous seamlessly
    engine.setSimulationMode('continuous');
    engine.step(1 / 60);
    expect(engine.getVisiblePixelCount()).toBe(totalVertices);

    engine.clearDynamicObjects();
    expect(engine.getVisiblePixelCount()).toBe(0);
    expect(engine.store.bodies.size).toBe(0);
  });

  test('loose pixel collides with the flat mid-edge of a 4-vertex Square without passing through', () => {
    const engine = createEngine();
    // Place a Square resting on the ground (center y = groundHeight + 2.5 * 8 = 48, top edge at y = 68)
    const sq = engine.spawnShape('square', { x: 400, y: 48, vx: 0, vy: 0 });
    const body = engine.store.bodies.get(sq.bodyId)!;

    // Drop a loose pixel straight down onto the exact center of the flat top edge (between corners)
    const px = engine.spawnShape('pixel', { x: 400, y: 110, vx: 0, vy: 0 });
    const pIdx = px.pixelIndices[0]!;

    for (let i = 0; i < 120; i++) {
      engine.step(1 / 60);
    }

    const squareTopY = body.y + 2.5 * engine.virtualPixelSize;
    // Pixel rests on top of the Square's face edge rather than falling through to the ground
    expect(engine.store.pos[pIdx * 2 + 1]!).toBeGreaterThanOrEqual(squareTopY - 2);
  });

  test('two vertex-face Squares stack cleanly via SAT collision', () => {
    const engine = createEngine();
    const bottom = engine.spawnShape('square', { x: 400, y: 48, vx: 0, vy: 0 });
    const top = engine.spawnShape('square', { x: 400, y: 110, vx: 0, vy: 0 });
    const bBody = engine.store.bodies.get(bottom.bodyId)!;
    const tBody = engine.store.bodies.get(top.bodyId)!;

    for (let i = 0; i < 150; i++) {
      engine.step(1 / 60);
    }

    // Bottom square rests flush on ground (y ≈ 28 + 20 = 48); top square rests above it (y ≈ 88)
    expect(bBody.y).toBeCloseTo(48, 0);
    expect(tBody.y).toBeGreaterThan(80);
  });

  test('third-party custom vertex-face shape plugin plugs in cleanly', () => {
    const engine = createEngine();
    const vertices: ShapeVertex[] = [
      { x: -2.5, y: -2 },
      { x: 2.5, y: -2 },
      { x: 0, y: 2.5 },
    ];
    const trianglePlugin: ShapePlugin = {
      id: 'triangle',
      name: 'Triangle',
      category: 'shape',
      description: '3-vertex triangle face',
      hotkey: '4',
      defaultColor: { r: 1, g: 0.4, b: 0.8, a: 1 },
      enabled: true,
      getVertices: () => vertices,
      getFootprint: () => vertices.map((v) => ({ gx: v.x, gy: v.y })),
      spawn: (ctx, opts) =>
        spawnVertexFaceShape(
          ctx,
          {
            pluginId: 'triangle',
            vertices,
            defaultColor: trianglePlugin.defaultColor,
          },
          opts,
        ),
    };

    engine.registerPlugin(trianglePlugin);
    expect(engine.setActiveShape('triangle')).toBe(true);
    const spawned = engine.spawnActiveShape({ x: 400, y: 300 });
    expect(spawned.pixelIndices.length).toBe(3);
    expect(spawned.bodyId).toBeGreaterThan(0);
  });

  test('TSLComputePipeline builds core and Tier-1 plugin compute nodes cleanly', () => {
    const engine = createEngine();
    const pipeline = new TSLComputePipeline(engine.store);
    pipeline.rebuildPluginPasses(engine.registry.getAll());
    const passes = pipeline.getComputePasses();
    expect(passes.length).toBe(2);
    expect(passes.every((p) => p.type === 'ComputeNode')).toBe(true);
  });
});
