import type { SceneObjectPlugin, WorldBounds } from '../../engine/types.ts';

/**
 * Static Ground Floor Scene Object Plugin.
 * Renders and anchors the wide phosphor ground bar spanning the bottom of the screen.
 */
export class GroundPlugin implements SceneObjectPlugin {
  readonly id = 'ground';
  readonly name = 'Ground Floor';
  readonly category = 'scene-object' as const;
  readonly description = 'Static ground floor bar spanning the bottom of the viewport.';
  enabled = true;

  getBounds(world: WorldBounds): { x: number; y: number; width: number; height: number } {
    return {
      x: world.width * 0.5,
      y: world.groundHeight * 0.5,
      width: world.width,
      height: world.groundHeight,
    };
  }
}
