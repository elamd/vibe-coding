import type { BondedBody, IPixelStore, RGBAColor, WorldBounds } from './types.ts';

export const DEFAULT_MAX_PIXELS = 131072;

/**
 * Structure-of-Arrays (SoA) pixel store shared between CPU plugins and
 * GPU TSL StorageBufferAttributes.
 */
export class PixelStore implements IPixelStore {
  readonly maxPixels: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly renderPos: Float32Array;
  readonly color: Float32Array;
  /** Packed vec4 per pixel: [mass, active (0|1), bodyId, kineticGlow] */
  readonly meta: Float32Array;
  readonly active: Uint8Array;
  readonly bodyId: Int32Array;
  readonly density: Float32Array;
  readonly restitution: Float32Array;
  readonly friction: Float32Array;

  readonly bodies = new Map<number, BondedBody>();

  private readonly channels = new Map<string, Float32Array>();
  private readonly channelDefaults = new Map<string, number>();
  private readonly freeList: number[] = [];
  private _activeCount = 0;
  private _highWaterMark = 0;
  private _topologyVersion = 0;
  private nextBodyId = 1;
  private dirty = true;
  private colorDirty = true;

  constructor(maxPixels = DEFAULT_MAX_PIXELS) {
    this.maxPixels = maxPixels;
    this.pos = new Float32Array(maxPixels * 2);
    this.vel = new Float32Array(maxPixels * 2);
    this.renderPos = new Float32Array(maxPixels * 2);
    this.color = new Float32Array(maxPixels * 4);
    this.meta = new Float32Array(maxPixels * 4);
    this.active = new Uint8Array(maxPixels);
    this.bodyId = new Int32Array(maxPixels);
    this.density = new Float32Array(maxPixels);
    this.restitution = new Float32Array(maxPixels);
    this.friction = new Float32Array(maxPixels);

    this.bodyId.fill(-1);
    this.density.fill(1.0);
    this.restitution.fill(0.28);
    this.friction.fill(0.45);
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get highWaterMark(): number {
    return this._highWaterMark;
  }

  get topologyVersion(): number {
    return this._topologyVersion;
  }

  registerChannel(name: string, defaultValue: number): Float32Array {
    const existing = this.channels.get(name);
    if (existing) return existing;
    const arr = new Float32Array(this.maxPixels);
    arr.fill(defaultValue);
    this.channels.set(name, arr);
    this.channelDefaults.set(name, defaultValue);
    return arr;
  }

  getChannel(name: string): Float32Array | undefined {
    return this.channels.get(name);
  }

  allocatePixel(params: {
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    mass: number;
    density?: number;
    restitution?: number;
    friction?: number;
    color: RGBAColor;
    bodyId?: number;
  }): number {
    let idx: number;
    if (this.freeList.length > 0) {
      idx = this.freeList.pop()!;
    } else if (this._highWaterMark < this.maxPixels) {
      idx = this._highWaterMark++;
    } else {
      return -1;
    }

    const i2 = idx * 2;
    const i4 = idx * 4;

    this.pos[i2] = params.x;
    this.pos[i2 + 1] = params.y;
    this.renderPos[i2] = params.x;
    this.renderPos[i2 + 1] = params.y;
    this.vel[i2] = params.vx ?? 0;
    this.vel[i2 + 1] = params.vy ?? 0;

    this.color[i4] = params.color.r;
    this.color[i4 + 1] = params.color.g;
    this.color[i4 + 2] = params.color.b;
    this.color[i4 + 3] = params.color.a;

    this.active[idx] = 1;
    this.bodyId[idx] = params.bodyId ?? -1;
    this.density[idx] = params.density ?? 1.0;
    this.restitution[idx] = params.restitution ?? 0.28;
    this.friction[idx] = params.friction ?? 0.45;

    this.meta[i4] = params.mass;
    this.meta[i4 + 1] = 1;
    this.meta[i4 + 2] = params.bodyId ?? -1;
    this.meta[i4 + 3] = 0;

    // Initialize registered property channels
    for (const [key, arr] of this.channels) {
      if (key === 'mass') {
        arr[idx] = params.mass;
      } else {
        arr[idx] = this.channelDefaults.get(key) ?? 0;
      }
    }

    this._activeCount++;
    this._topologyVersion++;
    this.dirty = true;
    this.colorDirty = true;
    return idx;
  }

  freePixel(index: number): void {
    if (index < 0 || index >= this._highWaterMark || this.active[index] === 0) return;

    this.active[index] = 0;
    this.bodyId[index] = -1;

    const i4 = index * 4;
    this.meta[i4] = 0;
    this.meta[i4 + 1] = 0;
    this.meta[i4 + 2] = -1;
    this.meta[i4 + 3] = 0;

    this.freeList.push(index);
    this._activeCount--;
    this._topologyVersion++;
    this.dirty = true;
  }

  createBondedBody(params: {
    pluginId: string;
    shapeKind?: 'polygon' | 'circle';
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    localOffsets: Float32Array;
    pixelIndices: number[];
    virtualPixelSize: number;
    color: RGBAColor;
    density?: number;
    restitution?: number;
    friction?: number;
  }): BondedBody {
    const id = this.nextBodyId++;
    let maxR = 0.5;
    for (let i = 0; i < params.pixelIndices.length; i++) {
      const rx = params.localOffsets[i * 2]!;
      const ry = params.localOffsets[i * 2 + 1]!;
      const r = Math.hypot(rx, ry);
      if (r > maxR) maxR = r;
    }

    const body: BondedBody = {
      id,
      pluginId: params.pluginId,
      shapeKind: params.shapeKind ?? 'polygon',
      pixelIndices: params.pixelIndices,
      localOffsets: params.localOffsets,
      color: { ...params.color },
      density: params.density ?? 1.0,
      boundingRadiusGrid: maxR,
      x: params.x,
      y: params.y,
      vx: params.vx ?? 0,
      vy: params.vy ?? 0,
      angle: 0,
      omega: 0,
      totalMass: 1,
      invMass: 1,
      inertia: 1,
      invInertia: 1,
      restitution: params.restitution ?? 0.25,
      friction: params.friction ?? 0.5,
      active: true,
    };

    for (const idx of params.pixelIndices) {
      this.bodyId[idx] = id;
      this.meta[idx * 4 + 2] = id;
    }

    this.recomputeBodyMassProperties(body, params.virtualPixelSize);
    this.bodies.set(id, body);
    this._topologyVersion++;
    this.dirty = true;
    return body;
  }

  recomputeBodyMassProperties(body: BondedBody, virtualPixelSize: number): void {
    const n = body.pixelIndices.length;
    if (n >= 3) {
      // Exact 2D polygon area and moment of inertia from its CCW vertices
      let area2 = 0;
      let inertiaNumer = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = body.localOffsets[i * 2]! * virtualPixelSize;
        const ay = body.localOffsets[i * 2 + 1]! * virtualPixelSize;
        const bx = body.localOffsets[j * 2]! * virtualPixelSize;
        const by = body.localOffsets[j * 2 + 1]! * virtualPixelSize;
        const cross = Math.abs(ax * by - ay * bx);
        area2 += cross;
        inertiaNumer += cross * (ax * ax + ax * bx + bx * bx + ay * ay + ay * by + by * by);
      }

      const polygonArea = Math.max(virtualPixelSize * virtualPixelSize, area2 * 0.5);
      const totalMass = Math.max(1e-4, polygonArea * body.density);
      const inertia = area2 > 1e-4 ? (totalMass * inertiaNumer) / (6 * area2) : totalMass * virtualPixelSize * virtualPixelSize;

      body.totalMass = totalMass;
      body.invMass = 1 / totalMass;
      body.inertia = Math.max(1e-2, inertia);
      body.invInertia = 1 / body.inertia;
      return;
    }

    const massChannel = this.channels.get('mass');
    let totalMass = 0;
    let inertia = 0;
    for (let i = 0; i < n; i++) {
      const idx = body.pixelIndices[i]!;
      const m = massChannel ? massChannel[idx]! : Math.max(1, this.meta[idx * 4]!);
      const rx = body.localOffsets[i * 2]! * virtualPixelSize;
      const ry = body.localOffsets[i * 2 + 1]! * virtualPixelSize;
      totalMass += m;
      inertia += m * (rx * rx + ry * ry + (virtualPixelSize * virtualPixelSize) / 6);
    }

    body.totalMass = Math.max(1e-4, totalMass);
    body.invMass = 1 / body.totalMass;
    body.inertia = Math.max(1e-2, inertia);
    body.invInertia = 1 / body.inertia;
  }

  dissolveAllBodies(): void {
    for (const body of this.bodies.values()) {
      for (const idx of body.pixelIndices) {
        if (this.active[idx] === 1) {
          this.bodyId[idx] = -1;
          this.meta[idx * 4 + 2] = -1;
        }
      }
    }
    this.bodies.clear();
    this._topologyVersion++;
    this.dirty = true;
  }

  clear(): void {
    const hwm = this._highWaterMark;
    this.active.fill(0, 0, hwm);
    this.bodyId.fill(-1, 0, hwm);
    this.pos.fill(0, 0, hwm * 2);
    this.vel.fill(0, 0, hwm * 2);
    this.renderPos.fill(0, 0, hwm * 2);
    this.color.fill(0, 0, hwm * 4);
    this.meta.fill(0, 0, hwm * 4);
    for (const [key, arr] of this.channels) {
      arr.fill(this.channelDefaults.get(key) ?? 0, 0, hwm);
    }
    this.bodies.clear();
    this.freeList.length = 0;
    this._activeCount = 0;
    this._highWaterMark = 0;
    this._topologyVersion++;
    this.nextBodyId = 1;
    this.dirty = true;
    this.colorDirty = true;
  }

  countVisible(bounds: WorldBounds, virtualPixelSize: number): number {
    const half = virtualPixelSize * 0.5;
    let count = 0;
    for (let i = 0; i < this._highWaterMark; i++) {
      if (this.active[i] === 0) continue;
      const x = this.pos[i * 2]!;
      const y = this.pos[i * 2 + 1]!;
      if (
        x + half >= 0 &&
        x - half <= bounds.width &&
        y + half >= 0 &&
        y - half <= bounds.height
      ) {
        count++;
      }
    }
    return count;
  }

  /** Synchronize CPU mass/meta and update renderPos for active loose pixels */
  syncPackedMetadata(snapToGrid: boolean, virtualPixelSize: number, groundHeight: number): void {
    const massChannel = this.channels.get('mass');
    const half = virtualPixelSize * 0.5;
    const invN = 1 / virtualPixelSize;
    const hwm = this._highWaterMark;
    const active = this.active;
    const bodyId = this.bodyId;
    const pos = this.pos;
    const vel = this.vel;
    const renderPos = this.renderPos;
    const meta = this.meta;

    for (let i = 0; i < hwm; i++) {
      const i4 = i * 4;
      if (active[i] === 0) {
        meta[i4 + 1] = 0;
        continue;
      }

      const bId = bodyId[i]!;
      meta[i4 + 1] = 1;
      meta[i4 + 2] = bId;
      if (massChannel) {
        meta[i4] = massChannel[i]!;
      }

      // Bonded body vertices are rendered via the batched face mesh; skip loose-pixel glow/snap math
      if (bId !== -1) continue;

      const i2 = i * 2;
      const vx = vel[i2]!;
      const vy = vel[i2 + 1]!;
      const speedSq = vx * vx + vy * vy;
      meta[i4 + 3] = speedSq > 4 ? Math.min(1, Math.sqrt(speedSq) * (1 / 750)) : 0;

      let rx = pos[i2]!;
      let ry = pos[i2 + 1]!;
      if (snapToGrid) {
        rx = Math.floor(rx * invN) * virtualPixelSize + half;
        const gy = Math.floor((ry - groundHeight) * invN);
        ry = groundHeight + (gy > 0 ? gy : 0) * virtualPixelSize + half;
      }
      renderPos[i2] = rx;
      renderPos[i2 + 1] = ry;
    }
    this.dirty = true;
  }

  /** Fast O(k) metadata sync for freshly spawned pixel indices */
  syncPixelIndices(
    indices: number[],
    snapToGrid: boolean,
    virtualPixelSize: number,
    groundHeight: number,
  ): void {
    const half = virtualPixelSize * 0.5;
    const invN = 1 / virtualPixelSize;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]!;
      if (this.active[i] === 0) continue;
      const i2 = i * 2;
      let rx = this.pos[i2]!;
      let ry = this.pos[i2 + 1]!;
      if (snapToGrid) {
        rx = Math.floor(rx * invN) * virtualPixelSize + half;
        const gy = Math.floor((ry - groundHeight) * invN);
        ry = groundHeight + (gy > 0 ? gy : 0) * virtualPixelSize + half;
      }
      this.renderPos[i2] = rx;
      this.renderPos[i2 + 1] = ry;
    }
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  consumeDirty(): boolean {
    const wasDirty = this.dirty;
    this.dirty = false;
    return wasDirty;
  }

  consumeColorDirty(): boolean {
    const wasDirty = this.colorDirty;
    this.colorDirty = false;
    return wasDirty;
  }
}
