import { StorageInstancedBufferAttribute } from 'three/webgpu';
import {
  Fn,
  If,
  clamp,
  float,
  floor,
  instanceIndex,
  length,
  max,
  storage,
  uniform,
  vec2,
} from 'three/tsl';
import type { ComputeNode, Node } from 'three/webgpu';
import type { PixelStore } from './PixelStore.ts';
import type { PluginObject, TSLComputeContext, WorldBounds } from './types.ts';

/**
 * Bridges PixelStore's typed arrays with Three.js StorageBufferAttributes
 * and executes GPU TSL compute shaders for core physics visual/grid-snap
 * transforms and registered Tier-1 TSL plugin compute passes.
 */
export class TSLComputePipeline {
  readonly posAttribute: StorageInstancedBufferAttribute;
  readonly velAttribute: StorageInstancedBufferAttribute;
  readonly renderPosAttribute: StorageInstancedBufferAttribute;
  readonly colorAttribute: StorageInstancedBufferAttribute;
  readonly metaAttribute: StorageInstancedBufferAttribute;

  readonly posStorage: ReturnType<typeof storage>;
  readonly velStorage: ReturnType<typeof storage>;
  readonly renderPosStorage: ReturnType<typeof storage>;
  readonly colorStorage: ReturnType<typeof storage>;
  readonly metaStorage: ReturnType<typeof storage>;

  readonly uPixelSize = uniform(8.0);
  readonly uGridSnap = uniform(0.0);
  readonly uDt = uniform(1 / 60);
  readonly uGravityY = uniform(-980.0);
  readonly uWorldWidth = uniform(1280.0);
  readonly uWorldHeight = uniform(720.0);
  readonly uGroundHeight = uniform(28.0);
  readonly uActiveCount = uniform(0.0);
  readonly uTime = uniform(0.0);

  private readonly maxPixels: number;
  private readonly coreRenderCompute: ComputeNode;
  private pluginComputeNodes: ComputeNode[] = [];

  constructor(store: PixelStore) {
    this.maxPixels = store.maxPixels;

    this.posAttribute = new StorageInstancedBufferAttribute(store.pos, 2);
    this.velAttribute = new StorageInstancedBufferAttribute(store.vel, 2);
    this.renderPosAttribute = new StorageInstancedBufferAttribute(store.renderPos, 2);
    this.colorAttribute = new StorageInstancedBufferAttribute(store.color, 4);
    this.metaAttribute = new StorageInstancedBufferAttribute(store.meta, 4);

    this.posStorage = storage(this.posAttribute, 'vec2', this.maxPixels);
    this.velStorage = storage(this.velAttribute, 'vec2', this.maxPixels);
    this.renderPosStorage = storage(this.renderPosAttribute, 'vec2', this.maxPixels);
    this.colorStorage = storage(this.colorAttribute, 'vec4', this.maxPixels);
    this.metaStorage = storage(this.metaAttribute, 'vec4', this.maxPixels);

    // Core GPU TSL compute kernel:
    // Reads CPU/GPU-synced particle positions & velocities, computes grid-snapped
    // render coordinates in Hybrid/CA modes, clamps within viewport/ground bounds,
    // and updates kinetic phosphor glow intensity in meta.w on the GPU.
    const computeFn = Fn(() => {
      const idx = instanceIndex;
      const metaVal = this.metaStorage.element(idx);
      const isActive = metaVal.y;

      If(isActive.greaterThan(0.5), () => {
        const pos = this.posStorage.element(idx);
        const vel = this.velStorage.element(idx);
        const half = this.uPixelSize.mul(0.5);

        const rawX = clamp(pos.x, half, this.uWorldWidth.sub(half));
        const rawY = max(pos.y, this.uGroundHeight.add(half));

        const snappedX = floor(rawX.div(this.uPixelSize)).mul(this.uPixelSize).add(half);
        const snappedY = this.uGroundHeight.add(
          max(float(0.0), floor(rawY.sub(this.uGroundHeight).div(this.uPixelSize)))
            .mul(this.uPixelSize)
            .add(half),
        );

        const finalPos = this.uGridSnap.greaterThan(0.5).select(vec2(snappedX, snappedY), vec2(rawX, rawY));
        this.renderPosStorage.element(idx).assign(finalPos);

        const speedGlow = clamp(length(vel).div(750.0), 0.0, 1.0);
        this.metaStorage.element(idx).w.assign(speedGlow);
      });
    });

    this.coreRenderCompute = computeFn().compute(this.maxPixels);
  }

  getContext(): TSLComputeContext {
    return {
      posStorage: this.posStorage,
      velStorage: this.velStorage,
      renderPosStorage: this.renderPosStorage,
      colorStorage: this.colorStorage,
      metaStorage: this.metaStorage,
      uniforms: {
        uPixelSize: this.uPixelSize,
        uGridSnap: this.uGridSnap,
        uDt: this.uDt,
        uGravityY: this.uGravityY,
        uWorldWidth: this.uWorldWidth,
        uWorldHeight: this.uWorldHeight,
        uGroundHeight: this.uGroundHeight,
        uActiveCount: this.uActiveCount,
        uTime: this.uTime,
      },
    };
  }

  /**
   * Rebuilds the list of plugin-supplied GPU TSL compute passes whenever
   * plugins are registered or toggled.
   */
  rebuildPluginPasses(plugins: PluginObject[]): void {
    const ctx = this.getContext();
    const nodes: ComputeNode[] = [];
    for (const plugin of plugins) {
      if (!plugin.enabled || !plugin.createTSLComputeNode) continue;
      const node: Node | null = plugin.createTSLComputeNode(ctx);
      if (!node) continue;
      if ((node as { isComputeNode?: boolean }).isComputeNode) {
        nodes.push(node as unknown as ComputeNode);
      } else if (typeof (node as { compute?: unknown }).compute === 'function') {
        nodes.push((node as unknown as { compute: (count: number) => ComputeNode }).compute(this.maxPixels));
      }
    }
    this.pluginComputeNodes = nodes;
  }

  updateUniforms(params: {
    virtualPixelSize: number;
    snapToGrid: boolean;
    dt: number;
    gravityY: number;
    bounds: WorldBounds;
    activeCount: number;
    time: number;
  }): void {
    this.uPixelSize.value = params.virtualPixelSize;
    this.uGridSnap.value = params.snapToGrid ? 1.0 : 0.0;
    this.uDt.value = params.dt;
    this.uGravityY.value = params.gravityY;
    this.uWorldWidth.value = params.bounds.width;
    this.uWorldHeight.value = params.bounds.height;
    this.uGroundHeight.value = params.bounds.groundHeight;
    this.uActiveCount.value = params.activeCount;
    this.uTime.value = params.time;
  }

  uploadDirtyBuffers(): void {
    this.posAttribute.needsUpdate = true;
    this.velAttribute.needsUpdate = true;
    this.renderPosAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.metaAttribute.needsUpdate = true;
  }

  getComputePasses(): ComputeNode[] {
    return [...this.pluginComputeNodes, this.coreRenderCompute];
  }
}
