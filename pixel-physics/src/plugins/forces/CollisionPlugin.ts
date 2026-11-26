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
}

/**
 * Mass-Weighted Solid Collision Interaction Plugin.
 * Resolves:
 *  - Loose Pixel <-> Loose Pixel (spatial hash, mass-weighted impulse + friction)
 *  - Loose Pixel <-> Ground & Walls
 *  - Loose Pixel <-> Vertex-Face Polygon Body (exact closest-edge / inside-polygon contact)
 *  - Vertex-Face Polygon Body <-> Polygon Body (2D Separating Axis Theorem)
 *  - Vertex-Face Polygon Body <-> Ground & Walls (exact vertex contacts with rotation)
 */
export class CollisionPlugin implements InteractionPlugin {
  readonly id = 'collision';
  readonly name = 'Solid Collision';
  readonly category = 'interaction' as const;
  readonly description =
    'Mass-weighted solid collision resolution for pixels and vertex-face polygon bodies.';
  enabled = true;

  private readonly grid = new Map<number, number[]>();
  private readonly cellPool: number[][] = [];
  private readonly iterations = 3;

  resolveInteractions(ctx: PluginContext, _dt: number): void {
    if (!this.enabled) return;

    const { store, bounds, virtualPixelSize } = ctx;
    if (store.activeCount === 0 && store.bodies.size === 0) return;

    const cellSize = Math.max(2, virtualPixelSize);
    const half = virtualPixelSize * 0.5;
    const minDist = virtualPixelSize;
    const minDistSq = minDist * minDist;

    for (let iter = 0; iter < this.iterations; iter++) {
      // 1. Rebuild spatial hash of loose pixels only
      this.clearGrid();
      for (let i = 0; i < store.highWaterMark; i++) {
        if (store.active[i] === 0 || store.bodyId[i] !== -1) continue;
        const cx = Math.floor(store.pos[i * 2]! / cellSize);
        const cy = Math.floor(store.pos[i * 2 + 1]! / cellSize);
        this.insertCell(cx, cy, i);
      }

      // 2. Loose pixel <-> loose pixel collisions
      for (let i = 0; i < store.highWaterMark; i++) {
        if (store.active[i] === 0 || store.bodyId[i] !== -1) continue;
        const xi = store.pos[i * 2]!;
        const yi = store.pos[i * 2 + 1]!;
        const cx = Math.floor(xi / cellSize);
        const cy = Math.floor(yi / cellSize);

        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const bucket = this.grid.get(hashCell(cx + ox, cy + oy));
            if (!bucket) continue;

            for (let b = 0; b < bucket.length; b++) {
              const j = bucket[b]!;
              if (j <= i) continue;
              if (store.active[j] === 0 || store.bodyId[j] !== -1) continue;

              const dx = store.pos[j * 2]! - store.pos[i * 2]!;
              const dy = store.pos[j * 2 + 1]! - store.pos[i * 2 + 1]!;
              const distSq = dx * dx + dy * dy;
              if (distSq >= minDistSq) continue;

              let dist = Math.sqrt(distSq);
              let nx: number;
              let ny: number;
              if (dist < 1e-4) {
                const angle = ((i * 73 + j * 37) % 360) * (Math.PI / 180);
                nx = Math.cos(angle);
                ny = Math.sin(angle);
                dist = 0;
              } else {
                nx = dx / dist;
                ny = dy / dist;
              }

              this.resolveLoosePixelPair(ctx, i, j, nx, ny, minDist - dist);
            }
          }
        }
      }

      // 3. Build world polygons for active bonded bodies
      const polys: WorldPoly[] = [];
      for (const body of store.bodies.values()) {
        if (!body.active || body.pixelIndices.length < 3) continue;
        polys.push(buildWorldPoly(body, virtualPixelSize));
      }

      // 4. Loose pixel <-> vertex-face polygon edge collisions
      for (let p = 0; p < polys.length; p++) {
        const poly = polys[p]!;
        const minC = Math.floor((poly.minX - half) / cellSize);
        const maxC = Math.floor((poly.maxX + half) / cellSize);
        const minR = Math.floor((poly.minY - half) / cellSize);
        const maxR = Math.floor((poly.maxY + half) / cellSize);

        for (let cx = minC; cx <= maxC; cx++) {
          for (let cy = minR; cy <= maxR; cy++) {
            const bucket = this.grid.get(hashCell(cx, cy));
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const idx = bucket[b]!;
              if (store.active[idx] === 0 || store.bodyId[idx] !== -1) continue;
              this.resolvePixelVsPolygon(ctx, idx, half, poly);
            }
          }
        }
      }

      // 5. Polygon body <-> polygon body (2D SAT)
      for (let a = 0; a < polys.length; a++) {
        for (let b = a + 1; b < polys.length; b++) {
          const polyA = polys[a]!;
          const polyB = polys[b]!;
          const dx = polyB.body.x - polyA.body.x;
          const dy = polyB.body.y - polyA.body.y;
          const rSum = polyA.radius + polyB.radius;
          if (dx * dx + dy * dy > rSum * rSum) continue;
          this.resolvePolygonPair(polyA, polyB);
        }
      }

      // 6. Loose pixel <-> ground floor & left/right walls
      for (let i = 0; i < store.highWaterMark; i++) {
        if (store.active[i] === 0 || store.bodyId[i] !== -1) continue;
        const i2 = i * 2;
        const e = store.restitution[i]!;
        const mu = store.friction[i]!;

        const floorY = bounds.groundHeight + half;
        if (store.pos[i2 + 1]! < floorY) {
          store.pos[i2 + 1] = floorY;
          if (store.vel[i2 + 1]! < 0) {
            const vn = store.vel[i2 + 1]!;
            store.vel[i2 + 1] = Math.abs(vn) < 28 ? 0 : -vn * e;
            store.vel[i2] = store.vel[i2]! * Math.max(0, 1 - mu * 0.35);
            if (Math.abs(store.vel[i2]!) < 2) store.vel[i2] = 0;
          }
        }

        if (store.pos[i2]! < half) {
          store.pos[i2] = half;
          if (store.vel[i2]! < 0) store.vel[i2] = -store.vel[i2]! * e;
        }

        if (store.pos[i2]! > bounds.width - half) {
          store.pos[i2] = bounds.width - half;
          if (store.vel[i2]! > 0) store.vel[i2] = -store.vel[i2]! * e;
        }
      }

      // 7. Bonded polygon bodies <-> ground floor & left/right walls
      for (const body of store.bodies.values()) {
        syncBodyPixels(ctx, body);
        this.resolveBodyBoundaries(ctx, body);
        syncBodyPixels(ctx, body);
      }
    }
  }

  private resolveLoosePixelPair(
    ctx: PluginContext,
    i: number,
    j: number,
    nx: number,
    ny: number,
    overlap: number,
  ): void {
    const { store } = ctx;
    const massCh = store.getChannel('mass');
    const massA = Math.max(0.1, massCh ? massCh[i]! : store.meta[i * 4]!);
    const massB = Math.max(0.1, massCh ? massCh[j]! : store.meta[j * 4]!);
    const invMassA = 1 / massA;
    const invMassB = 1 / massB;
    const totalInvMass = invMassA + invMassB;

    const correction = (overlap * 0.72) / totalInvMass;
    store.pos[i * 2] = store.pos[i * 2]! - nx * correction * invMassA;
    store.pos[i * 2 + 1] = store.pos[i * 2 + 1]! - ny * correction * invMassA;
    store.pos[j * 2] = store.pos[j * 2]! + nx * correction * invMassB;
    store.pos[j * 2 + 1] = store.pos[j * 2 + 1]! + ny * correction * invMassB;

    const rvx = store.vel[j * 2]! - store.vel[i * 2]!;
    const rvy = store.vel[j * 2 + 1]! - store.vel[i * 2 + 1]!;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return;

    const e = Math.abs(velAlongNormal) < 30 ? 0 : Math.min(store.restitution[i]!, store.restitution[j]!);
    const jn = (-(1 + e) * velAlongNormal) / totalInvMass;

    store.vel[i * 2] = store.vel[i * 2]! - jn * nx * invMassA;
    store.vel[i * 2 + 1] = store.vel[i * 2 + 1]! - jn * ny * invMassA;
    store.vel[j * 2] = store.vel[j * 2]! + jn * nx * invMassB;
    store.vel[j * 2 + 1] = store.vel[j * 2 + 1]! + jn * ny * invMassB;

    // Tangential friction
    const tx = -ny;
    const ty = nx;
    const velAlongTangent = rvx * tx + rvy * ty;
    const mu = Math.sqrt(store.friction[i]! * store.friction[j]!);
    const jt = Math.max(-jn * mu, Math.min(jn * mu, -velAlongTangent / totalInvMass));

    store.vel[i * 2] = store.vel[i * 2]! - jt * tx * invMassA;
    store.vel[i * 2 + 1] = store.vel[i * 2 + 1]! - jt * ty * invMassA;
    store.vel[j * 2] = store.vel[j * 2]! + jt * tx * invMassB;
    store.vel[j * 2 + 1] = store.vel[j * 2 + 1]! + jt * ty * invMassB;
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

    // Fast AABB reject
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
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = poly.vx[i]!;
      const ay = poly.vy[i]!;
      const bx = poly.vx[j]!;
      const by = poly.vy[j]!;

      const ex = bx - ax;
      const ey = by - ay;
      const lenSq = ex * ex + ey * ey;
      if (lenSq < 1e-8) continue;

      // Outward normal for CCW polygon edge (ax,ay)->(bx,by) is (ey, -ex) normalized
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

    // Normal points from polygon outward toward pixel
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

    const body = poly.body;
    const massCh = store.getChannel('mass');
    const pixelMass = Math.max(0.1, massCh ? massCh[pixelIdx]! : store.meta[pixelIdx * 4]!);
    const invPixelMass = 1 / pixelMass;
    const totalInvMass = invPixelMass + body.invMass;

    // Positional separation
    const corr = (penetration * 0.8) / totalInvMass;
    store.pos[pixelIdx * 2] = px + nx * corr * invPixelMass;
    store.pos[pixelIdx * 2 + 1] = py + ny * corr * invPixelMass;
    body.x -= nx * corr * body.invMass;
    body.y -= ny * corr * body.invMass;

    // Velocity impulse at contact point
    const rx = closestX - body.x;
    const ry = closestY - body.y;
    const vBodyX = body.vx - body.omega * ry;
    const vBodyY = body.vy + body.omega * rx;
    const rvx = store.vel[pixelIdx * 2]! - vBodyX;
    const rvy = store.vel[pixelIdx * 2 + 1]! - vBodyY;

    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return;

    const rCrossN = rx * ny - ry * nx;
    const denom = totalInvMass + rCrossN * rCrossN * body.invInertia;
    const e = Math.abs(velAlongNormal) < 30 ? 0 : Math.min(store.restitution[pixelIdx]!, body.restitution);
    const jn = (-(1 + e) * velAlongNormal) / denom;

    store.vel[pixelIdx * 2] = store.vel[pixelIdx * 2]! + jn * nx * invPixelMass;
    store.vel[pixelIdx * 2 + 1] = store.vel[pixelIdx * 2 + 1]! + jn * ny * invPixelMass;
    body.vx -= jn * nx * body.invMass;
    body.vy -= jn * ny * body.invMass;
    body.omega -= rCrossN * jn * body.invInertia;

    // Tangential friction
    const tx = -ny;
    const ty = nx;
    const velAlongTangent = rvx * tx + rvy * ty;
    const rCrossT = rx * ty - ry * tx;
    const denomT = totalInvMass + rCrossT * rCrossT * body.invInertia;
    const mu = Math.sqrt(store.friction[pixelIdx]! * body.friction);
    const jt = Math.max(-jn * mu, Math.min(jn * mu, -velAlongTangent / denomT));

    store.vel[pixelIdx * 2] = store.vel[pixelIdx * 2]! + jt * tx * invPixelMass;
    store.vel[pixelIdx * 2 + 1] = store.vel[pixelIdx * 2 + 1]! + jt * ty * invPixelMass;
    body.vx -= jt * tx * body.invMass;
    body.vy -= jt * ty * body.invMass;
    body.omega -= rCrossT * jt * body.invInertia;
  }

  private resolvePolygonPair(polyA: WorldPoly, polyB: WorldPoly): void {
    let minOverlap = Infinity;
    let bestNx = 0;
    let bestNy = 0;

    // Check SAT axes from both convex polygons
    const checkAxes = (src: WorldPoly): boolean => {
      const n = src.count;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ex = src.vx[j]! - src.vx[i]!;
        const ey = src.vy[j]! - src.vy[i]!;
        const len = Math.hypot(ex, ey);
        if (len < 1e-6) continue;
        const nx = ey / len;
        const ny = -ex / len;

        const [minA, maxA] = projectPoly(polyA, nx, ny);
        const [minB, maxB] = projectPoly(polyB, nx, ny);
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

    // Orient normal from A -> B
    const centerDx = bodyB.x - bodyA.x;
    const centerDy = bodyB.y - bodyA.y;
    if (centerDx * bestNx + centerDy * bestNy < 0) {
      bestNx = -bestNx;
      bestNy = -bestNy;
    }

    const totalInvMass = bodyA.invMass + bodyB.invMass;
    const corr = (minOverlap * 0.78) / totalInvMass;
    bodyA.x -= bestNx * corr * bodyA.invMass;
    bodyA.y -= bestNy * corr * bodyA.invMass;
    bodyB.x += bestNx * corr * bodyB.invMass;
    bodyB.y += bestNy * corr * bodyB.invMass;

    // Estimate contact point as average of deepest support vertices along MTV
    const supportA = findSupportVertex(polyA, bestNx, bestNy);
    const supportB = findSupportVertex(polyB, -bestNx, -bestNy);
    const contactX = (supportA.x + supportB.x) * 0.5;
    const contactY = (supportA.y + supportB.y) * 0.5;

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
    const velAlongNormal = rvx * bestNx + rvy * bestNy;
    if (velAlongNormal > 0) return;

    const rACrossN = rAx * bestNy - rAy * bestNx;
    const rBCrossN = rBx * bestNy - rBy * bestNx;
    const denom =
      totalInvMass +
      rACrossN * rACrossN * bodyA.invInertia +
      rBCrossN * rBCrossN * bodyB.invInertia;

    const e = Math.abs(velAlongNormal) < 35 ? 0 : Math.min(bodyA.restitution, bodyB.restitution);
    const jn = (-(1 + e) * velAlongNormal) / denom;

    bodyA.vx -= jn * bestNx * bodyA.invMass;
    bodyA.vy -= jn * bestNy * bodyA.invMass;
    bodyA.omega -= rACrossN * jn * bodyA.invInertia;

    bodyB.vx += jn * bestNx * bodyB.invMass;
    bodyB.vy += jn * bestNy * bodyB.invMass;
    bodyB.omega += rBCrossN * jn * bodyB.invInertia;

    // Tangential friction
    const tx = -bestNy;
    const ty = bestNx;
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

  private resolveBodyBoundaries(ctx: PluginContext, body: BondedBody): void {
    const { store, bounds } = ctx;
    const floorY = bounds.groundHeight;
    const leftX = 0;
    const rightX = bounds.width;

    let maxFloorPen = 0;
    let floorContactX = 0;
    let floorHits = 0;

    let maxLeftPen = 0;
    let maxRightPen = 0;

    for (let k = 0; k < body.pixelIndices.length; k++) {
      const idx = body.pixelIndices[k]!;
      const px = store.pos[idx * 2]!;
      const py = store.pos[idx * 2 + 1]!;

      if (py < floorY) {
        const pen = floorY - py;
        if (pen > maxFloorPen) maxFloorPen = pen;
        floorContactX += px;
        floorHits++;
      }
      if (px < leftX) {
        const pen = leftX - px;
        if (pen > maxLeftPen) maxLeftPen = pen;
      }
      if (px > rightX) {
        const pen = px - rightX;
        if (pen > maxRightPen) maxRightPen = pen;
      }
    }

    if (floorHits > 0) {
      body.y += maxFloorPen;
      const cx = floorContactX / floorHits;
      const cy = floorY;
      const rx = cx - body.x;
      const ry = cy - body.y;

      const vpx = body.vx - body.omega * ry;
      const vpy = body.vy + body.omega * rx;

      if (vpy < 0) {
        const rCrossN = rx;
        const denom = body.invMass + rCrossN * rCrossN * body.invInertia;
        const e = Math.abs(vpy) < 35 ? 0 : body.restitution;
        const jn = (-(1 + e) * vpy) / denom;

        body.vy += jn * body.invMass;
        body.omega += rCrossN * jn * body.invInertia;

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
    }

    if (maxRightPen > 0) {
      body.x -= maxRightPen;
      if (body.vx > 0) {
        body.vx = -body.vx * body.restitution;
        body.omega *= 0.9;
      }
    }
  }

  private clearGrid(): void {
    for (const bucket of this.grid.values()) {
      bucket.length = 0;
      this.cellPool.push(bucket);
    }
    this.grid.clear();
  }

  private insertCell(cx: number, cy: number, pixelIndex: number): void {
    const key = hashCell(cx, cy);
    let bucket = this.grid.get(key);
    if (!bucket) {
      bucket = this.cellPool.pop() ?? [];
      this.grid.set(key, bucket);
    }
    bucket.push(pixelIndex);
  }
}

export function syncBodyPixels(ctx: PluginContext, body: BondedBody): void {
  const { store, virtualPixelSize } = ctx;
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);

  for (let k = 0; k < body.pixelIndices.length; k++) {
    const idx = body.pixelIndices[k]!;
    const lx = body.localOffsets[k * 2]! * virtualPixelSize;
    const ly = body.localOffsets[k * 2 + 1]! * virtualPixelSize;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;

    store.pos[idx * 2] = body.x + rx;
    store.pos[idx * 2 + 1] = body.y + ry;
    store.vel[idx * 2] = body.vx - body.omega * ry;
    store.vel[idx * 2 + 1] = body.vy + body.omega * rx;
  }
}

function buildWorldPoly(body: BondedBody, virtualPixelSize: number): WorldPoly {
  const count = body.pixelIndices.length;
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < count; i++) {
    const lx = body.localOffsets[i * 2]! * virtualPixelSize;
    const ly = body.localOffsets[i * 2 + 1]! * virtualPixelSize;
    const wx = body.x + lx * cos - ly * sin;
    const wy = body.y + lx * sin + ly * cos;
    vx[i] = wx;
    vy[i] = wy;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }

  return {
    body,
    vx,
    vy,
    count,
    minX,
    maxX,
    minY,
    maxY,
    radius: body.boundingRadiusGrid * virtualPixelSize,
  };
}

function projectPoly(poly: WorldPoly, nx: number, ny: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < poly.count; i++) {
    const p = poly.vx[i]! * nx + poly.vy[i]! * ny;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

function findSupportVertex(poly: WorldPoly, nx: number, ny: number): { x: number; y: number } {
  let bestDot = -Infinity;
  let bestX = poly.body.x;
  let bestY = poly.body.y;
  for (let i = 0; i < poly.count; i++) {
    const d = poly.vx[i]! * nx + poly.vy[i]! * ny;
    if (d > bestDot) {
      bestDot = d;
      bestX = poly.vx[i]!;
      bestY = poly.vy[i]!;
    }
  }
  return { x: bestX, y: bestY };
}

function hashCell(cx: number, cy: number): number {
  return ((cx + 32768) << 16) ^ (cy + 32768);
}
