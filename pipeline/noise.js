// ISO 9613-2 octave-band screening model for Site Planning sheet NZ-101.
// Pure functions. Load after screening.js. Not a sound study.
// Downwind / favourable propagation, as ISO 9613-2 assumes. Equipment sound power in the
// catalog is assumed and flagged. Ambient is TBD unless a measurement is passed in.
// Output label, unless a consultant grid is imported: "EDIFICE SCREENING MODEL — NOT A SOUND STUDY".
const NZ_F = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
const NZ_LABEL = 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY';
const NZ_T0 = 293.15, NZ_T01 = 273.16, NZ_PR = 101.325;
const NZ_SCENARIOS = [
  ['typical', 'day'], ['typical', 'night'],
  ['maintenance', 'day'], ['maintenance', 'night'],
  ['emergency', 'day'], ['emergency', 'night']
];
// 5 dB bands, quiet green through loud purple. Display convention, not a measurement.
const NZ_LEGEND = [
  {max: sgNum(45, 'method', 'dBA', '5 dB band edge'), label: '≤45', color: '#1b5e20'},
  {max: sgNum(50, 'method', 'dBA', '5 dB band edge'), label: '45–50', color: '#7cb342'},
  {max: sgNum(55, 'method', 'dBA', '5 dB band edge'), label: '50–55', color: '#c0ca33'},
  {max: sgNum(60, 'method', 'dBA', '5 dB band edge'), label: '55–60', color: '#fdd835'},
  {max: sgNum(65, 'method', 'dBA', '5 dB band edge'), label: '60–65', color: '#ffb300'},
  {max: sgNum(70, 'method', 'dBA', '5 dB band edge'), label: '65–70', color: '#f4511e'},
  {max: sgNum(75, 'method', 'dBA', '5 dB band edge'), label: '70–75', color: '#c62828'},
  {max: sgNum(null, 'method', 'dBA', 'open upper band'), label: '>75', color: '#6a1b9a'}
];
const NZ_EPA = sgNum(55, 'EPA 1974 550/9-74-004, 55 dBA Ldn guideline (information only)', 'dBA');

// IEC 61672-1 A- and C-weighting, dB, normalized to 0 dB at 1 kHz.
function nzAweightDb(f) {
  const f2 = f * f, f4 = f2 * f2, c = 12194 * 12194;
  const den = (f2 + 424.36) * Math.sqrt((f2 + 11599.29) * (f2 + 544496.41)) * (f2 + 148693636);
  const ra = c * f4 / den;
  const r1 = c * 1e12 / ((1e6 + 424.36) * Math.sqrt((1e6 + 11599.29) * (1e6 + 544496.41)) * (1e6 + 148693636));
  return 20 * Math.log10(ra) - 20 * Math.log10(r1);
}
function nzCweightDb(f) {
  const f2 = f * f, c = 12194 * 12194;
  const rc = c * f2 / ((f2 + 424.36) * (f2 + 148693636));
  const r1 = c * 1e6 / ((1e6 + 424.36) * (1e6 + 148693636));
  return 20 * Math.log10(rc) - 20 * Math.log10(r1);
}
// ISO 9613-1 atmospheric absorption, dB/m. T kelvin, hr percent, pa kPa.
function nzAlpha(f, T, hr, pa) {
  const pr = NZ_PR, T0 = NZ_T0, T01 = NZ_T01;
  const ps = Math.pow(10, -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151);
  const h = hr * ps * (pr / pa);
  const papr = pa / pr;
  const frO = papr * (24 + 40400 * h * (0.02 + h) / (0.391 + h));
  const frN = papr * Math.pow(T / T0, -0.5) * (9 + 280 * h * Math.exp(-4.17 * (Math.pow(T / T0, -1 / 3) - 1)));
  const f2 = f * f;
  const term = 1.84e-11 * (1 / papr) * Math.sqrt(T / T0)
    + Math.pow(T / T0, -2.5) * (0.01275 * Math.exp(-2239.1 / T) / (frO + f2 / frO) + 0.1068 * Math.exp(-3352 / T) / (frN + f2 / frN));
  return 8.686 * f2 * term;
}
function nzSpeed(T) { return 343.2 * Math.sqrt(T / NZ_T0); }
// ISO 9613-2 §7.3.1 general method. G is a number, or {s, r, m}. Frequency-independent.
function nzAgr(hs, hr, dp, G) {
  const g = typeof G === 'number' ? {s: G, r: G, m: G} : {s: sgV(G.s), r: sgV(G.r), m: sgV(G.m)};
  const ap = h => 1.5 + 3 * Math.exp(-0.12 * (h - 5) * (h - 5)) * (1 - Math.exp(-dp / 50)) + 5.7 * Math.exp(-0.09 * h * h) * (1 - Math.exp(-2.8e-6 * dp * dp));
  const q = dp <= 30 * (hs + hr) ? 0 : 1 - 30 * (hs + hr) / dp;
  const As = -1.5 + g.s * ap(hs), Ar = -1.5 + g.r * ap(hr), Am = -3 * q * (1 - g.m);
  return {Agr: As + Ar + Am, As: As, Ar: Ar, Am: Am, q: q};
}
// ISO 9613-2 barrier Dz (eq. 14). C2 = 20. Cap 20 dB single / 25 dB double. z <= 0 → 0.
function nzC3(lambda, e) {
  const r = 5 * lambda / e, r2 = r * r;
  return (1 + r2) / (1 / 3 + r2);
}
function nzDz(z, dss, dsr, d, lambda, C3, cap) {
  if (!(z > 0) || !(lambda > 0)) return 0;
  const kmet = Math.exp(-Math.sqrt(dss * dsr * d / (2 * z)) / 2000);
  let Dz = 10 * Math.log10(3 + (20 / lambda) * C3 * z * kmet);
  if (Dz > cap) Dz = cap;
  return Dz;
}
// The path-length difference dss+dsr-d is positive on both sides of the ray. Only an edge
// above the straight ray (parameter t strictly between the ends) is a barrier.
function nzAbove(S, R, E) {
  const dx = R.x - S.x, dy = R.y - S.y, L2 = dx * dx + dy * dy;
  if (L2 < 1e-8) return false;
  const t = ((E.x - S.x) * dx + (E.y - S.y) * dy) / L2;
  if (t <= 1e-3 || t >= 1 - 1e-3) return false;
  return E.z > S.z + t * (R.z - S.z) + 1e-4;
}
function nzCandSingle(S, R, E, kind) {
  const d = sgDist3(S, R), dss = sgDist3(S, E), dsr = sgDist3(E, R);
  return {kind: kind, mode: 'single', z: dss + dsr - d, dss: dss, dsr: dsr, d: d, e: 0, cap: 20};
}
function nzCandDouble(S, R, e1, e2, kind) {
  const d = sgDist3(S, R), dss = sgDist3(S, e1), dsr = sgDist3(e2, R), e = sgDist3(e1, e2);
  return {kind: kind, mode: 'double', z: dss + e + dsr - d, dss: dss, dsr: dsr, d: d, e: e, cap: 25};
}
function nzCandidates(S, R, job) {
  const out = [], dem = job && job.dem, barriers = (job && job.barriers) || [];
  if (dem) {
    const step = (job && job.demStep) || Math.hypot(sgV(dem.dx) || 15, sgV(dem.dy) || 15);
    const L = Math.hypot(R.x - S.x, R.y - S.y);
    const n = Math.max(2, Math.min(80, Math.ceil(L / Math.max(step, 1))));
    for (let i = 1; i < n; i++) {
      const t = i / n, x = S.x + t * (R.x - S.x), y = S.y + t * (R.y - S.y);
      const gz = sgDem(dem, x, y);
      if (gz == null) continue;
      const E = {x: x, y: y, z: gz};
      if (nzAbove(S, R, E)) out.push(nzCandSingle(S, R, E, 'dem'));
    }
  }
  for (let bi = 0; bi < barriers.length; bi++) {
    const b = barriers[bi];
    if (b.kind === 'wall' || b.kind === 'screen' || b.kind === 'fence') {
      const hit = sgSeg(S, R, sgPt(b.a), sgPt(b.b));
      if (!hit || hit.t <= 1e-4 || hit.t >= 1 - 1e-4) continue;
      const E = {x: hit.x, y: hit.y, z: b.z1};
      if (nzAbove(S, R, E)) out.push(nzCandSingle(S, R, E, b.kind));
    } else if (b.kind === 'berm') {
      const hit = sgPolyHit(S, R, b.line);
      if (!hit) continue;
      const gz = dem ? (sgDem(dem, hit.x, hit.y) || 0) : (b.ground || 0);
      const crest = gz + b.crest;
      const half = (b.crestWidth || 0) / 2;
      if (half > 0.05) {
        const dx = R.x - S.x, dy = R.y - S.y, Lm = Math.hypot(dx, dy) || 1, ux = dx / Lm, uy = dy / Lm;
        const e1 = {x: hit.x - ux * half, y: hit.y - uy * half, z: crest};
        const e2 = {x: hit.x + ux * half, y: hit.y + uy * half, z: crest};
        if (nzAbove(S, R, e1) || nzAbove(S, R, e2)) out.push(nzCandDouble(S, R, e1, e2, 'berm'));
      } else {
        const E = {x: hit.x, y: hit.y, z: crest};
        if (nzAbove(S, R, E)) out.push(nzCandSingle(S, R, E, 'berm'));
      }
    } else if (b.kind === 'building') {
      const hits = sgRingHits(S, R, b.ring);
      if (hits.length >= 2) {
        const gz = dem ? (sgDem(dem, hits[0].x, hits[0].y) || 0) : (b.ground || 0);
        const z = b.roofZ != null ? b.roofZ : gz + (b.h || 0);
        const e1 = {x: hits[0].x, y: hits[0].y, z: z}, e2 = {x: hits[1].x, y: hits[1].y, z: z};
        if (nzAbove(S, R, e1) || nzAbove(S, R, e2)) out.push(nzCandDouble(S, R, e1, e2, 'building'));
      }
    }
  }
  return out;
}
function nzAbar(cands, lambda, Agr) {
  let best = 0, how = 'none', kind = null, hit = false;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!(c.z > 0)) continue;
    const C3 = c.mode === 'double' ? nzC3(lambda, c.e) : 1;
    const Dz = nzDz(c.z, c.dss, c.dsr, c.d, lambda, C3, c.cap);
    if (Dz > best) { best = Dz; how = c.mode; kind = c.kind; hit = true; }
  }
  // No edge above the ray: there is no barrier term. Do not turn a negative Agr into attenuation.
  if (!hit) return {Dz: 0, Abar: 0, how: 'none', kind: null};
  return {Dz: best, Abar: Math.max(0, best - Agr), how: how, kind: kind};
}
function nzEnv(met) {
  met = met || {};
  const T_C = met.T_C != null ? sgV(met.T_C) : 10;
  const rh = met.rh_pct != null ? sgV(met.rh_pct) : 70;
  const pa = met.pa_kPa != null ? sgV(met.pa_kPa) : NZ_PR;
  const G = met.G != null ? (typeof met.G === 'object' && met.G.s != null ? met.G : sgV(met.G)) : 0.5;
  const Tsrc = met.T_C != null ? (met.Tsrc || 'caller') : 'assumed';
  const rhSrc = met.rh_pct != null ? (met.rhSrc || 'caller') : 'assumed';
  const paSrc = met.pa_kPa != null ? (met.paSrc || 'caller') : 'assumed';
  const Gsrc = met.G != null ? (met.Gsrc || 'caller') : 'assumed';
  const Tk = T_C + 273.15;
  return {
    alpha: NZ_F.map(f => nzAlpha(f, Tk, rh, pa)),
    Aw: NZ_F.map(nzAweightDb),
    Cw: NZ_F.map(nzCweightDb),
    c: nzSpeed(Tk),
    G: G,
    T_C: T_C,
    met: {
      T_C: sgNum(T_C, Tsrc, '°C', Tsrc === 'assumed' ? 'ISO 9613-2 screening atmosphere, 10 °C' : undefined),
      rh_pct: sgNum(rh, rhSrc, '%', rhSrc === 'assumed' ? '70% relative humidity' : undefined),
      pa_kPa: sgNum(pa, paSrc, 'kPa', paSrc === 'assumed' ? 'standard pressure 101.325 kPa' : undefined),
      G: sgNum(typeof G === 'number' ? G : null, Gsrc, 'fraction', Gsrc === 'assumed' ? 'mixed ground, ISO 9613-2 general method. 0 = hard, 1 = porous' : undefined),
      c: sgNum(nzSpeed(Tk), 'ISO 9613-1', 'm/s'),
      propagation: {v: 'downwind', src: 'ISO 9613-2', note: 'favourable / downwind conditions; no upwind case is computed'}
    }
  };
}
function nzOn(s, scenario, period) {
  const r = s.run && s.run[scenario];
  return !!(r && r[period]);
}
// One source to one receiver. job may carry dem and barriers. Returns raw components; nzPair tags them.
function nzPropagate(src, rec, env, job) {
  const gzS = job && job.dem ? (sgDem(job.dem, src.x, src.y) || 0) : (src.ground || 0);
  const gzR = job && job.dem ? (sgDem(job.dem, rec.x, rec.y) || 0) : (rec.ground || 0);
  const S = {x: src.x, y: src.y, z: gzS + sgV(src.h)};
  const R = {x: rec.x, y: rec.y, z: gzR + sgV(rec.h)};
  const d = sgDist3(S, R), dp = sgDist2(S, R), dUse = Math.max(d, 1);
  const Adiv = 20 * Math.log10(dUse) + 11;
  const g = nzAgr(Math.max(0, sgV(src.h)), Math.max(0, sgV(rec.h)), Math.max(dp, 1), env.G);
  const cands = nzCandidates(S, R, job);
  const bands = [], linA = [], linC = [];
  const lw = src.lw;
  for (let i = 0; i < 8; i++) {
    const Aatm = env.alpha[i] * dUse;
    const bar = nzAbar(cands, env.c / NZ_F[i], g.Agr);
    const Dc = src.dc ? (sgV(src.dc[i] != null ? src.dc[i] : src.dc) || 0) : 0;
    const A = Adiv + Aatm + g.Agr + bar.Abar;
    const Lf = lw[i] + Dc - A;
    bands.push({f: NZ_F[i], Lw: lw[i], Adiv: Adiv, Aatm: Aatm, Agr: g.Agr, Dz: bar.Dz, Abar: bar.Abar, Dc: Dc, A: A, Lf: Lf, Aw: env.Aw[i], Cw: env.Cw[i], how: bar.how, kind: bar.kind});
    linA.push(Lf + env.Aw[i]);
    linC.push(Lf + env.Cw[i]);
  }
  return {d: d, dp: dp, near: d < 1, Adiv: Adiv, Agr: g.Agr, q: g.q, bands: bands, dBA: sgEnergy(linA), dBC: sgEnergy(linC), barriers: cands.length};
}
function nzTagBands(p, lwSrc) {
  const srcL = lwSrc || 'caller';
  return p.bands.map(b => ({
    f: sgNum(b.f, 'IEC 61260 octave centre', 'Hz'),
    Lw: sgNum(b.Lw, srcL, 'dB re 1 pW'),
    Adiv: sgNum(b.Adiv, 'ISO 9613-2 eq. 7', 'dB'),
    Aatm: sgNum(b.Aatm, 'ISO 9613-1', 'dB'),
    Agr: sgNum(b.Agr, 'ISO 9613-2 §7.3.1 general method', 'dB'),
    Dz: sgNum(b.Dz, 'ISO 9613-2 eq. 14', 'dB'),
    Abar: sgNum(b.Abar, 'ISO 9613-2 eq. 14; Abar = max(0, Dz − Agr)', 'dB'),
    Dc: sgNum(b.Dc, b.Dc === 0 ? 'assumed' : 'caller', 'dB', b.Dc === 0 ? 'omnidirectional; no directivity supplied' : undefined),
    Amisc: sgNum(0, 'method', 'dB', 'foliage and industrial-site attenuation are not applied'),
    A: sgNum(b.A, 'computed', 'dB'),
    Lf: sgNum(b.Lf, 'computed', 'dB'),
    Aw: sgNum(b.Aw, 'IEC 61672-1', 'dB'),
    Cw: sgNum(b.Cw, 'IEC 61672-1', 'dB'),
    barrier: b.how
  }));
}
function nzPair(src, rec, opts) {
  opts = opts || {};
  const env = opts.env || nzEnv(opts.met);
  const p = nzPropagate(src, rec, env, opts);
  const lwSrc = src.lwSrc || (src.assumed ? 'assumed' : 'caller');
  return {
    d: sgNum(p.d, 'computed', 'm'),
    dp: sgNum(p.dp, 'computed', 'm', 'ground distance'),
    nearField: p.near ? sgNum(1, 'method', null, 'ISO 9613-2 is not valid below 1 m; divergence was floored at 1 m') : sgNum(0, 'computed'),
    dBA: sgNum(p.dBA, 'computed', 'dBA'),
    dBC: sgNum(p.dBC, 'computed', 'dBC'),
    Adiv: sgNum(p.Adiv, 'ISO 9613-2 eq. 7', 'dB'),
    Agr: sgNum(p.Agr, 'ISO 9613-2 §7.3.1 general method', 'dB'),
    bands: nzTagBands(p, lwSrc),
    met: env.met
  };
}
function nzLimit(rec, kind, period) {
  const L = rec.limits && rec.limits[kind];
  if (!L) return null;
  if (L[period] && typeof L[period] === 'object') return L[period];
  if (typeof L.v === 'number' || L.v === null) return L;
  return null;
}
function nzMargin(limit, pred) {
  if (!limit || limit.v == null || pred == null || !isFinite(pred)) return sgNum(null, 'TBD', 'dB', 'no limit or no predicted level');
  return sgNum(limit.v - pred, 'computed', 'dB', 'positive means under the limit');
}
function nzPass(limit, pred) {
  if (!limit || limit.v == null || pred == null || !isFinite(pred)) return null;
  return pred <= limit.v + 1e-9;
}
function nzPassRow(limA, limC, a, c) {
  const checks = [];
  if (limA && limA.v != null) checks.push(nzPass(limA, a));
  if (limC && limC.v != null) checks.push(nzPass(limC, c));
  if (!checks.length || checks.some(x => x == null)) return null;
  return checks.every(Boolean);
}
function nzSumAt(rec, sources, env, job) {
  const accA = [], accC = [];
  let nearest = null;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const p = nzPropagate(s, rec, env, job);
    if (p.dBA != null) accA.push(p.dBA);
    if (p.dBC != null) accC.push(p.dBC);
    const dp = Math.hypot(s.x - rec.x, s.y - rec.y);
    if (nearest == null || dp < nearest) nearest = dp;
  }
  return {dBA: sources.length ? sgEnergy(accA) : null, dBC: sources.length ? sgEnergy(accC) : null, nearest: nearest};
}
function nzReceptorRow(rec, sources, env, job) {
  const period = job.period || 'day';
  const sum = nzSumAt(rec, sources, env, job);
  const limA = nzLimit(rec, 'dBA', period);
  const limC = nzLimit(rec, 'dBC', period);
  const amb = rec.ambient || {};
  const have = v => v != null && (typeof v === 'number' || (v && v.v != null));
  return {
    id: rec.id,
    kind: rec.kind || 'receptor',
    distance: sum.nearest == null ? sgNum(null, 'TBD', 'm', 'no operating source') : sgNum(sum.nearest, 'computed', 'm', 'horizontal distance to the nearest operating source'),
    dBA: sgNum(sum.dBA, sum.dBA == null ? 'TBD' : 'computed', 'dBA', sum.dBA == null ? 'no operating source in this scenario' : undefined),
    dBC: sgNum(sum.dBC, sum.dBC == null ? 'TBD' : 'computed', 'dBC'),
    limit_dBA: limA || sgNum(null, 'TBD', 'dBA', 'no limit supplied for this period'),
    limit_dBC: limC || sgNum(null, 'TBD', 'dBC', 'no limit supplied for this period'),
    margin_dBA: nzMargin(limA, sum.dBA),
    margin_dBC: nzMargin(limC, sum.dBC),
    pass: nzPassRow(limA, limC, sum.dBA, sum.dBC),
    epa55: {level: NZ_EPA, margin: nzMargin(NZ_EPA, sum.dBA), pass: nzPass(NZ_EPA, sum.dBA)},
    ambient: {
      L90: have(amb.L90) ? sgNum(sgV(amb.L90), amb.src || 'measured', 'dB') : sgNum(null, 'TBD', 'dB', 'no measurement'),
      L10: have(amb.L10) ? sgNum(sgV(amb.L10), amb.src || 'measured', 'dB') : sgNum(null, 'TBD', 'dB', 'no measurement')
    }
  };
}
function nzGrid(spec, sources, env, job) {
  const step = spec.step != null ? sgV(spec.step) : 15;
  const stepSrc = spec.step != null ? (spec.stepSrc || 'caller') : 'method';
  const h = spec.height != null ? sgV(spec.height) : 1.5;
  const hSrc = spec.height != null ? (spec.heightSrc || 'caller') : 'method';
  const x0 = sgV(spec.x0), y0 = sgV(spec.y0), x1 = sgV(spec.x1), y1 = sgV(spec.y1);
  const nx = Math.floor((x1 - x0) / step + 1e-9) + 1;
  const ny = Math.floor((y1 - y0) / step + 1e-9) + 1;
  const values = new Array(nx * ny), valuesC = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const rec = {x: x0 + i * step, y: y0 + j * step, h: h};
    const sum = nzSumAt(rec, sources, env, job);
    const k = j * nx + i;
    values[k] = sum.dBA;
    valuesC[k] = sum.dBC;
  }
  return {
    src: 'computed',
    nx: nx, ny: ny,
    x0: sgNum(x0, 'caller', 'm'), y0: sgNum(y0, 'caller', 'm'),
    dx: sgNum(step, stepSrc, 'm', stepSrc === 'method' ? '15 m screening grid' : undefined),
    dy: sgNum(step, stepSrc, 'm'),
    height: sgNum(h, hSrc, 'm', hSrc === 'method' ? '1.5 m receptor height' : undefined),
    values: values, valuesC: valuesC
  };
}
function nzIsolines(grid) {
  const levels = [45, 50, 55, 60, 65, 70, 75];
  const raw = sgMarch(grid.values, grid.nx, grid.ny, sgV(grid.x0), sgV(grid.y0), sgV(grid.dx), sgV(grid.dy), levels);
  return {
    src: 'computed',
    levels: raw.map(s => ({geom: true, level: sgNum(s.level, 'method', 'dBA', '5 dB band edge'), segs: s.segs, lines: sgStitch(s.segs, Math.max(sgV(grid.dx), sgV(grid.dy)) * 0.05)}))
  };
}
function nzAssumptions(sources, env) {
  const equip = (sources || []).some(s => s.assumed || s.lwSrc === 'assumed');
  return [
    {item: 'equipment sound power', src: equip ? 'assumed' : 'caller', note: equip ? 'Catalog spectra are assumptions. Replace with a vendor octave-band sound power before relying on a level.' : 'Sound power supplied by the caller.'},
    {item: 'atmosphere', src: env.met.T_C.src, note: 'Temperature, humidity and pressure used for ISO 9613-1 absorption.'},
    {item: 'ground factor', src: env.met.G.src, note: 'ISO 9613-2 general method. The same Agr is applied in every octave band; the general method has no frequency term.'},
    {item: 'propagation', src: 'ISO 9613-2', note: 'Downwind / favourable. Results are not an upwind or a long-term Lden.'},
    {item: 'ambient', src: 'TBD', note: 'L90 and L10 are printed only when a measurement is passed in.'},
    {item: 'directivity', src: 'assumed', note: 'Sources are omnidirectional unless dc is supplied.'}
  ];
}
function nzRun(job) {
  job = job || {};
  if (job.consultant) return nzFromConsultant(job);
  const env = nzEnv(job.met);
  const scenario = job.scenario || 'typical', period = job.period || 'day';
  const sources = (job.sources || []).filter(s => nzOn(s, scenario, period));
  const j2 = {period: period, dem: job.dem, barriers: job.barriers || [], demStep: job.demStep};
  const receptors = (job.receptors || []).map(r => nzReceptorRow(r, sources, env, j2));
  let grid = null, isolines = null;
  if (job.grid) {
    grid = nzGrid(job.grid, sources, env, j2);
    isolines = nzIsolines(grid);
  }
  const assumed = (job.sources || []).some(s => s.assumed || s.lwSrc === 'assumed');
  return {
    label: NZ_LABEL,
    equipmentAssumed: assumed,
    scenario: scenario,
    period: period,
    met: env.met,
    assumptions: nzAssumptions(job.sources || [], env),
    receptors: receptors,
    grid: grid,
    isolines: isolines,
    legend: NZ_LEGEND,
    operating: {v: sources.length, src: 'computed', u: 'sources', note: 'sources scheduled on for this scenario and period'}
  };
}
function nzRunAll(job) {
  const runs = NZ_SCENARIOS.map(([s, p]) => nzRun(Object.assign({}, job, {scenario: s, period: p})));
  return {label: NZ_LABEL, scenarios: NZ_SCENARIOS.map(([s, p]) => s + '-' + p), runs: runs};
}
// ---- consultant grid -------------------------------------------------------
function nzRound6(n) { return Math.round(n * 1e6) / 1e6; }
function nzEven(vals) {
  if (vals.length < 2) return true;
  const d = vals[1] - vals[0];
  if (!(d > 0)) return false;
  for (let i = 2; i < vals.length; i++) if (Math.abs((vals[i] - vals[i - 1]) - d) > 1e-4 * Math.max(1, Math.abs(d))) return false;
  return true;
}
function nzIdw(pts, x, y) {
  let ws = 0, va = 0, vc = 0, wc = 0, anyC = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], d = Math.hypot(p.x - x, p.y - y);
    if (d < 1e-6) return {dBA: p.dBA, dBC: p.dBC};
    const w = 1 / (d * d);
    ws += w; va += w * p.dBA;
    if (p.dBC != null && isFinite(p.dBC)) { wc += w; vc += w * p.dBC; anyC = true; }
  }
  return {dBA: ws ? va / ws : null, dBC: anyC && wc ? vc / wc : null};
}
function nzPointsToGrid(pts, step) {
  const xs = [...new Set(pts.map(p => nzRound6(p.x)))].sort((a, b) => a - b);
  const ys = [...new Set(pts.map(p => nzRound6(p.y)))].sort((a, b) => a - b);
  if (xs.length * ys.length === pts.length && nzEven(xs) && nzEven(ys)) {
    const nx = xs.length, ny = ys.length;
    const values = new Array(nx * ny).fill(null), valuesC = new Array(nx * ny).fill(null);
    const xi = new Map(xs.map((x, i) => [x, i])), yi = new Map(ys.map((y, i) => [y, i]));
    for (const p of pts) {
      const k = yi.get(nzRound6(p.y)) * nx + xi.get(nzRound6(p.x));
      values[k] = p.dBA; valuesC[k] = p.dBC;
    }
    return {
      src: 'consultant', method: sgNum(0, 'consultant', null, 'regular grid, used as imported'),
      nx: nx, ny: ny,
      x0: sgNum(xs[0], 'consultant', 'm'), y0: sgNum(ys[0], 'consultant', 'm'),
      dx: sgNum(nx > 1 ? xs[1] - xs[0] : (step || 15), 'consultant', 'm'),
      dy: sgNum(ny > 1 ? ys[1] - ys[0] : (step || 15), 'consultant', 'm'),
      values: values, valuesC: valuesC
    };
  }
  step = step || 15;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const nx = Math.floor((x1 - x0) / step + 1e-9) + 1, ny = Math.floor((y1 - y0) / step + 1e-9) + 1;
  const values = new Array(nx * ny), valuesC = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const s = nzIdw(pts, x0 + i * step, y0 + j * step);
    values[j * nx + i] = s.dBA; valuesC[j * nx + i] = s.dBC;
  }
  return {
    src: 'consultant',
    method: sgNum(2, 'assumed', null, 'inverse-distance power 2, because the points are not a regular grid'),
    nx: nx, ny: ny,
    x0: sgNum(x0, 'computed', 'm'), y0: sgNum(y0, 'computed', 'm'),
    dx: sgNum(step, 'method', 'm', '15 m screening grid'), dy: sgNum(step, 'method', 'm'),
    values: values, valuesC: valuesC
  };
}
function nzParseCsv(text) {
  const lines = String(text).split(/\r?\n/);
  let firm = null;
  const pts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line[0] === '#') {
      const m = /firm\s*[:=]\s*(.+)/i.exec(line);
      if (m) firm = m[1].trim();
      continue;
    }
    const parts = line.split(/[,\t ]+/).filter(Boolean);
    if (!parts.length) continue;
    if (isNaN(parseFloat(parts[0]))) continue;
    const n = parts.map(Number);
    if (n.length >= 3 && n.slice(0, 3).every(isFinite)) pts.push({x: n[0], y: n[1], dBA: n[2], dBC: n.length >= 4 && isFinite(n[3]) ? n[3] : null});
  }
  return {firm: firm, pts: pts};
}
function nzImportCsv(text, meta) {
  meta = meta || {};
  const parsed = nzParseCsv(text);
  const firm = meta.firm || parsed.firm || 'CONSULTANT';
  if (!parsed.pts.length) throw new Error('consultant CSV has no x,y,dBA rows');
  const grid = nzPointsToGrid(parsed.pts, meta.step);
  return {label: 'MODEL BY ' + firm, firm: firm, src: 'consultant', grid: grid, points: sgNum(parsed.pts.length, 'computed', 'count'), note: 'Imported consultant grid. Levels are not recomputed by the screening model.'};
}
function nzImportRaster(raster, meta) {
  meta = meta || {};
  const firm = meta.firm || 'CONSULTANT';
  const nx = raster.nx || raster.width, ny = raster.ny || raster.height;
  const values = raster.values || raster.dBA;
  if (!values || values.length !== nx * ny) throw new Error('consultant raster size does not match nx*ny');
  const grid = {
    src: 'consultant', method: sgNum(0, 'consultant', null, 'raster used as imported'),
    nx: nx, ny: ny,
    x0: sgNum(sgV(raster.x0), 'consultant', raster.unit || 'm'),
    y0: sgNum(sgV(raster.y0), 'consultant', raster.unit || 'm'),
    dx: sgNum(sgV(raster.dx), 'consultant', raster.unit || 'm'),
    dy: sgNum(sgV(raster.dy), 'consultant', raster.unit || 'm'),
    values: values.slice(), valuesC: raster.valuesC ? raster.valuesC.slice() : new Array(values.length).fill(null)
  };
  return {label: 'MODEL BY ' + firm, firm: firm, src: 'consultant', grid: grid, note: 'Imported consultant raster (GeoTIFF or decoded grid). Levels are not recomputed.'};
}
function nzSample(grid, x, y) {
  const x0 = sgV(grid.x0), y0 = sgV(grid.y0), dx = sgV(grid.dx), dy = sgV(grid.dy);
  const fx = (x - x0) / dx, fy = (y - y0) / dy;
  if (fx < -0.5 || fy < -0.5 || fx > grid.nx - 0.5 || fy > grid.ny - 0.5) return {dBA: null, dBC: null};
  const i0 = Math.max(0, Math.min(grid.nx - 1, Math.floor(fx))), j0 = Math.max(0, Math.min(grid.ny - 1, Math.floor(fy)));
  const i = grid.nx < 2 ? 0 : Math.min(i0, grid.nx - 2), j = grid.ny < 2 ? 0 : Math.min(j0, grid.ny - 2);
  const i2 = Math.min(grid.nx - 1, i + 1), j2 = Math.min(grid.ny - 1, j + 1);
  const u = i2 === i ? 0 : Math.max(0, Math.min(1, fx - i)), v = j2 === j ? 0 : Math.max(0, Math.min(1, fy - j));
  const A = (ii, jj) => grid.values[jj * grid.nx + ii];
  const C = (ii, jj) => grid.valuesC ? grid.valuesC[jj * grid.nx + ii] : null;
  const mix = (f) => {
    const a = f(i, j), b = f(i2, j), c = f(i, j2), d = f(i2, j2);
    if ([a, b, c, d].some(t => t == null || !isFinite(t))) return null;
    return (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
  };
  return {dBA: mix(A), dBC: mix(C)};
}
function nzFromConsultant(job) {
  const imp = job.consultant.grid ? job.consultant : (job.consultant.csv ? nzImportCsv(job.consultant.csv, job.consultant) : nzImportRaster(job.consultant.raster, job.consultant));
  const period = job.period || 'day';
  const receptors = (job.receptors || []).map(r => {
    const s = nzSample(imp.grid, r.x, r.y);
    const limA = nzLimit(r, 'dBA', period), limC = nzLimit(r, 'dBC', period);
    return {
      id: r.id, kind: r.kind || 'receptor',
      distance: sgNum(null, 'TBD', 'm', 'consultant grid import does not locate sources'),
      dBA: sgNum(s.dBA, s.dBA == null ? 'TBD' : 'consultant', 'dBA'),
      dBC: sgNum(s.dBC, s.dBC == null ? 'TBD' : 'consultant', 'dBC'),
      limit_dBA: limA || sgNum(null, 'TBD', 'dBA', 'no limit supplied'),
      limit_dBC: limC || sgNum(null, 'TBD', 'dBC', 'no limit supplied'),
      margin_dBA: nzMargin(limA, s.dBA), margin_dBC: nzMargin(limC, s.dBC),
      pass: nzPassRow(limA, limC, s.dBA, s.dBC),
      epa55: {level: NZ_EPA, margin: nzMargin(NZ_EPA, s.dBA), pass: nzPass(NZ_EPA, s.dBA)},
      ambient: {L90: sgNum(null, 'TBD', 'dB', 'no measurement'), L10: sgNum(null, 'TBD', 'dB', 'no measurement')}
    };
  });
  return {
    label: imp.label, firm: imp.firm, equipmentAssumed: false, scenario: job.scenario || 'imported', period: period,
    met: null, assumptions: [{item: 'levels', src: 'consultant', note: imp.note}],
    receptors: receptors, grid: imp.grid, isolines: nzIsolines(imp.grid), legend: NZ_LEGEND,
    operating: sgNum(null, 'TBD', 'sources', 'not known from an imported grid')
  };
}
// ---- assumed equipment catalog --------------------------------------------
// Shapes are unweighted octave Lw, then shifted so the A-weighted sum equals the stated LwA.
function nzFitLwA(shape, target) {
  const Aw = NZ_F.map(nzAweightDb);
  const sum = sgEnergy(shape.map((lw, i) => lw + Aw[i]));
  const d = target - sum;
  return shape.map(lw => lw + d);
}
function nzHemisphericLp(lwA, r) {
  // Lp ≈ Lw − 20 log10(r) − 10 log10(2π), r in metres, hemispherical radiation.
  return lwA - 20 * Math.log10(r) - 10 * Math.log10(2 * Math.PI);
}
function nzCatalog() {
  const gensetLwA = 105;
  const items = [
    {
      kind: 'genset', name: 'Enclosed diesel generator',
      shape: [102, 104, 101, 99, 97, 94, 90, 84], lwA: gensetLwA, h: 2,
      note: 'Assumed Level-2 enclosure, 80 dBA at 7 m (midpoint of the public 75–85 dBA at 7 m range), converted to sound power on a hemisphere. Octave shape is assumed. Replace with a vendor spectrum.',
      run: {typical: {day: false, night: false}, maintenance: {day: true, night: false}, emergency: {day: true, night: true}},
      runNote: 'Assumed schedule: off in typical operation; one-unit maintenance test in the daytime only; emergency operation day and night.'
    },
    {
      kind: 'cooler', name: 'Dry cooler',
      shape: [90, 94, 98, 100, 98, 94, 88, 80], lwA: 96, h: 3,
      note: 'Assumed dry-cooler sound power, 96 dBA Lw. Octave shape is assumed. Replace with a vendor spectrum.',
      run: {typical: {day: true, night: true}, maintenance: {day: true, night: true}, emergency: {day: true, night: true}},
      runNote: 'Assumed to run day and night in every scenario.'
    },
    {
      kind: 'transformer', name: 'Substation transformer',
      shape: [95, 105, 108, 98, 90, 82, 74, 66], lwA: 90, h: 3,
      note: 'Assumed transformer sound power, 90 dBA Lw, with the level concentrated at 125 and 250 Hz. Not a NEMA TR-1 nameplate. Replace with the nameplate octave spectrum.',
      run: {typical: {day: true, night: true}, maintenance: {day: true, night: true}, emergency: {day: true, night: true}},
      runNote: 'Assumed to run day and night in every scenario.'
    },
    {
      kind: 'facade', name: 'Building facade breakout',
      shape: [80, 85, 90, 92, 90, 85, 78, 70], lwA: 88, h: 5,
      note: 'Assumed equivalent point source for one hall facade, 88 dBA Lw. Replace with a measured or calculated breakout.',
      run: {typical: {day: true, night: true}, maintenance: {day: true, night: true}, emergency: {day: true, night: true}},
      runNote: 'Assumed to run day and night in every scenario.'
    }
  ];
  return items.map(it => ({
    src: 'assumed',
    kind: it.kind, name: it.name,
    lw: nzFitLwA(it.shape, it.lwA),
    lwA: sgNum(it.lwA, 'assumed', 'dBA', it.note),
    h: sgNum(it.h, 'assumed', 'm', 'source height above local ground'),
    note: it.note,
    run: it.run, runNote: it.runNote
  }));
}
function nzPlace(kind, x, y, extra) {
  const c = nzCatalog().find(e => e.kind === kind);
  if (!c) throw new Error('unknown equipment kind ' + kind);
  return Object.assign({
    id: kind, kind: kind, name: c.name, x: x, y: y, h: c.h.v, lw: c.lw.slice(), lwSrc: 'assumed', assumed: true,
    run: c.run, note: c.note
  }, extra || {});
}
// Examples only. Not applied unless the caller passes them on a receptor. Confirm the adopted ordinance.
const NZ_LIMITS = {
  epa55: {dBA: NZ_EPA},
  butler_draft: {
    note: 'Figures stated in the sheet-set spec as the Butler County draft. Confirm the adopted text before use.',
    dBA: {day: sgNum(60, 'Butler County draft, confirm adopted text', 'dBA'), night: sgNum(55, 'Butler County draft, confirm adopted text', 'dBA')},
    dBC: {day: sgNum(65, 'Butler County draft, confirm adopted text', 'dBC'), night: sgNum(60, 'Butler County draft, confirm adopted text', 'dBC')}
  },
  desoto: {
    note: 'Figures stated in the sheet-set spec as the De Soto standard. Confirm the adopted text before use.',
    dBA: {day: sgNum(55, 'De Soto noise standard, confirm adopted text', 'dBA'), night: sgNum(50, 'De Soto noise standard, confirm adopted text', 'dBA')}
  }
};
function nzHandle(msg) {
  if (!msg || msg.type !== 'run') return {type: 'error', message: 'expected {type:"run", job}'};
  try {
    const result = msg.job && msg.job.all ? nzRunAll(msg.job) : nzRun(msg.job);
    return {type: 'result', result: result};
  } catch (e) {
    return {type: 'error', message: String(e && e.message || e)};
  }
}
