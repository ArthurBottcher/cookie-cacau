import * as THREE from 'three';
import { smin, smoothstep, sdEll, sdSphere, sdRoundCone, surfaceNets, marchToSurface } from './sdf.js';

// Dog frame: ground at y=0, nose toward +Z, +X is the dog's LEFT side. Units ≈ metres for a
// standard dachshund (~1 m nose-to-tail-tip, ~0.42 m at the withers).
//
// The torso is modelled once, standing ("rest" frame). A pose places that torso in the dog frame
// (pitched up for sitting) and supplies the legs, neck and tail that connect it to the ground.

const TOE_ANGLES = [-0.78, -0.26, 0.26, 0.78];

// ------------------------------------------------------------------ poses
//
// Front legs are split at the elbow: the upper arm belongs to the body mesh, the forearm + paw is
// its own finely meshed piece hung from an elbow pivot, so she can lift it to give her paw.
// Hind paws are separate fine meshes too (static), so all four paws get real toes, pads and claws.

function standPose() {
  const legs = [];
  const fronts = [];
  const hindPaws = [];
  for (const s of [1, -1]) {
    // front: short, wrists turned in, big paws turned out
    const elbow = [s * 0.09, 0.165, 0.29, 0.05];
    legs.push({ chain: [[s * 0.095, 0.28, 0.26, 0.062], elbow] });
    fronts.push({ side: s, elbow, wrist: [s * 0.096, 0.062, 0.318, 0.04], paw: { c: [s * 0.12, 0, 0.35], yaw: s * 0.5, k: 1.12 } });
    // hind
    const ankle = [s * 0.08, 0.045, -0.41, 0.028];
    legs.push({
      thigh: [s * 0.075, 0.27, -0.34, 0.052, 0.1, 0.095],
      chain: [[s * 0.079, 0.21, -0.39, 0.043], [s * 0.08, 0.115, -0.435, 0.032], ankle],
    });
    hindPaws.push({ side: s, ankle, paw: { c: [s * 0.082, 0, -0.388], yaw: s * 0.15, k: 0.95 } });
  }
  return {
    toRest: (x, y, z, o) => { o[0] = x; o[1] = y; o[2] = z; },
    neck: [[0, 0.35, 0.3, 0.09], [0, 0.5, 0.42, 0.077]],
    legs, fronts, hindPaws,
    tailRoot: [0, 0.355, -0.47], tailRot: [-0.12, 0],
    bounds: [[-0.22, -0.01, -0.58], [0.22, 0.6, 0.53]],
  };
}

// Sitting: rump on the floor, torso pitched up about the hip, front legs straight, hind legs folded.
function sitPose(opts = {}) {
  const th = opts.angle ?? 0.42;
  const P = [0.32, -0.36]; // hip (y, z) in the rest frame
  const H = [0.1, -0.2];   // where the hip sits in the dog frame
  const c = Math.cos(th), sn = Math.sin(th);
  const fromRest = (x, y, z) => {
    const dy = y - P[0], dz = z - P[1];
    return [x, dy * c + dz * sn + H[0], -dy * sn + dz * c + H[1]];
  };
  const legs = [];
  const fronts = [];
  const hindPaws = [];
  for (const s of [1, -1]) {
    const top = fromRest(s * 0.095, 0.28, 0.26);
    const f = (s > 0 ? opts.frontL : opts.frontR) ?? {};
    const px = f.x ?? s * 0.118, pz = f.z ?? top[2] + 0.07;
    const elbow = [(top[0] + px) / 2 - s * 0.012, 0.17, (top[2] + pz) / 2 - 0.025, 0.05];
    legs.push({ chain: [[top[0], top[1], top[2], 0.06], elbow] });
    fronts.push({ side: s, elbow, wrist: [px - s * 0.012, 0.062, pz - 0.032, 0.04], paw: { c: [px, 0, pz], yaw: f.yaw ?? s * 0.5, k: 1.12 } });

    const ankle = [s * 0.142, 0.034, -0.15, 0.03];
    legs.push({
      thigh: [s * 0.12, 0.1, -0.16, 0.08, 0.1, 0.14],
      chain: [[s * 0.13, 0.1, -0.06, 0.044], [s * 0.135, 0.036, -0.24, 0.032], ankle],
    });
    hindPaws.push({ side: s, ankle, paw: { c: [s * 0.15, 0, -0.112], yaw: s * 0.4, k: 1.0 } });
  }
  const base = fromRest(0, 0.35, 0.3);
  return {
    toRest: (x, y, z, o) => {
      const dy = y - H[0], dz = z - H[1];
      o[0] = x; o[1] = dy * c - dz * sn + P[0]; o[2] = dy * sn + dz * c + P[1];
    },
    neck: [[base[0], base[1], base[2], 0.095], [0, opts.neckY ?? 0.535, opts.neckZ ?? 0.48, 0.08]],
    legs, fronts, hindPaws,
    tailRoot: fromRest(0, 0.355, -0.47), tailRot: [-0.42, 0.9],
    bounds: [[-0.27, -0.01, -0.42], [0.27, 0.68, 0.62]],
  };
}

// ------------------------------------------------------------------ paws
//
// Paw frame: origin on the floor under the paw, toes toward +Z (the dog frame turned by p.yaw).
// Four arched toes (knuckle + tip) that only touch along creases, so the grooves between them stay;
// a pad under each toe plus the big heart-shaped metacarpal pad; a pastern rising to `ankle`;
// on front paws, a dewclaw on the inner side. k scales the whole paw.
function makePaw(p, ankle, side, dewclaw) {
  const k = p.k, c = p.c, cs = Math.cos(p.yaw), sn = Math.sin(p.yaw);
  const L = [0, 0, 0];
  const toLocal = (x, y, z, o) => {
    const dx = x - c[0], dz = z - c[2];
    o[0] = dx * cs - dz * sn; o[1] = y; o[2] = dx * sn + dz * cs;
  };
  const toDog = (l) => [c[0] + l[0] * cs + l[2] * sn, l[1], c[2] - l[0] * sn + l[2] * cs];

  const toes = TOE_ANGLES.map((a) => {
    const reach = 1 - Math.abs(a) * 0.14; // the middle two toes reach further
    return {
      a,
      kn: [0.04 * Math.sin(a) * k, 0.025 * k, (0.004 + 0.02 * Math.cos(a)) * k],
      tip: [0.05 * Math.sin(a) * k, 0.0125 * k, (0.018 + 0.03 * Math.cos(a) * reach) * k],
    };
  });
  const pads = toes.map((t) => [t.tip[0], 0.0058 * k, t.tip[2] - 0.003 * k, 0.0105 * k, 0.0062 * k, 0.0108 * k]);
  pads.push([0, 0.0078 * k, -0.011 * k, 0.026 * k, 0.0088 * k, 0.019 * k]); // metacarpal pad
  const la = [0, 0, 0];
  toLocal(ankle[0], ankle[1], ankle[2], la);
  const pb = [0, 0.034 * k, -0.026 * k];

  let dew = null;
  const nails = toes.map((t) => ({
    pos: toDog([t.tip[0] * 1.03, t.tip[1] + 0.0042 * k, t.tip[2] + 0.0125 * k]),
    yaw: p.yaw + t.a * 0.38, pitch: Math.PI / 2 + 0.22, len: 0.021 * k, rad: 0.0062 * k,
  }));
  if (dewclaw) {
    const ix = -side * cs * 0.026 * k, iz = -side * sn * 0.026 * k; // toward the body's midline
    const q = [pb[0] + (la[0] - pb[0]) * 0.32 + ix, pb[1] + (la[1] - pb[1]) * 0.32, pb[2] + (la[2] - pb[2]) * 0.32 + iz];
    dew = [q[0], q[1], q[2], 0.0085 * k, 0.013 * k, 0.0085 * k];
    nails.push({ pos: toDog([q[0] + ix * 0.25, q[1] - 0.009 * k, q[2] + 0.004 * k]), yaw: p.yaw, pitch: Math.PI - 0.35, len: 0.012 * k, rad: 0.0032 * k });
  }

  const toe = (t, x, y, z) =>
    smin(sdSphere(x, y, z, t.kn[0], t.kn[1], t.kn[2], 0.0158 * k), sdEll(x, y, z, t.tip[0], t.tip[1], t.tip[2], 0.0138 * k, 0.0125 * k, 0.0168 * k), 0.012 * k);
  const padDist = (x, y, z) => {
    let d = 1e9;
    for (const q of pads) d = Math.min(d, sdEll(x, y, z, q[0], q[1], q[2], q[3], q[4], q[5]));
    return d;
  };

  const f = (x, y, z) => {
    toLocal(x, y, z, L);
    const lx = L[0], ly = L[1], lz = L[2];
    let d = sdEll(lx, ly, lz, 0, 0.026 * k, -0.022 * k, 0.036 * k, 0.026 * k, 0.034 * k); // palm
    d = smin(d, sdRoundCone(lx, ly, lz, la[0], la[1], la[2], pb[0], pb[1], pb[2], ankle[3], 0.031 * k), 0.015 * k);
    let dt = 1e9;
    for (const t of toes) dt = Math.min(dt, toe(t, lx, ly, lz)); // hard min keeps the grooves
    d = smin(d, dt, 0.007 * k);
    d = smin(d, padDist(lx, ly, lz), 0.003 * k);
    if (dew) d = smin(d, sdEll(lx, ly, lz, dew[0], dew[1], dew[2], dew[3], dew[4], dew[5]), 0.006 * k);
    return d;
  };

  // Per-vertex facts for painting: how "toe" it is, how deep in a groove, how close to a pad.
  const td = [0, 0, 0, 0];
  const info = { lx: 0, ly: 0, lz: 0, toe: 0, cleft: 0, pad: 0 };
  const describe = (x, y, z) => {
    toLocal(x, y, z, L);
    for (let i = 0; i < 4; i++) td[i] = Math.abs(toe(toes[i], L[0], L[1], L[2]));
    const sorted = [...td].sort((a, b) => a - b);
    info.lx = L[0]; info.ly = L[1]; info.lz = L[2];
    info.toe = 1 - smoothstep(0.002 * k, 0.01 * k, sorted[0]);
    info.cleft = (1 - smoothstep(0.0008 * k, 0.005 * k, sorted[1])) * smoothstep(0.006 * k, 0.013 * k, L[1]);
    info.pad = 1 - smoothstep(0.0006 * k, 0.0028 * k, padDist(L[0], L[1], L[2]));
    return info;
  };

  // Dog-frame bounding box of the paw and its pastern.
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  const grow = (pt, r = 0) => { for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], pt[i] - r); hi[i] = Math.max(hi[i], pt[i] + r); } };
  for (const bx of [-0.07, 0.07]) for (const bz of [-0.065, 0.08]) grow(toDog([bx * k, 0, bz * k]));
  grow(toDog([0, 0.06 * k, 0]));
  grow(ankle, ankle[3] + 0.01);
  lo[1] = -0.004;

  return { f, describe, nails, bounds: [lo, hi] };
}

// Curved, tapering claw: a cone bent along an arc. Base at the origin, grows along +Y and curls
// toward +Z; slightly flattened sideways like a real nail.
function clawGeometry(len, rad, bend = 1.0) {
  const g = new THREE.CylinderGeometry(rad * 0.22, rad, len, 12, 10);
  g.translate(0, len / 2, 0);
  g.scale(0.78, 1, 1);
  const pos = g.attributes.position, R = len / bend;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const phi = bend * (y / len);
    pos.setXYZ(i, x, R * Math.sin(phi) - z * Math.sin(phi), R * (1 - Math.cos(phi)) + z * Math.cos(phi));
  }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ signed distance fields

// Torso in the rest frame: deep keel-shaped chest, long narrow barrel, slight tuck to the loin.
function torsoSDF(x, y, z) {
  const w = x * 1.12; // a little narrower than it is deep
  let d = sdEll(x, y, z, 0, 0.27, 0.2, 0.162, 0.15, 0.21); // broad chest
  d = smin(d, sdEll(x, y, z, 0, 0.235, 0.35, 0.1, 0.095, 0.07), 0.06);
  d = smin(d, sdRoundCone(w, y, z, 0, 0.29, 0.12, 0, 0.312, -0.3, 0.142, 0.118), 0.08);
  d = smin(d, sdEll(w, y, z, 0, 0.322, -0.36, 0.125, 0.122, 0.15), 0.06);
  d = smin(d, sdEll(x, y, z, 0.08, 0.33, 0.25, 0.06, 0.09, 0.09), 0.05);
  d = smin(d, sdEll(x, y, z, -0.08, 0.33, 0.25, 0.06, 0.09, 0.09), 0.05);
  return d;
}

function makeBodySDF(pose) {
  const r = [0, 0, 0];
  const [n0, n1] = pose.neck;
  const torso = (x, y, z) => {
    pose.toRest(x, y, z, r);
    let d = torsoSDF(r[0], r[1], r[2]);
    return smin(d, sdRoundCone(x, y, z, n0[0], n0[1], n0[2], n1[0], n1[1], n1[2], n0[3], n1[3]), 0.06);
  };
  const limbs = (x, y, z) => {
    let d = 1e9;
    for (const leg of pose.legs) {
      let l = leg.thigh ? sdEll(x, y, z, ...leg.thigh) : 1e9;
      const ch = leg.chain;
      for (let i = 0; i < ch.length - 1; i++) {
        const a = ch[i], b = ch[i + 1];
        l = smin(l, sdRoundCone(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], a[3], b[3]), 0.025);
      }
      d = Math.min(d, l);
    }
    return d;
  };
  const full = (x, y, z) => smin(torso(x, y, z), limbs(x, y, z), 0.04);
  return { full, torso, limbs };
}

// Head frame: origin at the neck joint, same axes as the dog frame at rest.
function makeHeadSDF(cfg) {
  const sn = cfg.snoutLength ?? 1;
  return (x, y, z) => {
    let d = sdEll(x, y, z, 0, 0.094, 0.04, 0.094, 0.09, 0.1); // domed skull
    d = smin(d, sdRoundCone(x, y, z, 0, -0.025, -0.03, 0, 0.04, 0.02, 0.05, 0.058), 0.045);
    d = smin(d, sdEll(x, y, z, 0, 0.012, 0.045, 0.05, 0.05, 0.075), 0.05); // throat
    d = smin(d, sdEll(x, y, z, 0.046, 0.05, 0.09, 0.048, 0.046, 0.055), 0.03);
    d = smin(d, sdEll(x, y, z, -0.046, 0.05, 0.09, 0.048, 0.046, 0.055), 0.03);
    d = smin(d, sdRoundCone(x, y, z, 0, 0.068, 0.12, 0, 0.058, 0.12 + 0.158 * sn, 0.05, 0.033), 0.035);
    d = smin(d, sdRoundCone(x, y, z, 0, 0.026, 0.1, 0, 0.03, 0.1 + 0.148 * sn, 0.04, 0.024), 0.03);
    // upper lips (flews) hang a touch below the jaw line
    d = smin(d, sdEll(x, y, z, 0.022, 0.034, 0.1 + 0.1 * sn, 0.02, 0.025, 0.07 * sn), 0.02);
    d = smin(d, sdEll(x, y, z, -0.022, 0.034, 0.1 + 0.1 * sn, 0.02, 0.025, 0.07 * sn), 0.02);
    d = smin(d, sdEll(x, y, z, 0.038, 0.126, 0.12, 0.031, 0.021, 0.03), 0.02);
    d = smin(d, sdEll(x, y, z, -0.038, 0.126, 0.12, 0.031, 0.021, 0.03), 0.02);
    return d;
  };
}

function sdEll2(py, pz, ry, rz) {
  const k0 = Math.hypot(py / ry, pz / rz);
  const k1 = Math.hypot(py / (ry * ry), pz / (rz * rz));
  return (k0 * (k0 - 1)) / k1;
}

// Ear frame: origin at the attachment, ear hangs along -Y, flat faces point ±X. A leaf outline
// (2D, in the y/z plane) extruded to a thin rounded slab, cupped toward the cheek.
function makeEarSDF(side, L, W) {
  return (x, y, z) => {
    const lx = x * side;
    const xw = lx + 0.9 * z * z + 0.3 * y * y + 0.004 * Math.sin(z * 55 + 1) * smoothstep(0.08, 0.2, -y);
    let d2 = sdEll2(y + 0.07 * L, z, 0.075 * L, 0.042 * W);
    d2 = smin(d2, sdEll2(y + 0.155 * L, z + 0.004, 0.085 * L, 0.067 * W), 0.04);
    const wx = Math.abs(xw) - 0.0032 * (1 - 0.65 * smoothstep(-0.018, 0, d2)); // thin at the edges
    let d = Math.hypot(Math.max(d2, 0), Math.max(wx, 0)) + Math.min(Math.max(d2, wx), 0) - 0.0022;
    // rolled fold where the ear leaves the skull
    d = smin(d, sdRoundCone(xw, y, z, -0.004, -0.004, -0.032, -0.004, -0.012, 0.03, 0.01, 0.008), 0.015);
    return d;
  };
}

const TAIL_PTS = [[0, 0, 0.03], [0, 0.035, -0.1], [0, 0.07, -0.2], [0, 0.09, -0.29], [0, 0.095, -0.36]];
const TAIL_R = [0.034, 0.026, 0.018, 0.011, 0.006];
function tailSDF(x, y, z) {
  let d = 1e9;
  for (let i = 0; i < TAIL_PTS.length - 1; i++) {
    const a = TAIL_PTS[i], b = TAIL_PTS[i + 1];
    d = smin(d, sdRoundCone(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], TAIL_R[i], TAIL_R[i + 1]), 0.012);
  }
  return d;
}

// ------------------------------------------------------------------ meshing + fur shader

// aoStep > 0 adds ambient occlusion read straight from the distance field: step out along the
// normal and see how much nearer the surface is than it should be. Darkens armpits, the groove
// under the neck, the gaps between toes — the creases that make a shape stop looking plastic.
function buildGeometry(f, min, max, h, colorFn, aoStep = 0) {
  const { positions, normals, indices } = surfaceNets(f, min, max, h);
  const n = positions.length / 3;
  const colors = new Float32Array(n * 3);
  const ticks = new Float32Array(n * 3);
  // out = [r, g, b, tickDensity, roan]
  const out = [1, 1, 1, 0, 0];
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const px = positions[j], py = positions[j + 1], pz = positions[j + 2];
    const nx = normals[j], ny = normals[j + 1], nz = normals[j + 2];
    out[3] = 0; out[4] = 0;
    colorFn(px, py, pz, nx, ny, nz, out);
    let ao = 1;
    if (aoStep > 0) {
      let occ = 0, w = 1;
      for (let s = 1; s <= 5; s++) {
        const dist = s * aoStep;
        occ += w * Math.max(0, dist - f(px + nx * dist, py + ny * dist, pz + nz * dist));
        w *= 0.6;
      }
      ao = Math.max(0.42, 1 - (0.32 * occ) / aoStep);
    }
    colors[j] = out[0]; colors[j + 1] = out[1]; colors[j + 2] = out[2];
    ticks[j] = out[3]; ticks[j + 1] = out[4]; ticks[j + 2] = ao;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aTick', new THREE.BufferAttribute(ticks, 3));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

// Ticking is too fine for vertex colours, so it is drawn per pixel in each part's local space:
// irregular (domain-warped) spots on a jittered 3D grid, plus a cloudy "roan" layer where the
// spots merge into grey/tan. aTick = (spot density, roan amount, ambient occlusion) per vertex.
// On top, a fine stretched noise reads as hair: it shades each strand a little lighter or darker
// and tilts the normal (bump) — faded out with distance so it never turns into shimmer.
const TICK_GLSL = /* glsl */ `
  varying vec3 vTick;
  uniform vec3 uFurFreq;
  uniform float uFurBump;
  uniform vec3 uSpotStretch;
  varying vec3 vPos;
  uniform vec3 uTickColor;
  uniform vec3 uRoanColor;
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float spots(vec3 p, float density, float rMin, float rMax) {
    vec3 i = floor(p), f = fract(p);
    float aa = length(fwidth(p)) * 0.6 + 0.02; // from p, not d: d jumps at cell borders
    float m = 0.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 h = hash33(i + g);
      if (h.x > density) continue;
      vec3 o = hash33(i + g + 17.17) * 0.6 + 0.2;
      float r = mix(rMin, rMax, h.y);
      float d = length(g + o - f);
      m = max(m, 1.0 - smoothstep(r - aa, r + aa, d));
    }
    return m;
  }
  vec3 furPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
    vec3 vSigmaX = normalize(dFdx(surf_pos));
    vec3 vSigmaY = normalize(dFdy(surf_pos));
    vec3 R1 = cross(vSigmaY, surf_norm);
    vec3 R2 = cross(surf_norm, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDirection;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
  }
  float furHeight(vec3 p) {
    vec3 q = p * uFurFreq;
    return vnoise(q) * 0.65 + vnoise(q * 2.3 + 5.1) * 0.35;
  }
`;

// hairAlong: the axis hair runs along in the part's local space ('z' body/head, 'y' legs)
function furMaterial(cfg, tickScale = cfg.tickScale ?? 140, tickColor = cfg.tickColor, roanColor = cfg.roanColor, hairAlong = 'z') {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.82,
    sheen: 0.3,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0x9a9590),
  });
  const scale = tickScale.toFixed(1);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTickColor = { value: new THREE.Color(tickColor) };
    sh.uniforms.uRoanColor = { value: new THREE.Color(roanColor) };
    sh.uniforms.uFurFreq = { value: hairAlong === 'y' ? new THREE.Vector3(950, 260, 950) : new THREE.Vector3(950, 950, 260) };
    sh.uniforms.uFurBump = { value: 0.00035 };
    // ticks are flecks of hair, so they run along the coat
    sh.uniforms.uSpotStretch = { value: hairAlong === 'y' ? new THREE.Vector3(1, 0.42, 1) : new THREE.Vector3(1, 1, 0.42) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aTick;\nvarying vec3 vTick;\nvarying vec3 vPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTick = aTick;\nvPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TICK_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vTick.x + vTick.y > 0.001) {
          vec3 p = vPos * ${scale} * uSpotStretch;
          vec3 q = p + (vec3(vnoise(p * 0.35), vnoise(p * 0.35 + 11.0), vnoise(p * 0.35 + 23.0)) - 0.5) * 1.3;
          float roan = vTick.y * smoothstep(0.32, 0.62, vnoise(p * 0.16) * 0.55 + vnoise(p * 0.45) * 0.45);
          diffuseColor.rgb = mix(diffuseColor.rgb, uRoanColor, roan * 0.85);
          float s = spots(q, vTick.x, 0.11, 0.3);
          s = max(s, spots(q * 0.5 + 7.3, vTick.x * 0.5, 0.16, 0.38) * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, uTickColor, s);
        }
        diffuseColor.rgb *= (0.92 + 0.16 * furHeight(vPos)) * vTick.z;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float amt = uFurBump * (1.0 - smoothstep(0.0004, 0.0016, length(fwidth(vPos))));
          if (amt > 0.0) {
            float hh = furHeight(vPos);
            normal = furPerturb(-vViewPosition, normal, vec2(dFdx(hh), dFdy(hh)) * amt, faceDirection);
          }
        }`);
  };
  return m;
}

// Iris texture for a sphere whose +Y pole is the centre of the eye: the top rows of the canvas
// wrap around that pole, so horizontal bands become pupil, iris and the dark rim.
function irisTexture(irisHex) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  const iris = new THREE.Color(irisHex);
  const css = (col, k = 1) => `rgb(${Math.round(col.r * 255 * k)},${Math.round(col.g * 255 * k)},${Math.round(col.b * 255 * k)})`;
  const sRGB = iris.clone(); // hex is already sRGB
  g.fillStyle = '#120c0a'; g.fillRect(0, 0, 64, 256);            // dark sclera / rim
  const grad = g.createLinearGradient(0, 22, 0, 74);              // iris: lighter toward the pupil
  grad.addColorStop(0, css(sRGB, 1.5)); grad.addColorStop(0.7, css(sRGB, 1.0)); grad.addColorStop(1, css(sRGB, 0.45));
  g.fillStyle = grad; g.fillRect(0, 22, 64, 52);
  g.fillStyle = '#050404'; g.fillRect(0, 0, 64, 24);               // pupil
  for (let i = 0; i < 90; i++) {                                   // fibres in the iris
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,220,170' : '0,0,0'},0.08)`;
    g.fillRect(Math.random() * 64, 24 + Math.random() * 48, 1, 6 + Math.random() * 10);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Nose leather: fine cobbled bumps.
function leatherMaterial(hex) {
  const m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLPos;
        float lh(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        float lcell(vec3 p) {
          vec3 i = floor(p), f = fract(p); float d = 1.0;
          for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec3 g = vec3(float(x), float(y), float(z));
            vec3 o = vec3(lh(i + g), lh(i + g + 7.0), lh(i + g + 13.0));
            d = min(d, length(g + o - f));
          }
          return d;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float hh = lcell(vLPos * 14.0);
          vec3 sx = normalize(dFdx(-vViewPosition)), sy = normalize(dFdy(-vViewPosition));
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1) * faceDirection;
          vec3 grad = sign(det) * (dFdx(hh) * r1 + dFdy(hh) * r2) * 0.0012;
          normal = normalize(abs(det) * normal - grad);
          diffuseColor.rgb *= 0.75 + 0.35 * hh;
        }`);
  };
  return m;
}

// Whiskers: fine pale hairs on the sides of the muzzle and above the eyes, in the head frame.
function addWhiskers(parent, headSDF, eyes) {
  const mat = new THREE.LineBasicMaterial({ color: 0xf2eee6, transparent: true, opacity: 0.7 });
  const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const add = (base, dir, len) => {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push(new THREE.Vector3(
        base[0] + dir[0] * len * t,
        base[1] + dir[1] * len * t - 0.012 * len * t * t / 0.06, // droops toward the tip
        base[2] + dir[2] * len * t,
      ));
    }
    parent.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  };
  for (const s of [1, -1]) {
    for (const z of [0.2, 0.218, 0.236, 0.254]) {
      for (const y of [0.04, 0.052]) {
        const base = marchToSurface(headSDF, 0, y, z, s, 0.05, 0);
        add(base, [s * (0.75 + rand() * 0.2), -0.05 + rand() * 0.2, 0.45 + rand() * 0.3], 0.045 + rand() * 0.03);
      }
    }
    const e = s > 0 ? eyes.eyeL : eyes.eyeR;
    for (let i = 0; i < 3; i++) {
      const base = marchToSurface(headSDF, e[0] * 0.5, e[1] + 0.022, e[2] - 0.02, s * 0.3, 0.9, 0.3);
      add(base, [s * (0.4 + rand() * 0.3), 0.6 + rand() * 0.2, 0.5], 0.03 + rand() * 0.015);
    }
  }
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ assembly

// quality > 1 meshes the body, head and tail on a coarser grid (q³ fewer samples) — used on
// phones, where sculpting both dogs at full density takes too long and nobody can see the difference.
export function createDog(cfg, quality = 1) {
  const group = new THREE.Group();
  group.name = cfg.name;
  const root = new THREE.Group();
  root.scale.setScalar(cfg.scale ?? 1);
  group.add(root);

  const pose = cfg.pose === 'sit' ? sitPose(cfg.sit) : standPose();
  const fur = furMaterial(cfg);
  const gloss = (hex, rough = 0.25) =>
    new THREE.MeshPhysicalMaterial({ color: hex, roughness: rough, clearcoat: 1, clearcoatRoughness: 0.08 });

  // --- body (coat painted in the rest frame, so markings follow the torso into any pose)
  const sdf = makeBodySDF(pose);
  const rest = [0, 0, 0];
  const bodyCtx = { rest, leg: 0 };
  const body = shadowed(new THREE.Mesh(
    buildGeometry(sdf.full, pose.bounds[0], pose.bounds[1], 0.0058 * quality, (x, y, z, nx, ny, nz, out) => {
      pose.toRest(x, y, z, rest);
      bodyCtx.leg = smoothstep(-0.012, 0.012, sdf.torso(x, y, z) - sdf.limbs(x, y, z));
      cfg.coat.body(x, y, z, nx, ny, nz, out, bodyCtx);
    }, 0.014),
    fur,
  ));
  root.add(body);

  // --- paws: fine meshes with toes, pads and curved claws
  // legs and paws get finer spots, in their own colours (Cookie's lower legs are grey and tan)
  const pawFur = furMaterial(cfg, (cfg.tickScale ?? 140) * 1.5, cfg.pawTickColor ?? cfg.tickColor, cfg.pawRoanColor ?? cfg.roanColor, 'y');
  const nailMat = new THREE.MeshPhysicalMaterial({ color: 0x141211, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.2 });
  const padColor = new THREE.Color(cfg.padColor ?? 0x2b2324);
  const pawPainter = (paw) => (x, y, z, nx, ny, nz, out) => {
    const inf = paw.describe(x, y, z);
    cfg.coat.paw(x, y, z, nx, ny, nz, out, inf);
    const dk = 1 - 0.45 * inf.cleft; // fur shadowed in the grooves between toes
    out[0] *= dk; out[1] *= dk; out[2] *= dk;
    const pd = inf.pad * smoothstep(0.35, -0.1, ny); // bare skin on the pads
    if (pd > 0) {
      out[0] += (padColor.r - out[0]) * pd; out[1] += (padColor.g - out[1]) * pd; out[2] += (padColor.b - out[2]) * pd;
      out[3] *= 1 - pd; out[4] *= 1 - pd;
    }
  };
  const addNails = (paw, parent, offset) => {
    for (const n of paw.nails) {
      const nail = new THREE.Mesh(clawGeometry(n.len, n.rad), nailMat);
      nail.position.set(n.pos[0] - offset[0], n.pos[1] - offset[1], n.pos[2] - offset[2]);
      nail.rotation.set(n.pitch, n.yaw, 0, 'YXZ');
      nail.castShadow = true;
      parent.add(nail);
    }
  };

  for (const hp of pose.hindPaws) {
    const paw = makePaw(hp.paw, hp.ankle, hp.side, false);
    root.add(shadowed(new THREE.Mesh(buildGeometry(paw.f, paw.bounds[0], paw.bounds[1], 0.0026, pawPainter(paw), 0.006), pawFur)));
    addNails(paw, root, [0, 0, 0]);
  }

  // front: forearm + paw on an elbow pivot
  const frontLegs = [];
  const pawAnchors = [];
  for (const fr of pose.fronts) {
    const paw = makePaw(fr.paw, fr.wrist, fr.side, true);
    const e = fr.elbow, w = fr.wrist;
    const sdfLeg = (x, y, z) =>
      smin(sdRoundCone(x, y, z, e[0], e[1], e[2], w[0], w[1], w[2], e[3] * 0.92, w[3]), paw.f(x, y, z), 0.02);
    const lo = paw.bounds[0].map((v, i) => Math.min(v, e[i] - e[3] - 0.01));
    const hi = paw.bounds[1].map((v, i) => Math.max(v, e[i] + e[3] + 0.01));
    const geo = buildGeometry(sdfLeg, lo, hi, 0.0024, pawPainter(paw), 0.006);
    geo.translate(-e[0], -e[1], -e[2]);
    const pivot = new THREE.Group();
    pivot.position.set(e[0], e[1], e[2]);
    const mesh = shadowed(new THREE.Mesh(geo, pawFur));
    mesh.userData.pawSide = fr.side;
    pivot.add(mesh);
    addNails(paw, pivot, e);
    const anchor = new THREE.Object3D();
    anchor.position.set(fr.paw.c[0] - e[0], 0.03 - e[1], fr.paw.c[2] - e[2]);
    pivot.add(anchor);
    pawAnchors.push(anchor);
    root.add(pivot);
    frontLegs.push({ pivot, side: fr.side });
  }

  // --- head
  const headPivot = new THREE.Group();
  headPivot.position.fromArray(pose.neck[1]);
  root.add(headPivot);
  const headGroup = new THREE.Group();
  headGroup.scale.setScalar(cfg.headScale ?? 1.22);
  headPivot.add(headGroup);
  const headSDF = makeHeadSDF(cfg);

  // Eyes sit mostly inside the skull so only a lidded dome shows.
  const EYE_R = 0.0185, EYE_DEPTH = 0.0122;
  const eyes = {};
  const eyeDirs = {};
  for (const [key, s] of [['eyeL', 1], ['eyeR', -1]]) {
    const dir = [s * 0.26, 0.1, 0.96];
    const l = Math.hypot(...dir);
    const surf = marchToSurface(headSDF, s * 0.032, 0.09, 0.08, ...dir);
    eyes[key] = surf.map((v, i) => v - (dir[i] / l) * EYE_DEPTH);
    eyeDirs[key] = new THREE.Vector3(...dir).normalize();
  }
  const rimColor = new THREE.Color(cfg.rimColor ?? 0x1c1514);
  const ctx = { ...eyes };

  const head = shadowed(new THREE.Mesh(
    buildGeometry(headSDF, [-0.16, -0.1, -0.1], [0.16, 0.2, 0.36], 0.0036 * quality, (x, y, z, nx, ny, nz, out) => {
      cfg.coat.head(x, y, z, nx, ny, nz, out, ctx);
      // dark eyelid rim
      for (const e of [eyes.eyeL, eyes.eyeR]) {
        const d = Math.hypot(x - e[0], y - e[1], z - e[2]);
        const k = 1 - smoothstep(EYE_R + 0.0015, EYE_R + 0.0045, d);
        if (k > 0) {
          out[0] += (rimColor.r - out[0]) * k; out[1] += (rimColor.g - out[1]) * k; out[2] += (rimColor.b - out[2]) * k;
          out[3] *= 1 - k; out[4] *= 1 - k;
        }
      }
    }, 0.009),
    fur,
  ));
  headGroup.add(head);

  // Eye: sphere whose +Y pole looks out; iris and pupil are painted as bands around that pole,
  // and the eye is squashed into an almond (wider than tall).
  const eyeGeo = new THREE.SphereGeometry(EYE_R, 32, 24);
  const lidMat = new THREE.MeshStandardMaterial({ color: cfg.rimColor ?? 0x1c1514, roughness: 0.7 });
  const eyeMat = new THREE.MeshPhysicalMaterial({ map: irisTexture(cfg.eyeColor), roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.12, envMapIntensity: 0.55 });
  for (const key of ['eyeL', 'eyeR']) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.fromArray(eyes[key]);
    const d = eyeDirs[key];
    const r = new THREE.Vector3(0, 1, 0).cross(d).normalize();
    const u = d.clone().cross(r);
    e.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, d, u));
    e.scale.set(1.18, 1, 0.84);
    headGroup.add(e);
    // pigmented eyelids: a cap over the top of the eye and a thinner one under it, which turns
    // the round eyeball into the almond, slightly hooded eye of the photos
    for (const [theta, tilt] of [[0.78, Math.PI / 2 + 0.12], [0.45, -Math.PI / 2 - 0.12]]) {
      const lid = new THREE.Mesh(new THREE.SphereGeometry(EYE_R * 1.05, 28, 10, 0, Math.PI * 2, 0, theta), lidMat);
      lid.rotation.x = tilt; // sphere cap is built around +Y; turn it to the top (+Z) / bottom of the eye
      e.add(lid);
    }
  }

  const tip = marchToSurface(headSDF, 0, 0.057, 0.2, 0, 0.05, 1);
  const ns = cfg.noseScale ?? 1;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), leatherMaterial(cfg.noseColor));
  nose.scale.set(0.025 * ns, 0.0185 * ns, 0.0145 * ns);
  nose.position.set(0, tip[1] + 0.005, tip[2] - 0.0085);
  nose.castShadow = true;
  headGroup.add(nose);
  for (const s of [1, -1]) {
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.0048 * ns, 10, 8), new THREE.MeshBasicMaterial({ color: 0x050505 }));
    nostril.scale.set(1.05, 0.5, 0.45);
    nostril.rotation.z = s * 0.35;
    nostril.position.set(s * 0.0098 * ns, tip[1] + 0.0035, tip[2] - 0.0085 + 0.0133 * ns);
    headGroup.add(nostril);
  }
  addWhiskers(headGroup, headSDF, eyes);

  // --- ears
  const ears = [];
  const earLen = cfg.earLength ?? 1, earW = cfg.earWidth ?? 1;
  for (const s of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.088, 0.158, -0.004);
    pivot.userData.base = new THREE.Euler(-0.1, -s * 0.58, s * 0.28, 'YXZ');
    pivot.rotation.copy(pivot.userData.base);
    const ear = shadowed(new THREE.Mesh(
      buildGeometry(makeEarSDF(s, earLen, earW), [-0.04, -0.27 * earLen, -0.085 * earW], [0.04, 0.03, 0.085 * earW], 0.0024,
        (x, y, z, nx, ny, nz, out) => cfg.coat.ear(x, y, z, nx, ny, nz, out, s)),
      fur,
    ));
    pivot.add(ear);
    headGroup.add(pivot);
    ears.push({ pivot, side: s });
  }

  // --- tail
  const tailPivot = new THREE.Group();
  tailPivot.position.fromArray(pose.tailRoot);
  root.add(tailPivot);
  const tail = shadowed(new THREE.Mesh(
    buildGeometry(tailSDF, [-0.05, -0.05, -0.39], [0.05, 0.14, 0.08], 0.0042 * quality, (...a) => cfg.coat.tail(...a), 0.006),
    fur,
  ));
  tailPivot.add(tail);

  group.traverse((o) => { o.userData.dog = group; });

  // --- behaviour
  const phase = cfg.phase ?? 0;
  const sitting = cfg.pose === 'sit';
  let happy = 0;
  let tilt = 0;
  let paw = null;       // { side, t } while giving a paw
  let nextSide = -1;    // alternate paws, starting with her right
  const GIVE = 2.8;     // seconds the paw stays up
  return {
    group,
    name: cfg.name,
    pawAnchors,
    // clicking a dog: tail wag + she gives a paw (alternating), or the paw that was clicked
    cheer(side) {
      happy = 2.6;
      if (paw && paw.t < GIVE) return;
      paw = { side: side ?? nextSide, t: 0 };
      nextSide = -paw.side;
    },
    // still=true freezes her in the photo pose (used by the reference comparison view)
    update(t, dt, still = false) {
      happy = Math.max(0, happy - dt);
      const h = still ? 0 : Math.min(1, happy);
      const wagSpeed = 6 + 14 * h;
      const wagAmp = (sitting ? 0.12 : 0.22) + 0.5 * h;
      const wag = still ? 0 : Math.sin(t * wagSpeed + phase) * wagAmp;
      tailPivot.rotation.set(pose.tailRot[0] + (sitting ? 0 : 0.3 * h), pose.tailRot[1] + wag, 0, 'YXZ');

      let pitch, yaw;
      if (still) {
        tilt = cfg.photo?.tilt ?? 0;
        pitch = cfg.photo?.pitch ?? cfg.headPitch;
        yaw = cfg.photo?.yaw ?? 0;
      } else {
        // signature head tilt (Cacau tilts a lot, Cookie barely)
        const cycle = (t + phase * 3) % cfg.tiltEvery;
        const want = cycle < cfg.tiltHold ? cfg.tilt : 0;
        tilt += (want - tilt) * Math.min(1, dt * 4);
        pitch = cfg.headPitch + Math.sin(t * 0.7 + phase) * 0.035 - 0.08 * h;
        yaw = Math.sin(t * 0.33 + phase) * 0.16 * (1 - h);
      }
      headPivot.rotation.set(pitch, yaw, tilt, 'YXZ');

      for (const e of ears) {
        const b = e.pivot.userData.base;
        const flap = still ? 0 : Math.sin(t * (6 + 12 * h) + e.side) * (0.02 + 0.12 * h);
        e.pivot.rotation.set(b.x - (pitch - cfg.headPitch) * 0.7, b.y, b.z - tilt * 0.75 + flap, 'YXZ');
      }

      // give paw: forearm swings forward and up from the elbow, pads toward you, with a little wave
      let lift = 0;
      if (paw && !still) {
        paw.t += dt;
        lift = smoothstep(0, 0.35, paw.t) * (1 - smoothstep(GIVE - 0.5, GIVE, paw.t));
        if (paw.t >= GIVE) paw = null;
      }
      for (const fl of frontLegs) {
        const l = paw && fl.side === paw.side ? lift : 0;
        const wave = Math.sin(t * 7) * 0.08 * l;
        fl.pivot.rotation.set(-1.25 * l + wave, 0, -fl.side * 0.1 * l);
      }
      root.rotation.z = paw && !sitting ? (paw.side * 0.035) * lift : 0; // shift weight off that paw

      const breath = still ? 0 : Math.sin(t * 2.1 + phase);
      body.scale.set(1 + breath * 0.008, 1 + breath * 0.006, 1);
      root.position.y = Math.abs(Math.sin(t * 9)) * 0.035 * h;
    },
  };
}
