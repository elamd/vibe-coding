import type { PluginContext, SimulationModeId, SolverPlugin, WorldBounds } from '../../engine/types.ts';

/**
 * Mode 3: Discrete Cellular Automaton (Falling-Sand) Solver Plugin.
 * Operates on an N×N virtual-pixel grid with O(1) topology-versioned sync
 * and seamless live conversion when entering/exiting CA mode or changing N live.
 */
export class CellularAutomatonSolverPlugin implements SolverPlugin {
  readonly id = 'solver-cellular';
  readonly name = 'Cellular Automaton Solver';
  readonly category = 'solver' as const;
  readonly description = 'Discrete N×N falling-sand cellular automaton with mass-based settling.';
  readonly modeId = 'cellular' as const;
  readonly label = 'Cellular';
  readonly snapVisualsToGrid = true;
  enabled = true;

  private cols = 1;
  private rows = 1;
  private grid = new Int32Array(1);
  private seenScratch = new Uint8Array(131072);
  private occupiedCells = 0;
  private lastTopologyVersion = -1;
  private tickCount = 0;
  private accumulator = 0;
  private readonly stepInterval = 1 / 60;

  onEnterMode(ctx: PluginContext, _previousMode: SimulationModeId | null): void {
    ctx.store.dissolveAllBodies();
    this.rebuildGridFromStore(ctx);
  }

  onExitMode(ctx: PluginContext, _nextMode: SimulationModeId): void {
    const { store } = ctx;
    for (let i = 0; i < store.highWaterMark; i++) {
      if (store.active[i] === 0) continue;
      store.vel[i * 2] = 0;
      store.vel[i * 2 + 1] = 0;
    }
  }

  onVirtualPixelSizeChange(ctx: PluginContext): void {
    if (ctx.activeSolverId === 'cellular') {
      this.rebuildGridFromStore(ctx);
    }
  }

  onResize(ctx: PluginContext, _bounds: WorldBounds): void {
    if (ctx.activeSolverId === 'cellular') {
      this.rebuildGridFromStore(ctx);
    }
  }

  step(ctx: PluginContext, dt: number): void {
    this.accumulator += dt;
    this.syncMissingPixelsIntoGrid(ctx);

    let steps = 0;
    while (this.accumulator >= this.stepInterval && steps < 3) {
      this.accumulator -= this.stepInterval;
      this.stepGrid(ctx);
      steps++;
    }
  }

  private rebuildGridFromStore(ctx: PluginContext): void {
    const { store, bounds, virtualPixelSize } = ctx;
    const n = Math.max(1, virtualPixelSize);
    this.cols = Math.max(1, Math.floor(bounds.width / n));
    this.rows = Math.max(1, Math.floor((bounds.height - bounds.groundHeight) / n));

    const totalCells = this.cols * this.rows;
    if (this.grid.length !== totalCells) {
      this.grid = new Int32Array(totalCells);
    }
    this.grid.fill(-1);
    this.occupiedCells = 0;

    for (let i = 0; i < store.highWaterMark; i++) {
      if (store.active[i] === 0) continue;
      if (this.occupiedCells >= totalCells) break;
      this.placePixelNearestOpenCell(ctx, i);
    }

    this.lastTopologyVersion = store.topologyVersion;
  }

  private syncMissingPixelsIntoGrid(ctx: PluginContext): void {
    const { store, bounds, virtualPixelSize } = ctx;
    const n = Math.max(1, virtualPixelSize);
    const expectedCols = Math.max(1, Math.floor(bounds.width / n));
    const expectedRows = Math.max(1, Math.floor((bounds.height - bounds.groundHeight) / n));

    if (expectedCols !== this.cols || expectedRows !== this.rows) {
      this.rebuildGridFromStore(ctx);
      return;
    }

    // O(1) fast path: skip full scan when no pixels were spawned/freed/cleared
    if (this.lastTopologyVersion === store.topologyVersion) {
      return;
    }

    const hwm = store.highWaterMark;
    if (this.seenScratch.length < hwm) {
      this.seenScratch = new Uint8Array(Math.max(hwm, this.seenScratch.length * 2));
    }
    this.seenScratch.fill(0, 0, hwm);

    const totalCells = this.grid.length;
    let count = 0;
    for (let c = 0; c < totalCells; c++) {
      const idx = this.grid[c]!;
      if (idx !== -1) {
        if (idx >= hwm || store.active[idx] === 0) {
          this.grid[c] = -1;
        } else {
          this.seenScratch[idx] = 1;
          count++;
        }
      }
    }
    this.occupiedCells = count;

    for (let i = 0; i < hwm; i++) {
      if (store.active[i] === 1 && this.seenScratch[i] === 0) {
        if (this.occupiedCells >= totalCells) break;
        this.placePixelNearestOpenCell(ctx, i);
      }
    }

    this.lastTopologyVersion = store.topologyVersion;
  }

  private placePixelNearestOpenCell(ctx: PluginContext, pixelIndex: number): void {
    const { store, bounds, virtualPixelSize } = ctx;
    const n = Math.max(1, virtualPixelSize);
    const half = n * 0.5;

    const targetCol = clampInt(Math.floor(store.pos[pixelIndex * 2]! / n), 0, this.cols - 1);
    const targetRow = clampInt(
      Math.floor((store.pos[pixelIndex * 2 + 1]! - bounds.groundHeight) / n),
      0,
      this.rows - 1,
    );

    const cell = this.findNearestFreeCell(targetCol, targetRow);
    if (!cell) return;

    this.grid[cell.row * this.cols + cell.col] = pixelIndex;
    this.occupiedCells++;
    store.pos[pixelIndex * 2] = cell.col * n + half;
    store.pos[pixelIndex * 2 + 1] = bounds.groundHeight + cell.row * n + half;
    store.vel[pixelIndex * 2] = 0;
    store.vel[pixelIndex * 2 + 1] = 0;
  }

  private findNearestFreeCell(startCol: number, startRow: number): { col: number; row: number } | null {
    const cols = this.cols;
    const rows = this.rows;
    const grid = this.grid;

    if (grid[startRow * cols + startCol] === -1) {
      return { col: startCol, row: startRow };
    }

    const maxRadius = Math.min(Math.max(cols, rows), 64);
    for (let r = 1; r <= maxRadius; r++) {
      const minC = Math.max(0, startCol - r);
      const maxC = Math.min(cols - 1, startCol + r);
      const minR = Math.max(0, startRow - r);
      const maxR = Math.min(rows - 1, startRow + r);

      for (let row = minR; row <= maxR; row++) {
        const rowOff = row * cols;
        if (row === minR || row === maxR) {
          for (let col = minC; col <= maxC; col++) {
            if (grid[rowOff + col] === -1) return { col, row };
          }
        } else {
          if (grid[rowOff + minC] === -1) return { col: minC, row };
          if (grid[rowOff + maxC] === -1) return { col: maxC, row };
        }
      }
    }
    return null;
  }

  private stepGrid(ctx: PluginContext): void {
    const { store, registry, bounds, virtualPixelSize } = ctx;
    const n = Math.max(1, virtualPixelSize);
    const half = n * 0.5;
    const groundHeight = bounds.groundHeight;

    let gravityY = -980;
    for (const force of registry.getForces()) {
      if (force.id === 'gravity') {
        if (!force.enabled) return;
        if (force.getForceVector) gravityY = force.getForceVector().y;
      }
    }
    if (Math.abs(gravityY) < 1e-3) return;

    const fallDir = gravityY < 0 ? -1 : 1;
    const massCh = store.getChannel('mass');
    const flipScan = (this.tickCount++ & 1) === 1;
    const grid = this.grid;
    const cols = this.cols;
    const rows = this.rows;
    const pos = store.pos;
    const vel = store.vel;
    const meta = store.meta;
    const fallVel = fallDir * n * 42;

    const startRow = fallDir < 0 ? 1 : rows - 2;
    const endRow = fallDir < 0 ? rows : -1;
    const rowStep = fallDir < 0 ? 1 : -1;

    for (let row = startRow; row !== endRow; row += rowStep) {
      const rowOff = row * cols;
      const nextRow = row + fallDir;
      const nextRowOff = nextRow * cols;

      for (let cStep = 0; cStep < cols; cStep++) {
        const col = flipScan ? cols - 1 - cStep : cStep;
        const srcCell = rowOff + col;
        const idx = grid[srcCell]!;
        if (idx === -1) continue;

        const belowCell = nextRowOff + col;
        const belowIdx = grid[belowCell]!;

        if (belowIdx === -1) {
          grid[belowCell] = idx;
          grid[srcCell] = -1;
          pos[idx * 2] = col * n + half;
          pos[idx * 2 + 1] = groundHeight + nextRow * n + half;
          vel[idx * 2] = 0;
          vel[idx * 2 + 1] = fallVel;
          continue;
        }

        const myMass = massCh ? massCh[idx]! : meta[idx * 4]!;
        const belowMass = massCh ? massCh[belowIdx]! : meta[belowIdx * 4]!;
        if (myMass > belowMass * 1.15) {
          grid[srcCell] = belowIdx;
          grid[belowCell] = idx;
          pos[idx * 2] = col * n + half;
          pos[idx * 2 + 1] = groundHeight + nextRow * n + half;
          pos[belowIdx * 2] = col * n + half;
          pos[belowIdx * 2 + 1] = groundHeight + row * n + half;
          continue;
        }

        const firstDir = ((col + row + this.tickCount) & 1) === 0 ? -1 : 1;
        const c1 = col + firstDir;
        if (c1 >= 0 && c1 < cols && grid[nextRowOff + c1] === -1) {
          grid[nextRowOff + c1] = idx;
          grid[srcCell] = -1;
          pos[idx * 2] = c1 * n + half;
          pos[idx * 2 + 1] = groundHeight + nextRow * n + half;
          vel[idx * 2] = 0;
          vel[idx * 2 + 1] = fallVel;
          continue;
        }

        const c2 = col - firstDir;
        if (c2 >= 0 && c2 < cols && grid[nextRowOff + c2] === -1) {
          grid[nextRowOff + c2] = idx;
          grid[srcCell] = -1;
          pos[idx * 2] = c2 * n + half;
          pos[idx * 2 + 1] = groundHeight + nextRow * n + half;
          vel[idx * 2] = 0;
          vel[idx * 2 + 1] = fallVel;
          continue;
        }

        vel[idx * 2] = 0;
        vel[idx * 2 + 1] = 0;
      }
    }
  }
}

function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
