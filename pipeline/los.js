// Line-of-sight package for Site Planning (V-101 sections, V-201 views).
// Geometry only: DEM profile, sight line, berms, trees, and the fraction of the
// facing roofline a ray clears. Massing images are in los3d.js.
// Planning model, not a visual-impact study and not a survey.
// Every output names the DEM resolution it actually used.
// Public mode (the default) drops MW, owner, and APN fields.
const LOS_LABEL = 'Illustrative — massing model, not photoreal';
const LOS_ADMIN = 'ADMIN — NOT FOR DISTRIBUTION';
const LOS_EYE_PED = 5.5; // ft, pedestrian
const LOS_EYE_DRV = 3.5; // ft, AASHTO driver eye height
const LOS_FOCAL = 50; // mm, full-frame
const LOS_FOCAL_WIDE = 24;
const LOS_SENSOR = 36; // mm, full-frame width
const LOS_FENCE_FT = 8; // [A]
const LOS_WALL_FT = 6; // [A]
const LOS_SUB_FT = 55; // [A] typical bus / structure
const LOS_YARD_FT = 15; // [A] yard equipment
const LOS_BERM_SLOPE = 3; // run:rise [A]
const LOS_HSCALE = 100; // 1 in = 100 ft on the section
const LOS_3DEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
// Species-class defaults. Linear in year, capped at maturity. Replace with a
// landscape schedule; until then every one of these is tagged ASSUMED.
const LOS_SPECIES = {
  evergreen: { id: 'evergreen', installFt: 6, matureFt: 30, spreadInstallFt: 4, spreadMatureFt: 14, years: 18,
    source: 'ASSUMED · public extension/USDA class for an evergreen screen (eastern redcedar and similar): 6 ft installed, about 30 ft and 14 ft spread at 15–20 yr, linear' },
  deciduous: { id: 'deciduous', installFt: 8, matureFt: 40, spreadInstallFt: 6, spreadMatureFt: 24, years: 20,
    source: 'ASSUMED · public extension/USDA class for a deciduous screen (oak and similar): 8 ft installed, about 40 ft and 24 ft spread at about 20 yr, linear' }
};
const LOS_DROP = { mw: 1, itMw: 1, facMw: 1, facilityMw: 1, owner: 1, ownerName: 1, apn: 1, parcelId: 1, deed: 1, generator: 1, genCount: 1, genset: 1, sensitive: 1 };

function losHfov(mm) { return 2 * Math.atan((LOS_SENSOR / 2) / (+mm || LOS_FOCAL)) * 180 / Math.PI; }

function losAssumptions() {
  return [
    { item: 'Pedestrian eye height', valueFt: LOS_EYE_PED, tag: 'stated', note: 'Sight line uses 5.5 ft unless the viewpoint asks for the driver eye.' },
    { item: 'Driver eye height', valueFt: LOS_EYE_DRV, tag: 'stated', note: 'AASHTO driver eye height. Opt-in with viewpoint.eye = "driver".' },
    { item: 'Focal length', valueMm: LOS_FOCAL, tag: 'stated', note: 'Full-frame 36 mm sensor, about 40° horizontal. A 24 mm context camera is included with the view.' },
    { item: 'Berm side slope', value: '3:1', tag: 'A', note: 'ASSUMED when a berm does not set slope (run:rise).' },
    { item: 'Fence height', valueFt: LOS_FENCE_FT, tag: 'A', note: 'ASSUMED when a fence does not set height.' },
    { item: 'Screen wall', valueFt: LOS_WALL_FT, tag: 'A', note: 'ASSUMED when a screen wall does not set height.' },
    { item: 'Substation equipment', valueFt: LOS_SUB_FT, tag: 'A', note: 'ASSUMED typical bus and structure height.' },
    { item: 'Yard equipment', valueFt: LOS_YARD_FT, tag: 'A', note: 'ASSUMED equipment height. Public labels say Yard.' },
    { item: 'Evergreen screen', value: '6 ft → 30 ft / 14 ft spread at 18 yr', tag: 'A', source: LOS_SPECIES.evergreen.source },
    { item: 'Deciduous screen', value: '8 ft → 40 ft / 24 ft spread at 20 yr', tag: 'A', source: LOS_SPECIES.deciduous.source }
  ];
}

function losDemLabel(resM, src) {
  const s = String(src || '');
  const r = isFinite(+resM) ? Math.round(+resM * 10) / 10 : null;
  if (/terrarium|z15|≈\s*4|~4\s*m/i.test(s)) return 'USGS 3DEP via AWS Terrain Tiles (z15 ≈ 4 m)';
  if (/synthetic/i.test(s)) return 'synthetic DEM · ' + (r == null ? 'grid' : r + ' m');
  if (r != null && r <= 1.25 && /3DEP|USGS/i.test(s)) return 'USGS 3DEP 1 m';
  if (/3DEP|USGS/i.test(s)) return 'USGS 3DEP ImageServer · ' + (r == null ? '' : r + ' m');
  return (s || 'DEM') + (r == null ? '' : ' · ' + r + ' m');
}

// Accept the sheet DEM ({nx,ny,X0,Y0,dx,dy,G}) and the civil DEM ({x0,y0,z}).
function losDemNormalize(d) {
  if (!d) return null;
  const z = d.z || d.G;
  if (!z || !d.nx || !d.ny) return null;
  const x0 = d.x0 != null ? +d.x0 : +d.X0;
  const y0 = d.y0 != null ? +d.y0 : +d.Y0;
  const dx = +d.dx, dy = +d.dy;
  const resFt = Math.min(Math.abs(dx) || 0, Math.abs(dy) || 0);
  const resM = d.resM != null && isFinite(+d.resM) ? +d.resM : resFt * 0.3048;
  const src = d.src || '';
  return {
    nx: d.nx | 0, ny: d.ny | 0, x0, y0, dx, dy, z,
    src, resM, resLabel: d.resLabel || losDemLabel(resM, src),
    fallback: !!d.fallback
  };
}

function losLocalFeet(lon0, lat0) {
  const kx = 364000 * Math.cos((+lat0) * Math.PI / 180), ky = 364000;
  return {
    f: (lon, lat) => [((+lon) - lon0) * kx, ((+lat) - lat0) * ky],
    b: (xy) => [lon0 + xy[0] / kx, lat0 + xy[1] / ky],
    kx, ky
  };
}

function losZ(dem, x, y) {
  if (!dem || !dem.z) return null;
  const fx = (x - dem.x0) / dem.dx, fy = (y - dem.y0) / dem.dy;
  if (!(fx >= 0 && fy >= 0 && fx <= dem.nx - 1 && fy <= dem.ny - 1)) return null;
  const i = Math.floor(fx), j = Math.floor(fy);
  const u = fx - i, v = fy - j;
  const i1 = Math.min(i + 1, dem.nx - 1), j1 = Math.min(j + 1, dem.ny - 1);
  const Z = (a, b) => dem.z[b * dem.nx + a];
  const z00 = Z(i, j), z10 = Z(i1, j), z01 = Z(i, j1), z11 = Z(i1, j1);
  if (![z00, z10, z01, z11].every(v => v != null && isFinite(v))) return null;
  return (1 - u) * (1 - v) * z00 + u * (1 - v) * z10 + (1 - u) * v * z01 + u * v * z11;
}

function losOpen(R) {
  const P = (R || []).map(p => [+p[0], +p[1]]);
  if (P.length > 1) {
    const a = P[0], b = P[P.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) P.pop();
  }
  return P;
}
function losArea(P) {
  let s = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) s += P[j][0] * P[i][1] - P[i][0] * P[j][1];
  return s / 2;
}
function losIn(x, y, R) {
  const P = losOpen(R);
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function losSegDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
}
function losLineDist(x, y, line) {
  const L = line || [];
  let d = Infinity;
  for (let i = 1; i < L.length; i++) d = Math.min(d, losSegDist(x, y, L[i - 1], L[i]));
  return d;
}

// Additional height (ft) of the berm surface above the DEM. Slope is run:rise.
function losBermH(berms, x, y) {
  let h = 0;
  for (const b of berms || []) {
    const crest = +b.crestFt || 0;
    if (!(crest > 0)) continue;
    const slope = b.slope != null && isFinite(+b.slope) ? +b.slope : LOS_BERM_SLOPE;
    const hh = crest - losLineDist(x, y, b.line || b.pts) / (slope > 0 ? slope : LOS_BERM_SLOPE);
    if (hh > h) h = hh;
  }
  return h;
}

function losTreeSize(tree, year) {
  const sp = LOS_SPECIES[(tree && (tree.species || tree.class)) || 'evergreen'] || LOS_SPECIES.evergreen;
  const install = tree && tree.installFt != null ? +tree.installFt : sp.installFt;
  const mature = tree && tree.matureFt != null ? +tree.matureFt : sp.matureFt;
  const s0 = tree && tree.spreadInstallFt != null ? +tree.spreadInstallFt : sp.spreadInstallFt;
  const s1 = tree && tree.spreadMatureFt != null ? +tree.spreadMatureFt : sp.spreadMatureFt;
  const years = tree && tree.years != null ? +tree.years : sp.years;
  const matureYear = year === 'maturity' || year === 'mature';
  const u = matureYear ? 1 : Math.max(0, Math.min(1, (+year || 0) / (years || 1)));
  const usedDefault = !tree || tree.installFt == null || tree.matureFt == null || !tree.source;
  const assumed = tree && tree.assumed === false ? false : usedDefault;
  return {
    heightFt: install + (mature - install) * u,
    spreadFt: s0 + (s1 - s0) * u,
    year: matureYear ? 'maturity' : +year || 0,
    years, assumed, tag: assumed ? 'A' : (tree.tag || 'C'),
    source: (tree && tree.source) || sp.source,
    species: sp.id
  };
}

function losRoofSamples(ring, eye, z, spacing) {
  const P = losOpen(ring);
  if (P.length < 2) return [];
  const ccw = losArea(P) > 0;
  const sp = spacing > 0 ? spacing : 10;
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ox = ccw ? dy / L : -dy / L, oy = ccw ? -dx / L : dx / L;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (ox * (eye[0] - mx) + oy * (eye[1] - my) <= 1e-6) continue; // back-facing eave
    const n = Math.max(1, Math.round(L / sp));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ x: a[0] + dx * t, y: a[1] + dy * t, z, edge: i });
    }
  }
  return out;
}

function losTris(ring) {
  const P = losOpen(ring).map(p => [p[0], p[1]]);
  if (P.length < 3) return [];
  if (losArea(P) < 0) P.reverse();
  const idx = P.map((_, i) => i), tris = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => {
    const c1 = cross(a, b, p), c2 = cross(b, c, p), c3 = cross(c, a, p);
    return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < P.length * P.length) {
    let ear = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = P[i0], b = P[i1], c = P[i2];
      if (cross(a, b, c) <= 1e-10) continue;
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inTri(P[j], a, b, c)) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      ear = true;
      break;
    }
    if (!ear) break;
  }
  if (idx.length === 3) tris.push([P[idx[0]], P[idx[1]], P[idx[2]]]);
  return tris;
}

function losBuildingZ(model, b) {
  if (b && b.z0 != null && isFinite(+b.z0)) return +b.z0;
  const P = losOpen(b && b.ring);
  let m = null;
  for (const p of P) {
    const z = losZ(model.dem, p[0], p[1]);
    if (z == null) continue;
    m = m == null ? z : Math.min(m, z);
  }
  return m == null ? 0 : m;
}
function losCenter(ring) {
  const P = losOpen(ring);
  let x = 0, y = 0;
  P.forEach(p => { x += p[0]; y += p[1]; });
  return P.length ? [x / P.length, y / P.length] : [0, 0];
}

function losEye(model, vp) {
  const g = losZ(model.dem, vp.x, vp.y);
  const eyeFt = vp.eyeFt != null && isFinite(+vp.eyeFt) ? +vp.eyeFt : (vp.eye === 'driver' ? LOS_EYE_DRV : LOS_EYE_PED);
  return { x: +vp.x, y: +vp.y, z: (g == null ? 0 : g) + eyeFt, ground: g == null ? 0 : g, eyeFt, groundKnown: g != null };
}

function losSegHit(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: ax + t * rx, y: ay + t * ry };
}

function losRayTerrain(model, eye, point) {
  const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 0.5)) return null;
  const step = 2;
  const n = Math.max(2, Math.ceil(dist / step));
  const ts = [];
  for (let i = 1; i < n; i++) ts.push(i / n);
  const den = dx * dx + dy * dy;
  for (const b of model.berms || []) {
    const line = b.line || b.pts || [];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], c = line[i];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const m = Math.max(1, Math.ceil(L / 5));
      for (let k = 0; k <= m; k++) {
        const u = k / m, x = a[0] + (c[0] - a[0]) * u, y = a[1] + (c[1] - a[1]) * u;
        const t = ((x - eye.x) * dx + (y - eye.y) * dy) / den;
        if (t > 0.002 && t < 0.998) ts.push(t);
      }
    }
  }
  let best = null;
  for (const t of ts) {
    const x = eye.x + t * dx, y = eye.y + t * dy, z = eye.z + t * dz;
    const g = losZ(model.dem, x, y);
    if (g == null) continue;
    const bh = losBermH(model.berms, x, y);
    if (g + bh > z + 0.05 && (!best || t < best.t)) best = { kind: bh > 0.2 ? 'berm' : 'terrain', t, x, y, zSurf: g + bh, zRay: z };
  }
  return best;
}

function losRayTree(model, eye, point, year) {
  let best = null;
  for (const tree of model.trees || []) {
    const size = losTreeSize(tree, year);
    if (!(size.heightFt > 0)) continue;
    const g = losZ(model.dem, tree.x, tree.y);
    const ground = g == null ? 0 : g;
    const rx = Math.max(0.4, size.spreadFt / 2), rz = Math.max(0.4, size.heightFt * 0.28);
    const cz = ground + size.heightFt * 0.72;
    const ox = (eye.x - tree.x) / rx, oy = (eye.y - tree.y) / rx, oz = (eye.z - cz) / rz;
    const ddx = (point.x - eye.x) / rx, ddy = (point.y - eye.y) / rx, ddz = (point.z - eye.z) / rz;
    const A = ddx * ddx + ddy * ddy + ddz * ddz;
    if (A < 1e-12) continue;
    const B = 2 * (ox * ddx + oy * ddy + oz * ddz);
    const C = ox * ox + oy * oy + oz * oz - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) continue;
    const s = Math.sqrt(disc);
    for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) {
      if (t > 0.01 && t < 0.99 && (!best || t < best.t)) best = { kind: 'tree', t, id: tree.id || null };
    }
  }
  return best;
}

function losRayRibbon(lines, model, eye, point, kind, defaultH) {
  let best = null;
  for (const f of lines || []) {
    const h = f.heightFt != null && isFinite(+f.heightFt) ? +f.heightFt : defaultH;
    const line = f.line || f.pts || [];
    for (let i = 1; i < line.length; i++) {
      const hit = losSegHit(eye.x, eye.y, point.x, point.y, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
      if (!hit || hit.t <= 0.01 || hit.t >= 0.99) continue;
      const z = eye.z + hit.t * (point.z - eye.z);
      const g = losZ(model.dem, hit.x, hit.y);
      const base = g == null ? 0 : g;
      if (z >= base - 0.05 && z <= base + h + 0.05 && (!best || hit.t < best.t)) best = { kind, t: hit.t, x: hit.x, y: hit.y };
    }
  }
  return best;
}

function losRayBox(model, eye, point, b) {
  if (!b || !b.ring) return null;
  const z0 = losBuildingZ(model, b);
  const z1 = z0 + (+b.heightFt || 0);
  const P = losOpen(b.ring);
  let best = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], c = P[(i + 1) % P.length];
    const hit = losSegHit(eye.x, eye.y, point.x, point.y, a[0], a[1], c[0], c[1]);
    if (!hit || hit.t <= 0.01 || hit.t >= 0.99) continue;
    const z = eye.z + hit.t * (point.z - eye.z);
    if (z >= z0 - 0.05 && z <= z1 + 0.05 && (!best || hit.t < best.t)) best = { kind: b.kind || 'building', t: hit.t, id: b.id || null };
  }
  return best;
}

function losOcclusion(model, eye, point, year, ignoreId) {
  const hits = [];
  const add = h => { if (h) hits.push(h); };
  add(losRayTerrain(model, eye, point));
  add(losRayTree(model, eye, point, year));
  add(losRayRibbon(model.fences, model, eye, point, 'fence', LOS_FENCE_FT));
  add(losRayRibbon(model.screenWalls || model.walls, model, eye, point, 'screen', LOS_WALL_FT));
  for (const b of model.buildings || []) if (b.id !== ignoreId) add(losRayBox(model, eye, point, b));
  for (const b of model.yards || []) if (b.id !== ignoreId) add(losRayBox(model, eye, point, Object.assign({ kind: 'yard' }, b)));
  if (model.substation && model.substation.id !== ignoreId) add(losRayBox(model, eye, point, Object.assign({ kind: 'substation', id: model.substation.id || 'sub' }, model.substation)));
  if (!hits.length) return null;
  hits.sort((a, b) => a.t - b.t);
  return hits[0];
}

function losMasses(model) {
  const out = [];
  for (const b of model.buildings || []) out.push(b);
  for (const b of model.yards || []) out.push(b);
  if (model.substation && model.substation.ring) out.push(model.substation);
  return out;
}
function losNearest(model, vp) {
  const masses = (model.buildings && model.buildings.length) ? model.buildings : losMasses(model);
  let best = null, bd = Infinity;
  for (const b of masses) {
    const c = losCenter(b.ring);
    const d = Math.hypot(c[0] - vp.x, c[1] - vp.y);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

function losRoofline(model, vp, building, year, spacing) {
  const eye = losEye(model, vp);
  const z0 = losBuildingZ(model, building);
  const z1 = z0 + (+building.heightFt || 0);
  const samples = losRoofSamples(building.ring, [eye.x, eye.y], z1, spacing || 10);
  let visible = 0;
  const rows = [];
  for (const s of samples) {
    const hit = losOcclusion(model, eye, s, year, building.id);
    if (!hit) visible++;
    rows.push({ x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2), visible: !hit, by: hit ? hit.kind : null });
  }
  const total = samples.length;
  const pct = total ? Math.round(visible / total * 10000) / 100 : null;
  return {
    buildingId: building.id || null,
    year: year === 'maturity' || year === 'mature' ? 'maturity' : +year || 0,
    visible, total, pct,
    status: !total ? 'NO TARGET' : pct <= 0 ? 'BLOCKED' : pct >= 100 ? 'VISIBLE' : 'PARTIAL',
    samples: rows
  };
}

function losSectionTarget(model, building, eye) {
  const z0 = losBuildingZ(model, building);
  const z1 = z0 + (+building.heightFt || 0);
  const mids = losRoofSamples(building.ring, [eye.x, eye.y], z1, 1e9);
  if (!mids.length) {
    const c = losCenter(building.ring);
    return { x: c[0], y: c[1], z: z1, buildingId: building.id || null };
  }
  mids.sort((a, b) => (a.x - eye.x) ** 2 + (a.y - eye.y) ** 2 - ((b.x - eye.x) ** 2 + (b.y - eye.y) ** 2));
  return mids[0];
}

function losSight(model, vp, building, year) {
  const eye = losEye(model, vp);
  const target = losSectionTarget(model, building, eye);
  const hit = losOcclusion(model, eye, target, year, building.id);
  const dist = Math.hypot(target.x - eye.x, target.y - eye.y);
  return {
    eye, target, distFt: dist,
    status: hit ? 'BLOCKED' : 'VISIBLE',
    blockFt: hit ? hit.t * dist : null,
    hit: hit ? hit.kind : null,
    year: year === 'maturity' || year === 'mature' ? 'maturity' : +year || 0
  };
}

function losTreesOnSection(model, eye, target, year) {
  const dx = target.x - eye.x, dy = target.y - eye.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  const out = [];
  for (const tree of model.trees || []) {
    const px = tree.x - eye.x, py = tree.y - eye.y;
    const along = px * ux + py * uy;
    const cross = Math.abs(px * uy - py * ux);
    const size = losTreeSize(tree, year);
    if (cross > size.spreadFt / 2 + 1) continue;
    if (along < -5 || along > L + 5) continue;
    const g = losZ(model.dem, tree.x, tree.y);
    const ground = g == null ? 0 : g;
    out.push({ d: along, heightFt: size.heightFt, spreadFt: size.spreadFt, zTop: ground + size.heightFt, zGround: ground, assumed: size.assumed, tag: size.tag, source: size.source, year: size.year });
  }
  return out;
}

function losProfile(model, eye, target) {
  const dx = target.x - eye.x, dy = target.y - eye.y;
  const dist = Math.hypot(dx, dy) || 1;
  const n = Math.max(2, Math.ceil(dist / 5));
  const rows = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = eye.x + t * dx, y = eye.y + t * dy;
    const g = losZ(model.dem, x, y);
    const berm = losBermH(model.berms, x, y);
    rows.push({
      d: t * dist, x, y,
      zGround: g, zBerm: berm, zSurface: g == null ? null : g + berm,
      zSight: eye.z + t * (target.z - eye.z)
    });
  }
  return rows;
}

function losVExag(dist, zRange) {
  if (!(zRange > 0) || !(dist > 0)) return 8;
  const v = 0.4 * dist / zRange;
  return Math.max(5, Math.min(10, Math.round(v)));
}

function losEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function losDepth(ring, eye, target) {
  const dx = target.x - eye.x, dy = target.y - eye.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  let mn = Infinity, mx = -Infinity;
  for (const p of losOpen(ring)) {
    const a = (p[0] - eye.x) * ux + (p[1] - eye.y) * uy;
    mn = Math.min(mn, a); mx = Math.max(mx, a);
  }
  if (!isFinite(mn)) return { near: 0, far: 0 };
  return { near: mn, far: Math.max(mn + 1, mx) };
}

function losSection(model, vp, building) {
  model = Object.assign({}, model, { dem: losDemNormalize(model.dem) });
  const dem = model.dem;
  const eye = losEye(model, vp);
  const target = building ? losSectionTarget(model, building, eye) : null;
  if (!building || !target) {
    return { viewpointId: vp.id, buildingId: null, status: 'NO TARGET', disclaimer: LOS_LABEL, dem: dem && { resM: dem.resM, resLabel: dem.resLabel, src: dem.src }, svg: '' };
  }
  const y1 = losSight(model, vp, building, 1);
  const ym = losSight(model, vp, building, 'maturity');
  const prof = losProfile(model, eye, target);
  const trees1 = losTreesOnSection(model, eye, target, 1);
  const treesM = losTreesOnSection(model, eye, target, 'maturity');
  const depth = losDepth(building.ring, eye, target);
  const z0 = losBuildingZ(model, building);
  const z1 = z0 + (+building.heightFt || 0);
  let zLo = Infinity, zHi = -Infinity;
  const see = z => { if (z != null && isFinite(z)) { zLo = Math.min(zLo, z); zHi = Math.max(zHi, z); } };
  prof.forEach(p => { see(p.zGround); see(p.zSurface); see(p.zSight); });
  trees1.forEach(t => see(t.zTop)); treesM.forEach(t => see(t.zTop));
  see(z0); see(z1); see(eye.z);
  if (!isFinite(zLo)) { zLo = 0; zHi = 1; }
  zLo -= 4; zHi += 4;
  const dist = y1.distFt;
  const vex = losVExag(dist, zHi - zLo);
  const margin = 0.45;
  const reach = Math.max(dist, depth.far, LOS_HSCALE);
  const plotW = reach / LOS_HSCALE;
  const plotH = Math.max(zHi - zLo, 1) * vex / LOS_HSCALE;
  const top = 0.62;
  const X = d => margin + d / LOS_HSCALE;
  const Y = z => top + (zHi - z) * vex / LOS_HSCALE;
  const barY = Y(zLo) + 0.18;
  const W = Math.max(plotW + margin + 0.25, 6.4);
  const H = barY + 0.95;
  const poly = (pts) => pts.map(p => X(p[0]).toFixed(3) + ',' + Y(p[1]).toFixed(3)).join(' ');
  const ground = [], berm = [];
  prof.forEach(p => {
    if (p.zGround != null) ground.push([p.d, p.zGround]);
    if (p.zSurface != null) berm.push([p.d, p.zSurface]);
  });
  const base = zLo;
  const fill = (line) => line.length ? poly([[line[0][0], base]].concat(line, [[line[line.length - 1][0], base]])) : '';
  const sight = [[0, eye.z], [dist, target.z]];
  const blocked = y1.status === 'BLOCKED' || ym.status === 'BLOCKED';
  const bld = [[depth.near, z0], [depth.far, z0], [depth.far, z1], [depth.near, z1]];
  const treeTri = (list, fillC, sw) => list.map(t => {
    const hw = Math.max(2, Math.min(t.spreadFt / 2, 30));
    return `<polygon points="${X(t.d - hw).toFixed(2)},${Y(t.zGround).toFixed(2)} ${X(t.d + hw).toFixed(2)},${Y(t.zGround).toFixed(2)} ${X(t.d).toFixed(2)},${Y(t.zTop).toFixed(2)}" fill="${fillC}" fill-opacity=".35" stroke="${sw}" stroke-width=".015"/>`;
  }).join('');
  const demLabel = dem ? dem.resLabel : 'DEM not loaded';
  const statusTxt = 'Year 1 ' + y1.status + (y1.blockFt != null ? ' at ' + Math.round(y1.blockFt) + ' ft' : '') + ' · Maturity ' + ym.status + (ym.blockFt != null ? ' at ' + Math.round(ym.blockFt) + ' ft' : '');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}" data-label="${losEsc(LOS_LABEL)}" data-dem="${losEsc(demLabel)}" data-res-m="${dem ? dem.resM : ''}" data-vexag="${vex}" data-hscale="100" data-eye-ft="${eye.eyeFt}">
<title>Line of sight section</title>
<rect width="100%" height="100%" fill="#fff"/>
<text x="${margin}" y="0.28" font-family="Arial, Helvetica, sans-serif" font-size="0.16" font-weight="700">${losEsc(vp.name || 'Viewpoint')} → ${losEsc(building.label || 'Building')}</text>
<text x="${margin}" y="0.46" font-family="Arial, Helvetica, sans-serif" font-size="0.11">${losEsc(statusTxt)} · ${Math.round(dist)} ft · eye ${eye.eyeFt} ft</text>
${fill(ground) ? `<polygon points="${fill(ground)}" fill="#e4d3b0" stroke="none"/>` : ''}
${fill(berm) ? `<polygon points="${fill(berm)}" fill="#c5d7a4" stroke="none"/>` : ''}
${ground.length ? `<polyline points="${poly(ground)}" fill="none" stroke="#6b5436" stroke-width=".02"/>` : ''}
${berm.length ? `<polyline points="${poly(berm)}" fill="none" stroke="#3e6b32" stroke-width=".02"/>` : ''}
${treeTri(treesM, '#2f6b3a', '#1d4d28')}
${treeTri(trees1, '#9dbf7a', '#4e7a32')}
<polygon points="${poly(bld)}" fill="#d9d9de" stroke="#222" stroke-width=".02"/>
<polyline points="${poly(sight)}" fill="none" stroke="${blocked ? '#b00020' : '#1a7f37'}" stroke-width=".025" stroke-dasharray=".08 .05"/>
<circle cx="${X(0).toFixed(3)}" cy="${Y(eye.z).toFixed(3)}" r="0.035" fill="#111"/>
<line data-scale-bar="100" x1="${X(0).toFixed(3)}" y1="${barY.toFixed(3)}" x2="${X(LOS_HSCALE).toFixed(3)}" y2="${barY.toFixed(3)}" stroke="#111" stroke-width=".02"/>
<text x="${X(0)}" y="${(barY + 0.16).toFixed(3)}" font-family="Arial, Helvetica, sans-serif" font-size="0.1">0</text>
<text x="${X(LOS_HSCALE)}" y="${(barY + 0.16).toFixed(3)}" font-family="Arial, Helvetica, sans-serif" font-size="0.1">100 ft</text>
<text x="${margin}" y="${(barY + 0.34).toFixed(3)}" font-family="Arial, Helvetica, sans-serif" font-size="0.1">HORIZONTAL 1 in = 100 ft · VERTICAL EXAGGERATION ${vex}× · building ${Math.round(building.heightFt || 0)} ft ${losEsc(building.heightTag || 'A')}</text>
<text x="${margin}" y="${(barY + 0.50).toFixed(3)}" font-family="Arial, Helvetica, sans-serif" font-size="0.1">${losEsc(demLabel)}</text>
<text x="${margin}" y="${(barY + 0.66).toFixed(3)}" font-family="Arial, Helvetica, sans-serif" font-size="0.1">${losEsc(LOS_LABEL)}</text>
</svg>`;
  return {
    viewpointId: vp.id, buildingId: building.id || null,
    eyeFt: eye.eyeFt, focalMm: vp.focalMm || LOS_FOCAL, hfovDeg: losHfov(vp.focalMm || LOS_FOCAL),
    distFt: dist, vExag: vex, hScale: '1 in = 100 ft',
    statusYear1: y1.status, statusMaturity: ym.status,
    blockFtYear1: y1.blockFt, blockFtMaturity: ym.blockFt,
    hitYear1: y1.hit, hitMaturity: ym.hit,
    heightFt: +building.heightFt || 0, heightTag: building.heightTag || 'A',
    dem: dem ? { resM: dem.resM, resLabel: dem.resLabel, src: dem.src, fallback: !!dem.fallback } : null,
    disclaimer: LOS_LABEL,
    profile: prof.map(p => ({ d: +p.d.toFixed(2), zGround: p.zGround, zBerm: +p.zBerm.toFixed(3), zSurface: p.zSurface, zSight: +p.zSight.toFixed(3) })),
    treesYear1: trees1, treesMaturity: treesM,
    svg
  };
}

function losNormVp(v, i) {
  const eye = v.eye === 'driver' ? 'driver' : 'pedestrian';
  return {
    id: v.id || ('vp-' + (i + 1)),
    name: v.name || (v.kind === 'road' ? 'Road entrance' : 'Viewpoint'),
    kind: v.kind || 'receptor',
    x: +v.x, y: +v.y,
    eye,
    eyeFt: v.eyeFt != null && isFinite(+v.eyeFt) ? +v.eyeFt : (eye === 'driver' ? LOS_EYE_DRV : LOS_EYE_PED),
    headingDeg: v.headingDeg != null && isFinite(+v.headingDeg) ? +v.headingDeg : null,
    focalMm: v.focalMm || LOS_FOCAL
  };
}

function losViewpoints(model) {
  if (model.viewpoints && model.viewpoints.length) return model.viewpoints.map(losNormVp);
  const vps = (model.receptors || []).map(losNormVp);
  if (!vps.length) {
    const masses = losMasses(model);
    if (masses.length) {
      const c = losCenter(masses[0].ring);
      vps.push(losNormVp({ id: 'auto-road', name: 'Road entrance', kind: 'road', x: c[0], y: c[1] - 400, eyeFt: LOS_EYE_PED }));
    }
  }
  return vps;
}

function losHeading(eye, target) {
  let deg = Math.atan2(target.x - eye.x, target.y - eye.y) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

function losCamera(model, vp, target) {
  const eye = losEye(model, vp);
  const focal = vp.focalMm || LOS_FOCAL;
  let heading = vp.headingDeg;
  if (heading == null && target) heading = losHeading(eye, target);
  const look = target ? [target.x, target.y, target.z] : [
    eye.x + Math.sin((heading || 0) * Math.PI / 180) * 400,
    eye.y + Math.cos((heading || 0) * Math.PI / 180) * 400,
    eye.z
  ];
  return {
    eye: [eye.x, eye.y, eye.z],
    target: look,
    up: [0, 0, 1],
    eyeFt: eye.eyeFt,
    ground: eye.ground,
    focalMm: focal,
    hfovDeg: +losHfov(focal).toFixed(3),
    sensorMm: LOS_SENSOR,
    headingDeg: heading,
    wide: { focalMm: LOS_FOCAL_WIDE, hfovDeg: +losHfov(LOS_FOCAL_WIDE).toFixed(3) }
  };
}

function losBounds(model, vps) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const b of losMasses(model)) losOpen(b.ring).forEach(p => add(p[0], p[1]));
  for (const b of model.berms || []) (b.line || []).forEach(p => add(p[0], p[1]));
  for (const t of model.trees || []) add(t.x, t.y);
  for (const v of vps || []) add(v.x, v.y);
  if (!isFinite(x0)) { x0 = -10; y0 = -10; x1 = 10; y1 = 10; }
  const pad = Math.max(40, 0.08 * Math.max(x1 - x0, y1 - y0));
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

function losKeyMap(model, vps, cameras) {
  const b = losBounds(model, vps);
  const W = 4.2, H = 5.4; // inches at the 21% × 27% inset proportion (4.2/5.4 ≈ 0.21/0.27)
  const m = 0.28;
  const sx = (b[2] - b[0]) || 1, sy = (b[3] - b[1]) || 1;
  const sc = Math.min((W - m * 2) / sx, (H - m * 2 - 0.7) / sy);
  const ox = m + ((W - m * 2) - sx * sc) / 2, oy = m + ((H - m * 2 - 0.7) - sy * sc) / 2;
  const X = x => ox + (x - b[0]) * sc;
  const Y = y => oy + (b[3] - y) * sc; // north up
  const ring = (R, stroke, fill, sw) => {
    const P = losOpen(R);
    if (P.length < 2) return '';
    return `<polygon points="${P.map(p => X(p[0]).toFixed(2) + ',' + Y(p[1]).toFixed(2)).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${sw || 0.02}"/>`;
  };
  let g = '';
  if (model.parcel) g += ring(model.parcel, '#222', 'none', 0.03);
  for (const berm of model.berms || []) {
    const L = berm.line || [];
    if (L.length > 1) g += `<polyline points="${L.map(p => X(p[0]).toFixed(2) + ',' + Y(p[1]).toFixed(2)).join(' ')}" fill="none" stroke="#3e6b32" stroke-width="0.06"/>`;
  }
  for (const t of model.trees || []) g += `<circle cx="${X(t.x).toFixed(2)}" cy="${Y(t.y).toFixed(2)}" r="0.05" fill="#2f6b3a"/>`;
  const phase = ['#F14B21', '#3fa7ff', '#5ad17a', '#c77dff', '#ffb000', '#00c2c2', '#ff6fae', '#a0a0a0'];
  (model.buildings || []).forEach(bldg => { g += ring(bldg.ring, '#222', phase[((bldg.phase || 1) - 1) % phase.length], 0.02); });
  (model.yards || []).forEach(y => { g += ring(y.ring, '#555', '#bdbdbd', 0.015); });
  if (model.substation && model.substation.ring) g += ring(model.substation.ring, '#222', '#e6c35c', 0.02);
  const cams = [];
  (vps || []).forEach((vp, i) => {
    const cam = (cameras || [])[i];
    const heading = cam ? cam.headingDeg : vp.headingDeg;
    const len = Math.max(sx, sy) * 0.12;
    const h = (heading || 0) * Math.PI / 180;
    const x2 = vp.x + Math.sin(h) * len, y2 = vp.y + Math.cos(h) * len;
    g += `<line x1="${X(vp.x).toFixed(2)}" y1="${Y(vp.y).toFixed(2)}" x2="${X(x2).toFixed(2)}" y2="${Y(y2).toFixed(2)}" stroke="#d00000" stroke-width="0.045"/>`;
    g += `<circle cx="${X(vp.x).toFixed(2)}" cy="${Y(vp.y).toFixed(2)}" r="0.05" fill="#d00000"/>`;
    cams.push({ id: vp.id, x: vp.x, y: vp.y, headingDeg: heading, arrow: [[vp.x, vp.y], [x2, y2]] });
  });
  const nx = W - 0.55, ny = 0.42;
  g += `<line x1="${nx}" y1="${ny + 0.34}" x2="${nx}" y2="${ny}" stroke="#111" stroke-width="0.03"/>`;
  g += `<polygon points="${nx},${ny - 0.02} ${nx - 0.07},${ny + 0.1} ${nx + 0.07},${ny + 0.1}" fill="#111"/>`;
  g += `<text x="${nx - 0.06}" y="${ny - 0.06}" font-family="Arial, Helvetica, sans-serif" font-size="0.16" font-weight="700">N</text>`;
  const demLabel = model.dem ? model.dem.resLabel : '';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" data-label="${losEsc(LOS_LABEL)}" data-dem="${losEsc(demLabel)}">
<rect width="100%" height="100%" fill="#fff" stroke="#111" stroke-width="0.03"/>
${g}
<text x="0.12" y="${(H - 0.38).toFixed(2)}" font-family="Arial, Helvetica, sans-serif" font-size="0.11">${losEsc(demLabel)}</text>
<text x="0.12" y="${(H - 0.16).toFixed(2)}" font-family="Arial, Helvetica, sans-serif" font-size="0.1">${losEsc(LOS_LABEL)}</text>
</svg>`;
  return {
    anchor: 'lower-left', widthFrac: 0.21, heightFrac: 0.27,
    north: 'up', disclaimer: LOS_LABEL,
    bounds: b, cameras: cams, svg
  };
}

function losSecrets(model) {
  const s = [];
  const push = v => { if (v != null && String(v).trim().length >= 3) s.push(String(v)); };
  push(model.owner); push(model.ownerName); push(model.apn); push(model.parcelId);
  const sec = model.sensitive || {};
  push(sec.owner); push(sec.ownerName); push(sec.apn); push(sec.parcelId);
  return s;
}
function losScrubStr(str, secrets) {
  let t = String(str == null ? '' : str);
  for (const s of secrets) if (s) t = t.split(s).join('');
  t = t.replace(/\s*\b\d+(?:\.\d+)?\s*MW\b/gi, '');
  t = t.replace(/\bMW\b/g, '');
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}
function losScrub(value, secrets) {
  if (value == null) return value;
  if (typeof value === 'string') return losScrubStr(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(v => losScrub(v, secrets));
  if (typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) {
      if (LOS_DROP[k]) continue;
      o[k] = losScrub(value[k], secrets);
    }
    return o;
  }
  return value;
}

function losPackage(model, opt) {
  model = model || {};
  opt = opt || {};
  const mode = opt.mode || model.mode || 'public';
  model = Object.assign({}, model, { dem: losDemNormalize(model.dem) });
  const vps = losViewpoints(model);
  const sections = [], cameras = [], visibility = [], pairs = [];
  for (const vp of vps) {
    const bld = (vp.targetId && (model.buildings || []).find(b => b.id === vp.targetId)) || losNearest(model, vp);
    const sec = bld ? losSection(model, vp, bld) : { viewpointId: vp.id, statusYear1: 'NO TARGET', statusMaturity: 'NO TARGET', svg: '', disclaimer: LOS_LABEL, dem: model.dem && { resM: model.dem.resM, resLabel: model.dem.resLabel, src: model.dem.src } };
    sections.push(sec);
    const target = bld ? losSectionTarget(model, bld, losEye(model, vp)) : null;
    const cam = losCamera(model, vp, target);
    vp.headingDeg = cam.headingDeg;
    cameras.push(Object.assign({ viewpointId: vp.id }, cam));
    const r1 = bld ? losRoofline(model, vp, bld, 1) : null;
    const rm = bld ? losRoofline(model, vp, bld, 'maturity') : null;
    const treeNote = (model.trees && model.trees.length) ? losTreeSize(model.trees[0], 'maturity') : null;
    visibility.push({
      receptor: vp.name, kind: vp.kind, viewpointId: vp.id,
      target: bld ? (bld.label || 'Building') : null,
      targetId: bld ? bld.id : null,
      distFt: sec.distFt != null ? Math.round(sec.distFt * 10) / 10 : null, distTag: 'C',
      eyeFt: vp.eyeFt, eyeTag: 'stated',
      focalMm: cam.focalMm, hfovDeg: cam.hfovDeg, wideHfovDeg: cam.wide.hfovDeg, focalTag: 'stated',
      dem: model.dem ? model.dem.resLabel : null, resM: model.dem ? model.dem.resM : null, demTag: /synthetic/i.test((model.dem && model.dem.src) || '') ? 'A' : 'U',
      year1Status: r1 ? r1.status : 'NO TARGET', year1Pct: r1 ? r1.pct : null, year1Visible: r1 ? r1.visible : 0, year1Total: r1 ? r1.total : 0,
      maturityStatus: rm ? rm.status : 'NO TARGET', maturityPct: rm ? rm.pct : null, maturityVisible: rm ? rm.visible : 0, maturityTotal: rm ? rm.total : 0,
      sightYear1: sec.statusYear1 || null, sightMaturity: sec.statusMaturity || null,
      treeTag: treeNote ? treeNote.tag : null, treeSource: treeNote ? treeNote.source : null,
      heightTag: bld ? (bld.heightTag || 'A') : null
    });
    for (const year of [1, 'maturity']) {
      const roof = year === 1 ? r1 : rm;
      const sight = year === 1 ? sec.statusYear1 : sec.statusMaturity;
      pairs.push({
        viewpointId: vp.id, year,
        caption: {
          receptor: vp.name,
          distFt: sec.distFt != null ? Math.round(sec.distFt) : null,
          cameraHtFt: vp.eyeFt,
          focalMm: cam.focalMm,
          hfovDeg: cam.hfovDeg,
          wideFocalMm: LOS_FOCAL_WIDE,
          treeAge: year === 1 ? 'year 1' : 'maturity',
          treeSource: treeNote ? treeNote.source : null,
          dem: model.dem ? model.dem.resLabel : null,
          resM: model.dem ? model.dem.resM : null,
          disclaimer: LOS_LABEL,
          sight
        },
        placement: {
          existing: { x: 0, y: 0, w: 0.5, h: 1 },
          proposed: { x: 0.5, y: 0, w: 0.5, h: 1 },
          keymap: { anchor: 'lower-left', w: 0.21, h: 0.27 }
        },
        camera: cam,
        roofline: roof ? { pct: roof.pct, visible: roof.visible, total: roof.total, status: roof.status } : null,
        existing: null,
        proposed: null
      });
    }
  }
  const keymap = losKeyMap(model, vps, cameras);
  const obliqueCam = losObliqueCamera(model);
  const pkg = {
    mode,
    disclaimer: LOS_LABEL,
    adminStamp: mode === 'admin' ? LOS_ADMIN : null,
    dem: model.dem ? { resM: model.dem.resM, resLabel: model.dem.resLabel, src: model.dem.src, fallback: !!model.dem.fallback } : null,
    assumptions: losAssumptions(),
    viewpoints: vps,
    cameras,
    sections,
    keymap,
    visibility,
    pairs,
    oblique: {
      caption: { title: 'Massing context', dem: model.dem ? model.dem.resLabel : null, resM: model.dem ? model.dem.resM : null, disclaimer: LOS_LABEL, note: 'Phase colours. No capacity figures.' },
      camera: obliqueCam,
      placement: { w: 1, h: 1 },
      png: null
    },
    sheets: [
      { id: 'V-101', title: 'LINE OF SIGHT', place: 'section' },
      { id: 'V-201', title: 'LINE OF SIGHT VIEWS', place: 'views' }
    ]
  };
  if (mode === 'admin') {
    const sec = model.sensitive || {};
    pkg.sensitive = {
      owner: model.owner || model.ownerName || sec.owner || sec.ownerName || null,
      apn: model.apn || model.parcelId || sec.apn || sec.parcelId || null,
      mw: model.mw != null ? model.mw : (sec.mw != null ? sec.mw : null)
    };
    return pkg;
  }
  const secrets = losSecrets(model);
  const clean = losScrub(pkg, secrets);
  clean.mode = 'public';
  clean.disclaimer = LOS_LABEL;
  (clean.viewpoints || []).forEach(v => { if (!v.name) v.name = v.kind || 'Viewpoint'; });
  (clean.visibility || []).forEach(v => {
    if (!v.receptor) v.receptor = v.kind || 'Viewpoint';
    if (!v.target) v.target = 'Building';
  });
  return clean;
}

function losObliqueCamera(model) {
  const masses = losMasses(model);
  let x = 0, y = 0, n = 0;
  masses.forEach(b => { const c = losCenter(b.ring); x += c[0]; y += c[1]; n++; });
  if (!n) { x = 0; y = 0; n = 1; }
  x /= n; y /= n;
  const bb = losBounds(model, []);
  const span = Math.max(bb[2] - bb[0], bb[3] - bb[1], 200);
  const dist = span * 0.95;
  const elev = 45 * Math.PI / 180, az = 215 * Math.PI / 180;
  const gz = losZ(model.dem, x, y) || 0;
  return {
    eye: [x + Math.sin(az) * dist * Math.cos(elev), y + Math.cos(az) * dist * Math.cos(elev), gz + dist * Math.sin(elev) + 40],
    target: [x, y, gz + 20],
    up: [0, 0, 1],
    focalMm: 35,
    hfovDeg: +losHfov(35).toFixed(3),
    headingDeg: (az * 180 / Math.PI + 180) % 360,
    note: 'oblique 45°'
  };
}

function losSheetPayload(pkg) {
  pkg = pkg && pkg.sheets ? pkg : losPackage(pkg || {});
  return {
    sheets: pkg.sheets,
    mode: pkg.mode,
    disclaimer: pkg.disclaimer,
    dem: pkg.dem,
    v101: { sections: pkg.sections, visibility: pkg.visibility, keymap: pkg.keymap, assumptions: pkg.assumptions },
    v201: { pairs: pkg.pairs, oblique: pkg.oblique, cameras: pkg.cameras }
  };
}

function losRegister(reg) {
  if (!reg) reg = (typeof globalThis !== 'undefined' && globalThis.EDIFICE_SHEETS) || null;
  if (!reg || reg._losRegistered) return !!reg;
  const add = typeof reg.add === 'function' ? reg.add.bind(reg) : typeof reg.register === 'function' ? reg.register.bind(reg) : null;
  if (!add) return false;
  reg._losRegistered = true;
  add({ id: 'V-101', title: 'LINE OF SIGHT', source: 'los', build: losSheetPayload });
  add({ id: 'V-201', title: 'LINE OF SIGHT VIEWS', source: 'los', build: losSheetPayload });
  return true;
}

function losRingFromRect(rect, un) {
  if (!rect) return null;
  const [x, y, w, h] = rect;
  const f = un || (p => p);
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(f);
}

// Read a solved test-fit (local feet, rotated frame) into a line-of-sight model.
// Capacity, owner, and APN stay under sensitive and are omitted in public mode.
function losFromSolve(r, opt) {
  opt = opt || {};
  const un = r && r.C && r.C.un ? r.C.un : (p => p);
  const height = r && r.height != null ? +r.height : (opt.heightFt || 0);
  const heightTag = opt.heightTag || (r && r.hlim && r.hlim.why === 'zoning' ? 'Z' : 'A');
  const buildings = ((r && r.halls) || []).map((h, i) => ({
    id: 'building-' + (i + 1),
    ring: losRingFromRect(h.hall, un),
    heightFt: height,
    heightTag,
    phase: (r.phase && r.phase[i]) || 1,
    label: 'Building'
  })).filter(b => b.ring);
  const yards = ((r && r.halls) || []).map((h, i) => h.gen ? ({
    id: 'yard-' + (i + 1),
    ring: losRingFromRect(h.gen, un),
    heightFt: opt.yardHeightFt != null ? +opt.yardHeightFt : LOS_YARD_FT,
    heightTag: 'A',
    assumed: true,
    label: 'Yard',
    source: 'ASSUMED · yard equipment height'
  }) : null).filter(Boolean);
  const sub = r && r.sub ? {
    id: 'substation',
    ring: losRingFromRect(r.sub, un),
    heightFt: opt.subHeightFt != null ? +opt.subHeightFt : LOS_SUB_FT,
    heightTag: 'A',
    assumed: true,
    label: 'Substation',
    source: 'ASSUMED · typical bus and structure height'
  } : null;
  return {
    dem: losDemNormalize(opt.dem),
    buildings, yards, substation: sub,
    berms: opt.berms || [],
    trees: opt.trees || [],
    fences: opt.fences || [],
    screenWalls: opt.screenWalls || [],
    viewpoints: opt.viewpoints || null,
    receptors: opt.receptors || null,
    parcel: opt.parcel || null,
    sensitive: {
      mw: r && r.k ? r.k.it : null,
      facMw: r && r.k ? r.k.fac : null,
      owner: opt.owner || null,
      apn: opt.apn || null
    }
  };
}

function losVendorCandidates(file) {
  const bases = (typeof globalThis !== 'undefined' && globalThis.LOS_VENDOR_BASES) || ['pipeline/vendor/', '/pipeline/vendor/', 'vendor/'];
  return bases.map(b => String(b).replace(/\/?$/, '/') + file);
}
function losTryRequire(file) {
  if (typeof require !== 'function') return null;
  const paths = [];
  if (typeof globalThis !== 'undefined' && globalThis.LOS_VENDOR_DIR) paths.push(globalThis.LOS_VENDOR_DIR + '/' + file);
  try {
    const path = require('path');
    const cwd = (typeof process !== 'undefined' && process.cwd) ? process.cwd() : '';
    if (cwd) {
      paths.push(path.join(cwd, 'pipeline', 'vendor', file));
      paths.push(path.join(cwd, 'vendor', file));
    }
  } catch (e) { /* path unavailable */ }
  for (const p of paths) {
    try { return require(p); } catch (e) { /* next */ }
  }
  return null;
}
function losLoadScript(url) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => res();
    s.onerror = () => rej(new Error('load ' + url));
    document.head.appendChild(s);
  });
}
async function losEnsureGeoTIFF() {
  if (typeof globalThis !== 'undefined' && globalThis.GeoTIFF && globalThis.GeoTIFF.fromArrayBuffer) return globalThis.GeoTIFF;
  if (typeof Worker === 'undefined') {
    globalThis.Worker = class { constructor() { throw new Error('workers disabled'); } postMessage() {} terminate() {} };
  }
  const mod = losTryRequire('geotiff.js');
  if (mod && mod.fromArrayBuffer) { globalThis.GeoTIFF = mod; return mod; }
  if (typeof document !== 'undefined') {
    let last;
    for (const u of losVendorCandidates('geotiff.js')) {
      try {
        await losLoadScript(u);
        if (globalThis.GeoTIFF && globalThis.GeoTIFF.fromArrayBuffer) return globalThis.GeoTIFF;
      } catch (e) { last = e; }
    }
    if (last) throw last;
  }
  throw new Error('geotiff.js not loaded');
}

function los3DEPUrl(bbox, cols, rows) {
  const q = [
    'bbox=' + bbox.map(n => +n).join(','),
    'bboxSR=4326', 'imageSR=4326',
    'size=' + cols + ',' + rows,
    'format=tiff', 'pixelType=F32',
    'interpolation=RSP_BilinearInterpolation',
    'noDataInterpretation=esriNoDataMatchAny',
    'f=image'
  ].join('&');
  return LOS_3DEP + '?' + q;
}

function losDemRequestSize(opt) {
  const bbox = opt.bbox;
  const resM = opt.resM > 0 ? opt.resM : 1;
  const maxSide = opt.maxSide > 0 ? opt.maxSide : 512;
  const project = opt.project || losLocalFeet((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2).f;
  const sw = project(bbox[0], bbox[1]), se = project(bbox[2], bbox[1]), nw = project(bbox[0], bbox[3]);
  const widthFt = Math.hypot(se[0] - sw[0], se[1] - sw[1]);
  const heightFt = Math.hypot(nw[0] - sw[0], nw[1] - sw[1]);
  const resFt = resM / 0.3048;
  let cols = Math.max(2, Math.round(widthFt / resFt));
  let rows = Math.max(2, Math.round(heightFt / resFt));
  const scale = Math.max(cols, rows) > maxSide ? maxSide / Math.max(cols, rows) : 1;
  cols = Math.max(2, Math.round(cols * scale));
  rows = Math.max(2, Math.round(rows * scale));
  return { cols, rows };
}

async function losFetch3DEP(opt) {
  const fetchFn = opt.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) throw new Error('no fetch');
  if (!opt.bbox) throw new Error('no bbox');
  const size = losDemRequestSize(opt);
  const url = los3DEPUrl(opt.bbox, size.cols, size.rows);
  const res = await fetchFn(url, opt.fetchInit);
  if (!res || !res.ok) throw new Error('3DEP HTTP ' + (res && res.status));
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf);
  const le = b.length > 2 && b[0] === 0x49 && b[1] === 0x49;
  const be = b.length > 2 && b[0] === 0x4d && b[1] === 0x4d;
  if (!le && !be) throw new Error('3DEP did not return a TIFF');
  return { buf, url, cols: size.cols, rows: size.rows };
}

async function losGridFromTiff(buf, opt) {
  opt = opt || {};
  const GT = opt.geotiff || await losEnsureGeoTIFF();
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const tiff = await GT.fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const w = image.getWidth(), h = image.getHeight();
  const ras = await image.readRasters();
  const elev = ras[0];
  let west, south, east, north, row0North = true;
  try {
    const bb = image.getBoundingBox();
    west = bb[0]; south = bb[1]; east = bb[2]; north = bb[3];
    const res = image.getResolution();
    row0North = !res || res[1] <= 0;
  } catch (e) {
    if (!opt.bbox) throw e;
    west = opt.bbox[0]; south = opt.bbox[1]; east = opt.bbox[2]; north = opt.bbox[3];
  }
  const project = opt.project || losLocalFeet((west + east) / 2, (south + north) / 2).f;
  const toFt = (opt.zUnit === 'ft') ? 1 : 3.280839895;
  const z = new Array(w * h);
  for (let r = 0; r < h; r++) {
    const j = row0North ? (h - 1 - r) : r;
    for (let c = 0; c < w; c++) {
      const v = elev[r * w + c];
      z[j * w + c] = (v == null || !isFinite(+v)) ? null : +v * toFt;
    }
  }
  const lon0 = west + (east - west) / (2 * w);
  const lon1 = east - (east - west) / (2 * w);
  const lat0 = south + (north - south) / (2 * h);
  const lat1 = north - (north - south) / (2 * h);
  const a = project(lon0, lat0), b = project(lon1, lat0), c = project(lon0, lat1);
  const dx = w > 1 ? (b[0] - a[0]) / (w - 1) : 0;
  const dy = h > 1 ? (c[1] - a[1]) / (h - 1) : 0;
  const midLon = (west + east) / 2, midLat = (south + north) / 2;
  const pW = project(west, midLat), pE = project(east, midLat);
  const pS = project(midLon, south), pN = project(midLon, north);
  const widthM = Math.hypot(pE[0] - pW[0], pE[1] - pW[1]) * 0.3048;
  const heightM = Math.hypot(pN[0] - pS[0], pN[1] - pS[1]) * 0.3048;
  const resM = ((widthM / w) + (heightM / h)) / 2;
  const src = 'USGS 3DEP ImageServer';
  return { nx: w, ny: h, x0: a[0], y0: a[1], dx, dy, z, src, resM, resLabel: losDemLabel(resM, src), fallback: false };
}

async function losLoadDem(opt) {
  opt = opt || {};
  const fallback = () => {
    const g = losDemNormalize(opt.fallback);
    if (!g) return null;
    g.fallback = true;
    g.resLabel = losDemLabel(g.resM, g.src || 'USGS 3DEP via AWS Terrain Tiles (z15 ≈ 4 m)');
    if (/z15|terrarium|≈\s*4/i.test(g.src || '') || Math.abs((g.resM || 0) - 4) < 1.5) g.resLabel = 'USGS 3DEP via AWS Terrain Tiles (z15 ≈ 4 m)';
    return g;
  };
  try {
    const got = await losFetch3DEP(opt);
    const grid = await losGridFromTiff(got.buf, opt);
    grid.url = got.url;
    return grid;
  } catch (e) {
    const g = fallback();
    if (!g) throw e;
    g.fallbackReason = String(e && e.message || e);
    return g;
  }
}

const LOS = {
  LABEL: LOS_LABEL, assumptions: losAssumptions, package: losPackage, section: losSection,
  roofline: losRoofline, loadDem: losLoadDem, fromSolve: losFromSolve, register: losRegister,
  sheet: losSheetPayload, keyMap: losKeyMap, camera: losCamera, treeSize: losTreeSize,
  demLabel: losDemLabel, normalizeDem: losDemNormalize
};
if (typeof globalThis !== 'undefined') {
  globalThis.LOS = LOS;
  if (globalThis.EDIFICE_SHEETS) losRegister(globalThis.EDIFICE_SHEETS);
}
