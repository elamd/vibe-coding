import type { PluginContext, PropertyPlugin } from '../../engine/types.ts';

/**
 * Mass Property Plugin.
 * Calculates each virtual pixel's mass from its screen-pixel area (N × N)
 * multiplied by its per-pixel density, and updates all active pixels live
 * when the virtual pixel resolution changes.
 */
export class MassPlugin implements PropertyPlugin {
  readonly id = 'mass';
  readonly name = 'Mass';
  readonly category = 'property' as const;
  readonly description = 'Per-virtual-pixel mass computed from virtual pixel area (N×N) and density.';
  readonly defaultValue = 64;
  enabled = true;

  computeForVirtualPixelSize(virtualPixelSize: number, density = 1.0): number {
    return Math.max(0.1, density * virtualPixelSize * virtualPixelSize);
  }

  onVirtualPixelSizeChange(ctx: PluginContext, newSize: number): void {
    if (!this.enabled) return;
    const { store } = ctx;
    const massChannel = store.getChannel(this.id);
    if (!massChannel) return;

    for (let i = 0; i < store.highWaterMark; i++) {
      if (store.active[i] === 0) continue;
      const newMass = this.computeForVirtualPixelSize(newSize, store.density[i]!);
      massChannel[i] = newMass;
      store.meta[i * 4] = newMass;
    }
    store.markDirty();
  }
}
