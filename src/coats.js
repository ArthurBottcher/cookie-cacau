import * as THREE from 'three';
import { fbm } from './noise.js';
import { smoothstep } from './sdf.js';

// Coat painters. Each writes a linear RGB colour into `out` for a vertex given in its part's local
// frame (see dog.js for the frames). Body painters also get ctx.rest — the point in the standing
// torso frame, so markings stay put when the dog sits — and ctx.leg (1 on legs, 0 on the torso).
// Markings were read off cookie.jpeg and cacau.jpeg; what the photos don't show (the back half, the
// tail) is a plausible guess, kept deliberately plain.

const lin = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const set = (out, c) => { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; };
const mix = (out, c, t) => {
  if (t <= 0) return;
  out[0] += (c[0] - out[0]) * t;
  out[1] += (c[1] - out[1]) * t;
  out[2] += (c[2] - out[2]) * t;
};

// Soft membership of an irregular blob (1 inside, 0 outside).
function blob(x, y, z, cx, cy, cz, rx, ry, rz, seed, rough = 0.35, soft = 0.05) {
  const q = Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz);
  const n = fbm(x * 9 + seed, y * 9 - seed, z * 9 + seed * 0.5) * rough;
  return 1 - smoothstep(1 - soft, 1 + soft, q + n);
}

// Ticking is drawn per pixel by the fur shader (colours come from the dog config);
// painters set spot density (0 none … ~0.6 heavy) and roan (merged grey/tan cloud, 0…1).
const tick = (out, density, roan = 0) => { out[3] = density; out[4] = roan; };

// Dark lip at the corners of the mouth, fading out toward the nose.
function lipLine(x, y, z, nx, ny, out, color, strength = 0.8) {
  if (z < 0.12 || z > 0.22 || Math.abs(nx) < 0.3) return;
  const lipY = 0.034 + (z - 0.13) * 0.05;
  const w = 0.006 + Math.max(0, 0.16 - z) * 0.12;
  const along = 1 - smoothstep(0.15, 0.22, z);
  mix(out, color, (1 - smoothstep(w * 0.4, w, Math.abs(y - lipY))) * smoothstep(0.3, 0.6, Math.abs(nx)) * along * strength);
}

// ------------------------------------------------------------------ Cookie
// Dapple piebald: white heavily mottled with grey that merges on the chest, black patches,
// black ears with tan lining, black mask over her right eye with a tan brow dot and tan cheek.
const CK = {
  white: lin(0xeeebe6),
  black: lin(0x161719),
  tan: lin(0x86552f),
  tanLight: lin(0xb98a5c),
  lip: lin(0x2a2526),
};

const cookieCoat = {
  body(x, y, z, nx, ny, nz, out, ctx) {
    const [rx, ry, rz] = ctx.rest;
    set(out, CK.white);
    const chest = smoothstep(0.05, 0.2, rz) * (1 - smoothstep(0.38, 0.46, ry)) * (1 - ctx.leg);
    // patches as seen in fotos/cookie: a band over the withers running down the right shoulder,
    // an oval on the middle of the back, a big patch on the left hip, and the nape
    let b = 0;
    b = Math.max(b, blob(rx, ry, rz, 0, 0.41, 0.17, 0.17, 0.075, 0.095, 1, 0.45));    // withers band
    b = Math.max(b, blob(rx, ry, rz, -0.12, 0.33, 0.1, 0.07, 0.12, 0.15, 2, 0.5));    // down the right shoulder
    b = Math.max(b, blob(rx, ry, rz, 0.02, 0.43, -0.1, 0.075, 0.035, 0.085, 3, 0.3)); // oval on the back
    b = Math.max(b, blob(rx, ry, rz, 0.11, 0.35, -0.36, 0.06, 0.1, 0.11, 5, 0.45));   // left hip
    b = Math.max(b, blob(rx, ry, rz, 0, 0.5, 0.36, 0.08, 0.08, 0.1, 4, 0.4));         // nape, joins the head
    b *= 1 - ctx.leg;
    mix(out, CK.black, b);
    mix(out, CK.tan, (1 - smoothstep(0.02, 0.05, y)) * 0.3 * ctx.leg); // tan on the toes
    tick(out, (0.42 + 0.12 * chest + 0.06 * ctx.leg) * (1 - b), (0.75 + 0.25 * chest) * (1 - b));
  },

  head(x, y, z, nx, ny, nz, out, ctx) {
    set(out, CK.white);
    const muzzle = smoothstep(0.14, 0.18, z);

    let b = 0;
    b = Math.max(b, blob(x, y, z, -0.075, 0.1, 0.07, 0.08, 0.085, 0.135, 6, 0.25)); // mask over right eye
    b = Math.max(b, blob(x, y, z, 0.01, 0.125, -0.03, 0.11, 0.1, 0.09, 7, 0.25));   // back of skull
    b = Math.max(b, blob(x, y, z, 0.085, 0.09, 0.0, 0.05, 0.09, 0.075, 8, 0.25));   // behind left eye
    b = Math.max(b, blob(x, y, z, 0.062, 0.145, 0.07, 0.05, 0.045, 0.07, 19, 0.25)); // crown over left eye
    b = Math.max(b, blob(x, y, z, 0, 0.03, -0.06, 0.08, 0.06, 0.05, 9, 0.2));      // nape
    // white blaze: up the forehead between the eyes, widening onto the left side of the face
    const blazeW = 0.016 + 0.3 * Math.max(0, z - 0.07) + 0.03 * fbm(y * 20, z * 20, 3);
    const blaze = (1 - smoothstep(blazeW, blazeW + 0.008, Math.abs(x - 0.008))) * smoothstep(0.02, 0.05, z);
    b *= 1 - blaze * smoothstep(0.06, 0.09, y);
    mix(out, CK.black, b);
    tick(out, (0.45 + 0.14 * muzzle) * (1 - b), (0.5 + 0.5 * muzzle) * (1 - b));

    // tan points
    const e = ctx.eyeR, l = ctx.eyeL;
    mix(out, CK.tan, blob(x, y, z, e[0] + 0.004, e[1] + 0.03, e[2] - 0.006, 0.013, 0.01, 0.013, 10, 0.1, 0.25));
    mix(out, CK.tan, blob(x, y, z, -0.062, 0.035, 0.11, 0.03, 0.026, 0.055, 11, 0.25) * 0.95);
    mix(out, CK.black, blob(x, y, z, l[0] + 0.004, l[1], l[2] - 0.004, 0.026, 0.022, 0.02, 20, 0.3, 0.2) * 0.5); // dark ring round the left eye
    mix(out, CK.tan, blob(x, y, z, l[0] - 0.002, l[1] + 0.028, l[2] - 0.004, 0.013, 0.01, 0.013, 12, 0.1, 0.25) * 0.9);
    lipLine(x, y, z, nx, ny, out, CK.lip, 0.3);
  },

  // Paws (forearm down): white, dense grey dapples, a warm tan on the toes and between them —
  // the toes in the photo look brushed with tan.
  paw(x, y, z, nx, ny, nz, out, inf) {
    set(out, CK.white);
    const low = 1 - smoothstep(0.02, 0.05, inf.ly);
    mix(out, CK.tan, (inf.toe * 0.4 + inf.cleft * 0.5) * low + 0.1 * low);
    tick(out, 0.5 + 0.1 * low, 0.7);
  },

  ear(x, y, z, nx, ny, nz, out, side) {
    // outer face (pointing away from the head) black with a faint brown sheen, inner lining tan
    set(out, CK.black);
    mix(out, CK.tan, (0.5 + fbm(y * 30, z * 30, 5)) * 0.045);
    mix(out, CK.tan, smoothstep(-0.35, -0.75, nx * side) * 0.85); // only the true inner face, no tan outline
  },

  tail(x, y, z, nx, ny, nz, out) {
    set(out, CK.white); // white and mottled grey, like the rest of her
    tick(out, 0.45, 0.6);
  },
};

// ------------------------------------------------------------------ Cacau
// Red-and-white piebald: chestnut ears, chestnut over both eyes and the crown split by a narrow
// white blaze; white body with fine red freckles and soft tan washes on the chest and legs.
const CC = {
  white: lin(0xf1ece5),
  red: lin(0x66301a),
  redDark: lin(0x45200f),
  redInner: lin(0x6a3219),
  wash: lin(0xd6a274),
  lip: lin(0x3a2a24),
};

const cacauCoat = {
  body(x, y, z, nx, ny, nz, out, ctx) {
    const [rx, ry, rz] = ctx.rest;
    set(out, CC.white);
    let w = blob(rx, ry, rz, 0, 0.36, 0.32, 0.12, 0.1, 0.1, 13, 0.6, 0.3);            // chest
    w = Math.max(w, blob(rx, ry, rz, 0.05, 0.44, 0.38, 0.06, 0.06, 0.07, 18, 0.6, 0.3)); // throat, left
    mix(out, CC.wash, w * 0.5 * (1 - ctx.leg));
    tick(out, 0.2 + 0.16 * ctx.leg, 0.3 + 0.2 * ctx.leg);
  },

  head(x, y, z, nx, ny, nz, out) {
    set(out, CC.white);
    const muzzle = smoothstep(0.14, 0.18, z);

    let r = 0;
    r = Math.max(r, blob(x, y, z, 0.064, 0.095, 0.07, 0.082, 0.088, 0.12, 15, 0.25)); // over left eye (larger)
    r = Math.max(r, blob(x, y, z, -0.066, 0.113, 0.065, 0.075, 0.066, 0.105, 16, 0.25)); // above/behind right eye; white below it
    r = Math.max(r, blob(x, y, z, 0, 0.12, -0.02, 0.1, 0.1, 0.09, 17, 0.25));         // crown / back of skull
    const blazeW = 0.014 + 0.32 * Math.max(0, z - 0.0) ** 1.1 + 0.012 * fbm(y * 25, z * 25, 9);
    const blaze = 1 - smoothstep(blazeW, blazeW + 0.006, Math.abs(x - 0.003));
    r *= 1 - blaze * smoothstep(0.07, 0.1, y);
    r *= smoothstep(0.03, 0.05, y + 0.014 * Math.sign(x)); // white lower cheeks
    mix(out, CC.red, r);
    tick(out, (0.22 + 0.16 * muzzle) * (1 - r), 0.15 * (1 - r));
    lipLine(x, y, z, nx, ny, out, CC.lip, 0.35);
  },

  // Paws: white with reddish freckles that get denser on the toes, a soft tan between the toes.
  paw(x, y, z, nx, ny, nz, out, inf) {
    set(out, CC.white);
    const low = 1 - smoothstep(0.02, 0.05, inf.ly);
    mix(out, CC.wash, (inf.toe * 0.25 + inf.cleft * 0.45) * low);
    tick(out, 0.42 + 0.14 * low, 0.3);
  },

  ear(x, y, z, nx, ny, nz, out, side) {
    set(out, CC.red);
    mix(out, CC.redDark, (0.5 + fbm(y * 30, z * 30, 6)) * 0.35); // uneven, like real hair
    mix(out, CC.redDark, smoothstep(-0.2, 0.6, nx * side) * 0.55);
    mix(out, CC.redInner, smoothstep(-0.35, -0.75, nx * side) * 0.6);
  },

  tail(x, y, z, nx, ny, nz, out) {
    set(out, CC.white); // long, thin and white
    tick(out, 0.16, 0.1);
  },
};

// photo: head pose in the photo, used by the ?ref= comparison view
// refCam: camera that roughly matches the phone's position in the photo (dog frame)
export const cookie = {
  name: 'Cookie',
  coat: cookieCoat,
  pose: 'stand',
  scale: 1,
  tickColor: 0x34373c,
  roanColor: 0x7d8187,
  tickScale: 230,
  pawTickColor: 0x3a3a3e,
  pawRoanColor: 0x8c7158,
  eyeColor: 0x1e1009,
  noseColor: 0x2a2c30,
  noseScale: 0.95,
  padColor: 0x272022,
  headPitch: -0.22,
  tilt: 0.08,
  tiltEvery: 9,
  tiltHold: 2,
  earLength: 1,
  earWidth: 1,
  phase: 0,
  photo: { pitch: -0.26, yaw: 0.06, tilt: 0 },
  // realistic model generated on Meshy from cookie.jpeg, shown through Meshy's embed viewer
  meshy: {
    embed: 'https://www.meshy.ai/3d-models/embed/01a18978-45ec-7720-a72d-edb4a296b8a3',
    page: 'https://www.meshy.ai/s/GHmWed',
  },
  refCam: { pos: [0.02, 0.86, 1.08], target: [0, 0.32, 0.3], fov: 60 },
};

export const cacau = {
  name: 'Cacau',
  coat: cacauCoat,
  pose: 'sit',
  sit: {
    frontL: { x: 0.01, z: 0.5, yaw: 0.15 },   // left paw in front, crossing in a little
    frontR: { x: -0.2, z: 0.46, yaw: -0.85 },  // right paw stretched out to her side
  },
  scale: 0.96,
  tickColor: 0x9c5e38,
  roanColor: 0xdcb18a,
  tickScale: 210,
  pawTickColor: 0x8a4a28,
  eyeColor: 0x351a0a,
  noseColor: 0x151517,
  noseScale: 0.85,
  padColor: 0x2c2425,
  headPitch: -0.2,
  tilt: -0.32,
  tiltEvery: 6,
  tiltHold: 2.6,
  earLength: 1.0,
  earWidth: 1.12,
  snoutLength: 0.95,
  phase: 1.7,
  photo: { pitch: -0.24, yaw: -0.05, tilt: -0.3 },
  // realistic model generated on Meshy from her photo, shown through Meshy's embed viewer
  meshy: {
    embed: 'https://www.meshy.ai/3d-models/embed/01a18976-7e4c-7263-a88b-c771555d4e6e',
    page: 'https://www.meshy.ai/s/fTfvDC',
  },
  refCam: { pos: [0.05, 0.95, 1.15], target: [0, 0.3, 0.3], fov: 60 },
};
