import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedBufferGeometry,
  LineBasicMaterial,
  LineLoop,
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
import type { BondedBody, SceneObjectPlugin, ShapeFootprintCell, ShapeVertex } from '../engine/types.ts';

interface BodyFaceVisual {
  group: Group;
  faceGeo: BufferGeometry;
  faceMat: MeshBasicNodeMaterial;
  edgeGeo: BufferGeometry;
  edgeMat: LineBasicMaterial;
}

/**
 * Three.js WebGPU + TSL Renderer with:
 *  - Hybrid GPU TSL compute shader execution (when WebGPU backend is active)
 *  - Zero-copy instanced rendering for loose virtual pixels via TSL NodeMaterials
 *  - Triangulated vertex-face meshes + glowing edges for composite shapes (no pixel fill)
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
  private readonly bodyFacesGroup: Group;
  private readonly bodyVisuals = new Map<number, BodyFaceVisual>();
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

    // 1. Instanced Virtual Pixel Mesh (loose standalone pixels only; composite bodies render as vertex faces)
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

    // Render only active loose pixels (meta.y > 0.5 && bodyId < 0)
    const isLoose = aMeta.z.lessThan(0.0).select(float(1.0), float(0.0));
    const isVisiblePixel = aMeta.y.mul(isLoose);
    const cellGap = smoothstep(float(2.0), float(5.0), uPixelSize).mul(0.08);
    const visualScale = uPixelSize.mul(float(1.0).sub(cellGap)).mul(isVisiblePixel);
    const worldXY = aRenderPos.add(positionLocal.xy.mul(visualScale));
    pixelMat.positionNode = vec3(worldXY.x, worldXY.y, float(0.0));

    // Phosphor cell shading: glowing hot core + crisp rim + kinetic velocity boost
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

    // 2. Vertex-Face Composite Body Container (triangulated faces + glowing edges)
    this.bodyFacesGroup = new Group();
    this.bodyFacesGroup.renderOrder = 3;
    this.scene.add(this.bodyFacesGroup);

    // 3. Glowing Phosphor Ground Floor Bar
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

    // 4. Glowing Reticle (Crosshair + Live Shape Vertex/Footprint Outline)
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

    // 5. Crisp Phosphor CRT TSL Post-Processing (Bloom + Subtle Scanlines + Soft Vignette, No Curvature)
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
      this.pipeline.uploadDirtyBuffers();
    }

    this.syncBodyFaceVisuals(snapToGrid);
    this.pixelGeometry.instanceCount = this.engine.store.highWaterMark;

    if (this.isWebGPU && this.engine.store.highWaterMark > 0) {
      this.renderer.compute(this.pipeline.getComputePasses());
    }

    this.postProcessing.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const visual of this.bodyVisuals.values()) {
      this.disposeBodyVisual(visual);
    }
    this.bodyVisuals.clear();
    this.pixelGeometry.dispose();
    this.groundMesh.geometry.dispose();
    this.reticleCrosshair.geometry.dispose();
    this.reticleFootprintMesh.geometry.dispose();
    this.reticleCrosshairMat.dispose();
    this.reticleFootprintMat.dispose();
    this.postProcessing.dispose();
    this.renderer.dispose();
  }

  private syncBodyFaceVisuals(snapToGrid: boolean): void {
    const bodies = this.engine.store.bodies;
    const n = this.engine.virtualPixelSize;
    const half = n * 0.5;
    const { groundHeight } = this.engine.worldBounds;

    // Remove visuals for dissolved or cleared bodies
    for (const [id, visual] of this.bodyVisuals) {
      if (!bodies.has(id)) {
        this.bodyFacesGroup.remove(visual.group);
        this.disposeBodyVisual(visual);
        this.bodyVisuals.delete(id);
      }
    }

    // Create/update triangulated vertex-face meshes for active bodies
    for (const body of bodies.values()) {
      if (!body.active || body.pixelIndices.length < 3) continue;

      let visual = this.bodyVisuals.get(body.id);
      if (!visual) {
        visual = this.createBodyVisual(body);
        this.bodyVisuals.set(body.id, visual);
        this.bodyFacesGroup.add(visual.group);
      }

      let bx = body.x;
      let by = body.y;
      if (snapToGrid) {
        bx = Math.floor(bx / n) * n + half;
        by = groundHeight + Math.max(0, Math.floor((by - groundHeight) / n)) * n + half;
      }

      visual.group.position.set(bx, by, 0.5);
      visual.group.rotation.z = body.angle;
      visual.group.scale.set(n, n, 1);
    }
  }

  private createBodyVisual(body: BondedBody): BodyFaceVisual {
    const count = body.pixelIndices.length;
    const positions = new Float32Array(count * 3);
    const indices: number[] = [];

    for (let i = 0; i < count; i++) {
      positions[i * 3] = body.localOffsets[i * 2]!;
      positions[i * 3 + 1] = body.localOffsets[i * 2 + 1]!;
      positions[i * 3 + 2] = 0;
    }

    // Triangulate the convex vertex polygon directly from its vertices (fan from v0)
    for (let i = 1; i < count - 1; i++) {
      indices.push(0, i, i + 1);
    }

    const faceGeo = new BufferGeometry();
    faceGeo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    faceGeo.setIndex(indices);

    const c = body.color;
    const faceMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    // Subtle glowing CRT phosphor face fill — slightly brighter toward perimeter
    const radial = clamp(length(positionLocal.xy).div(Math.max(1, body.boundingRadiusGrid)), float(0.0), float(1.0));
    const faceIntensity = float(0.32).add(radial.mul(0.28));
    faceMat.colorNode = vec4(vec3(c.r, c.g, c.b).mul(faceIntensity), float(0.86));

    const faceMesh = new Mesh(faceGeo, faceMat);
    faceMesh.frustumCulled = false;

    // Bright glowing vertex-to-vertex phosphor edge outline
    const edgeGeo = new BufferGeometry();
    edgeGeo.setAttribute('position', new Float32BufferAttribute(positions.slice(), 3));
    const edgeMat = new LineBasicMaterial({
      color: new Color(Math.min(1, c.r * 1.15), Math.min(1, c.g * 1.15), Math.min(1, c.b * 1.15)),
      transparent: true,
      opacity: 0.96,
      blending: AdditiveBlending,
      depthTest: false,
    });
    const edgeLoop = new LineLoop(edgeGeo, edgeMat);
    edgeLoop.position.z = 0.05;
    edgeLoop.frustumCulled = false;

    const group = new Group();
    group.add(faceMesh);
    group.add(edgeLoop);

    return { group, faceGeo, faceMat, edgeGeo, edgeMat };
  }

  private disposeBodyVisual(visual: BodyFaceVisual): void {
    visual.faceGeo.dispose();
    visual.faceMat.dispose();
    visual.edgeGeo.dispose();
    visual.edgeMat.dispose();
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
