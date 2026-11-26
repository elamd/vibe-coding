import { DEFAULT_MAX_PIXELS, PixelStore } from './PixelStore.ts';
import { PluginRegistry } from './PluginRegistry.ts';
import type {
  PluginContext,
  PluginObject,
  ShapePlugin,
  SimulationModeId,
  SolverPlugin,
  SpawnOptions,
  SpawnResult,
  WorldBounds,
} from './types.ts';

export interface EngineOptions {
  width: number;
  height: number;
  groundHeight?: number;
  virtualPixelSize?: number;
  maxPixels?: number;
}

export class PhysicsEngine {
  readonly store: PixelStore;
  readonly registry: PluginRegistry;

  private bounds: WorldBounds;
  private _virtualPixelSize: number;
  private _activeSolverId: SimulationModeId = 'continuous';
  private _activeShapeId = 'pixel';
  private _elapsedTime = 0;

  private onPluginChangeListeners = new Set<() => void>();

  constructor(options: EngineOptions) {
    this.store = new PixelStore(options.maxPixels ?? DEFAULT_MAX_PIXELS);
    this.bounds = {
      width: Math.max(64, options.width),
      height: Math.max(64, options.height),
      groundHeight: options.groundHeight ?? 28,
    };
    this._virtualPixelSize = clampVirtualPixelSize(options.virtualPixelSize ?? 8);
    this.registry = new PluginRegistry(() => this.createContext());
  }

  get virtualPixelSize(): number {
    return this._virtualPixelSize;
  }

  get activeSolverId(): SimulationModeId {
    return this._activeSolverId;
  }

  get activeShapeId(): string {
    return this._activeShapeId;
  }

  get worldBounds(): WorldBounds {
    return { ...this.bounds };
  }

  get elapsedTime(): number {
    return this._elapsedTime;
  }

  onPluginsChanged(listener: () => void): () => void {
    this.onPluginChangeListeners.add(listener);
    return () => this.onPluginChangeListeners.delete(listener);
  }

  registerPlugin<T extends PluginObject>(plugin: T): T {
    const registered = this.registry.register(plugin);
    for (const listener of this.onPluginChangeListeners) {
      listener();
    }
    return registered;
  }

  createContext(): PluginContext {
    return {
      store: this.store,
      registry: this.registry,
      bounds: this.worldBounds,
      virtualPixelSize: this._virtualPixelSize,
      activeSolverId: this._activeSolverId,
      getPropertyValue: (propertyId: string, pixelIndex: number): number => {
        const ch = this.store.getChannel(propertyId);
        return ch ? ch[pixelIndex]! : 0;
      },
      setPropertyValue: (propertyId: string, pixelIndex: number, value: number): void => {
        const ch = this.store.getChannel(propertyId);
        if (ch) {
          ch[pixelIndex] = value;
          if (propertyId === 'mass') {
            this.store.meta[pixelIndex * 4] = value;
          }
        }
      },
    };
  }

  getActiveSolver(): SolverPlugin | undefined {
    return this.registry.getSolvers().find((s) => s.modeId === this._activeSolverId);
  }

  getActiveShape(): ShapePlugin | undefined {
    return this.registry.get<ShapePlugin>(this._activeShapeId);
  }

  setActiveShape(shapeId: string): boolean {
    const shape = this.registry.get<ShapePlugin>(shapeId);
    if (!shape || shape.category !== 'shape') return false;
    this._activeShapeId = shapeId;
    return true;
  }

  setSimulationMode(modeId: SimulationModeId): boolean {
    if (this._activeSolverId === modeId) return true;
    const nextSolver = this.registry.getSolvers().find((s) => s.modeId === modeId);
    if (!nextSolver) return false;

    const prevSolver = this.getActiveSolver();
    const prevMode = this._activeSolverId;

    const ctxBefore = this.createContext();
    prevSolver?.onExitMode?.(ctxBefore, modeId);

    this._activeSolverId = modeId;
    const ctxAfter = this.createContext();
    nextSolver.onEnterMode?.(ctxAfter, prevMode);

    this.store.syncPackedMetadata(
      nextSolver.snapVisualsToGrid,
      this._virtualPixelSize,
      this.bounds.groundHeight,
    );
    return true;
  }

  setVirtualPixelSize(nextSize: number): number {
    const clamped = clampVirtualPixelSize(nextSize);
    if (clamped === this._virtualPixelSize) return clamped;

    const oldSize = this._virtualPixelSize;
    this._virtualPixelSize = clamped;

    const ctx = this.createContext();

    // Clamp existing pixel positions cleanly inside bounds & above ground floor
    const half = clamped * 0.5;
    for (let i = 0; i < this.store.highWaterMark; i++) {
      if (this.store.active[i] === 0) continue;
      const i2 = i * 2;
      this.store.pos[i2] = Math.min(
        this.bounds.width - half,
        Math.max(half, this.store.pos[i2]!),
      );
      this.store.pos[i2 + 1] = Math.max(
        this.bounds.groundHeight + half,
        this.store.pos[i2 + 1]!,
      );
    }

    // Notify all plugins (e.g., Mass recalculates N^2 mass, CA solver rebuilds grid)
    for (const plugin of this.registry.getAll()) {
      plugin.onVirtualPixelSizeChange?.(ctx, clamped, oldSize);
    }

    // Recompute bonded body mass/inertia and project vertices to new virtual-pixel spacing
    for (const body of this.store.bodies.values()) {
      this.store.recomputeBodyMassProperties(body, clamped);
      const cos = Math.cos(body.angle);
      const sin = Math.sin(body.angle);
      let minY = Infinity;
      let minX = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < body.pixelIndices.length; i++) {
        const ox = body.localOffsets[i * 2]! * clamped;
        const oy = body.localOffsets[i * 2 + 1]! * clamped;
        const wx = body.x + ox * cos - oy * sin;
        const wy = body.y + ox * sin + oy * cos;
        if (wy < minY) minY = wy;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
      }
      if (minY < this.bounds.groundHeight) {
        body.y += this.bounds.groundHeight - minY;
      }
      if (minX < 0) {
        body.x += -minX;
      } else if (maxX > this.bounds.width) {
        body.x -= maxX - this.bounds.width;
      }
      for (let i = 0; i < body.pixelIndices.length; i++) {
        const idx = body.pixelIndices[i]!;
        const ox = body.localOffsets[i * 2]! * clamped;
        const oy = body.localOffsets[i * 2 + 1]! * clamped;
        this.store.pos[idx * 2] = body.x + ox * cos - oy * sin;
        this.store.pos[idx * 2 + 1] = body.y + ox * sin + oy * cos;
      }
    }

    const solver = this.getActiveSolver();
    this.store.syncPackedMetadata(
      solver?.snapVisualsToGrid ?? false,
      this._virtualPixelSize,
      this.bounds.groundHeight,
    );
    return clamped;
  }

  resize(width: number, height: number): void {
    this.bounds = {
      width: Math.max(64, width),
      height: Math.max(64, height),
      groundHeight: this.bounds.groundHeight,
    };
    const half = this._virtualPixelSize * 0.5;
    for (let i = 0; i < this.store.highWaterMark; i++) {
      if (this.store.active[i] === 0) continue;
      this.store.pos[i * 2] = Math.min(
        this.bounds.width - half,
        Math.max(half, this.store.pos[i * 2]!),
      );
      this.store.pos[i * 2 + 1] = Math.max(
        this.bounds.groundHeight + half,
        this.store.pos[i * 2 + 1]!,
      );
    }

    const ctx = this.createContext();
    for (const plugin of this.registry.getAll()) {
      plugin.onResize?.(ctx, this.worldBounds);
    }
    this.store.markDirty();
  }

  spawnActiveShape(options: SpawnOptions): SpawnResult {
    return this.spawnShape(this._activeShapeId, options);
  }

  spawnShape(shapeId: string, options: SpawnOptions): SpawnResult {
    const shape = this.registry.get<ShapePlugin>(shapeId);
    if (!shape || shape.category !== 'shape' || !shape.enabled) {
      return { pixelIndices: [], bodyId: -1 };
    }
    const ctx = this.createContext();
    const half = this._virtualPixelSize * 0.5;
    const clampedOptions: SpawnOptions = {
      ...options,
      x: Math.min(this.bounds.width - half, Math.max(half, options.x)),
      y: Math.max(this.bounds.groundHeight + half, options.y),
    };

    const result = shape.spawn(ctx, clampedOptions);

    // If we are in Cellular Automaton mode, bonded shapes dissolve directly into grid cells
    if (this._activeSolverId === 'cellular' && result.bodyId !== -1) {
      this.store.dissolveAllBodies();
      const caSolver = this.getActiveSolver();
      caSolver?.onEnterMode?.(this.createContext(), 'cellular');
    }

    const solver = this.getActiveSolver();
    this.store.syncPackedMetadata(
      solver?.snapVisualsToGrid ?? false,
      this._virtualPixelSize,
      this.bounds.groundHeight,
    );
    return result;
  }

  step(rawDt: number): void {
    // Cap dt to prevent physics tunneling on tab switches
    const dt = Math.min(1 / 30, Math.max(1 / 240, rawDt));
    this._elapsedTime += dt;

    const ctx = this.createContext();
    const solver = this.getActiveSolver();

    if (solver && solver.enabled) {
      solver.step(ctx, dt);
    }

    // Run Tier-2 (CPU) custom plugin per-step hooks (non-solver plugins)
    for (const plugin of this.registry.getAll()) {
      if (!plugin.enabled || plugin.category === 'solver') continue;
      plugin.onStep?.(ctx, dt);
    }

    this.store.syncPackedMetadata(
      solver?.snapVisualsToGrid ?? false,
      this._virtualPixelSize,
      this.bounds.groundHeight,
    );
  }

  clearDynamicObjects(): void {
    this.store.clear();
    // Re-sync solver internal structures (e.g. CA grid)
    const solver = this.getActiveSolver();
    if (solver && this._activeSolverId === 'cellular') {
      solver.onEnterMode?.(this.createContext(), 'cellular');
    }
  }

  getVisiblePixelCount(): number {
    return this.store.countVisible(this.bounds, this._virtualPixelSize);
  }

  getGravityY(): number {
    for (const force of this.registry.getForces()) {
      if (force.enabled && force.id === 'gravity' && force.getForceVector) {
        return force.getForceVector().y;
      }
    }
    return 0;
  }
}

export function clampVirtualPixelSize(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.min(64, Math.max(1, Math.round(value)));
}
