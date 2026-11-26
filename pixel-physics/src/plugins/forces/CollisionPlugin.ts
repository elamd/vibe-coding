import type { BondedBody, InteractionPlugin, PluginContext } from '../../engine/types.ts';

interface WorldPoly {
  body: BondedBody;
  vx: Float64Array;
  vy: Float64Array;
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  radius: number;
  isCircle: boolean;
}

const PIXEL_HASH_SIZE = 65536;
const PIXEL_HASH_MASK = PIXEL_HASH_SIZE - 1;
const BODY_HASH_SIZE = 8192;
const BODY_HASH_MASK = BODY_HASH_SIZE - 1;

/**
 * High-Performance Mass-Weighted Solid Collision Interaction Plugin.
 *  - Zero-allocation flat TypedArray spatial hash for loose pixels (half-neighborhood scan)
 *  - Zero-allocation broad-phase spatial grid for bonded bodies (replaces O(B²) scan)
 *  - Analytical O(1) Circle fast-paths (Circle-Circle, Circle-Pixel, Circle-Polygon, Circle-Bounds)
 *  - Pre-allocated WorldPoly scratch pool + 2D SAT for arbitrary convex vertex polygons
 */
export class CollisionPlugin implements InteractionPlugin {
  readonly id = 'collision';
  readonly name = 'Solid Collision';
  readonly category = 'interaction' as const;
  readonly description =
    'Mass-weighted solid collision resolution for pixels and vertex-face polygon bodies.';
  enabled = true;

  private readonly iterations = 2;

  // Loose-pixel flat intrusive spatial hash (zero GC)
  private readonly pixelHead = new Int32Array(PIXEL_HASH_SIZE).fill(-1);
  private pixelNext = new Int32Array(131072);
  private readonly pixelTouched = new Int32Array(PIXEL_HASH_SIZE);
  private pixelTouchedCount = 0;

  // Bonded-body flat broad-phase spatial hash (zero GC)
  private readonly bodyHead = new Int32Array(BODY_HASH_SIZE).fill(-1);
  private bodyNext = new Int32Array(16384);
  private bodyNodePoly = new Int32Array(16384);
  private readonly bodyTouched = new Int32Array(BODY_HASH_SIZE);
  private bodyTouchedCount = 0;
  private bodyNodeCount = 0;

  // Pre-allocated WorldPoly scratch pool
  private readonly polyPool: WorldPoly[] = [];
  private pairSeenStamp = new Int32Array(4096);
  private currentStamp = 1;

  resolveInteractions(ctx: PluginContext, _dt: number): void {
    if (!this.enabled) return;

    const { store, bounds, virtualPixelSize } = ctx;
    if (store.activeCount === 0 && store.bodies.size === 0) return;

    const hwm = store.highWaterMark;
    if (this.pixelNext.length < hwm) {
      this.pixelNext = new Int32Array(Math.max(hwm, this.pixelNext.length * 2));
    }

    const active = store.active;
    const bodyId = store.bodyId;
    const pos = store.pos;
    const vel = store.vel;
    const restitution = store.restitution;
    const friction = store.friction;

    const cellSize = Math.max(2, virtualPixelSize);
    const invCellSize = 1 / cellSize;
    const half = virtualPixelSize * 0.5;
    const minDist = virtualPixelSize;
    const minDistSq = minDist * minDist;

    const hasBodies = store.bodies.size > 0;

    for (let iter = 0; iter < this.iterations; iter++) {
      // 1. Rebuild flat spatial hash for loose pixels
      this.resetPixelGrid();
      let looseCount = 0;
      for (let i = 0; i < hwm; i++) {
        if (active[i] === 0 || bodyId[i] !== -1) continue;
        looseCount++;
        const cx = Math.floor(pos[i * 2]! * invCellSize);
        const cy = Math.floor(pos[i * 2 + 1]! * invCellSize);
        this.insertPixel(cx, cy, i);
      }

      // 2. Loose pixel <-> loose pixel collisions (half-neighborhood: self + 4 forward cells)
      if (looseCount > 1) {
        const pHead = this.pixelHead;
        const pNext = this.pixelNext;

        for (let i = 0; i < hwm; i++) {
          if (active[i] === 0 || bodyId[i] !== -1) continue;
          const xi = pos[i * 2]!;
          const yi = pos[i * 2 + 1]!;
          const cx = Math.floor(xi * invCellSize);
          const cy = Math.floor(yi * invCellSize);

          // Same cell: only test j > i
          let j = pHead[hashPixelCell(cx, cy)]!;
          while (j !== -1) {
            if (j > i) {
              const dx = pos[j * 2]! - pos[i * 2]!;
              const dy = pos[j * 2 + 1]! - pos[i * 2 + 1]!;
              const dSq = dx * dx + dy * dy;
              if (dSq < minDistSq) {
                this.resolveLoosePixelPair(ctx, i, j, dx, dy, dSq, minDist);
              }
            }
            j = pNext[j]!;
          }

          // 4 forward neighbor cells: (cx+1,cy), (cx-1,cy+1), (cx,cy+1), (cx+1,cy+1)
          for (let nIdx = 0; nIdx < 4; nIdx++) {
            const ncx = nIdx === 0 ? cx + 1 : nIdx === 1 ? cx - 1 : nIdx === 2 ? cx : cx + 1;
            const ncy = nIdx === 0 ? cy : cy + 1;
            let k = pHead[hashPixelCell(ncx, ncy)]!;
            while (k !== -1) {
              const dx = pos[k * 2]! - pos[i * 2]!;
              const dy = pos[k * 2 + 1]! - pos[i * 2 + 1]!;
              const dSq = dx * dx + dy * dy;
              if (dSq < minDistSq) {
                this.resolveLoosePixelPair(ctx, i, k, dx, dy, dSq, minDist);
              }
              k = pNext[k]!;
            }
          }
        }
      }

      // 3. Bonded bodies broad-phase, pixel-vs-body, body-vs-body, and body-vs-bounds
      if (hasBodies) {
        let polyCount = 0;
        let maxRadius = virtualPixelSize * 3;
        for (const body of store.bodies.values()) {
          if (!body.active || body.pixelIndices.length < 3) continue;
          const poly = this.acquirePoly(polyCount++, body, virtualPixelSize);
          if (poly.radius > maxRadius) maxRadius = poly.radius;
        }

        // 4. Loose pixel <-> bonded body collisions
        if (looseCount > 0 && polyCount > 0) {
          const pHead = this.pixelHead;
          const pNext = this.pixelNext;

          for (let p = 0; p < polyCount; p++) {
            const poly = this.polyPool[p]!;
            const minC = Math.floor((poly.minX - half) * invCellSize);
            const maxC = Math.floor((poly.maxX + half) * invCellSize);
            const minR = Math.floor((poly.minY - half) * invCellSize);
            const maxR = Math.floor((poly.maxY + half) * invCellSize);

            if (poly.isCircle) {
              for (let cx = minC; cx <= maxC; cx++) {
                for (let cy = minR; cy <= maxR; cy++) {
                  let idx = pHead[hashPixelCell(cx, cy)]!;
                  while (idx !== -1) {
                    this.resolvePixelVsCircle(ctx, idx, half, poly);
                    idx = pNext[idx]!;
                  }
                }
              }
            } else {
              for (let cx = minC; cx <= maxC; cx++) {
                for (let cy = minR; cy <= maxR; cy++) {
                  let idx = pHead[hashPixelCell(cx, cy)]!;
                  while (idx !== -1) {
                    this.resolvePixelVsPolygon(ctx, idx, half, poly);
                    idx = pNext[idx]!;
                  }
                }
              }
            }
          }
        }

        // 5. Body <-> Body collisions via flat broad-phase spatial grid (O(B))
        if (polyCount > 1) {
          this.resolveAllBodyPairsBroadPhase(polyCount, Math.max(16, maxRadius * 2));
        }

        // 6. Bonded bodies <-> ground floor & left/right walls
        for (let p = 0; p < polyCount; p++) {
          const poly = this.polyPool[p]!;
          if (poly.isCircle) {
            this.resolveCircleBoundaries(ctx, poly.body, poly.radius);
            syncBodyPixels(ctx, poly.body);
          } else {
            syncBodyPixels(ctx, poly.body);
            this.resolvePolygonBoundaries(ctx, poly.body);
            syncBodyPixels(ctx, poly.body);
          }
        }
      }

      // 7. Loose pixel <-> ground floor & left/right walls
      if (looseCount > 0) {
        const floorY = bounds.groundHeight + half;
        const rightWall = bounds.width - half;

        for (let i = 0; i < hwm; i++) {
          if (active[i] === 0 || bodyId[i] !== -1) continue;
          const i2 = i * 2;
          const e = restitution[i]!;
          const mu = friction[i]!;

          if (pos[i2 + 1]! < floorY) {
            pos[i2 + 1] = floorY;
            const vn = vel[i2 + 1]!;
            if (vn < 0) {
              vel[i2 + 1] = vn > -28 ? 0 : -vn * e;
              const vx = vel[i2]! * Math.max(0, 1 - mu * 0.35);
              vel[i2] = vx > -2 && vx < 2 ? 0 : vx;
            }
          }

          if (pos[i2]! < half) {
            pos[i2] = half;
            if (vel[i2]! < 0) vel[i2] = -vel[i2]! * e;
          } else if (pos[i2]! > rightWall) {
            pos[i2] = rightWall;
            if (vel[i2]! > 0) vel[i2] = -vel[i2]! * e;
          }
        }
      }
    }
  }

  private resolveAllBodyPairsBroadPhase(polyCount: number, cellSize: number): void {
    this.resetBodyGrid();
    const invCell = 1 / cellSize;

    // Ensure stamp array is big enough
    if (this.pairSeenStamp.length < polyCount) {
      this.pairSeenStamp = new Int32Array(Math.max(polyCount * 2, 4096));
    }

    // Insert each body into all broad-phase cells its AABB overlaps
    for (let a = 0; a < polyCount; a++) {
      const poly = this.polyPool[a]!;
      const minC = Math.floor(poly.minX * invCell);
      const maxC = Math.floor(poly.maxX * invCell);
      const minR = Math.floor(poly.minY * invCell);
      const maxR = Math.floor(poly.maxY * invCell);

      for (let cx = minC; cx <= maxC; cx++) {
        for (let cy = minR; cy <= maxR; cy++) {
          this.insertBodyCell(cx, cy, a);
        }
      }
    }

    // For each body a, query overlapping cells and test each neighbor b > a at most once
    const bHead = this.bodyHead;
    const bNext = this.bodyNext;
    const bPoly = this.bodyNodePoly;

    for (let a = 0; a < polyCount; a++) {
      const polyA = this.polyPool[a]!;
      const stamp = ++this.currentStamp;
      if (stamp >= 0x7ffffff0) {
        this.pairSeenStamp.fill(0);
        this.currentStamp = 1;
      }

      const minC = Math.floor(polyA.minX * invCell);
      const maxC = Math.floor(polyA.maxX * invCell);
      const minR = Math.floor(polyA.minY * invCell);
      const maxR = Math.floor(polyA.maxY * invCell);

      for (let cx = minC; cx <= maxC; cx++) {
        for (let cy = minR; cy <= maxR; cy++) {
          let node = bHead[hashBodyCell(cx, cy)]!;
          while (node !== -1) {
            const b = bPoly[node]!;
            if (b > a && this.pairSeenStamp[b] !== stamp) {
              this.pairSeenStamp[b] = stamp;
              const polyB = this.polyPool[b]!;
              const dx = polyB.body.x - polyA.body.x;
              const dy = polyB.body.y - polyA.body.y;
              const rSum = polyA.radius + polyB.radius;
              if (dx * dx + dy * dy < rSum * rSum) {
                if (polyA.isCircle && polyB.isCircle) {
                  this.resolveCirclePair(polyA, polyB, dx, dy);
                } else if (polyA.isCircle) {
                  this.resolveCircleVsPolygon(polyA, polyB);
                } else if (polyB.isCircle) {
                  this.resolveCircleVsPolygon(polyB, polyA);
                } else {
                  this.resolvePolygonPair(polyA, polyB);
                }
              }
            }
            node = bNext[node]!;
          }
        }
      }
    }
  }

  private resolveLoosePixelPair(
    ctx: PluginContext,
    i: number,
    j: number,
    dx: number,
    dy: number,
    distSq: number,
    minDist: number,
  ): void {
    const { store } = ctx;
    let dist: number;
    let nx: number;
    let ny: number;

    if (distSq < 1e-8) {
      const angle = ((i * 73 + j * 37) % 360) * (Math.PI / 180);
      nx = Math.cos(angle);
      ny = Math.sin(angle);
      dist = 0;
    } else {
      dist = Math.sqrt(distSq);
      const invDist = 1 / dist;
      nx = dx * invDist;
      ny = dy * invDist;
    }

    const overlap = minDist - dist;
    const massCh = store.getChannel('mass');
    const massA = massCh ? massCh[i]! : store.meta[i * 4]!;
    const massB = massCh ? massCh[j]! : store.meta[j * 4]!;
    const invMassA = massA > 0.1 ? 1 / massA : 10;
    const invMassB = massB > 0.1 ? 1 / massB : 10;
    const totalInvMass = invMassA + invMassB;

    const correction = (overlap * 0.78) / totalInvMass;
    const i2 = i * 2;
    const j2 = j * 2;
    const pos = store.pos;
    const vel = store.vel;

    pos[i2] = pos[i2]! - nx * correction * invMassA;
    pos[i2 + 1] = pos[i2 + 1]! - ny * correction * invMassA;
    pos[j2] = pos[j2]! + nx * correction * invMassB;
    pos[j2 + 1] = pos[j2 + 1]! + ny * correction * invMassB;

    const rvx = vel[j2]! - vel[i2]!;
    const rvy = vel[j2 + 1]! - vel[i2 + 1]!;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return;

    const e = velAlongNormal > -30 ? 0 : Math.min(store.restitution[i]!, store.restitution[j]!);
    const jn = (-(1 + e) * velAlongNormal) / totalInvMass;

    vel[i2] = vel[i2]! - jn * nx * invMassA;
    vel[i2 + 1] = vel[i2 + 1]! - jn * ny * invMassA;
    vel[j2] = vel[j2]! + jn * nx * invMassB;
    vel[j2 + 1] = vel[j2 + 1]! + jn * ny * invMassB;

    const tx = -ny;
    const ty = nx;
    const velAlongTangent = rvx * tx + rvy * ty;
    const mu = Math.sqrt(store.friction[i]! * store.friction[j]!);
    const jt = Math.max(-jn * mu, Math.min(jn * mu, -velAlongTangent / totalInvMass));

    vel[i2] = vel[i2]! - jt * tx * invMassA;
    vel[i2 + 1] = vel[i2 + 1]! - jt * ty * invMassA;
    vel[j2] = vel[j2]! + jt * tx * invMassB;
    vel[j2 + 1] = vel[j2 + 1]! + jt * ty * invMassB;
  }

  private resolvePixelVsCircle(
    ctx: PluginContext,
    pixelIdx: number,
    pixelRadius: number,
    circle: WorldPoly,
  ): void {
    const { store } = ctx;
    const body = circle.body;
    const i2 = pixelIdx * 2;
    const dx = store.pos[i2]! - body.x;
    const dy = store.pos[i2 + 1]! - body.y;
    const minDist = circle.radius + pixelRadius;
    const dSq = dx * dx + dy * dy;
    if (dSq >= minDist * minDist) return;

    let dist = Math.sqrt(dSq);
    let nx: number;
    let ny: number;
    if (dist < 1e-4) {
      nx = 0;
      ny = 1;
      dist = 0;
    } else {
      nx = dx / dist;
      ny = dy / dist;
    }

    const penetration = minDist - dist;
    const contactX = body.x + nx * circle.radius;
    const contactY = body.y + ny * circle.radius;
    this.applyPixelBodyContact(ctx, pixelIdx, body, nx, ny, penetration, contactX, contactY);
  }

  private resolvePixelVsPolygon(
    ctx: PluginContext,
    pixelIdx: number,
    pixelRadius: number,
    poly: WorldPoly,
  ): void {
    const { store } = ctx;
    const px = store.pos[pixelIdx * 2]!;
    const py = store.pos[pixelIdx * 2 + 1]!;

    if (
      px + pixelRadius < poly.minX ||
      px - pixelRadius > poly.maxX ||
      py + pixelRadius < poly.minY ||
      py - pixelRadius > poly.maxY
    ) {
      return;
    }

    let minDistSq = Infinity;
    let closestX = px;
    let closestY = py;
    let closestEdgeNx = 0;
    let closestEdgeNy = 1;
    let inside = true;

    const n = poly.count;
    const vx = poly.vx;
    const vy = poly.vy;

    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = vx[i]!;
      const ay = vy[i]!;
      const ex = vx[j]! - ax;
      const ey = vy[j]! - ay;
      const lenSq = ex * ex + ey * ey;
      if (lenSq < 1e-8) continue;

      const invLen = 1 / Math.sqrt(lenSq);
      const enx = ey * invLen;
      const eny = -ex * invLen;

      if ((px - ax) * enx + (py - ay) * eny > 0) {
        inside = false;
      }

      const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / lenSq));
      const cx = ax + ex * t;
      const cy = ay + ey * t;
      const dx = px - cx;
      const dy = py - cy;
      const dSq = dx * dx + dy * dy;

      if (dSq < minDistSq) {
        minDistSq = dSq;
        closestX = cx;
        closestY = cy;
        closestEdgeNx = enx;
        closestEdgeNy = eny;
      }
    }

    const dist = Math.sqrt(minDistSq);
    if (!inside && dist >= pixelRadius) return;

    let nx: number;
    let ny: number;
    let penetration: number;

    if (inside) {
      nx = closestEdgeNx;
      ny = closestEdgeNy;
      penetration = pixelRadius + dist;
    } else if (dist > 1e-4) {
      nx = (px - closestX) / dist;
      ny = (py - closestY) / dist;
      penetration = pixelRadius - dist;
    } else {
      nx = closestEdgeNx;
      ny = closestEdgeNy;
      penetration = pixelRadius;
    }

    this.applyPixelBodyContact(ctx, pixelIdx, poly.body, nx, ny, penetration, closestX, closestY);
  }

  private applyPixelBodyContact(
    ctx: PluginContext,
    pixelIdx: number,
    body: BondedBody,
    nx: number,
    ny: number,
    penetration: number,
    contactX: number,
    contactY: number,
  ): void {
    const { store } = ctx;
    const massCh = store.getChannel('mass');
    const pixelMass = massCh ? massCh[pixelIdx]! : store.meta[pixelIdx * 4]!;
    const invPixelMass = pixelMass > 0.1 ? 1 / pixelMass : 10;
    const totalInvMass = invPixelMass + body.invMass;

    const corr = (penetration * 0.82) / totalInvMass;
    const i2 = pixelIdx * 2;
    store.pos[i2] = store.pos[i2]! + nx * corr * invPixelMass;
    store.pos[i2 + 1] = store.pos[i2 + 1]! + ny * corr * invPixelMass;
    body.x -= nx * corr * body.invMass;
    body.y -= ny * corr * body.invMass;

    const rx = contactX - body.x;
    const ry = contactY - body.y;
    const vBodyX = body.vx - body.omega * ry;
    const vBodyY = body.vy + body.omega * rx;
    const rvx = store.vel[i2]! - vBodyX;
    const rvy = store.vel[i2 + 1]! - vBodyY;

    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return;

    const rCrossN = rx * ny - ry * nx;
    const denom = totalInvMass + rCrossN * rCrossN * body.invInertia;
    const e = velAlongNormal > -30 ? 0 : Math.min(store.restitution[pixelIdx]!, body.restitution);
    const jn = (-(1 + e) * velAlongNormal) / denom;

    store.vel[i2] = store.vel[i2]! + jn * nx * invPixelMass;
    store.vel[i2 + 1] = store.vel[i2 + 1]! + jn * ny * invPixelMass;
    body.vx -= jn * nx * body.invMass;
    body.vy -= jn * ny * body.invMass;
    body.omega -= rCrossN * jn * body.invInertia;

    const tx = -ny;
    const ty = nx;
    const velAlongTangent = rvx * tx + rvy * ty;
    const rCrossT = rx * ty - ry * tx;
    const denomT = totalInvMass + rCrossT * rCrossT * body.invInertia;
    const mu = Math.sqrt(store.friction[pixelIdx]! * body.friction);
    const jt = Math.max(-jn * mu, Math.min(jn * mu, -velAlongTangent / denomT));

    store.vel[i2] = store.vel[i2]! + jt * tx * invPixelMass;
    store.vel[i2 + 1] = store.vel[i2 + 1]! + jt * ty * invPixelMass;
    body.vx -= jt * tx * body.invMass;
    body.vy -= jt * ty * body.invMass;
    body.omega -= rCrossT * jt * body.invInertia;
  }

  private resolveCirclePair(polyA: WorldPoly, polyB: WorldPoly, dx: number, dy: number): void {
    const bodyA = polyA.body;
    const bodyB = polyB.body;
    const rSum = polyA.radius + polyB.radius;
    const dSq = dx * dx + dy * dy;
    if (dSq >= rSum * rSum) return;

    let dist = Math.sqrt(dSq);
    let nx: number;
    let ny: number;
    if (dist < 1e-4) {
      nx = 0;
      ny = 1;
      dist = 0;
    } else {
      nx = dx / dist;
      ny = dy / dist;
    }

    const contactX = bodyA.x + nx * polyA.radius;
    const contactY = bodyA.y + ny * polyA.radius;
    this.applyBodyPairContact(bodyA, bodyB, nx, ny, rSum - dist, contactX, contactY);
  }

  private resolveCircleVsPolygon(circle: WorldPoly, poly: WorldPoly): void {
    const cx = circle.body.x;
    const cy = circle.body.y;
    const r = circle.radius;

    if (
      cx + r < poly.minX ||
      cx - r > poly.maxX ||
      cy + r < poly.minY ||
      cy - r > poly.maxY
    ) {
      return;
    }

    let minDistSq = Infinity;
    let closestX = cx;
    let closestY = cy;
    let closestEdgeNx = 0;
    let closestEdgeNy = 1;
    let inside = true;

    const n = poly.count;
    const vx = poly.vx;
    const vy = poly.vy;

    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = vx[i]!;
      const ay = vy[i]!;
      const ex = vx[j]! - ax;
      const ey = vy[j]! - ay;
      const lenSq = ex * ex + ey * ey;
      if (lenSq < 1e-8) continue;

      const invLen = 1 / Math.sqrt(lenSq);
      const enx = ey * invLen;
      const eny = -ex * invLen;
      if ((cx - ax) * enx + (cy - ay) * eny > 0) {
        inside = false;
      }

      const t = Math.max(0, Math.min(1, ((cx - ax) * ex + (cy - ay) * ey) / lenSq));
      const px = ax + ex * t;
      const py = ay + ey * t;
      const dx = cx - px;
      const dy = cy - py;
      const dSq = dx * dx + dy * dy;

      if (dSq < minDistSq) {
        minDistSq = dSq;
        closestX = px;
        closestY = py;
        closestEdgeNx = enx;
        closestEdgeNy = eny;
      }
    }

    const dist = Math.sqrt(minDistSq);
    if (!inside && dist >= r) return;

    // Normal from poly -> circle
    let nx: number;
    let ny: number;
    let overlap: number;
    if (inside) {
      nx = closestEdgeNx;
      ny = closestEdgeNy;
      overlap = r + dist;
    } else if (dist > 1e-4) {
      nx = (cx - closestX) / dist;
      ny = (cy - closestY) / dist;
      overlap = r - dist;
    } else {
      nx = closestEdgeNx;
      ny = closestEdgeNy;
      overlap = r;
    }

    this.applyBodyPairContact(poly.body, circle.body, nx, ny, overlap, closestX, closestY);
  }

  private resolvePolygonPair(polyA: WorldPoly, polyB: WorldPoly): void {
    let minOverlap = Infinity;
    let bestNx = 0;
    let bestNy = 0;

    const checkAxes = (src: WorldPoly): boolean => {
      const n = src.count;
      const svx = src.vx;
      const svy = src.vy;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const ex = svx[j]! - svx[i]!;
        const ey = svy[j]! - svy[i]!;
        const lenSq = ex * ex + ey * ey;
        if (lenSq < 1e-10) continue;
        const invLen = 1 / Math.sqrt(lenSq);
        const nx = ey * invLen;
        const ny = -ex * invLen;

        let minA = Infinity;
        let maxA = -Infinity;
        for (let k = 0; k < polyA.count; k++) {
          const p = polyA.vx[k]! * nx + polyA.vy[k]! * ny;
          if (p < minA) minA = p;
          if (p > maxA) maxA = p;
        }

        let minB = Infinity;
        let maxB = -Infinity;
        for (let k = 0; k < polyB.count; k++) {
          const p = polyB.vx[k]! * nx + polyB.vy[k]! * ny;
          if (p < minB) minB = p;
          if (p > maxB) maxB = p;
        }

        const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
        if (overlap <= 0) return false;
        if (overlap < minOverlap) {
          minOverlap = overlap;
          bestNx = nx;
          bestNy = ny;
        }
      }
      return true;
    };

    if (!checkAxes(polyA) || !checkAxes(polyB)) return;

    const bodyA = polyA.body;
    const bodyB = polyB.body;
    if ((bodyB.x - bodyA.x) * bestNx + (bodyB.y - bodyA.y) * bestNy < 0) {
      bestNx = -bestNx;
      bestNy = -bestNy;
    }

    const sA = findSupportVertex(polyA, bestNx, bestNy);
    const sB = findSupportVertex(polyB, -bestNx, -bestNy);
    this.applyBodyPairContact(
      bodyA,
      bodyB,
      bestNx,
      bestNy,
      minOverlap,
      (sA.x + sB.x) * 0.5,
      (sA.y + sB.y) * 0.5,
    );
  }

  private applyBodyPairContact(
    bodyA: BondedBody,
    bodyB: BondedBody,
    nx: number,
    ny: number,
    overlap: number,
    contactX: number,
    contactY: number,
  ): void {
    const totalInvMass = bodyA.invMass + bodyB.invMass;
    const corr = (overlap * 0.82) / totalInvMass;
    bodyA.x -= nx * corr * bodyA.invMass;
    bodyA.y -= ny * corr * bodyA.invMass;
    bodyB.x += nx * corr * bodyB.invMass;
    bodyB.y += ny * corr * bodyB.invMass;

    const rAx = contactX - bodyA.x;
    const rAy = contactY - bodyA.y;
    const rBx = contactX - bodyB.x;
    const rBy = contactY - bodyB.y;

    const vAx = bodyA.vx - bodyA.omega * rAy;
    const vAy = bodyA.vy + bodyA.omega * rAx;
    const vBx = bodyB.vx - bodyB.omega * rBy;
    const vBy = bodyB.vy + bodyB.omega * rBx;

    const rvx = vBx - vAx;
    const rvy = vBy - vAy;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return;

    const rACrossN = rAx * ny - rAy * nx;
    const rBCrossN = rBx * ny - rBy * nx;
    const denom =
      totalInvMass +
      rACrossN * rACrossN * bodyA.invInertia +
      rBCrossN * rBCrossN * bodyB.invInertia;

    const e = velAlongNormal > -35 ? 0 : Math.min(bodyA.restitution, bodyB.restitution);
    const jn = (-(1 + e) * velAlongNormal) / denom;

    bodyA.vx -= jn * nx * bodyA.invMass;
    bodyA.vy -= jn * ny * bodyA.invMass;
    bodyA.omega -= rACrossN * jn * bodyA.invInertia;

    bodyB.vx += jn * nx * bodyB.invMass;
    bodyB.vy += jn * ny * bodyB.invMass;
    bodyB.omega += rBCrossN * jn * bodyB.invInertia;

    const tx = -ny;
    const ty = nx;
    const velAlongTangent = rvx * tx + rvy * ty;
    const rACrossT = rAx * ty - rAy * tx;
    const rBCrossT = rBx * ty - rBy * tx;
    const denomT =
      totalInvMass +
      rACrossT * rACrossT * bodyA.invInertia +
      rBCrossT * rBCrossT * bodyB.invInertia;

    const mu = Math.sqrt(bodyA.friction * bodyB.friction);
    const jt = Math.max(-jn * mu, Math.min(jn * mu, -velAlongTangent / denomT));

    bodyA.vx -= jt * tx * bodyA.invMass;
    bodyA.vy -= jt * ty * bodyA.invMass;
    bodyA.omega -= rACrossT * jt * bodyA.invInertia;

    bodyB.vx += jt * tx * bodyB.invMass;
    bodyB.vy += jt * ty * bodyB.invMass;
    bodyB.omega += rBCrossT * jt * bodyB.invInertia;
  }

  private resolveCircleBoundaries(ctx: PluginContext, body: BondedBody, radius: number): void {
    const { bounds } = ctx;
    const floorY = bounds.groundHeight + radius;

    if (body.y < floorY) {
      body.y = floorY;
      if (body.vy < 0) {
        const e = body.vy > -35 ? 0 : body.restitution;
        const jn = -(1 + e) * body.vy * body.totalMass;
        body.vy = -body.vy * e;

        // Rolling tangential friction at bottom contact point (rx=0, ry=-radius)
        const vContactX = body.vx + body.omega * radius;
        const denomT = body.invMass + radius * radius * body.invInertia;
        const jt = Math.max(-jn * body.friction, Math.min(jn * body.friction, -vContactX / denomT));
        body.vx += jt * body.invMass;
        body.omega += radius * jt * body.invInertia;

        if (Math.abs(body.vy) < 12 && Math.abs(body.vx) < 2 && Math.abs(body.omega) < 0.04) {
          body.vx = 0;
          body.omega = 0;
        }
      }
    }

    if (body.x < radius) {
      body.x = radius;
      if (body.vx < 0) {
        body.vx = -body.vx * body.restitution;
        body.omega *= 0.92;
      }
    } else if (body.x > bounds.width - radius) {
      body.x = bounds.width - radius;
      if (body.vx > 0) {
        body.vx = -body.vx * body.restitution;
        body.omega *= 0.92;
      }
    }
  }

  private resolvePolygonBoundaries(ctx: PluginContext, body: BondedBody): void {
    const { store, bounds } = ctx;
    const floorY = bounds.groundHeight;
    const rightX = bounds.width;

    let maxFloorPen = 0;
    let floorContactX = 0;
    let floorHits = 0;
    let maxLeftPen = 0;
    let maxRightPen = 0;

    const indices = body.pixelIndices;
    const pos = store.pos;
    for (let k = 0; k < indices.length; k++) {
      const idx = indices[k]!;
      const px = pos[idx * 2]!;
      const py = pos[idx * 2 + 1]!;

      if (py < floorY) {
        const pen = floorY - py;
        if (pen > maxFloorPen) maxFloorPen = pen;
        floorContactX += px;
        floorHits++;
      }
      if (px < 0) {
        if (-px > maxLeftPen) maxLeftPen = -px;
      } else if (px > rightX) {
        const pen = px - rightX;
        if (pen > maxRightPen) maxRightPen = pen;
      }
    }

    if (floorHits > 0) {
      body.y += maxFloorPen;
      const rx = floorContactX / floorHits - body.x;
      const ry = floorY - body.y;

      const vpx = body.vx - body.omega * ry;
      const vpy = body.vy + body.omega * rx;

      if (vpy < 0) {
        const denom = body.invMass + rx * rx * body.invInertia;
        const e = vpy > -35 ? 0 : body.restitution;
        const jn = (-(1 + e) * vpy) / denom;

        body.vy += jn * body.invMass;
        body.omega += rx * jn * body.invInertia;

        const rCrossT = -ry;
        const denomT = body.invMass + rCrossT * rCrossT * body.invInertia;
        const jt = Math.max(-jn * body.friction, Math.min(jn * body.friction, -vpx / denomT));
        body.vx += jt * body.invMass;
        body.omega += rCrossT * jt * body.invInertia;

        if (floorHits >= 2 && Math.abs(body.vy) < 18) {
          body.omega *= 0.78;
          if (Math.abs(body.omega) < 0.04) body.omega = 0;
          if (Math.abs(body.vx) < 3) body.vx = 0;
        }
      }
    }

    if (maxLeftPen > 0) {
      body.x += maxLeftPen;
      if (body.vx < 0) {
        body.vx = -body.vx * body.restitution;
        body.omega *= 0.9;
      }
    } else if (maxRightPen > 0) {
      body.x -= maxRightPen;
      if (body.vx > 0) {
        body.vx = -body.vx * body.restitution;
        body.omega *= 0.9;
      }
    }
  }

  private acquirePoly(slot: number, body: BondedBody, virtualPixelSize: number): WorldPoly {
    const count = body.pixelIndices.length;
    const isCircle = body.shapeKind === 'circle';
    const radius = body.boundingRadiusGrid * virtualPixelSize;

    let poly = this.polyPool[slot];
    if (!poly) {
      poly = {
        body,
        vx: new Float64Array(Math.max(8, count)),
        vy: new Float64Array(Math.max(8, count)),
        count,
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
        radius,
        isCircle,
      };
      this.polyPool[slot] = poly;
    } else {
      poly.body = body;
      poly.count = count;
      poly.radius = radius;
      poly.isCircle = isCircle;
      if (!isCircle && poly.vx.length < count) {
        poly.vx = new Float64Array(count);
        poly.vy = new Float64Array(count);
      }
    }

    if (isCircle) {
      // O(1) AABB for circles — no per-vertex trig needed!
      poly.minX = body.x - radius;
      poly.maxX = body.x + radius;
      poly.minY = body.y - radius;
      poly.maxY = body.y + radius;
      return poly;
    }

    const cos = Math.cos(body.angle);
    const sin = Math.sin(body.angle);
    const local = body.localOffsets;
    const vx = poly.vx;
    const vy = poly.vy;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < count; i++) {
      const lx = local[i * 2]! * virtualPixelSize;
      const ly = local[i * 2 + 1]! * virtualPixelSize;
      const wx = body.x + lx * cos - ly * sin;
      const wy = body.y + lx * sin + ly * cos;
      vx[i] = wx;
      vy[i] = wy;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }

    poly.minX = minX;
    poly.maxX = maxX;
    poly.minY = minY;
    poly.maxY = maxY;
    return poly;
  }

  private resetPixelGrid(): void {
    const head = this.pixelHead;
    const touched = this.pixelTouched;
    for (let i = 0; i < this.pixelTouchedCount; i++) {
      head[touched[i]!] = -1;
    }
    this.pixelTouchedCount = 0;
  }

  private insertPixel(cx: number, cy: number, pixelIndex: number): void {
    const bucket = hashPixelCell(cx, cy);
    const prev = this.pixelHead[bucket]!;
    if (prev === -1) {
      this.pixelTouched[this.pixelTouchedCount++] = bucket;
    }
    this.pixelNext[pixelIndex] = prev;
    this.pixelHead[bucket] = pixelIndex;
  }

  private resetBodyGrid(): void {
    const head = this.bodyHead;
    const touched = this.bodyTouched;
    for (let i = 0; i < this.bodyTouchedCount; i++) {
      head[touched[i]!] = -1;
    }
    this.bodyTouchedCount = 0;
    this.bodyNodeCount = 0;
  }

  private insertBodyCell(cx: number, cy: number, polySlot: number): void {
    const nodeIdx = this.bodyNodeCount++;
    if (nodeIdx >= this.bodyNext.length) {
      const nextCap = this.bodyNext.length * 2;
      const newNext = new Int32Array(nextCap);
      newNext.set(this.bodyNext);
      this.bodyNext = newNext;
      const newPoly = new Int32Array(nextCap);
      newPoly.set(this.bodyNodePoly);
      this.bodyNodePoly = newPoly;
    }

    const bucket = hashBodyCell(cx, cy);
    const prev = this.bodyHead[bucket]!;
    if (prev === -1) {
      this.bodyTouched[this.bodyTouchedCount++] = bucket;
    }
    this.bodyNodePoly[nodeIdx] = polySlot;
    this.bodyNext[nodeIdx] = prev;
    this.bodyHead[bucket] = nodeIdx;
  }
}

export function syncBodyPixels(ctx: PluginContext, body: BondedBody): void {
  const { store, virtualPixelSize } = ctx;
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const indices = body.pixelIndices;
  const local = body.localOffsets;
  const pos = store.pos;
  const vel = store.vel;

  for (let k = 0; k < indices.length; k++) {
    const idx = indices[k]!;
    const lx = local[k * 2]! * virtualPixelSize;
    const ly = local[k * 2 + 1]! * virtualPixelSize;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;

    pos[idx * 2] = body.x + rx;
    pos[idx * 2 + 1] = body.y + ry;
    vel[idx * 2] = body.vx - body.omega * ry;
    vel[idx * 2 + 1] = body.vy + body.omega * rx;
  }
}

function findSupportVertex(poly: WorldPoly, nx: number, ny: number): { x: number; y: number } {
  let bestDot = -Infinity;
  let bestX = poly.body.x;
  let bestY = poly.body.y;
  const vx = poly.vx;
  const vy = poly.vy;
  for (let i = 0; i < poly.count; i++) {
    const d = vx[i]! * nx + vy[i]! * ny;
    if (d > bestDot) {
      bestDot = d;
      bestX = vx[i]!;
      bestY = vy[i]!;
    }
  }
  return { x: bestX, y: bestY };
}

function hashPixelCell(cx: number, cy: number): number {
  return (((cx * 73856093) ^ (cy * 19349663)) >>> 0) & PIXEL_HASH_MASK;
}

function hashBodyCell(cx: number, cy: number): number {
  return (((cx * 73856093) ^ (cy * 19349663)) >>> 0) & BODY_HASH_MASK;
}
