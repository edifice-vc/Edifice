// Line-of-sight screening for Site Planning sheets V-101 / V-201.
// Pure functions. Load after screening.js. Terrain section, key map, ray-cast percent of roofline
// visible, and a headless raster of a Z-up scene (the same scene losToThree hands to three.js).
// Tree size at year 1 and at maturity is an assumed linear growth. DEM elevations come from the caller;
// dem3dep.js can fetch USGS 3DEP. Not a survey.
const LOS_LABEL = 'EDIFICE LINE-OF-SIGHT SCREENING — tree growth assumed — NOT A SURVEY';
const LOS_DISCLAIMER = 'CONCEPTUAL — NOT FOR CONSTRUCTION · NOT A SURVEY';
const LOS_FT = 0.3048;
// Species classes are assumptions, not a nursery schedule. Heights are metres at the source; losGrow converts.
const LOS_SPECIES = {
  evergreen: {install: 1.8288, mature: 9.144, years: 18, spread0: 1.2192, spread1: 4.8768,
    note: 'Assumed evergreen screening class: 6 ft installed, 30 ft and a wider crown at 18 years. Linear growth. Not a species curve.'},
  deciduous: {install: 2.4384, mature: 10.668, years: 20, spread0: 1.8288, spread1: 7.3152,
    note: 'Assumed deciduous screening class: 8 ft installed, 35 ft at 20 years. Linear growth. Not a species curve.'}
};
function losGrow(species, year, units) {
  const s = LOS_SPECIES[species];
  if (!s) throw new Error('unknown tree class ' + species);
  const t = Math.max(0, Math.min(1, year / s.years));
  const k = units === 'ft' ? 1 / LOS_FT : 1;
  const u = units === 'ft' ? 'ft' : 'm';
  return {
    height: sgNum((s.install + (s.mature - s.install) * t) * k, 'assumed', u, s.note),
    crown: sgNum((s.spread0 + (s.spread1 - s.spread0) * t) * k, 'assumed', u, s.note),
    year: sgNum(year, 'assumed', 'yr'),
    fraction: sgNum(t, 'computed', 'fraction', 'linear fraction of the assumed years to maturity')
  };
}
function losEyeHeight(kind, units) {
  const ft = kind === 'pedestrian' ? 5.5 : 3.5;
  const src = kind === 'pedestrian' ? 'assumed' : 'AASHTO driver eye height, 3.5 ft';
  const note = kind === 'pedestrian' ? 'pedestrian eye height, 5.5 ft' : undefined;
  const v = units === 'm' ? ft * LOS_FT : ft;
  return sgNum(v, src, units === 'm' ? 'm' : 'ft', note);
}
function losGround(spec, x, y) {
  if (spec && spec.dem) { const z = sgDem(spec.dem, x, y); if (z != null) return z; }
  return spec && spec.ground != null ? spec.ground : 0;
}
// Distance from a point to a polyline, and the berm surface (crest above the ground passed in, side slope H:V as run/rise).
function losBermZ(berm, x, y, ground) {
  const line = berm.line;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0], ay = line[i - 1][1], bx = line[i][0], by = line[i][1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  const crest = sgV(berm.crest);
  const slope = berm.slope != null ? sgV(berm.slope) : 3;
  const reach = crest * slope;
  if (!(crest > 0) || !(reach > 0) || best >= reach) return ground;
  return ground + crest * (1 - best / reach);
}
function losRayT(eye, target) { return {x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z}; }
function losWallHit(eye, target, wall) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  const ax = wall.a[0], ay = wall.a[1], bx = wall.b[0], by = wall.b[1];
  const wx = bx - ax, wy = by - ay, den = dx * wy - dy * wx;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((ax - eye.x) * wy - (ay - eye.y) * wx) / den;
  const u = ((ax - eye.x) * dy - (ay - eye.y) * dx) / den;
  if (t <= 1e-4 || t >= 1 - 1e-4 || u < -1e-8 || u > 1 + 1e-8) return false;
  const z = eye.z + t * dz;
  return z >= wall.z0 - 1e-6 && z <= wall.z1 + 1e-6;
}
function losBoxHit(eye, target, box) {
  const d = [target.x - eye.x, target.y - eye.y, target.z - eye.z];
  const o = [eye.x, eye.y, eye.z];
  const mn = [box.x0, box.y0, box.z0], mx = [box.x1, box.y1, box.z1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (o[i] < mn[i] || o[i] > mx[i]) return false; }
    else {
      let a = (mn[i] - o[i]) / d[i], b = (mx[i] - o[i]) / d[i];
      if (a > b) { const s = a; a = b; b = s; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
  }
  return t1 > 1e-4 && t0 < 1 - 1e-4;
}
// Vertical cone, apex at z1, base radius r at z0. Also tests the base disk.
function losConeHit(eye, target, cone) {
  const z0 = cone.z0, z1 = cone.z1, H = z1 - z0;
  if (!(H > 1e-6) || !(cone.r > 0)) return false;
  const D = losRayT(eye, target);
  const dz = D.z;
  if (Math.abs(dz) > 1e-12) {
    const t = (z0 - eye.z) / dz;
    if (t > 1e-4 && t < 1 - 1e-4) {
      const x = eye.x + t * D.x, y = eye.y + t * D.y;
      if (Math.hypot(x - cone.x, y - cone.y) <= cone.r + 1e-6) return true;
    }
  }
  const k = cone.r / H, k2 = k * k;
  const Bx = eye.x - cone.x, By = eye.y - cone.y, Bz = eye.z - z1;
  const a = k2 * D.z * D.z - D.x * D.x - D.y * D.y;
  const b = 2 * (k2 * Bz * D.z - Bx * D.x - By * D.y);
  const c = k2 * Bz * Bz - Bx * Bx - By * By;
  const roots = [];
  if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) roots.push(-c / b); }
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const s = Math.sqrt(disc);
    roots.push((-b - s) / (2 * a), (-b + s) / (2 * a));
  }
  for (let i = 0; i < roots.length; i++) {
    const t = roots[i];
    if (t <= 1e-4 || t >= 1 - 1e-4) continue;
    const h = -(Bz + t * D.z);
    if (h >= -1e-4 && h <= H + 1e-4) return true;
  }
  return false;
}
function losDemHit(eye, target, dem, step) {
  if (!dem) return false;
  const L = Math.hypot(target.x - eye.x, target.y - eye.y, target.z - eye.z);
  const n = Math.max(2, Math.min(200, Math.ceil(L / (step || Math.max(sgV(dem.dx) || 2, 1)))));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const z = eye.z + t * (target.z - eye.z);
    const gz = sgDem(dem, eye.x + t * (target.x - eye.x), eye.y + t * (target.y - eye.y));
    if (gz != null && gz > z + 1e-3) return true;
  }
  return false;
}
function losBermHit(eye, target, berm) {
  const n = 48;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = eye.x + t * (target.x - eye.x), y = eye.y + t * (target.y - eye.y), z = eye.z + t * (target.z - eye.z);
    const gz = berm.ground != null ? berm.ground : 0;
    const bz = losBermZ(berm, x, y, gz);
    if (bz > gz + 1e-3 && bz > z + 1e-3) return true;
  }
  return false;
}
// Returns the kind of the first obstacle that meets the ray strictly between the eye and the target, or null.
function losBlocked(eye, target, obstacles, dem) {
  const list = obstacles || [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if ((o.kind === 'wall' || o.kind === 'screen' || o.kind === 'fence') && losWallHit(eye, target, o)) return o.kind;
    if (o.kind === 'box' && losBoxHit(eye, target, o)) return 'box';
    if (o.kind === 'cone' && losConeHit(eye, target, o)) return 'cone';
    if (o.kind === 'berm' && losBermHit(eye, target, o)) return 'berm';
  }
  if (losDemHit(eye, target, dem)) return 'dem';
  return null;
}
function losVisibility(spec) {
  const targets = spec.targets || [];
  let blocked = 0;
  const detail = [];
  for (let i = 0; i < targets.length; i++) {
    const hit = losBlocked(spec.eye, targets[i], spec.obstacles, spec.dem);
    detail.push(hit);
    if (hit) blocked++;
  }
  const n = targets.length;
  const pct = n ? 100 * (n - blocked) / n : null;
  return {
    samples: sgNum(n, 'computed', 'count'),
    blocked: sgNum(blocked, 'computed', 'count'),
    visiblePct: sgNum(pct, pct == null ? 'TBD' : 'computed', '%', 'share of sample rays from the eye to the roofline that clear terrain, berms, walls and crowns'),
    detail: detail
  };
}
function losRoofTargets(building, perEdge) {
  const P = sgOpen(building.ring);
  const z = building.roofZ != null ? building.roofZ : (building.ground || 0) + sgV(building.h);
  const n = perEdge || 24;
  const pts = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push({x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]), z: z});
    }
  }
  return pts;
}
function losCones(spec, year) {
  const out = [];
  const trees = spec.trees || [];
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const g = losGrow(t.species || spec.species || 'evergreen', year, spec.units || 'ft');
    const gz = losGround(spec, t.x, t.y);
    out.push({kind: 'cone', x: t.x, y: t.y, z0: gz, z1: gz + g.height.v, r: g.crown.v});
  }
  return out;
}
function losYearVisibility(spec, year) {
  let targets = spec.targets;
  if (!targets && spec.building) targets = losRoofTargets(spec.building, spec.perEdge || 24);
  const berms = (spec.berms || []).map(b => Object.assign({kind: 'berm', ground: spec.ground || 0}, b));
  const obstacles = (spec.obstacles || []).concat(spec.includeTrees === false ? [] : losCones(spec, year)).concat(berms);
  return losVisibility({eye: spec.eye, targets: targets || [], obstacles: obstacles, dem: spec.dem});
}
function losSection(spec) {
  const eye = spec.eye, roof = spec.roof, units = spec.units || 'ft';
  const n = spec.samples || 80;
  const L = Math.hypot(roof.x - eye.x, roof.y - eye.y);
  const ve = spec.exaggeration != null ? sgV(spec.exaggeration) : 5;
  const veSrc = spec.exaggeration != null ? (spec.exaggerationSrc || 'caller') : 'assumed';
  let obsClear = Infinity, anyRise = false;
  const samples = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = eye.x + t * (roof.x - eye.x), y = eye.y + t * (roof.y - eye.y);
    const ground = spec.dem ? (sgDem(spec.dem, x, y) || 0) : (spec.ground || 0);
    let proposed = ground;
    for (const b of spec.berms || []) proposed = Math.max(proposed, losBermZ(b, x, y, ground));
    const sight = eye.z + t * (roof.z - eye.z);
    const clear = sight - proposed;
    // Clearance is over the raised works (berm, fill). The gap at the eye itself is just the eye height.
    if (proposed > ground + 0.05) { anyRise = true; if (clear < obsClear) obsClear = clear; }
    samples.push({
      dist: sgNum(t * L, 'computed', units),
      ground: sgNum(ground, spec.dem ? (spec.dem.src || 'caller') : 'caller', units),
      proposed: sgNum(proposed, 'computed', units),
      sight: sgNum(sight, 'computed', units)
    });
  }
  const trees = [];
  for (const t of spec.trees || []) {
    const g1 = losGrow(t.species || 'evergreen', spec.year1 == null ? 1 : spec.year1, units);
    const gM = losGrow(t.species || 'evergreen', spec.yearMature == null ? LOS_SPECIES[t.species || 'evergreen'].years : spec.yearMature, units);
    // station = projection onto the section
    const dx = roof.x - eye.x, dy = roof.y - eye.y, L2 = dx * dx + dy * dy || 1;
    const u = ((t.x - eye.x) * dx + (t.y - eye.y) * dy) / L2;
    const px = eye.x + u * dx, py = eye.y + u * dy;
    const off = Math.hypot(t.x - px, t.y - py);
    if (u <= 0 || u >= 1 || off > Math.max(g1.crown.v, gM.crown.v)) continue;
    const gz = spec.dem ? (sgDem(spec.dem, t.x, t.y) || 0) : (spec.ground || 0);
    trees.push({
      geom: true, x: t.x, y: t.y,
      dist: sgNum(u * L, 'computed', units),
      offset: sgNum(off, 'computed', units),
      year1: g1.height, mature: gM.height,
      ground: sgNum(gz, spec.dem ? (spec.dem.src || 'caller') : 'caller', units)
    });
  }
  if (!anyRise) {
    for (let i = 1; i < samples.length - 1; i++) {
      const gap = samples[i].sight.v - samples[i].proposed.v;
      if (gap < obsClear) obsClear = gap;
    }
  }
  const ray = losBlocked(eye, roof, (spec.obstacles || []).concat((spec.berms || []).map(b => Object.assign({kind: 'berm', ground: spec.ground || 0}, b))), spec.dem);
  const gradeBlocks = obsClear < -1e-6;
  const status = gradeBlocks || ray ? 'BLOCKED' : 'VISIBLE';
  return {
    status: status,
    by: ray || (gradeBlocks ? 'grade' : null),
    distance: sgNum(L, 'computed', units, 'horizontal distance from the eye to the roof point'),
    clearance: sgNum(isFinite(obsClear) ? obsClear : null, isFinite(obsClear) ? 'computed' : 'TBD', units, 'vertical gap from the sight line down to the berm or raised grade; negative means that grade breaks the line'),
    exaggeration: sgNum(ve, veSrc, 'x', veSrc === 'assumed' ? 'default vertical exaggeration 5×, for the section drawing' : undefined),
    horizontalScale: sgNum(100, 'method', units === 'm' ? 'm per inch-equivalent' : "ft per inch", "sheet convention 1 in = 100 ft horizontal; the section geometry itself is not scaled"),
    samples: samples,
    trees: trees,
    eye: {x: sgNum(eye.x, 'caller', units), y: sgNum(eye.y, 'caller', units), z: sgNum(eye.z, spec.eyeSrc || 'caller', units)},
    roof: {x: sgNum(roof.x, 'caller', units), y: sgNum(roof.y, 'caller', units), z: sgNum(roof.z, spec.roofSrc || 'caller', units)}
  };
}
function losKeyMap(spec) {
  const ring = spec.boundary || [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const views = (spec.viewpoints || []).map(v => {
    const nx = x1 > x0 ? (v.x - x0) / (x1 - x0) : 0.5;
    const ny = y1 > y0 ? (v.y - y0) / (y1 - y0) : 0.5;
    const b = (v.bearing || 0) * Math.PI / 180;
    return {
      id: v.id, name: v.name || v.id,
      nx: sgNum(nx, 'computed', 'fraction'), ny: sgNum(ny, 'computed', 'fraction'),
      bearing: sgNum(v.bearing || 0, v.bearingSrc || 'caller', 'deg', 'clockwise from north'),
      arrow: {x: sgNum(Math.sin(b), 'computed', 'fraction'), y: sgNum(Math.cos(b), 'computed', 'fraction')}
    };
  });
  return {
    inset: {
      widthFrac: sgNum(0.21, 'Compass Exhibit A key-map proportion', 'fraction'),
      heightFrac: sgNum(0.27, 'Compass Exhibit A key-map proportion', 'fraction')
    },
    north: {x: sgNum(0, 'method', 'fraction'), y: sgNum(1, 'method', 'fraction'), note: '+Y is north in local coordinates'},
    viewpoints: views,
    boundary: {geom: true, ring: ring}
  };
}
function losCamera(opts) {
  const focal = opts.focal_mm || 50;
  const hfov = 2 * Math.atan(18 / focal) * 180 / Math.PI;
  const aspect = opts.aspect || 16 / 9;
  const vfov = 2 * Math.atan(Math.tan(hfov * Math.PI / 360) / aspect) * 180 / Math.PI;
  const units = opts.units || 'ft';
  const eye = opts.eye, target = opts.target;
  const eyeSrc = opts.eyeSrc || 'caller';
  return {
    eye: {x: sgNum(eye.x, 'caller', units), y: sgNum(eye.y, 'caller', units), z: sgNum(eye.z, eyeSrc, units)},
    target: {x: sgNum(target.x, 'caller', units), y: sgNum(target.y, 'caller', units), z: sgNum(target.z, 'caller', units)},
    focal_mm: sgNum(focal, opts.focalSrc || (focal === 50 || focal === 24 ? 'method' : 'caller'), 'mm', 'full-frame equivalent, 36 mm sensor width'),
    hfov: sgNum(hfov, 'computed', 'deg', '2·atan(18/f)'),
    vfov: sgNum(vfov, 'computed', 'deg'),
    aspect: sgNum(aspect, 'computed', 'width/height'),
    near: sgNum(opts.near || 0.5, 'method', units),
    far: sgNum(opts.far || 8000, 'method', units)
  };
}
function losBoxMesh(name, x0, y0, z0, x1, y1, z1, color, src, note) {
  const pos = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const quads = [[4, 5, 6, 7], [1, 2, 6, 5], [3, 0, 4, 7], [0, 1, 5, 4], [2, 3, 7, 6]];
  const idx = [];
  for (const q of quads) idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  return {name: name, positions: pos, indices: idx, color: color, src: src, note: note};
}
function losConeProto() {
  const n = 6, pos = [0, 0, 1], idx = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    pos.push(Math.cos(a), Math.sin(a), 0);
  }
  for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + (i + 1) % n);
  // base
  for (let i = 1; i < n - 1; i++) idx.push(1, 1 + i + 1, 1 + i);
  return {positions: pos, indices: idx};
}
function losTrunkProto() {
  const n = 6, r = 0.12, h = 0.28, pos = [], idx = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(c * r, s * r, 0, c * r, s * r, h);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1, c = ((i + 1) % n) * 2, d = c + 1;
    idx.push(a, c, d, a, d, b, a, d, c, a, b, d);
  }
  return {positions: pos, indices: idx};
}
function losTerrain(dem, z, src) {
  const nx = dem.nx, ny = dem.ny, x0 = sgV(dem.x0), y0 = sgV(dem.y0), dx = sgV(dem.dx), dy = sgV(dem.dy);
  const pos = [], idx = [], colors = [];
  let zmin = Infinity, zmax = -Infinity;
  for (let k = 0; k < z.length; k++) { if (z[k] < zmin) zmin = z[k]; if (z[k] > zmax) zmax = z[k]; }
  const span = Math.max(1e-6, zmax - zmin);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const zz = z[j * nx + i];
    pos.push(x0 + i * dx, y0 + j * dy, zz);
    const t = (zz - zmin) / span;
    colors.push((86 + 50 * t) | 0, (122 + 30 * (1 - t)) | 0, 62);
  }
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i;
    idx.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
  }
  return {name: 'terrain', positions: pos, indices: idx, colors: colors, src: src || 'caller', note: 'existing ground'};
}
function losFrame(spec) {
  const units = spec.units || 'ft';
  const mode = spec.mode || 'proposed';
  const year = spec.year == null ? 1 : spec.year;
  const dem = spec.dem;
  if (!dem) throw new Error('losFrame needs a DEM grid');
  const base = (dem.values || dem.z).slice();
  const z = base.slice();
  if (mode === 'proposed') {
    for (let j = 0; j < dem.ny; j++) for (let i = 0; i < dem.nx; i++) {
      const x = sgV(dem.x0) + i * sgV(dem.dx), y = sgV(dem.y0) + j * sgV(dem.dy);
      let h = z[j * dem.nx + i];
      for (const b of spec.berms || []) h = Math.max(h, losBermZ(b, x, y, base[j * dem.nx + i]));
      z[j * dem.nx + i] = h;
    }
  }
  const meshes = [losTerrain(dem, z, dem.src || spec.demSrc || 'caller')];
  const assumptions = [];
  if (mode === 'proposed') {
    for (const b of spec.buildings || []) {
      if (b.h == null && b.roofZ == null) throw new Error('building ' + (b.id || '') + ' needs a height');
      const gz = losGround(spec, b.x + b.w / 2, b.y + b.d / 2);
      const top = b.roofZ != null ? b.roofZ : gz + sgV(b.h);
      const phase = (b.phase || 1) - 1;
      const pal = [[196, 168, 130], [120, 146, 168], [168, 140, 120], [140, 158, 130]];
      meshes.push(losBoxMesh(b.id || 'building', b.x, b.y, gz, b.x + b.w, b.y + b.d, top, pal[phase % pal.length], b.hSrc || 'caller', 'building mass'));
    }
    for (const yrd of spec.yards || []) {
      const gz = losGround(spec, yrd.x, yrd.y);
      meshes.push(losBoxMesh(yrd.id || 'yard', yrd.x, yrd.y, gz, yrd.x + yrd.w, yrd.y + yrd.d, gz + 0.4, [168, 164, 150], 'caller', 'equipment yard pad'));
    }
    if (spec.substation) {
      const s = spec.substation;
      const gz = losGround(spec, s.x, s.y);
      const h = s.h != null ? sgV(s.h) : (units === 'm' ? 2.44 : 8);
      const src = s.h != null ? (s.hSrc || 'caller') : 'assumed';
      if (src === 'assumed') assumptions.push({item: 'substation equipment height', src: 'assumed', note: 'typical structure height, ' + h + ' ' + units});
      meshes.push(losBoxMesh('substation', s.x, s.y, gz, s.x + s.w, s.y + s.d, gz + h, [90, 96, 110], src, 'substation equipment'));
    }
    const fenceH = (line, h, fallback, name, note) => {
      const hh = h != null ? sgV(h) : fallback;
      const src = h != null ? 'caller' : 'assumed';
      const pos = [], idx = [];
      for (let i = 0; i < line.length; i++) {
        const gz = losGround(spec, line[i][0], line[i][1]);
        pos.push(line[i][0], line[i][1], gz, line[i][0], line[i][1], gz + hh);
      }
      for (let i = 0; i < line.length - 1; i++) {
        const a = i * 2, c = a + 2, d = a + 3, b = a + 1;
        idx.push(a, c, d, a, d, b, a, d, c, a, b, d);
      }
      meshes.push({name: name, positions: pos, indices: idx, color: name === 'fence' ? [150, 154, 158] : [168, 164, 156], src: src, note: note});
      if (src === 'assumed') assumptions.push({item: name + ' height', src: 'assumed', note: note});
    };
    for (const f of spec.fences || []) fenceH(f.line, f.h, units === 'm' ? 2.4384 : 8, 'fence', 'assumed 8 ft fence where a height was not supplied');
    for (const f of spec.walls || []) fenceH(f.line, f.h, units === 'm' ? 1.8288 : 6, 'screen', 'assumed 6 ft screen wall where a height was not supplied');
    const trees = spec.trees || [];
    if (trees.length) {
      const crown = losConeProto(), trunk = losTrunkProto();
      const ic = [], it = [];
      for (const t of trees) {
        const g = losGrow(t.species || spec.species || 'evergreen', year, units);
        const gz = losGround(spec, t.x, t.y);
        ic.push({geom: true, x: t.x, y: t.y, z: gz, sx: g.crown.v, sy: g.crown.v, sz: g.height.v, h: g.height, r: g.crown});
        it.push({geom: true, x: t.x, y: t.y, z: gz, sx: g.crown.v, sy: g.crown.v, sz: g.height.v});
      }
      meshes.push({name: 'trees', positions: crown.positions, indices: crown.indices, color: [46, 96, 52], instances: ic, src: 'assumed', note: 'low-poly crowns scaled to the assumed year'});
      meshes.push({name: 'trunks', positions: trunk.positions, indices: trunk.indices, color: [92, 72, 48], instances: it, src: 'assumed', note: 'trunks'});
      assumptions.push({item: 'tree growth', src: 'assumed', note: LOS_SPECIES[trees[0].species || spec.species || 'evergreen'].note});
    }
    if (spec.figures) {
      const gnd = losGround(spec, spec.eye.x + 12, spec.eye.y + 8);
      const carH = units === 'm' ? 1.45 : 4.5, carL = units === 'm' ? 4.6 : 15, carW = units === 'm' ? 1.8 : 6;
      meshes.push(losBoxMesh('scale-car', spec.eye.x + 8, spec.eye.y + 6, gnd, spec.eye.x + 8 + carW, spec.eye.y + 6 + carL, gnd + carH, [40, 44, 52], 'assumed', 'scale figure, not a parked vehicle'));
      assumptions.push({item: 'scale figure', src: 'assumed', note: 'car-sized box for scale only'});
    }
  }
  const aspect = spec.aspect || (spec.width && spec.height ? spec.width / spec.height : 16 / 9);
  const camera = losCamera({
    eye: spec.eye, target: spec.target, focal_mm: spec.focal_mm || 50, focalSrc: spec.focalSrc,
    aspect: aspect, units: units, eyeSrc: spec.eyeSrc, near: spec.near, far: spec.far
  });
  return {
    label: LOS_LABEL,
    disclaimer: LOS_DISCLAIMER,
    mode: mode,
    year: sgNum(year, 'assumed', 'yr', mode === 'existing' ? 'existing ground only; year does not change the terrain' : 'tree age used to scale crowns'),
    units: units,
    meshes: meshes,
    camera: camera,
    keyMap: losKeyMap(spec),
    boundary: {geom: true, ring: spec.boundary || []},
    footprints: (spec.buildings || []).map(b => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.d], [b.x, b.y + b.d]]),
    assumptions: assumptions,
    growthAssumed: mode === 'proposed'
  };
}
function losMassingFrame(spec) {
  const ring = spec.boundary;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const dist = Math.hypot(x1 - x0, y1 - y0) * 0.85;
  const gz = spec.ground != null ? spec.ground : losGround(spec, cx, cy);
  const eye = {x: cx - dist / Math.SQRT2, y: cy - dist / Math.SQRT2, z: gz + dist};
  const target = {x: cx, y: cy, z: gz};
  return losFrame(Object.assign({}, spec, {mode: 'proposed', eye: eye, target: target, eyeSrc: 'computed', focal_mm: spec.focal_mm || 24, figures: false}));
}
// ---- rasterizer. Z-up, horizontal field of view held. No WebGL. ----
function losBasis(cam, w, h) {
  const eye = {x: sgV(cam.eye.x), y: sgV(cam.eye.y), z: sgV(cam.eye.z)};
  const target = {x: sgV(cam.target.x), y: sgV(cam.target.y), z: sgV(cam.target.z)};
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  const up = [0, 0, 1];
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const hfov = sgV(cam.hfov) * Math.PI / 180;
  const th = Math.tan(hfov / 2), tv = th * (h / w);
  return {eye: eye, fx: fx, fy: fy, fz: fz, rx: rx, ry: ry, rz: rz, ux: ux, uy: uy, uz: uz, th: th, tv: tv, w: w, h: h, near: sgV(cam.near) || 0.5};
}
function losProject(cam, x, y, z) {
  const dx = x - cam.eye.x, dy = y - cam.eye.y, dz = z - cam.eye.z;
  const cx = dx * cam.rx + dy * cam.ry + dz * cam.rz;
  const cy = dx * cam.ux + dy * cam.uy + dz * cam.uz;
  const cz = dx * cam.fx + dy * cam.fy + dz * cam.fz;
  if (cz <= cam.near) return null;
  return {x: ((cx / cz) / cam.th * 0.5 + 0.5) * cam.w, y: (1 - ((cy / cz) / cam.tv * 0.5 + 0.5)) * cam.h, z: cz};
}
function losFacing(eye, p0, p1, p2) {
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
  const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  return nx * (eye.x - p0[0]) + ny * (eye.y - p0[1]) + nz * (eye.z - p0[2]) > 0;
}
function losShade(p0, p1, p2, rgb) {
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
  const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const lx = -0.35, ly = -0.2, lz = 0.91, ll = Math.hypot(lx, ly, lz);
  const lambert = Math.max(0, (nx * lx + ny * ly + nz * lz) / ll);
  const s = 0.42 + 0.58 * lambert;
  return [(rgb[0] * s) | 0, (rgb[1] * s) | 0, (rgb[2] * s) | 0, 255];
}
function losFill(rgba, zbuf, w, h, s0, s1, s2, rgb) {
  const minx = Math.max(0, Math.floor(Math.min(s0.x, s1.x, s2.x)));
  const maxx = Math.min(w - 1, Math.ceil(Math.max(s0.x, s1.x, s2.x)));
  const miny = Math.max(0, Math.floor(Math.min(s0.y, s1.y, s2.y)));
  const maxy = Math.min(h - 1, Math.ceil(Math.max(s0.y, s1.y, s2.y)));
  const denom = (s1.y - s2.y) * (s0.x - s2.x) + (s2.x - s1.x) * (s0.y - s2.y);
  if (Math.abs(denom) < 1e-8) return;
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const px = x + 0.5, py = y + 0.5;
    const a = ((s1.y - s2.y) * (px - s2.x) + (s2.x - s1.x) * (py - s2.y)) / denom;
    const b = ((s2.y - s0.y) * (px - s2.x) + (s0.x - s2.x) * (py - s2.y)) / denom;
    const c = 1 - a - b;
    if (a < -1e-4 || b < -1e-4 || c < -1e-4) continue;
    const iz = a / s0.z + b / s1.z + c / s2.z;
    if (!(iz > 0)) continue;
    const depth = 1 / iz, k = y * w + x;
    if (depth >= zbuf[k]) continue;
    zbuf[k] = depth;
    const i = k * 4;
    rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
  }
}
function losDrawMesh(rgba, zbuf, w, h, cam, mesh, ins) {
  const pos = mesh.positions, idx = mesh.indices;
  const sx = ins.sx == null ? 1 : ins.sx, sy = ins.sy == null ? 1 : ins.sy, sz = ins.sz == null ? 1 : ins.sz;
  const ox = ins.x || 0, oy = ins.y || 0, oz = ins.z || 0;
  const world = (i) => [pos[i * 3] * sx + ox, pos[i * 3 + 1] * sy + oy, pos[i * 3 + 2] * sz + oz];
  for (let t = 0; t < idx.length; t += 3) {
    const p0 = world(idx[t]), p1 = world(idx[t + 1]), p2 = world(idx[t + 2]);
    if (!losFacing(cam.eye, p0, p1, p2)) continue;
    const s0 = losProject(cam, p0[0], p0[1], p0[2]);
    const s1 = losProject(cam, p1[0], p1[1], p1[2]);
    const s2 = losProject(cam, p2[0], p2[1], p2[2]);
    if (!s0 || !s1 || !s2) continue;
    let rgb = mesh.color || [160, 160, 160];
    if (mesh.colors) {
      const c = mesh.colors, ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
      rgb = [((c[ia * 3] + c[ib * 3] + c[ic * 3]) / 3), ((c[ia * 3 + 1] + c[ib * 3 + 1] + c[ic * 3 + 1]) / 3), ((c[ia * 3 + 2] + c[ib * 3 + 2] + c[ic * 3 + 2]) / 3)];
    }
    losFill(rgba, zbuf, w, h, s0, s1, s2, losShade(p0, p1, p2, rgb));
  }
}
function losPix(img, x, y, rgba) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  img.rgba[i] = rgba[0]; img.rgba[i + 1] = rgba[1]; img.rgba[i + 2] = rgba[2]; img.rgba[i + 3] = rgba[3];
}
function losRect(img, x, y, w, h, rgba) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) losPix(img, x + i, y + j, rgba);
}
function losLine(img, x0, y0, x1, y1, rgba) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    losPix(img, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rgba);
  }
}
function losArrow(img, x0, y0, x1, y1, rgba) {
  losLine(img, x0, y0, x1, y1, rgba);
  losLine(img, x0 + 1, y0, x1 + 1, y1, rgba);
  // head
  const ang = Math.atan2(y1 - y0, x1 - x0), len = 7;
  for (const da of [2.6, -2.6]) {
    const a = ang + da;
    for (let i = 0; i <= len; i++) losPix(img, x1 + Math.cos(a) * i, y1 + Math.sin(a) * i, rgba);
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) losPix(img, x1 + dx, y1 + dy, rgba);
}
function losPaintKey(img, frame) {
  const w = img.w, h = img.h;
  const iw = Math.max(10, Math.round(w * 0.21)), ih = Math.max(10, Math.round(h * 0.27));
  const x = Math.round(w * 0.025), y = h - ih - Math.max(6, Math.round(h * 0.06));
  losRect(img, x, y, iw, ih, [255, 255, 255, 255]);
  for (let i = 0; i < iw; i++) { losPix(img, x + i, y, [20, 20, 20, 255]); losPix(img, x + i, y + ih - 1, [20, 20, 20, 255]); }
  for (let j = 0; j < ih; j++) { losPix(img, x, y + j, [20, 20, 20, 255]); losPix(img, x + iw - 1, y + j, [20, 20, 20, 255]); }
  const ring = frame.boundary && frame.boundary.ring ? frame.boundary.ring : (frame.boundary || []);
  if (ring.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const sx = (iw - 10) / Math.max(1e-6, x1 - x0), sy = (ih - 10) / Math.max(1e-6, y1 - y0);
    const sc = Math.min(sx, sy);
    const X = p => x + 5 + (p[0] - x0) * sc, Y = p => y + ih - 5 - (p[1] - y0) * sc;
    const draw = pts => { for (let i = 1; i < pts.length; i++) losLine(img, X(pts[i - 1]), Y(pts[i - 1]), X(pts[i]), Y(pts[i]), [40, 40, 40, 255]); };
    draw(ring);
    const P = sgOpen(ring);
    if (P.length > 1) losLine(img, X(P[P.length - 1]), Y(P[P.length - 1]), X(P[0]), Y(P[0]), [40, 40, 40, 255]);
    for (const fp of frame.footprints || []) {
      draw(fp);
      if (fp.length > 1) losLine(img, X(fp[fp.length - 1]), Y(fp[fp.length - 1]), X(fp[0]), Y(fp[0]), [40, 40, 40, 255]);
    }
  }
  const views = frame.keyMap && frame.keyMap.viewpoints || [];
  let tip = [x + (iw / 2) | 0, y + (ih / 2) | 0];
  if (views.length) {
    const v = views[0];
    const vx = x + 5 + sgV(v.nx) * (iw - 10);
    const vy = y + ih - 5 - sgV(v.ny) * (ih - 10);
    const len = Math.min(iw, ih) * 0.34;
    const x2 = vx + sgV(v.arrow.x) * len, y2 = vy - sgV(v.arrow.y) * len;
    losArrow(img, vx, vy, x2, y2, [198, 32, 32, 255]);
    tip = [x2 | 0, y2 | 0];
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) losPix(img, tip[0] + dx, tip[1] + dy, [198, 32, 32, 255]);
  const nx = x + iw - 12, ny0 = y + 18;
  losArrow(img, nx, ny0, nx, y + 6, [20, 20, 20, 255]);
  return {inset: [x, y, iw, ih], arrow: tip, north: [nx, y + 6]};
}
function losRaster(frame, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  const zbuf = new Float64Array(w * h);
  for (let i = 0; i < zbuf.length; i++) zbuf[i] = 1e20;
  for (let y = 0; y < h; y++) {
    const t = h <= 1 ? 0 : y / (h - 1);
    const r = (176 + (220 - 176) * t) | 0, g = (206 + (230 - 206) * t) | 0, b = (226 + (240 - 226) * t) | 0;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  }
  const cam = losBasis(frame.camera, w, h);
  for (let m = 0; m < frame.meshes.length; m++) {
    const mesh = frame.meshes[m];
    const inst = mesh.instances && mesh.instances.length ? mesh.instances : [{x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1}];
    for (let k = 0; k < inst.length; k++) losDrawMesh(rgba, zbuf, w, h, cam, mesh, inst[k]);
  }
  return {w: w, h: h, rgba: rgba};
}
function losRender(spec, w, h) {
  const frame = spec.meshes ? spec : losFrame(Object.assign({}, spec, {width: w, height: h}));
  const img = losRaster(frame, w, h);
  img.markers = losPaintKey(img, frame);
  const bh = Math.max(4, Math.round(h * 0.05));
  losRect(img, 0, h - bh, w, bh, [16, 20, 26, 255]);
  img.frame = frame;
  img.caption = frame.label;
  return img;
}
function losProbe(spec, w, h) {
  const img = losRender(spec, w, h);
  let sum = 0;
  for (let i = 0; i < img.rgba.length; i += 17) sum = (sum + img.rgba[i]) >>> 0;
  const px = (x, y) => { const i = ((y | 0) * img.w + (x | 0)) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]; };
  const a = img.markers.arrow, inset = img.markers.inset;
  return {w: img.w, h: img.h, sum: sum, arrow: px(a[0], a[1]), inset: px(inset[0] + 3, inset[1] + 3), bar: px(2, img.h - 2)};
}
function losToThree(frame, THREE) {
  if (!THREE || !THREE.Scene || !THREE.BufferGeometry || !THREE.PerspectiveCamera) throw new Error('losToThree needs three.js (MIT): Scene, BufferGeometry, PerspectiveCamera');
  const scene = new THREE.Scene();
  scene.name = frame.mode + '-year-' + (frame.year && frame.year.v != null ? frame.year.v : frame.year);
  const Mat = THREE.MeshLambertMaterial || THREE.MeshBasicMaterial;
  const Attr = THREE.Float32BufferAttribute || THREE.BufferAttribute;
  for (let mi = 0; mi < frame.meshes.length; mi++) {
    const m = frame.meshes[mi];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new Attr(m.positions, 3));
    if (m.indices && g.setIndex) g.setIndex(m.indices.slice ? m.indices.slice() : m.indices);
    const color = m.color || [170, 170, 170];
    const mat = new Mat({color: (color[0] << 16) | (color[1] << 8) | color[2]});
    let obj;
    if (m.instances && m.instances.length && THREE.InstancedMesh && THREE.Matrix4) {
      obj = new THREE.InstancedMesh(g, mat, m.instances.length);
      for (let i = 0; i < m.instances.length; i++) {
        const ins = m.instances[i];
        const M = new THREE.Matrix4();
        if (M.makeScale) M.makeScale(ins.sx, ins.sy, ins.sz);
        if (M.elements) { M.elements[12] = ins.x; M.elements[13] = ins.y; M.elements[14] = ins.z; }
        obj.setMatrixAt(i, M);
      }
    } else {
      obj = new THREE.Mesh(g, mat);
    }
    obj.name = m.name;
    scene.add(obj);
  }
  const c = frame.camera;
  const cam = new THREE.PerspectiveCamera(sgV(c.vfov), sgV(c.aspect), sgV(c.near), sgV(c.far));
  cam.position.set(sgV(c.eye.x), sgV(c.eye.y), sgV(c.eye.z));
  if (!cam.up) cam.up = {set: function (x, y, z) { this.x = x; this.y = y; this.z = z; }};
  cam.up.set(0, 0, 1);
  if (cam.lookAt) cam.lookAt(sgV(c.target.x), sgV(c.target.y), sgV(c.target.z));
  cam.userData = {focal_mm: sgV(c.focal_mm), hfov: sgV(c.hfov), mode: frame.mode, year: sgV(frame.year), label: frame.label};
  return {scene: scene, camera: cam};
}
function losRun(spec) {
  const units = spec.units || 'ft';
  const species = spec.species || (spec.trees && spec.trees[0] && spec.trees[0].species) || 'evergreen';
  const y1 = spec.year1 == null ? 1 : spec.year1;
  const yM = spec.yearMature == null ? LOS_SPECIES[species].years : spec.yearMature;
  const eyeSrc = spec.eyeSrc || (spec.eyeKind ? losEyeHeight(spec.eyeKind, units).src : 'caller');
  const section = spec.eye && spec.roof ? losSection(Object.assign({}, spec, {eyeSrc: eyeSrc, year1: y1, yearMature: yM})) : null;
  const key = spec.boundary ? losKeyMap(spec) : null;
  const vis1 = (spec.targets || spec.building) ? losYearVisibility(spec, y1) : null;
  const visM = (spec.targets || spec.building) ? losYearVisibility(spec, yM) : null;
  return {
    label: LOS_LABEL,
    disclaimer: LOS_DISCLAIMER,
    units: units,
    section: spec.roof ? section : null,
    keyMap: key,
    visibility: {year1: vis1, mature: visM},
    growth: {src: 'assumed', note: LOS_SPECIES[species].note},
    eyeHeight: spec.eyeKind ? losEyeHeight(spec.eyeKind, units) : null,
    focal: losCamera({eye: spec.eye || {x: 0, y: 0, z: 0}, target: spec.target || {x: 0, y: 1, z: 0}, focal_mm: spec.focal_mm || 50, aspect: spec.aspect || 16 / 9, units: units, eyeSrc: eyeSrc}).hfov
  };
}
