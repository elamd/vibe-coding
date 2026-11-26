import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  PostProcessing,
  Scene,
  Vector2,
  WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  float,
  length,
  max,
  mix,
  pass,
  positionLocal,
  screenUV,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { PhysicsEngine } from '../engine/PhysicsEngine.ts';
import { TSLComputePipeline } from '../engine/TSLComputePipeline.ts';
import type { SceneObjectPlugin, ShapeFootprintCell, ShapeVertex } from '../engine/types.ts';

const INITIAL_FACE_VERT_CAPACITY = 98304; // Supports ~16,000+ squares or ~1,800+ circles in 1 draw call
const INITIAL_EDGE_VERT_CAPACITY = 131072;

/**
 * Three.js WebGPU + TSL Renderer with:
 *  - Hybrid GPU TSL compute shader execution (dynamic active dispatch + partial buffer uploads)
 *  - Zero-copy instanced rendering for loose virtual pixels via TSL NodeMaterials (1 draw call)
 *  - Batched triangulated vertex-face mesh + batched glowing edge lines for ALL composite shapes (2 draw calls total!)
 *  - Crisp Phosphor CRT post-processing: TSL Bloom + subtle scanlines + light vignette (no curvature)
 *  - Glowing phosphor ground floor bar & live vertex-outline reticle
 */
export class PixelPhysicsRenderer {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  readonly pipeline: TSLComputePipeline;

  private readonly engine: PhysicsEngine;
  private readonly postProcessing: PostProcessing;
  private readonly pixelMesh: Mesh;
  private readonly pixelGeometry: InstancedBufferGeometry;

  // Batched vertex-face buffers (1 draw call for all polygon faces + 1 draw call for all glowing edges)
  private readonly batchedFaceGeo: BufferGeometry;
  private readonly batchedFaceMat: MeshBasicNodeMaterial;
  private readonly batchedFaceMesh: Mesh;
  private facePositions: Float32Array;
  private faceColors: Float32Array;
  private facePosAttr: BufferAttribute;
  private faceColorAttr: BufferAttribute;

  private readonly batchedEdgeGeo: BufferGeometry;
  private readonly batchedEdgeMat: LineBasicMaterial;
  private readonly batchedEdgeLines: LineSegments;
  private edgePositions: Float32Array;
  private edgeColors: Float32Array;
  private edgePosAttr: BufferAttribute;
  private edgeColorAttr: BufferAttribute;

  private readonly groundMesh: Mesh;
  private readonly reticleGroup: Group;
  private readonly reticleCrosshair: LineSegments;
  private readonly reticleFootprintMesh: LineSegments;
  private readonly reticleCrosshairMat: LineBasicMaterial;
  private readonly reticleFootprintMat: LineBasicMaterial;

  private readonly uResolution = uniform(new Vector2(1280, 720));
  private readonly uGroundTime = uniform(0.0);
  private readonly uGroundWidth = uniform(1280.0);

  private isWebGPU = false;
  private initialized = false;
  private disposed = false;
  private lastReticleShapeId = '';
  private lastReticlePixelSize = -1;

  constructor(canvas: HTMLCanvasElement, engine: PhysicsEngine) {
    this.engine = engine;
    const { width, height } = engine.worldBounds;

    this.renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(new Color(0x04080d), 1);

    this.scene = new Scene();
    this.camera = new OrthographicCamera(0, width, height, 0, -100, 100);
    this.camera.position.z = 10;

    this.pipeline = new TSLComputePipeline(engine.store);
    this.pipeline.rebuildPluginPasses(engine.registry.getAll());
    engine.onPluginsChanged(() => {
      this.pipeline.rebuildPluginPasses(engine.registry.getAll());
    });

    // 1. Instanced Virtual Pixel Mesh (loose standalone pixels only — 1 draw call)
    const baseQuad = new PlaneGeometry(1, 1);
    this.pixelGeometry = new InstancedBufferGeometry();
    this.pixelGeometry.index = baseQuad.index;
    this.pixelGeometry.setAttribute('position', baseQuad.attributes.position);
    this.pixelGeometry.setAttribute('uv', baseQuad.attributes.uv);
    this.pixelGeometry.setAttribute('aRenderPos', this.pipeline.renderPosAttribute);
    this.pixelGeometry.setAttribute('aColor', this.pipeline.colorAttribute);
    this.pixelGeometry.setAttribute('aMeta', this.pipeline.metaAttribute);
    this.pixelGeometry.instanceCount = 0;

    const aRenderPos = attribute('aRenderPos', 'vec2');
    const aColor = attribute('aColor', 'vec4');
    const aMeta = attribute('aMeta', 'vec4');
    const uPixelSize = this.pipeline.uPixelSize;

    const pixelMat = new MeshBasicNodeMaterial({
      transparent: false,
      depthTest: false,
      depthWrite: false,
    });

    const isLoose = aMeta.z.lessThan(0.0).select(float(1.0), float(0.0));
    const isVisiblePixel = aMeta.y.mul(isLoose);
    const cellGap = smoothstep(float(2.0), float(5.0), uPixelSize).mul(0.08);
    const visualScale = uPixelSize.mul(float(1.0).sub(cellGap)).mul(isVisiblePixel);
    const worldXY = aRenderPos.add(positionLocal.xy.mul(visualScale));
    pixelMat.positionNode = vec3(worldXY.x, worldXY.y, float(0.0));

    const localUV = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const edgeDist = max(abs(localUV.x), abs(localUV.y));
    const coreBoost = float(1.18).sub(smoothstep(float(0.0), float(0.95), edgeDist).mul(0.28));
    const kineticBoost = float(1.0).add(aMeta.w.mul(0.55));
    const phosphorRGB = aColor.rgb.mul(coreBoost).mul(kineticBoost);
    pixelMat.colorNode = vec4(phosphorRGB, float(1.0));

    this.pixelMesh = new Mesh(this.pixelGeometry, pixelMat);
    this.pixelMesh.frustumCulled = false;
    this.pixelMesh.renderOrder = 2;
    this.scene.add(this.pixelMesh);

    // 2. Single Batched Vertex-Face Mesh for ALL composite shapes (1 draw call!)
    this.facePositions = new Float32Array(INITIAL_FACE_VERT_CAPACITY * 3);
    this.faceColors = new Float32Array(INITIAL_FACE_VERT_CAPACITY * 3);
    this.facePosAttr = new BufferAttribute(this.facePositions, 3);
    this.facePosAttr.setUsage(DynamicDrawUsage);
    this.faceColorAttr = new BufferAttribute(this.faceColors, 3);
    this.faceColorAttr.setUsage(DynamicDrawUsage);

    this.batchedFaceGeo = new BufferGeometry();
    this.batchedFaceGeo.setAttribute('position', this.facePosAttr);
    this.batchedFaceGeo.setAttribute('aFaceColor', this.faceColorAttr);
    this.batchedFaceGeo.setDrawRange(0, 0);

    this.batchedFaceMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const aFaceColor = attribute('aFaceColor', 'vec3');
    this.batchedFaceMat.colorNode = vec4(aFaceColor, float(0.86));

    this.batchedFaceMesh = new Mesh(this.batchedFaceGeo, this.batchedFaceMat);
    this.batchedFaceMesh.frustumCulled = false;
    this.batchedFaceMesh.renderOrder = 3;
    this.scene.add(this.batchedFaceMesh);

    // 3. Single Batched Glowing Edge LineSegments for ALL composite shapes (1 draw call!)
    this.edgePositions = new Float32Array(INITIAL_EDGE_VERT_CAPACITY * 3);
    this.edgeColors = new Float32Array(INITIAL_EDGE_VERT_CAPACITY * 3);
    this.edgePosAttr = new BufferAttribute(this.edgePositions, 3);
    this.edgePosAttr.setUsage(DynamicDrawUsage);
    this.edgeColorAttr = new BufferAttribute(this.edgeColors, 3);
    this.edgeColorAttr.setUsage(DynamicDrawUsage);

    this.batchedEdgeGeo = new BufferGeometry();
    this.batchedEdgeGeo.setAttribute('position', this.edgePosAttr);
    this.batchedEdgeGeo.setAttribute('color', this.edgeColorAttr);
    this.batchedEdgeGeo.setDrawRange(0, 0);

    this.batchedEdgeMat = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.96,
      blending: AdditiveBlending,
      depthTest: false,
    });

    this.batchedEdgeLines = new LineSegments(this.batchedEdgeGeo, this.batchedEdgeMat);
    this.batchedEdgeLines.frustumCulled = false;
    this.batchedEdgeLines.renderOrder = 4;
    this.scene.add(this.batchedEdgeLines);

    // 4. Glowing Phosphor Ground Floor Bar
    const groundMat = new MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
    });
    const gUv = uv();
    const topEdgeGlow = smoothstep(float(0.76), float(1.0), gUv.y);
    const fineGrid = smoothstep(
      float(0.88),
      float(0.98),
      abs(sin(gUv.x.mul(this.uGroundWidth.div(16.0)).mul(Math.PI))),
    ).mul(0.18);
    const baseFloor = vec3(0.04, 0.14, 0.17).add(vec3(0.04, 0.16, 0.18).mul(fineGrid));
    const horizonColor = vec3(0.26, 0.98, 0.88);
    const floorRGB = mix(baseFloor, horizonColor, topEdgeGlow);
    groundMat.colorNode = vec4(floorRGB, float(1.0));

    this.groundMesh = new Mesh(new PlaneGeometry(1, 1), groundMat);
    this.groundMesh.frustumCulled = false;
    this.groundMesh.renderOrder = 1;
    this.scene.add(this.groundMesh);
    this.updateGroundTransform();

    // 5. Glowing Reticle (Crosshair + Live Shape Vertex/Footprint Outline)
    this.reticleGroup = new Group();
    this.reticleGroup.visible = false;
    this.reticleGroup.renderOrder = 5;

    this.reticleCrosshairMat = new LineBasicMaterial({
      color: 0x5efce8,
      transparent: true,
      opacity: 0.92,
      blending: AdditiveBlending,
      depthTest: false,
    });
    this.reticleCrosshair = new LineSegments(createCrosshairGeometry(), this.reticleCrosshairMat);
    this.reticleGroup.add(this.reticleCrosshair);

    this.reticleFootprintMat = new LineBasicMaterial({
      color: 0x5efce8,
      transparent: true,
      opacity: 0.78,
      blending: AdditiveBlending,
      depthTest: false,
    });
    this.reticleFootprintMesh = new LineSegments(new BufferGeometry(), this.reticleFootprintMat);
    this.reticleGroup.add(this.reticleFootprintMesh);

    this.scene.add(this.reticleGroup);

    // 6. Crisp Phosphor CRT TSL Post-Processing (Bloom + Subtle Scanlines + Soft Vignette, No Curvature)
    const scenePass = pass(this.scene, this.camera);
    const sceneColor = scenePass.getTextureNode('output');
    const bloomPass = bloom(sceneColor, 0.55, 0.42, 0.14);

    const combined = sceneColor.rgb.add(bloomPass.rgb);

    const scanPhase = screenUV.y.mul(this.uResolution.y).mul(Math.PI);
    const scanMask = float(1.0).sub(sin(scanPhase).mul(0.5).add(0.5).mul(0.075));

    const centered = screenUV.sub(vec2(0.5, 0.5)).mul(vec2(1.15, 1.0));
    const vigDist = length(centered);
    const vignette = float(1.0).sub(smoothstep(float(0.45), float(0.95), vigDist).mul(0.28));

    const crtRGB = clamp(combined.mul(scanMask).mul(vignette), float(0.0), float(2.5));

    this.postProcessing = new PostProcessing(this.renderer);
    this.postProcessing.outputNode = vec4(crtRGB, float(1.0));

    this.uResolution.value.set(width, height);
    this.uGroundWidth.value = width;
  }

  async init(): Promise<{ backend: 'webgpu' | 'webgl2' }> {
    if (this.initialized) {
      return { backend: this.isWebGPU ? 'webgpu' : 'webgl2' };
    }
    await this.renderer.init();
    const backendObj = this.renderer.backend as { isWebGPUBackend?: boolean } | undefined;
    this.isWebGPU = Boolean(backendObj?.isWebGPUBackend);
    this.initialized = true;
    return { backend: this.isWebGPU ? 'webgpu' : 'webgl2' };
  }

  get backendLabel(): 'WebGPU + TSL' | 'WebGL2 + TSL' {
    return this.isWebGPU ? 'WebGPU + TSL' : 'WebGL2 + TSL';
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.renderer.setSize(width, height, false);
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();

    this.uResolution.value.set(width, height);
    this.uGroundWidth.value = width;
    this.updateGroundTransform();
  }

  updateReticle(params: {
    visible: boolean;
    worldX: number;
    worldY: number;
    snapToGrid: boolean;
  }): void {
    this.reticleGroup.visible = params.visible;
    if (!params.visible) return;

    const n = this.engine.virtualPixelSize;
    const half = n * 0.5;
    const { width, groundHeight } = this.engine.worldBounds;

    let rx = Math.min(width - half, Math.max(half, params.worldX));
    let ry = Math.max(groundHeight + half, params.worldY);

    if (params.snapToGrid) {
      rx = Math.floor(rx / n) * n + half;
      ry = groundHeight + Math.max(0, Math.floor((ry - groundHeight) / n)) * n + half;
    }

    this.reticleGroup.position.set(rx, ry, 2);

    const activeShape = this.engine.getActiveShape();
    const shapeId = activeShape?.id ?? 'pixel';
    if (shapeId !== this.lastReticleShapeId || n !== this.lastReticlePixelSize) {
      this.lastReticleShapeId = shapeId;
      this.lastReticlePixelSize = n;

      this.reticleFootprintMesh.geometry.dispose();
      const verts = activeShape?.getVertices?.();
      if (verts && verts.length >= 3) {
        this.reticleFootprintMesh.geometry = createVertexOutlineGeometry(verts, n);
      } else {
        const footprint = activeShape?.getFootprint() ?? [{ gx: 0, gy: 0 }];
        this.reticleFootprintMesh.geometry = createFootprintGeometry(footprint, n);
      }

      if (activeShape) {
        const c = activeShape.defaultColor;
        this.reticleFootprintMat.color.setRGB(c.r, c.g, c.b);
        this.reticleCrosshairMat.color.setRGB(
          Math.min(1, c.r + 0.25),
          Math.min(1, c.g + 0.25),
          Math.min(1, c.b + 0.25),
        );
      }
    }
  }

  render(dt: number): void {
    if (!this.initialized || this.disposed) return;

    const solver = this.engine.getActiveSolver();
    const snapToGrid = solver?.snapVisualsToGrid ?? false;
    const hwm = this.engine.store.highWaterMark;

    this.uGroundTime.value = this.engine.elapsedTime;
    this.pipeline.updateUniforms({
      virtualPixelSize: this.engine.virtualPixelSize,
      snapToGrid,
      dt,
      gravityY: this.engine.getGravityY(),
      bounds: this.engine.worldBounds,
      activeCount: this.engine.store.activeCount,
      time: this.engine.elapsedTime,
    });

    if (this.engine.store.consumeDirty()) {
      const includeColors = this.engine.store.consumeColorDirty();
      this.pipeline.uploadDirtyBuffers(hwm, includeColors);
    }

    this.rebuildBatchedBodyFaces(snapToGrid);
    this.pixelGeometry.instanceCount = hwm;

    if (this.isWebGPU && hwm > 0) {
      this.renderer.compute(this.pipeline.getComputePasses(hwm));
    }

    this.postProcessing.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batchedFaceGeo.dispose();
    this.batchedFaceMat.dispose();
    this.batchedEdgeGeo.dispose();
    this.batchedEdgeMat.dispose();
    this.pixelGeometry.dispose();
    this.groundMesh.geometry.dispose();
    this.reticleCrosshair.geometry.dispose();
    this.reticleFootprintMesh.geometry.dispose();
    this.reticleCrosshairMat.dispose();
    this.reticleFootprintMat.dispose();
    this.postProcessing.dispose();
    this.renderer.dispose();
  }

  /**
   * Packs every active bonded polygon body's triangulated face and glowing perimeter
   * into two single contiguous GPU buffers (2 draw calls total regardless of body count!).
   */
  private rebuildBatchedBodyFaces(snapToGrid: boolean): void {
    const bodies = this.engine.store.bodies;
    if (bodies.size === 0) {
      this.batchedFaceGeo.setDrawRange(0, 0);
      this.batchedEdgeGeo.setDrawRange(0, 0);
      return;
    }

    // Count required vertices first so buffers grow cleanly if needed
    let neededFaceVerts = 0;
    let neededEdgeVerts = 0;
    for (const body of bodies.values()) {
      const n = body.pixelIndices.length;
      if (!body.active || n < 3) continue;
      // Fan from body center: n triangles -> n * 3 vertices (gives clean radial phosphor shading!)
      neededFaceVerts += n * 3;
      neededEdgeVerts += n * 2;
    }

    this.ensureBatchCapacity(neededFaceVerts, neededEdgeVerts);

    const nSize = this.engine.virtualPixelSize;
    const invN = 1 / nSize;
    const half = nSize * 0.5;
    const groundHeight = this.engine.worldBounds.groundHeight;

    const fPos = this.facePositions;
    const fCol = this.faceColors;
    const ePos = this.edgePositions;
    const eCol = this.edgeColors;

    let fIdx = 0;
    let eIdx = 0;

    for (const body of bodies.values()) {
      const count = body.pixelIndices.length;
      if (!body.active || count < 3) continue;

      let bx = body.x;
      let by = body.y;
      if (snapToGrid) {
        bx = Math.floor(bx * invN) * nSize + half;
        const gy = Math.floor((by - groundHeight) * invN);
        by = groundHeight + (gy > 0 ? gy : 0) * nSize + half;
      }

      const cos = Math.cos(body.angle) * nSize;
      const sin = Math.sin(body.angle) * nSize;
      const local = body.localOffsets;

      const c = body.color;
      // Center slightly darker, perimeter vertices brighter -> smooth CRT phosphor bevel gradient
      const crCenter = c.r * 0.32;
      const cgCenter = c.g * 0.32;
      const cbCenter = c.b * 0.32;
      const crRim = c.r * 0.62;
      const cgRim = c.g * 0.62;
      const cbRim = c.b * 0.62;
      const er = Math.min(1, c.r * 1.15);
      const eg = Math.min(1, c.g * 1.15);
      const eb = Math.min(1, c.b * 1.15);

      const lx0 = local[0]!;
      const ly0 = local[1]!;
      let prevX = bx + lx0 * cos - ly0 * sin;
      let prevY = by + lx0 * sin + ly0 * cos;
      const firstX = prevX;
      const firstY = prevY;

      for (let i = 0; i < count; i++) {
        let nextX: number;
        let nextY: number;
        if (i + 1 === count) {
          nextX = firstX;
          nextY = firstY;
        } else {
          const lx = local[(i + 1) * 2]!;
          const ly = local[(i + 1) * 2 + 1]!;
          nextX = bx + lx * cos - ly * sin;
          nextY = by + lx * sin + ly * cos;
        }

        // Triangle (center, prev, next)
        fPos[fIdx] = bx;
        fPos[fIdx + 1] = by;
        fPos[fIdx + 2] = 0.5;
        fCol[fIdx] = crCenter;
        fCol[fIdx + 1] = cgCenter;
        fCol[fIdx + 2] = cbCenter;

        fPos[fIdx + 3] = prevX;
        fPos[fIdx + 4] = prevY;
        fPos[fIdx + 5] = 0.5;
        fCol[fIdx + 3] = crRim;
        fCol[fIdx + 4] = cgRim;
        fCol[fIdx + 5] = cbRim;

        fPos[fIdx + 6] = nextX;
        fPos[fIdx + 7] = nextY;
        fPos[fIdx + 8] = 0.5;
        fCol[fIdx + 6] = crRim;
        fCol[fIdx + 7] = cgRim;
        fCol[fIdx + 8] = cbRim;
        fIdx += 9;

        // Glowing edge segment (prev -> next)
        ePos[eIdx] = prevX;
        ePos[eIdx + 1] = prevY;
        ePos[eIdx + 2] = 0.55;
        eCol[eIdx] = er;
        eCol[eIdx + 1] = eg;
        eCol[eIdx + 2] = eb;

        ePos[eIdx + 3] = nextX;
        ePos[eIdx + 4] = nextY;
        ePos[eIdx + 5] = 0.55;
        eCol[eIdx + 3] = er;
        eCol[eIdx + 4] = eg;
        eCol[eIdx + 5] = eb;
        eIdx += 6;

        prevX = nextX;
        prevY = nextY;
      }
    }

    const faceVertCount = fIdx / 3;
    const edgeVertCount = eIdx / 3;

    this.facePosAttr.clearUpdateRanges();
    this.facePosAttr.addUpdateRange(0, fIdx);
    this.facePosAttr.needsUpdate = true;
    this.faceColorAttr.clearUpdateRanges();
    this.faceColorAttr.addUpdateRange(0, fIdx);
    this.faceColorAttr.needsUpdate = true;
    this.batchedFaceGeo.setDrawRange(0, faceVertCount);

    this.edgePosAttr.clearUpdateRanges();
    this.edgePosAttr.addUpdateRange(0, eIdx);
    this.edgePosAttr.needsUpdate = true;
    this.edgeColorAttr.clearUpdateRanges();
    this.edgeColorAttr.addUpdateRange(0, eIdx);
    this.edgeColorAttr.needsUpdate = true;
    this.batchedEdgeGeo.setDrawRange(0, edgeVertCount);
  }

  private ensureBatchCapacity(faceVerts: number, edgeVerts: number): void {
    if (faceVerts * 3 > this.facePositions.length) {
      const nextCap = Math.max(faceVerts * 2, this.facePositions.length);
      this.facePositions = new Float32Array(nextCap * 3);
      this.faceColors = new Float32Array(nextCap * 3);
      this.facePosAttr = new BufferAttribute(this.facePositions, 3);
      this.facePosAttr.setUsage(DynamicDrawUsage);
      this.faceColorAttr = new BufferAttribute(this.faceColors, 3);
      this.faceColorAttr.setUsage(DynamicDrawUsage);
      this.batchedFaceGeo.setAttribute('position', this.facePosAttr);
      this.batchedFaceGeo.setAttribute('aFaceColor', this.faceColorAttr);
    }

    if (edgeVerts * 3 > this.edgePositions.length) {
      const nextCap = Math.max(edgeVerts * 2, this.edgePositions.length);
      this.edgePositions = new Float32Array(nextCap * 3);
      this.edgeColors = new Float32Array(nextCap * 3);
      this.edgePosAttr = new BufferAttribute(this.edgePositions, 3);
      this.edgePosAttr.setUsage(DynamicDrawUsage);
      this.edgeColorAttr = new BufferAttribute(this.edgeColors, 3);
      this.edgeColorAttr.setUsage(DynamicDrawUsage);
      this.batchedEdgeGeo.setAttribute('position', this.edgePosAttr);
      this.batchedEdgeGeo.setAttribute('color', this.edgeColorAttr);
    }
  }

  private updateGroundTransform(): void {
    const groundPlugin = this.engine.registry.get<SceneObjectPlugin>('ground');
    const bounds = this.engine.worldBounds;
    const rect = groundPlugin
      ? groundPlugin.getBounds(bounds)
      : { x: bounds.width * 0.5, y: bounds.groundHeight * 0.5, width: bounds.width, height: bounds.groundHeight };

    this.groundMesh.position.set(rect.x, rect.y, 0);
    this.groundMesh.scale.set(rect.width, rect.height, 1);
  }
}

function createCrosshairGeometry(): BufferGeometry {
  const inner = 5;
  const outer = 16;
  const verts = new Float32Array([
    -outer, 0, 0, -inner, 0, 0,
    inner, 0, 0, outer, 0, 0,
    0, -outer, 0, 0, -inner, 0,
    0, inner, 0, 0, outer, 0,
  ]);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(verts, 3));
  return geo;
}

function createVertexOutlineGeometry(vertices: ShapeVertex[], virtualPixelSize: number): BufferGeometry {
  const n = vertices.length;
  const segs = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    segs[i * 6] = a.x * virtualPixelSize;
    segs[i * 6 + 1] = a.y * virtualPixelSize;
    segs[i * 6 + 2] = 0;
    segs[i * 6 + 3] = b.x * virtualPixelSize;
    segs[i * 6 + 4] = b.y * virtualPixelSize;
    segs[i * 6 + 5] = 0;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(segs, 3));
  return geo;
}

function createFootprintGeometry(footprint: ShapeFootprintCell[], virtualPixelSize: number): BufferGeometry {
  const occupied = new Set<string>();
  for (const c of footprint) {
    occupied.add(`${Math.round(c.gx * 2)},${Math.round(c.gy * 2)}`);
  }

  const half = virtualPixelSize * 0.5;
  const segs: number[] = [];

  for (const c of footprint) {
    const cx = c.gx * virtualPixelSize;
    const cy = c.gy * virtualPixelSize;
    const kx = Math.round(c.gx * 2);
    const ky = Math.round(c.gy * 2);

    if (!occupied.has(`${kx},${ky + 2}`)) {
      segs.push(cx - half, cy + half, 0, cx + half, cy + half, 0);
    }
    if (!occupied.has(`${kx},${ky - 2}`)) {
      segs.push(cx - half, cy - half, 0, cx + half, cy - half, 0);
    }
    if (!occupied.has(`${kx - 2},${ky}`)) {
      segs.push(cx - half, cy - half, 0, cx - half, cy + half, 0);
    }
    if (!occupied.has(`${kx + 2},${ky}`)) {
      segs.push(cx + half, cy - half, 0, cx + half, cy + half, 0);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(segs), 3));
  return geo;
}
