import * as THREE from 'three';

/**
 * Builds and controls the Fairchild Republic A-10 Thunderbolt II ("Warthog")
 * with spinning 7-barrel GAU-8/A 30mm Avenger rotary chaingun, brass casing ejection,
 * barrel-roll evasive maneuvers, and Zaxxon ground-shadow depth projection.
 */
export class A10Warthog {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.meshGroup = new THREE.Group();
    this.root.add(this.meshGroup);
    this.scene.add(this.root);

    // Flight envelope bounds (classic Zaxxon corridor)
    this.minX = -11.5;
    this.maxX = 11.5;
    this.minY = 1.35; // Low-altitude strafing height
    this.maxY = 10.5; // High-altitude wall-clearing height

    this.position = new THREE.Vector3(0, 4.2, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.bankAngle = 0;
    this.pitchAngle = 0;

    // Barrel roll dodge state
    this.rollTimer = 0;
    this.rollCooldown = 0;
    this.rollDirection = 1;

    // GAU-8/A 30mm Rotary Chaingun state
    this.barrelSpinSpeed = 0;
    this.barrelHeat = 0;
    this.fireTimer = 0;
    this.fireInterval = 0.028; // ~36 physics projectiles/sec (visualizing 3,900 RPM stream)
    this.recoilOffset = 0;

    // Ejected 30mm brass casings pool
    this.casings = [];

    this._buildAircraftModel();
    this._buildZaxxonShadowProjector();
    this._initCasingPool();

    this.root.position.copy(this.position);
  }

  _buildAircraftModel() {
    // Desert Storm / two-tone desert camo & gunmetal materials
    const desertCamoMat = new THREE.MeshStandardMaterial({
      color: 0xc2a278,
      roughness: 0.58,
      metalness: 0.25
    });
    const darkCamoMat = new THREE.MeshStandardMaterial({
      color: 0x8c7355,
      roughness: 0.62,
      metalness: 0.22
    });
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x26292e,
      roughness: 0.35,
      metalness: 0.82
    });
    const canopyMat = new THREE.MeshPhysicalMaterial({
      color: 0x1a3848,
      roughness: 0.12,
      metalness: 0.1,
      transmission: 0.55,
      transparent: true,
      opacity: 0.82
    });
    const ordnanceMat = new THREE.MeshStandardMaterial({
      color: 0xe8e4d8,
      roughness: 0.4,
      metalness: 0.3
    });

    // 1. Main Fuselage (nose points toward -Z)
    const fuselageGeo = new THREE.CylinderGeometry(0.42, 0.34, 4.8, 12);
    fuselageGeo.rotateX(Math.PI / 2);
    const fuselage = new THREE.Mesh(fuselageGeo, desertCamoMat);
    fuselage.castShadow = true;
    fuselage.receiveShadow = true;
    this.meshGroup.add(fuselage);

    // Tapered Nose Cone (Titanium bathtub forward section)
    const noseGeo = new THREE.ConeGeometry(0.42, 1.35, 12);
    noseGeo.rotateX(-Math.PI / 2);
    const nose = new THREE.Mesh(noseGeo, darkCamoMat);
    nose.position.set(0, -0.03, -3.05);
    nose.castShadow = true;
    this.meshGroup.add(nose);

    // Warthog Shark-Mouth Nose Art Band (crimson/white accent around nose)
    const mouthGeo = new THREE.CylinderGeometry(0.32, 0.39, 0.45, 12);
    mouthGeo.rotateX(Math.PI / 2);
    const mouthMat = new THREE.MeshStandardMaterial({ color: 0xb8291e, roughness: 0.5 });
    const mouthBand = new THREE.Mesh(mouthGeo, mouthMat);
    mouthBand.position.set(0, -0.05, -2.55);
    this.meshGroup.add(mouthBand);

    // 2. Bubble Canopy & Pilot
    const canopyGeo = new THREE.SphereGeometry(0.36, 12, 10);
    canopyGeo.scale(0.85, 0.72, 2.15);
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.position.set(0, 0.34, -1.05);
    this.meshGroup.add(canopy);

    const helmetGeo = new THREE.SphereGeometry(0.14, 8, 8);
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0x3b4d38, roughness: 0.3 });
    const helmet = new THREE.Mesh(helmetGeo, helmetMat);
    helmet.position.set(0, 0.36, -1.15);
    this.meshGroup.add(helmet);

    // 3. Straight Wide Main Wings (characteristic A-10 unswept plank wings)
    const wingGeo = new THREE.BoxGeometry(5.6, 0.11, 1.05);
    const mainWing = new THREE.Mesh(wingGeo, desertCamoMat);
    mainWing.position.set(0, -0.05, -0.25);
    mainWing.castShadow = true;
    mainWing.receiveShadow = true;
    this.meshGroup.add(mainWing);

    // Camo patches on wings
    const patchGeo = new THREE.BoxGeometry(1.6, 0.115, 0.92);
    const leftPatch = new THREE.Mesh(patchGeo, darkCamoMat);
    leftPatch.position.set(-1.55, -0.05, -0.25);
    const rightPatch = new THREE.Mesh(patchGeo, darkCamoMat);
    rightPatch.position.set(1.55, -0.05, -0.25);
    this.meshGroup.add(leftPatch, rightPatch);

    // Drooped Wingtip Fairings & Navigation Lights
    for (const side of [-1, 1]) {
      const tipGeo = new THREE.BoxGeometry(0.22, 0.24, 1.12);
      const tip = new THREE.Mesh(tipGeo, darkCamoMat);
      tip.position.set(side * 2.82, -0.1, -0.25);
      tip.castShadow = true;
      this.meshGroup.add(tip);

      // Wingtip nav strobe (Red port / Green starboard)
      const navMat = new THREE.MeshBasicMaterial({
        color: side < 0 ? 0xff2211 : 0x22ff66
      });
      const navLight = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), navMat);
      navLight.position.set(side * 2.93, -0.04, -0.65);
      this.meshGroup.add(navLight);

      // Main landing gear wheel pod fairings under inner wings
      const podGeo = new THREE.CapsuleGeometry(0.16, 0.75, 6, 8);
      podGeo.rotateX(Math.PI / 2);
      const pod = new THREE.Mesh(podGeo, desertCamoMat);
      pod.position.set(side * 1.05, -0.18, -0.35);
      this.meshGroup.add(pod);

      // Underwing AGM-65 Maverick missiles & Hydra-70 rocket pods
      for (const pylonX of [1.65, 2.25]) {
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.55), gunmetalMat);
        pylon.position.set(side * pylonX, -0.18, -0.25);
        this.meshGroup.add(pylon);

        const missileGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.95, 8);
        missileGeo.rotateX(Math.PI / 2);
        const missile = new THREE.Mesh(missileGeo, ordnanceMat);
        missile.position.set(side * pylonX, -0.30, -0.30);
        missile.castShadow = true;
        this.meshGroup.add(missile);
      }
    }

    // 4. Twin High-Mounted General Electric TF34 Turbofan Engine Nacelles
    this.fanBlades = [];
    for (const side of [-1, 1]) {
      const nacelleGroup = new THREE.Group();
      nacelleGroup.position.set(side * 0.76, 0.44, 1.05);
      nacelleGroup.rotation.x = 0.06; // Characteristic slight nose-up nacelle cant

      // Outer engine cowling
      const cowlGeo = new THREE.CylinderGeometry(0.42, 0.36, 1.55, 14);
      cowlGeo.rotateX(Math.PI / 2);
      const cowl = new THREE.Mesh(cowlGeo, desertCamoMat);
      cowl.castShadow = true;
      cowl.receiveShadow = true;
      nacelleGroup.add(cowl);

      // Dark intake lip ring
      const lipGeo = new THREE.TorusGeometry(0.39, 0.045, 8, 16);
      const lip = new THREE.Mesh(lipGeo, gunmetalMat);
      lip.position.z = -0.76;
      nacelleGroup.add(lip);

      // Spinning Turbofan Blade Hub inside intake
      const fanGroup = new THREE.Group();
      fanGroup.position.z = -0.68;
      const bladeGeo = new THREE.BoxGeometry(0.68, 0.09, 0.02);
      for (let b = 0; b < 4; b++) {
        const blade = new THREE.Mesh(bladeGeo, gunmetalMat);
        blade.rotation.z = (b * Math.PI) / 4;
        fanGroup.add(blade);
      }
      nacelleGroup.add(fanGroup);
      this.fanBlades.push(fanGroup);

      // Exhaust nozzle cone + warm turbine glow
      const nozzleGeo = new THREE.CylinderGeometry(0.24, 0.34, 0.38, 12);
      nozzleGeo.rotateX(Math.PI / 2);
      const nozzle = new THREE.Mesh(nozzleGeo, gunmetalMat);
      nozzle.position.z = 0.92;
      nacelleGroup.add(nozzle);

      const glowMat = new THREE.MeshBasicMaterial({ color: 0xff7b29 });
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.22, 10), glowMat);
      glow.position.z = 1.12;
      nacelleGroup.add(glow);

      // Pylon strut connecting nacelle to rear fuselage
      const strutGeo = new THREE.BoxGeometry(0.45, 0.14, 0.85);
      const strut = new THREE.Mesh(strutGeo, darkCamoMat);
      strut.position.set(-side * 0.25, -0.18, 0);
      nacelleGroup.add(strut);

      this.meshGroup.add(nacelleGroup);
    }

    // 5. Twin H-Tail Stabilizers
    const hStabGeo = new THREE.BoxGeometry(2.35, 0.08, 0.65);
    const hStab = new THREE.Mesh(hStabGeo, desertCamoMat);
    hStab.position.set(0, 0.12, 2.25);
    hStab.castShadow = true;
    this.meshGroup.add(hStab);

    for (const side of [-1, 1]) {
      const vFinGeo = new THREE.BoxGeometry(0.09, 1.05, 0.78);
      const vFin = new THREE.Mesh(vFinGeo, darkCamoMat);
      vFin.position.set(side * 1.15, 0.48, 2.22);
      vFin.castShadow = true;
      this.meshGroup.add(vFin);
    }

    // 6. Iconic 7-Barrel 30mm GAU-8/A Avenger Rotary Chaingun
    this.gau8Group = new THREE.Group();
    // Slightly offset to port/down just like the real A-10 so the firing barrel aligns on centerline!
    this.gau8Group.position.set(-0.04, -0.16, -3.55);

    const centralHub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.9, 10).rotateX(Math.PI / 2),
      gunmetalMat
    );
    this.gau8Group.add(centralHub);

    // 7 individual 30mm barrels arranged radially
    const barrelGeo = new THREE.CylinderGeometry(0.024, 0.024, 1.05, 6);
    barrelGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2;
      const barrel = new THREE.Mesh(barrelGeo, gunmetalMat);
      barrel.position.set(Math.cos(angle) * 0.072, Math.sin(angle) * 0.072, -0.15);
      this.gau8Group.add(barrel);
    }

    // Muzzle clamp ring
    const clamp = new THREE.Mesh(
      new THREE.CylinderGeometry(0.115, 0.115, 0.08, 12).rotateX(Math.PI / 2),
      gunmetalMat
    );
    clamp.position.z = -0.52;
    this.gau8Group.add(clamp);

    this.meshGroup.add(this.gau8Group);

    // 7. Multi-lobe Volumetric Muzzle Flash + Dynamic Muzzle PointLight
    this.muzzleFlashGroup = new THREE.Group();
    this.muzzleFlashGroup.position.set(0, -0.16, -4.35);

    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd266,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const coreCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 1.35, 8).rotateX(-Math.PI / 2),
      flashMat
    );
    coreCone.position.z = -0.5;
    this.muzzleFlashGroup.add(coreCone);

    const starPlaneGeo = new THREE.PlaneGeometry(1.1, 1.1);
    const starMat = new THREE.MeshBasicMaterial({
      color: 0xff8811,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const star1 = new THREE.Mesh(starPlaneGeo, starMat);
    const star2 = new THREE.Mesh(starPlaneGeo, starMat);
    star2.rotation.z = Math.PI / 4;
    this.muzzleFlashGroup.add(star1, star2);

    this.muzzleLight = new THREE.PointLight(0xff9922, 0, 14);
    this.muzzleFlashGroup.add(this.muzzleLight);
    this.muzzleFlashGroup.visible = false;
    this.meshGroup.add(this.muzzleFlashGroup);
  }

  /**
   * Builds the Zaxxon Ground Shadow & Tactical Altitude Drop-Line directly beneath the A-10
   * so the player can always judge horizontal alignment and altitude relative to desert walls.
   */
  _buildZaxxonShadowProjector() {
    this.shadowGroup = new THREE.Group();
    this.scene.add(this.shadowGroup);

    // Crisp dark aircraft silhouette projected on the sand/tarmac
    const silGroup = new THREE.Group();
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x050403,
      transparent: true,
      opacity: 0.55,
      depthWrite: false
    });

    const bodyShadow = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 5.2), shadowMat);
    bodyShadow.rotation.x = -Math.PI / 2;
    const wingShadow = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 1.05), shadowMat);
    wingShadow.rotation.x = -Math.PI / 2;
    wingShadow.position.z = -0.25;
    const tailShadow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.65), shadowMat);
    tailShadow.rotation.x = -Math.PI / 2;
    tailShadow.position.z = 2.25;

    silGroup.add(bodyShadow, wingShadow, tailShadow);
    this.groundSilhouette = silGroup;
    this.shadowGroup.add(silGroup);

    // Tactical Laser Reticle Ring around ground shadow (color-coded by wall clearance!)
    const ringGeo = new THREE.RingGeometry(1.25, 1.42, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.reticleMat = new THREE.MeshBasicMaterial({
      color: 0x4eff8c,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.groundReticle = new THREE.Mesh(ringGeo, this.reticleMat);
    this.shadowGroup.add(this.groundReticle);

    // Vertical laser drop-line connecting the A-10 belly to its ground shadow
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 1, 0)
    ]);
    this.dropLineMat = new THREE.LineBasicMaterial({
      color: 0x4eff8c,
      transparent: true,
      opacity: 0.35
    });
    this.dropLine = new THREE.Line(lineGeo, this.dropLineMat);
    this.scene.add(this.dropLine);
  }

  _initCasingPool() {
    const casingGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.14, 6);
    const casingMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.25,
      metalness: 0.9
    });

    for (let i = 0; i < 45; i++) {
      const mesh = new THREE.Mesh(casingGeo, casingMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.casings.push({
        mesh,
        active: false,
        vel: new THREE.Vector3(),
        rotVel: new THREE.Vector3(),
        life: 0
      });
    }
  }

  spawnBrassCasing() {
    const c = this.casings.find((item) => !item.active);
    if (!c) return;
    c.active = true;
    c.life = 1.1;
    c.mesh.visible = true;
    c.mesh.position.set(
      this.position.x - 0.15,
      this.position.y - 0.32,
      this.position.z - 1.8
    );
    c.vel.set(
      -2.2 - Math.random() * 1.8,
      -1.5 - Math.random() * 1.2,
      4.5 + Math.random() * 3.0
    );
    c.rotVel.set(
      (Math.random() - 0.5) * 25,
      (Math.random() - 0.5) * 25,
      (Math.random() - 0.5) * 25
    );
  }

  triggerBarrelRoll(dir = 1) {
    if (this.rollTimer > 0 || this.rollCooldown > 0) return false;
    this.rollTimer = 0.48;
    this.rollCooldown = 0.9;
    this.rollDirection = dir >= 0 ? 1 : -1;
    return true;
  }

  get isInvulnerable() {
    return this.rollTimer > 0;
  }

  /**
   * Updates A-10 position, banking, pitch, GAU-8 barrel spin, and Zaxxon shadow projection
   */
  update(dt, input, isFiring, wallClearanceHeight = 3.6) {
    const moveSpeedX = 14.5;
    const moveSpeedY = 9.2;

    let targetVx = 0;
    let targetVy = 0;

    if (input.left) targetVx -= moveSpeedX;
    if (input.right) targetVx += moveSpeedX;
    if (input.up) targetVy += moveSpeedY;
    if (input.down) targetVy -= moveSpeedY;

    // Extra burst lateral speed during barrel roll
    if (this.rollTimer > 0) {
      this.rollTimer = Math.max(0, this.rollTimer - dt);
      targetVx += this.rollDirection * 11.0;
    }
    if (this.rollCooldown > 0) {
      this.rollCooldown = Math.max(0, this.rollCooldown - dt);
    }

    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, targetVx, 1 - Math.exp(-12 * dt));
    this.velocity.y = THREE.MathUtils.lerp(this.velocity.y, targetVy, 1 - Math.exp(-10 * dt));

    this.position.x = THREE.MathUtils.clamp(
      this.position.x + this.velocity.x * dt,
      this.minX,
      this.maxX
    );
    this.position.y = THREE.MathUtils.clamp(
      this.position.y + this.velocity.y * dt,
      this.minY,
      this.maxY
    );

    // Aerodynamic banking & pitching
    const targetBank = -this.velocity.x * 0.042;
    const targetPitch = this.velocity.y * 0.038 - (isFiring ? 0.035 : 0); // Slight nose-down for GAU-8 strafe
    this.bankAngle = THREE.MathUtils.lerp(this.bankAngle, targetBank, 1 - Math.exp(-12 * dt));
    this.pitchAngle = THREE.MathUtils.lerp(this.pitchAngle, targetPitch, 1 - Math.exp(-12 * dt));

    let rollAdd = 0;
    if (this.rollTimer > 0) {
      const progress = 1 - this.rollTimer / 0.48;
      rollAdd = -this.rollDirection * progress * Math.PI * 2;
    }

    // Spin TF34 turbofan blades
    for (const fan of this.fanBlades) {
      fan.rotation.z += dt * 32.0;
    }

    // Spin 7-barrel GAU-8/A Avenger rotary cannon & muzzle flash
    if (isFiring) {
      this.barrelSpinSpeed = THREE.MathUtils.lerp(this.barrelSpinSpeed, 55.0, 1 - Math.exp(-20 * dt));
      this.barrelHeat = Math.min(1.0, this.barrelHeat + dt * 0.24);
      this.recoilOffset = (Math.random() - 0.5) * 0.09;

      this.muzzleFlashGroup.visible = true;
      this.muzzleFlashGroup.rotation.z += dt * 45.0;
      const pulse = 0.8 + Math.random() * 0.55;
      this.muzzleFlashGroup.scale.set(pulse, pulse, 0.85 + Math.random() * 0.5);
      this.muzzleLight.intensity = 3.5 + Math.random() * 3.0;
    } else {
      this.barrelSpinSpeed = THREE.MathUtils.lerp(this.barrelSpinSpeed, 0, 1 - Math.exp(-6 * dt));
      this.barrelHeat = Math.max(0.0, this.barrelHeat - dt * 0.35);
      this.recoilOffset = 0;
      this.muzzleFlashGroup.visible = false;
      this.muzzleLight.intensity = 0;
    }

    this.gau8Group.rotation.z += this.barrelSpinSpeed * dt;

    // Apply position + GAU-8 recoil shudder
    this.root.position.set(
      this.position.x + (isFiring ? (Math.random() - 0.5) * 0.045 : 0),
      this.position.y + (isFiring ? (Math.random() - 0.5) * 0.045 : 0),
      this.position.z + this.recoilOffset
    );
    this.meshGroup.rotation.set(this.pitchAngle, 0, this.bankAngle + rollAdd);

    // Update Zaxxon Ground Shadow & Altitude Drop-Line
    const altNorm = (this.position.y - this.minY) / (this.maxY - this.minY);
    this.shadowGroup.position.set(this.position.x, 0.05, this.position.z);
    // Shadow shrinks slightly and softens as the aircraft climbs higher
    const shadowScale = THREE.MathUtils.lerp(1.0, 0.72, altNorm);
    this.groundSilhouette.scale.set(shadowScale, 1, shadowScale);
    this.groundSilhouette.rotation.y = -this.bankAngle * 0.25;

    // Color-code the reticle & drop-line by wall clearance (Red = below wall top, Amber = close, Green = clear)
    let clearanceColor = 0x4eff8c;
    if (this.position.y < wallClearanceHeight - 0.1) {
      clearanceColor = 0xff3b30;
    } else if (this.position.y < wallClearanceHeight + 1.1) {
      clearanceColor = 0xffae34;
    }
    this.reticleMat.color.setHex(clearanceColor);
    this.dropLineMat.color.setHex(clearanceColor);

    const posAttr = this.dropLine.geometry.attributes.position;
    posAttr.setXYZ(0, this.position.x, 0.06, this.position.z);
    posAttr.setXYZ(1, this.position.x, this.position.y - 0.25, this.position.z);
    posAttr.needsUpdate = true;

    // Update ejected 30mm brass casings
    for (const c of this.casings) {
      if (!c.active) continue;
      c.life -= dt;
      if (c.life <= 0 || c.mesh.position.y < 0.05) {
        c.active = false;
        c.mesh.visible = false;
        continue;
      }
      c.vel.y -= 24.0 * dt; // Gravity
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.rotVel.x * dt;
      c.mesh.rotation.y += c.rotVel.y * dt;
      c.mesh.rotation.z += c.rotVel.z * dt;
    }
  }

  /**
   * Returns muzzle world position and firing direction for GAU-8/A 30mm projectiles
   */
  getMuzzleTransform() {
    const muzzlePos = new THREE.Vector3(
      this.position.x + (Math.random() - 0.5) * 0.12,
      this.position.y - 0.18 + (Math.random() - 0.5) * 0.10,
      this.position.z - 4.25
    );
    // Slight dispersion cone characteristic of the GAU-8/A (5 mil, 80% circle) + aircraft pitch/bank influence
    const dir = new THREE.Vector3(
      -this.bankAngle * 0.18 + (Math.random() - 0.5) * 0.026,
      this.pitchAngle * 0.45 + (Math.random() - 0.5) * 0.022,
      -1.0
    ).normalize();

    return { muzzlePos, dir };
  }
}
