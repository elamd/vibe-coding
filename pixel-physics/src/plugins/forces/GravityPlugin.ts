import { Fn, If, abs, clamp, instanceIndex, max } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type {
  BondedBody,
  ForcePlugin,
  PluginContext,
  TSLComputeContext,
} from '../../engine/types.ts';

/**
 * Gravity Force Plugin.
 * Applies uniform downward acceleration to all active pixels and bonded bodies,
 * and contributes a Tier-1 GPU TSL compute pass for kinetic velocity/gravity phosphor response.
 */
export class GravityPlugin implements ForcePlugin {
  readonly id = 'gravity';
  readonly name = 'Gravity';
  readonly category = 'force' as const;
  readonly description = 'Downward gravitational acceleration applied per virtual pixel and bonded body.';
  enabled = true;

  gravityX: number;
  gravityY: number;

  constructor(gravityY = -980, gravityX = 0) {
    this.gravityX = gravityX;
    this.gravityY = gravityY;
  }

  getForceVector(): { x: number; y: number } {
    return { x: this.gravityX, y: this.gravityY };
  }

  applyToPixel(ctx: PluginContext, pixelIndex: number, dt: number): void {
    if (!this.enabled) return;
    const i2 = pixelIndex * 2;
    ctx.store.vel[i2] = ctx.store.vel[i2]! + this.gravityX * dt;
    ctx.store.vel[i2 + 1] = ctx.store.vel[i2 + 1]! + this.gravityY * dt;
  }

  applyToBody(_ctx: PluginContext, body: BondedBody, dt: number): void {
    if (!this.enabled) return;
    body.vx += this.gravityX * dt;
    body.vy += this.gravityY * dt;
  }

  /**
   * Tier-1 GPU TSL compute hook: modulates phosphor kinetic glow in meta.w
   * based on gravitational fall energy without duplicating CPU velocity integration.
   */
  createTSLComputeNode(tslCtx: TSLComputeContext): Node {
    const velStorage = tslCtx.velStorage as { element: (i: unknown) => { y: { mul: (v: unknown) => unknown } } };
    const metaStorage = tslCtx.metaStorage as {
      element: (i: unknown) => {
        y: { greaterThan: (v: number) => unknown };
        w: { assign: (v: unknown) => void };
      };
    };
    const uGravityY = tslCtx.uniforms.uGravityY as { abs: () => unknown };

    return Fn(() => {
      const idx = instanceIndex;
      const meta = metaStorage.element(idx);
      If(meta.y.greaterThan(0.5) as never, () => {
        const vel = velStorage.element(idx);
        const gravScale = max(abs(uGravityY as never), 1.0);
        const fallEnergy = clamp(abs(vel.y as never).div(gravScale.mul(0.85)), 0.0, 1.0);
        meta.w.assign(fallEnergy);
      });
    })();
  }
}
