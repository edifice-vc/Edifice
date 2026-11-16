// Plan-set export (ARCH D / ARCH E / 11x17). Separate from tfSheet, which stays the on-screen concept sheet.
// Paper units are PDF points (72 pt = 1 inch). Map units are local feet, x east, y north.
// Public mode is the default and drops MW, generator counts, water rates, APNs and owner names.
// Every site-summary number carries a source tag [Z][C][F][N][T][H][O][U][A]. Unknowns print TBD, never a guess.
// SS_CHECKLISTS is injected by render.py (the Shawnee Sec. 39.05 list). Tests inject it the same way.
//
// Other modules fill a reserved sheet without editing this file:
//   ssRegister({no:'NZ-101', title:'NOISE SCREENING', order:80, render:fn})
// fn(ctx, sheet, draw) adds geometry with draw.line / rect / poly / text / clip.
// ctx: r, meta, mode, paper, scale (printed ft per inch), scales.ARCH_D, extent,
//   map {X, Y, ppf} (local feet to paper points), chrome.view, cfg, date, summary, check, ext.
// Paper y is up. Return nothing to keep what you drew, or {ops} to replace the page.
// A sheet with no render stays on the G-001 index and is not exported.
// ssResetRegistry() clears registrations (tests).

const SS_PAPER = {
  ARCH_D: {id: 'ARCH_D', w: 2592, h: 1728, label: 'ARCH D', inch: '36 x 24'},
  ARCH_E: {id: 'ARCH_E', w: 3456, h: 2592, label: 'ARCH E', inch: '48 x 36'},
  TABLOID: {id: 'TABLOID', w: 1224, h: 792, label: '11x17', inch: '17 x 11'}
};
// Standard engineering scales, smallest first, then coarser scales if the site still does not fit.
const SS_SCALES = [20, 30, 40, 50, 60, 100, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000, 3000];
// One pen table for the PDF and the DXF. Layer names and linetypes are the contract the tests check.
const SS_PENS = {
  PAGE: {layer: 'PAGE', lw: 0, rgb: [1, 1, 1], ltype: 'CONTINUOUS', aci: 7},
  BORDER: {layer: 'BORDER', lw: 1.6, rgb: [0.11, 0.11, 0.11], ltype: 'CONTINUOUS', aci: 7},
  TITLE: {layer: 'TITLEBLOCK', lw: 0.6, rgb: [0.11, 0.11, 0.11], ltype: 'CONTINUOUS', aci: 7},
  TEXT: {layer: 'ANNO-TEXT', lw: 0.2, rgb: [0.11, 0.11, 0.11], ltype: 'CONTINUOUS', aci: 7},
  BOUNDARY: {layer: 'BOUNDARY', lw: 1.5, rgb: [0.05, 0.05, 0.05], ltype: 'CONTINUOUS', aci: 7},
  SETBACK: {layer: 'SETBACK', lw: 0.7, rgb: [0.54, 0.38, 0], ltype: 'DASHED', aci: 30, dash: [8, 4]},
  ROW: {layer: 'ROW', lw: 0.6, rgb: [0.75, 0.22, 0.17], ltype: 'DASHED', aci: 1, dash: [3, 3]},
  EASEMENT: {layer: 'EASEMENT-BUFFER', lw: 0.6, rgb: [0.84, 0.15, 0.16], ltype: 'DASHDOT', aci: 1, dash: [10, 3, 2, 3]},
  FLOODPLAIN: {layer: 'FLOODPLAIN', lw: 0.4, rgb: [0.15, 0.55, 0.75], ltype: 'CONTINUOUS', aci: 4},
  STREAM: {layer: 'STREAM', lw: 0.9, rgb: [0.12, 0.44, 0.82], ltype: 'CONTINUOUS', aci: 5},
  CONTOUR: {layer: 'CONTOUR', lw: 0.3, rgb: [0.63, 0.5, 0.35], ltype: 'CONTINUOUS', aci: 32},
  ROAD: {layer: 'ROAD', lw: 0.7, rgb: [0.33, 0.33, 0.33], ltype: 'CONTINUOUS', aci: 8},
  TRANSMISSION: {layer: 'TRANSMISSION', lw: 0.7, rgb: [0.48, 0.17, 0.75], ltype: 'DASHDOT', aci: 6, dash: [12, 3, 2, 3]},
  BUILDING: {layer: 'BUILDING', lw: 0.8, rgb: [0.11, 0.11, 0.11], ltype: 'CONTINUOUS', aci: 7},
  YARD: {layer: 'YARD', lw: 0.5, rgb: [0.29, 0.29, 0.29], ltype: 'CONTINUOUS', aci: 8},
  SUBSTATION: {layer: 'SUBSTATION', lw: 0.7, rgb: [0.35, 0.09, 0.6], ltype: 'CONTINUOUS', aci: 6},
  PARKING: {layer: 'PARKING', lw: 0.5, rgb: [0.4, 0.4, 0.4], ltype: 'CONTINUOUS', aci: 8},
  DETENTION: {layer: 'DETENTION', lw: 0.8, rgb: [0.12, 0.3, 0.47], ltype: 'CONTINUOUS', aci: 5},
  VICINITY: {layer: 'VICINITY', lw: 0.6, rgb: [0.2, 0.2, 0.2], ltype: 'CONTINUOUS', aci: 8},
  SCALEBAR: {layer: 'SCALEBAR', lw: 0.6, rgb: [0, 0, 0], ltype: 'CONTINUOUS', aci: 7}
};
const SS_LTYPES = {
  CONTINUOUS: {desc: 'Solid line', pat: []},
  DASHED: {desc: 'Dashed', pat: [0.5, -0.25]},
  DASHDOT: {desc: 'Dash dot', pat: [0.5, -0.15, 0, -0.15]}
};
const SS_BASE = [
  {no: 'G-001', title: 'COVER AND SHEET INDEX', order: 10, draw: 'cover'},
  {no: 'C-100', title: 'SITE PLAN', order: 20, draw: 'site'},
  {no: 'C-200', title: 'GRADING PLAN', order: 30},
  {no: 'C-300', title: 'UTILITY PLAN', order: 40},
  {no: 'C-400', title: 'PHASING PLAN', order: 50},
  {no: 'L-100', title: 'LANDSCAPE PLAN', order: 60},
  {no: 'E-001', title: 'SITE PHOTOMETRIC', order: 70},
  {no: 'NZ-101', title: 'NOISE SCREENING', order: 80},
  {no: 'V-101', title: 'LINE OF SIGHT', order: 90},
  {no: 'V-201', title: 'MASSING VIEWS', order: 100},
  {no: 'OP-001', title: 'OPERATIONS PLAN', order: 110}
];
let SS_EXTRA = [];
const SS_TAGS = /^[ZCFNTHOUA]$/;
const SS_HIDE = {mw: 1, gen: 1, water: 1, owner: 1, apn: 1};

function ssPaper(id) {return SS_PAPER[id] || SS_PAPER.ARCH_D}
function ssRegister(def) {
  if (!def || !def.no) throw new Error('ssRegister needs a sheet number');
  if (def.render != null && typeof def.render !== 'function') throw new Error('ssRegister render must be a function');
  SS_EXTRA = SS_EXTRA.filter(s => s.no !== def.no).concat([def]);
  return def.no;
}
function ssResetRegistry() {SS_EXTRA = []}
function ssRegistry() {
  const m = new Map(SS_BASE.map(s => [s.no, Object.assign({}, s)]));
  SS_EXTRA.forEach(s => {
    const prev = m.get(s.no) || {};
    m.set(s.no, Object.assign({}, prev, s, {order: s.order != null ? s.order : (prev.order != null ? prev.order : 1000)}));
  });
  return [...m.values()].sort((a, b) => a.order - b.order || String(a.no).localeCompare(String(b.no)));
}
function ssHasDraw(sh) {return typeof sh.render === 'function' || sh.draw === 'cover' || sh.draw === 'site'}
function ssPenTable() {return Object.keys(SS_PENS).map(id => {const p = SS_PENS[id]; return {id, layer: p.layer, ltype: p.ltype, lw: p.lw, aci: p.aci, rgb: p.rgb.slice()}})}
function ssNum(v, d) {return v == null || !isFinite(v) ? null : (d == null ? String(Math.round(v)) : v.toFixed(d))}
function ssAc(v) {const n = ssNum(v, 2); return n == null ? null : n + ' ac'}
function ssSf(v) {return v == null || !isFinite(v) ? null : Math.round(v).toLocaleString('en-US') + ' SF'}

// A summary row. A value that contains a digit must carry a source tag. Assumed values say so.
function ssRow(label, value, tag, assumed, sensitive) {
  tag = String(tag || '');
  if (tag[0] === '[') tag = tag.slice(1, -1);
  if (!SS_TAGS.test(tag)) throw new Error('bad source tag on ' + label);
  const print = label + ': ' + value + ' [' + tag + ']' + (assumed ? ' ASSUMED' : '');
  if (/\d/.test(String(value)) && !SS_TAGS.test(tag)) throw new Error('untagged number on ' + label);
  return {label, value: String(value), tag: '[' + tag + ']', assumed: !!assumed, sensitive: sensitive || '', print};
}
function ssRowsOk(rows) {
  return (rows || []).every(r => r && SS_TAGS.test(String(r.tag || '').replace(/[\[\]]/g, '')) && (!/\d/.test(String(r.value)) || /^\[[ZCFNTHOUA]\]$/.test(r.tag)));
}
function ssHits(text, secrets) {
  const t = String(text || ''), hits = [];
  if (/\bMW\b/.test(t)) hits.push('MW');
  if (/generator/i.test(t)) hits.push('generator');
  if (/\bgpm\b/i.test(t)) hits.push('gpm');
  if (/\bgpd\b/i.test(t)) hits.push('gpd');
  if (/\bgpy\b/i.test(t)) hits.push('gpy');
  (secrets || []).forEach(s => {if (s && String(s).length >= 4 && t.indexOf(String(s)) >= 0) hits.push(String(s))});
  return hits;
}

function ssChrome(paper) {
  const m = 36, tb = Math.round(paper.w * 0.115), head = 22;
  const titleBand = paper.id === 'TABLOID' ? 48 : 62;
  const summary = paper.id === 'TABLOID' ? 168 : 300;
  const view = {
    x: m + summary + 8,
    y: m + titleBand,
    w: paper.w - m - (m + tb) - summary - 16,
    h: paper.h - m - m - titleBand - head
  };
  return {m, tb, head, titleBand, summary, view, tbX: paper.w - m - tb};
}
function ssExtent(r) {
  const R = shOpen((r.C.Q || []).map(r.C.un));
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  R.forEach(p => {x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1])});
  if (!(x1 > x0)) {x0 = 0; y0 = 0; x1 = 1000; y1 = 1000}
  const pad = Math.max(x1 - x0, y1 - y0) * 0.08 + 40;
  return {x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad, w: (x1 - x0) + 2 * pad, h: (y1 - y0) + 2 * pad, ring: R};
}
function ssFits(extent, view, scale) {
  const ppf = 72 / scale;
  return extent.w * ppf <= view.w * 0.98 && extent.h * ppf <= view.h * 0.98;
}
// Smallest standard scale whose feet-per-inch covers the site in the viewport.
function ssPickScale(wFt, hFt, wIn, hIn) {
  const need = Math.max(wFt / Math.max(wIn, 0.1), hFt / Math.max(hIn, 0.1));
  for (let i = 0; i < SS_SCALES.length; i++) if (SS_SCALES[i] >= need - 1e-6) return SS_SCALES[i];
  return SS_SCALES[SS_SCALES.length - 1];
}
function ssFit(extent, view) {return ssPickScale(extent.w, extent.h, view.w / 72 * 0.98, view.h / 72 * 0.98)}
// 11x17 is a uniform reduction of the ARCH D sheet (11/24 of the height). The printed scale is the ARCH D scale divided by that factor.
function ssHalfFit() {const d = SS_PAPER.ARCH_D, t = SS_PAPER.TABLOID; return Math.min(t.w / d.w, t.h / d.h)}
function ssScaleNum(s) {const r = Math.round(s * 10) / 10; return Math.abs(r - Math.round(r)) < 1e-6 ? String(Math.round(r)) : r.toFixed(1)}
function ssScales(extent) {
  const archD = ssFit(extent, ssChrome(SS_PAPER.ARCH_D).view);
  const archE = ssFit(extent, ssChrome(SS_PAPER.ARCH_E).view);
  const printed = archD / ssHalfFit();
  const tabView = ssChrome(SS_PAPER.TABLOID).view;
  let tab = printed, half = true;
  if (!ssFits(extent, tabView, printed)) {
    tab = SS_SCALES.find(s => s + 1e-6 >= printed && ssFits(extent, tabView, s)) || SS_SCALES[SS_SCALES.length - 1];
    half = Math.abs(tab - printed) < 1e-3;
  }
  return {ARCH_D: archD, ARCH_E: archE, TABLOID: tab, half, fit: ssHalfFit()};
}
function ssScaleLabel(scale, scales, paperId) {
  const n = ssScaleNum(scale);
  if (paperId === 'TABLOID') return 'SCALE: 1 IN = ' + n + ' FT AT 11x17 (1 IN = ' + ssScaleNum(scales.ARCH_D) + ' FT AT ARCH D)';
  return 'SCALE: 1 IN = ' + n + ' FT';
}
function ssMap(extent, view, scale) {
  const ppf = 72 / scale, gw = extent.w * ppf, gh = extent.h * ppf;
  const ox = view.x + (view.w - gw) / 2, oy = view.y + (view.h - gh) / 2;
  return {ppf, X: e => ox + (e - extent.x0) * ppf, Y: n => oy + (n - extent.y0) * ppf};
}

function ssDraw() {
  const ops = [];
  const api = {
    ops,
    line(x1, y1, x2, y2, pen) {ops.push({k: 'L', x1, y1, x2, y2, pen})},
    poly(pts, pen, opt) {ops.push({k: 'P', pts, pen, closed: !(opt && opt.open), fill: !!(opt && opt.fill), fillRgb: opt && opt.fillRgb})},
    rect(x, y, w, h, pen, opt) {ops.push({k: 'R', x, y, w, h, pen, fill: !!(opt && opt.fill), fillRgb: opt && opt.fillRgb})},
    text(x, y, s, opt) {opt = opt || {}; ops.push({k: 'T', x, y, s: s == null ? '' : String(s), size: opt.size || 8, pen: opt.pen || 'TEXT', anchor: opt.anchor || 'start', rgb: opt.rgb || null, tags: opt.tags || []})},
    clip(x, y, w, h) {ops.push({k: 'C', x, y, w, h})},
    unclip() {ops.push({k: 'U'})}
  };
  return api;
}
function ssScrub(ops, mode, secrets) {
  if (mode !== 'public') return ops;
  ops.forEach(op => {
    if (op.k !== 'T') return;
    if ((op.tags || []).some(t => SS_HIDE[t])) {op.s = ''; return}
    if (ssHits(op.s, secrets).length) op.s = '';
  });
  return ops;
}

function ssRing(draw, ring, map, pen, opt) {
  const pts = shOpen(ring).map(p => [map.X(p[0]), map.Y(p[1])]);
  if (pts.length >= 2) draw.poly(pts, pen, opt);
}
function ssSegs(draw, segs, map, pen) {
  (segs || []).forEach(s => {if (s && s.length >= 2) draw.line(map.X(s[0][0]), map.Y(s[0][1]), map.X(s[1][0]), map.Y(s[1][1]), pen)});
}
function ssRectRing(R, un) {const [x, y, w, h] = R; return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(un)}
function ssCentroid(ring) {const P = shOpen(ring); let x = 0, y = 0; P.forEach(p => {x += p[0]; y += p[1]}); return [x / P.length, y / P.length]}

function ssBuildings(r) {
  const un = r.C.un, out = [];
  const add = (R, kind, name) => {if (R && R.length >= 4 && R[2] > 1 && R[3] > 1) out.push({R, kind, name, sf: R[2] * R[3], ring: ssRectRing(R, un)})};
  if (r.boundaryNeeded) return out;
  if (r.co === 'land') {
    (r.halls || []).forEach((h, i) => {add(h.hall, 'BUILDING', 'BLDG ' + (i + 1)); if (h.gen) add(h.gen, 'YARD', 'YARD ' + (i + 1))});
    if (r.sub) add(r.sub, 'SUBSTATION', 'SUBSTATION');
    if (r.park) add(r.park, 'PARKING', 'PARKING');
  } else {
    if (r.mu) add(r.mu, 'BUILDING', 'CLIMATE');
    (r.du || []).forEach((d, i) => add(d, 'BUILDING', 'DRIVE-UP ' + (i + 1)));
    if (r.office) add(r.office, 'BUILDING', 'OFFICE');
    (r.rv || []).forEach((d, i) => add(d, 'BUILDING', 'RV ' + (i + 1)));
  }
  return out;
}

function ssCfg(opts, meta, mode) {
  const c = (opts && opts.cfg) || {};
  const pick = (v, fallback) => v ? String(v).slice(0, 80) : fallback;
  return {
    client: pick(c.client, meta.co === 'storage' ? 'EVERSTOW' : 'TERRAFICE'),
    projectName: pick(c.projectName, mode === 'admin' && meta.s && meta.s.name ? meta.s.name : 'DATA CENTER SITE'),
    address: pick(c.address, 'TBD'),
    projectNo: pick(c.projectNo, 'TBD'),
    civil: pick(c.civil, 'TBD'),
    designTeam: pick(c.designTeam, 'EDIFICE'),
    designSet: pick(c.designSet, 'SCHEMATIC'),
    issuedFor: pick(c.issuedFor, 'PRELIMINARY SITE PLAN'),
    jurisdiction: pick(c.jurisdiction, 'TBD')
  };
}

function ssZoneBit(zone, key) {
  const v = zone && zone[key];
  if (v == null || v === '') return null;
  return String(v).replace(/\s+/g, ' ').slice(0, 48);
}
// Sec. 39.05 rows filled from the cached v2 pull. A missing or failed endpoint is TBD, never a guessed number.
function ssZoneLines(rows, zone) {
  const line = (label, value) => rows.push(ssRow(label, value == null ? 'TBD' : value, 'Z', false));
  line('Zoning district', ssZoneBit(zone, 'district'));
  line('Permitted use', ssZoneBit(zone, 'use'));
  line('Coverage limit', zone && zone.cov != null && isFinite(+zone.cov) ? Math.round(+zone.cov) + '%' : null);
  line('FAR limit', zone && zone.far != null && isFinite(+zone.far) ? String(+zone.far) : null);
  line('Overlays', ssZoneBit(zone, 'overlays'));
  line('Zoning code', ssZoneBit(zone, 'code'));
  line('Parking standard', ssZoneBit(zone, 'parkingText'));
  line('Future land use', ssZoneBit(zone, 'flum'));
  line('Zone geometry', zone && zone.geomOk ? 'on file' : null);
  line('Zoning map', zone && zone.screenOk ? 'on file' : null);
}
function ssZoneReq(zone, kind) {
  if (!zone) return null;
  if (kind === 'front' || kind === 'front2') return zone.front;
  if (kind === 'rear') return zone.rear;
  return zone.side;
}

// Sec. 39.05(a)(9) site summary. Sensitive rows are omitted from public text by ssScrub.
function ssSummary(r, meta) {
  meta = meta || {};
  const ext = meta.ext || {}, zone = meta.zone || {}, b = r.build || {};
  const square = meta.polySrc === 'square' || r.boundaryNeeded;
  const rows = [];
  const grossFt = Math.abs(shArea(ssExtent(r).ring));
  const gross = grossFt / 43560;
  rows.push(ssRow('Gross area', ssAc(gross), square ? 'A' : 'C', square));
  const rowAc = isFinite(b.row) ? b.row : null;
  rows.push(rowAc == null ? ssRow('ROW dedication', 'TBD', 'A', true) : ssRow('ROW dedication', ssAc(rowAc), 'A', true));
  const floodLoaded = Array.isArray(ext.flood);
  if (!floodLoaded) rows.push(ssRow('Floodplain', 'TBD', 'F', false));
  else if (isFinite(b.flood)) rows.push(ssRow('Floodplain', ssAc(b.flood), 'F', false));
  else rows.push(ssRow('Floodplain', 'TBD', 'F', false));
  rows.push(isFinite(b.net) ? ssRow('Net developable', ssAc(b.net), 'A', true) : ssRow('Net developable', 'TBD', 'A', true));
  const blds = ssBuildings(r);
  const bSf = blds.filter(o => o.kind === 'BUILDING').reduce((a, o) => a + o.sf, 0);
  const pSf = blds.filter(o => o.kind === 'PARKING').reduce((a, o) => a + o.sf, 0);
  const gSf = blds.filter(o => o.kind === 'SUBSTATION').reduce((a, o) => a + o.sf, 0);
  const pondSf = r.pond ? r.pond[2] * r.pond[3] : 0;
  const floodSf = isFinite(b.flood) ? b.flood * 43560 : 0;
  const vegSf = Math.max(0, grossFt - bSf - pSf - gSf - pondSf - floodSf);
  const pct = sf => grossFt > 0 ? (sf / grossFt * 100).toFixed(1) + '%' : 'TBD';
  rows.push(ssRow('Building area', ssSf(bSf) + ' (' + pct(bSf) + ')', 'A', true));
  rows.push(ssRow('Paved area', ssSf(pSf) + ' (' + pct(pSf) + ')', 'A', true));
  rows.push(ssRow('Gravel area', ssSf(gSf) + ' (' + pct(gSf) + ')', 'A', true));
  rows.push(ssRow('Vegetated area', ssSf(vegSf) + ' (' + pct(vegSf) + ')', 'A', true));
  rows.push(ssRow('Building floor area', ssSf(bSf * Math.max(1, +r.stories || 1)), 'A', true));
  const edges = (r.C && r.C.edges) || [];
  if (!edges.length) rows.push(ssRow('Setbacks', 'TBD', 'Z', false));
  edges.forEach((e, i) => {
    const k = e[4] || {}, kind = k.kind || ('side ' + (i + 1));
    const provided = e[2];
    const req = ssZoneReq(zone, kind);
    const zTag = zone.has && req != null;
    if (provided > 0) rows.push(ssRow('Setback ' + kind + ' provided', Math.round(provided) + ' ft', zTag ? 'Z' : 'A', !zTag));
    rows.push(req == null ? ssRow('Setback ' + kind + ' required', 'TBD', 'Z', false) : ssRow('Setback ' + kind + ' required', Math.round(req) + ' ft', 'Z', false));
  });
  rows.push(r.height != null && isFinite(+r.height) ? ssRow('Height provided', Math.round(r.height) + ' ft', 'A', true) : ssRow('Height provided', 'TBD', 'A', true));
  rows.push(zone.maxH == null ? ssRow('Height limit', 'TBD', 'Z', false) : ssRow('Height limit', Math.round(zone.maxH) + ' ft', 'Z', false));
  ssZoneLines(rows, zone);
  rows.push(r.stories ? ssRow('Stories', String(r.stories), 'A', true) : ssRow('Stories', 'TBD', 'A', true));
  const stalls = r.stalls != null && isFinite(+r.stalls) ? Math.round(r.stalls) : null;
  rows.push(stalls == null ? ssRow('Parking stalls', 'TBD', 'A', true) : ssRow('Parking stalls', String(stalls), 'A', true));
  if (r.sw && isFinite(r.sw.imp)) rows.push(ssRow('Impervious', (r.sw.imp * 100).toFixed(1) + '%', 'A', true));
  else rows.push(ssRow('Impervious', 'TBD', 'A', true));
  if (r.sw && isFinite(r.sw.Vac)) rows.push(ssRow('Detention storage', r.sw.Vac.toFixed(2) + ' ac-ft', 'A', true));
  else rows.push(ssRow('Detention storage', 'TBD', 'A', true));
  if (r.pond) rows.push(ssRow('Pond area', ssAc(pondSf / 43560), 'A', true));
  else rows.push(ssRow('Pond area', 'TBD', 'A', true));
  const bfe = ssBfe(meta);
  if (bfe.v == null) rows.push(ssRow('Base flood elevation', 'TBD', 'F', false));
  else rows.push(ssRow('Base flood elevation', Number(bfe.v).toFixed(1) + ' ft', 'F', false));
  if (meta.legal) rows.push(ssRow('Legal description', 'see note', 'C', false));
  else rows.push(ssRow('Legal description', 'Survey to be ordered', 'C', false));
  // Admin-only program figures. Public scrub drops the whole row.
  if (r.co === 'land' && r.k && isFinite(r.k.it)) rows.push(ssRow('IT load', r.k.it.toFixed(1) + ' MW', 'A', true, 'mw'));
  if (r.co === 'land' && r.k && isFinite(r.k.fac)) rows.push(ssRow('Facility load', r.k.fac.toFixed(1) + ' MW', 'A', true, 'mw'));
  const yards = blds.filter(o => o.kind === 'YARD').length;
  if (yards) rows.push(ssRow('Generator yards', String(yards), 'A', true, 'gen'));
  if (meta.waterGpm != null && isFinite(+meta.waterGpm)) rows.push(ssRow('Water demand', Math.round(meta.waterGpm) + ' gpm', 'A', true, 'water'));
  if (meta.waterGpd != null && isFinite(+meta.waterGpd)) rows.push(ssRow('Water demand daily', Math.round(meta.waterGpd) + ' gpd', 'A', true, 'water'));
  if (meta.apn) rows.push(ssRow('Parcel ID', String(meta.apn), 'C', false, 'apn'));
  if (meta.owner) rows.push(ssRow('Parcel owner', String(meta.owner), 'C', false, 'owner'));
  if (!ssRowsOk(rows)) throw new Error('site summary has an untagged number');
  return rows;
}

function ssBfe(meta) {
  const ext = (meta && meta.ext) || {};
  if (meta && meta.bfe != null && isFinite(+meta.bfe)) return {v: +meta.bfe, src: 'given'};
  const fs = ext.flood || [];
  const hit = fs.find(f => f && f.bfe != null && isFinite(+f.bfe));
  if (hit) return {v: +hit.bfe, src: 'NFHL'};
  return {v: null, loaded: Array.isArray(ext.flood), zones: [...new Set(fs.map(f => f && f.zone).filter(Boolean))]};
}
function ssSurveyNotes(r, meta) {
  const square = !meta || meta.polySrc === 'square' || r.boundaryNeeded;
  const notes = [];
  if (meta && meta.legal) notes.push('LEGAL DESCRIPTION: ' + String(meta.legal).slice(0, 240) + ' [C]');
  else notes.push('LEGAL DESCRIPTION: Survey to be ordered.');
  if (square) notes.push('BOUNDARY: Survey to be ordered. The outline on this sheet is a planning square [A], not an ALTA survey.');
  else notes.push('BOUNDARY: Survey to be ordered. Courses are from the GIS polygon [C], not an ALTA survey.');
  const bfe = ssBfe(meta || {});
  if (bfe.v != null) notes.push('FLOOD ELEVATION: BFE ' + Number(bfe.v).toFixed(1) + ' ft [F]' + (bfe.zones && bfe.zones.length ? ' zone ' + bfe.zones.join(', ') : ''));
  else if (bfe.loaded && bfe.zones && bfe.zones.length) notes.push('FLOOD ELEVATION: TBD (no BFE published) [F]. Zone ' + bfe.zones.join(', ') + '.');
  else if (bfe.loaded) notes.push('FLOOD ELEVATION: TBD (no BFE) [F]. No SFHA mapped on the loaded NFHL extract.');
  else notes.push('FLOOD ELEVATION: TBD [F]. FEMA NFHL was not loaded. Survey to be ordered.');
  if (!(meta && meta.control)) notes.push('SURVEY CONTROL: Survey to be ordered. No northing, easting or benchmark elevation is on file.');
  return notes;
}

function ssChecklist(flags, opts) {
  const items = (typeof SS_CHECKLISTS === 'undefined' || !SS_CHECKLISTS) ? [] : SS_CHECKLISTS.items;
  const waive = new Set((opts && opts.waive) || []);
  const F = flags || {};
  const rules = {
    1: ['PRESENT', 'Signature block is on the sheet and reads PRELIMINARY - NOT SEALED. Not a Kansas seal.'],
    2: ['PRESENT', 'Sheet title is centered at the top of the sheet, and repeated in the title block.'],
    3: [F.paperOk ? 'PRESENT' : 'MISSING', F.paperOk ? 'This sheet is ' + F.paperInch + '.' : '11x17 is a half-size print, not the 24x36 submittal.'],
    4: [F.north && F.date && F.vicinity ? 'PRESENT' : 'MISSING', F.vicinity ? 'North arrow, date and a TIGER vicinity inset are on the sheet.' + (F.places ? '' : ' City limits: TBD.') : 'North arrow and date are on the sheet. Vicinity roads were not loaded.'],
    5: ['PRESENT', 'This export is the electronic copy (vector PDF).'],
    6: [F.courses && F.legal && F.scales ? 'PRESENT' : 'MISSING', F.legal ? 'Boundary courses, legal description and both scales are on the sheet.' : 'Boundary courses and both scales are on C-100. Legal description: Survey to be ordered.'],
    7: [F.contourIv != null && F.contourIv <= 2 ? 'PRESENT' : 'MISSING', F.contourIv == null ? 'Contours TBD. DEM was not loaded.' : (F.contourIv <= 2 ? F.contourIv + ' ft contours.' : 'Interval is ' + F.contourIv + ' ft. Sec. 39.05(a)(7) wants 2 ft or closer.')],
    8: ['MISSING', 'Existing transmission and easements are drawn when loaded. Proposed utilities are not in this issue (sheet C-300).'],
    9: [F.summary && F.pond && F.arrows ? 'PRESENT' : 'MISSING', 'Site summary table is on C-100. ' + (F.pond ? 'A detention pond is drawn. ' : 'Pond: TBD. ') + (F.arrows ? 'Drainage arrows are drawn.' : 'Drainage arrows: TBD (grading sheet C-200).')],
    10: [F.structures && F.stories && F.entrances ? 'PRESENT' : 'MISSING', (F.structures ? 'Floor area and stories are in the summary. ' : 'No structures placed. ') + (F.entrances ? 'Road crossings are marked as access points.' : 'Entrances: TBD.')],
    11: ['MISSING', 'Parking count is in the summary when the layout has it. Curb radii, aisle widths, accessible stalls and loading are TBD.'],
    12: ['MISSING', 'Screen walls and fences are not in this issue. Height and material: TBD.'],
    13: [F.surfacing ? 'PRESENT' : 'MISSING', 'Paved, gravel and vegetated areas are in the summary, from the layout rectangles [A]. Material specifications are TBD.'],
    14: [F.streets ? 'PRESENT' : 'MISSING', F.streets ? 'Roads and the ROW dedication are shown. ROW widths by class are assumed [A].' : 'No roads loaded and no ROW dedication. Streets: TBD.'],
    15: ['MISSING', 'Landscape schedule is not in this issue (sheet L-100).'],
    16: ['MISSING', 'Signage: TBD.'],
    17: ['MISSING', 'Stall dimensions: TBD. The stall count is in the summary.'],
    18: ['MISSING', 'Lighting is not in this issue (sheet E-001).'],
    19: ['MISSING', 'Trash screening: TBD.'],
    20: ['MISSING', 'Plat restrictions: Survey to be ordered.'],
    21: [F.bfe ? 'PRESENT' : 'MISSING', F.bfe ? 'Floodplain and a base flood elevation are on the sheet.' : 'Flood note is printed as TBD or no BFE. Survey to be ordered for an elevation.'],
    22: ['MISSING', 'On-site sewage: TBD.'],
    23: [F.openSpace ? 'PRESENT' : 'MISSING', 'Vegetated area is in the site summary [A].'],
    24: ['MISSING', 'A sealed drainage report is not part of this issue. Detention volume on the summary is a TR-55 planning figure [A].']
  };
  return items.map(it => {
    const rule = rules[it.n] || ['MISSING', 'Not checked.'];
    const status = waive.has(it.n) ? 'WAIVER REQUESTED' : rule[0];
    const note = waive.has(it.n) ? 'Waiver requested. ' + rule[1] : rule[1];
    return {n: it.n, title: it.title, status, note};
  });
}

function ssFlags(r, meta, paper, ext, scalePack) {
  const bfe = ssBfe(meta);
  const roads = (ext && ext.roads) || [];
  const places = (ext && ext.places) || [];
  const blds = ssBuildings(r);
  const courses = shCourses(ssExtent(r).ring);
  let contourIv = null;
  const T = ext && ext.topo;
  if (T && T.G && T.G.length === T.nx * T.ny) {
    const slope = shSlope(T.G, T.nx, T.ny, T.X0, T.Y0, T.dx, T.dy);
    if (slope) contourIv = shInterval(slope.relief);
  }
  const hard = r.C && r.C.hardRing && ((r.C.hardRing.segs && r.C.hardRing.segs.length) || r.C.hardRing.length > 2);
  const row = (r.build && r.build.row > 0) || (r.C && r.C.rowRing && r.C.rowRing.length > 2);
  return {
    paperOk: paper.id === 'ARCH_D' || paper.id === 'ARCH_E',
    paperInch: paper.inch,
    north: true, date: true,
    vicinity: roads.length > 0,
    places: places.length > 0,
    courses: courses.length >= 3,
    legal: !!(meta && meta.legal),
    scales: true,
    contourIv,
    summary: true,
    pond: !!r.pond,
    arrows: false,
    structures: blds.some(o => o.kind === 'BUILDING'),
    stories: !!r.stories,
    entrances: roads.length > 0,
    surfacing: true,
    streets: roads.length > 0 || !!row || !!(r.C && r.C.rowRing),
    openSpace: true,
    bfe: bfe.v != null,
    hard: !!hard,
    scalePack
  };
}

function ssTitleBlock(d, paper, chrome, sheet, cfg, rev, mode) {
  const x = chrome.tbX, w = chrome.tb, top = paper.h - chrome.m, bot = chrome.m, H = top - bot;
  const spec = [['CLIENT', 0.09], ['PROJECT', 0.10], ['PROJECT NO.', 0.055], ['CIVIL ENGINEER', 0.08], ['DESIGN TEAM', 0.11], ['SEAL', 0.11], ['DESIGN SET', 0.05], ['ISSUED FOR', 0.06], ['REVISIONS', 0.18], ['SHEET TITLE', 0.055], ['SHEET NO.', 0.08], ['REVISION', 0.03]];
  let y = top;
  const body = (yy, rh, lines) => {let base = yy + rh - 20; lines.filter(Boolean).forEach(t => {if (base > yy + 3) {d.text(x + 8, base, String(t).slice(0, 42), {size: 7.5, pen: 'TEXT'}); base -= 10}})};
  spec.forEach(([name, f]) => {
    const rh = H * f; y -= rh;
    const hot = name === 'SHEET NO.';
    d.rect(x, y, w, rh, 'TITLE', hot ? {fill: true, fillRgb: [0.945, 0.294, 0.129]} : {fill: false});
    d.text(x + 8, y + rh - 9, name, {size: 6, pen: 'TEXT', rgb: hot ? [1, 1, 1] : null});
    if (name === 'CLIENT') body(y, rh, [cfg.client]);
    else if (name === 'PROJECT') body(y, rh, [cfg.projectName, cfg.address]);
    else if (name === 'PROJECT NO.') body(y, rh, [cfg.projectNo]);
    else if (name === 'CIVIL ENGINEER') body(y, rh, [cfg.civil]);
    else if (name === 'DESIGN TEAM') body(y, rh, [cfg.designTeam, 'Prime professional: TBD']);
    else if (name === 'SEAL') body(y, rh, ['PRELIMINARY', 'NOT SEALED']);
    else if (name === 'DESIGN SET') body(y, rh, [cfg.designSet]);
    else if (name === 'ISSUED FOR') body(y, rh, [cfg.issuedFor]);
    else if (name === 'REVISIONS') {
      d.text(x + 8, y + rh - 22, '#   DESCRIPTION', {size: 6, pen: 'TEXT'});
      d.text(x + w - 8, y + rh - 22, 'DATE', {size: 6, pen: 'TEXT', anchor: 'end'});
      const list = (rev && rev.length ? rev : [{n: 0, text: 'Preliminary issue', date: sheet.date}]).slice(0, 5);
      list.forEach((rv, i) => {
        d.text(x + 8, y + rh - 34 - i * 10, String(rv.n) + '   ' + String(rv.text || '').slice(0, 32), {size: 6.5, pen: 'TEXT'});
        d.text(x + w - 8, y + rh - 34 - i * 10, String(rv.date || ''), {size: 6.5, pen: 'TEXT', anchor: 'end'});
      });
    } else if (name === 'SHEET TITLE') body(y, rh, [sheet.title]);
    else if (name === 'SHEET NO.') d.text(x + w / 2, y + rh * 0.38, sheet.no, {size: paper.id === 'TABLOID' ? 14 : 20, pen: 'TITLE', anchor: 'middle', rgb: [1, 1, 1]});
    else if (name === 'REVISION') body(y, rh, [String((rev && rev.length ? rev[rev.length - 1].n : 0))]);
  });
  if (mode === 'admin') d.text(x, bot - 14, 'ADMIN - NOT FOR DISTRIBUTION', {size: 7, pen: 'TEXT', rgb: [0.945, 0.294, 0.129]});
}

function ssFooter(d, paper, chrome) {
  const y = 16;
  d.text(chrome.m, y, 'Confidential  |  Edifice', {size: 7, pen: 'TEXT'});
  d.text(paper.w / 2, y, 'CONCEPTUAL - NOT FOR CONSTRUCTION  |  NOT A SURVEY', {size: 7, pen: 'TEXT', anchor: 'middle'});
}
function ssCheckBar(d, paper) {
  const x = paper.w - 36 - 78, y = 14;
  d.rect(x, y, 72, 6, 'SCALEBAR', {fill: true, fillRgb: [0, 0, 0]});
  d.text(x - 6, y, 'VERIFY SCALE: THIS BAR = 1.00 INCH WHEN PRINTED FULL SIZE', {size: 6, pen: 'TEXT', anchor: 'end'});
}
function ssViewTitle(d, paper, chrome, o) {
  const cx = chrome.view.x + chrome.view.w / 2, y = chrome.m + 28;
  d.line(cx - 70, y + 16, cx + 70, y + 16, 'TEXT');
  d.text(cx, y + 20, o.title, {size: 9, pen: 'TEXT', anchor: 'middle'});
  d.text(cx, y + 4, o.scaleLabel || ('SCALE: 1 IN = ' + ssScaleNum(o.scale) + ' FT'), {size: 8, pen: 'TEXT', anchor: 'middle'});
  const nx = chrome.view.x + 18, ny = y + 8;
  d.poly([[nx, ny + 14], [nx - 6, ny], [nx + 6, ny]], 'TEXT', {fill: true, fillRgb: [0.11, 0.11, 0.11]});
  d.text(nx, ny + 16, 'N', {size: 8, pen: 'TEXT', anchor: 'middle'});
  const barFt = Number(ssScaleNum(o.scale * 2)), bw = barFt * 72 / o.scale;
  const bx = cx - bw / 2, by = chrome.m + 36;
  d.rect(bx, by, bw, 8, 'SCALEBAR', {fill: true, fillRgb: [0, 0, 0]});
  d.line(bx + bw / 2, by + 8, bx + bw / 2, by + 14, 'SCALEBAR');
  d.text(bx, by + 16, '0', {size: 6, pen: 'TEXT'});
  d.text(bx + bw / 2, by + 16, String(barFt / 2), {size: 6, pen: 'TEXT', anchor: 'middle'});
  d.text(bx + bw, by + 16, String(barFt) + ' FT', {size: 6, pen: 'TEXT', anchor: 'end'});
  d.text(bx + bw + 8, by + 1, 'SCALE BAR ' + ssScaleNum(barFt) + ' FT', {size: 6, pen: 'TEXT'});
}
function ssHeadTitle(d, paper, chrome, title) {
  d.text(chrome.view.x + chrome.view.w / 2, paper.h - chrome.m - 16, title, {size: 11, pen: 'TEXT', anchor: 'middle'});
}

function ssSummaryBlock(d, rows, mode, x, yTop, width) {
  const shown = rows.filter(r => mode === 'admin' || !r.sensitive);
  d.text(x, yTop, 'SITE SUMMARY  Sec. 39.05(a)(9)', {size: 7.5, pen: 'TEXT'});
  d.text(x, yTop - 11, '[Z]oning [C]ounty GIS [F]EMA [N]HD [T]IGER [H]IFLD [O]SM [U]SGS [A]ssumed', {size: 5.5, pen: 'TEXT'});
  let y = yTop - 24;
  shown.forEach(r => {d.text(x, y, r.print.slice(0, Math.max(28, Math.floor(width / 3.4))), {size: 6, pen: 'TEXT', tags: r.sensitive ? [r.sensitive] : []}); y -= 8});
  return y;
}

function ssVicinity(d, ext, extent, box) {
  const roads = (ext && ext.roads) || [], places = (ext && ext.places) || [];
  d.rect(box.x, box.y, box.w, box.h, 'VICINITY', {fill: true, fillRgb: [0.97, 0.96, 0.94]});
  d.text(box.x + 6, box.y + box.h - 11, 'VICINITY', {size: 7, pen: 'TEXT'});
  d.text(box.x + box.w - 6, box.y + box.h - 11, 'N', {size: 7, pen: 'TEXT', anchor: 'end'});
  const note = !roads.length ? 'TIGER roads not loaded' : (places.length ? '[T] Census TIGER roads and places' : '[T] Census TIGER roads. City limits: TBD');
  d.text(box.x + 6, box.y + 6, note.slice(0, 42), {size: 5, pen: 'TEXT'});
  d.text(box.x + 6, box.y + 14, 'NOT TO SCALE', {size: 5, pen: 'TEXT'});
  const pts = [];
  const push = p => {if (p && isFinite(p[0]) && isFinite(p[1])) pts.push(p)};
  roads.forEach(o => (o.L || []).forEach(push));
  places.forEach(o => (o.ring || []).forEach(push));
  extent.ring.forEach(push);
  if (pts.length < 2) {d.rect(box.x, box.y, box.w, box.h, 'VICINITY'); return}
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  pts.forEach(p => {x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1])});
  const pad = Math.max(x1 - x0, y1 - y0) * 0.08 + 20; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const sc = Math.min((box.w - 12) / (x1 - x0 || 1), (box.h - 28) / (y1 - y0 || 1));
  const X = e => box.x + 6 + (e - x0) * sc, Y = n => box.y + 20 + (n - y0) * sc;
  d.clip(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
  places.forEach(o => {const ring = o.ring || []; if (ring.length > 2) d.poly(ring.map(p => [X(p[0]), Y(p[1])]), 'VICINITY', {fill: false})});
  roads.forEach(o => {const L = o.L || []; if (L.length > 1) d.poly(L.map(p => [X(p[0]), Y(p[1])]), 'ROAD', {open: true})});
  if (extent.ring.length > 2) d.poly(extent.ring.map(p => [X(p[0]), Y(p[1])]), 'BOUNDARY');
  d.unclip();
  d.rect(box.x, box.y, box.w, box.h, 'VICINITY');
}

function ssPlan(d, r, meta, map, mode) {
  const ext = meta.ext || {}, un = r.C.un;
  const T = ext.topo;
  if (T && T.G && T.G.length === T.nx * T.ny) {
    const slope = shSlope(T.G, T.nx, T.ny, T.X0, T.Y0, T.dx, T.dy);
    if (slope) {
      let n = 0;
      shContours(T.G, T.nx, T.ny, T.X0, T.Y0, T.dx, T.dy, shInterval(slope.relief)).forEach(({segs}) => segs.forEach(([p, q]) => {if (n++ < 1800) d.line(map.X(p[0]), map.Y(p[1]), map.X(q[0]), map.Y(q[1]), 'CONTOUR')}));
    }
  }
  (ext.flood || []).forEach(f => {if (!f || !f.nb) return; (f.R || []).forEach(ring => {if (ring && ring.length > 2) d.poly(shOpen(ring).map(p => [map.X(p[0]), map.Y(p[1])]), 'FLOODPLAIN', {fill: true, fillRgb: [0.65, 0.86, 0.92]})})});
  (ext.streams || []).forEach(L => {if (L && L.length > 1) d.poly(L.map(p => [map.X(p[0]), map.Y(p[1])]), 'STREAM', {open: true})});
  (ext.tx || []).forEach(o => {if (o.L && o.L.length > 1) d.poly(o.L.map(p => [map.X(p[0]), map.Y(p[1])]), 'TRANSMISSION', {open: true})});
  (ext.roads || []).forEach(o => {if (o.L && o.L.length > 1) {d.poly(o.L.map(p => [map.X(p[0]), map.Y(p[1])]), 'ROAD', {open: true}); const m = o.L[Math.floor(o.L.length / 2)]; if (o.name) d.text(map.X(m[0]) + 3, map.Y(m[1]) + 3, String(o.name).toUpperCase().slice(0, 28) + (o.row ? " (" + o.row + " FT ROW [A])" : ''), {size: 6, pen: 'TEXT'})}});
  const drawRing = (ring, pen) => {if (!ring) return; if (ring.segs && ring.segs.length) ssSegs(d, ring.segs, map, pen); else if (ring.length > 2) ssRing(d, ring.map ? ring.map(un) : ring, map, pen)};
  // setback / row / hard rings are stored in the rotated frame
  if (r.C.setRing) {const rg = r.C.setRing; if (rg.segs && rg.segs.length) ssSegs(d, rg.segs.map(s => s.map(un)), map, 'SETBACK'); else if (rg.length > 2) ssRing(d, rg.map(un), map, 'SETBACK', {open: true})}
  if (r.C.rowRing && r.C.rowRing.length > 2) ssRing(d, r.C.rowRing.map(un), map, 'ROW', {open: true});
  if (r.C.hardRing) {const rg = r.C.hardRing; if (rg.segs && rg.segs.length) ssSegs(d, rg.segs.map(s => s.map(un)), map, 'EASEMENT'); else if (rg.length > 2) ssRing(d, rg.map(un), map, 'EASEMENT', {open: true})}
  const ring = ssExtent(r).ring;
  for (let i = 0; i < ring.length; i++) {const a = ring[i], b = ring[(i + 1) % ring.length]; d.line(map.X(a[0]), map.Y(a[1]), map.X(b[0]), map.Y(b[1]), 'BOUNDARY')}
  const courses = shCourses(ring);
  courses.forEach(c => {if (c.dist * map.ppf < 28) return; const mx = (c.a[0] + c.b[0]) / 2, my = (c.a[1] + c.b[1]) / 2; d.text(map.X(mx), map.Y(my) + 4, 'L' + c.n + '  ' + c.dist.toFixed(1) + ' FT', {size: 5.5, pen: 'TEXT', anchor: 'middle'})});
  if (r.pond) ssRing(d, ssRectRing(r.pond, un), map, 'DETENTION', {fill: true, fillRgb: [0.75, 0.86, 0.93]});
  ssBuildings(r).forEach(o => {
    const fill = o.kind === 'BUILDING' ? [0.82, 0.82, 0.8] : o.kind === 'YARD' ? [0.7, 0.7, 0.7] : o.kind === 'SUBSTATION' ? [0.93, 0.86, 0.55] : [0.75, 0.75, 0.75];
    ssRing(d, o.ring, map, o.kind, {fill: true, fillRgb: fill});
    const c = ssCentroid(o.ring);
    let label = o.kind === 'BUILDING' ? o.name + '  ' + Math.round(o.sf).toLocaleString('en-US') + ' SF' : o.name;
    if (o.kind === 'YARD') label = mode === 'admin' ? 'GENERATOR YARD' : 'YARD';
    if (o.kind === 'PARKING' && r.stalls != null) label = 'PARKING  ' + Math.round(r.stalls) + ' STALLS [A]';
    d.text(map.X(c[0]), map.Y(c[1]), label, {size: 6, pen: 'TEXT', anchor: 'middle', tags: o.kind === 'YARD' && mode === 'admin' ? ['gen'] : []});
  });
  if (r.pond) {const c = un([r.pond[0] + r.pond[2] / 2, r.pond[1] + r.pond[3] / 2]); d.text(map.X(c[0]), map.Y(c[1]), 'DETENTION', {size: 6.5, pen: 'TEXT', anchor: 'middle'})}
  (r.C.edges || []).forEach(e => {if (!(e[2] > 0)) return; const A = un(e[0]), B = un(e[1]); if (shDist(A, B) * map.ppf < 40) return; const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2; const k = e[4] || {}; d.text(map.X(mx), map.Y(my) - 8, Math.round(e[2]) + ' FT ' + String(k.kind || 'SETBACK').toUpperCase(), {size: 5.5, pen: 'TEXT', anchor: 'middle'})});
}

function ssSheetFrame(d, paper, chrome, sheet, cfg, rev, mode) {
  d.rect(chrome.m, chrome.m, paper.w - 2 * chrome.m, paper.h - 2 * chrome.m, 'BORDER');
  d.line(chrome.tbX, chrome.m, chrome.tbX, paper.h - chrome.m, 'TITLE');
  ssTitleBlock(d, paper, chrome, sheet, cfg, rev, mode);
  ssFooter(d, paper, chrome);
  ssCheckBar(d, paper);
  ssHeadTitle(d, paper, chrome, sheet.no + '  ' + sheet.title);
}

function ssCompose(r, meta, opts) {
  meta = meta || {}; opts = opts || {};
  const mode = opts.mode === 'admin' ? 'admin' : 'public';
  const paper = ssPaper(opts.paper || 'ARCH_D');
  const extent = ssExtent(r);
  const scales = ssScales(extent);
  const scale = scales[paper.id];
  const chrome = ssChrome(paper);
  const map = ssMap(extent, chrome.view, scale);
  const cfg = ssCfg(opts, Object.assign({co: r.co}, meta), mode);
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const rev = (opts.rev && opts.rev.length ? opts.rev : [{n: 0, text: 'Preliminary issue', date}]).map(rv => ({n: rv.n, text: String(rv.text || '').slice(0, 80), date: String(rv.date || date).slice(0, 20)}));
  const summary = ssSummary(r, meta);
  const ext = meta.ext || {};
  const flags = ssFlags(r, meta, paper, ext, scales);
  const check = ssChecklist(flags, opts);
  const secrets = [meta.apn, meta.owner].filter(Boolean).map(String);
  const scaleLabel = ssScaleLabel(scale, scales, paper.id);
  const notes = ssSurveyNotes(r, meta);
  const assumptions = [
    'ASSUMPTIONS, each marked [A] on the summary: layout areas, setbacks where zoning did not govern,',
    'ROW widths by road class, transmission ROW by voltage, 50 ft stream buffer, story height, TR-55 detention.',
    'Civil engineer, design firm and seal are TBD. This set is not signed by a Kansas licensee.'
  ];
  function blank(no, title) {return {no, title, date, w: paper.w, h: paper.h, paper: paper.id, scale, ops: []}}
  const cover = blank('G-001', 'COVER AND SHEET INDEX');
  const site = blank('C-100', 'SITE PLAN');
  const dc = ssDraw(), ds = ssDraw();
  ssSheetFrame(dc, paper, chrome, cover, cfg, rev, mode);
  ssSheetFrame(ds, paper, chrome, site, cfg, rev, mode);
  const left = chrome.m + 12, right = chrome.tbX - 12, top = paper.h - chrome.m - 28;
  dc.text(left, top, cfg.projectName, {size: 16, pen: 'TEXT'});
  dc.text(left, top - 16, cfg.jurisdiction + '  |  ' + date, {size: 9, pen: 'TEXT'});
  dc.text(left, top - 32, 'Source tags: [Z]oning [C]ounty GIS [F]EMA [N]HD [T]IGER [H]IFLD [O]SM [U]SGS [A]ssumed. TBD means the figure is not known.', {size: 7, pen: 'TEXT'});
  let y = top - 52;
  notes.forEach(t => {dc.text(left, y, t.slice(0, 140), {size: 7.5, pen: 'TEXT'}); y -= 11});
  y -= 6;
  assumptions.forEach(t => {dc.text(left, y, t.slice(0, 150), {size: 6.5, pen: 'TEXT'}); y -= 9});
  y -= 8;
  dc.text(left, y, 'SHEET INDEX', {size: 9, pen: 'TEXT'}); y -= 14;
  ssRegistry().forEach(s => {dc.text(left, y, s.no + '   ' + s.title, {size: 7.5, pen: 'TEXT'}); dc.text(left + 280, y, ssHasDraw(s) ? 'IN THIS SET' : 'NOT IN THIS ISSUE', {size: 7, pen: 'TEXT'}); y -= 11});
  let cy = top - 52;
  const cx = left + 360;
  dc.text(cx, top - 36, 'SEC. 39.05(a) REQUIRED CONTENTS', {size: 9, pen: 'TEXT'});
  check.forEach(it => {dc.text(cx, cy, '(a)(' + it.n + ') ' + it.status, {size: 6.5, pen: 'TEXT'}); dc.text(cx + 108, cy, it.title.slice(0, 52), {size: 6.5, pen: 'TEXT'}); cy -= 11});
  if (cy < chrome.m + chrome.titleBand) { /* checklist fits on ARCH D and E; tabloid may clip visually but text is still in the file */ }
  // site plan
  let noteY = ssSummaryBlock(ds, summary, mode, left, top, chrome.summary - 8) - 8;
  const noteW = Math.max(24, Math.floor((chrome.summary - 16) / 3.1));
  ssSurveyNotes(r, meta).forEach(t => {shWrap(t, noteW).forEach(line => {ds.text(left, noteY, line, {size: 5.5, pen: 'TEXT'}); noteY -= 7})});
  const box = {x: left, y: chrome.m + chrome.titleBand + 8, w: Math.max(80, chrome.summary - 16), h: Math.min(150, Math.max(64, noteY - (chrome.m + chrome.titleBand + 16)))};
  if (box.h > 56) ssVicinity(ds, ext, extent, box);
  ds.clip(chrome.view.x, chrome.view.y, chrome.view.w, chrome.view.h - 48);
  ssPlan(ds, r, meta, map, mode);
  ds.unclip();
  ssViewTitle(ds, paper, chrome, {title: 'SITE PLAN', scale, scaleLabel});
  ds.text(chrome.view.x, chrome.m + chrome.titleBand - 8, 'GRAPHIC SCALE MATCHES 1 IN = ' + ssScaleNum(scale) + ' FT. CONFIRM THE 1.00 INCH BAR BEFORE MEASURING.', {size: 6, pen: 'TEXT'});
  cover.ops = ssScrub(dc.ops, mode, secrets);
  site.ops = ssScrub(ds.ops, mode, secrets);
  const ctx = {r, meta, mode, paper, scale, scales, extent, map, chrome, cfg, date, rev, summary, check, ext, secrets, scaleLabel};
  const pages = [];
  ssRegistry().forEach(sh => {
    if (typeof sh.render === 'function') pages.push(ssCustom(ctx, sh));
    else if (sh.draw === 'cover') pages.push(cover);
    else if (sh.draw === 'site') pages.push(site);
  });
  const info = mode === 'admin'
    ? {title: 'ADMIN - NOT FOR DISTRIBUTION', author: 'Edifice', subject: 'Preliminary site plan set', keywords: 'admin'}
    : {title: 'Site plan set', author: 'Edifice', subject: 'Conceptual site plan - not for construction - not a survey', keywords: 'site plan'};
  ['title', 'author', 'subject', 'keywords'].forEach(k => {if (mode === 'public' && ssHits(info[k], secrets).length) info[k] = 'Site plan set'});
  return {sheets: pages, summary, check, scales, scale, paper: paper.id, mode, info, half: paper.id === 'TABLOID' && scales.half, barFt: scale * 2};
}
function ssCustom(ctx, sh) {
  const d = ssDraw();
  const sheet = {no: sh.no, title: sh.title || sh.no, date: ctx.date};
  ssSheetFrame(d, ctx.paper, ctx.chrome, sheet, ctx.cfg, ctx.rev, ctx.mode);
  const page = sh.render(ctx, sh, d);
  const ops = page && page.ops ? page.ops : d.ops;
  return {no: sheet.no, title: sheet.title, date: ctx.date, w: ctx.paper.w, h: ctx.paper.h, paper: ctx.paper.id, scale: ctx.scale, ops: ssScrub(ops, ctx.mode, ctx.secrets)};
}

function ssFmt(n) {return (Math.round(n * 1000) / 1000).toFixed(3)}
function ssPdfEsc(s) {return '(' + String(s).replace(/\\/g, '\\\\').replace(/[()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?') + ')'}
function ssPdfContent(page) {
  let s = '% SS_LAYER PAGE\n1.000 1.000 1.000 rg\n0.000 0.000 ' + ssFmt(page.w) + ' ' + ssFmt(page.h) + ' re\nf\n0.000 0.000 0.000 RG\n0.000 0.000 0.000 rg\n';
  let clip = 0, penId = '';
  const penOn = pen => {
    const p = SS_PENS[pen] || SS_PENS.TEXT;
    if (pen === penId) return p;
    penId = pen;
    s += '% SS_LAYER ' + p.layer + '\n' + p.rgb.map(ssFmt).join(' ') + ' RG\n' + p.rgb.map(ssFmt).join(' ') + ' rg\n' + ssFmt(p.lw || 0.4) + ' w\n' + (p.dash ? '[' + p.dash.join(' ') + '] 0 d\n' : '[] 0 d\n');
    return p;
  };
  page.ops.forEach(op => {
    if (op.k === 'C') {s += 'q\n' + [op.x, op.y, op.w, op.h].map(ssFmt).join(' ') + ' re\nW\nn\n'; clip++; penId = ''; return}
    if (op.k === 'U') {if (clip) {s += 'Q\n'; clip--; penId = ''} return}
    penOn(op.pen);
    if (op.fillRgb) s += op.fillRgb.map(ssFmt).join(' ') + ' rg\n';
    if (op.k === 'L') s += ssFmt(op.x1) + ' ' + ssFmt(op.y1) + ' m\n' + ssFmt(op.x2) + ' ' + ssFmt(op.y2) + ' l\nS\n';
    else if (op.k === 'R') s += [op.x, op.y, op.w, op.h].map(ssFmt).join(' ') + ' re\n' + (op.fill ? 'f\n' : 'S\n');
    else if (op.k === 'P') {
      if (!op.pts || op.pts.length < 2) return;
      s += ssFmt(op.pts[0][0]) + ' ' + ssFmt(op.pts[0][1]) + ' m\n';
      for (let i = 1; i < op.pts.length; i++) s += ssFmt(op.pts[i][0]) + ' ' + ssFmt(op.pts[i][1]) + ' l\n';
      if (op.closed) s += 'h\n' + (op.fill ? 'f\n' : 'S\n'); else s += 'S\n';
    } else if (op.k === 'T' && op.s) {
      const size = op.size || 8, rgb = op.rgb || (SS_PENS[op.pen] || SS_PENS.TEXT).rgb;
      let x = op.x; const w = op.s.length * size * 0.52;
      if (op.anchor === 'middle') x -= w / 2; else if (op.anchor === 'end') x -= w;
      s += 'BT\n/F1 ' + ssFmt(size) + ' Tf\n' + rgb.map(ssFmt).join(' ') + ' rg\n' + ssFmt(x) + ' ' + ssFmt(op.y) + ' Td\n' + ssPdfEsc(op.s) + ' Tj\nET\n';
      penId = '';
    }
    if (op.fillRgb) penId = '';
  });
  while (clip--) s += 'Q\n';
  return s;
}
function ssPdf(pages, info) {
  const contents = pages.map(ssPdfContent);
  const n = pages.length, fontId = 3 + n * 2, infoId = fontId + 1;
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Count ' + n + ' /Kids [' + pages.map((_, i) => (3 + i * 2) + ' 0 R').join(' ') + '] >>');
  pages.forEach((p, i) => {
    const contId = 4 + i * 2;
    objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + p.w + ' ' + p.h + '] /Contents ' + contId + ' 0 R /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> >>');
    objs.push('<< /Length ' + contents[i].length + ' >>\nstream\n' + contents[i] + 'endstream');
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objs.push('<< /Title ' + ssPdfEsc(info.title) + ' /Author ' + ssPdfEsc(info.author) + ' /Subject ' + ssPdfEsc(info.subject) + ' /Keywords ' + ssPdfEsc(info.keywords) + ' >>');
  let out = '%PDF-1.4\n', offsets = [0];
  objs.forEach((o, i) => {offsets.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'});
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return out;
}

function ssDxf(page) {
  const inch = v => (v / 72).toFixed(4);
  const L = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1021', '9', '$INSUNITS', '70', '1', '9', '$MEASUREMENT', '70', '0', '0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES'];
  const ltypes = Object.keys(SS_LTYPES);
  L.push('0', 'TABLE', '2', 'LTYPE', '70', String(ltypes.length));
  ltypes.forEach(name => {
    const p = SS_LTYPES[name];
    L.push('0', 'LTYPE', '2', name, '70', '0', '3', p.desc, '72', '65', '73', String(p.pat.length), '40', p.pat.reduce((a, v) => a + Math.abs(v), 0).toFixed(4));
    p.pat.forEach(v => L.push('49', v.toFixed(4)));
  });
  L.push('0', 'ENDTAB');
  const pens = ssPenTable();
  L.push('0', 'TABLE', '2', 'LAYER', '70', String(pens.length));
  pens.forEach(p => L.push('0', 'LAYER', '2', p.layer, '70', '0', '62', String(p.aci), '6', p.ltype));
  L.push('0', 'ENDTAB', '0', 'TABLE', '2', 'STYLE', '70', '1', '0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0', '41', '1', '50', '0', '71', '0', '42', '0.2', '3', 'txt', '4', '', '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  const layerOf = pen => (SS_PENS[pen] || SS_PENS.TEXT).layer;
  const ltypeOf = pen => (SS_PENS[pen] || SS_PENS.TEXT).ltype;
  page.ops.forEach(op => {
    const layer = layerOf(op.pen), lt = ltypeOf(op.pen);
    if (op.k === 'L') L.push('0', 'LINE', '8', layer, '6', lt, '10', inch(op.x1), '20', inch(op.y1), '11', inch(op.x2), '21', inch(op.y2));
    else if (op.k === 'R') L.push('0', 'LWPOLYLINE', '8', layer, '6', lt, '90', '4', '70', '1', '10', inch(op.x), '20', inch(op.y), '10', inch(op.x + op.w), '20', inch(op.y), '10', inch(op.x + op.w), '20', inch(op.y + op.h), '10', inch(op.x), '20', inch(op.y + op.h));
    else if (op.k === 'P' && op.pts && op.pts.length >= 2) {
      L.push('0', 'LWPOLYLINE', '8', layer, '6', lt, '90', String(op.pts.length), '70', op.closed ? '1' : '0');
      op.pts.forEach(p => L.push('10', inch(p[0]), '20', inch(p[1])));
    } else if (op.k === 'T' && op.s) L.push('0', 'TEXT', '8', layer, '6', lt, '10', inch(op.x), '20', inch(op.y), '40', inch(op.size || 8), '1', op.s.replace(/\r?\n/g, ' ').slice(0, 240), '7', 'STANDARD');
  });
  L.push('0', 'ENDSEC', '0', 'EOF');
  return L.join('\n');
}

function ssCrc(s) {
  if (!ssCrc.t) {const t = ssCrc.t = new Uint32Array(256); for (let n = 0; n < 256; n++) {let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0}}
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = ssCrc.t[(c ^ s.charCodeAt(i)) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function ssU16(n) {return String.fromCharCode(n & 255, (n >> 8) & 255)}
function ssU32(n) {return String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255)}
function ssZip(files) {
  let locals = '', central = '', offset = 0;
  files.forEach(f => {
    const name = f.name, data = f.text, crc = ssCrc(data), sz = data.length;
    const lh = 'PK\x03\x04' + ssU16(20) + ssU16(0) + ssU16(0) + ssU16(0) + ssU16(0) + ssU32(crc) + ssU32(sz) + ssU32(sz) + ssU16(name.length) + ssU16(0) + name + data;
    locals += lh;
    central += 'PK\x01\x02' + ssU16(20) + ssU16(20) + ssU16(0) + ssU16(0) + ssU16(0) + ssU16(0) + ssU32(crc) + ssU32(sz) + ssU32(sz) + ssU16(name.length) + ssU16(0) + ssU16(0) + ssU16(0) + ssU16(0) + ssU32(0) + ssU32(offset) + name;
    offset += lh.length;
  });
  return locals + central + 'PK\x05\x06' + ssU16(0) + ssU16(0) + ssU16(files.length) + ssU16(files.length) + ssU32(central.length) + ssU32(offset) + ssU16(0);
}

function ssExport(r, meta, opts) {
  const pack = ssCompose(r, meta || {}, opts || {});
  const pdf = ssPdf(pack.sheets, pack.info);
  const dxf = pack.sheets.map(s => ({name: s.no + '.dxf', text: ssDxf(s)}));
  const secrets = [meta && meta.apn, meta && meta.owner].filter(Boolean).map(String);
  if (pack.mode === 'public') {
    const hits = ssHits(pdf + '\n' + dxf.map(d => d.text).join('\n'), secrets);
    if (hits.length) {
      const bad = new Error('public export still contains ' + hits.join(', '));
      bad.hits = hits;
      throw bad;
    }
  }
  return {pdf, dxf, zip: ssZip(dxf.concat([{name: 'plan-set.pdf', text: pdf}])), sheets: pack.sheets.map(s => s.no), summary: pack.summary, check: pack.check, scales: pack.scales, scale: pack.scale, barFt: pack.barFt, paper: pack.paper, mode: pack.mode, info: pack.info, half: pack.half};
}

// Browser helper: Census TIGER Places (incorporated) for the vicinity inset. Free, no Mapbox.
async function ssLoadPlaces(P, ring) {
  if (typeof shxGet !== 'function' || !P || !ring || !ring.length) return [];
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  ring.forEach(p => {x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1])});
  const pad = Math.max(x1 - x0, y1 - y0, 2000);
  const a = P.b([x0 - pad, y0 - pad]), b = P.b([x1 + pad, y1 + pad]);
  const bb = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].join(',');
  const url = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query?geometry=' + bb + '&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NAME&f=geojson';
  const j = await shxGet(url, null, 1, 12000);
  const out = [];
  (j.features || []).forEach(f => {
    const g = f.geometry || {}, rings = g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
    const list = g.type === 'Polygon' ? [rings[0]] : rings;
    list.forEach(ringLl => {if (ringLl && ringLl.length > 2) out.push({name: (f.properties || {}).NAME || '', ring: ringLl.map(p => P.f(p))})});
  });
  return out;
}
