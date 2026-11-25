export const BASE_GLOBE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const BASE_GLOBE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uTexA;
  uniform sampler2D uTexB;
  uniform sampler2D uLandMask;
  uniform float uAlpha;
  uniform float uRelativeMode;
  uniform float uRelativeNormRef;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    float land = smoothstep(0.22, 0.78, texture2D(uLandMask, vUv).r);
    float a = texture2D(uTexA, vUv).r;
    float b = texture2D(uTexB, vUv).r;
    float d = mix(a, b, uAlpha);
    if (uRelativeMode > 0.5) {
      d = clamp(d / max(uRelativeNormRef, 0.15), 0.0, 1.0);
    }
    d *= land;

    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 keyLight = normalize(vec3(1.6, 1.1, 1.4));
    float diff = max(dot(N, keyLight), 0.0);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.1);

    // Smooth midnight indigo ocean with subtle orbital sheen
    vec3 oceanBase = vec3(0.013, 0.028, 0.082);
    vec3 ocean = oceanBase * (0.68 + 0.52 * diff) + vec3(0.02, 0.085, 0.19) * fresnel;
    vec3 H = normalize(keyLight + V);
    ocean += vec3(0.14, 0.38, 0.66) * pow(max(dot(N, H), 0.0), 42.0) * 0.055;

    // Matte dark indigo landmass with a subtle ambient density underglow beneath the blocks
    vec3 landBase = vec3(0.044, 0.082, 0.185) * (0.62 + 0.52 * diff);
    vec3 underglow = mix(vec3(0.02, 0.24, 0.38), vec3(0.45, 0.30, 0.06), smoothstep(0.45, 0.82, d));
    vec3 landCol = landBase + underglow * smoothstep(0.06, 0.75, d) * 0.42;

    vec3 col = mix(ocean, landCol, land);
    col += vec3(0.045, 0.24, 0.50) * fresnel * 0.52;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const BLOCK_VERTEX_SHADER = /* glsl */ `
  attribute vec2 aCellUv;

  uniform sampler2D uTexA;
  uniform sampler2D uTexB;
  uniform float uAlpha;
  uniform float uElevation;
  uniform float uRelativeMode;
  uniform float uRelativeNormRef;
  uniform vec2 uTexelSize;
  uniform float uSampleRadius;
  uniform float uLodHeightScale;
  uniform float uLodTransition;

  varying float vDensity;
  varying float vHeightFrac;
  varying vec3 vLocalNormal;
  varying vec2 vFaceUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  float sampleTap(vec2 uv) {
    float a = texture2D(uTexA, uv).r;
    float b = texture2D(uTexB, uv).r;
    return mix(a, b, uAlpha);
  }

  void main() {
    float d;
    if (uSampleRadius > 0.05) {
      // Macro/Regional LOD: 5-tap footprint filter matches the wider block area accurately
      vec2 ox = vec2(uTexelSize.x * uSampleRadius, 0.0);
      vec2 oy = vec2(0.0, uTexelSize.y * uSampleRadius);
      d = (
        sampleTap(aCellUv) * 2.0 +
        sampleTap(aCellUv + ox) +
        sampleTap(aCellUv - ox) +
        sampleTap(aCellUv + oy) +
        sampleTap(aCellUv - oy)
      ) / 6.0;
    } else {
      // Metro LOD (0.26 deg): exact native 0.25-deg HYDE pixel fidelity
      d = sampleTap(aCellUv);
    }

    if (uRelativeMode > 0.5) {
      d = clamp(d / max(uRelativeNormRef, 0.15), 0.0, 1.0);
    }

    vDensity = d;
    vLocalNormal = normal;
    vFaceUv = uv;

    // Unit box geometry spans z in [0, 1] along outward radial axis
    vHeightFrac = clamp(position.z, 0.0, 1.0);

    // Hide near-zero uninhabited cells cleanly so deserts & tundra stay smooth dark land
    float activeMask = smoothstep(0.05, 0.12, d);
    float blockHeight =
      (0.0035 + pow(d, 1.75) * 0.22 * uElevation * uLodHeightScale) *
      activeMask *
      uLodTransition;

    // Slightly taper xy footprint to 0 when inactive so zero-density cells never z-fight
    vec3 scaledPos = vec3(
      position.x * activeMask,
      position.y * activeMask,
      position.z * blockHeight
    );

    vec4 worldPos = modelMatrix * instanceMatrix * vec4(scaledPos, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const BLOCK_FRAGMENT_SHADER = /* glsl */ `
  varying float vDensity;
  varying float vHeightFrac;
  varying vec3 vLocalNormal;
  varying vec2 vFaceUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  // Sci-Fi Orbital Telemetry Block Palette:
  // Deep orbital teal -> luminous cyan -> electric aqua -> radiant amber-gold -> HDR incandescent cap
  vec3 densityPalette(float d) {
    vec3 c0 = vec3(0.032, 0.220, 0.390); // Low-density settlement deep teal
    vec3 c1 = vec3(0.045, 0.560, 0.740); // Moderate rural orbital cyan
    vec3 c2 = vec3(0.150, 0.840, 0.930); // Populated corridor electric cyan
    vec3 c3 = vec3(0.980, 0.650, 0.120); // Dense urban basin radiant amber-gold
    vec3 c4 = vec3(1.520, 1.320, 0.780); // Incandescent HDR megacity core (selective bloom)

    if (d < 0.28) return mix(c0, c1, smoothstep(0.05, 0.28, d));
    if (d < 0.52) return mix(c1, c2, smoothstep(0.28, 0.52, d));
    if (d < 0.72) return mix(c2, c3, smoothstep(0.52, 0.72, d));
    return mix(c3, c4, smoothstep(0.72, 1.00, d));
  }

  void main() {
    if (vDensity < 0.055) discard;

    vec3 N = normalize(vWorldNormal);
    vec3 keyLight = normalize(vec3(1.6, 1.1, 1.4));
    vec3 rimLight = normalize(vec3(-1.3, -0.4, -1.1));
    float diff = max(dot(N, keyLight), 0.0);
    float rim = max(dot(N, rimLight), 0.0);

    bool isTopFace = vLocalNormal.z > 0.7;

    vec3 peakCol = densityPalette(vDensity);
    // Darker rooted base rising smoothly to glowing top cap gives crisp architectural depth
    vec3 baseCol = mix(vec3(0.020, 0.090, 0.210), peakCol * 0.42, smoothstep(0.15, 0.85, vDensity));
    vec3 bodyCol = mix(baseCol, peakCol, smoothstep(0.0, 0.92, vHeightFrac));

    // Crisp flat-face directional lighting on sides; bright emissive cap on top
    float sideLighting = 0.48 + 0.58 * diff + 0.18 * rim;
    float topLighting = 0.92 + 0.24 * diff;
    vec3 col = bodyCol * (isTopFace ? topLighting : sideLighting);

    // Subtle crisp bevel highlight around the edges of the top cap
    if (isTopFace) {
      vec2 edgeDist = min(vFaceUv, 1.0 - vFaceUv);
      float edge = 1.0 - smoothstep(0.0, 0.11, min(edgeDist.x, edgeDist.y));
      col += peakCol * edge * 0.22;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const ATMOSPHERE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const ATMOSPHERE_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndv = clamp(dot(vNormal, -V), 0.0, 1.0);
    float outerFade = smoothstep(0.0, 0.52, ndv);
    float innerRim = pow(clamp(1.0 - ndv, 0.0, 1.0), 2.4);
    float glow = outerFade * innerRim * 1.45;
    vec3 col = mix(vec3(0.04, 0.28, 0.70), vec3(0.18, 0.78, 0.96), innerRim);
    gl_FragColor = vec4(col * glow, glow * 0.55);
  }
`;
