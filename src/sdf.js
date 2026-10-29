// Signed distance primitives + Naive Surface Nets mesher.
// Everything is plain numbers (no vector allocs) because the field is sampled ~10^6 times.

export function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

// Approximate ellipsoid distance (iq)
export function sdEll(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = x - cx, py = y - cy, pz = z - cz;
  const k0 = Math.sqrt((px / rx) ** 2 + (py / ry) ** 2 + (pz / rz) ** 2);
  const k1 = Math.sqrt((px / (rx * rx)) ** 2 + (py / (ry * ry)) ** 2 + (pz / (rz * rz)) ** 2);
  return (k0 * (k0 - 1)) / k1;
}

export function sdSphere(x, y, z, cx, cy, cz, r) {
  return Math.hypot(x - cx, y - cy, z - cz) - r;
}

// Round cone between a (radius r1) and b (radius r2) — iq
export function sdRoundCone(x, y, z, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

const CO = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

// Returns { positions, normals, indices } for the zero level set of f inside [min, max].
export function surfaceNets(f, min, max, h) {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1;
  const ny = Math.ceil((max[1] - min[1]) / h) + 1;
  const nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const F = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * h;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * h;
      let o = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) F[o++] = f(min[0] + i * h, y, z);
    }
  }

  const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
  const vid = new Int32Array(cnx * cny * cnz).fill(-1);
  const pos = [];
  const v = new Float32Array(8);
  for (let k = 0; k < cnz; k++) {
    for (let j = 0; j < cny; j++) {
      for (let i = 0; i < cnx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CO[c];
          v[c] = F[i + o[0] + nx * (j + o[1] + ny * (k + o[2]))];
          if (v[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          if ((v[a] < 0) === (v[b] < 0)) continue;
          const t = v[a] / (v[a] - v[b]);
          const oa = CO[a], ob = CO[b];
          sx += oa[0] + t * (ob[0] - oa[0]);
          sy += oa[1] + t * (ob[1] - oa[1]);
          sz += oa[2] + t * (ob[2] - oa[2]);
          cnt++;
        }
        vid[i + cnx * (j + cny * k)] = pos.length / 3;
        pos.push(min[0] + (i + sx / cnt) * h, min[1] + (j + sy / cnt) * h, min[2] + (k + sz / cnt) * h);
      }
    }
  }

  const cell = (i, j, k) => vid[i + cnx * (j + cny * k)];
  const idx = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    idx.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const inside = F[i + nx * (j + ny * k)] < 0;
        if (i < cnx && j > 0 && k > 0 && j < ny - 1 && k < nz - 1) {
          if (inside !== F[i + 1 + nx * (j + ny * k)] < 0)
            quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k));
        }
        if (j < cny && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
          if (inside !== F[i + nx * (j + 1 + ny * k)] < 0)
            quad(cell(i - 1, j, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i - 1, j, k));
        }
        if (k < cnz && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
          if (inside !== F[i + nx * (j + ny * (k + 1))] < 0)
            quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k));
        }
      }
    }
  }

  // Project vertices onto the surface and take normals from the field gradient.
  const n = pos.length / 3;
  const positions = new Float32Array(pos);
  const normals = new Float32Array(n * 3);
  const e = h * 0.35;
  for (let p = 0; p < n; p++) {
    let x = positions[p * 3], y = positions[p * 3 + 1], z = positions[p * 3 + 2];
    let gx = 0, gy = 1, gz = 0;
    for (let it = 0; it < 3; it++) {
      gx = f(x + e, y, z) - f(x - e, y, z);
      gy = f(x, y + e, z) - f(x, y - e, z);
      gz = f(x, y, z + e) - f(x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      if (it === 2) break;
      const d = Math.max(-h, Math.min(h, f(x, y, z)));
      x -= d * gx; y -= d * gy; z -= d * gz;
    }
    positions[p * 3] = x; positions[p * 3 + 1] = y; positions[p * 3 + 2] = z;
    normals[p * 3] = gx; normals[p * 3 + 1] = gy; normals[p * 3 + 2] = gz;
  }

  // Fix winding so faces agree with the gradient normals.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const dot = fx * (normals[a] + normals[b] + normals[c]) + fy * (normals[a + 1] + normals[b + 1] + normals[c + 1]) + fz * (normals[a + 2] + normals[b + 2] + normals[c + 2]);
    if (dot < 0) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }

  return { positions, normals, indices: idx };
}

// Walk from an inside point along a direction until leaving the surface.
export function marchToSurface(f, ox, oy, oz, dx, dy, dz, step = 0.001, maxDist = 0.4) {
  const l = Math.hypot(dx, dy, dz);
  dx /= l; dy /= l; dz /= l;
  for (let s = 0; s < maxDist; s += step) {
    if (f(ox + dx * s, oy + dy * s, oz + dz * s) > 0) return [ox + dx * s, oy + dy * s, oz + dz * s];
  }
  return [ox, oy, oz];
}
