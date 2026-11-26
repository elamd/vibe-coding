import type { PhysicsEngine } from '../engine/PhysicsEngine.ts';

export interface PointerState {
  visible: boolean;
  worldX: number;
  worldY: number;
  rightDown: boolean;
}

/**
 * Handles canvas mouse tracking, reticle visibility, left-click single spawn,
 * hold right-click ~4/s stream (contextmenu suppressed), and shape hotkeys.
 */
export class InputController {
  readonly pointer: PointerState = {
    visible: false,
    worldX: 0,
    worldY: 0,
    rightDown: false,
  };

  private readonly canvas: HTMLCanvasElement;
  private readonly engine: PhysicsEngine;
  private readonly onShapeHotkey?: (shapeId: string) => void;

  private streamTimer: number | null = null;
  private readonly streamIntervalMs = 25; // 4 spawns per second
  private active = true;

  constructor(
    canvas: HTMLCanvasElement,
    engine: PhysicsEngine,
    onShapeHotkey?: (shapeId: string) => void,
  ) {
    this.canvas = canvas;
    this.engine = engine;
    this.onShapeHotkey = onShapeHotkey;

    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('blur', this.handleWindowBlur);
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKeyDown);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.stopRightStream();
      this.pointer.visible = false;
    }
  }

  dispose(): void {
    this.stopRightStream();
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
  }

  private updateWorldCoords(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = rect.height - (e.clientY - rect.top);
    this.pointer.worldX = x;
    this.pointer.worldY = y;
    this.pointer.visible = true;
  }

  private spawnAtPointer(): void {
    if (!this.active) return;
    const solver = this.engine.getActiveSolver();
    const n = this.engine.virtualPixelSize;
    const half = n * 0.5;
    const { groundHeight } = this.engine.worldBounds;

    let sx = this.pointer.worldX;
    let sy = this.pointer.worldY;
    if (solver?.snapVisualsToGrid) {
      sx = Math.floor(sx / n) * n + half;
      sy = groundHeight + Math.max(0, Math.floor((sy - groundHeight) / n)) * n + half;
    }

    this.engine.spawnActiveShape({ x: sx, y: sy });
  }

  private startRightStream(): void {
    this.stopRightStream();
    this.pointer.rightDown = true;
    this.spawnAtPointer();
    this.streamTimer = window.setInterval(() => {
      if (!this.pointer.rightDown || !this.active) {
        this.stopRightStream();
        return;
      }
      this.spawnAtPointer();
    }, this.streamIntervalMs);
  }

  private stopRightStream(): void {
    this.pointer.rightDown = false;
    if (this.streamTimer !== null) {
      window.clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
  }

  private readonly handlePointerMove = (e: PointerEvent): void => {
    if (!this.active) return;
    this.updateWorldCoords(e);
  };

  private readonly handlePointerLeave = (): void => {
    this.pointer.visible = false;
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    if (!this.active) return;
    // Release focus from the resolution input when clicking the canvas
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    this.updateWorldCoords(e);

    if (e.button === 0) {
      this.spawnAtPointer();
    } else if (e.button === 2) {
      e.preventDefault();
      this.startRightStream();
    }
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (e.button === 2) {
      this.stopRightStream();
    }
  };

  private readonly handleWindowBlur = (): void => {
    this.stopRightStream();
    this.pointer.visible = false;
  };

  private readonly handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    for (const shape of this.engine.registry.getShapes()) {
      if (shape.enabled && shape.hotkey && e.key === shape.hotkey) {
        this.engine.setActiveShape(shape.id);
        this.onShapeHotkey?.(shape.id);
        return;
      }
    }
  };
}
