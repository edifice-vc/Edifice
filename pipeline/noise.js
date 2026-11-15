// NZ-101 noise screening engine. ISO 9613-2:1996 octave-band point sources, 63 Hz–8 kHz.
// Downwind (favourable) levels only: the long-term Cmet correction is not applied.
// Runs in the page or in a worker (nzWorkerSource / nzScreenAsync). Returns plain data.
//
// Accuracy, short form: this is a screening model, not a sound study. With known inputs,
// ISO 9613-2 Table 5 puts broadband downwind error at about ±3 dB out to 1 km. Our
// equipment levels, ground factor and barrier simplification are assumed, so siting use
// should expect roughly ±3 to ±5 dB and more where several barriers or steep ground matter.
// Every Edifice-computed output carries NZ_LABEL. A consultant grid is labelled MODEL BY <firm>.

const NZ_LABEL = 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY';
const NZ_BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
const NZ_CONTOUR_DB = [45, 50, 55, 60, 65, 70, 75];
// Quiet green through loud purple, the low-to-high order of the WJHW figures.
// The public spec does not publish the swatch hexes; a sheet may recolour these.
const NZ_CONTOUR_COLOR = { 45: '#1b7f4e', 50: '#7cb342', 55: '#c0ca33', 60: '#fdd835', 65: '#fb8c00', 70: '#e53935', 75: '#6a1b9a' };
const NZ_EPA_DBA = 55;
const NZ_FT = 0.3048;
const NZ_SCENARIOS = [
  ['typical', 'day'], ['typical', 'night'],
  ['maintenance', 'day'], ['maintenance', 'night'],
  ['emergency', 'day'], ['emergency', 'night']
];

// ---- weights (IEC 61672-1) and energy sum ---------------------------------

function nzDbA(f) { return nzWeightA(f) - nzWeightA(1000); }
function nzDbC(f) { return nzWeightC(f) - nzWeightC(1000); }
function nzWeightA(f) {
  const f2 = f * f, f4 = f2 * f2;
  const n = f4 * 12194 * 12194;
  const d = (f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194);
  return 20 * Math.log10(n / d);
}
function nzWeightC(f) {
  const f2 = f * f;
  const n = f2 * 12194 * 12194;
  const d = (f2 + 20.6 * 20.6) * (f2 + 12194 * 12194);
  return 20 * Math.log10(n / d);
}
function nzSumDb(levels) {
  let s = 0, n = 0;
  for (let i = 0; i < levels.length; i++) {
    const L = levels[i];
    if (L == null || !isFinite(L)) continue;
    s += Math.pow(10, L / 10);
    n++;
  }
  return n ? 10 * Math.log10(s) : null;
}
function nzRound1(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10) / 10; }

// ---- ISO 9613-1 atmospheric absorption, dB/km -----------------------------
// Eq. 5 with the Annex B vapour pressure. f in Hz, rh in percent, pressure in kPa.

function nzAlpha(freqHz, tempC, rhPercent, pressureKPa) {
  const T = tempC + 273.15, T0 = 293.15, T01 = 273.16, pr = 101.325, pa = pressureKPa;
  const psat = Math.pow(10, -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151);
  const h = rhPercent * psat * (pr / pa);
  const frO = (pa / pr) * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
  const frN = (pa / pr) * Math.pow(T / T0, -0.5) * (9 + 280 * h * Math.exp(-4.170 * (Math.pow(T / T0, -1 / 3) - 1)));
  const f2 = freqHz * freqHz;
  const classical = 1.84e-11 * (pr / pa) * Math.sqrt(T / T0);
  const relax = Math.pow(T / T0, -2.5) * (
    0.01275 * Math.exp(-2239.1 / T) / (frO + f2 / frO) +
    0.1068 * Math.exp(-3352.0 / T) / (frN + f2 / frN)
  );
  return 8.686 * f2 * (classical + relax) * 1000;
}
function nzSpeed(tempC) { return 331.3 * Math.sqrt(1 + tempC / 273.15); }

// ---- propagation terms ------------------------------------------------------

function nzAdiv(d) { return 20 * Math.log10(Math.max(d, 1)) + 11; }

function nzQ(dp, hs, hr) {
  const lim = 30 * (hs + hr);
  if (!(dp > lim)) return 0;
  return 1 - lim / dp;
}
function nzAprime(h, dp) {
  return 1.5 + 3.0 * Math.exp(-0.12 * (h - 5) * (h - 5)) * (1 - Math.exp(-dp / 50)) + 5.7 * Math.exp(-0.09 * h * h) * (1 - Math.exp(-2.8e-6 * dp * dp));
}
function nzBprime(h, dp) { return 1.5 + 8.6 * Math.exp(-0.09 * h * h) * (1 - Math.exp(-dp / 50)); }
function nzCprime(h, dp) { return 1.5 + 14.0 * Math.exp(-0.46 * h * h) * (1 - Math.exp(-dp / 50)); }
function nzDprime(h, dp) { return 1.5 + 5.0 * Math.exp(-0.9 * h * h) * (1 - Math.exp(-dp / 50)); }

// General method, ISO 9613-2:1996 Table 3. Not the A-weighted alternative (eq. 10).
function nzEndRegion(freq, G, h, dp) {
  if (freq < 100) return -1.5;
  if (freq < 200) return -1.5 + G * nzAprime(h, dp);
  if (freq < 400) return -1.5 + G * nzBprime(h, dp);
  if (freq < 800) return -1.5 + G * nzCprime(h, dp);
  if (freq < 1600) return -1.5 + G * nzDprime(h, dp);
  return -1.5 * (1 - G);
}
function nzMidRegion(freq, Gm, q) {
  if (freq < 100) return -3 * q;
  return -3 * q * (1 - Gm);
}
function nzAgr(freq, hs, hr, dp, Gs, Gr, Gm) {
  const q = nzQ(dp, hs, hr);
  return nzEndRegion(freq, Gs, hs, dp) + nzEndRegion(freq, Gr, hr, dp) + nzMidRegion(freq, Gm, q);
}

// Eq. 15. C3 = 1 for a thin edge (e = 0) and tends to 3 for a thick barrier.
function nzC3(lambda, e) {
  if (!(e > 0)) return 1;
  const r2 = (5 * lambda / e) * (5 * lambda / e);
  return (1 + r2) / (1 / 3 + r2);
}
// Eq. 14 and eq. 18. C2 = 20 (ground reflections are inside Dz, not image sources).
// Dz is capped at 20 dB (single) or 25 dB (double). Negative z uses Kmet = 1.
function nzDz(freq, z, dss, dsr, d, e, c) {
  const lambda = c / freq, C2 = 20, C3 = nzC3(lambda, e);
  let K = 1;
  if (z > 0) K = Math.exp(-Math.sqrt(Math.max(0, (dss * dsr * d) / (2 * z))) / 2000);
  const arg = 3 + (C2 / lambda) * C3 * z * K;
  let Dz = 10 * Math.log10(arg > 1 ? arg : 1);
  const cap = e > 0 ? 25 : 20;
  if (Dz > cap) Dz = cap;
  return Dz;
}

// ---- geometry ----------------------------------------------------------------

function nzDist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function nzInRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (ring[j][0] - ring[i][0]) * (y - yi) / (yj - yi) + ring[i][0]) c = !c;
  }
  return c;
}
function nzBlocks(S, R, E) {
  const dx = R.x - S.x, dy = R.y - S.y, L2 = dx * dx + dy * dy;
  let t = L2 > 1e-12 ? ((E.x - S.x) * dx + (E.y - S.y) * dy) / L2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return E.z > S.z + t * (R.z - S.z) + 1e-6;
}
function nzSingleGeom(S, R, E) {
  const dss = nzDist3(S, E), dsr = nzDist3(E, R), d = nzDist3(S, R);
  const zmag = dss + dsr - d, blocked = nzBlocks(S, R, E);
  return { edges: [E], z: blocked ? zmag : -zmag, dss: dss, dsr: dsr, e: 0, d: d, blocked: blocked };
}
function nzDoubleGeom(S, R, E1, E2) {
  const a = nzDist3(S, E1) <= nzDist3(S, E2) ? E1 : E2;
  const b = a === E1 ? E2 : E1;
  const dss = nzDist3(S, a), dsr = nzDist3(b, R), e = nzDist3(a, b), d = nzDist3(S, R);
  const zmag = dss + e + dsr - d;
  const blocked = nzBlocks(S, R, a) || nzBlocks(S, R, b);
  return { edges: [a, b], z: blocked ? zmag : -zmag, dss: dss, dsr: dsr, e: e, d: d, blocked: blocked };
}
function nzSegT(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t > 1e-5 && t < 1 - 1e-5 && u >= -1e-6 && u <= 1 + 1e-6) return { t: t, u: u };
  return null;
}
function nzWidthNormal(ring, S, R) {
  const dx = R.x - S.x, dy = R.y - S.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const t = ring[i][0] * nx + ring[i][1] * ny;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo;
}
function nzLineLength(line) {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return s;
}

// Obstacles the ground path actually crosses. Buildings are one thick barrier
// (two edges). Berms are one thin edge at the crossing. Terrain, if given, adds
// the single sample that bulges farthest through the line of sight.
function nzObstacles(S, R, barriers, terrain) {
  const out = [];
  for (let i = 0; i < barriers.length; i++) {
    const b = barriers[i];
    if (b.kind === 'building' && b.polygon && b.polygon.length >= 3) {
      if (nzInRing(S.x, S.y, b.polygon) || nzInRing(R.x, R.y, b.polygon)) continue;
      const hits = [];
      for (let k = 0; k < b.polygon.length; k++) {
        const a = b.polygon[k], c = b.polygon[(k + 1) % b.polygon.length];
        const hit = nzSegT(S.x, S.y, R.x, R.y, a[0], a[1], c[0], c[1]);
        if (hit) hits.push({ t: hit.t, x: S.x + hit.t * (R.x - S.x), y: S.y + hit.t * (R.y - S.y) });
      }
      if (hits.length < 2) continue;
      hits.sort(function (p, q) { return p.t - q.t; });
      const E1 = { x: hits[0].x, y: hits[0].y, z: b.roofZ };
      const E2 = { x: hits[hits.length - 1].x, y: hits[hits.length - 1].y, z: b.roofZ };
      out.push({ id: b.id, length_m: nzWidthNormal(b.polygon, S, R), geom: nzDoubleGeom(S, R, E1, E2) });
    } else if (b.line && b.line.length >= 2) {
      let best = null;
      for (let k = 1; k < b.line.length; k++) {
        const a = b.line[k - 1], c = b.line[k];
        const hit = nzSegT(S.x, S.y, R.x, R.y, a[0], a[1], c[0], c[1]);
        if (!hit) continue;
        const zc = c.length > 2 ? c[2] : b.z, za = a.length > 2 ? a[2] : b.z;
        const z = za + hit.u * (zc - za);
        if (!best || hit.t < best.t) best = { t: hit.t, x: S.x + hit.t * (R.x - S.x), y: S.y + hit.t * (R.y - S.y), z: z };
      }
      if (!best) continue;
      out.push({ id: b.id, length_m: b.length_m || nzLineLength(b.line), geom: nzSingleGeom(S, R, { x: best.x, y: best.y, z: best.z }) });
    }
  }
  if (terrain && terrain.z && terrain.nx > 1) {
    const edge = nzTerrainPoint(S, R, terrain);
    if (edge) out.push({ id: 'terrain', length_m: Infinity, geom: nzSingleGeom(S, R, edge) });
  }
  return out;
}
function nzTerrainAt(terrain, x, y) {
  const i = (x - terrain.xmin) / terrain.dx, j = (y - terrain.ymin) / terrain.dy;
  if (i < 0 || j < 0 || i > terrain.nx - 1 || j > terrain.ny - 1) return null;
  const i0 = Math.min(terrain.nx - 2, Math.floor(i)), j0 = Math.min(terrain.ny - 2, Math.floor(j));
  const u = i - i0, v = j - j0, n = terrain.nx;
  const z00 = terrain.z[j0 * n + i0], z10 = terrain.z[j0 * n + i0 + 1], z01 = terrain.z[(j0 + 1) * n + i0], z11 = terrain.z[(j0 + 1) * n + i0 + 1];
  if ([z00, z10, z01, z11].some(function (z) { return z == null || !isFinite(z); })) return null;
  return (1 - u) * (1 - v) * z00 + u * (1 - v) * z10 + (1 - u) * v * z01 + u * v * z11;
}
function nzTerrainPoint(S, R, terrain) {
  const dp = Math.hypot(R.x - S.x, R.y - S.y);
  const step = Math.max(terrain.dx, terrain.dy);
  if (!(dp > step * 2)) return null;
  const n = Math.min(80, Math.max(2, Math.floor(dp / step)));
  let best = null;
  for (let i = 1; i < n; i++) {
    const t = i / n, x = S.x + (R.x - S.x) * t, y = S.y + (R.y - S.y) * t;
    const zg = nzTerrainAt(terrain, x, y);
    if (zg == null) continue;
    const zLine = S.z + (R.z - S.z) * t;
    if (zg <= zLine + 0.05) continue;
    const E = { x: x, y: y, z: zg };
    const z = nzDist3(S, E) + nzDist3(E, R) - nzDist3(S, R);
    if (!best || z > best.z) best = { x: x, y: y, z: zg, path: z };
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

// One or two most effective barriers (ISO 9613-2 clause 7.4, last paragraph).
// Nothing blocking: the nearest miss, so eq. 14 still sees a negative z.
// One blocking obstacle: use it (a building stays double diffraction).
// Several: the two with the largest path difference, joined at their outer edges.
function nzPickGeomResolved(S, R, obstacles, freq, c) {
  const lambda = c / freq;
  const usable = obstacles.filter(function (o) { return !(o.length_m < lambda); });
  if (!usable.length) return null;
  const blocking = usable.filter(function (o) { return o.geom.blocked; });
  if (!blocking.length) {
    usable.sort(function (a, b) { return b.geom.z - a.geom.z; });
    return usable[0].geom;
  }
  if (blocking.length === 1) return blocking[0].geom;
  blocking.sort(function (a, b) { return b.geom.z - a.geom.z; });
  const pts = [];
  blocking.slice(0, 2).forEach(function (o) { o.geom.edges.forEach(function (p) { pts.push(p); }); });
  pts.sort(function (a, b) { return nzDist3(S, a) - nzDist3(S, b); });
  if (pts.length === 1) return nzSingleGeom(S, R, pts[0]);
  return nzDoubleGeom(S, R, pts[0], pts[pts.length - 1]);
}

// ---- one receiver, one or many sources --------------------------------------

function nzEvalPair(src, rec, obstacles, model) {
  const dp = Math.hypot(rec.x - src.x, rec.y - src.y);
  const d3 = Math.max(Math.hypot(dp, rec.z - src.z), 0.01);
  const dDiv = Math.max(d3, 1);
  const Adiv = nzAdiv(dDiv);
  const hs = Math.max(0, src.z - model.groundZ(src.x, src.y));
  const hr = Math.max(0, rec.z - model.groundZ(rec.x, rec.y));
  const Gs = model.groundAt(src, rec, 0.08), Gr = model.groundAt(src, rec, 0.92), Gm = model.groundAt(src, rec, 0.5);
  const bands = [];
  for (let i = 0; i < NZ_BANDS.length; i++) {
    const Lw = src.lw[i];
    if (Lw == null || !isFinite(Lw)) { bands.push(null); continue; }
    const f = NZ_BANDS[i];
    const Aatm = model.alpha[i] * d3 / 1000;
    const Agr = nzAgr(f, hs, hr, dp, Gs, Gr, Gm);
    const geom = nzPickGeomResolved(src, rec, obstacles, f, model.c);
    const has = !!geom;
    const Dz = has ? nzDz(f, geom.z, geom.dss, geom.dsr, geom.d, geom.e, model.c) : 0;
    // Eq. 12: Abar = Dz − Agr, not below 0. Net ground+barrier is max(Agr, Dz).
    const Abar = has ? Math.max(0, Dz - Agr) : 0;
    const Amisc = src.amisc && src.amisc[i] != null ? src.amisc[i] : 0;
    const Dc = src.dc && src.dc[i] != null ? src.dc[i] : 0;
    const A = Adiv + Aatm + Agr + Abar + Amisc;
    bands.push({ f: f, Lw: Lw, Dc: Dc, Adiv: Adiv, Aatm: Aatm, Agr: Agr, Dz: Dz, Abar: Abar, Amisc: Amisc, A: A, Lp: Lw + Dc - A, z: has ? geom.z : null, blocked: has ? geom.blocked : false, hs: hs, hr: hr, dp: dp, d: d3 });
  }
  return {
    bands: bands,
    dBA: nzSumDb(bands.map(function (b, i) { return b ? b.Lp + model.aw[i] : null; })),
    dBC: nzSumDb(bands.map(function (b, i) { return b ? b.Lp + model.cw[i] : null; })),
    distance_m: dp
  };
}
function nzSumPairs(pairs, model) {
  const lp = [];
  for (let i = 0; i < NZ_BANDS.length; i++) lp.push(nzSumDb(pairs.map(function (p) { return p.bands[i] ? p.bands[i].Lp : null; })));
  return {
    lp: lp,
    dBA: nzSumDb(lp.map(function (L, i) { return L == null ? null : L + model.aw[i]; })),
    dBC: nzSumDb(lp.map(function (L, i) { return L == null ? null : L + model.cw[i]; }))
  };
}

// ---- inputs -------------------------------------------------------------------

function nzScaleSpectrum(rel, lwA) {
  const aw = NZ_BANDS.map(function (f, i) { return rel[i] + nzDbA(f); });
  const delta = lwA - nzSumDb(aw);
  return rel.map(function (v) { return v + delta; });
}
// Shapes are generic slopes, scaled to an overall LwA. They are not vendor tests.
const NZ_LIBRARY = {
  genset_enclosed: { lwA: 110, rel: [12, 11, 8, 5, 2, 0, -4, -10], cite: 'ASSUMED enclosed-diesel slope scaled to LwA 110 dB, about 82 dBA at 7 m by free-field divergence only (20 log10 d + 11). Not an enclosure data sheet.' },
  dry_cooler: { lwA: 96, rel: [-5, 0, 4, 7, 6, 4, 0, -6], cite: 'ASSUMED fan-dominated slope scaled to LwA 96 dB. Not a vendor test.' },
  transformer: { lwA: 88, rel: [8, 12, 10, 6, 0, -6, -12, -18], cite: 'ASSUMED hum-weighted slope scaled to LwA 88 dB. Not a NEMA TR-1 nameplate conversion.' },
  facade: { lwA: 85, rel: [4, 4, 2, 0, -1, -2, -4, -8], cite: 'ASSUMED broadband facade breakout scaled to LwA 85 dB for the whole hall, then split equally across four wall points. A point source is not an area source.' }
};
function nzLibrarySpectrum(kind) {
  const row = NZ_LIBRARY[kind];
  if (!row) throw new Error('unknown equipment kind ' + kind);
  return { lw: nzScaleSpectrum(row.rel, row.lwA), lwA: row.lwA, cite: row.cite, assumed: true, tag: 'ASSUMED' };
}
function nzEquipment(kind, over) {
  over = over || {};
  const lib = nzLibrarySpectrum(kind);
  const duty = over.duty || nzDefaultDuty(kind);
  return {
    id: over.id || kind,
    kind: kind,
    name: over.name || kind,
    x: over.x || 0, y: over.y || 0, z: over.z != null ? over.z : nzDefaultHeight(kind),
    lw: over.lw || lib.lw,
    lwA: over.lw ? null : lib.lwA,
    dc: over.dc || null,
    amisc: over.amisc || null,
    duty: duty,
    assumed: over.lw ? !!over.assumed : true,
    tag: over.lw ? (over.assumed ? 'ASSUMED' : 'INPUT') : 'ASSUMED',
    cite: over.cite || (over.lw ? '' : lib.cite),
    sensitive: kind === 'genset_enclosed'
  };
}
function nzDefaultHeight(kind) {
  if (kind === 'genset_enclosed') return 2;
  if (kind === 'dry_cooler') return 3.5;
  if (kind === 'transformer') return 3;
  return 4;
}
// Operating states follow the published Exhibit B §2.1 definitions, not a fitted spectrum.
// Typical: generators off. Maintenance: one genset, daytime, at the library Lw (their "100% load"
// has no separate spectrum in the report). Emergency: every genset on; substation transformers off.
// The report also says emergency generators are at 80% load. That load-versus-Lw curve is not
// published, so no load derate is applied. Cooling and the facade stay on in every state.
function nzDefaultDuty(kind) {
  if (kind === 'genset_enclosed') return { typical: { day: 0, night: 0 }, maintenance: { day: 1, night: 0 }, emergency: { day: 1, night: 1 } };
  if (kind === 'transformer') return { typical: { day: 1, night: 1 }, maintenance: { day: 1, night: 1 }, emergency: { day: 0, night: 0 } };
  return { typical: { day: 1, night: 1 }, maintenance: { day: 1, night: 1 }, emergency: { day: 1, night: 1 } };
}
function nzDutyOf(src, name, period) {
  const d = src.duty && src.duty[name];
  if (!d) return 1;
  const v = d[period];
  return v == null ? 1 : +v;
}

function nzPrepare(input) {
  const units = input.units === 'ft' ? 'ft' : 'm';
  const toM = units === 'ft' ? NZ_FT : 1;
  const metIn = input.met || {};
  const tempC = metIn.tempC != null ? +metIn.tempC : 10;
  const rh = metIn.rh != null ? +metIn.rh : 70;
  const pressure = metIn.pressureKPa != null ? +metIn.pressureKPa : 101.325;
  const c = metIn.speed != null ? +metIn.speed : nzSpeed(tempC);
  const groundIn = input.ground || {};
  const G = groundIn.G != null ? +groundIn.G : 0.5;
  const zones = (groundIn.zones || []).map(function (z) {
    return { ring: z.polygon.map(function (p) { return [p[0] * toM, p[1] * toM]; }), G: +z.G };
  });
  function groundAtPoint(x, y) {
    for (let i = zones.length - 1; i >= 0; i--) if (nzInRing(x, y, zones[i].ring)) return zones[i].G;
    return G;
  }
  const terrain = nzPrepareTerrain(input.terrain, toM);
  function groundZ(x, y) {
    if (!terrain) return input.groundZ != null ? input.groundZ * toM : 0;
    const z = nzTerrainAt(terrain, x, y);
    return z == null ? 0 : z;
  }
  const alpha = NZ_BANDS.map(function (f) { return nzAlpha(f, tempC, rh, pressure); });
  const aw = NZ_BANDS.map(nzDbA), cw = NZ_BANDS.map(nzDbC);
  const model = {
    units: units, toM: toM, fromM: 1 / toM, tempC: tempC, rh: rh, pressure: pressure, c: c,
    G: G, gAssumed: groundIn.G == null, metAssumed: metIn.tempC == null || metIn.rh == null,
    alpha: alpha, aw: aw, cw: cw, terrain: terrain,
    groundZ: groundZ,
    groundAt: function (src, rec, t) {
      if (!zones.length) return G;
      return groundAtPoint(src.x + (rec.x - src.x) * t, src.y + (rec.y - src.y) * t);
    }
  };
  const sources = (input.sources || []).map(function (s, i) { return nzPrepSource(s, i, toM); });
  const receptors = (input.receptors || []).map(function (r, i) { return nzPrepPoint(r, i, toM, 1.5); });
  const barriers = (input.barriers || []).map(function (b) { return nzPrepBarrier(b, toM); }).filter(Boolean);
  return { model: model, sources: sources, receptors: receptors, barriers: barriers, raw: input };
}
function nzPrepSource(s, i, toM) {
  if (!s.lw || s.lw.length !== 8) throw new Error('source ' + (s.id || i) + ' needs eight octave-band Lw values (63 Hz–8 kHz); pass null for a silent band');
  return {
    id: s.id || ('s' + (i + 1)),
    kind: s.kind || 'source',
    name: s.name || s.id || ('Source ' + (i + 1)),
    x: s.x * toM, y: s.y * toM, z: s.z != null ? s.z * toM : nzDefaultHeight(s.kind),
    lw: s.lw.slice(),
    dc: s.dc || null,
    amisc: s.amisc || null,
    duty: s.duty || nzDefaultDuty(s.kind || ''),
    assumed: !!s.assumed,
    tag: s.tag || (s.assumed ? 'ASSUMED' : 'INPUT'),
    cite: s.cite || '',
    sensitive: !!s.sensitive
  };
}
function nzPrepPoint(r, i, toM, zDefaultM) {
  return {
    id: r.id || ('r' + (i + 1)),
    name: r.name || r.id || ('Receptor ' + (i + 1)),
    kind: r.kind || 'receptor',
    x: r.x * toM, y: r.y * toM,
    z: r.z != null ? r.z * toM : zDefaultM,
    xyIn: [r.x, r.y]
  };
}
function nzPrepBarrier(b, toM) {
  if (b.kind === 'building' && b.polygon && b.polygon.length >= 3) {
    return { id: b.id || 'building', kind: 'building', polygon: b.polygon.map(function (p) { return [p[0] * toM, p[1] * toM]; }), roofZ: (b.roofZ != null ? b.roofZ : b.height || 0) * toM };
  }
  if (b.line && b.line.length >= 2) {
    return {
      id: b.id || 'berm', kind: b.kind || 'berm',
      line: b.line.map(function (p) { return p.length > 2 ? [p[0] * toM, p[1] * toM, p[2] * toM] : [p[0] * toM, p[1] * toM]; }),
      z: (b.z != null ? b.z : b.height || 0) * toM,
      length_m: b.length_m
    };
  }
  return null;
}
function nzPrepareTerrain(t, toM) {
  if (!t || !t.z || !t.nx) return null;
  return { xmin: t.xmin * toM, ymin: t.ymin * toM, dx: t.dx * toM, dy: t.dy * toM, nx: t.nx, ny: t.ny, z: t.z.map(function (v) { return v == null ? null : v * toM; }) };
}
function nzActive(sources, name, period) {
  const out = [];
  for (let i = 0; i < sources.length; i++) {
    const f = nzDutyOf(sources[i], name, period);
    if (!(f > 0)) continue;
    if (f >= 0.999) { out.push(sources[i]); continue; }
    const add = 10 * Math.log10(f);
    const copy = Object.assign({}, sources[i], { lw: sources[i].lw.map(function (v) { return v == null ? null : v + add; }) });
    out.push(copy);
  }
  return out;
}

// Full-precision single-point level. scenario is 'typical_day' or {name, period}.
function nzLevelAt(input, x, y, scenario, z) {
  const prep = nzPrepare(input);
  const key = nzScenarioKey(scenario);
  const active = nzActive(prep.sources, key.name, key.period);
  const zM = z != null ? z * prep.model.toM : (input.grid && input.grid.height_m != null ? +input.grid.height_m : 1.5);
  const rec = { id: 'pt', x: x * prep.model.toM, y: y * prep.model.toM, z: zM };
  return nzAtReceiver(active, rec, prep);
}
function nzScenarioKey(scenario) {
  if (scenario && scenario.name) return scenario;
  const id = scenario || 'typical_day';
  const parts = String(id).split('_');
  return { name: parts[0], period: parts[1] || 'day', id: id };
}
function nzAtReceiver(active, rec, prep) {
  if (!active.length) return { dBA: null, dBC: null, distance_m: null, bands: null, pairs: [] };
  const pairs = active.map(function (src) {
    const obstacles = nzObstacles(src, rec, prep.barriers, prep.model.terrain);
    return nzEvalPair(src, rec, obstacles, prep.model);
  });
  const sum = nzSumPairs(pairs, prep.model);
  let nearest = null;
  for (let i = 0; i < pairs.length; i++) if (nearest == null || pairs[i].distance_m < nearest) nearest = pairs[i].distance_m;
  return { dBA: sum.dBA, dBC: sum.dBC, lp: sum.lp, distance_m: nearest, pairs: pairs };
}

// Propagate one source to one receiver and return every term, unrounded.
function nzPropagate(spec) {
  const prep = nzPrepare({
    units: spec.units || 'm',
    sources: [spec.source],
    met: spec.met, ground: spec.ground, groundZ: spec.groundZ,
    barriers: spec.barriers || [], terrain: spec.terrain
  });
  const src = prep.sources[0];
  const rec = nzPrepPoint(spec.receiver, 0, prep.model.toM, 1.5);
  const obstacles = nzObstacles(src, rec, prep.barriers, prep.model.terrain);
  const ev = nzEvalPair(src, rec, obstacles, prep.model);
  return { dBA: ev.dBA, dBC: ev.dBC, distance_m: ev.distance_m, bands: ev.bands, c: prep.model.c, alpha: prep.model.alpha };
}

// ---- grid, contours, receptor table ----------------------------------------

function nzScreen(input) {
  const prep = nzPrepare(input || {});
  const bounds = nzBounds(input, prep);
  const spacingM = input.grid && input.grid.spacing_m ? +input.grid.spacing_m : 15;
  const heightM = input.grid && input.grid.height_m != null ? +input.grid.height_m : 1.5;
  const xmin = bounds.xmin, ymin = bounds.ymin, xmax = bounds.xmax, ymax = bounds.ymax;
  const nx = Math.max(2, Math.floor((xmax - xmin) / spacingM) + 1);
  const ny = Math.max(2, Math.floor((ymax - ymin) / spacingM) + 1);
  const dx = nx > 1 ? (xmax - xmin) / (nx - 1) : spacingM;
  const dy = ny > 1 ? (ymax - ymin) / (ny - 1) : spacingM;
  const nPt = nx * ny;
  const wanted = (input.scenarios && input.scenarios.length)
    ? input.scenarios.map(function (s) { const k = nzScenarioKey(s); return [k.name, k.period]; })
    : NZ_SCENARIOS;
  const nEval = nPt * Math.max(1, prep.sources.length) * wanted.length;
  if (nEval > 5e6) throw new Error('noise grid is ' + nEval + ' source-points; raise spacing_m or shrink the bounds (cap 5e6)');
  const metrics = input.contourMetrics || ['dBA', 'dBC'];
  const limits = input.limits || {};
  const ambient = input.ambient || null;
  const scenarios = {};
  const wide = prep.receptors.map(function (r) {
    return {
      id: r.id, name: r.name, kind: r.kind,
      x: r.xyIn[0], y: r.xyIn[1], z: r.z * prep.model.fromM,
      distance_m: null, distance_ft: null, nearestSource: null,
      epaGuideline_dBA: NZ_EPA_DBA,
      epaNote: 'EPA 1974 55 dBA Ldn guideline, not a local limit',
      ambient_L90: ambient && ambient.L90 != null ? ambient.L90 : null,
      ambient_L10: ambient && ambient.L10 != null ? ambient.L10 : null,
      ambientNote: ambient && (ambient.L90 != null || ambient.L10 != null) ? (ambient.source || 'measured') : 'TBD (not measured)',
      label: NZ_LABEL,
      levels: {}
    };
  });
  // Distance is to the nearest catalogued source, whether or not that source is on.
  prep.receptors.forEach(function (r, ri) {
    let best = null, who = null;
    for (let s = 0; s < prep.sources.length; s++) {
      const d = Math.hypot(prep.sources[s].x - r.x, prep.sources[s].y - r.y);
      if (best == null || d < best) { best = d; who = prep.sources[s].id; }
    }
    wide[ri].distance_m = best == null ? null : nzRound1(best);
    wide[ri].distance_ft = best == null ? null : nzRound1(best / NZ_FT);
    wide[ri].nearestSource = who;
  });
  const cache = new Map();
  function obstaclesFor(src, rec) {
    const k = src.id + '|' + rec.id;
    let g = cache.get(k);
    if (!g) { g = nzObstacles(src, rec, prep.barriers, prep.model.terrain); cache.set(k, g); }
    return g;
  }
  wanted.forEach(function (sc) {
    const name = sc[0], period = sc[1], id = name + '_' + period;
    const active = nzActive(prep.sources, name, period);
    const dBA = new Array(nPt), dBC = new Array(nPt);
    for (let p = 0; p < nPt; p++) {
      const i = p % nx, j = (p - i) / nx;
      const rec = { id: 'g' + p, x: xmin + i * dx, y: ymin + j * dy, z: heightM + prep.model.groundZ(xmin + i * dx, ymin + j * dy) };
      if (!active.length) { dBA[p] = null; dBC[p] = null; continue; }
      const pairs = active.map(function (src) { return nzEvalPair(src, rec, obstaclesFor(src, rec), prep.model); });
      const sum = nzSumPairs(pairs, prep.model);
      dBA[p] = nzRound1(sum.dBA);
      dBC[p] = nzRound1(sum.dBC);
    }
    const recRows = prep.receptors.map(function (r, ri) {
      const hit = active.length ? nzSumPairs(active.map(function (src) { return nzEvalPair(src, r, obstaclesFor(src, r), prep.model); }), prep.model) : { dBA: null, dBC: null };
      const lim = period === 'night' ? (limits.night || {}) : (limits.day || {});
      const row = {
        id: r.id, name: r.name, kind: r.kind,
        distance_m: wide[ri].distance_m, distance_ft: wide[ri].distance_ft,
        dBA: nzRound1(hit.dBA), dBC: nzRound1(hit.dBC),
        limit_dBA: lim.dBA != null ? lim.dBA : null,
        limit_dBC: lim.dBC != null ? lim.dBC : null,
        limitTag: lim.dBA != null || lim.dBC != null ? (lim.tag || 'TBD (source)') : null,
        margin_dBA: lim.dBA != null && hit.dBA != null ? nzRound1(lim.dBA - hit.dBA) : null,
        margin_dBC: lim.dBC != null && hit.dBC != null ? nzRound1(lim.dBC - hit.dBC) : null,
        margin_epa: hit.dBA != null ? nzRound1(NZ_EPA_DBA - hit.dBA) : null,
        label: NZ_LABEL
      };
      wide[ri].levels[id] = { dBA: row.dBA, dBC: row.dBC, limit_dBA: row.limit_dBA, limit_dBC: row.limit_dBC, limitTag: row.limitTag, margin_dBA: row.margin_dBA, margin_dBC: row.margin_dBC, margin_epa: row.margin_epa };
      return row;
    });
    const fromM = prep.model.fromM;
    scenarios[id] = {
      id: id, name: name.charAt(0).toUpperCase() + name.slice(1), period: period,
      label: NZ_LABEL,
      grid: {
        spacing_m: spacingM, height_m: heightM, nx: nx, ny: ny,
        xmin: xmin * fromM, ymin: ymin * fromM, dx: dx * fromM, dy: dy * fromM,
        dBA: dBA, dBC: dBC
      },
      contours: {
        dBA: metrics.indexOf('dBA') >= 0 ? nzContourFC(dBA, nx, ny, xmin * fromM, ymin * fromM, dx * fromM, dy * fromM, id, 'dBA') : emptyFC(),
        dBC: metrics.indexOf('dBC') >= 0 ? nzContourFC(dBC, nx, ny, xmin * fromM, ymin * fromM, dx * fromM, dy * fromM, id, 'dBC') : emptyFC()
      },
      receptors: recRows
    };
  });
  return {
    label: NZ_LABEL,
    origin: 'edifice',
    method: 'ISO 9613-2:1996',
    propagation: 'downwind',
    bandsHz: NZ_BANDS.slice(),
    units: prep.model.units,
    legend: nzLegend(),
    limitsNote: 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY. ISO 9613-2:1996 downwind octave bands. Directivity is omnidirectional (Dc = 0) unless a source supplies Dc. Ground is the general method on approximately flat ground. Diffraction is the top edge only, for the one or two obstacles that block the most; sound around the ends of a finite barrier is not added. The 1996 barrier formula still returns up to about 4.8 dB at a grazing edge. No measured ambient is invented.',
    assumptions: nzAssumptions(prep, input),
    equipment: prep.sources.map(function (s) {
      return { id: s.id, kind: s.kind, name: s.name, x: s.x * prep.model.fromM, y: s.y * prep.model.fromM, z: s.z * prep.model.fromM, lw: s.lw.map(nzRound1), duty: s.duty, assumed: s.assumed, tag: s.tag, cite: s.cite, sensitive: s.sensitive };
    }),
    scenarios: scenarios,
    receptors: wide
  };
}
function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
function nzLegend() {
  return [
    { max: 45, label: '≤45', color: '#d7efe3' },
    { min: 45, max: 50, label: '45–50', color: NZ_CONTOUR_COLOR[45] },
    { min: 50, max: 55, label: '50–55', color: NZ_CONTOUR_COLOR[50] },
    { min: 55, max: 60, label: '55–60', color: NZ_CONTOUR_COLOR[55] },
    { min: 60, max: 65, label: '60–65', color: NZ_CONTOUR_COLOR[60] },
    { min: 65, max: 70, label: '65–70', color: NZ_CONTOUR_COLOR[65] },
    { min: 70, max: 75, label: '70–75', color: NZ_CONTOUR_COLOR[70] },
    { min: 75, label: '>75', color: NZ_CONTOUR_COLOR[75] }
  ];
}
function nzContourFC(values, nx, ny, xmin, ymin, dx, dy, scenario, metric) {
  if (typeof isoLines !== 'function') return emptyFC();
  const groups = isoLines(values, nx, ny, xmin, ymin, dx, dy, NZ_CONTOUR_DB);
  return isoFeatureCollection(groups, function (level) {
    return { level: level, metric: metric, scenario: scenario, color: NZ_CONTOUR_COLOR[level] || '#333', label: NZ_LABEL };
  });
}
function nzBounds(input, prep) {
  if (input.grid && input.grid.xmin != null) {
    const g = input.grid, toM = prep.model.toM;
    return { xmin: g.xmin * toM, ymin: g.ymin * toM, xmax: g.xmax * toM, ymax: g.ymax * toM };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  function add(x, y) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  prep.sources.forEach(function (s) { add(s.x, s.y); });
  prep.receptors.forEach(function (r) { add(r.x, r.y); });
  prep.barriers.forEach(function (b) {
    (b.polygon || b.line || []).forEach(function (p) { add(p[0], p[1]); });
  });
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 300; y1 = 300; }
  const pad = 150;
  return { xmin: x0 - pad, ymin: y0 - pad, xmax: x1 + pad, ymax: y1 + pad };
}
function nzAssumptions(prep, input) {
  const rows = [];
  if (prep.model.metAssumed) rows.push({ tag: 'ASSUMED', item: 'Air', value: prep.model.tempC + ' °C, ' + prep.model.rh + '% RH, ' + prep.model.pressure + ' kPa', note: 'ISO 9613-1 coefficients. Replace with the design day the acoustician specifies.' });
  if (prep.model.gAssumed) rows.push({ tag: 'ASSUMED', item: 'Ground factor G', value: prep.model.G, note: 'Uniform ground, general method. 0 is hard, 1 is porous. Zones may override G.' });
  rows.push({ tag: 'METHOD', item: 'Propagation', value: 'downwind', note: 'ISO 9613-2 favourable conditions. Long-term Cmet is not applied.' });
  rows.push({ tag: 'METHOD', item: 'Directivity', value: 'Dc = 0 unless supplied', note: 'Lw is free-field sound power into 4π. Do not also add 3 dB for hemispherical radiation; ground reflection is in Agr.' });
  rows.push({ tag: 'METHOD', item: 'Operating states', value: 'Exhibit B §2.1', note: 'Typical: generators off. Maintenance: one genset, daytime. Emergency: gensets on and substation transformers off. The stated 80% emergency load is not applied; that spectrum was not published. Day and night are the same equipment state unless a source duty says otherwise. Exhibit B has no day/night split.' });
  (input.sources || []).forEach(function (s) {
    if (s.assumed || s.tag === 'ASSUMED') rows.push({ tag: 'ASSUMED', item: (s.name || s.id || s.kind) + ' Lw', value: 'octave bands', note: s.cite || 'Default library spectrum.' });
  });
  if (!input.ambient || (input.ambient.L90 == null && input.ambient.L10 == null)) rows.push({ tag: 'TBD', item: 'Ambient L90 / L10', value: null, note: 'Not measured. Printed as TBD. Nothing is estimated.' });
  return rows;
}

// ---- consultant grid ----------------------------------------------------------

function nzImportGrid(text, opts) {
  opts = opts || {};
  const firm = (opts.firm || 'consultant').trim() || 'consultant';
  const parsed = nzParseImport(text, opts);
  const label = 'MODEL BY ' + firm;
  let contours = emptyFC();
  if (parsed.lattice) {
    const g = parsed.lattice;
    contours = typeof isoLines === 'function'
      ? isoFeatureCollection(isoLines(g.dBA, g.nx, g.ny, g.xmin, g.ymin, g.dx, g.dy, NZ_CONTOUR_DB), function (level) {
        return { level: level, metric: 'dBA', scenario: parsed.scenario || 'imported', color: NZ_CONTOUR_COLOR[level] || '#333', label: label };
      })
      : emptyFC();
  }
  return {
    label: label,
    origin: 'import',
    firm: firm,
    method: 'imported grid',
    scenario: parsed.scenario || null,
    note: parsed.lattice ? 'Contours traced from the imported lattice. Not recomputed by the Edifice screening model.' : 'Points are not on a regular lattice, so contours were not traced.',
    lattice: !!parsed.lattice,
    grid: parsed.lattice ? { xmin: parsed.lattice.xmin, ymin: parsed.lattice.ymin, dx: parsed.lattice.dx, dy: parsed.lattice.dy, nx: parsed.lattice.nx, ny: parsed.lattice.ny, dBA: parsed.lattice.dBA, dBC: parsed.lattice.dBC } : null,
    contours: contours,
    points: parsed.points
  };
}
function nzParseImport(text, opts) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) throw new Error('empty consultant grid');
  if (opts.format === 'geojson' || raw[0] === '{' || raw[0] === '[') return nzParseGeoJSON(raw);
  return nzParseCSV(raw);
}
function nzParseCSV(text) {
  const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.trim()[0] !== '#'; });
  if (!lines.length) throw new Error('CSV has no rows');
  const head = lines[0].split(',').map(function (s) { return s.trim().toLowerCase(); });
  const ix = nzCol(head, ['x', 'easting', 'lon', 'longitude']);
  const iy = nzCol(head, ['y', 'northing', 'lat', 'latitude']);
  const ia = nzCol(head, ['dba', 'lpa', 'laeq', 'db']);
  if (ix < 0 || iy < 0 || ia < 0) throw new Error('CSV needs columns x, y and dBA');
  const ic = nzCol(head, ['dbc', 'lpc']);
  const isc = nzCol(head, ['scenario', 'case']);
  const points = [];
  let scenario = null;
  for (let i = 1; i < lines.length; i++) {
    const c = nzSplitCSV(lines[i]);
    const x = +c[ix], y = +c[iy], dBA = +c[ia];
    if (!isFinite(x) || !isFinite(y) || !isFinite(dBA)) throw new Error('CSV row ' + (i + 1) + ' is not numeric');
    const dBC = ic >= 0 && c[ic] !== '' && c[ic] != null ? +c[ic] : null;
    if (isc >= 0 && c[isc]) scenario = scenario || c[isc];
    points.push({ x: x, y: y, dBA: dBA, dBC: dBC == null || !isFinite(dBC) ? null : dBC });
  }
  return { points: points, lattice: nzLattice(points), scenario: scenario };
}
function nzCol(head, names) {
  for (let i = 0; i < names.length; i++) { const k = head.indexOf(names[i]); if (k >= 0) return k; }
  return -1;
}
function nzSplitCSV(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function nzParseGeoJSON(text) {
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('GeoJSON is not valid JSON'); }
  const features = json.type === 'FeatureCollection' ? json.features : json.type === 'Feature' ? [json] : null;
  if (!features) throw new Error('GeoJSON must be a Feature or FeatureCollection');
  if (features.length === 1 && features[0].properties && features[0].properties.dBA && features[0].properties.nx) {
    const p = features[0].properties;
    const dBA = p.dBA, nx = p.nx, ny = p.ny;
    if (!dBA || dBA.length !== nx * ny) throw new Error('GeoJSON grid dBA length does not match nx*ny');
    const points = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) points.push({ x: p.xmin + i * p.dx, y: p.ymin + j * p.dy, dBA: dBA[j * nx + i], dBC: p.dBC ? p.dBC[j * nx + i] : null });
    return { points: points, lattice: { xmin: p.xmin, ymin: p.ymin, dx: p.dx, dy: p.dy, nx: nx, ny: ny, dBA: dBA.slice(), dBC: p.dBC || null }, scenario: p.scenario || null };
  }
  const points = [];
  let scenario = null;
  features.forEach(function (f) {
    const g = f.geometry || {};
    if (g.type !== 'Point') return;
    const props = f.properties || {};
    const dBA = props.dBA != null ? +props.dBA : props.LpA != null ? +props.LpA : props.dba != null ? +props.dba : null;
    if (dBA == null || !isFinite(dBA)) return;
    scenario = scenario || props.scenario || null;
    const dBC = props.dBC != null ? +props.dBC : props.LpC != null ? +props.LpC : null;
    points.push({ x: g.coordinates[0], y: g.coordinates[1], dBA: dBA, dBC: dBC != null && isFinite(dBC) ? dBC : null });
  });
  if (!points.length) throw new Error('GeoJSON has no Point features with dBA');
  return { points: points, lattice: nzLattice(points), scenario: scenario };
}
function nzLattice(points) {
  const xs = [], ys = [];
  function add(list, v) { for (let i = 0; i < list.length; i++) if (Math.abs(list[i] - v) < 1e-6) return; list.push(v); }
  points.forEach(function (p) { add(xs, p.x); add(ys, p.y); });
  xs.sort(function (a, b) { return a - b; }); ys.sort(function (a, b) { return a - b; });
  if (xs.length < 2 || ys.length < 2 || xs.length * ys.length !== points.length) return null;
  const dx = xs[1] - xs[0], dy = ys[1] - ys[0];
  for (let i = 2; i < xs.length; i++) if (Math.abs(xs[i] - xs[0] - i * dx) > Math.abs(dx) * 1e-3 + 1e-6) return null;
  for (let i = 2; i < ys.length; i++) if (Math.abs(ys[i] - ys[0] - i * dy) > Math.abs(dy) * 1e-3 + 1e-6) return null;
  const dBA = new Array(xs.length * ys.length), dBC = new Array(xs.length * ys.length);
  let anyC = false;
  points.forEach(function (p) {
    let i = 0, j = 0;
    while (Math.abs(xs[i] - p.x) > 1e-6) i++;
    while (Math.abs(ys[j] - p.y) > 1e-6) j++;
    dBA[j * xs.length + i] = p.dBA;
    dBC[j * xs.length + i] = p.dBC;
    if (p.dBC != null) anyC = true;
  });
  if (dBA.some(function (v) { return v == null || !isFinite(v); })) return null;
  return { xmin: xs[0], ymin: ys[0], dx: dx, dy: dy, nx: xs.length, ny: ys.length, dBA: dBA, dBC: anyC ? dBC : null };
}

// Footprints within 1 mile. The receptor sits on the ring point closest to the site.
function nzReceptorsFromFootprints(footprints, origin, opts) {
  opts = opts || {};
  const units = opts.units === 'ft' ? 'ft' : 'm';
  const toM = units === 'ft' ? NZ_FT : 1;
  const radius = opts.radius_m != null ? opts.radius_m : 1609.344;
  const ox = origin[0], oy = origin[1];
  const out = [];
  (footprints || []).forEach(function (f, i) {
    const ring = f.ring || f.polygon || [];
    if (ring.length < 3) return;
    let best = null, bd = Infinity, cx = 0, cy = 0;
    ring.forEach(function (p) {
      cx += p[0]; cy += p[1];
      const d = Math.hypot((p[0] - ox) * toM, (p[1] - oy) * toM);
      if (d < bd) { bd = d; best = p; }
    });
    if (bd > radius) return;
    out.push({ id: f.id || ('fp' + (i + 1)), name: f.name || f.kind || 'Residence', kind: f.kind || 'residence', x: best[0], y: best[1], z: f.z != null ? f.z : (units === 'ft' ? 1.5 / NZ_FT : 1.5), distance_m: bd });
  });
  return out;
}

// Layout adapter. Rects are in the solver's rotated frame; C.un returns world feet.
// All equipment levels are the ASSUMED library. Only the first genset runs in the
// daytime maintenance test. Halls are barriers. Berms are used when the layout has them.
function nzFromPlan(layout, opts) {
  opts = opts || {};
  const un = layout && layout.C && layout.C.un ? function (p) { return layout.C.un(p); } : function (p) { return p; };
  const heightFt = layout && layout.height ? +layout.height : 42;
  const sources = [], barriers = [];
  const gensets = [];
  (layout.halls || []).forEach(function (h, i) {
    const ring = nzWorldRing(h.hall, un);
    if (ring) {
      barriers.push({ id: 'hall' + (i + 1), kind: 'building', polygon: ring, roofZ: heightFt, height: heightFt });
      const lib = nzLibrarySpectrum('facade');
      const drop = 10 * Math.log10(0.25);
      const lw = lib.lw.map(function (v) { return v + drop; });
      nzFacadePoints(ring, heightFt * 0.6).forEach(function (p, k) {
        sources.push(nzEquipment('facade', { id: 'hall' + (i + 1) + '-facade-' + k, name: 'Hall ' + (i + 1) + ' facade', x: p[0], y: p[1], z: p[2], lw: lw, assumed: true, cite: lib.cite }));
      });
    }
    if (h.gen) {
      const g = nzWorldRing(h.gen, un);
      const c = nzCentroid(g);
      const off = 2 / NZ_FT;
      gensets.push(nzEquipment('genset_enclosed', { id: 'hall' + (i + 1) + '-genset', name: 'Hall ' + (i + 1) + ' genset', x: c[0] - off, y: c[1], z: 2 / NZ_FT }));
      sources.push(nzEquipment('dry_cooler', { id: 'hall' + (i + 1) + '-cooler', name: 'Hall ' + (i + 1) + ' dry cooler', x: c[0] + off, y: c[1], z: 3.5 / NZ_FT }));
    }
  });
  gensets.forEach(function (g, i) {
    if (i > 0) g.duty = { typical: { day: 0, night: 0 }, maintenance: { day: 0, night: 0 }, emergency: { day: 1, night: 1 } };
    sources.push(g);
  });
  if (layout.sub) {
    const c = nzCentroid(nzWorldRing(layout.sub, un));
    sources.push(nzEquipment('transformer', { id: 'sub-transformer', name: 'Substation transformer', x: c[0], y: c[1], z: 3 / NZ_FT }));
  }
  (layout.berms || []).forEach(function (b, i) {
    if (!b.line || b.line.length < 2) return;
    const line = b.line.map(function (p) { return b.frame === 'rotated' ? un(p) : p.slice(); });
    barriers.push({ id: b.id || ('berm' + (i + 1)), kind: 'berm', line: line, height: b.height_ft != null ? b.height_ft : b.height, z: b.z_ft != null ? b.z_ft : (b.height_ft != null ? b.height_ft : b.height) });
  });
  const receptors = (layout.receptors || []).map(function (r) { return Object.assign({ kind: r.kind || 'residence' }, r); });
  return {
    units: 'ft',
    sources: sources,
    barriers: barriers,
    receptors: opts.receptors || receptors,
    ground: opts.ground || { G: 0.5 },
    met: opts.met || { tempC: 10, rh: 70 },
    limits: opts.limits || null,
    ambient: opts.ambient || null,
    grid: opts.grid || null,
    contourMetrics: opts.contourMetrics || ['dBA', 'dBC']
  };
}
function nzWorldRing(rect, un) {
  if (!rect) return null;
  const x = rect[0], y = rect[1], w = rect[2], h = rect[3];
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(function (p) { const q = un(p); return [q[0], q[1]]; });
}
function nzCentroid(ring) {
  let x = 0, y = 0;
  ring.forEach(function (p) { x += p[0]; y += p[1]; });
  return [x / ring.length, y / ring.length];
}
function nzFacadePoints(ring, zFt) {
  const c = nzCentroid(ring);
  const pts = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    let nx = -dy / L, ny = dx / L;
    if ((c[0] - mx) * nx + (c[1] - my) * ny > 0) { nx = -nx; ny = -ny; }
    const off = 1 / NZ_FT;
    pts.push([mx + nx * off, my + ny * off, zFt]);
  }
  return pts;
}

// ---- worker -------------------------------------------------------------------

function nzWorkerSource() {
  const head = [
    'const NZ_LABEL=' + JSON.stringify(NZ_LABEL),
    'const NZ_BANDS=' + JSON.stringify(NZ_BANDS),
    'const NZ_CONTOUR_DB=' + JSON.stringify(NZ_CONTOUR_DB),
    'const NZ_CONTOUR_COLOR=' + JSON.stringify(NZ_CONTOUR_COLOR),
    'const NZ_EPA_DBA=' + NZ_EPA_DBA,
    'const NZ_FT=' + NZ_FT,
    'const NZ_SCENARIOS=' + JSON.stringify(NZ_SCENARIOS),
    'const NZ_LIBRARY=' + JSON.stringify(NZ_LIBRARY)
  ].join(';\n') + ';\n';
  const fns = [nzDbA, nzDbC, nzWeightA, nzWeightC, nzSumDb, nzRound1, nzAlpha, nzSpeed, nzAdiv, nzQ, nzAprime, nzBprime, nzCprime, nzDprime, nzEndRegion, nzMidRegion, nzAgr, nzC3, nzDz, nzDist3, nzInRing, nzBlocks, nzSingleGeom, nzDoubleGeom, nzSegT, nzWidthNormal, nzLineLength, nzObstacles, nzTerrainAt, nzTerrainPoint, nzPickGeomResolved, nzEvalPair, nzSumPairs, nzScaleSpectrum, nzLibrarySpectrum, nzEquipment, nzDefaultHeight, nzDefaultDuty, nzDutyOf, nzPrepare, nzPrepSource, nzPrepPoint, nzPrepBarrier, nzPrepareTerrain, nzActive, nzLevelAt, nzScenarioKey, nzAtReceiver, nzPropagate, nzScreen, emptyFC, nzLegend, nzContourFC, nzBounds, nzAssumptions, nzImportGrid, nzParseImport, nzParseCSV, nzCol, nzSplitCSV, nzParseGeoJSON, nzLattice, nzReceptorsFromFootprints, nzFromPlan, nzWorldRing, nzCentroid, nzFacadePoints];
  const iso = (typeof isoLines === 'function') ? [isoLines, isoSegments, isoStitch, isoFeatureCollection, round6].map(function (f) { return f.toString(); }).join('\n') : 'function isoLines(){return[]}function isoFeatureCollection(){return{type:"FeatureCollection",features:[]}}\n';
  return head + iso + '\n' + fns.map(function (f) { return f.toString(); }).join('\n') + '\nonmessage=function(ev){var m=ev.data||{};if(m.type!=="screen"&&m.type!=="import")return;try{var output=m.type==="import"?nzImportGrid(m.text,m.opts||{}):nzScreen(m.input);postMessage({type:"result",id:m.id,output:output})}catch(err){postMessage({type:"error",id:m.id,message:String(err&&err.message||err)})}};';
}
function nzScreenAsync(input) {
  if (typeof Worker === 'undefined') return Promise.resolve(nzScreen(input));
  return nzRunWorker({ type: 'screen', input: input });
}
function nzRunWorker(message) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(new Blob([nzWorkerSource()], { type: 'text/javascript' }));
    const w = new Worker(url);
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(function () { w.terminate(); URL.revokeObjectURL(url); reject(new Error('noise worker timeout')); }, 120000);
    w.onmessage = function (ev) {
      const m = ev.data || {};
      if (m.id !== id) return;
      clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url);
      if (m.type === 'error') reject(new Error(m.message));
      else resolve(m.output);
    };
    w.onerror = function (e) { clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url); reject(new Error(e.message || 'noise worker failed')); };
    message.id = id;
    w.postMessage(message);
  });
}
