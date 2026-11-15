// E-001 photometric screening engine. IES LM-63 Type C parser and direct-component
// point-by-point illuminance, the outdoor method AGi32 uses before interreflection.
// E = I(θ,ψ) · h / d³ · LLF, which is I · cos³θ / h² when the fixture aims straight down.
// Fixture library values are synthetic and tagged ASSUMED. Not a lighting study.
//
// Near-field (a point closer than about five times the luminous opening) is not modeled.
// Light reflected from the ground or a facade is not modeled, so a 0.0 fc property-line
// result is only as good as the fixture file and the pole positions.
// The file's candela multiplier is applied. Its ballast factor is not applied again;
// put ballast and dirt depreciation in LLF.

const PH_LABEL = 'EDIFICE SCREENING MODEL — NOT A LIGHTING STUDY';
const PH_ISOLINES_FC = [0.1, 0.5, 1, 2, 3, 5];
const PH_ISOLINE_COLOR = { 0.1: '#d5e4cf', 0.5: '#8fbf7a', 1: '#2e7d32', 2: '#f2c14e', 3: '#e07a3d', 5: '#c62828' };
const PH_FC_PER_LUX = 0.09290304;
const PH_FT = 0.3048;

// ---- IES LM-63 ----------------------------------------------------------------

function phParseIES(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const keywords = {};
  let version = '', i = 0, sawTilt = false, tiltLine = '';
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^IES/i.test(line) && !/^\[/.test(line)) { version = line; continue; }
    if (/^\[/.test(line)) {
      const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (m) keywords[m[1].toUpperCase()] = m[2].trim();
      continue;
    }
    if (/^TILT\s*=/i.test(line)) { sawTilt = true; tiltLine = line; break; }
  }
  if (!sawTilt) throw new Error('IES: missing TILT=');
  const tiltKind = tiltLine.split('=').slice(1).join('=').trim().toUpperCase();
  i++;
  const nums = phNumbers(lines, i);
  let tilt = { kind: tiltKind, geometry: null, angles: [], factors: [] };
  let rest = nums;
  if (tiltKind === 'INCLUDE') {
    if (nums.length < 2) throw new Error('IES: truncated TILT=INCLUDE');
    const nAng = nums[1];
    if (!(nAng >= 1) || nums.length < 2 + 2 * nAng) throw new Error('IES: truncated tilt angles');
    tilt = { kind: 'INCLUDE', geometry: nums[0], angles: nums.slice(2, 2 + nAng), factors: nums.slice(2 + nAng, 2 + 2 * nAng) };
    rest = nums.slice(2 + 2 * nAng);
  } else if (tiltKind !== 'NONE') {
    throw new Error('IES: external TILT file is not supported (' + tiltKind + ')');
  }
  if (rest.length < 13) throw new Error('IES: photometric header is truncated');
  const nV = rest[3], nH = rest[4];
  if (!(nV >= 1) || !(nH >= 1)) throw new Error('IES: angle counts must be positive');
  const need = 13 + nV + nH + nV * nH;
  if (rest.length < need) throw new Error('IES: expected ' + need + ' numbers after TILT, got ' + rest.length);
  let k = 13;
  const vertical = rest.slice(k, k + nV); k += nV;
  const horizontal = rest.slice(k, k + nH); k += nH;
  const candela = [];
  for (let h = 0; h < nH; h++) { candela.push(rest.slice(k, k + nV)); k += nV; }
  phCheckAngles(vertical, 'vertical');
  phCheckAngles(horizontal, 'horizontal');
  const lamps = rest[0], lumensPerLamp = rest[1];
  const photoType = rest[5];
  return {
    version: version,
    keywords: keywords,
    tilt: tilt,
    lamps: lamps,
    lumensPerLamp: lumensPerLamp,
    multiplier: rest[2],
    nV: nV,
    nH: nH,
    photoType: photoType,
    photometricType: photoType === 1 ? 'C' : photoType === 2 ? 'B' : photoType === 3 ? 'A' : 'unknown',
    unitsType: rest[6],
    units: rest[6] === 2 ? 'm' : 'ft',
    width: rest[7], length: rest[8], height: rest[9],
    ballastFactor: rest[10],
    futureUse: rest[11],
    inputWatts: rest[12],
    vertical: vertical,
    horizontal: horizontal,
    candela: candela,
    lumensRated: lamps * lumensPerLamp,
    lumensIntegrated: null
  };
}
function phNumbers(lines, start) {
  const nums = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line[0] === '[') continue;
    const parts = line.match(/[+-]?(?:\d+\.\d+|\d+\.|\.\d+|\d+)(?:[eE][+-]?\d+)?/g);
    if (!parts) continue;
    for (let k = 0; k < parts.length; k++) {
      const n = +parts[k];
      if (!isFinite(n)) throw new Error('IES: non-numeric token ' + parts[k]);
      nums.push(n);
    }
  }
  return nums;
}
function phCheckAngles(angles, name) {
  for (let i = 1; i < angles.length; i++) if (!(angles[i] > angles[i - 1] - 1e-9)) throw new Error('IES: ' + name + ' angles must increase');
}
function phTiltFactor(ies, tiltDeg) {
  if (!ies.tilt || ies.tilt.kind !== 'INCLUDE') return 1;
  const a = ies.tilt.angles, f = ies.tilt.factors, t = tiltDeg || 0;
  if (t <= a[0]) return f[0];
  if (t >= a[a.length - 1]) return f[f.length - 1];
  let i = 0;
  while (i < a.length - 1 && a[i + 1] < t) i++;
  const u = (t - a[i]) / (a[i + 1] - a[i] || 1);
  return f[i] + u * (f[i + 1] - f[i]);
}

// Map a compass psi into the file's horizontal range.
// Last angle 0: axially symmetric. 90: quadrant. 180: bilateral. 360: full.
function phPsiInFile(psi, horizontal) {
  const last = horizontal[horizontal.length - 1];
  let a = ((psi % 360) + 360) % 360;
  if (horizontal.length === 1 || last <= 0.01) return horizontal[0];
  if (last <= 90.01) {
    a = a % 180;
    if (a > 90) a = 180 - a;
  } else if (last <= 180.01) {
    if (a > 180) a = 360 - a;
  } else if (a > last) {
    a = last;
  }
  return a;
}
function phBracket(angles, value) {
  if (value <= angles[0]) return { i: 0, j: 0, t: 0, above: false };
  const last = angles[angles.length - 1];
  if (value >= last) return { i: angles.length - 1, j: angles.length - 1, t: 0, above: value > last + 1e-9 };
  let i = 0;
  while (i < angles.length - 1 && angles[i + 1] < value) i++;
  const j = Math.min(angles.length - 1, i + 1);
  const span = angles[j] - angles[i];
  return { i: i, j: j, t: span ? (value - angles[i]) / span : 0, above: false };
}
function phCandela(ies, theta, psi) {
  if (ies.photoType !== 1) throw new Error('IES: only Type C photometry is calculated (this file is type ' + ies.photometricType + ')');
  const vb = phBracket(ies.vertical, theta);
  if (vb.above || theta > ies.vertical[ies.vertical.length - 1] + 1e-9) return 0;
  const pb = phBracket(ies.horizontal, phPsiInFile(psi, ies.horizontal));
  const c = ies.candela;
  const i00 = c[pb.i][vb.i], i10 = c[pb.j][vb.i], i01 = c[pb.i][vb.j], i11 = c[pb.j][vb.j];
  const i0 = i00 + (i01 - i00) * vb.t;
  const i1 = i10 + (i11 - i10) * vb.t;
  return (i0 + (i1 - i0) * pb.t) * (ies.multiplier == null ? 1 : ies.multiplier);
}
function phIntegratedLumens(ies) {
  const parsed = ies.vertical ? ies : phParseIES(ies);
  if (parsed.photoType !== 1) return null;
  const V = parsed.vertical;
  const cols = phExpandHorizontal(parsed);
  let flux = 0;
  for (let h = 0; h < cols.horizontal.length - 1; h++) {
    const dPsi = (cols.horizontal[h + 1] - cols.horizontal[h]) * Math.PI / 180;
    for (let v = 0; v < V.length - 1; v++) {
      const th1 = V[v] * Math.PI / 180, th2 = V[v + 1] * Math.PI / 180;
      const I = 0.25 * (cols.candela[h][v] + cols.candela[h][v + 1] + cols.candela[h + 1][v] + cols.candela[h + 1][v + 1]) * (parsed.multiplier || 1);
      flux += I * dPsi * (Math.cos(th1) - Math.cos(th2));
    }
  }
  return flux;
}
function phExpandHorizontal(ies) {
  const H = ies.horizontal, last = H[H.length - 1];
  if (H.length === 1 || last <= 0.01) {
    return { horizontal: [0, 360], candela: [ies.candela[0], ies.candela[0]] };
  }
  const map = {};
  function put(angle, col) { const k = Math.round(angle * 1000) / 1000; map[k] = col; }
  for (let i = 0; i < H.length; i++) put(H[i], ies.candela[i]);
  if (last <= 90.01) {
    Object.keys(map).forEach(function (k) {
      const a = +k;
      put(180 - a, map[k]);
      put(180 + a, map[k]);
      put(360 - a, map[k]);
    });
  } else if (last <= 180.01) {
    Object.keys(map).forEach(function (k) { put(360 - (+k), map[k]); });
  }
  put(360, map[0]);
  const angles = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
  return { horizontal: angles, candela: angles.map(function (a) { return map[Math.round(a * 1000) / 1000]; }) };
}

// Photometric direction of the point, in the fixture frame.
// orientation: degrees clockwise from +y (north) that the 0° plane faces.
// tilt: degrees the nadir is tipped toward that 0° plane. Zero aims straight down.
// psi increases counterclockwise from the 0° plane when looking along the beam.
function phDirection(fixture, x, y, zPlane) {
  const dx = x - fixture.x, dy = y - fixture.y, dz = zPlane - fixture.z;
  const bearing = (fixture.orientation || 0) * Math.PI / 180;
  const tilt = (fixture.tilt || 0) * Math.PI / 180;
  const fwd = dx * Math.sin(bearing) + dy * Math.cos(bearing);
  const right = dx * Math.cos(bearing) - dy * Math.sin(bearing);
  const up = dz;
  const Ax = Math.sin(tilt), Ay = 0, Az = -Math.cos(tilt);
  let xx = 1 - Ax * Ax, xy = -Ay * Ax, xz = -Az * Ax;
  let xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-8) { xx = -Ax * Az; xy = -Ay * Az; xz = 1 - Az * Az; xl = Math.hypot(xx, xy, xz); }
  xx /= xl; xy /= xl; xz /= xl;
  const yx = Ay * xz - Az * xy, yy = Az * xx - Ax * xz, yz = Ax * xy - Ay * xx;
  const along = fwd * Ax + right * Ay + up * Az;
  const a0 = fwd * xx + right * xy + up * xz;
  const acc = fwd * yx + right * yy + up * yz;
  const theta = Math.atan2(Math.hypot(a0, acc), along) * 180 / Math.PI;
  let psi = Math.atan2(acc, a0) * 180 / Math.PI;
  if (psi < 0) psi += 360;
  return { theta: theta, psi: psi, dist: Math.hypot(dx, dy, dz), h: -dz };
}

// Illuminance on a horizontal plane. Footcandles when coordinates are feet, lux when metres.
function phIlluminance(fixture, x, y, zPlane) {
  const ies = fixture._ies || (fixture._ies = (fixture.ies && fixture.ies.vertical ? fixture.ies : phParseIES(fixture.ies || fixture.iesText)));
  const dir = phDirection(fixture, x, y, zPlane == null ? 0 : zPlane);
  if (!(dir.h > 0.05) || !(dir.dist > 0)) return 0;
  let I = phCandela(ies, dir.theta, dir.psi) * phTiltFactor(ies, fixture.tilt || 0);
  if (fixture.houseSide && dir.psi > 90 && dir.psi < 270) I = 0;
  const llf = fixture.llf != null ? fixture.llf : 1;
  return I * dir.h / (dir.dist * dir.dist * dir.dist) * llf;
}

// ---- synthetic files ----------------------------------------------------------
// I(θ) = 10000 cos²θ from nadir to 90°. Axial symmetry, full cutoff.
// Rated lumens equal the closed-form integral 2π·10000/3, rounded.
// Watts are a round synthetic number. This is not the Compass LP1 file
// (15,357 lm, 120.7 W); that comparison needs the manufacturer's IES.

function phSyntheticFullCutoffIES() {
  const ang = [], cd = [];
  for (let t = 0; t <= 90; t += 5) {
    ang.push(String(t));
    cd.push((10000 * Math.cos(t * Math.PI / 180) * Math.cos(t * Math.PI / 180)).toFixed(2));
  }
  return [
    'IESNA:LM-63-2002',
    '[TEST] SYNTHETIC — not manufacturer photometry. Public-domain test file.',
    '[MANUFAC] Edifice screening library',
    '[LUMCAT] SYN-FC-10000',
    '[LUMINAIRE] Synthetic full-cutoff area light, rotationally symmetric, I = 10000 cos^2(theta)',
    '[OTHER] Generated for unit tests. Not a measured photometric file and not a Compass LP1.',
    'TILT=NONE',
    '1 20944 1.0 19 1 1 1 0.5 0.5 0.1',
    '1.0 1.0 150',
    ang.join(' '),
    '0',
    cd.join(' ')
  ].join('\n') + '\n';
}
function phSyntheticForwardIES() {
  return [
    'IESNA:LM-63-2002',
    '[TEST] SYNTHETIC asymmetric forward throw. Public-domain test file.',
    '[MANUFAC] Edifice screening library',
    '[LUMCAT] SYN-FWD',
    '[LUMINAIRE] Synthetic quadrant-symmetric forward throw for parser tests',
    '[OTHER] Not a measured photometric file.',
    'TILT=NONE',
    '1 10000 1.0 3 3 1 1 0.5 0.5 0.1',
    '1.0 1.0 100',
    '0 45 90',
    '0 45 90',
    '8000 6000 0',
    '8000 3000 0',
    '8000 1000 0'
  ].join('\n') + '\n';
}
function phDefaultFixture(over) {
  over = over || {};
  const ies = over.ies || phSyntheticFullCutoffIES();
  const parsed = ies.vertical ? ies : phParseIES(ies);
  return {
    id: over.id || 'lp1',
    label: over.label || 'LP1',
    symbol: over.symbol || 'LP1',
    arrangement: over.arrangement || 'pole, full cutoff',
    x: over.x || 0, y: over.y || 0,
    z: over.z != null ? over.z : (over.mountingHeight != null ? over.mountingHeight : 30),
    mountingHeight: over.mountingHeight != null ? over.mountingHeight : (over.z != null ? over.z : 30),
    llf: over.llf != null ? over.llf : 0.85,
    orientation: over.orientation || 0,
    tilt: over.tilt || 0,
    watts: over.watts != null ? over.watts : parsed.inputWatts,
    lumens: over.lumens != null ? over.lumens : parsed.lumensRated,
    ies: ies,
    assumed: over.ies ? !!over.assumed : true,
    tag: over.ies ? (over.assumed ? 'ASSUMED' : 'INPUT') : 'ASSUMED',
    cite: over.cite || (over.ies ? '' : 'ASSUMED synthetic full-cutoff distribution, LLF 0.85 and a 30 ft pole. Not a manufacturer IES file.')
  };
}

// ---- grid, schedule, summary, property line ---------------------------------

function phCalc(input) {
  input = input || {};
  const units = input.units === 'm' ? 'm' : 'ft';
  const planeZ = input.planeZ != null ? input.planeZ : 0;
  const fixtures = (input.fixtures || []).map(function (f, i) { return phNormFixture(f, i); });
  const bounds = phBounds(input, fixtures);
  const spacing = input.grid && input.grid.spacing != null ? input.grid.spacing : (units === 'm' ? 3.048 : 10);
  const nx = Math.max(2, Math.floor((bounds.xmax - bounds.xmin) / spacing) + 1);
  const ny = Math.max(2, Math.floor((bounds.ymax - bounds.ymin) / spacing) + 1);
  const dx = nx > 1 ? (bounds.xmax - bounds.xmin) / (nx - 1) : spacing;
  const dy = ny > 1 ? (bounds.ymax - bounds.ymin) / (ny - 1) : spacing;
  if (nx * ny > 250000) throw new Error('photometric grid is ' + (nx * ny) + ' points; raise spacing or shrink the bounds');
  const values = new Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = bounds.xmin + i * dx, y = bounds.ymin + j * dy;
      let e = 0;
      for (let f = 0; f < fixtures.length; f++) e += phIlluminance(fixtures[f], x, y, planeZ);
      values[j * nx + i] = e;
    }
  }
  const unit = units === 'm' ? 'lx' : 'fc';
  const toFc = unit === 'fc' ? 1 : PH_FC_PER_LUX;
  const levels = (input.isolines || PH_ISOLINES_FC).map(function (fc) { return unit === 'fc' ? fc : fc / PH_FC_PER_LUX; });
  const groups = typeof isoLines === 'function' ? isoLines(values, nx, ny, bounds.xmin, bounds.ymin, dx, dy, levels) : [];
  const isolines = typeof isoFeatureCollection === 'function' ? isoFeatureCollection(groups, function (level) {
    const fc = unit === 'fc' ? level : level * PH_FC_PER_LUX;
    const key = PH_ISOLINES_FC.reduce(function (best, v) { return Math.abs(v - fc) < Math.abs(best - fc) ? v : best; }, PH_ISOLINES_FC[0]);
    return { level: round4(fc), unit: 'fc', raw: round4(level), color: PH_ISOLINE_COLOR[key] || '#333', label: PH_LABEL };
  }) : { type: 'FeatureCollection', features: [] };
  const areas = input.areas || [];
  const summary = [phSummarize('Grid', values, function () { return true; }, unit, bounds, nx, ny, dx, dy)].concat(areas.map(function (a) {
    return phSummarize(a.name || a.id || 'Area', values, function (x, y) { return phInRing(x, y, a.polygon); }, unit, bounds, nx, ny, dx, dy);
  }));
  const propertyLine = phPropertyLine(fixtures, input.propertyLine, planeZ, unit, toFc);
  return {
    label: PH_LABEL,
    method: 'IES LM-63 Type C direct component, E = I·h/d³·LLF',
    unit: unit,
    assumptions: phAssumptions(fixtures, input),
    schedule: phSchedule(fixtures),
    summary: summary,
    propertyLine: propertyLine,
    grid: { xmin: bounds.xmin, ymin: bounds.ymin, dx: dx, dy: dy, nx: nx, ny: ny, spacing: spacing, planeZ: planeZ, values: values.map(function (v) { return round4(v); }) },
    isolines: isolines,
    fixtures: fixtures.map(function (f) {
      return { id: f.id, label: f.label, symbol: f.symbol, x: f.x, y: f.y, z: f.z, mountingHeight: f.mountingHeight, llf: f.llf, orientation: f.orientation, tilt: f.tilt, watts: f.watts, lumens: f.lumens, assumed: f.assumed, tag: f.tag, cite: f.cite };
    }),
    notes: input.notes || []
  };
}
function round4(v) { return Math.round(v * 10000) / 10000; }
function phNormFixture(f, i) {
  const ies = f.ies || f.iesText || phSyntheticFullCutoffIES();
  const parsed = ies.vertical ? ies : phParseIES(ies);
  const z = f.z != null ? f.z : (f.mountingHeight != null ? f.mountingHeight : 30);
  const ownIes = !!(f.ies || f.iesText);
  return {
    id: f.id || ('f' + (i + 1)),
    label: f.label || 'LP1',
    symbol: f.symbol || f.label || 'LP1',
    arrangement: f.arrangement || 'pole, full cutoff',
    x: f.x, y: f.y, z: z,
    mountingHeight: f.mountingHeight != null ? f.mountingHeight : z,
    llf: f.llf != null ? f.llf : 0.85,
    orientation: f.orientation || 0,
    tilt: f.tilt || 0,
    houseSide: !!f.houseSide,
    watts: f.watts != null ? f.watts : parsed.inputWatts,
    lumens: f.lumens != null ? f.lumens : parsed.lumensRated,
    ies: parsed,
    assumed: f.assumed != null ? !!f.assumed : !ownIes,
    tag: f.tag || ((f.assumed != null ? f.assumed : !ownIes) ? 'ASSUMED' : 'INPUT'),
    cite: f.cite || ''
  };
}
function phBounds(input, fixtures) {
  if (input.grid && input.grid.xmin != null) return { xmin: input.grid.xmin, ymin: input.grid.ymin, xmax: input.grid.xmax, ymax: input.grid.ymax };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  function add(x, y) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  fixtures.forEach(function (f) { add(f.x, f.y); });
  (input.areas || []).forEach(function (a) { (a.polygon || []).forEach(function (p) { add(p[0], p[1]); }); });
  const ring = input.propertyLine && (input.propertyLine.ring || input.propertyLine);
  if (Array.isArray(ring) && ring.length && Array.isArray(ring[0])) ring.forEach(function (p) { add(p[0], p[1]); });
  if (!isFinite(x0)) { x0 = -50; y0 = -50; x1 = 50; y1 = 50; }
  const pad = input.units === 'm' ? 15 : 50;
  return { xmin: x0 - pad, ymin: y0 - pad, xmax: x1 + pad, ymax: y1 + pad };
}
function phInRing(x, y, ring) {
  if (!ring || ring.length < 3) return false;
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (ring[j][0] - ring[i][0]) * (y - yi) / (yj - yi) + ring[i][0]) c = !c;
  }
  return c;
}
function phSummarize(name, values, mask, unit, bounds, nx, ny, dx, dy) {
  let n = 0, sum = 0, max = -Infinity, min = Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = bounds.xmin + i * dx, y = bounds.ymin + j * dy;
      if (mask && !mask(x, y)) continue;
      const v = values[j * nx + i];
      if (v == null || !isFinite(v)) continue;
      n++; sum += v;
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  if (!n) return { area: name, n: 0, avg: null, max: null, min: null, avgMin: null, maxMin: null, unit: unit, note: 'no grid points inside' };
  const avg = sum / n;
  const usable = min > 0.01;
  return {
    area: name, n: n, unit: unit,
    avg: round4(avg), max: round4(max), min: round4(min),
    avgMin: usable ? round4(avg / min) : null,
    maxMin: usable ? round4(max / min) : null,
    note: usable ? '' : 'min is at or near zero; avg/min and max/min are not meaningful'
  };
}
function phSchedule(fixtures) {
  const groups = new Map();
  fixtures.forEach(function (f) {
    const key = [f.label, f.symbol, f.arrangement, f.llf, f.lumens, f.watts, f.mountingHeight, f.tag].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { symbol: f.symbol, qty: 0, label: f.label, arrangement: f.arrangement, llf: f.llf, lumens: f.lumens, watts: f.watts, mountingHeight: f.mountingHeight, assumed: f.assumed, tag: f.tag };
      groups.set(key, g);
    }
    g.qty++;
  });
  return Array.from(groups.values());
}
function phPropertyLine(fixtures, spec, planeZ, unit, toFc) {
  if (!spec) return null;
  const ring = spec.ring || spec;
  if (!ring || ring.length < 2) return null;
  const spacing = spec.spacing || (unit === 'fc' ? 10 : 3.048);
  const samples = phSampleRing(ring, spacing);
  let max = -Infinity, at = null;
  for (let i = 0; i < samples.length; i++) {
    let e = 0;
    for (let f = 0; f < fixtures.length; f++) e += phIlluminance(fixtures[f], samples[i][0], samples[i][1], planeZ);
    if (e > max) { max = e; at = samples[i]; }
  }
  const maxFc = max * toFc;
  const limitFc = spec.limitFc != null ? +spec.limitFc : null;
  return {
    maxFc: round4(maxFc),
    max: round4(max),
    unit: unit,
    limitFc: limitFc,
    limitTag: limitFc == null ? null : (spec.limitTag || 'TBD (source)'),
    limitNote: spec.limitNote || (limitFc == null ? 'TBD (limit)' : ''),
    pass: limitFc == null || max == null ? null : maxFc <= limitFc + 1e-9,
    at: at ? { x: round4(at[0]), y: round4(at[1]) } : null,
    samples: samples.length,
    label: PH_LABEL
  };
}
function phSampleRing(ring, spacing) {
  const pts = [];
  const n = ring.length && (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / spacing));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return pts;
}
function phAssumptions(fixtures, input) {
  const rows = [];
  const seen = {};
  fixtures.forEach(function (f) {
    if (!f.assumed || seen[f.label]) return;
    seen[f.label] = 1;
    rows.push({ tag: 'ASSUMED', item: f.label + ' fixture', value: f.lumens + ' lm, ' + f.watts + ' W, LLF ' + f.llf + ', ' + f.mountingHeight + ' mounting', note: f.cite || 'Default fixture. Replace with the lighting designer\'s IES file and pole height.' });
  });
  if (!input.propertyLine || input.propertyLine.limitFc == null) rows.push({ tag: 'TBD', item: 'Property-line limit', value: null, note: 'No footcandle limit was supplied. The maximum is reported and the pass/fail is left open.' });
  rows.push({ tag: 'METHOD', item: 'Calculation', value: 'direct component only', note: 'No interreflected light. Outdoor screening, not a sealed photometric study.' });
  return rows;
}

// Poles along each path. Spacing defaults to 4 × mounting height, the usual
// full-cutoff starting point, and is tagged ASSUMED when the caller does not set it.
function phAutoPoles(paths, opt) {
  opt = opt || {};
  const height = opt.mountingHeight != null ? opt.mountingHeight : 30;
  const spacingAssumed = opt.spacing == null;
  const spacing = opt.spacing != null ? opt.spacing : 4 * height;
  const fixtures = [];
  (paths || []).forEach(function (path, pi) {
    const line = path.line || path;
    let dist = 0;
    const segs = [];
    for (let i = 1; i < line.length; i++) {
      const len = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      segs.push({ a: line[i - 1], b: line[i], len: len, at: dist });
      dist += len;
    }
    if (!(dist > 0)) return;
    const places = [];
    if (dist < spacing) places.push(dist / 2);
    else for (let s = spacing / 2; s < dist - spacing / 8; s += spacing) places.push(s);
    places.forEach(function (s, k) {
      let seg = segs[0];
      for (let i = 0; i < segs.length; i++) if (s >= segs[i].at && s <= segs[i].at + segs[i].len + 1e-6) seg = segs[i];
      const t = seg.len ? (s - seg.at) / seg.len : 0;
      const x = seg.a[0] + (seg.b[0] - seg.a[0]) * t, y = seg.a[1] + (seg.b[1] - seg.a[1]) * t;
      const bearing = Math.atan2(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) * 180 / Math.PI;
      const f = phDefaultFixture(Object.assign({}, opt, {
        id: (opt.idPrefix || 'lp') + '-' + pi + '-' + k,
        x: x, y: y, z: height, mountingHeight: height,
        orientation: (bearing % 360 + 360) % 360,
        assumed: opt.ies ? !!opt.assumed : true
      }));
      f.spacingAssumed = spacingAssumed;
      fixtures.push(f);
    });
  });
  return fixtures;
}

// Yards, substation, parking and pond become calc areas. Poles follow each
// lit perimeter. The pond is included so a lagoon is not dropped from the summary.
// There is no gatehouse object in the layout solver; none is invented.
function phFromPlan(layout, opts) {
  opts = opts || {};
  const un = layout && layout.C && layout.C.un ? function (p) { return layout.C.un(p); } : function (p) { return p; };
  const areas = [], paths = [];
  (layout.halls || []).forEach(function (h, i) {
    if (!h.gen) return;
    const ring = phWorldRing(h.gen, un);
    areas.push({ id: 'yard' + (i + 1), name: 'Generator yard ' + (i + 1), polygon: ring });
    paths.push(ring.concat([ring[0]]));
  });
  if (layout.sub) {
    const ring = phWorldRing(layout.sub, un);
    areas.push({ id: 'sub', name: 'Substation', polygon: ring });
    paths.push(ring.concat([ring[0]]));
  }
  if (layout.park) {
    const ring = phWorldRing(layout.park, un);
    areas.push({ id: 'park', name: 'Parking', polygon: ring });
    paths.push(ring.concat([ring[0]]));
  }
  if (layout.pond) {
    const ring = phWorldRing(layout.pond, un);
    areas.push({ id: 'pond', name: 'Lagoon', polygon: ring });
    paths.push(ring.concat([ring[0]]));
  }
  let propertyRing = null;
  if (layout.C && layout.C.Q && layout.C.Q.length) propertyRing = layout.C.Q.map(function (p) { const q = un(p); return [q[0], q[1]]; });
  const fixtures = opts.fixtures || phAutoPoles(paths, { mountingHeight: opts.mountingHeight, spacing: opts.spacing, llf: opts.llf, label: opts.label || 'LP1' });
  return {
    units: 'ft',
    fixtures: fixtures,
    areas: areas,
    propertyLine: propertyRing ? { ring: propertyRing, limitFc: opts.limitFc != null ? opts.limitFc : null, limitTag: opts.limitTag || null, limitNote: opts.limitNote || '', spacing: opts.lineSpacing || 10 } : null,
    grid: opts.grid || null,
    planeZ: 0,
    notes: ['No gatehouse object is in the layout; none was added.', 'Drives are not a layout layer; poles follow yard, parking, substation and lagoon perimeters.', 'Pole spacing is 4 × mounting height unless overridden, tagged ASSUMED.']
  };
}
function phWorldRing(rect, un) {
  const x = rect[0], y = rect[1], w = rect[2], h = rect[3];
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(function (p) { const q = un(p); return [q[0], q[1]]; });
}

function phWorkerSource() {
  const head = [
    'const PH_LABEL=' + JSON.stringify(PH_LABEL),
    'const PH_ISOLINES_FC=' + JSON.stringify(PH_ISOLINES_FC),
    'const PH_ISOLINE_COLOR=' + JSON.stringify(PH_ISOLINE_COLOR),
    'const PH_FC_PER_LUX=' + PH_FC_PER_LUX,
    'const PH_FT=' + PH_FT
  ].join(';\n') + ';\n';
  const fns = [phParseIES, phNumbers, phCheckAngles, phTiltFactor, phPsiInFile, phBracket, phCandela, phIntegratedLumens, phExpandHorizontal, phDirection, phIlluminance, phSyntheticFullCutoffIES, phSyntheticForwardIES, phDefaultFixture, phCalc, round4, phNormFixture, phBounds, phInRing, phSummarize, phSchedule, phPropertyLine, phSampleRing, phAssumptions, phAutoPoles, phFromPlan, phWorldRing];
  const iso = (typeof isoLines === 'function') ? [isoLines, isoSegments, isoStitch, isoFeatureCollection, round6].map(function (f) { return f.toString(); }).join('\n') : '';
  return head + iso + '\n' + fns.map(function (f) { return f.toString(); }).join('\n') + '\nonmessage=function(ev){var m=ev.data||{};if(!m||m.type!=="calc")return;try{postMessage({type:"result",id:m.id,output:phCalc(m.input)})}catch(err){postMessage({type:"error",id:m.id,message:String(err&&err.message||err)})}};';
}
function phCalcAsync(input) {
  if (typeof Worker === 'undefined') return Promise.resolve(phCalc(input));
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(new Blob([phWorkerSource()], { type: 'text/javascript' }));
    const w = new Worker(url);
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(function () { w.terminate(); URL.revokeObjectURL(url); reject(new Error('photometric worker timeout')); }, 120000);
    w.onmessage = function (ev) {
      const m = ev.data || {};
      if (m.id !== id) return;
      clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url);
      if (m.type === 'error') reject(new Error(m.message));
      else resolve(m.output);
    };
    w.onerror = function (e) { clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url); reject(new Error(e.message || 'photometric worker failed')); };
    w.postMessage({ type: 'calc', id: id, input: input });
  });
}
