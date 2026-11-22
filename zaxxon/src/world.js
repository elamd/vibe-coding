import * as THREE from 'three';
import {
  COASTLINE_START_DIST,
  DESERT_START_DIST,
  BASE_START_DIST,
  createBarrierMaterial
} from './shaders.js';

const UP_VEC = new THREE.Vector3(0, 1, 0);

/**
 * Manages level progression (Sea Approach -> Coastal Beachhead -> Desert Base -> Boss),
 * destructible ground/air targets, realistic white SAM/ICBM missiles with thrust flames & smoke trails,
 * and level-scaled enemy projectile difficulty.
 */
export class DesertWorldDirector {
  constructor(scene, physicsSystem, soundEngine) {
    this.scene = scene;
    this.physics = physicsSystem;
    this.sound = soundEngine;

    this.targets = [];
    this.barriers = [];
    this.enemyProjectiles = [];
    this.desertProps = [];

    this.levelNumber = 1;
    this.distanceTraveled = 0;
    this.levelLength = 600;
    this.spawnedUpToDist = 0;
    this.stageIndex = 0;
    this.planesRemaining = 12;
    this.boss = null;

    this.sharedBarrierMat = createBarrierMaterial();
    this._initSharedMaterials();
    this._initDesertPropsPool();
  }

  _initSharedMaterials() {
    this.fuelRedMat = new THREE.MeshStandardMaterial({
      color: 0xd93829,
      roughness: 0.38,
      metalness: 0.45
    });
    this.fuelWhiteMat = new THREE.MeshStandardMaterial({
      color: 0xf2ece1,
      roughness: 0.45,
      metalness: 0.35
    });
    this.missileWhiteMat = new THREE.MeshStandardMaterial({
      color: 0xf7f9fc,
      roughness: 0.25,
      metalness: 0.35
    });
    this.hazardYellowMat = new THREE.MeshStandardMaterial({
      color: 0xf0af24,
      roughness: 0.45,
      metalness: 0.3
    });
    this.armorOliveMat = new THREE.MeshStandardMaterial({
      color: 0x5c6346,
      roughness: 0.6,
      metalness: 0.4
    });
    this.armorTanMat = new THREE.MeshStandardMaterial({
      color: 0xb89668,
      roughness: 0.62,
      metalness: 0.3
    });
    this.darkSteelMat = new THREE.MeshStandardMaterial({
      color: 0x2a2d32,
      roughness: 0.38,
      metalness: 0.82
    });
    this.radarDishMat = new THREE.MeshStandardMaterial({
      color: 0xd8dfd6,
      roughness: 0.35,
      metalness: 0.65
    });
    this.enemyJetMat = new THREE.MeshStandardMaterial({
      color: 0x6e473b,
      roughness: 0.45,
      metalness: 0.5
    });
    this.flameCoreMat = new THREE.MeshBasicMaterial({
      color: 0xfff8d6,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.flameOuterMat = new THREE.MeshBasicMaterial({
      color: 0xff5e00,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
  }

  /**
   * Builds a realistic white military missile (oriented along +Y local axis, nose at +Y, nozzle at -Y)
   * complete with white fuselage, red warhead band, dark seeker tip, 4 cruciform tail fins,
   * 4 mid-body guidance canards, exhaust nozzle, and optional animated rocket thrust flame!
   */
  _createRealisticMissileMesh(withThrustFlame = true, scale = 1.0) {
    const group = new THREE.Group();
    group.scale.setScalar(scale);

    // 1. Glossy White Cylindrical Fuselage Tube
    const bodyGeo = new THREE.CylinderGeometry(0.14, 0.14, 1.45, 14);
    const body = new THREE.Mesh(bodyGeo, this.missileWhiteMat);
    body.castShadow = true;
    group.add(body);

    // 2. Red Tactical Warhead Identification Band & Black Roll-Rate Ring
    const redBandGeo = new THREE.CylinderGeometry(0.144, 0.144, 0.16, 14);
    const redBand = new THREE.Mesh(redBandGeo, this.fuelRedMat);
    redBand.position.y = 0.42;
    group.add(redBand);

    const blackBandGeo = new THREE.CylinderGeometry(0.143, 0.143, 0.08, 14);
    const blackBand = new THREE.Mesh(blackBandGeo, this.darkSteelMat);
    blackBand.position.y = -0.25;
    group.add(blackBand);

    // 3. White Ogive Nose Cone + Graphite Seeker Tip
    const noseConeGeo = new THREE.ConeGeometry(0.14, 0.46, 14);
    const noseCone = new THREE.Mesh(noseConeGeo, this.missileWhiteMat);
    noseCone.position.y = 0.955;
    noseCone.castShadow = true;
    group.add(noseCone);

    const seekerTipGeo = new THREE.ConeGeometry(0.055, 0.18, 12);
    const seekerTip = new THREE.Mesh(seekerTipGeo, this.darkSteelMat);
    seekerTip.position.y = 1.16;
    group.add(seekerTip);

    // 4. Four Cruciform Swept Tail Fins (at 0, 90, 180, 270 deg) + Four Forward Canards
    const tailFinGeo = new THREE.BoxGeometry(0.56, 0.34, 0.026);
    const canardGeo = new THREE.BoxGeometry(0.36, 0.18, 0.022);
    for (let i = 0; i < 2; i++) {
      const angle = (i * Math.PI) / 2;

      const tailFin = new THREE.Mesh(tailFinGeo, this.darkSteelMat);
      tailFin.position.y = -0.52;
      tailFin.rotation.y = angle;
      group.add(tailFin);

      const canard = new THREE.Mesh(canardGeo, this.darkSteelMat);
      canard.position.y = 0.25;
      canard.rotation.y = angle + Math.PI / 4;
      group.add(canard);
    }

    // 5. Rocket Exhaust Nozzle Bell at Rear (-Y)
    const nozzleGeo = new THREE.CylinderGeometry(0.085, 0.115, 0.14, 12);
    const nozzle = new THREE.Mesh(nozzleGeo, this.darkSteelMat);
    nozzle.position.y = -0.78;
    group.add(nozzle);

    // 6. Animated Rocket Motor Thrust Flame Plume
    if (withThrustFlame) {
      const flameGroup = new THREE.Group();
      flameGroup.position.y = -0.85;

      // Inner white-hot Mach diamond core pointing -Y
      const coreGeo = new THREE.ConeGeometry(0.11, 0.65, 10);
      coreGeo.rotateX(Math.PI);
      const coreMesh = new THREE.Mesh(coreGeo, this.flameCoreMat);
      coreMesh.position.y = -0.30;
      flameGroup.add(coreMesh);

      // Outer bright orange-red afterburner plume pointing -Y
      const outerGeo = new THREE.ConeGeometry(0.20, 1.25, 10);
      outerGeo.rotateX(Math.PI);
      const outerMesh = new THREE.Mesh(outerGeo, this.flameOuterMat);
      outerMesh.position.y = -0.58;
      flameGroup.add(outerMesh);

      group.add(flameGroup);
      group.userData.flameGroup = flameGroup;
    }

    return group;
  }

  _initDesertPropsPool() {
    const rockGeo = new THREE.DodecahedronGeometry(1.4, 0);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0xa66e46,
      roughness: 0.9
    });

    for (let i = 0; i < 32; i++) {
      const mesh = new THREE.Mesh(rockGeo, rockMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.desertProps.push({
        mesh,
        levelDist: 0
      });
    }
  }

  getDifficultyParams() {
    const lvl = this.levelNumber;
    const maxProjectiles = lvl === 1 ? 2 : lvl === 2 ? 4 : 2 + lvl * 2;
    const fireInterval = Math.max(1.25, 4.4 - (lvl - 1) * 0.65);
    const projectileSpeed = Math.min(34, 18.5 + (lvl - 1) * 3.0);
    const salvoSize = lvl === 1 ? 1 : lvl <= 3 ? 2 : 3;

    return {
      maxProjectiles,
      fireInterval,
      projectileSpeed,
      salvoSize
    };
  }

  startLevel(levelNum = 1) {
    for (const t of this.targets) {
      this.scene.remove(t.mesh);
      if (t.shadowMesh) this.scene.remove(t.shadowMesh);
    }
    for (const b of this.barriers) this.scene.remove(b.mesh);
    for (const p of this.enemyProjectiles) this.scene.remove(p.mesh);
    if (this.boss) {
      this.scene.remove(this.boss.mesh);
      this.boss = null;
    }

    this.targets = [];
    this.barriers = [];
    this.enemyProjectiles = [];

    this.levelNumber = levelNum;
    this.distanceTraveled = 0;
    this.levelLength = 560 + (levelNum - 1) * 60;
    this.spawnedUpToDist = DESERT_START_DIST;
    this.stageIndex = 0;
    this.planesRemaining = 8 + levelNum * 4;

    for (let i = 0; i < this.desertProps.length; i++) {
      const prop = this.desertProps[i];
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (16.5 + Math.random() * 18);
      const forwardDist = DESERT_START_DIST + 18 + i * 14 + Math.random() * 8;
      prop.levelDist = forwardDist;
      prop.mesh.position.set(x, 0.6, -forwardDist);
      prop.mesh.scale.set(
        0.8 + Math.random() * 1.6,
        0.6 + Math.random() * 2.0,
        0.8 + Math.random() * 1.6
      );
      prop.mesh.rotation.set(Math.random(), Math.random(), Math.random());
    }

    this.spawnFuelDepot(-4.5, -112);
  }

  reset() {
    this.startLevel(1);
  }

  getSectorTitle() {
    const lvl = String(this.levelNumber).padStart(2, '0');
    switch (this.stageIndex) {
      case 0:
        return `LEVEL ${lvl} // PHASE 1: SEA APPROACH TO COAST`;
      case 1:
        return `LEVEL ${lvl} // PHASE 2: COASTAL BEACHHEAD`;
      case 2:
        return `LEVEL ${lvl} // PHASE 3: DESERT AIRBASE ASSAULT`;
      case 3:
        return `LEVEL ${lvl} // FINAL PHASE: ZAXXON CITADEL`;
      default:
        return `LEVEL ${lvl} // DESERT SORTIE`;
    }
  }

  getLevelProgressPercent() {
    if (this.boss) return 100;
    return Math.min(100, Math.max(0, (this.distanceTraveled / this.levelLength) * 100));
  }

  _spawnSliceAt(zPos, sliceForwardDist) {
    const lvl = this.levelNumber;

    if (sliceForwardDist < BASE_START_DIST) {
      const beachProgress =
        (sliceForwardDist - DESERT_START_DIST) / (BASE_START_DIST - DESERT_START_DIST);

      this.spawnFuelDepot((Math.random() - 0.5) * 14, zPos - 4);
      if (beachProgress > 0.35) {
        this.spawnRadarTower((Math.random() - 0.5) * 15, zPos - 12);
      }

      if (beachProgress > 0.6) {
        this.physics.spawnFracturableWall(zPos - 18, {
          rows: 2,
          cols: 11,
          gapCols: [4, 5, 6],
          variant: 0,
          hasCrenellations: true
        });
        if (lvl >= 1) {
          this.spawnSamLauncher(5.5, zPos - 24);
        }
      }
      return;
    }

    const baseDepth = (sliceForwardDist - BASE_START_DIST) / (this.levelLength - BASE_START_DIST);
    const isDeepBase = baseDepth > 0.55;

    const wallRows = isDeepBase && lvl >= 2 ? 4 : 3;
    const gapWidth = lvl === 1 ? 3 : 2;
    const gapStart = 2 + Math.floor(Math.random() * (8 - gapWidth));
    const gapCols = [];
    for (let g = 0; g < gapWidth; g++) gapCols.push(gapStart + g);

    this.physics.spawnFracturableWall(zPos, {
      rows: wallRows,
      cols: 11,
      gapCols,
      variant: isDeepBase ? 1 : 0,
      hasCrenellations: true
    });

    if ((lvl >= 2 && isDeepBase) || (lvl >= 3 && Math.random() < 0.45)) {
      this._spawnLaserBarrierInGap(zPos, gapCols, wallRows);
    }

    const usedLanes = new Set();
    const pickLane = () => {
      for (let tries = 0; tries < 10; tries++) {
        const lane = Math.floor((Math.random() - 0.5) * 7);
        if (!usedLanes.has(lane)) {
          usedLanes.add(lane);
          return lane * 3.1;
        }
      }
      return (Math.random() - 0.5) * 18;
    };

    this.spawnFuelDepot(pickLane(), zPos - 9);
    if (Math.random() < 0.55) {
      this.spawnFuelDepot(pickLane(), zPos - 16);
    }

    const numTurrets = lvl === 1 ? 1 : Math.min(3, 1 + Math.floor(lvl * 0.6));
    for (let t = 0; t < numTurrets; t++) {
      this.spawnAATurret(pickLane(), zPos - 11 - t * 6);
    }

    if (Math.random() < 0.65) {
      this.spawnRadarTower(pickLane(), zPos - 15);
    }

    // Spawn SAM Launchers regularly so players see the white missiles with thrust flames & smoke trails!
    if (Math.random() < 0.8) {
      this.spawnSamLauncher(pickLane(), zPos - 19);
    }

    if (Math.random() < 0.5) {
      this.spawnParkedJet(pickLane(), zPos - 22);
    }

    if ((lvl === 1 && isDeepBase && Math.random() < 0.5) || (lvl >= 2 && Math.random() < 0.75)) {
      const airCount = lvl >= 3 ? 2 : 1;
      for (let a = 0; a < airCount; a++) {
        this.spawnAirInterceptor(
          (Math.random() - 0.5) * 16,
          2.8 + Math.random() * 5.8,
          zPos - 14 - a * 9
        );
      }
    }
  }

  _spawnLaserBarrierInGap(zPos, gapCols, rows) {
    const blockW = 2.25;
    const blockH = 1.42;
    const startX = -(11 * blockW) / 2 + blockW / 2;
    const xCenter = startX + ((gapCols[0] + gapCols[gapCols.length - 1]) / 2) * blockW;
    const width = gapCols.length * blockW;
    const height = rows * blockH * 0.85;

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      this.sharedBarrierMat
    );
    mesh.position.set(xCenter, height / 2 + 0.2, zPos);
    this.scene.add(mesh);

    this.barriers.push({
      mesh,
      width,
      height,
      active: true
    });
  }

  spawnFuelDepot(x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(1.05, 1.05, 1.85, 14),
      this.fuelRedMat
    );
    cyl.position.y = 0.95;
    cyl.castShadow = true;
    cyl.receiveShadow = true;
    group.add(cyl);

    const stripe = new THREE.Mesh(
      new THREE.CylinderGeometry(1.07, 1.07, 0.42, 14),
      this.fuelWhiteMat
    );
    stripe.position.y = 1.05;
    group.add(stripe);

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(1.02, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      this.hazardYellowMat
    );
    cap.position.y = 1.85;
    cap.castShadow = true;
    group.add(cap);

    this.scene.add(group);
    this.targets.push({
      type: 'fuel',
      mesh: group,
      radius: 1.35,
      height: 2.4,
      hp: 2,
      score: 300,
      fuelBonus: 26,
      palette: [0xd93829, 0xf0af24, 0xf2ece1, 0x2a2d32],
      explosionScale: 1.45
    });
  }

  spawnAATurret(x, z) {
    const diff = this.getDifficultyParams();
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.75, 1.9),
      this.armorTanMat
    );
    base.position.y = 0.38;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const turretHead = new THREE.Group();
    turretHead.position.y = 0.95;
    const dome = new THREE.Mesh(
      new THREE.CylinderGeometry(0.65, 0.82, 0.65, 10),
      this.armorOliveMat
    );
    dome.castShadow = true;
    turretHead.add(dome);

    const barrelGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.45, 6);
    barrelGeo.rotateX(Math.PI / 2);
    for (const bx of [-0.22, 0.22]) {
      for (const by of [-0.1, 0.14]) {
        const b = new THREE.Mesh(barrelGeo, this.darkSteelMat);
        b.position.set(bx, by, 0.65);
        turretHead.add(b);
      }
    }
    group.add(turretHead);

    this.scene.add(group);
    this.targets.push({
      type: 'turret',
      mesh: group,
      turretHead,
      radius: 1.25,
      height: 1.8,
      hp: 3,
      score: 500,
      fireCooldown: diff.fireInterval * (0.6 + Math.random() * 0.7),
      palette: [0x5c6346, 0xb89668, 0x2a2d32],
      explosionScale: 1.25
    });
  }

  spawnRadarTower(x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.95, 3.1, 8),
      this.darkSteelMat
    );
    tower.position.y = 1.55;
    tower.castShadow = true;
    group.add(tower);

    const dishPivot = new THREE.Group();
    dishPivot.position.y = 3.35;
    const dish = new THREE.Mesh(
      new THREE.CylinderGeometry(1.35, 0.25, 0.55, 14),
      this.radarDishMat
    );
    dish.rotation.x = Math.PI / 2.6;
    dish.castShadow = true;
    dishPivot.add(dish);
    group.add(dishPivot);

    this.scene.add(group);
    this.targets.push({
      type: 'radar',
      mesh: group,
      dishPivot,
      radius: 1.35,
      height: 4.1,
      hp: 3,
      score: 1000,
      palette: [0xd8dfd6, 0x2a2d32, 0xf0af24],
      explosionScale: 1.5
    });
  }

  /**
   * Surface-to-Air Missile (SAM) Battery with twin realistic white missiles on launcher rails
   */
  spawnSamLauncher(x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.3, 0.55, 10),
      this.armorTanMat
    );
    pad.position.y = 0.28;
    pad.castShadow = true;
    group.add(pad);

    // Elevate rail support gantry
    const gantry = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.65, 0.45),
      this.darkSteelMat
    );
    gantry.position.y = 0.72;
    group.add(gantry);

    // 2 Realistic White SAM Missiles mounted on the launcher rails
    const railMissiles = [];
    for (const mx of [-0.42, 0.42]) {
      const sam = this._createRealisticMissileMesh(false, 0.95);
      sam.position.set(mx, 1.35, 0);
      group.add(sam);
      railMissiles.push(sam);
    }

    this.scene.add(group);
    this.targets.push({
      type: 'sam',
      mesh: group,
      railMissiles,
      radius: 1.25,
      height: 2.3,
      hp: 2,
      score: 750,
      launched: false,
      palette: [0xf7f9fc, 0xd93829, 0xb89668],
      explosionScale: 1.35
    });
  }

  spawnParkedJet(x, z) {
    const jet = this._createEnemyJetMesh();
    jet.position.set(x, 0.65, z);
    this.scene.add(jet);

    this.targets.push({
      type: 'parked_jet',
      mesh: jet,
      radius: 1.45,
      height: 1.5,
      hp: 2,
      score: 400,
      palette: [0x6e473b, 0xb89668, 0x2a2d32],
      explosionScale: 1.3
    });
  }

  spawnAirInterceptor(x, y, z) {
    const diff = this.getDifficultyParams();
    const jet = this._createEnemyJetMesh();
    jet.position.set(x, y, z);
    this.scene.add(jet);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x050403,
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      })
    );
    shadow.position.set(x, 0.06, z);
    this.scene.add(shadow);

    this.targets.push({
      type: 'air_enemy',
      mesh: jet,
      shadowMesh: shadow,
      baseX: x,
      baseY: y,
      phase: Math.random() * Math.PI * 2,
      radius: 1.5,
      height: 1.4,
      hp: 2,
      score: 800,
      fireCooldown: diff.fireInterval * (0.7 + Math.random() * 0.6),
      palette: [0x6e473b, 0xd93829, 0x2a2d32],
      explosionScale: 1.4
    });
  }

  _createEnemyJetMesh() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 3.2, 8).rotateX(Math.PI / 2),
      this.enemyJetMat
    );
    body.castShadow = true;
    group.add(body);

    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 0.09, 1.25),
      this.armorTanMat
    );
    wing.position.z = -0.25;
    wing.castShadow = true;
    group.add(wing);

    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.85, 0.8),
      this.enemyJetMat
    );
    fin.position.set(0, 0.42, -0.9);
    group.add(fin);

    return group;
  }

  spawnZaxxonBoss() {
    if (this.boss) return;

    const group = new THREE.Group();
    group.position.set(0, 0, -48);

    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(9.5, 3.2, 5.2),
      this.armorTanMat
    );
    hull.position.y = 1.8;
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(5.2, 2.8, 3.6),
      this.armorOliveMat
    );
    tower.position.set(0, 4.4, -0.3);
    tower.castShadow = true;
    group.add(tower);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(3.8, 0.55, 0.25),
      new THREE.MeshBasicMaterial({ color: 0xff2a1f })
    );
    visor.position.set(0, 4.7, 1.55);
    group.add(visor);

    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 2.2, 3.2),
        this.darkSteelMat
      );
      pod.position.set(side * 4.4, 3.8, 0.2);
      pod.castShadow = true;
      group.add(pod);

      const cannon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.34, 3.2, 10).rotateX(Math.PI / 2),
        this.fuelRedMat
      );
      cannon.position.set(side * 4.4, 3.8, 2.1);
      group.add(cannon);
    }

    // Central White ICBM Homing Missile mounted on the Boss Citadel
    const missileMesh = this._createRealisticMissileMesh(false, 1.45);
    missileMesh.rotation.x = Math.PI / 2;
    missileMesh.position.set(0, 2.8, 2.8);
    group.add(missileMesh);

    this.scene.add(group);

    const bossHp = 55 + (this.levelNumber - 1) * 25;
    this.boss = {
      mesh: group,
      missileMesh,
      hp: bossHp,
      maxHp: bossHp,
      targetZ: -26,
      phase: 0,
      fireTimer: 2.2,
      missileTimer: 3.5
    };
  }

  /**
   * Fires an enemy projectile (realistic white missile with thrust flame & smoke trail, or AA flak shell)
   */
  spawnEnemyProjectile(position, velocity, type = 'flak') {
    const diff = this.getDifficultyParams();
    const cap = this.boss ? diff.maxProjectiles + 2 : diff.maxProjectiles;
    if (this.enemyProjectiles.length >= cap) return;

    const isMissile = type === 'sam' || type === 'boss_missile';
    let mesh;
    if (isMissile) {
      mesh = this._createRealisticMissileMesh(true, type === 'boss_missile' ? 1.25 : 1.0);
      const dir = velocity.clone().normalize();
      mesh.quaternion.setFromUnitVectors(UP_VEC, dir);
    } else {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xff3b30 })
      );
    }

    mesh.position.copy(position);
    this.scene.add(mesh);

    this.enemyProjectiles.push({
      mesh,
      vel: velocity.clone(),
      type,
      isMissile,
      hp: isMissile ? 2 : 1,
      radius: isMissile ? 0.9 : 0.45,
      smokeTimer: 0
    });
  }

  update(dt, scrollSpeed, playerPos, onStageChangeCallback) {
    this.sharedBarrierMat.uniforms.uTime.value += dt;
    const diff = this.getDifficultyParams();

    const effectiveScroll = this.boss ? scrollSpeed * 0.18 : scrollSpeed;
    const dz = effectiveScroll * dt;
    this.distanceTraveled += dz;

    if (!this.boss) {
      let desiredStage = 0;
      if (this.distanceTraveled >= this.levelLength) {
        desiredStage = 3;
      } else if (this.distanceTraveled >= BASE_START_DIST - 15) {
        desiredStage = 2;
      } else if (this.distanceTraveled >= COASTLINE_START_DIST - 10) {
        desiredStage = 1;
      }

      if (desiredStage !== this.stageIndex) {
        this.stageIndex = desiredStage;
        if (desiredStage === 3) {
          this.spawnZaxxonBoss();
        }
        if (onStageChangeCallback) onStageChangeCallback(this.stageIndex);
      }
    }

    const lookAheadDist = this.distanceTraveled + 135;
    while (!this.boss && this.spawnedUpToDist < Math.min(lookAheadDist, this.levelLength - 25)) {
      const sliceZ = -(this.spawnedUpToDist - this.distanceTraveled);
      this._spawnSliceAt(sliceZ, this.spawnedUpToDist);
      const spacing = Math.max(25, 33 - (this.levelNumber - 1) * 2);
      this.spawnedUpToDist += spacing;
    }

    for (const prop of this.desertProps) {
      prop.mesh.position.z += dz;
      if (prop.mesh.position.z > 24) {
        prop.levelDist += 260;
        prop.mesh.position.z = -(prop.levelDist - this.distanceTraveled);
      }
    }

    for (let i = this.barriers.length - 1; i >= 0; i--) {
      const b = this.barriers[i];
      b.mesh.position.z += dz;
      if (b.mesh.position.z > 22 || !b.active) {
        this.scene.remove(b.mesh);
        this.barriers.splice(i, 1);
      }
    }

    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      t.mesh.position.z += dz;

      if (t.type === 'radar' && t.dishPivot) {
        t.dishPivot.rotation.y += dt * 3.2;
      } else if (t.type === 'turret') {
        if (t.turretHead) {
          const dx = playerPos.x - t.mesh.position.x;
          const dzToPlayer = playerPos.z - t.mesh.position.z;
          t.turretHead.rotation.y = Math.atan2(dx, dzToPlayer);
        }
        t.fireCooldown -= dt;
        if (
          t.fireCooldown <= 0 &&
          t.mesh.position.z > -68 &&
          t.mesh.position.z < -16
        ) {
          t.fireCooldown = diff.fireInterval * (0.85 + Math.random() * 0.4);
          const spawnPos = t.mesh.position.clone().add(new THREE.Vector3(0, 1.25, 0.8));
          const toPlayer = playerPos.clone().sub(spawnPos).normalize();

          for (let s = 0; s < diff.salvoSize; s++) {
            const spread = (s - (diff.salvoSize - 1) / 2) * 0.12;
            const dir = toPlayer.clone();
            dir.x += spread;
            dir.normalize();
            this.spawnEnemyProjectile(
              spawnPos.clone().add(new THREE.Vector3(spread * 2, 0, s * 0.6)),
              dir.multiplyScalar(diff.projectileSpeed),
              'flak'
            );
          }
        }
      } else if (t.type === 'sam' && !t.launched) {
        if (t.mesh.position.z > -44 && t.mesh.position.z < -12) {
          t.launched = true;
          const samCount = this.levelNumber >= 3 ? 2 : 1;
          for (let s = 0; s < samCount; s++) {
            // Hide the missile on the rail as it launches into the sky!
            if (t.railMissiles && t.railMissiles[s]) {
              t.railMissiles[s].visible = false;
            }
            const samPos = t.mesh.position
              .clone()
              .add(new THREE.Vector3((s - 0.5) * 0.84, 1.45, 0));
            this.spawnEnemyProjectile(
              samPos,
              new THREE.Vector3(0, 11.2, effectiveScroll * 0.85),
              'sam'
            );
          }
        }
      } else if (t.type === 'air_enemy') {
        t.phase += dt * 2.3;
        t.mesh.position.z += dt * 8.5;
        t.mesh.position.x = THREE.MathUtils.clamp(
          t.baseX + Math.sin(t.phase) * 3.8,
          -11,
          11
        );
        t.mesh.position.y = THREE.MathUtils.clamp(
          t.baseY + Math.cos(t.phase * 0.8) * 1.6,
          1.8,
          9.5
        );
        t.mesh.rotation.z = -Math.cos(t.phase) * 0.35;

        if (t.shadowMesh) {
          t.shadowMesh.position.set(t.mesh.position.x, 0.06, t.mesh.position.z);
        }

        t.fireCooldown -= dt;
        if (t.fireCooldown <= 0 && t.mesh.position.z > -60 && t.mesh.position.z < -14) {
          t.fireCooldown = diff.fireInterval * 0.9;
          const shotPos = t.mesh.position.clone().add(new THREE.Vector3(0, 0, 1.5));
          // Airborne enemy jets fire air-to-air white missiles!
          this.spawnEnemyProjectile(
            shotPos,
            new THREE.Vector3(
              (playerPos.x - shotPos.x) * 0.25,
              (playerPos.y - shotPos.y) * 0.15,
              diff.projectileSpeed + 8
            ),
            'boss_missile'
          );
        }
      }

      if (t.mesh.position.z > 22) {
        this.scene.remove(t.mesh);
        if (t.shadowMesh) this.scene.remove(t.shadowMesh);
        this.targets.splice(i, 1);
      }
    }

    if (this.boss) {
      this.boss.phase += dt * (1.25 + this.levelNumber * 0.2);
      this.boss.mesh.position.z = THREE.MathUtils.lerp(
        this.boss.mesh.position.z,
        this.boss.targetZ,
        dt * 1.8
      );
      this.boss.mesh.position.x = Math.sin(this.boss.phase) * 6.5;

      this.boss.fireTimer -= dt;
      if (this.boss.fireTimer <= 0) {
        this.boss.fireTimer = Math.max(0.95, 2.3 - (this.levelNumber - 1) * 0.35);
        const sides =
          this.levelNumber === 1
            ? [Math.sin(this.boss.phase) > 0 ? 1 : -1]
            : [-1, 1];
        for (const side of sides) {
          const origin = this.boss.mesh.position
            .clone()
            .add(new THREE.Vector3(side * 4.4, 3.8, 3.2));
          const aim = playerPos
            .clone()
            .sub(origin)
            .normalize()
            .multiplyScalar(diff.projectileSpeed + 4);
          this.spawnEnemyProjectile(origin, aim, 'flak');
        }
      }

      this.boss.missileTimer -= dt;
      if (this.boss.missileTimer <= 0) {
        this.boss.missileTimer = Math.max(2.0, 3.8 - (this.levelNumber - 1) * 0.45);
        const mPos = this.boss.mesh.position.clone().add(new THREE.Vector3(0, 3.2, 3.2));
        const aim = playerPos
          .clone()
          .sub(mPos)
          .normalize()
          .multiplyScalar(diff.projectileSpeed + 2);
        this.spawnEnemyProjectile(mPos, aim, 'boss_missile');
      }
    }

    // Update Enemy Projectiles, Missile Thrust Flames & Dense Rocket Exhaust Smoke Trails
    for (let i = this.enemyProjectiles.length - 1; i >= 0; i--) {
      const p = this.enemyProjectiles[i];
      p.mesh.position.addScaledVector(p.vel, dt);

      if (p.isMissile) {
        const velDir = p.vel.clone().normalize();
        p.mesh.quaternion.setFromUnitVectors(UP_VEC, velDir);

        // Flicker the rocket motor thrust flame plume realistically
        const flameGroup = p.mesh.userData.flameGroup;
        if (flameGroup) {
          const flicker = 0.82 + Math.random() * 0.45;
          flameGroup.scale.set(
            0.9 + Math.random() * 0.25,
            flicker,
            0.9 + Math.random() * 0.25
          );
        }

        // Emit dense white-gray smoke trail & hot afterburner sparks directly from the tail nozzle
        p.smokeTimer += dt;
        if (p.smokeTimer > 0.025) {
          p.smokeTimer = 0;
          const tailOffset = p.type === 'boss_missile' ? -1.15 : -0.92;
          const tailPos = p.mesh.position.clone().addScaledVector(velDir, tailOffset);
          this.physics.spawnMissileExhaustTrail(tailPos, velDir);
        }
      }

      if (
        p.mesh.position.z > 20 ||
        p.mesh.position.y > 16 ||
        p.mesh.position.y < 0.1
      ) {
        this.scene.remove(p.mesh);
        this.enemyProjectiles.splice(i, 1);
      }
    }
  }
}
