// Shared helpers for the Site Planning screening modules (noise.js, photometric.js, los.js, dem3dep.js).
// Pure functions. Not wired into sheet.js. Every reported quantity is {v, src, u?, note?}:
//   src is a citation, "computed", "caller", "consultant", "TBD", or "assumed".
// Planning estimates only. Not a survey, not a sealed study.
function sgNum(v, src, u, note) {
  const o = {v: v == null || (typeof v === 'number' && !isFinite(v)) ? null : v, src: src || 'TBD'};
  if (u) o.u = u;
  if (note) o.note = note;
  return o;
}
function sgV(x) {
  if (x == null) return null;
  if (typeof x === 'number') return isFinite(x) ? x : null;
  if (typeof x === 'object' && typeof x.v === 'number' && isFinite(x.v)) return x.v;
  return null;
}
// Walk a public result. A finite number is allowed only as the v of a {v, src} quantity,
// or inside geometry that is explicitly marked (geom:true skips raw numbers and arrays;
// a parent src covers keys in SG_GEOM).
const SG_SKIP = {nx: 1, ny: 1, w: 1, h: 1, checksum: 1, band: 1, i: 1, j: 1, n: 1, pass: 1, width: 1, height: 1, sampleFormat: 1};
const SG_GEOM = {values: 1, valuesC: 1, segs: 1, positions: 1, indices: 1, rgba: 1, ring: 1, line: 1, xy: 1, lw: 1, polygon: 1, faces: 1, color: 1, colors: 1, arrow: 1, scale: 1, tie: 1, lines: 1};
function sgAudit(x, path, acc) {
  if (!acc) acc = [];
  if (x == null || typeof x === 'boolean' || typeof x === 'string') return acc;
  if (typeof x === 'number') { if (isFinite(x)) acc.push(path || '$'); return acc; }
  if (typeof x !== 'object') return acc;
  if (x.geom === true) {
    for (const k of Object.keys(x)) {
      const c = x[k];
      if (c && typeof c === 'object' && !Array.isArray(c)) sgAudit(c, (path || '$') + '.' + k, acc);
    }
    return acc;
  }
  if (typeof x.v === 'number' && typeof x.src === 'string') {
    for (const k of Object.keys(x)) if (k !== 'v') sgAudit(x[k], (path || '$') + '.' + k, acc);
    return acc;
  }
  const cover = typeof x.src === 'string';
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) sgAudit(x[i], (path || '$') + '[' + i + ']', acc);
    return acc;
  }
  for (const k of Object.keys(x)) {
    if (SG_SKIP[k]) continue;
    if (cover && SG_GEOM[k]) continue;
    sgAudit(x[k], (path || '$') + '.' + k, acc);
  }
  return acc;
}
function sgEnergy(db) {
  let s = 0, any = false;
  for (let i = 0; i < db.length; i++) {
    const L = db[i];
    if (L == null || !isFinite(L)) continue;
    s += Math.pow(10, L / 10);
    any = true;
  }
  return any && s > 0 ? 10 * Math.log10(s) : null;
}
function sgOpen(ring) {
  const P = (ring || []).slice();
  if (P.length > 1) {
    const a = P[0], b = P[P.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) P.pop();
  }
  return P;
}
function sgIn(x, y, ring) {
  const P = sgOpen(ring);
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const yi = P[i][1], yj = P[j][1];
    if ((yi > y) !== (yj > y) && x < (P[j][0] - P[i][0]) * (y - yi) / (yj - yi) + P[i][0]) c = !c;
  }
  return c;
}
function sgDist2(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function sgDist3(a, b) { return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }
// Bilinear DEM. dem: {x0,y0,dx,dy,nx,ny, values|z} row-major, y increases with row. Clamped to the grid.
function sgDem(dem, x, y) {
  if (!dem) return null;
  const z = dem.values || dem.z;
  const nx = dem.nx, ny = dem.ny;
  const x0 = sgV(dem.x0), y0 = sgV(dem.y0), dx = sgV(dem.dx), dy = sgV(dem.dy);
  if (!(dx && dy) || !z || z.length < nx * ny) return null;
  let fx = (x - x0) / dx, fy = (y - y0) / dy;
  fx = Math.max(0, Math.min(nx - 1.0000001, fx));
  fy = Math.max(0, Math.min(ny - 1.0000001, fy));
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const Z = (a, b) => z[b * nx + a];
  return (1 - u) * (1 - v) * Z(i, j) + u * (1 - v) * Z(i + 1, j) + (1 - u) * v * Z(i, j + 1) + u * v * Z(i + 1, j + 1);
}
// Segment intersection. Returns {x,y,t,u} with t along ab (S=a, R=b) and u along cd, or null.
function sgSeg(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return {x: a.x + t * rx, y: a.y + t * ry, t: t, u: u};
}
function sgPt(p) { return Array.isArray(p) ? {x: p[0], y: p[1]} : p; }
// First hit of segment S-R against a polyline (open).
function sgPolyHit(S, R, line) {
  let best = null;
  for (let i = 1; i < line.length; i++) {
    const hit = sgSeg(S, R, sgPt(line[i - 1]), sgPt(line[i]));
    if (hit && hit.t > 1e-4 && hit.t < 1 - 1e-4 && (!best || hit.t < best.t)) best = hit;
  }
  return best;
}
// All hits of segment S-R against a ring, sorted by t along S-R.
function sgRingHits(S, R, ring) {
  const P = sgOpen(ring), hits = [];
  for (let i = 0; i < P.length; i++) {
    const hit = sgSeg(S, R, sgPt(P[i]), sgPt(P[(i + 1) % P.length]));
    if (hit && hit.t > 1e-4 && hit.t < 1 - 1e-4) hits.push(hit);
  }
  hits.sort((a, b) => a.t - b.t);
  // drop duplicates from a corner graze
  const out = [];
  for (const h of hits) if (!out.length || Math.hypot(h.x - out[out.length - 1].x, h.y - out[out.length - 1].y) > 1e-3) out.push(h);
  return out;
}
// Marching squares. values[j*nx+i] at (x0+i*dx, y0+j*dy). levels is an array of numbers.
// Returns [{level, segs:[[ [x,y],[x,y] ], ...]}]. A saddle (4 crossings) is split as two segments.
function sgMarch(values, nx, ny, x0, y0, dx, dy, levels) {
  const out = [];
  for (let li = 0; li < levels.length; li++) {
    const z = levels[li], segs = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const c = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => [x0 + a * dx, y0 + b * dy, values[b * nx + a]]);
      if (c.some(p => p[2] == null || !isFinite(p[2]))) continue;
      const q = [];
      for (let k = 0; k < 4; k++) {
        const A = c[k], B = c[(k + 1) % 4];
        if ((A[2] < z) !== (B[2] < z)) {
          const t = (z - A[2]) / (B[2] - A[2]);
          q.push([A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])]);
        }
      }
      if (q.length === 2) segs.push(q);
      else if (q.length === 4) { segs.push([q[0], q[1]]); segs.push([q[2], q[3]]); }
    }
    if (segs.length) out.push({level: z, segs: segs});
  }
  return out;
}
// Greedy stitch of marching-square segments into polylines. tol in coordinate units.
function sgStitch(segs, tol) {
  tol = tol || 1e-6;
  const left = segs.map(s => [s[0].slice(), s[1].slice()]);
  const lines = [];
  function near(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol; }
  while (left.length) {
    let cur = left.pop();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = left.length - 1; i >= 0; i--) {
        const s = left[i], a = cur[0], b = cur[cur.length - 1];
        if (near(b, s[0])) { cur.push(s[1]); left.splice(i, 1); grew = true; }
        else if (near(b, s[1])) { cur.push(s[0]); left.splice(i, 1); grew = true; }
        else if (near(a, s[1])) { cur.unshift(s[0]); left.splice(i, 1); grew = true; }
        else if (near(a, s[0])) { cur.unshift(s[1]); left.splice(i, 1); grew = true; }
      }
    }
    lines.push(cur);
  }
  return lines;
}
// Classic TIFF, uncompressed strips, float32 or uint16, optional GeoTIFF ModelPixelScale (33550) and ModelTiepoint (33922).
function sgParseTiff(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (u.byteLength < 16) throw new Error('TIFF: too short');
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const le = u[0] === 0x49 && u[1] === 0x49;
  if (!le && !(u[0] === 0x4d && u[1] === 0x4d)) throw new Error('TIFF: not a TIFF');
  if (v.getUint16(2, le) !== 42) throw new Error('TIFF: bad version');
  const typeSize = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8};
  function readVal(type, count, pos) {
    const sz = typeSize[type];
    if (!sz) throw new Error('TIFF: unsupported type ' + type);
    const total = sz * count;
    const at = total <= 4 ? pos : v.getUint32(pos, le);
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = at + i * sz;
      if (type === 1 || type === 2) out.push(v.getUint8(p));
      else if (type === 3) out.push(v.getUint16(p, le));
      else if (type === 4) out.push(v.getUint32(p, le));
      else if (type === 11) out.push(v.getFloat32(p, le));
      else if (type === 12) out.push(v.getFloat64(p, le));
      else out.push(v.getUint32(p, le) / v.getUint32(p + 4, le));
    }
    return out;
  }
  const tags = {};
  const off = v.getUint32(4, le);
  const n = v.getUint16(off, le);
  for (let i = 0; i < n; i++) {
    const p = off + 2 + i * 12;
    tags[v.getUint16(p, le)] = readVal(v.getUint16(p + 2, le), v.getUint32(p + 4, le), p + 8);
  }
  const w = tags[256][0], h = tags[257][0];
  const comp = tags[259] ? tags[259][0] : 1;
  if (comp !== 1) throw new Error('TIFF: only uncompressed strips are supported (compression ' + comp + ')');
  const bps = tags[258][0];
  const sf = tags[339] ? tags[339][0] : 1;
  const rows = tags[278] ? tags[278][0] : h;
  const offsets = tags[273], counts = tags[279];
  if (!offsets) throw new Error('TIFF: missing strip offsets');
  const values = new Array(w * h);
  let row = 0, k = 0;
  for (let s = 0; s < offsets.length && row < h; s++) {
    const start = offsets[s], nRows = Math.min(rows, h - row);
    if (bps === 32 && sf === 3) {
      for (let i = 0; i < nRows * w; i++) values[k++] = v.getFloat32(start + i * 4, le);
    } else if (bps === 16 && (sf === 1 || sf === 2)) {
      for (let i = 0; i < nRows * w; i++) values[k++] = sf === 2 ? v.getInt16(start + i * 2, le) : v.getUint16(start + i * 2, le);
    } else throw new Error('TIFF: need float32 or 16-bit samples, got ' + bps + '/' + sf);
    row += nRows;
  }
  return {width: w, height: h, values: values, scale: tags[33550] || null, tie: tags[33922] || null, sampleFormat: sf, bits: bps, stripBytes: counts || null};
}
