// IES LM-63 parser and outdoor point-by-point illuminance for Site Planning sheet E-001.
// Pure functions. Load after screening.js. Direct component only: E = I(θ,ψ) · cosβ / d² · LLF.
// Fixtures are assumed until a lighting designer supplies them. Results then carry the illustrative label.
const PH_LABEL = 'ILLUSTRATIVE — fixture selection assumed until a lighting designer picks fixtures';
const PH_LABEL_SUPPLIED = 'DIRECT PHOTOMETRIC CALCULATION — fixtures as supplied';
const PH_LUX_PER_FC = 10.7639104167;
const PH_FT = 0.3048;
const PH_ISO = [0.1, 0.5, 1, 2, 3, 5];
// Cited only when the caller selects them. Shawnee 2.0 fc is the figure quoted on the Compass note; Butler 0.1 fc is the draft figure in the sheet spec. Confirm the adopted text.
const PH_LIMITS = {
  shawnee: sgNum(2.0, 'Shawnee County lighting standard as cited for the CUP photometric note, 2.0 fc at the property line. Confirm the adopted text.', 'fc'),
  butler_draft: sgNum(0.1, 'Butler County draft lighting standard, 0.1 fc at the property line. Confirm the adopted text.', 'fc'),
  no_spillover: sgNum(0, 'Shawnee County Zoning Regulations Sec. 39.06(d), no spillover. A computed maximum of exactly 0 is not claimed from an assumed layout.', 'fc')
};

function phParseIes(text) {
  const lines = String(text).split(/\r?\n/);
  const kw = {};
  let i = 0, tilt = null;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const km = /^\[([A-Za-z0-9_]+)\]\s*(.*)$/.exec(line);
    if (km) { kw[km[1].toUpperCase()] = km[2]; continue; }
    if (/^IESNA/i.test(line)) continue;
    const tm = /^TILT\s*=\s*(.+)$/i.exec(line);
    if (tm) { tilt = tm[1].trim().toUpperCase(); i++; break; }
    throw new Error('IES: expected a keyword or TILT= before photometry');
  }
  if (!tilt) throw new Error('IES: missing TILT');
  if (tilt !== 'NONE' && tilt !== 'INCLUDE') throw new Error('IES: external TILT file is not embedded (' + tilt + ')');
  const nums = [];
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line[0] === '[') continue;
    const tok = line.split(/[\s,]+/);
    for (let k = 0; k < tok.length; k++) if (tok[k] !== '') {
      const n = Number(tok[k]);
      if (!isFinite(n)) throw new Error('IES: non-numeric photometry');
      nums.push(n);
    }
  }
  let tiltAngles = null, tiltFactors = null;
  if (tilt === 'INCLUDE') {
    if (nums.length < 2) throw new Error('IES: truncated TILT=INCLUDE block');
    const nt = nums[1];
    if (!(nt >= 1) || nums.length < 2 + 2 * nt) throw new Error('IES: truncated TILT=INCLUDE block');
    tiltAngles = nums.slice(2, 2 + nt);
    tiltFactors = nums.slice(2 + nt, 2 + 2 * nt);
    nums.splice(0, 2 + 2 * nt);
  }
  if (nums.length < 13) throw new Error('IES: header is short');
  const nLamps = nums[0], lumens = nums[1], mult = nums[2], nV = Math.round(nums[3]), nH = Math.round(nums[4]);
  const photo = Math.round(nums[5]), units = Math.round(nums[6]);
  const width = nums[7], length = nums[8], height = nums[9];
  const ballast = nums[10], watts = nums[12];
  if (photo !== 1) throw new Error('IES: photometric type ' + photo + ' is not implemented; supply a Type C file');
  if (!(nV >= 2) || !(nH >= 1)) throw new Error('IES: need at least two vertical angles');
  let p = 13;
  if (nums.length < p + nV + nH + nV * nH) throw new Error('IES: candela block is short');
  const vAng = nums.slice(p, p + nV); p += nV;
  const hAng = nums.slice(p, p + nH); p += nH;
  const cd = [];
  for (let h = 0; h < nH; h++) { cd.push(nums.slice(p, p + nV)); p += nV; }
  if (p !== nums.length) throw new Error('IES: ' + (nums.length - p) + ' extra numbers after the candela block');
  for (let k = 1; k < vAng.length; k++) if (vAng[k] < vAng[k - 1] - 1e-6) throw new Error('IES: vertical angles must increase');
  for (let k = 1; k < hAng.length; k++) if (hAng[k] < hAng[k - 1] - 1e-6) throw new Error('IES: horizontal angles must increase');
  return {
    keywords: kw, tilt: tilt, tiltAngles: tiltAngles, tiltFactors: tiltFactors,
    nLamps: nLamps, lumensPerLamp: lumens, multiplier: mult, photoType: photo, units: units,
    width: width, length: length, height: height, ballastFactor: ballast, watts: watts,
    vAng: vAng, hAng: hAng, cd: cd, absolute: lumens < 0
  };
}
function phFold(psi, maxA, nH) {
  if (nH <= 1) return 0;
  psi = ((psi % 360) + 360) % 360;
  if (maxA >= 360 - 1e-3) return psi;
  if (maxA <= 90 + 1e-6) {
    if (psi > 270) return 360 - psi;
    if (psi > 180) return psi - 180;
    if (psi > 90) return 180 - psi;
    return psi;
  }
  if (maxA <= 180 + 1e-6) return psi > 180 ? 360 - psi : psi;
  return psi;
}
function phBracket(arr, x) {
  if (x <= arr[0]) return {i: 0, j: 0, t: 0};
  if (x >= arr[arr.length - 1]) return {i: arr.length - 1, j: arr.length - 1, t: 0};
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m; else hi = m; }
  const span = arr[hi] - arr[lo];
  return {i: lo, j: hi, t: span ? (x - arr[lo]) / span : 0};
}
// Candela for one lamp times the candela multiplier, before lamp count and tilt factor.
function phCandela(ies, theta, psi) {
  const maxA = ies.hAng[ies.hAng.length - 1];
  const hp = ies.hAng.length === 1 ? {i: 0, j: 0, t: 0} : phBracket(ies.hAng, phFold(psi, maxA, ies.hAng.length));
  const vp = phBracket(ies.vAng, theta);
  const row = (h, v) => ies.cd[h][v];
  const a = row(hp.i, vp.i) * (1 - vp.t) + row(hp.i, vp.j) * vp.t;
  const b = row(hp.j, vp.i) * (1 - vp.t) + row(hp.j, vp.j) * vp.t;
  return (a * (1 - hp.t) + b * hp.t) * (ies.multiplier == null ? 1 : ies.multiplier);
}
function phTiltFactor(ies, tiltDeg) {
  if (!ies.tiltFactors) return 1;
  const b = phBracket(ies.tiltAngles, tiltDeg);
  return ies.tiltFactors[b.i] * (1 - b.t) + ies.tiltFactors[b.j] * b.t;
}
// Photometric axis: tilt 0 is nadir (0,0,-1). Azimuth 0 is north (+y), clockwise, in the direction of tilt and of ψ = 0.
function phBasis(azDeg, tiltDeg) {
  const az = (azDeg || 0) * Math.PI / 180, tilt = (tiltDeg || 0) * Math.PI / 180;
  const horiz = [Math.sin(az), Math.cos(az), 0];
  const nadir = [Math.sin(tilt) * horiz[0], Math.sin(tilt) * horiz[1], -Math.cos(tilt)];
  let r = horiz.slice();
  const dot = r[0] * nadir[0] + r[1] * nadir[1] + r[2] * nadir[2];
  r = [r[0] - dot * nadir[0], r[1] - dot * nadir[1], r[2] - dot * nadir[2]];
  let rl = Math.hypot(r[0], r[1], r[2]);
  if (rl < 1e-9) r = [0, 0, 1];
  else r = [r[0] / rl, r[1] / rl, r[2] / rl];
  const p = [nadir[1] * r[2] - nadir[2] * r[1], nadir[2] * r[0] - nadir[0] * r[2], nadir[0] * r[1] - nadir[1] * r[0]];
  return {nadir: nadir, r: r, p: p};
}
function phPrepare(fixture) {
  if (fixture._ies) return fixture._ies;
  const ies = fixture.ies && fixture.ies.cd ? fixture.ies : phParseIes(fixture.ies || fixture.iesText);
  fixture._ies = ies;
  fixture._basis = phBasis(fixture.azimuth || 0, fixture.tilt || 0);
  return ies;
}
// Horizontal illuminance at a point. Coordinates are in opts.units ('m' default, or 'ft'). z defaults to 0.
function phPoint(fixture, x, y, z, opts) {
  opts = opts || {};
  const units = opts.units || fixture.units || 'm';
  const k = units === 'ft' ? PH_FT : 1;
  const ies = phPrepare(fixture);
  const fz = fixture.z != null ? fixture.z : (fixture.h != null ? (opts.planeZ || 0) + sgV(fixture.h) : null);
  if (fz == null) throw new Error('fixture needs h or z');
  const dx = (x - fixture.x) * k, dy = (y - fixture.y) * k, dz = ((z == null ? (opts.planeZ || 0) : z) - fz) * k;
  const d = Math.hypot(dx, dy, dz);
  const B = fixture._basis;
  const cosT = d > 1e-9 ? (dx * B.nadir[0] + dy * B.nadir[1] + dz * B.nadir[2]) / d : 1;
  const theta = Math.acos(Math.max(-1, Math.min(1, cosT))) * 180 / Math.PI;
  const dr = dx * B.r[0] + dy * B.r[1] + dz * B.r[2];
  const dp = dx * B.p[0] + dy * B.p[1] + dz * B.p[2];
  let psi = Math.atan2(dp, dr) * 180 / Math.PI;
  if (psi < 0) psi += 360;
  const lamps = ies.absolute ? 1 : (ies.nLamps || 1);
  const I = phCandela(ies, theta, psi) * lamps * phTiltFactor(ies, fixture.tilt || 0);
  const llf = fixture.llf != null ? sgV(fixture.llf) : 0.85;
  const cosB = d > 1e-9 ? (-dz) / d : 0;
  const lux = cosB > 0 && d > 1e-6 ? I * cosB / (d * d) * llf : 0;
  const llfSrc = fixture.llf != null ? (fixture.llfSrc || 'caller') : 'assumed';
  return {
    lux: sgNum(lux, 'computed', 'lx'),
    fc: sgNum(lux / PH_LUX_PER_FC, 'computed', 'fc'),
    I: sgNum(I, fixture.assumed ? 'assumed' : 'IES file', 'cd'),
    theta: sgNum(theta, 'computed', 'deg'),
    psi: sgNum(psi, 'computed', 'deg'),
    d: sgNum(d, 'computed', 'm'),
    llf: sgNum(llf, llfSrc, 'fraction', llfSrc === 'assumed' ? 'light loss factor 0.85' : undefined),
    cosB: sgNum(Math.max(0, cosB), 'computed', 'fraction')
  };
}
function phLattice(bounds, step) {
  const x0 = sgV(bounds.x0), y0 = sgV(bounds.y0), x1 = sgV(bounds.x1), y1 = sgV(bounds.y1);
  const nx = Math.floor((x1 - x0) / step + 1e-9) + 1;
  const ny = Math.floor((y1 - y0) / step + 1e-9) + 1;
  return {x0: x0, y0: y0, step: step, nx: nx, ny: ny};
}
function phGrid(fixtures, bounds, opts) {
  opts = opts || {};
  const units = opts.units || 'ft';
  const step = opts.step != null ? sgV(opts.step) : (units === 'm' ? 10 * PH_FT : 10);
  const stepSrc = opts.step != null ? (opts.stepSrc || 'caller') : 'method';
  const lat = phLattice(bounds, step);
  const values = new Array(lat.nx * lat.ny);
  const prepared = fixtures.map(f => { phPrepare(f); return f; });
  for (let j = 0; j < lat.ny; j++) for (let i = 0; i < lat.nx; i++) {
    const x = lat.x0 + i * step, y = lat.y0 + j * step;
    let lux = 0;
    for (let k = 0; k < prepared.length; k++) lux += phPoint(prepared[k], x, y, opts.planeZ || 0, opts).lux.v;
    values[j * lat.nx + i] = lux / PH_LUX_PER_FC;
  }
  return {
    src: 'computed', nx: lat.nx, ny: lat.ny,
    x0: sgNum(lat.x0, 'caller', units), y0: sgNum(lat.y0, 'caller', units),
    dx: sgNum(step, stepSrc, units, stepSrc === 'method' ? '10 ft calculation grid' : undefined),
    dy: sgNum(step, stepSrc, units),
    values: values, planeZ: sgNum(opts.planeZ || 0, 'method', units, 'horizontal calculation plane')
  };
}
function phIsolines(grid, levels) {
  levels = levels || PH_ISO;
  const raw = sgMarch(grid.values, grid.nx, grid.ny, sgV(grid.x0), sgV(grid.y0), sgV(grid.dx), sgV(grid.dy), levels);
  return {
    src: 'computed',
    levels: raw.map(s => ({geom: true, level: sgNum(s.level, 'method', 'fc', 'isolux level'), segs: s.segs, lines: sgStitch(s.segs, Math.max(sgV(grid.dx), sgV(grid.dy)) * 0.05)}))
  };
}
function phStats(vals) {
  if (!vals.length) return {n: sgNum(0, 'computed', 'count'), avg: sgNum(null, 'TBD', 'fc', 'no points in the area'), max: sgNum(null, 'TBD', 'fc'), min: sgNum(null, 'TBD', 'fc'), avgMin: sgNum(null, 'TBD', 'ratio', 'no points'), maxMin: sgNum(null, 'TBD', 'ratio')};
  let s = 0, mx = -Infinity, mn = Infinity;
  for (let i = 0; i < vals.length; i++) { s += vals[i]; if (vals[i] > mx) mx = vals[i]; if (vals[i] < mn) mn = vals[i]; }
  const avg = s / vals.length;
  const ratio = (name) => mn > 1e-6 ? sgNum((name === 'avg' ? avg : mx) / mn, 'computed', 'ratio') : sgNum(null, 'TBD', 'ratio', 'minimum is zero');
  return {
    n: sgNum(vals.length, 'computed', 'count'),
    avg: sgNum(avg, 'computed', 'fc'), max: sgNum(mx, 'computed', 'fc'), min: sgNum(mn, 'computed', 'fc'),
    avgMin: ratio('avg'), maxMin: ratio('max')
  };
}
function phSummary(grid, areas) {
  const x0 = sgV(grid.x0), y0 = sgV(grid.y0), dx = sgV(grid.dx), dy = sgV(grid.dy);
  return (areas || []).map(a => {
    const vals = [];
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      const x = x0 + i * dx, y = y0 + j * dy;
      if (sgIn(x, y, a.ring)) vals.push(grid.values[j * grid.nx + i]);
    }
    return {id: a.id, kind: a.kind || a.id, stats: phStats(vals)};
  });
}
function phBoundary(fixtures, ring, opts) {
  opts = opts || {};
  const units = opts.units || 'ft';
  const step = opts.step != null ? sgV(opts.step) : (units === 'm' ? 10 * PH_FT : 10);
  const P = sgOpen(ring);
  let max = -Infinity, at = null, n = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < m; k++) {
      const t = k / m, x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1]);
      let lux = 0;
      for (let f = 0; f < fixtures.length; f++) lux += phPoint(fixtures[f], x, y, opts.planeZ || 0, opts).lux.v;
      const fc = lux / PH_LUX_PER_FC;
      n++;
      if (fc > max) { max = fc; at = {x: x, y: y}; }
    }
  }
  const limit = opts.limit || null;
  const margin = limit && limit.v != null && isFinite(max) ? sgNum(limit.v - max, 'computed', 'fc', 'positive means under the limit') : sgNum(null, 'TBD', 'fc', 'no property-line limit supplied');
  return {
    max: sgNum(isFinite(max) ? max : null, 'computed', 'fc'),
    at: at ? {geom: true, x: at.x, y: at.y} : null,
    samples: sgNum(n, 'computed', 'count'),
    step: sgNum(step, opts.step != null ? (opts.stepSrc || 'caller') : 'method', units),
    limit: limit || sgNum(null, 'TBD', 'fc', 'no property-line limit supplied'),
    margin: margin,
    pass: limit && limit.v != null && isFinite(max) ? max <= limit.v + 1e-9 : null
  };
}
function phSchedule(fixtures, opts) {
  opts = opts || {};
  const units = opts.units || 'ft';
  const groups = new Map();
  for (const f of fixtures) {
    const key = f.label || f.id || 'LP';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const rows = [];
  for (const [label, list] of groups) {
    const f = list[0];
    const ies = phPrepare(f);
    const assumed = list.some(g => g.assumed !== false);
    const src = assumed ? 'assumed' : (f.source || 'IES file');
    const llf = f.llf != null ? sgV(f.llf) : 0.85;
    const lumens = ies.absolute ? null : (ies.nLamps || 1) * ies.lumensPerLamp;
    rows.push({
      symbol: f.symbol || label,
      label: label,
      qty: sgNum(list.length, 'computed', 'count'),
      arrangement: f.arrangement || 'single',
      llf: sgNum(llf, f.llf != null ? (f.llfSrc || src) : 'assumed', 'fraction', f.llf == null ? 'light loss factor 0.85' : undefined),
      lumens: lumens == null ? sgNum(null, 'TBD', 'lm', 'absolute photometry; lamp lumens not stated in the file') : sgNum(lumens, src, 'lm'),
      watts: ies.watts == null ? sgNum(null, 'TBD', 'W') : sgNum(ies.watts, src, 'W'),
      mount: sgNum(sgV(f.h), src, units),
      ballast: sgNum(ies.ballastFactor, 'IES file', 'fraction', 'reported from the file and not applied again; include ballast in LLF for relative photometry'),
      assumed: assumed
    });
  }
  return rows;
}
// Poles along polylines. Spacing defaults to 4 × mounting height, flagged assumed. First pole is inset half a space.
function phAutoPoles(opts) {
  opts = opts || {};
  const units = opts.units || 'ft';
  const mount = sgV(opts.mount);
  const factor = opts.spacingFactor != null ? opts.spacingFactor : 4;
  const spacing = opts.spacing != null ? sgV(opts.spacing) : mount * factor;
  const spacingSrc = opts.spacing != null ? (opts.spacingSrc || 'caller') : 'assumed';
  const poles = [];
  const lines = opts.lines || [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let run = 0;
    const seg = [];
    for (let i = 1; i < line.length; i++) {
      const L = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      seg.push(L); run += L;
    }
    if (!(run > 0) || !(spacing > 0)) continue;
    for (let s = spacing / 2; s < run - 1e-6; s += spacing) {
      let acc = 0;
      for (let i = 0; i < seg.length; i++) {
        if (acc + seg[i] >= s) {
          const t = (s - acc) / seg[i];
          poles.push({x: line[i][0] + t * (line[i + 1][0] - line[i][0]), y: line[i][1] + t * (line[i + 1][1] - line[i][1])});
          break;
        }
        acc += seg[i];
      }
    }
  }
  return {
    poles: poles.map((p, i) => Object.assign({id: 'LP' + (i + 1), label: opts.label || 'LP1', h: mount, assumed: true, llf: opts.llf != null ? opts.llf : 0.85, ies: opts.ies || phGenericIes()}, p)),
    spacing: sgNum(spacing, spacingSrc, units, spacingSrc === 'assumed' ? 'spacing = ' + factor + ' × mounting height' : undefined),
    mount: sgNum(mount, opts.mountSrc || 'assumed', units),
    count: sgNum(poles.length, 'computed', 'count')
  };
}
// Synthetic full-cutoff area light. I(θ) = I0 cos³θ for θ ≤ 90°, else 0. Not a manufacturer file.
function phGenericIes() {
  const I0 = 15000 * 2 / Math.PI;
  const v = [];
  for (let a = 0; a <= 90; a += 5) v.push(a);
  const cd = v.map(a => a >= 90 ? 0 : I0 * Math.pow(Math.cos(a * Math.PI / 180), 3));
  const fmt = n => (Math.round(n * 100) / 100).toString();
  const lines = [
    'IESNA:LM-63-2002',
    '[TEST] EDIFICE SYNTHETIC FULL CUTOFF',
    '[MANUFAC] EDIFICE SYNTHETIC — NOT A MANUFACTURER FILE',
    '[LUMCAT] GENERIC-COS3',
    'TILT=NONE',
    '1 15000 1 ' + v.length + ' 1 1 2 0 0 0',
    '1 1 120',
    v.join(' '),
    '0',
    cd.map(fmt).join(' ')
  ];
  return lines.join('\n');
}
// Numerical flux of a rotationally symmetric Type C file, trapezoid on θ. For the synthetic file check.
function phFlux(ies) {
  if (ies.hAng.length !== 1) return null;
  const th = ies.vAng.map(a => a * Math.PI / 180);
  let s = 0;
  for (let i = 1; i < th.length; i++) {
    const a = ies.cd[0][i - 1] * Math.sin(th[i - 1]), b = ies.cd[0][i] * Math.sin(th[i]);
    s += 0.5 * (a + b) * (th[i] - th[i - 1]);
  }
  return 2 * Math.PI * s * (ies.multiplier || 1) * (ies.absolute ? 1 : (ies.nLamps || 1));
}
function phRun(job) {
  job = job || {};
  const opts = {units: job.units || 'ft', planeZ: job.planeZ || 0, step: job.step, stepSrc: job.stepSrc};
  const fixtures = job.fixtures || [];
  fixtures.forEach(phPrepare);
  const illustrative = fixtures.length === 0 || fixtures.some(f => f.assumed !== false);
  const grid = job.bounds ? phGrid(fixtures, job.bounds, opts) : null;
  const areas = grid && job.areas ? phSummary(grid, job.areas) : [];
  const boundary = job.boundary ? phBoundary(fixtures, job.boundary, Object.assign({}, opts, {limit: job.limit, step: job.boundaryStep})) : null;
  return {
    label: illustrative ? PH_LABEL : PH_LABEL_SUPPLIED,
    illustrative: illustrative,
    method: {v: 'direct', src: 'method', note: 'Horizontal illuminance, direct component only. Reflected light is not included.'},
    units: opts.units,
    schedule: phSchedule(fixtures, opts),
    grid: grid,
    isolines: grid ? phIsolines(grid, job.levels) : null,
    summary: areas,
    propertyLine: boundary,
    assumptions: illustrative ? [{item: 'fixtures', src: 'assumed', note: 'Pole type, photometry and placement are assumptions until a lighting designer selects them. Do not report a 0 fc property line from this layout.'}] : [{item: 'fixtures', src: 'caller', note: 'Photometry and placement supplied by the caller.'}]
  };
}
function phHandle(msg) {
  if (!msg || msg.type !== 'run') return {type: 'error', message: 'expected {type:"run", job}'};
  try { return {type: 'result', result: phRun(msg.job)}; }
  catch (e) { return {type: 'error', message: String(e && e.message || e)}; }
}
