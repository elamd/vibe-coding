import type { PhysicsEngine } from '../engine/PhysicsEngine.ts';
import type { SimulationModeId } from '../engine/types.ts';

export interface HudCallbacks {
  onExit: () => void;
  onResume: () => void;
}

/**
 * Manages the Crisp Phosphor CRT HUD:
 *  - Upper-left: Visible pixel count + FPS counter underneath
 *  - Upper-right: Virtual pixel N×N input + dynamic Solver & Shape plugin buttons
 *  - Lower-right: Clear & Exit buttons (+ fallback overlay when window.close() is blocked)
 */
export class HudController {
  private readonly engine: PhysicsEngine;
  private readonly pixelCountEl: HTMLElement;
  private readonly fpsCountEl: HTMLElement;
  private readonly pixelSizeInput: HTMLInputElement;
  private readonly pixelSizeSuffix: HTMLElement;
  private readonly solverContainer: HTMLElement;
  private readonly shapeContainer: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly exitBtn: HTMLButtonElement;
  private readonly exitOverlay: HTMLElement;
  private readonly resumeBtn: HTMLButtonElement;

  private readonly solverButtons = new Map<SimulationModeId, HTMLButtonElement>();
  private readonly shapeButtons = new Map<string, HTMLButtonElement>();

  private frameCounter = 0;
  private fpsAccumMs = 0;
  private displayedFps = 60;

  constructor(engine: PhysicsEngine, callbacks: HudCallbacks) {
    this.engine = engine;

    this.pixelCountEl = requireEl('pixel-count');
    this.fpsCountEl = requireEl('fps-count');
    this.pixelSizeInput = requireEl('pixel-size-input') as HTMLInputElement;
    this.pixelSizeSuffix = requireEl('pixel-size-suffix');
    this.solverContainer = requireEl('solver-buttons');
    this.shapeContainer = requireEl('shape-buttons');
    this.clearBtn = requireEl('clear-btn') as HTMLButtonElement;
    this.exitBtn = requireEl('exit-btn') as HTMLButtonElement;
    this.exitOverlay = requireEl('exit-overlay');
    this.resumeBtn = requireEl('resume-btn') as HTMLButtonElement;

    this.pixelSizeInput.value = String(engine.virtualPixelSize);
    this.pixelSizeSuffix.textContent = `×${engine.virtualPixelSize} px`;

    this.pixelSizeInput.addEventListener('change', () => this.applyPixelSizeFromInput());
    this.pixelSizeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.applyPixelSizeFromInput();
        this.pixelSizeInput.blur();
      }
    });

    this.clearBtn.addEventListener('click', () => {
      this.engine.clearDynamicObjects();
      this.updateCounters(0);
    });

    this.exitBtn.addEventListener('click', () => {
      callbacks.onExit();
    });

    this.resumeBtn.addEventListener('click', () => {
      this.hideExitOverlay();
      callbacks.onResume();
    });

    this.rebuildPluginButtons();
    this.engine.onPluginsChanged(() => this.rebuildPluginButtons());
  }

  rebuildPluginButtons(): void {
    // 1. Solver Mode buttons
    this.solverContainer.innerHTML = '';
    this.solverButtons.clear();

    for (const solver of this.engine.registry.getSolvers()) {
      if (!solver.enabled) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crt-btn';
      btn.textContent = solver.label.toUpperCase();
      btn.title = solver.description;
      btn.addEventListener('click', () => {
        this.engine.setSimulationMode(solver.modeId);
        this.syncActiveStates();
      });
      this.solverContainer.appendChild(btn);
      this.solverButtons.set(solver.modeId, btn);
    }

    // 2. Shape Object buttons
    this.shapeContainer.innerHTML = '';
    this.shapeButtons.clear();

    for (const shape of this.engine.registry.getShapes()) {
      if (!shape.enabled) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crt-btn';
      btn.textContent = shape.hotkey ? `${shape.hotkey}:${shape.name.toUpperCase()}` : shape.name.toUpperCase();
      btn.title = shape.description;
      btn.addEventListener('click', () => {
        this.engine.setActiveShape(shape.id);
        this.syncActiveStates();
      });
      this.shapeContainer.appendChild(btn);
      this.shapeButtons.set(shape.id, btn);
    }

    this.syncActiveStates();
  }

  syncActiveStates(): void {
    const activeSolver = this.engine.activeSolverId;
    for (const [modeId, btn] of this.solverButtons) {
      btn.classList.toggle('is-active', modeId === activeSolver);
    }

    const activeShape = this.engine.activeShapeId;
    for (const [shapeId, btn] of this.shapeButtons) {
      btn.classList.toggle('is-active', shapeId === activeShape);
    }
  }

  updateCounters(deltaMs: number): void {
    this.pixelCountEl.textContent = String(this.engine.getVisiblePixelCount());

    if (deltaMs > 0) {
      this.frameCounter++;
      this.fpsAccumMs += deltaMs;
      if (this.fpsAccumMs >= 200) {
        this.displayedFps = Math.round((this.frameCounter * 1000) / this.fpsAccumMs);
        this.fpsCountEl.textContent = String(this.displayedFps);
        this.frameCounter = 0;
        this.fpsAccumMs = 0;
      }
    }
  }

  showExitOverlay(): void {
    this.exitOverlay.classList.remove('hidden');
  }

  hideExitOverlay(): void {
    this.exitOverlay.classList.add('hidden');
  }

  private applyPixelSizeFromInput(): void {
    const parsed = Number.parseInt(this.pixelSizeInput.value, 10);
    const applied = this.engine.setVirtualPixelSize(Number.isNaN(parsed) ? 8 : parsed);
    this.pixelSizeInput.value = String(applied);
    this.pixelSizeSuffix.textContent = `×${applied} px`;
  }
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required HUD element #${id}`);
  return el;
}
