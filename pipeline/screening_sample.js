// Synthetic-site figures for the noise, photometric and line-of-sight modules.
// No parcel, owner or real site. Run: node pipeline/screening_sample.js [outdir]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = __dirname;
if (!global.__SCREEN_SAMPLE) {
  const ctx = {
    console: console, Math: Math, Buffer: Buffer, require: require, process: process, fs: fs, path: path, dir: dir,
    Uint8Array: Uint8Array, Float64Array: Float64Array, Uint32Array: Uint32Array, DataView: DataView,
    ArrayBuffer: ArrayBuffer, JSON: JSON, parseFloat: parseFloat, isFinite: isFinite, parseInt: parseInt,
    Map: Map, Set: Set, Error: Error, Object: Object, Array: Array, String: String, Number: Number, Infinity: Infinity
  };
  ctx.globalThis = ctx;
  ctx.outDir = process.argv[2] || path.join(dir, 'tests', 'fixtures', 'screening');
  vm.createContext(ctx);
  const libs = ['screening.js', 'screening_draw.js', 'noise.js', 'photometric.js', 'los.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const parts = fs.readFileSync(__filename, 'utf8').split('/*__SAMPLE__*/');
  const body = parts[parts.length - 1];
  vm.runInContext(libs + '\n' + body, ctx);
  return;
}
/*__SAMPLE__*/
const outDir = globalThis.outDir;
fs.mkdirSync(outDir, { recursive: true });

const PAPER = [250, 248, 242, 255], INK = [28, 28, 26, 255], MUTED = [92, 86, 76, 255], RULE = [210, 204, 192, 255];
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255]; }
function canvas(w, h, rgb) { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255; } return a; }
function save(name, w, h, rgba) { fs.writeFileSync(path.join(outDir, name), sgPng(w, h, rgba)); }
function mapOf(x0, y0, x1, y1, px, py, pw, ph) {
  const s = Math.min(pw / (x1 - x0), ph / (y1 - y0));
  const ox = px + (pw - (x1 - x0) * s) / 2, oy = py + (ph - (y1 - y0) * s) / 2;
  return { X: x => ox + (x - x0) * s, Y: y => oy + ph - (y - y0) * s - (ph - (y1 - y0) * s), s: s };
}
function poly(rgba, W, H, pts, X, Y, rgb) {
  for (let i = 1; i < pts.length; i++) sgLine(rgba, W, H, X(pts[i - 1][0]), Y(pts[i - 1][1]), X(pts[i][0]), Y(pts[i][1]), rgb);
  if (pts.length > 2) sgLine(rgba, W, H, X(pts[pts.length - 1][0]), Y(pts[pts.length - 1][1]), X(pts[0][0]), Y(pts[0][1]), rgb);
}
function bandColor(v) {
  const cols = ['#1b5e20', '#7cb342', '#c0ca33', '#fdd835', '#ffb300', '#f4511e', '#c62828', '#6a1b9a'];
  const edges = [45, 50, 55, 60, 65, 70, 75];
  if (v == null) return [230, 226, 216, 255];
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return hex(cols[i]);
  return hex(cols[7]);
}

function noiseFigure() {
  const W = 1280, H = 860, img = canvas(W, H, PAPER);
  const sources = [
    nzPlace('cooler', 70, 70, {id: 'C1'}), nzPlace('cooler', 110, 70, {id: 'C2'}),
    nzPlace('transformer', 40, 110, {id: 'T1'}), nzPlace('facade', 90, 120, {id: 'F1'}),
    nzPlace('genset', 78, 48, {id: 'G1'}), nzPlace('genset', 102, 48, {id: 'G2'})
  ];
  const receptors = [
    {id: 'R1', kind: 'residence', x: 90, y: -30, h: 1.5, limits: NZ_LIMITS.butler_draft},
    {id: 'R2', kind: 'school', x: 210, y: 80, h: 1.5, limits: NZ_LIMITS.butler_draft}
  ];
  const buildings = [[[20, 90], [160, 90], [160, 150], [20, 150]], [[20, 40], [160, 40], [160, 70], [20, 70]]];
  const out = nzRun({
    sources: sources, receptors: receptors, scenario: 'emergency', period: 'night',
    grid: {x0: -40, y0: -60, x1: 250, y1: 190, step: 15, height: 1.5}
  });
  const g = out.grid, x0 = g.x0.v, y0 = g.y0.v, dx = g.dx.v;
  const M = mapOf(x0, y0, x0 + (g.nx - 1) * dx, y0 + (g.ny - 1) * dx, 36, 78, 860, 700);
  const cs = Math.max(2, dx * M.s);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const x = x0 + i * dx, y = y0 + j * dx;
    sgFill(img, W, H, M.X(x) - cs / 2, M.Y(y) - cs / 2, cs + 0.5, cs + 0.5, bandColor(g.values[j * g.nx + i]));
  }
  for (const lv of out.isolines.levels) for (const seg of lv.segs) sgLine(img, W, H, M.X(seg[0][0]), M.Y(seg[0][1]), M.X(seg[1][0]), M.Y(seg[1][1]), INK);
  for (const b of buildings) poly(img, W, H, b, M.X, M.Y, INK);
  sgText(img, W, H, M.X(90) - 28, M.Y(120) - 8, 'HALL', INK, 1);
  sgText(img, W, H, M.X(90) - 24, M.Y(55) - 8, 'YARD', INK, 1);
  for (const r of out.receptors) {
    const rec = receptors.find(q => q.id === r.id);
    sgFill(img, W, H, M.X(rec.x) - 4, M.Y(rec.y) - 4, 8, 8, [20, 20, 20, 255]);
    const txt = r.id + '  ' + (r.dBA.v == null ? 'TBD' : r.dBA.v.toFixed(1)) + ' dBA';
    sgText(img, W, H, M.X(rec.x) + 8, M.Y(rec.y) - 8, txt, INK, 1);
  }
  sgText(img, W, H, 36, 16, 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY', INK, 1);
  sgText(img, W, H, 36, 40, 'Emergency, night  ·  synthetic site, local metres  ·  15 m grid, 1.5 m high', MUTED, 1);
  let ly = 78;
  const labels = ['<=45', '45-50', '50-55', '55-60', '60-65', '65-70', '70-75', '>75'];
  sgText(img, W, H, 980, ly, 'dBA', INK, 1); ly += 28;
  NZ_LEGEND.forEach((b, i) => { sgFill(img, W, H, 980, ly, 22, 16, hex(b.color)); sgText(img, W, H, 1010, ly - 1, labels[i], INK, 1); ly += 26; });
  ly += 10;
  sgText(img, W, H, 980, ly, 'RECEPTORS', INK, 1); ly += 24;
  for (const r of out.receptors) {
    const line = r.id + '  ' + (r.dBA.v == null ? 'TBD' : r.dBA.v.toFixed(1)) + ' / ' + (r.dBC.v == null ? 'TBD' : r.dBC.v.toFixed(1));
    sgText(img, W, H, 980, ly, line, INK, 1); ly += 18;
    const lim = r.limit_dBA.v == null ? 'limit TBD' : ('lim ' + r.limit_dBA.v + '  ' + (r.pass ? 'PASS' : 'FAIL'));
    sgText(img, W, H, 980, ly, lim, MUTED, 1); ly += 22;
  }
  sgText(img, W, H, 36, H - 36, 'Sound power, G=0.5, 10 C / 70% RH: assumed.  L90/L10: TBD.  Not a sound study.', MUTED, 1);
  save('noise_emergency_night.png', W, H, img);
  return {label: out.label, r1: out.receptors[0], r2: out.receptors[1], assumed: out.equipmentAssumed};
}

function photoFigure() {
  const W = 1280, H = 900, img = canvas(W, H, PAPER);
  const ies = phGenericIes();
  const drive = phAutoPoles({lines: [[[40, 20], [40, 200], [300, 200]], [[40, 70], [280, 70]]], mount: 30, units: 'ft', ies: ies, label: 'LP1'});
  const fixtures = drive.poles.map(p => Object.assign({azimuth: 0, tilt: 0, arrangement: 'single', symbol: 'LP1'}, p));
  const boundary = [[0, 0], [360, 0], [360, 240], [0, 240], [0, 0]];
  const areas = [
    {id: 'drive', kind: 'drive', ring: [[20, 10], [70, 10], [70, 220], [20, 220]]},
    {id: 'yard', kind: 'yard', ring: [[80, 40], [280, 40], [280, 100], [80, 100]]},
    {id: 'hall', kind: 'hall', ring: [[90, 110], [250, 110], [250, 190], [90, 190]]},
    {id: 'substation', kind: 'substation', ring: [[280, 120], [340, 120], [340, 180], [280, 180]]},
    {id: 'gatehouse', kind: 'gatehouse', ring: [[20, 0], [70, 0], [70, 24], [20, 24]]},
    {id: 'lagoon', kind: 'lagoon', ring: [[260, 20], [350, 20], [350, 80], [260, 80]]}
  ];
  const out = phRun({
    units: 'ft', fixtures: fixtures, bounds: {x0: -10, y0: -10, x1: 370, y1: 250}, step: 10, stepSrc: 'method',
    areas: areas, boundary: boundary, limit: PH_LIMITS.shawnee
  });
  const g = out.grid;
  const M = mapOf(-10, -10, 370, 250, 28, 70, 820, 760);
  const fills = {hall: [214, 206, 190, 255], yard: [196, 188, 170, 255], substation: [176, 180, 188, 255], lagoon: [186, 206, 214, 255], drive: [206, 202, 194, 255], gatehouse: [230, 220, 200, 255]};
  // paint calculation cells under the linework
  const dx = g.dx.v, cs = Math.max(2, dx * M.s);
  let max = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) max = Math.max(max, g.values[j * g.nx + i]);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const v = g.values[j * g.nx + i];
    const t = max > 0 ? Math.min(1, v / Math.max(0.5, max * 0.5)) : 0;
    const col = [255 - t * 40 | 0, 236 - t * 80 | 0, 170 - t * 40 | 0, 255];
    const x = g.x0.v + i * dx, y = g.y0.v + j * dx;
    sgFill(img, W, H, M.X(x) - cs / 2, M.Y(y) - cs / 2, cs + 0.5, cs + 0.5, col);
  }
  const isoCol = {0.1: [40, 90, 160, 255], 0.5: [30, 130, 90, 255], 1: [180, 140, 20, 255], 2: [200, 90, 20, 255], 3: [180, 40, 40, 255], 5: [120, 20, 80, 255]};
  for (const a of areas) {
    // filled footprint is the cell wash; stroke the ring
    poly(img, W, H, a.ring, M.X, M.Y, INK);
    const c = a.ring.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
    sgText(img, W, H, M.X(c[0] / a.ring.length) - 28, M.Y(c[1] / a.ring.length) - 8, a.id.toUpperCase(), INK, 1);
  }
  poly(img, W, H, boundary, M.X, M.Y, [20, 20, 20, 255]);
  for (const lv of out.isolines.levels) for (const seg of lv.segs) {
    const col = isoCol[lv.level.v] || INK;
    sgLine(img, W, H, M.X(seg[0][0]), M.Y(seg[0][1]), M.X(seg[1][0]), M.Y(seg[1][1]), col);
  }
  for (const p of fixtures) sgFill(img, W, H, M.X(p.x) - 2, M.Y(p.y) - 2, 5, 5, [20, 40, 80, 255]);
  sgText(img, W, H, 28, 14, 'ILLUSTRATIVE — fixture selection assumed until a lighting designer picks fixtures', INK, 1);
  sgText(img, W, H, 28, 36, 'Synthetic site, local feet  ·  direct component  ·  10 ft grid  ·  generic full-cutoff IES', MUTED, 1);
  let ly = 78;
  sgText(img, W, H, 900, ly, 'ISOLINES (fc)', INK, 1); ly += 24;
  for (const lv of [0.1, 0.5, 1, 2, 3, 5]) { sgFill(img, W, H, 900, ly, 22, 12, isoCol[lv]); sgText(img, W, H, 930, ly - 3, String(lv), INK, 1); ly += 20; }
  ly += 8;
  const sch = out.schedule[0];
  sgText(img, W, H, 900, ly, 'LUMINAIRE SCHEDULE', INK, 1); ly += 22;
  const rows = ['LP1   qty ' + sch.qty.v, 'LLF ' + sch.llf.v.toFixed(2) + '  assumed', Math.round(sch.lumens.v) + ' lm  assumed', sch.watts.v + ' W  assumed', 'mount ' + sch.mount.v + ' ft assumed'];
  for (const line of rows) { sgText(img, W, H, 900, ly, line, INK, 1); ly += 18; }
  ly += 10;
  sgText(img, W, H, 900, ly, 'CALCULATION SUMMARY', INK, 1); ly += 22;
  for (const a of out.summary) {
    const s = a.stats;
    const line = a.id.slice(0, 10).padEnd(11, ' ') + (s.avg.v == null ? '  no pts' : (' avg ' + s.avg.v.toFixed(2)));
    sgText(img, W, H, 900, ly, line, INK, 1); ly += 18;
  }
  ly += 8;
  const pl = out.propertyLine;
  sgText(img, W, H, 900, ly, 'PROPERTY LINE', INK, 1); ly += 20;
  sgText(img, W, H, 900, ly, 'max ' + pl.max.v.toFixed(3) + ' fc', INK, 1); ly += 18;
  sgText(img, W, H, 900, ly, 'limit ' + pl.limit.v.toFixed(1) + ' fc', INK, 1); ly += 18;
  sgText(img, W, H, 900, ly, pl.pass ? 'under the cited limit' : 'over the cited limit', INK, 1);
  sgText(img, W, H, 28, H - 28, 'Illustrative. Spacing = 4 x mounting height, assumed. Reflected light is not included.', MUTED, 1);
  save('photometric_illustrative.png', W, H, img);
  return {label: out.label, max: pl.max.v, limit: pl.limit.v, pass: pl.pass, qty: sch.qty.v, areas: out.summary.map(a => ({id: a.id, avg: a.stats.avg.v, max: a.stats.max.v, min: a.stats.min.v}))};
}

function sectionFigure(section) {
  const W = 1280, H = 560, img = canvas(W, H, PAPER);
  const s = section.samples;
  let d1 = 0, z0 = Infinity, z1 = -Infinity;
  for (const p of s) { d1 = Math.max(d1, p.dist.v); z0 = Math.min(z0, p.ground.v, p.sight.v); z1 = Math.max(z1, p.proposed.v, p.sight.v, p.ground.v); }
  for (const t of section.trees) { z1 = Math.max(z1, t.ground.v + t.mature.v); }
  z0 -= 4; z1 += 8;
  const ve = section.exaggeration.v;
  const px = 70, py = 70, pw = 1120, ph = 400;
  const X = d => px + d / d1 * pw;
  const Y = z => py + ph - (z - z0) / (z1 - z0) * ph;
  sgText(img, W, H, 28, 16, 'LINE OF SIGHT SECTION  ·  synthetic site  ·  ' + section.status, INK, 1);
  sgText(img, W, H, 28, 40, 'Plot fitted to the data. Sheet convention is ' + ve + 'x vertical exaggeration. Clearance is true vertical feet.', MUTED, 1);
  sgLine(img, W, H, px, py + ph, px + pw, py + ph, INK);
  sgLine(img, W, H, px, py, px, py + ph, INK);
  for (let i = 1; i < s.length; i++) {
    sgLine(img, W, H, X(s[i - 1].dist.v), Y(s[i - 1].ground.v), X(s[i].dist.v), Y(s[i].ground.v), [120, 110, 80, 255]);
    sgLine(img, W, H, X(s[i - 1].dist.v), Y(s[i - 1].proposed.v), X(s[i].dist.v), Y(s[i].proposed.v), [90, 70, 40, 255]);
    if (i % 4 === 0) sgLine(img, W, H, X(s[i - 1].dist.v), Y(s[i - 1].sight.v), X(s[i].dist.v), Y(s[i].sight.v), [180, 40, 30, 255]);
  }
  for (let i = 1; i < s.length; i++) sgLine(img, W, H, X(s[i - 1].dist.v), Y(s[i - 1].sight.v), X(s[i].dist.v), Y(s[i].sight.v), [180, 40, 30, 255]);
  sgFill(img, W, H, X(0) - 3, Y(section.eye.z.v) - 3, 6, 6, [180, 40, 30, 255]);
  sgText(img, W, H, X(0) + 8, Y(section.eye.z.v) - 18, 'EYE', [180, 40, 30, 255], 1);
  const last = s[s.length - 1];
  sgLine(img, W, H, X(last.dist.v), Y(last.ground.v), X(last.dist.v), Y(section.roof.z.v), INK);
  sgText(img, W, H, X(last.dist.v) - 46, Y(section.roof.z.v) - 18, 'ROOF', INK, 1);
  for (const t of section.trees) {
    const y1 = t.ground.v + t.year1.v, ym = t.ground.v + t.mature.v;
    sgLine(img, W, H, X(t.dist.v), Y(t.ground.v), X(t.dist.v), Y(y1), [70, 130, 70, 255]);
    sgLine(img, W, H, X(t.dist.v) - 8, Y(y1), X(t.dist.v) + 8, Y(y1), [70, 130, 70, 255]);
    sgLine(img, W, H, X(t.dist.v), Y(t.ground.v), X(t.dist.v), Y(ym), [20, 80, 40, 255]);
  }
  const clr = section.clearance.v;
  sgText(img, W, H, 28, H - 48, section.status + '   clearance ' + (clr == null ? 'TBD' : clr.toFixed(1) + ' ft') + '   distance ' + section.distance.v.toFixed(0) + ' ft', INK, 1);
  sgText(img, W, H, 28, H - 26, 'Brown = berm (3:1, crest assumed).  Green = tree at year 1 and at maturity, growth assumed.  Red = sight line.', MUTED, 1);
  save('los_section.png', W, H, img);
}

function viewFigure(spec, name, caption) {
  const W = 960, H = 540;
  const img = losRender(spec, W, H);
  sgText(img.rgba, W, H, 16, 12, caption, [255, 255, 255, 255], 1);
  sgText(img.rgba, W, H, img.markers.inset[0] + 6, img.markers.inset[1] + 4, 'KEY', INK, 1);
  sgText(img.rgba, W, H, img.markers.north[0] - 14, img.markers.north[1] + 4, 'N', INK, 1);
  sgText(img.rgba, W, H, 12, H - 22, 'EDIFICE LINE-OF-SIGHT SCREENING — tree growth assumed — NOT A SURVEY', [230, 226, 216, 255], 1);
  save(name, W, H, img.rgba);
}

function losFigures() {
  const nx = 34, ny = 24, dx = 20, dy = 20, x0 = -40, y0 = -40;
  const z = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z.push(100 + 0.004 * (y0 + j * dy));
  const dem = {x0: x0, y0: y0, dx: dx, dy: dy, nx: nx, ny: ny, z: z, src: 'synthetic'};
  const boundary = [[0, 0], [520, 0], [520, 360], [0, 360], [0, 0]];
  const building = {id: 'HALL', x: 180, y: 160, w: 160, d: 80, h: 46, hSrc: 'assumed'};
  const berm = {line: [[30, 50], [490, 50]], crest: 8, slope: 3};
  const trees = [];
  for (let x = 50; x <= 470; x += 28) trees.push({species: 'evergreen', x: x, y: 58});
  const gz = 100 + 0.004 * (-80);
  const eye = {x: 260, y: -80, z: gz + 3.5};
  const target = {x: 260, y: 200, z: gz + 16};
  const base = {
    units: 'ft', dem: dem, ground: 100, boundary: boundary, buildings: [building], berms: [berm], trees: trees,
    substation: {x: 60, y: 180, w: 40, d: 28, h: 8}, yards: [{id: 'YARD', x: 180, y: 100, w: 160, d: 40}],
    fences: [{line: [[20, 20], [500, 20], [500, 340], [20, 340], [20, 20]]}],
    eye: eye, target: target, eyeSrc: 'AASHTO driver eye height, 3.5 ft', focal_mm: 35,
    viewpoints: [{id: 'V1', name: 'South entrance', x: 260, y: 0, bearing: 0}], figures: false
  };
  const roof = {x: 260, y: 160, z: 100 + 0.004 * 160 + 46};
  const section = losSection({eye: eye, roof: roof, dem: dem, units: 'ft', berms: [berm], trees: trees, eyeSrc: 'AASHTO driver eye height, 3.5 ft', ground: 100});
  sectionFigure(section);
  const run = losRun({
    eye: eye, roof: roof, dem: dem, units: 'ft', eyeKind: 'driver', ground: 100, berms: [berm], trees: trees,
    building: {ring: [[180, 160], [340, 160], [340, 240], [180, 240]], roofZ: roof.z, h: 46}, boundary: boundary
  });
  const p1 = run.visibility.year1.visiblePct.v.toFixed(0), pM = run.visibility.mature.visiblePct.v.toFixed(0);
  viewFigure(Object.assign({mode: 'existing', year: 1}, base), 'los_existing.png', 'EXISTING  ·  synthetic terrain only');
  viewFigure(Object.assign({mode: 'proposed', year: 1}, base), 'los_proposed_year1.png', 'PROPOSED  ·  YEAR 1  ·  ' + p1 + '% of roofline visible  ·  tree growth assumed');
  viewFigure(Object.assign({mode: 'proposed', year: 18}, base), 'los_proposed_maturity.png', 'PROPOSED  ·  MATURITY  ·  ' + pM + '% of roofline visible  ·  tree growth assumed');
  return {status: section.status, clearance: section.clearance, distance: section.distance, year1: run.visibility.year1.visiblePct, mature: run.visibility.mature.visiblePct, label: run.label};
}

const summary = {site: 'synthetic local coordinates only', noise: noiseFigure(), photometric: photoFigure(), los: losFigures()};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({noise: summary.noise.r1.dBA, photo: {max: summary.photometric.max, qty: summary.photometric.qty}, los: {status: summary.los.status, year1: summary.los.year1, mature: summary.los.mature}}, null, 2));
