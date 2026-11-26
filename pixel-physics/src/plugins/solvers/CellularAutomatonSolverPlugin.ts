import type { PluginContext, SimulationModeId, SolverPlugin, WorldBounds } from '../../engine/types.ts';

/**
 * Mode 3: Discrete Cellular Automaton (Falling-Sand) Solver Plugin.
 * Operates on an N×N virtual-pixel grid with seamless live conversion
 * when entering/exiting CA mode or changing N live.
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
  private tickCount = 0;
  private accumulator = 0;
  private readonly stepInterval = 1 / 60;

  onEnterMode(ctx: PluginContext, _previousMode: SimulationModeId | null): void {
    // Dissolve bonded composite bodies so they settle cell-by-cell on the CA grid
    ctx.store.dissolveAllBodies();
    this.rebuildGridFromStore(ctx);
  }

  onExitMode(ctx: PluginContext, _nextMode: SimulationModeId): void {
    // Ensure continuous velocity starts cleanly settled when leaving CA mode
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
    // Ensure newly spawned pixels since last tick are registered in grid
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

    for (let i = 0; i < store.highWaterMark; i++) {
      if (store.active[i] === 0) continue;
      this.placePixelNearestOpenCell(ctx, i);
    }
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

    // Track already-present pixels
    const seen = new Uint8Array(store.highWaterMark);
    for (let c = 0; c < this.grid.length; c++) {
      const idx = this.grid[c]!;
      if (idx !== -1) {
        if (idx >= store.highWaterMark || store.active[idx] === 0) {
          this.grid[c] = -1;
        } else {
          seen[idx] = 1;
        }
      }
    }

    for (let i = 0; i < store.highWaterMark; i++) {
      if (store.active[i] === 1 && seen[i] === 0) {
        this.placePixelNearestOpenCell(ctx, i);
      }
    }
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
    store.pos[pixelIndex * 2] = cell.col * n + half;
    store.pos[pixelIndex * 2 + 1] = bounds.groundHeight + cell.row * n + half;
    store.vel[pixelIndex * 2] = 0;
    store.vel[pixelIndex * 2 + 1] = 0;
  }

  private findNearestFreeCell(startCol: number, startRow: number): { col: number; row: number } | null {
    if (this.grid[startRow * this.cols + startCol] === -1) {
      return { col: startCol, row: startRow };
    }

    const maxRadius = Math.max(this.cols, this.rows);
    for (let r = 1; r <= maxRadius; r++) {
      const minC = Math.max(0, startCol - r);
      const maxC = Math.min(this.cols - 1, startCol + r);
      const minR = Math.max(0, startRow - r);
      const maxR = Math.min(this.rows - 1, startRow + r);

      for (let row = minR; row <= maxR; row++) {
        for (let col = minC; col <= maxC; col++) {
          if (row !== minR && row !== maxR && col !== minC && col !== maxC) continue;
          if (this.grid[row * this.cols + col] === -1) {
            return { col, row };
          }
        }
      }
    }
    return null;
  }

  private stepGrid(ctx: PluginContext): void {
    const { store, registry, bounds, virtualPixelSize } = ctx;
    const n = Math.max(1, virtualPixelSize);
    const half = n * 0.5;

    // Respect GravityPlugin direction & enabled state
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

    const startRow = fallDir < 0 ? 1 : this.rows - 2;
    const endRow = fallDir < 0 ? this.rows : -1;
    const rowStep = fallDir < 0 ? 1 : -1;

    for (let row = startRow; row !== endRow; row += rowStep) {
      for (let cStep = 0; cStep < this.cols; cStep++) {
        const col = flipScan ? this.cols - 1 - cStep : cStep;
        const srcCell = row * this.cols + col;
        const idx = this.grid[srcCell]!;
        if (idx === -1) continue;

        const nextRow = row + fallDir;
        if (nextRow < 0 || nextRow >= this.rows) continue;

        const belowCell = nextRow * this.cols + col;
        const belowIdx = this.grid[belowCell]!;

        // 1. Fall straight down if empty
        if (belowIdx === -1) {
          this.moveCell(store, srcCell, belowCell, col, nextRow, n, half, bounds.groundHeight, fallDir);
          continue;
        }

        // 2. Density/mass displacement: heavier virtual pixel sinks beneath strictly lighter one
        const myMass = massCh ? massCh[idx]! : store.meta[idx * 4]!;
        const belowMass = massCh ? massCh[belowIdx]! : store.meta[belowIdx * 4]!;
        if (myMass > belowMass * 1.15) {
          this.swapCells(store, srcCell, belowCell, col, row, col, nextRow, n, half, bounds.groundHeight);
          continue;
        }

        // 3. Slide diagonally down-left or down-right into natural piles
        const firstDir = ((col + row + this.tickCount) & 1) === 0 ? -1 : 1;
        const secondDir = -firstDir;

        const c1 = col + firstDir;
        if (c1 >= 0 && c1 < this.cols && this.grid[nextRow * this.cols + c1] === -1) {
          this.moveCell(
            store,
            srcCell,
            nextRow * this.cols + c1,
            c1,
            nextRow,
            n,
            half,
            bounds.groundHeight,
            fallDir,
          );
          continue;
        }

        const c2 = col + secondDir;
        if (c2 >= 0 && c2 < this.cols && this.grid[nextRow * this.cols + c2] === -1) {
          this.moveCell(
            store,
            srcCell,
            nextRow * this.cols + c2,
            c2,
            nextRow,
            n,
            half,
            bounds.groundHeight,
            fallDir,
          );
          continue;
        }

        // Settled
        store.vel[idx * 2] = 0;
        store.vel[idx * 2 + 1] = 0;
      }
    }
  }

  private moveCell(
    store: PluginContext['store'],
    srcCell: number,
    dstCell: number,
    dstCol: number,
    dstRow: number,
    n: number,
    half: number,
    groundHeight: number,
    fallDir: number,
  ): void {
    const idx = this.grid[srcCell]!;
    this.grid[dstCell] = idx;
    this.grid[srcCell] = -1;
    store.pos[idx * 2] = dstCol * n + half;
    store.pos[idx * 2 + 1] = groundHeight + dstRow * n + half;
    store.vel[idx * 2] = 0;
    store.vel[idx * 2 + 1] = fallDir * n * 42;
  }

  private swapCells(
    store: PluginContext['store'],
    cellA: number,
    cellB: number,
    colA: number,
    rowA: number,
    colB: number,
    rowB: number,
    n: number,
    half: number,
    groundHeight: number,
  ): void {
    const idxA = this.grid[cellA]!;
    const idxB = this.grid[cellB]!;
    this.grid[cellA] = idxB;
    this.grid[cellB] = idxA;

    store.pos[idxA * 2] = colB * n + half;
    store.pos[idxA * 2 + 1] = groundHeight + rowB * n + half;
    store.pos[idxB * 2] = colA * n + half;
    store.pos[idxB * 2 + 1] = groundHeight + rowA * n + half;
  }
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
