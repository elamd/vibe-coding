import type { Node } from 'three/webgpu';

export type PluginCategory =
  | 'property'
  | 'force'
  | 'interaction'
  | 'solver'
  | 'shape'
  | 'scene-object';

export type SimulationModeId = 'continuous' | 'grid-snap' | 'cellular';

export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface WorldBounds {
  width: number;
  height: number;
  groundHeight: number;
}

export interface SpawnOptions {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  color?: RGBAColor;
  density?: number;
  bonded?: boolean;
}

export interface ShapeFootprintCell {
  /** Offset in virtual-pixel grid units from the shape center */
  gx: number;
  gy: number;
  /** Optional color override relative to shape base color */
  brightness?: number;
}

export interface ShapeVertex {
  /** Vertex position in virtual-pixel grid units relative to shape center (CCW order) */
  x: number;
  y: number;
}

export interface SpawnResult {
  pixelIndices: number[];
  bodyId: number;
}

export interface TSLComputeContext {
  /** Storage node for per-pixel world positions (vec2) */
  posStorage: unknown;
  /** Storage node for per-pixel velocities (vec2) */
  velStorage: unknown;
  /** Storage node for per-pixel render positions (vec2) */
  renderPosStorage: unknown;
  /** Storage node for per-pixel colors (vec4) */
  colorStorage: unknown;
  /** Storage node for per-pixel metadata: (mass, active, bodyId, speedGlow) */
  metaStorage: unknown;
  /** Uniforms shared across compute passes */
  uniforms: {
    uPixelSize: unknown;
    uGridSnap: unknown;
    uDt: unknown;
    uGravityY: unknown;
    uWorldWidth: unknown;
    uWorldHeight: unknown;
    uGroundHeight: unknown;
    uActiveCount: unknown;
    uTime: unknown;
  };
}

export interface PluginContext {
  readonly store: IPixelStore;
  readonly registry: IPluginRegistry;
  readonly bounds: WorldBounds;
  readonly virtualPixelSize: number;
  readonly activeSolverId: SimulationModeId;
  getPropertyValue(propertyId: string, pixelIndex: number): number;
  setPropertyValue(propertyId: string, pixelIndex: number, value: number): void;
}

/**
 * Base contract for every object in the plugin system.
 * Both core engine concepts (Pixel, Mass, Gravity, Ground, Solvers)
 * and third-party custom objects (Square, Circle, etc.) implement PluginObject.
 */
export interface PluginObject {
  readonly id: string;
  readonly name: string;
  readonly category: PluginCategory;
  readonly description: string;
  enabled: boolean;

  onRegister?(ctx: PluginContext): void;
  onUnregister?(ctx: PluginContext): void;
  onVirtualPixelSizeChange?(ctx: PluginContext, newSize: number, oldSize: number): void;
  onResize?(ctx: PluginContext, bounds: WorldBounds): void;

  /**
   * Optional Tier-1 (GPU) hook: plugins can attach a TSL compute node
   * operating on the shared GPU storage buffers.
   */
  createTSLComputeNode?(tslCtx: TSLComputeContext): Node | null;

  /**
   * Optional Tier-2 (CPU) hook: third-party plugins can execute pure TypeScript
   * per-frame logic without writing any shader code.
   */
  onStep?(ctx: PluginContext, dt: number): void;
}

/**
 * Property plugin (e.g., Mass, Restitution, Friction, Temperature).
 * Owns a typed per-pixel data channel in PixelStore.
 */
export interface PropertyPlugin extends PluginObject {
  readonly category: 'property';
  readonly defaultValue: number;
  computeForVirtualPixelSize?(virtualPixelSize: number, multiplier?: number): number;
}

/**
 * Force plugin (e.g., Gravity, Wind, Attractor).
 * Applies acceleration or forces to pixels and bonded bodies.
 */
export interface ForcePlugin extends PluginObject {
  readonly category: 'force';
  applyToPixel?(ctx: PluginContext, pixelIndex: number, dt: number): void;
  applyToBody?(ctx: PluginContext, body: BondedBody, dt: number): void;
  /** Optional gravity/force vector exposed for GPU TSL uniforms & CA solver */
  getForceVector?(): { x: number; y: number };
}

/**
 * Interaction plugin (e.g., Mass-weighted Solid Collision).
 * Resolves pixel-to-pixel, pixel-to-body, and boundary interactions.
 */
export interface InteractionPlugin extends PluginObject {
  readonly category: 'interaction';
  resolveInteractions(ctx: PluginContext, dt: number): void;
}

/**
 * Solver plugin (e.g., Continuous, Grid-Snap, Cellular Automaton).
 * Controls how a frame advances and how state converts on live mode switch.
 */
export interface SolverPlugin extends PluginObject {
  readonly category: 'solver';
  readonly modeId: SimulationModeId;
  readonly label: string;
  readonly snapVisualsToGrid: boolean;
  onEnterMode?(ctx: PluginContext, previousMode: SimulationModeId | null): void;
  onExitMode?(ctx: PluginContext, nextMode: SimulationModeId): void;
  step(ctx: PluginContext, dt: number): void;
}

/**
 * Shape / Entity plugin (e.g., Pixel, Square, Circle).
 * Spawns standalone virtual pixels or vertex-defined polygonal face objects.
 */
export interface ShapePlugin extends PluginObject {
  readonly category: 'shape';
  readonly hotkey?: string;
  readonly defaultColor: RGBAColor;
  /** Footprint cells in virtual-pixel units (used for pixel-based shapes & fallback preview) */
  getFootprint(): ShapeFootprintCell[];
  /** Optional CCW vertex polygon in virtual-pixel units for face-based composite shapes */
  getVertices?(): ShapeVertex[];
  spawn(ctx: PluginContext, options: SpawnOptions): SpawnResult;
}

/**
 * Static or dynamic scene object plugin (e.g., Ground Floor).
 */
export interface SceneObjectPlugin extends PluginObject {
  readonly category: 'scene-object';
  getBounds(world: WorldBounds): { x: number; y: number; width: number; height: number };
}

export interface BondedBody {
  id: number;
  pluginId: string;
  pixelIndices: number[];
  /** Local CCW vertex coordinates in virtual-pixel grid units (x0, y0, x1, y1, ...) */
  localOffsets: Float32Array;
  color: RGBAColor;
  density: number;
  /** Bounding radius in virtual-pixel grid units */
  boundingRadiusGrid: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  omega: number;
  totalMass: number;
  invMass: number;
  inertia: number;
  invInertia: number;
  restitution: number;
  friction: number;
  active: boolean;
}

export interface IPixelStore {
  readonly maxPixels: number;
  readonly activeCount: number;
  readonly highWaterMark: number;

  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly renderPos: Float32Array;
  readonly color: Float32Array;
  readonly meta: Float32Array;
  readonly active: Uint8Array;
  readonly bodyId: Int32Array;
  readonly density: Float32Array;
  readonly restitution: Float32Array;
  readonly friction: Float32Array;

  readonly bodies: Map<number, BondedBody>;

  registerChannel(name: string, defaultValue: number): Float32Array;
  getChannel(name: string): Float32Array | undefined;
  allocatePixel(params: {
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    mass: number;
    density?: number;
    restitution?: number;
    friction?: number;
    color: RGBAColor;
    bodyId?: number;
  }): number;
  freePixel(index: number): void;
  createBondedBody(params: {
    pluginId: string;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    localOffsets: Float32Array;
    pixelIndices: number[];
    virtualPixelSize: number;
    color: RGBAColor;
    density?: number;
    restitution?: number;
    friction?: number;
  }): BondedBody;
  recomputeBodyMassProperties(body: BondedBody, virtualPixelSize: number): void;
  dissolveAllBodies(): void;
  clear(): void;
  countVisible(bounds: WorldBounds, virtualPixelSize: number): number;
  markDirty(): void;
  consumeDirty(): boolean;
}

export interface IPluginRegistry {
  register<T extends PluginObject>(plugin: T): T;
  unregister(id: string): boolean;
  get<T extends PluginObject = PluginObject>(id: string): T | undefined;
  getAll(): PluginObject[];
  getByCategory<T extends PluginObject>(category: PluginCategory): T[];
  getProperties(): PropertyPlugin[];
  getForces(): ForcePlugin[];
  getInteractions(): InteractionPlugin[];
  getSolvers(): SolverPlugin[];
  getShapes(): ShapePlugin[];
  getSceneObjects(): SceneObjectPlugin[];
}
