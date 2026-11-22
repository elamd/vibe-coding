import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import {
  MAX_SCORCHES,
  createDesertTerrainMaterial,
  HeatDistortionShader
} from './shaders.js?v=5';
import { SoundEngine } from './audio.js?v=5';
import { A10Warthog } from './a10.js?v=5';
import { PhysicsAndDestructionSystem } from './physics.js?v=5';
import { DesertWorldDirector } from './world.js?v=5';

class ZaxxonDesertHogGame {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.sound = new SoundEngine();

    // Game state: 'MENU' | 'PLAYING' | 'PAUSED' | 'RESPAWNING' | 'GAMEOVER'
    this.state = 'MENU';
    this.prePauseState = 'PLAYING';
    this.score = 0;
    this.highScore = Number(localStorage.getItem('zaxxon_deserthog_hi') || 25000);
    this.lives = 3;
    this.fuel = 100;
    this.scrollSpeed = 22.0;
    this.scrollZ = 0;
    this.levelStartScrollZ = 0;
    this.simTime = 0;
    this.cameraMode = 'ISOMETRIC'; // 'ISOMETRIC' | 'CHASE'
    this.cameraShake = 0;
    this.respawnTimer = 0;

    // FPS & Frame Time tracking
    this.fpsFrames = 0;
    this.fpsLastTime = performance.now();
    this.currentFps = 60;
    this.frameWorkAccumMs = 0;
    this.avgFrameWorkMs = 2.0;

    // Input state
    this.input = {
      up: false,
      down: false,
      left: false,
      right: false,
      firing: false
    };

    // 30mm GAU-8 Tracer projectile pool
    this.bullets = [];
    this.scorchIndex = 0;

    this._initThree();
    this._initPostProcessing();
    this._initEnvironment();
    this._initSubsystems();
    this._initGpuPhysicsDetail();
    this._initBulletPool();
    this._bindEvents();

    // Position the A-10 & camera cleanly over the sea for the initial paused menu frame
    this.a10.position.set(0, 4.5, 0);
    this.a10.update(0, this.input, false, 0);
    this._updateCamera(1.0);
    this._updateHUD();

    this.clock = new THREE.Clock();
    this._animate = this._animate.bind(this);
    requestAnimationFrame(this._animate);
  }

  _initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdca974);
    this.scene.fog = new THREE.FogExp2(0xdca974, 0.0062);

    this.camera = new THREE.PerspectiveCamera(
      40,
      window.innerWidth / window.innerHeight,
      0.5,
      260
    );
    this.camera.position.set(24.5, 24.0, 22.5);
    this.camera.lookAt(0, 3.5, -15.5);
  }

  /**
   * Detects the user's GPU renderer via WebGL and selects a sensible default
   * Destructible Physics Detail level (0..10).
   */
  _initGpuPhysicsDetail() {
    const gl = this.renderer.getContext();
    let gpuName = 'Standard WebGL GPU';
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        gpuName = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || gpuName;
      } else {
        gpuName = gl.getParameter(gl.RENDERER) || gpuName;
      }
    }

    const upper = gpuName.toUpperCase();
    const isMobile = /ANDROID|IPHONE|IPAD|MOBILE/i.test(navigator.userAgent);
    let recommended = 6;

    if (
      /SWIFTSHADER|LLVMPIPE|SOFTWARE|MESA OFFSCREEN|MICROSOFT BASIC/i.test(upper)
    ) {
      recommended = 2;
    } else if (
      /RTX|RADEON RX|RADEON PRO|GEFORCE GTX 1080|GEFORCE GTX 16|APPLE M[1-9] (PRO|MAX|ULTRA)/i.test(
        upper
      )
    ) {
      recommended = 8;
    } else if (
      /INTEL.*(ARC|IRIS)|APPLE M[1-9]|GEFORCE|RADEON/i.test(upper) &&
      !isMobile
    ) {
      recommended = 6;
    } else if (/UHD|HD GRAPHICS|ADRENO|MALI|POWERVR/i.test(upper) || isMobile) {
      recommended = 4;
    }

    this.detectedGpuName = gpuName;
    this.recommendedPhysicsDetail = recommended;
    this.setPhysicsDetailSetting(recommended);

    const noteEl = document.getElementById('gpu-detect-note');
    if (noteEl) {
      const shortGpu = gpuName.length > 58 ? gpuName.slice(0, 55) + '...' : gpuName;
      noteEl.textContent = `Auto-tuned default (${recommended}/10) for detected GPU: ${shortGpu}`;
    }
  }

  /**
   * Updates the 0..10 Destructible Physics Detail setting across physics, explosions,
   * debris/spark caps, post-processing bloom/pixelRatio, and both menu + HUD sliders.
   */
  setPhysicsDetailSetting(val) {
    const level = THREE.MathUtils.clamp(Math.round(Number(val)), 0, 10);
    this.physics.setPhysicsDetail(level);

    // Also scale renderer resolution & post-processing bloom with the detail slider
    if (this.renderer && this.composer) {
      const dpr = window.devicePixelRatio || 1;
      let targetRatio = Math.min(dpr, 1.5);
      if (level === 0) targetRatio = 0.85;
      else if (level <= 2) targetRatio = 1.0;
      else if (level >= 8) targetRatio = Math.min(dpr, 2.0);

      this.renderer.setPixelRatio(targetRatio);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);

      if (this.bloomPass) {
        this.bloomPass.enabled = level >= 1;
        this.bloomPass.strength = 0.25 + level * 0.045;
      }
      if (this.heatPass) {
        this.heatPass.enabled = level >= 2;
      }
    }

    const menuSlider = document.getElementById('physics-detail-slider');
    if (menuSlider && Number(menuSlider.value) !== level) {
      menuSlider.value = String(level);
    }
    const hudSlider = document.getElementById('hud-phys-slider');
    if (hudSlider && Number(hudSlider.value) !== level) {
      hudSlider.value = String(level);
    }

    let tierName = 'BALANCED';
    if (level === 0) tierName = 'MINIMAL / OFF';
    else if (level <= 2) tierName = 'LOW';
    else if (level <= 4) tierName = 'MEDIUM';
    else if (level <= 7) tierName = 'HIGH';
    else if (level <= 9) tierName = 'VERY HIGH';
    else tierName = 'MAXIMUM DESTRUCTION';

    const labelEl = document.getElementById('physics-detail-val');
    if (labelEl) {
      labelEl.textContent = `${level} / 10 (${tierName})`;
    }
    const hudEl = document.getElementById('hud-phys-detail');
    if (hudEl) {
      hudEl.textContent = `${level} / 10`;
    }
  }

  _initPostProcessing() {
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.52,
      0.4,
      0.78
    );
    this.composer.addPass(this.bloomPass);

    this.heatPass = new ShaderPass(HeatDistortionShader);
    this.composer.addPass(this.heatPass);
  }

  _initEnvironment() {
    const hemiLight = new THREE.HemisphereLight(0xfff1d6, 0x9c6b3b, 0.85);
    this.scene.add(hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff0d4, 2.35);
    this.sunLight.position.set(22, 48, 18);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 140;
    const d = 48;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.scene.add(this.sunLight);

    const terrainGeo = new THREE.PlaneGeometry(130, 230, 140, 200);
    terrainGeo.rotateX(-Math.PI / 2);
    this.terrainMat = createDesertTerrainMaterial();
    this.terrainMesh = new THREE.Mesh(terrainGeo, this.terrainMat);
    this.terrainMesh.position.set(0, 0, -65);
    this.terrainMesh.receiveShadow = true;
    this.scene.add(this.terrainMesh);
  }

  _initSubsystems() {
    this.a10 = new A10Warthog(this.scene);

    this.physics = new PhysicsAndDestructionSystem(
      this.scene,
      this.sound,
      (x, z, radius, heat) => this.addDesertScorch(x, z, radius, heat)
    );

    this.worldDirector = new DesertWorldDirector(
      this.scene,
      this.physics,
      this.sound
    );
    this.worldDirector.reset();
  }

  addDesertScorch(worldX, worldZ, radius = 2.0, heat = 1.0) {
    const uniforms = this.terrainMat.userData.shaderUniforms;
    if (!uniforms) return;
    const sampleZ = worldZ - this.scrollZ;
    uniforms.uScorches.value[this.scorchIndex].set(worldX, sampleZ, radius, heat);
    this.scorchIndex = (this.scorchIndex + 1) % MAX_SCORCHES;
  }

  _clearScorches() {
    const uniforms = this.terrainMat.userData.shaderUniforms;
    if (!uniforms) return;
    for (let i = 0; i < MAX_SCORCHES; i++) {
      uniforms.uScorches.value[i].set(0, -9999, 0, 0);
    }
  }

  _initBulletPool() {
    const tracerGeo = new THREE.CylinderGeometry(0.06, 0.09, 2.2, 6);
    tracerGeo.rotateX(Math.PI / 2);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffe47a
    });

    for (let i = 0; i < 90; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.bullets.push({
        mesh,
        active: false,
        vel: new THREE.Vector3(),
        life: 0
      });
    }
  }

  _spawnChaingunRound() {
    const b = this.bullets.find((item) => !item.active);
    if (!b) return;

    const { muzzlePos, dir } = this.a10.getMuzzleTransform();
    b.active = true;
    b.life = 1.15;
    b.mesh.visible = true;
    b.mesh.position.copy(muzzlePos);

    const speed = 135.0;
    b.vel.copy(dir).multiplyScalar(speed);
    b.mesh.lookAt(muzzlePos.clone().add(dir));

    this.a10.spawnBrassCasing();
  }

  _clearInputs() {
    this.input.up = false;
    this.input.down = false;
    this.input.left = false;
    this.input.right = false;
    this.input.firing = false;
  }

  pauseGame(reason = 'SORTIE PAUSED') {
    this._clearInputs();
    this.sound.setPaused(true);

    if (this.state === 'PLAYING' || this.state === 'RESPAWNING') {
      this.prePauseState = this.state;
      this.state = 'PAUSED';

      const modal = document.getElementById('overlay-screen');
      modal.querySelector('.game-title').innerHTML = `ZAXXON: <span>PAUSED</span>`;
      modal.querySelector('.game-subtitle').innerHTML =
        `${reason} &bull; Level <strong>${this.worldDirector.levelNumber}</strong> &bull; Current Score: <strong>${this.score}</strong>`;
      document.getElementById('btn-start').textContent = 'RESUME SORTIE // BRRRRRRT!';
      modal.classList.remove('hidden');
      this._updateHUD();
    }
  }

  resumeGame() {
    if (this.state !== 'PAUSED') return;
    document.getElementById('overlay-screen').classList.add('hidden');
    this.clock.getDelta();
    this.state = this.prePauseState || 'PLAYING';
    this.sound.setPaused(false);
    this.showCallout('SORTIE RESUMED', 1500);
    this._updateHUD();
  }

  _bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    });

    window.addEventListener('blur', () => {
      this._clearInputs();
      if (this.state === 'PLAYING' || this.state === 'RESPAWNING') {
        this.pauseGame('WINDOW LOST FOCUS — GAME PAUSED');
      } else {
        this.sound.setPaused(true);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._clearInputs();
        if (this.state === 'PLAYING' || this.state === 'RESPAWNING') {
          this.pauseGame('TAB HIDDEN — GAME PAUSED');
        } else {
          this.sound.setPaused(true);
        }
      }
    });

    const menuSlider = document.getElementById('physics-detail-slider');
    if (menuSlider) {
      menuSlider.addEventListener('input', (e) => {
        this.setPhysicsDetailSetting(e.target.value);
      });
    }

    const hudSlider = document.getElementById('hud-phys-slider');
    if (hudSlider) {
      hudSlider.addEventListener('input', (e) => {
        this.setPhysicsDetailSetting(e.target.value);
        this.showCallout(
          `DESTRUCTIBLE PHYSICS DETAIL SET TO ${this.physics.physicsDetail} / 10`,
          1400
        );
      });
    }

    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (this.state === 'PLAYING' || this.state === 'RESPAWNING') {
          this.pauseGame('PILOT OPENED SETTINGS MENU');
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'Escape':
        case 'KeyP':
          if (this.state === 'PLAYING' || this.state === 'RESPAWNING') {
            this.pauseGame('PILOT PAUSED SORTIE');
          } else if (this.state === 'PAUSED') {
            this.resumeGame();
          }
          break;
        case 'KeyW':
        case 'ArrowUp':
          this.input.up = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.input.down = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.input.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.input.right = true;
          break;
        case 'Space':
          e.preventDefault();
          if (this.state === 'PAUSED') {
            this.resumeGame();
          } else if (this.state === 'MENU' || this.state === 'GAMEOVER') {
            this.startGame();
          } else {
            this.input.firing = true;
          }
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
        case 'KeyE':
          if (this.state === 'PLAYING') {
            const dir = this.input.left ? -1 : 1;
            this.a10.triggerBarrelRoll(dir);
          }
          break;
        case 'KeyC':
          this.toggleCameraMode();
          break;
        case 'KeyM':
          this.toggleAudio();
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.input.up = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.input.down = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.input.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.input.right = false;
          break;
        case 'Space':
          this.input.firing = false;
          break;
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.state === 'PLAYING') {
        this.input.firing = true;
      }
    });
    window.addEventListener('mouseup', () => {
      this.input.firing = false;
    });

    document.getElementById('btn-start').addEventListener('click', () => {
      if (this.state === 'PAUSED') {
        this.resumeGame();
      } else {
        this.startGame();
      }
    });
    document.getElementById('btn-cam').addEventListener('click', () => {
      this.toggleCameraMode();
    });
    document.getElementById('btn-audio').addEventListener('click', () => {
      this.toggleAudio();
    });
  }

  toggleCameraMode() {
    this.cameraMode = this.cameraMode === 'ISOMETRIC' ? 'CHASE' : 'ISOMETRIC';
    document.getElementById('cam-mode-label').textContent =
      this.cameraMode === 'ISOMETRIC' ? 'ISOMETRIC (ZAXXON)' : 'TACTICAL CHASE';
  }

  toggleAudio() {
    const on = this.sound.toggleMute();
    document.getElementById('btn-audio').textContent = `[M] AUDIO: ${on ? 'ON' : 'OFF'}`;
  }

  showCallout(text, duration = 2600) {
    const banner = document.getElementById('callout-banner');
    banner.textContent = text;
    banner.classList.remove('hidden');
    clearTimeout(this._calloutTimeout);
    this._calloutTimeout = setTimeout(() => {
      banner.classList.add('hidden');
    }, duration);
  }

  startGame() {
    this.sound.init();
    this.sound.setPaused(false);
    document.getElementById('overlay-screen').classList.add('hidden');
    document.getElementById('boss-hud').classList.add('hidden');

    this.clock.getDelta();

    this.score = 0;
    this.lives = 3;
    this.fuel = 100;
    this.scrollZ = 0;
    this.levelStartScrollZ = 0;

    this.physics.clearAll();
    this._clearScorches();

    for (const b of this.bullets) {
      b.active = false;
      b.mesh.visible = false;
    }

    this.worldDirector.startLevel(1);

    this.a10.position.set(0, 4.5, 0);
    this.a10.root.visible = true;
    this.a10.shadowGroup.visible = true;
    this.a10.dropLine.visible = true;
    this.state = 'PLAYING';
    this.showCallout('LEVEL 1 // APPROACHING DESERT COAST FROM THE SEA...', 3000);
    this._updateHUD();
  }

  _triggerPlayerCrash(reason = 'WALL IMPACT') {
    if (this.state !== 'PLAYING' || this.a10.isInvulnerable) return;

    this.sound.stopBrrrt();
    this.cameraShake = 1.4;
    this.heatPass.uniforms.uShockStrength.value = 1.0;

    this.physics.spawnObjectExplosion(
      this.a10.position.clone(),
      1.85,
      [0xc2a278, 0x8c7355, 0x26292e, 0xff5500]
    );

    this.a10.root.visible = false;
    this.a10.shadowGroup.visible = false;
    this.a10.dropLine.visible = false;

    this.lives -= 1;
    this._updateHUD();

    const dmgOverlay = document.getElementById('damage-overlay');
    dmgOverlay.style.opacity = '0.9';
    setTimeout(() => {
      dmgOverlay.style.opacity = '0';
    }, 450);

    if (this.lives <= 0) {
      this._clearInputs();
      this.state = 'GAMEOVER';
      this.sound.setPaused(true);
      this.showCallout(`${reason} // MISSION OVER`, 3500);

      const modal = document.getElementById('overlay-screen');
      modal.querySelector('.game-title').innerHTML = `SORTIE <span>DOWN</span>`;
      modal.querySelector('.game-subtitle').innerHTML =
        `${reason} &bull; Reached <strong>Level ${this.worldDirector.levelNumber}</strong> &bull; Final Score: <strong>${this.score}</strong> &bull; Wall Breaches: <strong>${this.physics.breachesCreated}</strong>`;
      document.getElementById('btn-start').textContent = 'LAUNCH NEW SORTIE // BRRRRRRT!';
      modal.classList.remove('hidden');
    } else {
      this.state = 'RESPAWNING';
      this.respawnTimer = 2.0;
      this.showCallout(`${reason} // DEPLOYING NEXT A-10 WARTHOG...`, 1900);
    }
  }

  _getUpcomingWallClearanceHeight() {
    let maxWallTop = 0;
    const px = this.a10.position.x;

    for (const b of this.physics.wallBlocks) {
      if (b.destroyed) continue;
      if (b.mesh.position.z < 1.5 && b.mesh.position.z > -36) {
        if (Math.abs(b.mesh.position.x - px) < b.width * 0.85) {
          const topY = b.mesh.position.y + b.height * 0.5;
          if (topY > maxWallTop) maxWallTop = topY;
        }
      }
    }
    return maxWallTop;
  }

  _updateBulletsAndCollisions(dt) {
    for (const b of this.bullets) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }

      const prevPos = b.mesh.position.clone();
      b.mesh.position.addScaledVector(b.vel, dt);
      const pos = b.mesh.position;

      if (pos.y <= 0.15) {
        if (this.physics.physicsDetail > 0) {
          this.addDesertScorch(pos.x, pos.z, 1.15, 0.75);
          this.physics.spawnSmokePuff(pos, 0.38, 0xd8b27c, false);
        }
        b.active = false;
        b.mesh.visible = false;
        continue;
      }

      let hitSomething = false;
      for (const block of this.physics.wallBlocks) {
        if (block.destroyed) continue;
        const bp = block.mesh.position;
        if (
          Math.abs(pos.z - bp.z) < block.depth * 0.75 ||
          (prevPos.z >= bp.z && pos.z <= bp.z)
        ) {
          if (
            Math.abs(pos.x - bp.x) < block.width * 0.55 &&
            Math.abs(pos.y - bp.y) < block.height * 0.55
          ) {
            const shattered = this.physics.damageWallBlock(
              block,
              pos,
              b.vel.clone().normalize(),
              1
            );
            if (shattered) {
              this._addScore(75);
            }
            b.active = false;
            b.mesh.visible = false;
            hitSomething = true;
            break;
          }
        }
      }
      if (hitSomething) continue;

      for (let i = this.worldDirector.targets.length - 1; i >= 0; i--) {
        const t = this.worldDirector.targets[i];
        const tp = t.mesh.position;
        const targetCenterY = t.type === 'air_enemy' ? tp.y : tp.y + t.height * 0.5;

        if (
          Math.abs(pos.z - tp.z) < t.radius + 0.9 &&
          Math.abs(pos.x - tp.x) < t.radius + 0.45 &&
          Math.abs(pos.y - targetCenterY) < t.height * 0.65 + 0.5
        ) {
          t.hp -= 1;
          this.physics.spawnImpactSparksAndChips(pos, b.vel.clone().normalize(), 1);
          b.active = false;
          b.mesh.visible = false;
          hitSomething = true;

          if (t.hp <= 0) {
            const blastOrigin = new THREE.Vector3(tp.x, targetCenterY, tp.z);
            this.physics.spawnObjectExplosion(
              blastOrigin,
              t.explosionScale || 1.3,
              t.palette
            );
            this.cameraShake = Math.max(
              this.cameraShake,
              (0.2 + this.physics.physicsDetail * 0.06) * (t.explosionScale || 1.2)
            );
            this.heatPass.uniforms.uShockStrength.value = Math.min(
              1.0,
              this.heatPass.uniforms.uShockStrength.value +
                0.15 +
                this.physics.physicsDetail * 0.04
            );

            this._addScore(t.score);
            if (t.fuelBonus) {
              this.fuel = Math.min(100, this.fuel + t.fuelBonus);
              this.sound.playFuelReplenish();
            }
            if (t.type === 'air_enemy' || t.type === 'parked_jet') {
              this.worldDirector.planesRemaining = Math.max(
                0,
                this.worldDirector.planesRemaining - 1
              );
            }

            this.scene.remove(t.mesh);
            if (t.shadowMesh) this.scene.remove(t.shadowMesh);
            this.worldDirector.targets.splice(i, 1);
          }
          break;
        }
      }
      if (hitSomething) continue;

      for (let i = this.worldDirector.enemyProjectiles.length - 1; i >= 0; i--) {
        const ep = this.worldDirector.enemyProjectiles[i];
        if (pos.distanceTo(ep.mesh.position) < ep.radius + 0.45) {
          ep.hp -= 1;
          b.active = false;
          b.mesh.visible = false;
          hitSomething = true;
          if (ep.hp <= 0) {
            this.physics.spawnObjectExplosion(
              ep.mesh.position,
              0.9,
              [0xf7f9fc, 0xd93829, 0xffae34]
            );
            this._addScore(250);
            this.scene.remove(ep.mesh);
            this.worldDirector.enemyProjectiles.splice(i, 1);
          }
          break;
        }
      }
      if (hitSomething) continue;

      const boss = this.worldDirector.boss;
      if (boss) {
        const bp = boss.mesh.position;
        if (
          Math.abs(pos.z - bp.z) < 3.5 &&
          Math.abs(pos.x - bp.x) < 5.2 &&
          pos.y > 0.2 &&
          pos.y < 6.2
        ) {
          boss.hp -= 1;
          this.physics.spawnImpactSparksAndChips(pos, b.vel.clone().normalize(), 1);
          b.active = false;
          b.mesh.visible = false;

          if (boss.hp % 8 === 0) {
            this.physics.spawnObjectExplosion(pos.clone(), 0.95, [0x5c6346, 0xb89668, 0xd93829]);
          }

          if (boss.hp <= 0) {
            this._defeatBossAndAdvanceLevel();
          }
        }
      }
    }
  }

  _defeatBossAndAdvanceLevel() {
    const boss = this.worldDirector.boss;
    if (!boss) return;
    const bp = boss.mesh.position.clone();
    const completedLevel = this.worldDirector.levelNumber;
    const nextLevel = completedLevel + 1;

    for (const offset of [
      new THREE.Vector3(0, 2.5, 0),
      new THREE.Vector3(-4.0, 3.2, 0.5),
      new THREE.Vector3(4.0, 3.2, 0.5),
      new THREE.Vector3(0, 4.5, -1.0)
    ]) {
      this.physics.spawnObjectExplosion(
        bp.clone().add(offset),
        2.1,
        [0x5c6346, 0xb89668, 0xd93829, 0xf0af24, 0x2a2d32]
      );
    }

    this.cameraShake = 2.0;
    this.heatPass.uniforms.uShockStrength.value = 1.2;
    this._addScore(5000 * completedLevel);
    this.fuel = 100;

    this.scene.remove(boss.mesh);
    this.worldDirector.boss = null;
    document.getElementById('boss-hud').classList.add('hidden');

    this.physics.clearAll();
    this._clearScorches();
    this.levelStartScrollZ = this.scrollZ;
    this.worldDirector.startLevel(nextLevel);

    this.showCallout(
      `LEVEL ${completedLevel} COMPLETE! +${5000 * completedLevel} PTS // LEVEL ${nextLevel}: APPROACHING NEXT COAST FROM THE SEA`,
      4000
    );
  }

  _checkPlayerCollisions() {
    if (this.state !== 'PLAYING' || this.a10.isInvulnerable) return;
    const p = this.a10.position;

    for (const b of this.physics.wallBlocks) {
      if (b.destroyed) continue;
      const bp = b.mesh.position;
      if (
        Math.abs(p.z - bp.z) < b.depth * 0.5 + 1.1 &&
        Math.abs(p.x - bp.x) < b.width * 0.5 + 1.25 &&
        Math.abs(p.y - bp.y) < b.height * 0.5 + 0.32
      ) {
        this.physics.shatterWallBlock(b, p, new THREE.Vector3(0, 0, -1));
        this._triggerPlayerCrash('FORTRESS WALL COLLISION');
        return;
      }
    }

    for (const bar of this.worldDirector.barriers) {
      if (!bar.active) continue;
      const bp = bar.mesh.position;
      if (
        Math.abs(p.z - bp.z) < 0.9 &&
        Math.abs(p.x - bp.x) < bar.width * 0.48 &&
        p.y < bar.height + 0.25
      ) {
        this._triggerPlayerCrash('LASER BARRIER IMPACT');
        return;
      }
    }

    for (let i = this.worldDirector.targets.length - 1; i >= 0; i--) {
      const t = this.worldDirector.targets[i];
      const tp = t.mesh.position;
      const centerY = t.type === 'air_enemy' ? tp.y : tp.y + t.height * 0.5;
      if (
        Math.abs(p.z - tp.z) < t.radius + 1.1 &&
        Math.abs(p.x - tp.x) < t.radius + 1.2 &&
        Math.abs(p.y - centerY) < t.height * 0.5 + 0.35
      ) {
        this.physics.spawnObjectExplosion(tp, 1.4, t.palette);
        this.scene.remove(t.mesh);
        if (t.shadowMesh) this.scene.remove(t.shadowMesh);
        this.worldDirector.targets.splice(i, 1);
        this._triggerPlayerCrash('TARGET COLLISION');
        return;
      }
    }

    for (let i = this.worldDirector.enemyProjectiles.length - 1; i >= 0; i--) {
      const ep = this.worldDirector.enemyProjectiles[i];
      if (p.distanceTo(ep.mesh.position) < ep.radius + 0.85) {
        this.scene.remove(ep.mesh);
        this.worldDirector.enemyProjectiles.splice(i, 1);
        this._triggerPlayerCrash(
          ep.isMissile ? 'SURFACE-TO-AIR MISSILE HIT' : 'ANTI-AIRCRAFT FLAK HIT'
        );
        return;
      }
    }
  }

  _addScore(pts) {
    this.score += pts;
    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem('zaxxon_deserthog_hi', String(this.highScore));
    }
  }

  _updateCamera(dt) {
    this.cameraShake = Math.max(0, this.cameraShake - dt * 2.8);
    const shakeX = (Math.random() - 0.5) * this.cameraShake * 0.8;
    const shakeY = (Math.random() - 0.5) * this.cameraShake * 0.8;

    if (this.cameraMode === 'ISOMETRIC') {
      const targetCamPos = new THREE.Vector3(
        24.5 + this.a10.position.x * 0.32 + shakeX,
        24.0 + this.a10.position.y * 0.25 + shakeY,
        22.5
      );
      this.camera.position.lerp(targetCamPos, 1 - Math.exp(-8 * dt));
      this.camera.lookAt(
        this.a10.position.x * 0.28,
        2.8 + this.a10.position.y * 0.18,
        -15.5
      );
    } else {
      const targetCamPos = new THREE.Vector3(
        this.a10.position.x * 0.75 + shakeX,
        this.a10.position.y + 4.2 + shakeY,
        14.5
      );
      this.camera.position.lerp(targetCamPos, 1 - Math.exp(-10 * dt));
      this.camera.lookAt(
        this.a10.position.x * 0.5,
        this.a10.position.y * 0.7 + 1.5,
        -24.0
      );
    }
  }

  _updateFpsCounter(frameWorkMs) {
    this.fpsFrames++;
    this.frameWorkAccumMs += frameWorkMs;
    const now = performance.now();
    const elapsedMs = now - this.fpsLastTime;
    if (elapsedMs >= 250) {
      this.currentFps = Math.round((this.fpsFrames * 1000) / elapsedMs);
      this.avgFrameWorkMs = this.frameWorkAccumMs / this.fpsFrames;
      this.fpsFrames = 0;
      this.frameWorkAccumMs = 0;
      this.fpsLastTime = now;

      const fpsValEl = document.getElementById('fps-val');
      const fpsBadgeEl = document.getElementById('fps-badge');
      if (fpsValEl) {
        fpsValEl.textContent = `${this.currentFps} FPS • ${this.avgFrameWorkMs.toFixed(1)}ms`;
      }
      if (fpsBadgeEl) {
        fpsBadgeEl.classList.toggle('warn', this.currentFps < 45 && this.currentFps >= 28);
        fpsBadgeEl.classList.toggle('low', this.currentFps < 28);
      }
    }
  }

  _updateHUD() {
    document.getElementById('score-val').textContent = String(this.score).padStart(6, '0');
    document.getElementById('hiscore-val').textContent = String(this.highScore).padStart(6, '0');

    const livesEl = document.getElementById('lives-container');
    if (livesEl.childElementCount !== Math.max(0, this.lives)) {
      livesEl.innerHTML = '';
      for (let i = 0; i < Math.max(0, this.lives); i++) {
        const icon = document.createElement('span');
        icon.className = 'life-jet';
        livesEl.appendChild(icon);
      }
    }

    document.getElementById('sector-name').textContent = this.worldDirector.getSectorTitle();
    const fuelFill = document.getElementById('fuel-bar-fill');
    fuelFill.style.width = `${Math.max(0, this.fuel).toFixed(1)}%`;
    fuelFill.classList.toggle('low-fuel', this.fuel < 25);
    document.getElementById('fuel-pct').textContent = `${Math.ceil(this.fuel)}%`;

    const isFiring = this.state === 'PLAYING' && this.input.firing;
    const brrrtBadge = document.getElementById('brrrt-indicator');
    brrrtBadge.textContent = isFiring ? 'BRRRRRRT!' : 'READY';
    brrrtBadge.classList.toggle('firing', isFiring);
    document.getElementById('heat-bar-fill').style.width = `${(
      this.a10.barrelHeat * 100
    ).toFixed(0)}%`;

    const altNorm =
      (this.a10.position.y - this.a10.minY) / (this.a10.maxY - this.a10.minY);
    const pip = document.getElementById('alt-pip');
    pip.style.bottom = `${(altNorm * 88 + 4).toFixed(1)}%`;
    const altFeet = Math.round(40 + altNorm * 460);
    document.getElementById('alt-feet').textContent = `${altFeet} FT`;

    const wallHeight = this._getUpcomingWallClearanceHeight();
    const clearanceEl = document.getElementById('clearance-badge');
    if (wallHeight > 0 && this.a10.position.y < wallHeight) {
      clearanceEl.textContent = 'WALL DANGER';
      clearanceEl.className = 'clearance-badge danger';
    } else if (this.a10.position.y < 2.6) {
      clearanceEl.textContent = 'LOW STRAFE';
      clearanceEl.className = 'clearance-badge warn';
    } else {
      clearanceEl.textContent = 'ALT CLEAR';
      clearanceEl.className = 'clearance-badge safe';
    }

    document.getElementById('enemy-count').textContent = `${Math.round(
      this.worldDirector.getLevelProgressPercent()
    )}%`;
    document.getElementById('breach-count').textContent = String(
      this.physics.breachesCreated
    );
    document.getElementById('debris-count').textContent = String(
      this.physics.debrisList.length
    );
    const sparkEl = document.getElementById('spark-count');
    if (sparkEl) {
      sparkEl.textContent = String(this.physics.sparksList.length);
    }

    const bossHud = document.getElementById('boss-hud');
    if (this.worldDirector.boss) {
      bossHud.classList.remove('hidden');
      const pct = Math.max(
        0,
        (this.worldDirector.boss.hp / this.worldDirector.boss.maxHp) * 100
      );
      document.getElementById('boss-bar-fill').style.width = `${pct.toFixed(1)}%`;
    } else {
      bossHud.classList.add('hidden');
    }
  }

  _animate() {
    requestAnimationFrame(this._animate);
    const frameStart = performance.now();

    const rawDt = this.clock.getDelta();
    const overlayVisible = !document
      .getElementById('overlay-screen')
      .classList.contains('hidden');

    const isPaused =
      overlayVisible ||
      this.state === 'MENU' ||
      this.state === 'PAUSED' ||
      this.state === 'GAMEOVER';

    if (isPaused) {
      const tUniforms = this.terrainMat.userData.shaderUniforms;
      if (tUniforms) {
        tUniforms.uTime.value = this.simTime;
        tUniforms.uScrollZ.value = this.scrollZ;
        tUniforms.uLevelStartScrollZ.value = this.levelStartScrollZ;
      }
      this.composer.render();
      this._updateFpsCounter(performance.now() - frameStart);
      return;
    }

    const dt = Math.min(rawDt, 0.05);
    this.simTime += dt;

    const effectiveScroll = this.worldDirector.boss
      ? this.scrollSpeed * 0.18
      : this.scrollSpeed;
    this.scrollZ += effectiveScroll * dt;

    const tUniforms = this.terrainMat.userData.shaderUniforms;
    if (tUniforms) {
      tUniforms.uTime.value = this.simTime;
      tUniforms.uScrollZ.value = this.scrollZ;
      tUniforms.uLevelStartScrollZ.value = this.levelStartScrollZ;
      for (let i = 0; i < MAX_SCORCHES; i++) {
        const sc = tUniforms.uScorches.value[i];
        if (sc.w > 0) sc.w = Math.max(0, sc.w - dt * 0.45);
      }
    }

    this.heatPass.uniforms.uTime.value = this.simTime;
    this.heatPass.uniforms.uShockStrength.value = Math.max(
      0,
      this.heatPass.uniforms.uShockStrength.value - dt * 1.6
    );

    const wallClearance = this._getUpcomingWallClearanceHeight();

    if (this.state === 'PLAYING') {
      const isFiring = this.input.firing;
      this.a10.update(dt, this.input, isFiring, wallClearance);

      const altNorm =
        (this.a10.position.y - this.a10.minY) / (this.a10.maxY - this.a10.minY);
      this.sound.updateEnginePitch(altNorm, isFiring);

      if (isFiring) {
        this.sound.startBrrrt();
        this.a10.fireTimer -= dt;
        while (this.a10.fireTimer <= 0) {
          this.a10.fireTimer += this.a10.fireInterval;
          this._spawnChaingunRound();
        }
      } else {
        this.sound.stopBrrrt();
        this.a10.fireTimer = 0;
      }

      if (this.worldDirector.stageIndex >= 1) {
        this.fuel -= dt * 1.65;
        if (this.fuel <= 0) {
          this.fuel = 0;
          this._triggerPlayerCrash('JP-8 FUEL EXHAUSTED');
        }
      }

      this._updateBulletsAndCollisions(dt);
      this.physics.update(dt, effectiveScroll);
      this.worldDirector.update(dt, this.scrollSpeed, this.a10.position, (newStage) => {
        const lvl = this.worldDirector.levelNumber;
        if (newStage === 1) {
          this.showCallout(`LEVEL ${lvl} // LANDFALL! CROSSING BEACHHEAD & OUTER DUNES`);
        } else if (newStage === 2) {
          this.showCallout(`LEVEL ${lvl} // ENTERING FORTIFIED DESERT BASE — BREACH THE WALLS!`);
        } else if (newStage === 3) {
          this.showCallout(`WARNING // LEVEL ${lvl} ZAXXON MK-IV DESERT MOBILE CITADEL!`);
          this.sound.playAlertBeep();
        }
      });

      this._checkPlayerCollisions();
    } else if (this.state === 'RESPAWNING') {
      this._updateBulletsAndCollisions(dt);
      this.physics.update(dt, effectiveScroll);
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.fuel = 100;
        this.a10.position.set(0, 6.2, 0);
        this.a10.root.visible = true;
        this.a10.shadowGroup.visible = true;
        this.a10.dropLine.visible = true;
        this.a10.triggerBarrelRoll(1);
        this.state = 'PLAYING';
      }
    }

    this._updateCamera(dt);
    this._updateHUD();

    this.composer.render();
    this._updateFpsCounter(performance.now() - frameStart);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.game = new ZaxxonDesertHogGame();
});
