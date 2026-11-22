import * as THREE from 'three';

export const MAX_SCORCHES = 24;

// Distance thresholds (in world units from the start of each level)
export const COASTLINE_START_DIST = 78.0; // Ocean -> Foaming Surf & Wet Beach shoreline (visible ahead at start!)
export const DESERT_START_DIST = 105.0;   // Beach -> Dry Desert Dunes
export const BASE_START_DIST = 215.0;     // Desert Dunes -> Fortified Base Tarmac

// Shared GLSL Simplex/Value noise helpers (verified 100% valid WebGL GLSL)
const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm2D(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += amp * noise2D(p);
    p = rot * p * 2.03;
    amp *= 0.5;
  }
  return v;
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3D(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}
`;

/**
 * Creates a shadow-receiving PBR terrain material that transitions seamlessly at the start
 * of each level from:
 *   1. Open Deep Blue & Turquoise Sea with animated 3D ocean waves & whitecaps
 *   2. Crashing white surf & wet sandy beach shoreline
 *   3. Coastal desert sand dunes
 *   4. Fortified desert airbase tarmac, canyon mesas, and dynamic bullet/explosion craters
 *
 * SCROLL DIRECTION:
 * Objects in the world move toward +Z (`z += scrollSpeed * dt`).
 * Therefore, a point locked to the scrolling ground has intrinsic coordinate:
 *   `sampleZ = wp0.z - uScrollZ`
 * and forward distance into the current level:
 *   `forwardDist = (uScrollZ - uLevelStartScrollZ) - wp0.z`
 */
export function createDesertTerrainMaterial() {
  const scorches = [];
  for (let i = 0; i < MAX_SCORCHES; i++) {
    scorches.push(new THREE.Vector4(0, -9999, 0, 0)); // x, sampleZ, radius, heat
  }

  const uniforms = {
    uTime: { value: 0 },
    uScrollZ: { value: 0 },
    uLevelStartScrollZ: { value: 0 },
    uScorches: { value: scorches }
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0.08
  });

  material.userData.shaderUniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uScrollZ = uniforms.uScrollZ;
    shader.uniforms.uLevelStartScrollZ = uniforms.uLevelStartScrollZ;
    shader.uniforms.uScorches = uniforms.uScorches;

    shader.vertexShader =
      /* glsl */ `
      uniform float uTime;
      uniform float uScrollZ;
      uniform float uLevelStartScrollZ;
      varying vec3 vWorldPos;
      varying float vElevation;
      varying float vSampleZ;
      varying float vForwardDist;
      ${GLSL_NOISE}
      ` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vec4 wp0 = modelMatrix * vec4(transformed, 1.0);

        // sampleZ = wp0.z - uScrollZ moves toward +Z at the exact same speed as buildings & rocks
        float sampleZ = wp0.z - uScrollZ;
        // How far forward along the current level this vertex lies
        float forwardDist = (uScrollZ - uLevelStartScrollZ) - wp0.z;

        // Natural curved coastline across X
        float coastCurve = sin(wp0.x * 0.08) * 6.0 + (noise2D(vec2(wp0.x * 0.12, 1.5)) - 0.5) * 10.0;
        float distFromShore = forwardDist - (${COASTLINE_START_DIST.toFixed(1)} + coastCurve);

        // Land mask: 0.0 in the sea, rising smoothly across the beach into the desert
        float landMask = smoothstep(-2.0, 24.0, distFromShore);
        float inlandMask = smoothstep(22.0, 88.0, distFromShore);

        // Animated 3D ocean wave swells when over water
        float seaSwell = (sin(wp0.x * 0.35 + sampleZ * 0.45 + uTime * 2.6) * 0.28
                        + cos(wp0.x * 0.22 - sampleZ * 0.55 + uTime * 2.1) * 0.22) * (1.0 - landMask);

        // Desert dunes & canyon mesas once on land
        float corridorMask = smoothstep(15.5, 28.0, abs(wp0.x));
        float duneHeight = fbm2D(vec2(wp0.x * 0.08, sampleZ * 0.06)) * 5.2
                         + sin(wp0.x * 0.25 + sampleZ * 0.12) * 1.3;
        float mesaWall = smoothstep(26.0, 44.0, abs(wp0.x))
                       * (7.5 + fbm2D(vec2(wp0.x * 0.14, sampleZ * 0.14)) * 8.5)
                       * inlandMask;

        float innerSand = smoothstep(9.0, 15.0, abs(wp0.x))
                        * (noise2D(vec2(wp0.x * 0.3, sampleZ * 0.25)) - 0.5) * 0.42;

        float elev = seaSwell + landMask * (corridorMask * duneHeight + innerSand) + mesaWall;
        transformed.y += elev;

        vElevation = elev;
        vSampleZ = sampleZ;
        vForwardDist = distFromShore;
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
      );

    shader.fragmentShader =
      /* glsl */ `
      uniform float uTime;
      uniform float uScrollZ;
      uniform float uLevelStartScrollZ;
      uniform vec4 uScorches[${MAX_SCORCHES}];
      varying vec3 vWorldPos;
      varying float vElevation;
      varying float vSampleZ;
      varying float vForwardDist;
      ${GLSL_NOISE}
      ` +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        float sz = vSampleZ;
        vec2 uvWorld = vec2(vWorldPos.x, sz);

        // 1. VIVID OCEAN / SEA SHADER (vForwardDist < 0 is open sea, 0..16 is surf & wet beach)
        vec2 waveUv1 = uvWorld * 0.26 + vec2(uTime * 0.22, -uTime * 0.32);
        vec2 waveUv2 = uvWorld * 0.54 + vec2(-uTime * 0.25, uTime * 0.18);
        float wavePattern = fbm2D(waveUv1) * 0.6 + noise2D(waveUv2) * 0.4;

        vec3 deepOceanBlue = vec3(0.03, 0.24, 0.52);
        vec3 midSeaBlue = vec3(0.05, 0.42, 0.68);
        vec3 coastalAqua = vec3(0.12, 0.66, 0.74);

        float midBlend = smoothstep(-70.0, -18.0, vForwardDist);
        float shallowBlend = smoothstep(-22.0, 2.0, vForwardDist);
        vec3 seaCol = mix(deepOceanBlue, midSeaBlue, midBlend);
        seaCol = mix(seaCol, coastalAqua, shallowBlend);

        // Open-water rolling wave bands & whitecaps
        float openWaveCrest = sin(sz * 0.55 + vWorldPos.x * 0.15 - uTime * 2.4 + wavePattern * 3.0);
        float whitecap = smoothstep(0.75, 0.96, openWaveCrest) * 0.45;
        float glint = pow(clamp(wavePattern * 1.38, 0.0, 1.0), 4.5);
        seaCol += vec3(0.55, 0.80, 0.95) * glint * 0.7 + vec3(0.9, 0.96, 1.0) * whitecap;

        // Animated foaming surf waves crashing onto the sandy beach
        float surfWash = sin(vForwardDist * 0.72 - uTime * 3.4 + fbm2D(uvWorld * 0.25) * 2.5);
        float surfZone = smoothstep(-16.0, -1.0, vForwardDist) * (1.0 - smoothstep(2.0, 10.0, vForwardDist));
        float foamLine = smoothstep(0.35, 0.82, surfWash) * surfZone;
        float shoreEdgeFoam = (1.0 - smoothstep(0.0, 3.6, abs(vForwardDist - sin(uTime * 2.2 + vWorldPos.x * 0.28) * 1.6))) * 0.92;
        float totalFoam = clamp(foamLine + shoreEdgeFoam, 0.0, 1.0);
        seaCol = mix(seaCol, vec3(0.96, 0.99, 1.0), totalFoam);

        // 2. BEACH & DESERT SAND SHADER
        float ripple = sin(uvWorld.x * 3.8 + uvWorld.y * 2.2 + fbm2D(uvWorld * 0.45) * 4.5) * 0.5 + 0.5;
        float macroSand = fbm2D(uvWorld * 0.07);

        vec3 wetBeachSand = vec3(0.62, 0.47, 0.30);
        vec3 warmSand = vec3(0.87, 0.68, 0.44);
        vec3 paleDune = vec3(0.94, 0.80, 0.57);
        vec3 canyonRock = vec3(0.58, 0.36, 0.23);
        vec3 strataDark = vec3(0.36, 0.22, 0.14);

        vec3 drySandCol = mix(warmSand, paleDune, ripple * 0.45 + macroSand * 0.55);
        float dryBlend = smoothstep(3.0, 24.0, vForwardDist);
        vec3 sandCol = mix(wetBeachSand, drySandCol, dryBlend);

        // 3. DESERT FORTRESS BASE TARMAC (Only appears once vForwardDist > 115 inside the base!)
        float baseReachMask = smoothstep(105.0, 128.0, vForwardDist);
        float runwayMask = (1.0 - smoothstep(13.2, 13.8, abs(vWorldPos.x))) * baseReachMask;
        vec3 tarmacCol = vec3(0.32, 0.30, 0.27) + (noise2D(uvWorld * 1.6) - 0.5) * 0.05;

        // Concrete slab grid lines on fortress floor
        float gridX = smoothstep(0.93, 0.98, abs(sin(vWorldPos.x * 1.047)));
        float gridZ = smoothstep(0.93, 0.98, abs(sin(sz * 1.047)));
        tarmacCol = mix(tarmacCol, vec3(0.22, 0.20, 0.18), max(gridX, gridZ) * 0.65);

        // Yellow/black hazard stripes along fortress edge
        float edgeBand = smoothstep(12.2, 12.4, abs(vWorldPos.x)) * (1.0 - smoothstep(13.1, 13.3, abs(vWorldPos.x)));
        float chevron = step(0.5, fract((vWorldPos.x + sz) * 0.6));
        vec3 hazardCol = mix(vec3(0.95, 0.72, 0.12), vec3(0.12, 0.12, 0.12), chevron);
        tarmacCol = mix(tarmacCol, hazardCol, edgeBand * 0.85);

        // Center dashed runway line
        float centerLine = (1.0 - smoothstep(0.18, 0.25, abs(vWorldPos.x))) * step(0.45, fract(sz * 0.12));
        tarmacCol = mix(tarmacCol, vec3(0.92, 0.86, 0.70), centerLine * 0.6);

        // Wind-blown sand drifting across tarmac
        float sandDrift = smoothstep(0.48, 0.78, fbm2D(uvWorld * 0.11));
        vec3 landCol = mix(sandCol, mix(tarmacCol, sandCol, sandDrift * 0.55), runwayMask);

        // Canyon rock strata on high elevation walls
        float rockMask = smoothstep(1.8, 6.5, vElevation);
        float strata = sin(vElevation * 2.8 + macroSand * 3.0) * 0.5 + 0.5;
        vec3 mesaCol = mix(canyonRock, strataDark, strata);
        landCol = mix(landCol, mesaCol, rockMask);

        // Sparkle quartz grains in desert sunlight
        float sparkle = pow(hash21(floor(uvWorld * 18.0)), 18.0);
        landCol += vec3(0.25, 0.22, 0.15) * sparkle * (1.0 - runwayMask) * dryBlend;

        // Blend Sea -> Beach/Land across shoreline
        float shoreBlend = smoothstep(-2.0, 4.5, vForwardDist);
        vec3 groundCol = mix(seaCol, landCol, shoreBlend);

        // Dynamic bullet & explosion scorch craters (on land)
        if (shoreBlend > 0.2) {
          for (int i = 0; i < ${MAX_SCORCHES}; i++) {
            vec4 sc = uScorches[i];
            if (sc.z > 0.01) {
              float d = length(vec2(vWorldPos.x - sc.x, sz - sc.y));
              float soot = (1.0 - smoothstep(sc.z * 0.25, sc.z, d)) * shoreBlend;
              float rim = smoothstep(sc.z * 0.4, sc.z * 0.75, d) * (1.0 - smoothstep(sc.z * 0.75, sc.z * 1.1, d));
              groundCol = mix(groundCol, vec3(0.07, 0.06, 0.05), soot * 0.82);
              groundCol += vec3(1.0, 0.38, 0.05) * soot * sc.w * 1.6;
              groundCol = mix(groundCol, warmSand * 0.65, rim * 0.4 * shoreBlend);
            }
          }
        }

        diffuseColor.rgb = groundCol;
        `
      );
  };

  return material;
}

/**
 * Creates a custom GLSL-enhanced PBR material for destructible sandstone/concrete fortress wall blocks.
 */
export function createWallMaterial(damageLevel = 0, variant = 0) {
  const baseColors = [
    new THREE.Color(0xc89d6c), // Desert sandstone bunker
    new THREE.Color(0x9e9589), // Reinforced concrete
    new THREE.Color(0xb5835a)  // Weathered adobe/red rock
  ];

  const material = new THREE.MeshStandardMaterial({
    color: baseColors[variant % baseColors.length],
    roughness: 0.82,
    metalness: 0.08
  });

  const uniforms = {
    uDamage: { value: damageLevel },
    uSeed: { value: Math.random() * 100.0 }
  };
  material.userData.shaderUniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDamage = uniforms.uDamage;
    shader.uniforms.uSeed = uniforms.uSeed;

    shader.vertexShader =
      /* glsl */ `
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      ` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vLocalPos = position;
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
      );

    shader.fragmentShader =
      /* glsl */ `
      uniform float uDamage;
      uniform float uSeed;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      ${GLSL_NOISE}
      ` +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        vec3 p = vLocalPos * 2.4 + vec3(uSeed);
        float grain = fbm2D(p.xy * 1.8 + p.z * 0.9);
        float mortarY = smoothstep(0.92, 0.98, abs(sin(vWorldPos.y * 3.14159)));
        float mortarX = smoothstep(0.94, 0.99, abs(sin((vWorldPos.x + floor(vWorldPos.y) * 0.7) * 2.2)));
        float mortar = max(mortarY, mortarX);

        vec3 col = diffuseColor.rgb * (0.84 + 0.32 * grain);
        col = mix(col, col * 0.58, mortar * 0.65);

        float dust = 1.0 - smoothstep(0.0, 3.2, vWorldPos.y);
        col = mix(col, vec3(0.85, 0.67, 0.43), dust * 0.35);

        if (uDamage > 0.01) {
          float crackNoise = abs(noise3D(p * 3.2) - 0.5) * 2.0;
          float crackMask = 1.0 - smoothstep(0.0, 0.14 * uDamage, crackNoise);
          col = mix(col, vec3(0.08, 0.07, 0.06), uDamage * 0.45 + crackMask * 0.75);
          col += vec3(1.0, 0.42, 0.08) * crackMask * uDamage * 1.8;
        }

        diffuseColor.rgb = col;
        `
      );
  };

  return material;
}

/**
 * Volumetric GLSL Fireball Shader for explosions
 */
export function createFireballMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uSeed: { value: Math.random() * 50 }
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uProgress;
      uniform float uSeed;
      varying float vNoise;
      varying vec3 vNormalDir;
      varying vec3 vViewDir;
      ${GLSL_NOISE}

      void main() {
        vec3 n = normalize(normal);
        float turb = noise3D(position * 2.2 + vec3(0.0, -uTime * 4.5, uSeed)) * 0.65
                   + noise3D(position * 5.0 - vec3(uTime * 3.0)) * 0.35;
        vNoise = turb;
        vec3 displaced = position + n * (turb * (0.45 + uProgress * 0.65));
        vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);
        vNormalDir = normalize(normalMatrix * n);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress;
      varying float vNoise;
      varying vec3 vNormalDir;
      varying vec3 vViewDir;

      void main() {
        float fresnel = dot(vNormalDir, vViewDir);
        float heat = clamp((vNoise * 0.75 + fresnel * 0.45) * (1.15 - uProgress * 0.85), 0.0, 1.0);

        vec3 soot = vec3(0.10, 0.09, 0.08);
        vec3 crimson = vec3(0.85, 0.14, 0.03);
        vec3 orange = vec3(1.0, 0.48, 0.06);
        vec3 yellow = vec3(1.0, 0.92, 0.45);
        vec3 whiteCore = vec3(1.0, 0.99, 0.92);

        vec3 col = mix(soot, crimson, smoothstep(0.08, 0.32, heat));
        col = mix(col, orange, smoothstep(0.32, 0.58, heat));
        col = mix(col, yellow, smoothstep(0.58, 0.82, heat));
        col = mix(col, whiteCore, smoothstep(0.82, 0.98, heat));

        col *= (1.4 + (1.0 - uProgress) * 2.2);

        float alpha = smoothstep(0.0, 0.25, 1.0 - uProgress) * smoothstep(0.02, 0.22, vNoise + 0.15);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
  });
}

/**
 * Expanding Shockwave Ring Shader
 */
export function createShockwaveMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uProgress: { value: 0 },
      uColor: { value: new THREE.Color(0xff9d3b) }
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress;
      uniform vec3 uColor;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        float ring = smoothstep(0.68, 0.88, r) * (1.0 - smoothstep(0.88, 1.0, r));
        float alpha = ring * (1.0 - uProgress) * 0.85;
        gl_FragColor = vec4(uColor * 2.4, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  });
}

/**
 * Classic Zaxxon Forcefield / Laser Barrier Shader
 */
export function createBarrierMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      ${GLSL_NOISE}

      void main() {
        float beam = abs(sin(vUv.y * 18.0 - uTime * 16.0));
        float arc = noise2D(vec2(vUv.x * 10.0 - uTime * 8.0, vUv.y * 6.0));
        float edge = 1.0 - smoothstep(0.0, 0.15, abs(vUv.y - 0.5) * 2.0 - 0.7);
        vec3 col = mix(vec3(1.0, 0.12, 0.08), vec3(0.35, 0.92, 1.0), pow(arc, 2.2));
        float alpha = (0.35 + 0.55 * beam) * edge;
        gl_FragColor = vec4(col * 2.2, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  });
}

/**
 * Full-screen Post-Processing Shader for Desert Heat Shimmer, Explosion Shockwave & Chromatic Aberration
 */
export const HeatDistortionShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uShockStrength: { value: 0 },
    uShockCenter: { value: new THREE.Vector2(0.5, 0.5) }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uShockStrength;
    uniform vec2 uShockCenter;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;

      float heatWave = sin(uv.y * 55.0 + uTime * 6.5) * cos(uv.x * 35.0 + uTime * 4.2) * 0.00055;
      uv.x += heatWave;

      vec2 toCenter = uv - uShockCenter;
      float dist = length(toCenter);
      vec2 dir = dist > 0.0001 ? toCenter / dist : vec2(0.0);
      float wave = sin(dist * 28.0 - uTime * 18.0) * exp(-dist * 4.5) * uShockStrength * 0.012;
      uv += dir * wave;

      float ca = uShockStrength * 0.0038 + 0.00045 * dist;
      float r = texture2D(tDiffuse, uv + dir * ca).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - dir * ca).b;
      vec3 col = vec3(r, g, b);

      float vig = smoothstep(0.95, 0.32, length((vUv - 0.5) * vec2(1.15, 1.0)));
      col *= mix(0.76, 1.04, vig);

      gl_FragColor = vec4(col, 1.0);
    }
  `
};
