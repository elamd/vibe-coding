import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  createWallMaterial,
  createFireballMaterial,
  createShockwaveMaterial
} from './shaders.js';

const MAX_SPARKS = 1400;
const DUMMY_OBJ = new THREE.Object3D();
const TEMP_COLOR = new THREE.Color();

/**
 * Manages the cannon-es 3D rigid-body physics world, destructible/fracturing fortress walls,
 * volumetric GLSL explosions, ballistic bouncing shrapnel sparks, and physical flying debris pieces
 * with dramatic visual & physical scaling across `physicsDetail` (0..10).
 */
export class PhysicsAndDestructionSystem {
  constructor(scene, soundEngine, addScorchCallback) {
    this.scene = scene;
    this.sound = soundEngine;
    this.addScorch = addScorchCallback;

    // Initialize cannon-es physics world
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -26.0, 0)
    });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;

    this.groundMat = new CANNON.Material('ground');
    this.debrisMat = new CANNON.Material('debris');

    const groundContact = new CANNON.ContactMaterial(this.groundMat, this.debrisMat, {
      friction: 0.5,
      restitution: 0.44
    });
    const debrisToDebrisContact = new CANNON.ContactMaterial(this.debrisMat, this.debrisMat, {
      friction: 0.4,
      restitution: 0.48
    });
    this.world.addContactMaterial(groundContact);
    this.world.addContactMaterial(debrisToDebrisContact);

    // Infinite desert floor collider plane
    const groundBody = new CANNON.Body({
      mass: 0,
      material: this.groundMat,
      shape: new CANNON.Plane()
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(groundBody);

    // Destructible physics detail level (0 = minimal/off, 10 = ultra maximum destruction)
    this.physicsDetail = 7;
    this.maxDebris = 300;

    // Active dynamic debris rigid bodies
    this.debrisList = [];

    // Delayed secondary cook-off explosions (for high detail levels 6..10)
    this.pendingSubExplosions = [];

    // Active destructible wall blocks
    this.wallBlocks = [];
    this.breachesCreated = 0;

    // Active volumetric shader explosions & particle plumes
    this.explosions = [];
    this.smokeParticles = [];

    this._initSharedGeometries();
    this._initBallisticSparksPool();
    this.setPhysicsDetail(7);
  }

  /**
   * Sets the Destructible Physics Detail level from 0 (Minimal) to 10 (Ultra Destruction).
   */
  setPhysicsDetail(level) {
    this.physicsDetail = THREE.MathUtils.clamp(Math.round(level), 0, 10);

    if (this.physicsDetail === 0) {
      this.maxDebris = 0;
      this.world.solver.iterations = 2;
    } else if (this.physicsDetail <= 3) {
      this.maxDebris = this.physicsDetail * 35; // 35 .. 105
      this.world.solver.iterations = 5;
    } else if (this.physicsDetail <= 7) {
      this.maxDebris = 100 + (this.physicsDetail - 3) * 65; // 165 .. 360
      this.world.solver.iterations = 8;
    } else {
      // Detail 8..10: Massive rigid-body capacity (500 .. 900 bodies!)
      this.maxDebris = 360 + (this.physicsDetail - 7) * 180;
      this.world.solver.iterations = 12;
    }

    // Prune excess active debris immediately if detail was lowered
    while (this.debrisList.length > this.maxDebris) {
      const oldest = this.debrisList.shift();
      this.scene.remove(oldest.mesh);
      this.world.removeBody(oldest.body);
      oldest.mesh.material.dispose();
    }

    // Clear active sparks if set to 0
    if (this.physicsDetail === 0 && this.sparksList) {
      this.sparksList = [];
      this.sparksInstancedMesh.count = 0;
    }
  }

  _initSharedGeometries() {
    this.shardGeometries = [];
    for (let i = 0; i < 6; i++) {
      const geo = new THREE.DodecahedronGeometry(0.45, 0);
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        pos.setXYZ(
          v,
          pos.getX(v) * (0.65 + Math.random() * 0.8),
          pos.getY(v) * (0.55 + Math.random() * 0.8),
          pos.getZ(v) * (0.65 + Math.random() * 0.8)
        );
      }
      geo.computeVertexNormals();
      this.shardGeometries.push(geo);
    }

    // Brick geometry for shattered wall masonry
    this.brickGeo = new THREE.BoxGeometry(0.62, 0.36, 0.44);
    // Twisted metal hull plate
    this.plateGeo = new THREE.BoxGeometry(0.85, 0.12, 0.65);
    // Rebar / pipe / barrel geometry
    this.pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.15, 7);
    // Wheel / tank cap geometry
    this.wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10);

    this.fireballGeo = new THREE.IcosahedronGeometry(1.0, 3);
    this.basicFlashGeo = new THREE.SphereGeometry(1.0, 10, 8);
    this.shockwaveGeo = new THREE.PlaneGeometry(2.4, 2.4);
    this.shockwaveGeo.rotateX(-Math.PI / 2);

    this.smokeGeo = new THREE.DodecahedronGeometry(0.48, 1);
  }

  /**
   * High-performance InstancedMesh pool for hundreds of glowing ballistic shrapnel sparks
   * that arc through the air and bounce off the desert sand.
   */
  _initBallisticSparksPool() {
    const sparkGeo = new THREE.BoxGeometry(0.11, 0.11, 0.55);
    const sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
      depthWrite: false
    });

    this.sparksInstancedMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
    this.sparksInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparksInstancedMesh.count = 0;
    this.sparksInstancedMesh.frustumCulled = false;
    this.scene.add(this.sparksInstancedMesh);

    this.sparksList = [];
  }

  /**
   * Spawns a burst of glowing physical ballistic sparks that fly outward and bounce on the ground
   */
  spawnSparkShower(origin, count, speedScale = 1.0) {
    if (this.physicsDetail === 0 || count <= 0) return;

    const sparkColors = [0xfff6b0, 0xffaa22, 0xff5500, 0xffffff];
    for (let i = 0; i < count; i++) {
      if (this.sparksList.length >= MAX_SPARKS) {
        this.sparksList.shift();
      }
      const theta = Math.random() * Math.PI * 2;
      const elevation = 0.15 + Math.random() * 0.85;
      const speed = (10 + Math.random() * 24) * speedScale;

      this.sparksList.push({
        pos: origin.clone().add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.6,
            Math.random() * 0.5,
            (Math.random() - 0.5) * 0.6
          )
        ),
        vel: new THREE.Vector3(
          Math.cos(theta) * speed,
          elevation * speed + 4.0,
          Math.sin(theta) * speed
        ),
        age: 0,
        maxAge: 0.45 + Math.random() * (0.35 + this.physicsDetail * 0.08),
        colorHex: sparkColors[i % sparkColors.length],
        scale: 0.7 + Math.random() * 1.1
      });
    }
  }

  /**
   * Builds a destructible fortress wall composed of fracturable concrete/sandstone cells.
   */
  spawnFracturableWall(zPos, options = {}) {
    const {
      rows = 3,
      cols = 11,
      gapCols = [],
      variant = 0,
      hasCrenellations = true
    } = options;

    const blockW = 2.25;
    const blockH = 1.42;
    const blockD = 1.45;
    const totalW = cols * blockW;
    const startX = -totalW / 2 + blockW / 2;

    const wallId = Math.random().toString(36).slice(2);
    const blockGeo = new THREE.BoxGeometry(blockW * 0.98, blockH * 0.98, blockD);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (gapCols.includes(c)) continue;

        const x = startX + c * blockW;
        const y = blockH / 2 + r * blockH;

        const mat = createWallMaterial(0, variant);
        const mesh = new THREE.Mesh(blockGeo, mat);
        mesh.position.set(x, y, zPos);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);

        const shape = new CANNON.Box(new CANNON.Vec3(blockW * 0.49, blockH * 0.49, blockD * 0.5));
        const body = new CANNON.Body({
          mass: 0,
          type: CANNON.Body.KINEMATIC,
          material: this.groundMat,
          position: new CANNON.Vec3(x, y, zPos),
          shape
        });
        this.world.addBody(body);

        this.wallBlocks.push({
          wallId,
          row: r,
          col: c,
          mesh,
          body,
          width: blockW,
          height: blockH,
          depth: blockD,
          hp: 3,
          maxHp: 3,
          variant,
          destroyed: false,
          collapsing: false
        });
      }
    }

    if (hasCrenellations) {
      const topY = rows * blockH + 0.35;
      const merlonGeo = new THREE.BoxGeometry(blockW * 0.65, 0.7, blockD * 0.85);
      for (let c = 0; c < cols; c += 2) {
        if (gapCols.includes(c)) continue;
        const x = startX + c * blockW;
        const mat = createWallMaterial(0, variant);
        const mesh = new THREE.Mesh(merlonGeo, mat);
        mesh.position.set(x, topY, zPos);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);

        const body = new CANNON.Body({
          mass: 0,
          type: CANNON.Body.KINEMATIC,
          position: new CANNON.Vec3(x, topY, zPos),
          shape: new CANNON.Box(new CANNON.Vec3(blockW * 0.32, 0.35, blockD * 0.42))
        });
        this.world.addBody(body);

        this.wallBlocks.push({
          wallId,
          row: rows,
          col: c,
          mesh,
          body,
          width: blockW * 0.65,
          height: 0.7,
          depth: blockD * 0.85,
          hp: 1,
          maxHp: 1,
          variant,
          destroyed: false,
          collapsing: false
        });
      }
    }
  }

  damageWallBlock(block, hitPoint, bulletDir, damage = 1) {
    if (block.destroyed) return false;

    block.hp -= damage;
    const damageRatio = Math.min(1.0, 1.0 - block.hp / block.maxHp);
    if (block.mesh.material.userData?.shaderUniforms) {
      block.mesh.material.userData.shaderUniforms.uDamage.value = damageRatio;
    }

    this.spawnImpactSparksAndChips(hitPoint, bulletDir, block.variant);

    if (block.hp <= 0) {
      this.shatterWallBlock(block, hitPoint, bulletDir);
      return true;
    } else {
      this.sound.playWallFracture(false);
      return false;
    }
  }

  /**
   * Fractures a destroyed wall block into physical 3D masonry bricks, jagged shards, and rebar
   * scaled dramatically by `this.physicsDetail` (0..10)!
   */
  shatterWallBlock(block, hitPoint, impulseDir) {
    if (block.destroyed) return;
    block.destroyed = true;
    this.breachesCreated++;

    const center = block.mesh.position.clone();
    this.scene.remove(block.mesh);
    this.world.removeBody(block.body);

    this.sound.playWallFracture(true);

    const detail = this.physicsDetail;

    if (detail === 0) {
      // Detail 0: Simple minimal arcade flash, 0 physics shards, 0 smoke, 0 scorch
      this._spawnMinimalBasicFlash(center, 0.8);
    } else {
      this.addScorch(center.x, center.z, 2.2, 0.9);
      this.spawnVolumetricExplosion(center, 0.55 + detail * 0.04, detail >= 4);

      // Bouncing spark shower scaled by detail (6 at detail 1 up to 85 at detail 10)
      this.spawnSparkShower(center, Math.round(detail * detail * 0.85), 0.95);

      const shardPalette = [0xd4a672, 0xa89e91, 0x85715c, 0x595149, 0xe0be94];
      // Scale shard count nonlinearly:
      // detail 1 -> 3 shards
      // detail 5 -> 16 shards
      // detail 10 -> 48 sub-fractured masonry bricks & shards!
      const numShards = Math.round(1 + detail * 1.7 + detail * detail * 0.3);

      for (let i = 0; i < numShards; i++) {
        const ox = (Math.random() - 0.5) * block.width * 0.9;
        const oy = (Math.random() - 0.5) * block.height * 0.9;
        const oz = (Math.random() - 0.5) * block.depth * 0.85;

        const shardPos = new THREE.Vector3(center.x + ox, center.y + oy, center.z + oz);
        const outward = shardPos.clone().sub(hitPoint || center).normalize();
        const speedMult = 0.85 + detail * 0.06;
        const blastVel = new THREE.Vector3(
          (outward.x * (7 + Math.random() * 12) + (impulseDir ? impulseDir.x * 5 : 0)) * speedMult,
          (Math.abs(outward.y) * (6 + Math.random() * 11) + 4.0) * speedMult,
          (outward.z * (7 + Math.random() * 11) + (impulseDir ? impulseDir.z * 7 : -3)) * speedMult
        );

        const useBrick = i % 3 === 0;
        const shardGeo = useBrick
          ? this.brickGeo
          : this.shardGeometries[i % this.shardGeometries.length];
        const shardColor = shardPalette[i % shardPalette.length];

        const sizeFactor = detail >= 8 ? 0.55 + Math.random() * 0.65 : 0.7 + Math.random() * 0.6;
        this.spawnDebrisPiece({
          position: shardPos,
          velocity: blastVel,
          geometry: shardGeo,
          scale: new THREE.Vector3(sizeFactor, sizeFactor, sizeFactor),
          color: shardColor,
          mass: 1.5,
          life: 2.2 + detail * 0.25,
          smoking: detail >= 5 && i % 3 === 0,
          flaming: detail >= 7 && i % 6 === 0
        });
      }

      // Twisted steel rebar rods (0 at detail < 3, up to 6 at detail 10)
      const numRebar = detail < 3 ? 0 : Math.floor((detail - 1) * 0.7);
      for (let r = 0; r < numRebar; r++) {
        this.spawnDebrisPiece({
          position: center.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.1, 0, 0)),
          velocity: new THREE.Vector3(
            (Math.random() - 0.5) * 18,
            7 + Math.random() * 10,
            -4 + (Math.random() - 0.5) * 14
          ),
          geometry: this.pipeGeo,
          scale: new THREE.Vector3(0.5, 1.0, 0.5),
          color: 0x3b3530,
          metalness: 0.8,
          mass: 1.2,
          smoking: detail >= 8
        });
      }
    }

    // Cascade structural collapse to unsupported blocks directly above
    for (const other of this.wallBlocks) {
      if (
        !other.destroyed &&
        other.wallId === block.wallId &&
        other.col === block.col &&
        other.row > block.row
      ) {
        other.hp = Math.min(other.hp, 1);
        if (other.mesh.material.userData?.shaderUniforms) {
          other.mesh.material.userData.shaderUniforms.uDamage.value = 0.85;
        }
        this.shatterWallBlock(
          other,
          other.mesh.position.clone().add(new THREE.Vector3(0, -0.5, 0)),
          new THREE.Vector3((Math.random() - 0.5) * 0.4, -0.5, -0.2)
        );
      }
    }
  }

  /**
   * Spawns concrete chips & HEI sparks when a 30mm round strikes a surface, scaled by `physicsDetail`
   */
  spawnImpactSparksAndChips(point, bulletDir, variant = 0) {
    const detail = this.physicsDetail;
    if (detail === 0) return;

    // Bouncing sparks on every bullet impact! (3 at detail 1 up to 35 at detail 10)
    this.spawnSparkShower(point, Math.round(detail * 3.5), 0.7);

    // Physical flying rock/armor chips (0 at detail 1, up to 10 per bullet hit at detail 10!)
    const numChips = Math.floor(detail * detail * 0.1);
    for (let i = 0; i < numChips; i++) {
      const geo = this.shardGeometries[i % this.shardGeometries.length];
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 15 - bulletDir.x * 5,
        3.5 + Math.random() * 9,
        Math.abs(bulletDir.z) * (6 + Math.random() * 9)
      );
      this.spawnDebrisPiece({
        position: point.clone(),
        velocity: vel,
        geometry: geo,
        scale: new THREE.Vector3(0.36, 0.36, 0.36),
        color: variant === 1 ? 0xa89e91 : 0xd4a672,
        mass: 0.4,
        life: 1.2 + detail * 0.15,
        smoking: detail >= 9 && i === 0
      });
    }

    this.spawnSmokePuff(point, 0.45 + detail * 0.03, 0xd8b88c, true);
    if (detail >= 6) {
      this.spawnSmokePuff(point, 0.38, 0xff7711, true);
    }
  }

  /**
   * Triggers a multi-layered explosion whose visual scale, fireball cluster count,
   * rigid-body debris count, secondary cook-off explosions, and shrapnel spark showers
   * scale dramatically from 0 (Minimal Arcade Flash) to 10 (Cataclysmic Ultra Destruction)!
   */
  spawnObjectExplosion(position, scale = 1.2, palette = [0xd93829, 0xf0af24, 0xf2ece1]) {
    this.sound.playExplosion(scale);
    const detail = this.physicsDetail;

    // DETAIL 0: Lightweight retro arcade flash — zero shader fireballs, zero lights, zero debris!
    if (detail === 0) {
      this._spawnMinimalBasicFlash(position, scale * 1.35);
      return;
    }

    this.addScorch(position.x, position.z, (2.4 + detail * 0.22) * scale, 1.0);

    // Primary Volumetric GLSL Fireball
    this.spawnVolumetricExplosion(position, scale * (0.85 + detail * 0.06), true);

    // Bouncing Ballistic Spark & Shrapnel Shower:
    // detail 1 -> 15 sparks
    // detail 5 -> 95 sparks
    // detail 10 -> 320 glowing bouncing sparks!
    const sparkCount = Math.round((8 + detail * 7 + detail * detail * 2.4) * scale);
    this.spawnSparkShower(position, sparkCount, 1.0 + detail * 0.06);

    // Secondary & Tertiary Staggered Cook-Off Fireballs at Detail >= 4!
    // At detail 5: 2 extra boiling sub-fireballs
    // At detail 8: 5 extra staggered fireballs
    // At detail 10: 8 staggered outward-erupting cook-off fireballs!
    if (detail >= 4) {
      const extraFireballs = Math.floor((detail - 2) * 1.05);
      for (let f = 0; f < extraFireballs; f++) {
        const angle = (f / extraFireballs) * Math.PI * 2 + Math.random() * 0.6;
        const dist = (0.9 + Math.random() * (1.2 + detail * 0.18)) * scale;
        const offset = new THREE.Vector3(
          Math.cos(angle) * dist,
          0.4 + Math.random() * 1.4 * scale,
          Math.sin(angle) * dist
        );
        this.pendingSubExplosions.push({
          delay: 0.04 + f * 0.038,
          pos: position.clone().add(offset),
          scale: scale * (0.55 + Math.random() * 0.45),
          withShockwave: detail >= 8 && f % 3 === 0
        });
      }
    }

    // Physical 3D Rigid-Body Debris Pieces:
    // detail 1 -> ~5 pieces
    // detail 5 -> ~38 pieces
    // detail 10 -> ~135 physical 3D rigid bodies per explosion!
    const numPieces = Math.floor((2 + detail * 3.2 + detail * detail * 0.85) * scale);

    // Ensure high-visibility vibrant debris colors mixed with glowing charred wreckage
    const vividPalette = [...palette, 0xff6600, 0xffe066, 0x383c42];

    for (let i = 0; i < numPieces; i++) {
      const theta = Math.random() * Math.PI * 2;
      const upward = 0.35 + Math.random() * 0.9;
      const speed = (9 + Math.random() * (13 + detail * 1.1)) * Math.sqrt(scale);

      const vel = new THREE.Vector3(
        Math.cos(theta) * speed,
        upward * speed + 4.5,
        Math.sin(theta) * speed
      );

      const spawnPos = position.clone().add(
        new THREE.Vector3(
          (Math.random() - 0.5) * 1.5 * scale,
          0.35 + Math.random() * 1.1 * scale,
          (Math.random() - 0.5) * 1.5 * scale
        )
      );

      let geo = this.plateGeo;
      const sizeMult = (0.55 + Math.random() * 0.95) * scale;
      const pieceScale = new THREE.Vector3(sizeMult, sizeMult, sizeMult);
      const r = Math.random();
      if (r < 0.32) {
        geo = this.shardGeometries[i % this.shardGeometries.length];
      } else if (r < 0.62) {
        geo = this.plateGeo;
      } else if (r < 0.84) {
        geo = this.pipeGeo;
      } else {
        geo = this.wheelGeo;
      }

      const col = vividPalette[i % vividPalette.length];
      const isFlaming = detail >= 2 && i % (detail >= 7 ? 2 : 3) === 0;
      const isSmoking = detail >= 3 && i % 2 === 0;
      // At detail 8..10, some large flaming debris chunks cook off and explode in mid-air!
      const willCookOff = detail >= 8 && i < Math.floor(detail - 6);

      this.spawnDebrisPiece({
        position: spawnPos,
        velocity: vel,
        geometry: geo,
        scale: pieceScale,
        color: col,
        metalness: 0.5,
        mass: 1.4 * scale,
        life: 2.5 + detail * 0.28,
        smoking: isSmoking,
        flaming: isFlaming,
        cookOffTimer: willCookOff ? 0.32 + Math.random() * 0.45 : 0
      });
    }
  }

  /**
   * Detail 0 minimal non-shader flash sphere
   */
  _spawnMinimalBasicFlash(position, scale = 1.0) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffaa33,
      transparent: true,
      opacity: 0.9
    });
    const mesh = new THREE.Mesh(this.basicFlashGeo, mat);
    mesh.position.copy(position);
    mesh.position.y = Math.max(0.8, position.y);
    mesh.scale.setScalar(0.5 * scale);
    this.scene.add(mesh);

    this.explosions.push({
      fireballMesh: mesh,
      fireballMat: mat,
      isBasicFlash: true,
      shockMesh: null,
      shockMat: null,
      light: null,
      scale,
      age: 0,
      duration: 0.28
    });
  }

  /**
   * Spawns a volumetric GLSL fireball + expanding shockwave ring + dynamic flash light
   */
  spawnVolumetricExplosion(position, scale = 1.0, withShockwave = true) {
    const fireballMat = createFireballMaterial();
    const fireballMesh = new THREE.Mesh(this.fireballGeo, fireballMat);
    fireballMesh.position.copy(position);
    fireballMesh.position.y = Math.max(0.8, position.y);
    fireballMesh.scale.setScalar(0.35 * scale);
    this.scene.add(fireballMesh);

    let shockMesh = null;
    let shockMat = null;
    if (withShockwave && this.physicsDetail >= 2) {
      shockMat = createShockwaveMaterial();
      shockMesh = new THREE.Mesh(this.shockwaveGeo, shockMat);
      shockMesh.position.set(position.x, Math.max(0.12, position.y * 0.3), position.z);
      shockMesh.scale.setScalar(0.5 * scale);
      this.scene.add(shockMesh);
    }

    let light = null;
    if (this.physicsDetail >= 2) {
      light = new THREE.PointLight(0xff7711, (5.0 + this.physicsDetail * 0.8) * scale, 24 * scale);
      light.position.copy(fireballMesh.position).add(new THREE.Vector3(0, 1.0, 0));
      this.scene.add(light);
    }

    this.explosions.push({
      fireballMesh,
      fireballMat,
      isBasicFlash: false,
      shockMesh,
      shockMat,
      light,
      scale,
      age: 0,
      duration: 0.5 + scale * 0.25 + this.physicsDetail * 0.025
    });

    const detail = this.physicsDetail;
    if (detail > 0) {
      // Scale volumetric smoke cloud count from 2 (at detail 1) up to 28 (at detail 10)
      const smokeCount = Math.floor((1 + detail * 1.4 + detail * detail * 0.12) * scale);
      for (let i = 0; i < smokeCount; i++) {
        const isFireCore = i < Math.ceil(smokeCount * 0.38);
        this.spawnSmokePuff(
          position.clone().add(
            new THREE.Vector3(
              (Math.random() - 0.5) * 1.8 * scale,
              Math.random() * 1.3 * scale,
              (Math.random() - 0.5) * 1.8 * scale
            )
          ),
          (0.6 + Math.random() * 0.95) * scale,
          isFireCore ? (i % 2 === 0 ? 0xff7711 : 0xffcc33) : 0x1a1816,
          isFireCore
        );
      }
    }
  }

  /**
   * Spawns a dense white-gray rocket propellant contrail puff + hot exhaust spark for flying missiles
   */
  spawnMissileExhaustTrail(tailPosition, velocityDir) {
    const mat = new THREE.MeshLambertMaterial({
      color: 0xedeae4,
      transparent: true,
      opacity: 0.82
    });
    const mesh = new THREE.Mesh(this.smokeGeo, mat);
    mesh.position.copy(tailPosition);
    const startScale = 0.28 + Math.random() * 0.14;
    mesh.scale.setScalar(startScale);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.scene.add(mesh);

    this.smokeParticles.push({
      mesh,
      vel: new THREE.Vector3(
        -velocityDir.x * 2.5 + (Math.random() - 0.5) * 1.6,
        -velocityDir.y * 1.5 + 0.8 + Math.random() * 1.2,
        -velocityDir.z * 2.5 + (Math.random() - 0.5) * 1.6
      ),
      age: 0,
      maxAge: 0.75 + Math.random() * 0.35,
      startScale
    });

    if (this.physicsDetail >= 2 && Math.random() < 0.75) {
      const sparkMat = new THREE.MeshBasicMaterial({
        color: Math.random() < 0.5 ? 0xfff0aa : 0xff7711,
        transparent: true,
        opacity: 0.95
      });
      const sparkMesh = new THREE.Mesh(this.smokeGeo, sparkMat);
      sparkMesh.position.copy(tailPosition);
      sparkMesh.scale.setScalar(0.16);
      this.scene.add(sparkMesh);

      this.smokeParticles.push({
        mesh: sparkMesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 1.2,
          (Math.random() - 0.5) * 1.2,
          (Math.random() - 0.5) * 1.2
        ),
        age: 0,
        maxAge: 0.16,
        startScale: 0.16
      });
    }
  }

  spawnSmokePuff(position, size = 0.7, colorHex = 0x22201e, emissive = false) {
    const mat = emissive
      ? new THREE.MeshBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0.92
        })
      : new THREE.MeshLambertMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0.78
        });

    const mesh = new THREE.Mesh(this.smokeGeo, mat);
    mesh.position.copy(position);
    mesh.scale.setScalar(size);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.scene.add(mesh);

    this.smokeParticles.push({
      mesh,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 4.2,
        2.8 + Math.random() * 5.2,
        (Math.random() - 0.5) * 4.2
      ),
      age: 0,
      maxAge: emissive ? 0.45 : 1.25 + Math.random() * (0.4 + this.physicsDetail * 0.08),
      startScale: size
    });
  }

  /**
   * Registers a single 3D rigid-body debris piece in cannon-es and Three.js
   */
  spawnDebrisPiece({
    position,
    velocity,
    geometry,
    scale,
    color = 0x888888,
    metalness = 0.25,
    mass = 1.0,
    life = 3.8,
    smoking = false,
    flaming = false,
    cookOffTimer = 0
  }) {
    if (this.maxDebris <= 0) return;

    if (this.debrisList.length >= this.maxDebris) {
      const oldest = this.debrisList.shift();
      this.scene.remove(oldest.mesh);
      this.world.removeBody(oldest.body);
      oldest.mesh.material.dispose();
    }

    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness,
      emissive: flaming ? 0xff5500 : 0x000000,
      emissiveIntensity: flaming ? 1.15 : 0
    });

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.scale.copy(scale);
    mesh.position.copy(position);
    // Cast shadows at medium/high detail; skip shadow casting on debris at low detail (1..3) for extra FPS
    mesh.castShadow = this.physicsDetail >= 4;
    mesh.receiveShadow = this.physicsDetail >= 4;
    this.scene.add(mesh);

    const halfExtents = new CANNON.Vec3(
      Math.max(0.14, scale.x * 0.3),
      Math.max(0.14, scale.y * 0.3),
      Math.max(0.14, scale.z * 0.3)
    );
    const body = new CANNON.Body({
      mass,
      material: this.debrisMat,
      shape: new CANNON.Box(halfExtents),
      position: new CANNON.Vec3(position.x, Math.max(0.28, position.y), position.z),
      linearDamping: 0.06,
      angularDamping: 0.06
    });

    body.velocity.set(velocity.x, velocity.y, velocity.z);
    body.angularVelocity.set(
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 22
    );
    this.world.addBody(body);

    this.debrisList.push({
      mesh,
      body,
      life,
      maxLife: life,
      smoking,
      flaming,
      cookOffTimer,
      smokeTimer: 0
    });
  }

  /**
   * Steps the cannon-es physics world, triggers delayed secondary cook-off fireballs,
   * updates bouncing instanced shrapnel sparks, and animates volumetric explosions.
   */
  update(dt, scrollSpeed) {
    const clampedDt = Math.min(dt, 0.05);
    const dz = scrollSpeed * clampedDt;

    // Only step the cannon-es physics solver when physicsDetail > 0 and dynamic bodies exist
    if (this.physicsDetail > 0 && this.debrisList.length > 0) {
      const maxSubSteps = this.physicsDetail >= 8 ? 5 : 3;
      this.world.step(1 / 60, clampedDt, maxSubSteps);
    }

    // Process staggered secondary cook-off fireballs (at detail >= 4)
    for (let i = this.pendingSubExplosions.length - 1; i >= 0; i--) {
      const sub = this.pendingSubExplosions[i];
      sub.delay -= clampedDt;
      sub.pos.z += dz;
      if (sub.delay <= 0) {
        this.spawnVolumetricExplosion(sub.pos, sub.scale, sub.withShockwave);
        if (this.physicsDetail >= 7) {
          this.spawnSparkShower(sub.pos, Math.round(this.physicsDetail * 6), 0.85);
        }
        this.pendingSubExplosions.splice(i, 1);
      }
    }

    // Scroll intact wall blocks
    for (let i = this.wallBlocks.length - 1; i >= 0; i--) {
      const b = this.wallBlocks[i];
      if (b.destroyed) {
        this.wallBlocks.splice(i, 1);
        continue;
      }
      b.mesh.position.z += dz;
      b.body.position.z = b.mesh.position.z;

      if (b.mesh.position.z > 24) {
        this.scene.remove(b.mesh);
        this.world.removeBody(b.body);
        b.mesh.material.dispose();
        this.wallBlocks.splice(i, 1);
      }
    }

    // Update dynamic rigid-body debris & mid-air secondary cook-offs
    const smokeInterval = Math.max(0.025, 0.13 - this.physicsDetail * 0.01);
    for (let i = this.debrisList.length - 1; i >= 0; i--) {
      const d = this.debrisList[i];
      d.life -= clampedDt;
      d.body.position.z += dz;

      d.mesh.position.set(d.body.position.x, d.body.position.y, d.body.position.z);
      d.mesh.quaternion.set(
        d.body.quaternion.x,
        d.body.quaternion.y,
        d.body.quaternion.z,
        d.body.quaternion.w
      );

      // Mid-air secondary debris cook-off explosions at high physics detail (8..10)
      if (d.cookOffTimer > 0) {
        d.cookOffTimer -= clampedDt;
        if (d.cookOffTimer <= 0 && d.body.position.y > 0.4) {
          this.spawnVolumetricExplosion(d.mesh.position.clone(), 0.65, false);
          this.spawnSparkShower(d.mesh.position, 28, 0.8);
        }
      }

      if (this.physicsDetail >= 2 && (d.smoking || d.flaming) && d.body.position.y > 0.3) {
        d.smokeTimer += clampedDt;
        if (d.smokeTimer > smokeInterval) {
          d.smokeTimer = 0;
          this.spawnSmokePuff(
            d.mesh.position,
            0.25 + this.physicsDetail * 0.018,
            d.flaming ? 0xff6611 : 0x262320,
            d.flaming
          );
        }
      }

      if (d.flaming && d.mesh.material.emissiveIntensity > 0) {
        d.mesh.material.emissiveIntensity = Math.max(0, (d.life / d.maxLife) * 1.15);
      }

      if (d.life <= 0 || d.body.position.z > 26 || d.body.position.y < -5) {
        this.scene.remove(d.mesh);
        this.world.removeBody(d.body);
        d.mesh.material.dispose();
        this.debrisList.splice(i, 1);
      }
    }

    // Update bouncing instanced ballistic shrapnel sparks
    if (this.sparksList.length > 0) {
      let activeCount = 0;
      for (let i = this.sparksList.length - 1; i >= 0; i--) {
        const sp = this.sparksList[i];
        sp.age += clampedDt;
        if (sp.age >= sp.maxAge || sp.pos.z > 26) {
          this.sparksList.splice(i, 1);
          continue;
        }

        sp.vel.y -= 28.0 * clampedDt;
        sp.pos.addScaledVector(sp.vel, clampedDt);
        sp.pos.z += dz;

        // Bounce sparks off the desert floor!
        if (sp.pos.y < 0.08) {
          sp.pos.y = 0.08;
          sp.vel.y = Math.abs(sp.vel.y) * 0.48;
          sp.vel.x *= 0.72;
          sp.vel.z *= 0.72;
        }

        const lifeRatio = 1.0 - sp.age / sp.maxAge;
        DUMMY_OBJ.position.copy(sp.pos);
        DUMMY_OBJ.lookAt(sp.pos.clone().add(sp.vel));
        DUMMY_OBJ.scale.set(
          sp.scale * lifeRatio,
          sp.scale * lifeRatio,
          sp.scale * (0.8 + sp.vel.length() * 0.08) * lifeRatio
        );
        DUMMY_OBJ.updateMatrix();

        this.sparksInstancedMesh.setMatrixAt(activeCount, DUMMY_OBJ.matrix);
        this.sparksInstancedMesh.setColorAt(activeCount, TEMP_COLOR.setHex(sp.colorHex));
        activeCount++;
      }

      this.sparksInstancedMesh.count = activeCount;
      this.sparksInstancedMesh.instanceMatrix.needsUpdate = true;
      if (this.sparksInstancedMesh.instanceColor) {
        this.sparksInstancedMesh.instanceColor.needsUpdate = true;
      }
    } else {
      this.sparksInstancedMesh.count = 0;
    }

    // Update Volumetric GLSL Fireballs & Shockwave Rings
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const ex = this.explosions[i];
      ex.age += clampedDt;
      const prog = Math.min(1.0, ex.age / ex.duration);

      ex.fireballMesh.position.z += dz;
      ex.fireballMesh.position.y += clampedDt * 1.8;

      if (ex.isBasicFlash) {
        ex.fireballMesh.scale.setScalar(ex.scale * (0.6 + prog * 1.8));
        ex.fireballMat.opacity = (1.0 - prog) * 0.85;
      } else {
        ex.fireballMat.uniforms.uTime.value += clampedDt;
        ex.fireballMat.uniforms.uProgress.value = prog;
        const fbScale = ex.scale * (0.55 + Math.pow(prog, 0.55) * 2.45);
        ex.fireballMesh.scale.setScalar(fbScale);
      }

      if (ex.shockMesh) {
        ex.shockMesh.position.z += dz;
        ex.shockMat.uniforms.uProgress.value = prog;
        ex.shockMesh.scale.setScalar(ex.scale * (0.8 + prog * 5.6));
      }

      if (ex.light) {
        ex.light.position.z += dz;
        ex.light.intensity = (1.0 - prog) * (5.0 + this.physicsDetail * 0.8) * ex.scale;
      }

      if (prog >= 1.0) {
        this.scene.remove(ex.fireballMesh);
        ex.fireballMat.dispose();
        if (ex.shockMesh) {
          this.scene.remove(ex.shockMesh);
          ex.shockMat.dispose();
        }
        if (ex.light) {
          this.scene.remove(ex.light);
        }
        this.explosions.splice(i, 1);
      }
    }

    // Update rising smoke & fire clouds
    for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
      const p = this.smokeParticles[i];
      p.age += clampedDt;
      const prog = p.age / p.maxAge;
      if (prog >= 1.0) {
        this.scene.remove(p.mesh);
        p.mesh.material.dispose();
        this.smokeParticles.splice(i, 1);
        continue;
      }
      p.mesh.position.addScaledVector(p.vel, clampedDt);
      p.mesh.position.z += dz;
      p.mesh.scale.setScalar(p.startScale * (1.0 + prog * 2.1));
      p.mesh.material.opacity = (1.0 - prog) * 0.8;
    }
  }

  clearAll() {
    this.pendingSubExplosions = [];
    this.sparksList = [];
    if (this.sparksInstancedMesh) {
      this.sparksInstancedMesh.count = 0;
    }

    for (const b of this.wallBlocks) {
      if (!b.destroyed) {
        this.scene.remove(b.mesh);
        this.world.removeBody(b.body);
        b.mesh.material.dispose();
      }
    }
    this.wallBlocks = [];

    for (const d of this.debrisList) {
      this.scene.remove(d.mesh);
      this.world.removeBody(d.body);
      d.mesh.material.dispose();
    }
    this.debrisList = [];
    this.breachesCreated = 0;
  }
}
