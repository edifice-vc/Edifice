// ---- Draft CUP packet (admin). Three documents from deal-app + Site Planning data.
// Marks: [AUTO · source] filled from data on hand; [ASSUMED · basis] a labeled planning assumption;
// [TBD] not on file; [TO BE ORDERED · what] a study, survey, title commitment, or letter still to commission.
// Public export withholds MW, generator counts, water volumes, parcel IDs / quick refs, and owner identity.
// The legal description's calls are grid bearings and grid distances on Kansas State Plane NAD83,
// North Zone (EPSG:3419) or South Zone (EPSG:3420), US survey feet, chosen from the county.
// They are not the Site Planning local tangent plane, and they are not ground distances.
// No other applicant's name, slogan, or exhibit lettering is used.
const CUP_BANNER = 'DRAFT — NOT A SURVEY. Boundary/ALTA survey by a Kansas PLS to be ordered.';
const CUP_SURVEY = 'To be ordered (survey / title commitment)';
const CUP_WITHHELD = '[withheld — public export]';

function cupNum(n, d) {
  if (n == null || !isFinite(+n)) return '';
  const neg = +n < 0;
  const s = Math.abs(+n).toFixed(d);
  const p = s.split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + p.join('.');
}
function cupWrap(text, max) {
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const chunk = w => { for (let i = 0; i < w.length; i += max) lines.push(w.slice(i, i + max)); };
  for (const w of words) {
    if (!cur) { if (w.length > max) chunk(w); else cur = w; continue; }
    if (cur.length + 1 + w.length <= max) cur += ' ' + w;
    else { lines.push(cur); if (w.length > max) { chunk(w); cur = ''; } else cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
function cupShow(f, pub) {
  const hide = !!(pub && f.redact && f.mark !== 'TBD' && f.mark !== 'ORDER');
  const v = hide ? CUP_WITHHELD : f.value;
  const tag = f.mark === 'ORDER' ? 'TO BE ORDERED' : f.mark;
  const src = f.source ? ' · ' + f.source : '';
  return (f.label ? f.label + ': ' : '') + v + ' [' + tag + src + ']';
}
function cupPush(fields, doc, spec) {
  let mark = spec.mark || 'TBD';
  let value = spec.value;
  const empty = value == null || String(value).trim() === '';
  if (empty) {
    if (mark === 'AUTO' || mark === 'ASSUMED') mark = 'TBD';
    value = mark === 'ORDER' ? (spec.empty || 'To be ordered') : 'TBD';
  }
  const f = { id: spec.id, doc: doc, label: spec.label || '', value: String(value), mark: mark, source: spec.source || '', redact: spec.redact || '' };
  fields.push(f);
  return f;
}
function cupBlocksText(blocks) {
  const o = [];
  (blocks || []).forEach(b => {
    if (b.t === 'h1' || b.t === 'h2' || b.t === 'p' || b.t === 'note') o.push(b.text);
    else if (b.t === 'ul') b.items.forEach(i => o.push('- ' + i));
    else if (b.t === 'table') { o.push(b.head.join(' | ')); b.rows.forEach(r => o.push(r.join(' | '))); }
    o.push('');
  });
  return o.join('\n');
}
function cupStr(v) { return v == null ? '' : String(v).trim(); }
function cupProvider(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return cupProvider(v[0]);
  return cupStr(v.provider || v.name || '');
}
function cupOwner(s) {
  const o = s && s.owner;
  if (!o) return { name: '', mailing: '', phone: '', email: '' };
  if (typeof o === 'string') return { name: o.trim(), mailing: '', phone: '', email: '' };
  return { name: cupStr(o.name || o.owner), mailing: cupStr(o.mailing || o.address), phone: cupStr(o.phone), email: cupStr(o.email) };
}
function cupParcels(s, meta) {
  const raw = (s && s.parcels) || [];
  const out = [];
  raw.forEach(p => {
    if (p == null || p === '') return;
    if (typeof p === 'string') out.push({ apn: p.trim(), quick: '' });
    else out.push({ apn: cupStr(p.apn || p.id || p.pin || p.parcel), quick: cupStr(p.quickRef || p.quick_ref || p.qref) });
  });
  if (!out.length && meta && meta.apn) String(meta.apn).split(';').map(x => x.trim()).filter(Boolean).forEach(apn => out.push({ apn: apn, quick: '' }));
  return out.filter(p => p.apn);
}
function cupAnnex(s) {
  const a = s && s.annexation;
  if (!a || !a.status || a.status === 'unknown') return '';
  if (a.status === 'annexed') return 'Inside city limits' + (a.place ? ' (' + a.place + ')' : '');
  if (a.status === 'unincorporated') return 'Unincorporated' + (a.nearest_city ? ', nearest incorporated place ' + a.nearest_city : '');
  return cupStr(a.status);
}
function cupTx(s) {
  const lines = (s && s.power && s.power.lines_by_class) || [];
  const l = lines.filter(x => x && isFinite(+x.kv)).sort((a, b) => (+b.kv) - (+a.kv))[0];
  if (!l) return null;
  return { kv: +l.kv, mi: l.mi != null && isFinite(+l.mi) ? +l.mi : null };
}
// Outward cardinal side of each solved edge, in the local east-north foot plane.
function cupEdgeSetbacks(r) {
  if (!r || !r.C || !r.C.edges || !r.C.edges.length || typeof shOpen !== 'function') return [];
  const un = r.C.un || (p => p);
  const Q = shOpen((r.C.Q || []).map(un));
  if (Q.length < 3) return [];
  let cx = 0, cy = 0;
  Q.forEach(p => { cx += p[0]; cy += p[1]; });
  cx /= Q.length; cy /= Q.length;
  return r.C.edges.map(([a, b, s, , k]) => {
    const A = un(a), B = un(b);
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    let nx = -(B[1] - A[1]), ny = B[0] - A[0];
    const L = Math.hypot(nx, ny) || 1;
    nx /= L; ny /= L;
    if (nx * (cx - mx) + ny * (cy - my) > 0) { nx = -nx; ny = -ny; }
    const side = Math.abs(ny) >= Math.abs(nx) ? (ny >= 0 ? 'N' : 'S') : (nx >= 0 ? 'E' : 'W');
    return { side: side, ft: +s, kind: (k && k.kind) || 'side' };
  }).filter(e => isFinite(e.ft));
}
function cupOrdFt(kind, ord) {
  if (!ord) return null;
  if (kind === 'rear') return ord.rear;
  if (kind === 'side') return ord.side;
  if (kind === 'front' || kind === 'front2') return ord.front;
  return null;
}
function cupSideTable(edges, ord) {
  return ['N', 'E', 'S', 'W'].map(side => {
    const es = edges.filter(e => e.side === side);
    if (!es.length) return { side: side, provided: null, ordinance: null, kind: '' };
    const kinds = [...new Set(es.map(e => e.kind))];
    const ov = kinds.length === 1 ? cupOrdFt(kinds[0], ord) : null;
    return { side: side, provided: Math.min(...es.map(e => e.ft)), ordinance: ov, kind: kinds.join('/') };
  });
}
function cupRingsOf(plan) {
  if (!plan || plan.polySrc === 'square') return [];
  return (plan.rings || []).filter(r => r && r.length >= 3);
}
function cupNorm(input) {
  input = input || {};
  const s = input.site || {};
  const plan = input.plan || {};
  const own = cupOwner(s);
  const parcels = cupParcels(s, input.meta);
  const elec = s.electric;
  const elecKv = elec && !Array.isArray(elec) && elec.served_kv != null ? +elec.served_kv : (Array.isArray(elec) && elec[0] && elec[0].served_kv != null ? +elec[0].served_kv : null);
  const ord = s.ordinance || {};
  const flood = s.floodplain || {};
  return {
    name: cupStr(s.name),
    address: cupStr(s.address),
    city: cupStr(s.city),
    county: cupStr(s.county),
    state: cupStr(s.state || (s.county || s.city ? 'KS' : '')),
    zip: cupStr(s.zip),
    acres: s.acres != null && s.acres !== '' && isFinite(+s.acres) ? +s.acres : null,
    district: cupStr(s.zoningDistrict || (typeof s.zoning === 'string' ? s.zoning : (s.zoning && s.zoning.district))),
    zoningUse: cupStr(s.zoningUse),
    zoningSrc: cupStr(s.zoningSource || (s.zoningDistrict || s.zoning ? 'deal record' : '')),
    ord: { front: ord.front != null ? +ord.front : null, side: ord.side != null ? +ord.side : null, rear: ord.rear != null ? +ord.rear : null, height: ord.height != null ? +ord.height : null, source: cupStr(ord.source) },
    electric: cupProvider(s.electric),
    electricKv: elecKv != null && isFinite(elecKv) ? elecKv : null,
    water: cupProvider(s.water),
    sewer: cupProvider(s.sewer),
    gas: cupProvider(s.gas),
    telecom: cupProvider(s.telecom),
    floodPct: flood.pct != null && isFinite(+flood.pct) ? +flood.pct : (s.floodPct != null && isFinite(+s.floodPct) ? +s.floodPct : null),
    floodZones: flood.zones || s.floodZones || [],
    floodAc: s.floodAc != null && isFinite(+s.floodAc) ? +s.floodAc : null,
    owner: own,
    parcels: parcels,
    plss: cupStr(s.plss),
    existingUse: cupStr(s.existing_use || s.existingUse || s.land_use),
    structures: cupStr(s.structures),
    annex: cupAnnex(s),
    tx: cupTx(s),
    compPlan: cupStr(s.compPlan || s.comp_plan),
    adjoining: cupStr(s.adjoining),
    plan: plan,
    rings: cupRingsOf(plan),
    geoRings: (plan.geoRings || []).filter(r => typeof cupLooksGeo !== 'function' || cupLooksGeo(r)),
    waterUse: input.water || {},
    generators: input.generators != null && input.generators !== '' && isFinite(+input.generators) ? +input.generators : null
  };
}
function cupPlace(c) {
  const line = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
  const cty = c.county ? c.county + ' County' : '';
  return [line, cty].filter(Boolean).join(', ');
}
function cupAudit(built) {
  const problems = [];
  const seen = new Set();
  built.fields.forEach(f => {
    const key = f.doc + '/' + f.id;
    if (seen.has(key)) problems.push('dup ' + key);
    seen.add(key);
    if (!f.value || !String(f.value).trim()) problems.push('blank ' + key);
    if ((f.mark === 'AUTO' || f.mark === 'ASSUMED') && !f.source) problems.push('nosrc ' + key);
    if (['AUTO', 'ASSUMED', 'TBD', 'ORDER'].indexOf(f.mark) < 0) problems.push('badmark ' + key);
    const text = (built.docs[f.doc] && built.docs[f.doc].text) || '';
    if (!text.includes(cupShow(f, built.publicMode))) problems.push('unrendered ' + key);
  });
  const all = Object.keys(built.docs).map(k => built.docs[k].text).join('\n');
  if (/\bundefined\b|\bNaN\b/.test(all)) problems.push('undefined or NaN');
  if (!built.docs.legal.text.startsWith(CUP_BANNER)) problems.push('banner');
  if (built.publicMode) {
    built.fields.forEach(f => {
      if (!f.redact || f.mark === 'TBD' || f.mark === 'ORDER') return;
      Object.keys(built.docs).forEach(k => { if (built.docs[k].text.includes(f.value)) problems.push('leak ' + k + '/' + f.id); });
    });
  }
  return problems;
}

function cupOps(c, F, show, asOf) {
  const doc = 'operations';
  const B = [];
  const h1 = t => B.push({ t: 'h1', text: t });
  const h2 = t => B.push({ t: 'h2', text: t });
  const p = t => B.push({ t: 'p', text: t });
  const ul = items => B.push({ t: 'ul', items: items });
  const tbl = (head, rows) => B.push({ t: 'table', head: head, rows: rows });
  const line = (id, label, mark, value, source, redact, empty) => show(F(doc, { id: id, label: label, mark: mark, value: value, source: source, redact: redact, empty: empty }));
  const jurisdiction = c.county ? (c.county + ' County, ' + (c.state || 'KS')) : '';
  const place = cupPlace(c);
  const hasLayout = !!(c.plan && c.plan.hasBoundary && c.plan.halls > 0);
  const it = hasLayout && c.plan.itMW != null ? cupNum(c.plan.itMW, 1) + ' MW critical (IT) load' : '';
  const fac = hasLayout && c.plan.facMW != null ? cupNum(c.plan.facMW, 1) + ' MW facility load in the planning model' : '';
  const fp = hasLayout && c.plan.footprintSf ? +c.plan.footprintSf : 0;
  let outlineSf = 0;
  c.rings.forEach(r => { if (typeof shArea === 'function') outlineSf += Math.abs(shArea(r)); });
  const cov = fp > 0 && outlineSf > 0 ? (fp / outlineSf * 100) : null;
  const coolWord = { air: 'air-cooled', liquid: 'liquid-cooled', hybrid: 'hybrid cooling' }[c.plan && c.plan.cool] || '';
  const sides = cupSideTable(c.plan.edges || [], c.ord);

  h1('Operations Plan');
  p('Draft assembled from the deal record and from Site Planning. It is not a sealed filing. Fields are marked AUTO, ASSUMED, TBD, or TO BE ORDERED. A blank was not filled with a guessed number.');
  h2('Cover');
  ul([
    line('name', 'Project name', c.name ? 'AUTO' : 'TBD', c.name, 'deal record name'),
    line('case', 'Jurisdiction and case type', jurisdiction ? 'AUTO' : 'ASSUMED', jurisdiction ? ('Conditional use permit — ' + jurisdiction) : 'Conditional use permit', jurisdiction ? 'deal record county' : 'packet type; the jurisdiction is not on the deal record'),
    line('location', 'Site location', place ? 'AUTO' : 'TBD', place, 'deal record address'),
    line('title', 'Document title', 'AUTO', 'Operations Plan', 'this export'),
    line('author', 'Author, firm, and professional seal', 'TBD', '', 'the deal app does not store a preparer or a seal')
  ]);
  h2('Version table');
  tbl(['Version', 'Issue date', 'Comment'], [[
    line('ver', '', 'AUTO', '0.1', 'first draft from this export'),
    line('date', '', asOf ? 'AUTO' : 'TBD', asOf, 'export date passed to the generator'),
    line('vernote', '', 'AUTO', 'Initial draft from deal-app and Site Planning data. Studies, survey, and title work are not in this packet.', 'this export')
  ]]);
  h2('Change log');
  p(line('chg', 'Change 1', 'AUTO', 'Version 0.1. No prior filed version is stored in the deal app. Studies listed as to be ordered were not in the record on this date.', 'this export'));
  p('There is no county comment letter in the deal record. Topics that usually arrive after filing — phasing, load, employees, ownership, lighting, generators, density, hazardous materials, and substation roles — are grouped after section 14 so they are not missing. That group is not a response to a staff letter.');

  h2('1. Use and Project Statement');
  p('The applicant asks for a conditional use permit to develop and operate a data center campus. The sentences below use only figures the deal app already has. Critical load is a Site Planning result, not a utility commitment.');
  ul([
    line('use-where', 'Request', 'AUTO', 'Conditional use permit to develop and operate a data center campus.', 'packet type'),
    line('use-acres', 'Assessor area', c.acres != null ? 'AUTO' : 'TBD', c.acres != null ? cupNum(c.acres, 2) + ' acres, assessor area' : '', 'deal record acres. This is not a surveyed area.'),
    line('use-survey-ac', 'Surveyed acres and legal description', 'ORDER', '', 'boundary / ALTA survey by a Kansas PLS', '', CUP_SURVEY),
    line('use-zone', 'Zoning district', c.district ? 'AUTO' : 'TBD', c.district, c.district ? (c.zoningSrc || 'deal record zoning') : ''),
    line('use-status', 'Zoning-record treatment of the use', c.zoningUse ? 'AUTO' : 'TBD', c.zoningUse, 'zoning record treatment status'),
    line('use-program', 'Program', hasLayout ? 'ASSUMED' : 'TBD', hasLayout ? (c.plan.halls + ' data hall' + (c.plan.halls === 1 ? '' : 's') + ', ' + (c.plan.stories || 'TBD') + ' story, with the yards, parking, and substation yard drawn in Site Planning') : '', 'Site Planning program. Building count is how many halls the concept plan placed.'),
    line('use-sub', 'On-site substation yard', 'ASSUMED', c.plan.hasSub ? 'An on-site substation yard is drawn in Site Planning. Who owns the land and the equipment is not in the record.' : 'No on-site substation yard is drawn. Whether one is required is not in the record.', 'Site Planning layout'),
    line('use-gen', 'Backup generation', 'ASSUMED', c.plan.hasGenYard ? 'The concept plan draws an equipment yard with halls. That yard is not a generator count.' : 'No equipment yard is drawn. Standby generation is not specified.', 'Site Planning layout'),
    line('use-it', 'Critical load at full build-out', it ? 'ASSUMED' : 'TBD', it, 'Site Planning solve, critical IT load, not a utility commitment', 'mw'),
    line('use-fac', 'Facility load in the planning model', fac ? 'ASSUMED' : 'TBD', fac, 'Site Planning solve, IT load times the planning PUE', 'mw'),
    line('use-annex', 'City limits', c.annex ? 'AUTO' : 'TBD', c.annex, 'deal record annexation status'),
    line('use-tx', 'Transmission proximity', c.tx ? 'AUTO' : 'TBD', c.tx ? (cupNum(c.tx.kv, 0) + ' kV' + (c.tx.mi != null ? ', about ' + cupNum(c.tx.mi, 2) + ' mi' : '')) : '', 'deal record transmission distance. Not a will-serve.'),
    line('use-fiber', 'Fiber / telecom', c.telecom ? 'AUTO' : 'TBD', c.telecom, 'deal record telecom provider'),
    line('use-comp', 'Comprehensive-plan designation', c.compPlan ? 'AUTO' : 'TBD', c.compPlan, 'deal record comprehensive-plan field'),
    line('use-flood', 'Floodplain', c.floodPct != null || (c.floodZones && c.floodZones.length) ? 'AUTO' : 'TBD', c.floodPct != null || (c.floodZones && c.floodZones.length) ? ((c.floodPct != null ? cupNum(c.floodPct, 1) + '% of the listed site in the deal-record FEMA summary' : 'FEMA zones on the deal record') + (c.floodZones && c.floodZones.length ? '. Zones: ' + c.floodZones.join(', ') : '') + '. Screening-grade. The flood line is not surveyed.') : '', 'deal record floodplain summary'),
    line('use-adj', 'Adjoining zoning and uses', c.adjoining ? 'AUTO' : 'TBD', c.adjoining, 'deal record adjoining-use note'),
    line('use-staff', 'Staffing, hours, and traffic character', 'TBD', '', 'headcount and a traffic study are not in the deal record'),
    line('use-cool', 'Cooling concept', coolWord ? 'ASSUMED' : 'TBD', coolWord ? coolWord + '. Water use is not calculated from this label.' : '', 'Site Planning cooling input, until mechanical design'),
    line('use-mit', 'Mitigation studies', 'ORDER', '', 'noise, lighting, drainage, and traffic studies')
  ]);
  p('Compatibility with the district is not decided here. Setbacks drawn on the concept plan are listed in the next section. This draft does not claim a tax, school, or welfare finding.');

  h2('2. Site Plan Narrative');
  p(line('sp-pointer', 'Site plan', c.rings.length ? 'AUTO' : 'ORDER', c.rings.length ? 'The concept plan in Site Planning shows the outline, halls, yards, parking, substation yard, and detention if they fit. It is screening-grade.' : '', c.rings.length ? (c.plan.boundarySource || 'Site Planning outline') : 'filing-grade site plan', '', c.rings.length ? '' : CUP_SURVEY));
  p('Setback table. Provided distances are the concept plan, screening-grade until a survey. Ordinance distances are printed only when the zoning record has a number. Cardinal side is the outward normal of each edge in the local east-north plane.');
  const setRows = sides.map(s => {
    const oSrc = s.ordinance != null ? (c.ord.source || 'zoning record') + ', ' + (s.kind || 'edge') + ' setback' : (s.kind ? 'edges on this side are ' + s.kind + ', not one ordinance class' : 'no edge faces this cardinal side');
    return [
      s.side,
      show(F(doc, { id: 'ord-' + s.side, label: '', mark: s.ordinance != null ? 'AUTO' : 'TBD', value: s.ordinance != null ? cupNum(s.ordinance, 0) + ' ft' : '', source: oSrc })),
      show(F(doc, { id: 'prv-' + s.side, label: '', mark: s.provided != null ? 'AUTO' : 'TBD', value: s.provided != null ? cupNum(s.provided, 0) + ' ft' : '', source: s.provided != null ? 'Site Planning concept plan, screening-grade until a survey' : '' }))
    ];
  });
  setRows.push(['Corner', show(F(doc, { id: 'ord-corner', label: '', mark: 'TBD', value: '', source: 'no separate corner setback is stored' })), show(F(doc, { id: 'prv-corner', label: '', mark: 'TBD', value: '', source: 'no separate corner dimension is drawn' }))]);
  tbl(['Boundary', 'Ordinance', 'Provided on the concept plan'], setRows);
  const covVal = cov != null ? cupNum(cov, 2) + '% campus-wide. Footprint ' + cupNum(fp, 0) + ' sf divided by the Site Planning outline ' + cupNum(outlineSf / 43560, 2) + ' acres (' + cupNum(Math.round(outlineSf), 0) + ' sf). Substation yards are not in the footprint. Assessor acres are not used in this percentage.' + (c.acres != null ? ' Assessor area is ' + cupNum(c.acres, 2) + ' acres and is a different source.' : '') : '';
  ul([
    line('density', 'Building density', cov != null ? 'AUTO' : 'TBD', covVal, 'calculated from Site Planning footprint and outline area. Surveyed area is to be ordered before this percentage is filed.'),
    line('height-des', 'Height to roof', c.plan && c.plan.heightFt ? 'ASSUMED' : 'TBD', c.plan && c.plan.heightFt ? cupNum(c.plan.heightFt, 0) + ' ft, ' + (c.plan.stories || '') + ' story, from the planning storey height' : '', 'Site Planning stories times storey height'),
    line('height-ord', 'Ordinance height limit', c.ord.height != null ? 'AUTO' : 'TBD', c.ord.height != null ? cupNum(c.ord.height, 0) + ' ft' : '', c.ord.source || 'zoning record max height'),
    line('light', 'Lighting concept', 'ASSUMED', 'Full-cutoff fixtures aimed at the site. Pole height: TBD. Property-line illuminance: TBD.', 'planning intent only; no photometric calc is in the deal app'),
    line('photo', 'Photometric plan', 'ORDER', '', 'lighting study'),
    line('sub-why', 'Substation role in this CUP', 'TBD', '', 'utility, voltage, land control, and whether the utility yard is part of the permit are not in the record'),
    line('park-ord', 'Parking ordinance standard', 'TBD', '', 'no data-center stall standard is stored for this jurisdiction'),
    line('park-prv', 'Stalls on the concept plan', c.plan && c.plan.stalls != null ? 'ASSUMED' : 'TBD', c.plan && c.plan.stalls != null ? cupNum(c.plan.stalls, 0) + ' stalls' : '', 'Site Planning stalls-per-hall input times halls placed'),
    line('fence', 'Fence, openings, berms, and plant mix', 'TBD', '', 'fence height and type are not in Site Planning'),
    line('fence-ord', 'Fence ordinance limit', 'TBD', '', 'not in the zoning record used here'),
    line('los', 'Line of sight', 'ORDER', '', 'key map, sections, and existing-versus-proposed views')
  ]);

  h2('3. Noise');
  ul([
    line('noise-target', 'Design target', 'ASSUMED', 'No numeric limit is on the deal record. The figure used for siting conversation is the EPA 55 dBA guideline, and it is only a guideline, not an adopted local limit.', 'EPA guideline, labeled because the zoning record has no dBA number'),
    line('noise-ambient', 'Existing ambient', 'ORDER', '', 'acoustical survey: locations, dates, L90, L10, and Leq'),
    line('noise-model', 'Predictive model', 'ORDER', '', 'property-line model for typical operation, generator testing, and outage, including any school or residence the jurisdiction names'),
    line('noise-subs', 'Substations in the model', 'TBD', '', 'no model is on file, so this draft cannot say that on-site or utility substations were included'),
    line('noise-verify', 'Post-construction verification', 'ASSUMED', 'A verification measurement is the planning intent. The timing is TBD.', 'planning intent; no protocol is in the record')
  ]);

  h2('4. Utilities');
  p(line('util-cup', 'Effect of CUP approval', 'ASSUMED', 'Approval of the conditional use does not, by itself, authorize utility construction.', 'planning statement, unless counsel directs otherwise'));
  ul([
    line('util-elec', 'Electric provider', c.electric ? 'AUTO' : 'TBD', c.electric, 'deal record electric provider'),
    line('util-kv', 'Listed service or nearby transmission voltage', c.electricKv || c.tx ? 'AUTO' : 'TBD', c.electricKv ? cupNum(c.electricKv, 0) + ' kV on the deal record' : (c.tx ? cupNum(c.tx.kv, 0) + ' kV nearby, not a service commitment' : ''), c.electricKv ? 'deal record served voltage' : 'deal record transmission distance'),
    line('util-ws', 'Electric will-serve or capacity letter', 'ORDER', '', 'utility letter'),
    line('util-water', 'Water provider named on the deal', c.water ? 'AUTO' : 'TBD', c.water, 'deal record water provider. A name is not a commitment.'),
    line('util-sewer', 'Wastewater provider named on the deal', c.sewer ? 'AUTO' : 'TBD', c.sewer, 'deal record sewer provider. A name is not a commitment.'),
    line('util-pref', 'Preferred water and wastewater path', 'TBD', '', 'the deal record does not select municipal, rural-district, or on-site service'),
    line('util-wells', 'On-site wells', 'ASSUMED', 'None are drawn in Site Planning and none are named on the deal record. This is not a permit determination.', 'absence of a well in the concept plan'),
    line('util-commit', 'Provider commitment', 'ORDER', '', 'utility letter')
  ]);

  h2('5. Water Usage');
  p('Three demand figures are reported separately. Peak and maximum-day values are not annualized. Volumes are omitted from a public export. No volume is invented when mechanical loads are absent.');
  const wu = c.waterUse || {};
  const wline = (id, label, raw, unit, note) => raw != null && raw !== '' && isFinite(+raw)
    ? line(id, label, 'ASSUMED', cupNum(+raw, 0) + ' ' + unit + '. ' + note, 'mechanical planning figure supplied to the export, not a measured demand', 'water')
    : line(id, label, 'TBD', '', note);
  ul([
    wline('w-peak', 'Peak instantaneous demand', wu.peakGpm, 'gpm', 'Pipe sizing only. Do not annualize. Per building and at build-out are both TBD until mechanical loads exist.'),
    wline('w-max', 'Maximum daily demand', wu.maxGpd, 'gpd', 'Not a typical day. The driver (humidification or another use) is TBD. Do not annualize.'),
    wline('w-avg', 'Average annual demand', wu.annualGpy, 'gpy', 'Average year. Do not treat peak or maximum day as a year.'),
    line('w-staff', 'Domestic staffing basis', 'TBD', '', 'the same headcount gap as section 1. Fixture-unit math is not run without a headcount.')
  ]);

  h2('6. Electrical Details');
  ul([
    line('el-path', 'Transmission path and on-site distribution', 'TBD', '', 'circuit count, voltage, and routing are not designed in Site Planning'),
    line('el-block', 'Building electrical block', hasLayout ? 'ASSUMED' : 'TBD', hasLayout ? c.plan.halls + ' halls on the concept plan. Hall bus, redundancy, and IT per hall are not a one-line.' : '', 'Site Planning hall count only'),
    line('el-fuel', 'Standby fuel', 'TBD', '', 'fuel type is not in the deal record'),
    line('el-count', 'Standby generator count', c.generators != null ? 'ASSUMED' : 'TBD', c.generators != null ? cupNum(c.generators, 0) + ' standby generators' : '', c.generators != null ? 'planning figure supplied to the export, not a vendor schedule' : 'not in the deal record. Equipment yards are not counted as generators.', 'gen'),
    line('el-test', 'Testing cycle and on-site fuel storage', 'TBD', '', 'not in the deal record')
  ]);

  h2('7. Prototypical Building Plans');
  ul([
    line('proto', 'Architectural and MEP prototype', 'ORDER', '', 'prototype or project-specific drawing set'),
    line('proto-method', 'Construction method', 'TBD', '', 'modular versus site-built, and the resulting duration and traffic, are not in the record'),
    line('proto-fluid', 'Cooling fluid, make-up, blowdown, and reclamation', 'TBD', '', 'reviewers ask where spent fluid goes. The destination is not in the record and is not guessed.')
  ]);

  h2('8. Environmental Studies');
  p('If a report is not in the record, this draft says it will be ordered.');
  ul([
    line('env-esa', 'Phase I ESA', 'ORDER', '', 'Phase I environmental site assessment'),
    line('env-bio', 'Biological, habitat, and wetlands', 'ORDER', '', 'habitat and wetland study'),
    line('env-geo', 'Geotechnical', 'ORDER', '', 'desktop or field geotechnical study'),
    line('env-air', 'Air quality, corrosion, and weather', 'ORDER', '', 'air and weather summary, if the filing uses one')
  ]);

  h2('9. Drainage Report');
  ul([
    line('dr-rep', 'Drainage report', 'ORDER', '', 'drainage report'),
    line('dr-fp', 'Floodplain on the outline', c.floodAc != null && c.floodAc > 0 ? 'AUTO' : (c.floodPct != null ? 'AUTO' : 'TBD'), c.floodAc != null && c.floodAc > 0 ? cupNum(c.floodAc, 2) + ' acres of SFHA inside the outline, screening-grade' : (c.floodPct != null ? cupNum(c.floodPct, 1) + '% in the deal-record FEMA summary. Acres on the outline were not computed.' : ''), c.floodAc != null && c.floodAc > 0 ? 'Site Planning intersection with FEMA SFHA polygons' : 'deal record floodplain summary'),
    line('dr-survey', 'Surveyed flood line and any no-disturbance limit', 'ORDER', '', 'survey', '', CUP_SURVEY),
    line('dr-det', 'Detention concept', c.plan && c.plan.detAcFt != null ? 'ASSUMED' : 'TBD', c.plan && c.plan.detAcFt != null ? cupNum(c.plan.detAcFt, 2) + ' ac-ft required in the Site Planning stormwater screen' : '', 'Site Planning stormwater screen, not a drainage report')
  ]);

  h2('10. Traffic Impact Assessment');
  ul([
    line('tia', 'Traffic impact assessment', 'ORDER', '', 'traffic impact assessment'),
    line('tia-char', 'Trip character', 'ASSUMED', 'Operational traffic is employees, vendors, and service vehicles. Construction traffic is separate. No trip count is stated.', 'planning character only, until a traffic study')
  ]);

  h2('11. Construction Management');
  ul([
    line('cm-hours', 'Construction hours', 'TBD', '', 'not in the deal record'),
    line('cm-route', 'Construction access routes', 'TBD', '', 'often set by public-works comments, which are not in the record'),
    line('cm-sec', 'Security during construction', 'TBD', '', 'not in the deal record')
  ]);
  p('Phasing is in supplement S2A. It is a concept-plan sequence, not a construction schedule.');

  h2('12. Fire Safety Plans');
  p(line('fire', 'Access, water supply, suppression, and fire-district coordination', 'TBD', '', 'not coordinated. This draft does not commit a station, an apparatus, or a hydrant flow. Fuel wording will follow the standby-fuel field, which is TBD.'));

  h2('13. Emergency Response Plan');
  p(line('eap', 'Site-specific emergency action plan', 'ORDER', '', 'emergency action plan. The state spill hotline and local contacts belong in that plan; they are not copied here before the plan exists.'));

  h2('14. Decommissioning and Reclamation');
  ul([
    line('dec-path', 'End of operations', 'ASSUMED', 'Adaptive reuse is the planning preference. Equipment and cooling fluid would be removed. This is not a promise of a reuse or of a residual value.', 'planning preference'),
    line('dec-bond', 'Financial assurance', 'TBD', '', 'mechanism to be agreed with the jurisdiction before occupancy')
  ]);

  h2('Supplement');
  p('No county request letter is on the deal record. The sections follow the usual request order so the topics are present. Dates of provider talks are not invented.');
  h2('S1. Public Utility Connections');
  p(line('s1', 'Utility path', 'TBD', '', 'preferred versus alternate path, and the timeline of provider talks, are not in the record'));
  h2('S1A. Municipal Water and Wastewater');
  p(line('s1a', 'Municipal path', c.water || c.sewer ? 'AUTO' : 'TBD', (c.water || c.sewer) ? ('Named on the deal record: ' + [c.water && ('water ' + c.water), c.sewer && ('wastewater ' + c.sewer)].filter(Boolean).join('; ') + '. Whether either provider is municipal, and whether it will serve the site, is TBD.') : '', 'deal record provider names'));
  h2('S1B. Other Water and Wastewater Path');
  ul([
    line('s1b-path', 'Rural district or on-site path', 'TBD', '', 'not selected'),
    line('s1b-plan', 'Alternate utility site plan', 'ORDER', '', 'engineering, if a second path is used'),
    line('s1b-land', 'Land application of effluent', 'TBD', '', 'not proposed in the deal record. Floodplain, wells, setbacks, livestock, pH, and fencing would be stated here only if land application were proposed.'),
    line('s1b-off', 'Off-site improvements', 'TBD', '', 'whether they serve only this site, and whether they sit on applicant land, is not in the record')
  ]);

  h2('S2A. Phases');
  p(line('ph-note', 'Phasing basis', c.plan && c.plan.phases && c.plan.phases.length ? 'ASSUMED' : 'TBD', c.plan && c.plan.phases && c.plan.phases.length ? 'The concept plan places ' + c.plan.phases.length + ' phase' + (c.plan.phases.length === 1 ? '' : 's') + '. Calendar timing is not in the record. The sequence is subject to demand and approvals.' : '', 'Site Planning phase rows'));
  const ph = (c.plan && c.plan.phases) || [];
  if (ph.length) {
    tbl(['Phase', 'Buildings', 'Critical load', 'Facility load in the model', 'What the concept plan includes'], ph.map((row, i) => [
      'P' + row.k,
      show(F(doc, { id: 'ph-n-' + i, label: '', mark: 'ASSUMED', value: cupNum(row.halls, 0) + ' halls', source: 'Site Planning phase row' })),
      show(F(doc, { id: 'ph-it-' + i, label: '', mark: 'ASSUMED', value: cupNum(row.it, 1) + ' MW', source: 'Site Planning phase IT load', redact: 'mw' })),
      show(F(doc, { id: 'ph-fac-' + i, label: '', mark: 'ASSUMED', value: cupNum(row.fac, 1) + ' MW', source: 'Site Planning phase facility load', redact: 'mw' })),
      show(F(doc, { id: 'ph-inf-' + i, label: '', mark: 'ASSUMED', value: row.k === 1 ? 'Phase 1 is the first halls plus the substation yard, parking, and detention if the concept plan drew them.' : 'Later phase halls. Shared yards stay with phase 1 unless the plan says otherwise.', source: 'Site Planning layout, not a dated schedule' }))
    ]));
  } else p('No phase table: the concept plan did not place halls.');
  p(line('ph-time', 'Calendar timing and construction hours', 'TBD', '', 'not in the deal record'));

  h2('S2B. Electrical Load');
  p('Critical load and the planning-model facility load are the same figures as section 1 and section 6. "Critical" means IT load in Site Planning. It is not total site demand from a utility study.');
  ul([
    line('s2b-it', 'Critical IT load at the concept build-out', it ? 'ASSUMED' : 'TBD', it, 'Site Planning solve', 'mw'),
    line('s2b-fac', 'Facility load in the planning model', fac ? 'ASSUMED' : 'TBD', fac, 'Site Planning solve, IT times planning PUE. A utility study may be higher.', 'mw')
  ]);

  h2('S2C. Employees');
  p(line('s2c', 'Employees by phase and at build-out', 'TBD', '', 'same gap as section 1. Vendor and contractor counts are excluded and are also TBD. Section 1, section 5, and this table use one answer: headcount is not in the record.'));

  h2('S2D. Ownership');
  ul([
    line('own-name', 'Owner of record named on the deal', c.owner.name ? 'AUTO' : 'TBD', c.owner.name, 'deal record owner field. Title work must confirm every owner. One name can be incomplete.', 'owner'),
    line('own-mail', 'Owner mailing address', c.owner.mailing ? 'AUTO' : 'TBD', c.owner.mailing, 'deal record owner mailing address', 'owner'),
    line('own-contract', 'Purchase contract and closing', 'TBD', '', 'not taken from the deal record for this draft'),
    line('own-hold', 'Who holds the land through construction and operations', 'TBD', '', 'not in the deal record')
  ]);

  h2('S2E. Tenants');
  p(line('ten', 'Building operator and IT tenant', 'TBD', '', 'no tenant is identified in the deal record. Who operates the building versus the IT equipment is TBD.'));

  h2('S2F. Lighting');
  p(line('s2f', 'Nighttime photometric plans', 'ORDER', '', 'photometric plan'));

  h2('S2G. Generators');
  p('Count, fuel, storage, testing, and emergency start stay consistent with sections 3 and 6. An equipment yard is not a generator.');
  ul([
    line('s2g-count', 'Count', c.generators != null ? 'ASSUMED' : 'TBD', c.generators != null ? cupNum(c.generators, 0) + ' standby generators' : '', c.generators != null ? 'same planning figure as section 6' : 'same gap as section 6', 'gen'),
    line('s2g-fuel', 'Fuel, storage, testing, and emergency start', 'TBD', '', 'same gap as section 6')
  ]);

  h2('S2H. Security');
  p(line('s2h', 'Security during construction and operations', 'TBD', '', 'not in the deal record'));

  h2('S2I. Building Density');
  p('The coverage math is the same campus-wide figure as section 2. Substation control buildings are not included because none are drawn as buildings.');
  p(line('s2i', 'Coverage', cov != null ? 'AUTO' : 'TBD', covVal, 'same calculation as section 2'));

  h2('S2J. Hazardous Material');
  p('Quantities wait for a basis of design. The rows are listed so the question is not skipped.');
  tbl(['Material', 'Quantity and storage', 'Handling'], ['Cooling fluid', 'Standby fuel', 'Refrigerant', 'Water-treatment chemicals', 'Batteries'].map(name => [
    name,
    show(F(doc, { id: 'hz-q-' + name.slice(0, 3), label: '', mark: 'TBD', value: '', source: 'basis of design' })),
    show(F(doc, { id: 'hz-h-' + name.slice(0, 3), label: '', mark: 'TBD', value: '', source: 'basis of design' }))
  ]));

  h2('S3. Noise Study Scope');
  p(line('s3', 'Whether substations are in the sound model', 'TBD', '', 'same gap as section 3. The acoustical consultant has not been given a scope in this record.'));

  h2('S4. Applicant Substations');
  ul([
    line('s4-draw', 'Concept-plan substation yard', 'ASSUMED', c.plan.hasSub ? 'One on-site substation yard is drawn.' : 'No on-site substation yard is drawn.', 'Site Planning layout'),
    line('s4-role', 'Purpose, land rights, who builds, timing, operations, maintenance, and reclamation', 'TBD', '', 'not in the deal record')
  ]);

  h2('S5. Utility Substation');
  ul([
    line('s5-role', 'Purpose, land rights, who builds, timing, operations, maintenance, and reclamation', 'TBD', '', 'not in the deal record'),
    line('s5-ack', 'Written utility acknowledgement that the substation is part of the conditional use', 'ORDER', '', 'utility letter'),
    line('s5-own', 'Who owns the equipment after construction', 'TBD', '', 'not in the deal record')
  ]);
  p('Exhibit index for this draft, separate from any other filing: A line of sight, B sound, C building plans, D Phase I ESA, E habitat, F geotechnical, G air and weather, H drainage, I traffic, J emergency plan, K electric will-serve, L photometrics, M utility-substation letter. Each one is to be ordered. Letters are not reused from another case.');
  return { id: doc, title: 'Operations Plan', filename: '01-operations-plan', blocks: B };
}

function cupApp(c, F, show, asOf) {
  const doc = 'application';
  const B = [];
  const h1 = t => B.push({ t: 'h1', text: t });
  const h2 = t => B.push({ t: 'h2', text: t });
  const p = t => B.push({ t: 'p', text: t });
  const ul = items => B.push({ t: 'ul', items: items });
  const tbl = (head, rows) => B.push({ t: 'table', head: head, rows: rows });
  const line = (id, label, mark, value, source, redact, empty) => show(F(doc, { id: id, label: label, mark: mark, value: value, source: source, redact: redact, empty: empty }));
  const place = cupPlace(c);
  h1('Conditional use permit application data sheet');
  p('Draft data sheet. The field list follows a typical Kansas county conditional-use form: owner, representative, property, requested action, required documents, acknowledgment. It is not the jurisdiction\'s official form and generating it does not file anything. Issue date ' + (asOf || 'TBD') + '.');
  p(c.county ? line('jur', 'Jurisdiction', 'AUTO', c.county + ' County, ' + (c.state || 'KS'), 'deal record county') : line('jur', 'Jurisdiction', 'TBD', '', 'deal record county'));

  h2('Property Owner Information');
  p('Every owner of record has to be confirmed by title work. A deal record often names one owner. This sheet does not drop the others; it says they are to be confirmed.');
  ul([
    line('atype', 'Applicant type', 'TBD', '', 'the deal record does not say owner, applicant, or representative'),
    line('oname', 'Owner name', c.owner.name ? 'AUTO' : 'TBD', c.owner.name, 'deal record owner field', 'owner'),
    line('omail', 'Owner mailing address', c.owner.mailing ? 'AUTO' : 'TBD', c.owner.mailing, 'deal record owner mailing address', 'owner'),
    line('ophone', 'Owner phone', c.owner.phone ? 'AUTO' : 'TBD', c.owner.phone, 'deal record owner phone', 'owner'),
    line('oemail', 'Owner email', c.owner.email ? 'AUTO' : 'TBD', c.owner.email, 'deal record owner email', 'owner'),
    line('oother', 'Other owners of record', 'ORDER', '', 'title commitment. Do not assume the single name above is the only owner.', '', CUP_SURVEY)
  ]);

  h2('Representative Information');
  p('The civil or land-use representative is not stored on the deal. No name is invented.');
  ul(['First name', 'Last name', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Business'].map(lab => line('rep-' + lab.slice(0, 3).toLowerCase(), 'Representative ' + lab.toLowerCase(), 'TBD', '', 'not in the deal record')));

  h2('Property Information');
  const apnVal = c.parcels.length ? c.parcels.map(p => p.apn).join('; ') : '';
  const qKnown = c.parcels.filter(p => p.quick);
  const qVal = c.parcels.length ? c.parcels.map(p => p.quick || 'TBD').join('; ') : '';
  ul([
    line('addr', 'Property address', place ? 'AUTO' : 'TBD', place, 'deal record address. Unplatted land often has no street number; do not invent one.'),
    line('apn', 'Parcel IDs (all)', apnVal ? 'AUTO' : 'TBD', apnVal, 'deal record parcels. Every id is listed, not only the first.', 'apn'),
    line('qref', 'Quick reference numbers (all)', qKnown.length ? 'AUTO' : 'TBD', qKnown.length ? qVal : '', qKnown.length ? 'deal record quick ref. A parcel with no quick ref is marked TBD inside the list and is not copied from the parcel id.' : 'not in the deal record', 'apn'),
    line('subd', 'Subdivision', 'TBD', '', 'not on the deal record. Do not enter NA unless the record says the land is unplatted.'),
    line('block', 'Block', 'TBD', '', 'not on the deal record'),
    line('lot', 'Lot', 'TBD', '', 'not on the deal record'),
    line('ac-form', 'Acreage on the form', c.acres != null ? 'AUTO' : 'TBD', c.acres != null ? cupNum(c.acres, 2) + ' acres, assessor area' : '', 'deal record acres, labeled assessor area'),
    line('ac-pls', 'Surveyed acreage', 'ORDER', '', 'boundary / ALTA survey', '', CUP_SURVEY),
    line('use', 'Existing use', c.existingUse ? 'AUTO' : 'TBD', c.existingUse, 'deal record existing use. Confirm in the field.'),
    line('bldg', 'Existing structures', c.structures ? 'AUTO' : 'TBD', c.structures, 'deal record structures. A survey should confirm what is on the ground.', '', CUP_SURVEY),
    line('uniq', 'Unique features', c.floodPct != null || (c.floodZones && c.floodZones.length) ? 'AUTO' : 'TBD', c.floodPct != null || (c.floodZones && c.floodZones.length) ? ('Floodplain: ' + (c.floodPct != null ? cupNum(c.floodPct, 1) + '% in the deal-record FEMA summary' : 'zones on the deal record') + (c.floodZones && c.floodZones.length ? ', zone ' + c.floodZones.join(', ') : '') + (c.floodAc != null && c.floodAc > 0 ? ', about ' + cupNum(c.floodAc, 2) + ' acres of SFHA on the outline in Site Planning' : '') + '. Screening-grade. Steep slopes are TBD unless a survey measures them.') : '', 'deal record floodplain and, if present, Site Planning SFHA acres')
  ]);

  h2('Requested Action');
  const prop = (c.plan && c.plan.co === 'storage') ? 'Self-storage' : 'Data center';
  ul([
    line('act', 'Requested action', c.zoningUse && /conditional|special|cup|sup/i.test(c.zoningUse) ? 'AUTO' : 'ASSUMED', 'Conditional use permit', c.zoningUse && /conditional|special|cup|sup/i.test(c.zoningUse) ? 'zoning record status: ' + c.zoningUse : 'this packet is a conditional-use draft; the deal record does not store a filed action'),
    line('amd', 'Is this an amendment', 'TBD', '', 'not on the deal record'),
    line('cz', 'Current zoning', c.district ? 'AUTO' : 'TBD', c.district, c.zoningSrc || 'deal record zoning'),
    line('pu', 'Proposed conditional use', 'ASSUMED', prop, 'Site Planning program'),
    line('why-fit', 'Why the current zoning is or is not the right fit', 'ASSUMED', 'This draft does not argue that the zoning is a poor fit. The district and the use status are the tagged fields above. Whether a conditional use is available, and whether a rezoning is unnecessary, is for the jurisdiction.', 'drafted from the tagged zoning fields; not a staff report'),
    line('how-long', 'How long the property has been in the current zoning', 'TBD', '', 'not on the deal record'),
    line('near', 'Zoning and use of nearby properties', c.adjoining ? 'AUTO' : 'TBD', c.adjoining, 'deal record adjoining-use note'),
    line('effect', 'Effect on nearby properties', 'TBD', '', 'not assessed in the deal record. Concept-plan setbacks are in the operations plan. They are not a compatibility finding.'),
    line('welfare', 'Will the conditional use improve public health, safety, or welfare', 'TBD', '', 'the deal record does not support a yes or no. Traffic, stormwater, noise, and lighting studies are to be ordered.')
  ]);

  h2('Required Documents');
  p('Checked means the file is in this draft packet. A concept plan and these drafts are not the filing-grade set.');
  const docs = [
    ['Site plan', 'Concept plan exists only when Site Planning has an outline. Filing-grade boundary, easements, and right-of-way need a survey and a title commitment.', true],
    ['Legal description', 'The draft in this packet. A licensed surveyor description is still to be ordered.', true],
    ['Operations plan', 'The draft in this packet.', false],
    ['Recorded deed', 'Current vesting deed for every parcel.', true],
    ['Owner authorization', 'Names can be pre-filled. The owner or an authorized officer must sign. This app does not sign.', true],
    ['Title commitment', 'Easements and exceptions of record.', true],
    ['Boundary / ALTA survey', 'Not in the record.', true]
  ];
  tbl(['Item', 'Status', 'In this draft'], docs.map((d, i) => [
    d[0],
    show(F(doc, { id: 'req-' + i, label: '', mark: 'ORDER', value: '', empty: d[2] ? CUP_SURVEY : 'To be ordered', source: d[1] })),
    'No — not a filed exhibit'
  ]));

  h2('Acknowledgment');
  ul([
    line('ack', 'Acknowledgment checkbox', 'TBD', '', 'not signed. Generating this sheet does not authorize a filing.'),
    line('sig', 'Authorized signature', 'TBD', '', 'the deal app cannot sign'),
    line('print', 'Print name', 'TBD', '', 'not stored as a filer'),
    line('sdate', 'Signature date', 'TBD', '', 'not signed')
  ]);
  p('Exhibit index: see the operations plan. Letters A through M in that draft are this packet\'s index, each to be ordered.');
  return { id: doc, title: 'Conditional Use Permit Application Data Sheet', filename: '02-cup-application', blocks: B };
}

function cupLegal(c, F, show) {
  const doc = 'legal';
  const B = [];
  const h1 = t => B.push({ t: 'h1', text: t });
  const h2 = t => B.push({ t: 'h2', text: t });
  const p = t => B.push({ t: 'p', text: t });
  const ul = items => B.push({ t: 'ul', items: items });
  const line = (id, label, mark, value, source, redact, empty) => show(F(doc, { id: id, label: label, mark: mark, value: value, source: source, redact: redact, empty: empty }));
  B.push({ t: 'note', text: CUP_BANNER });
  h1('Draft legal description');
  p(c.name ? line('l-name', 'Project', 'AUTO', c.name, 'deal record name') : line('l-name', 'Project', 'TBD', '', 'deal record name'));
  p(line('l-place', 'Location named on the deal', cupPlace(c) ? 'AUTO' : 'TBD', cupPlace(c), 'deal record address'));
  const zone = typeof cupSpcsZone === 'function' ? cupSpcsZone(c.county) : null;
  const geo = (c.geoRings || []).filter(r => typeof cupLooksGeo === 'function' && cupLooksGeo(r));
  const grids = zone && typeof cupSpcsRing === 'function' && typeof shCourses === 'function' ? geo.map(r => cupSpcsRing(r, zone)).filter(Boolean) : [];
  p(zone
    ? 'Calls are grid bearings and grid distances on ' + zone.label + '. Vertices are the parcel outline as stored, used as NAD83 geographic positions with no datum shift. Distances are not ground distances.'
    : 'No Kansas State Plane zone was selected, so this draft does not compute calls. The local east-north plane used elsewhere in Site Planning is not a basis of bearings.');
  if (!grids.length || typeof shCourses !== 'function') {
    const why = !geo.length
      ? 'no geographic parcel outline is on file' + (c.plan && c.plan.polySrc === 'square' ? '. The acreage square drawn around the pin is not a boundary and is not described here.' : '.')
      : !zone
        ? 'the county on the deal record is not a Kansas North Zone or South Zone county, so no zone was assumed.'
        : 'the outline could not be projected.';
    h2('Point of beginning');
    p(line('pob', 'Point of beginning', 'ORDER', '', why, '', CUP_SURVEY));
    h2('Calls');
    p(line('calls', 'Metes and bounds calls', 'ORDER', '', 'boundary / ALTA survey on the Kansas State Plane grid', '', CUP_SURVEY));
    h2('Area statement');
    p(line('area', 'Grid area', 'ORDER', '', 'a State Plane grid area is not computed without a zone and a geographic outline', '', CUP_SURVEY));
  } else {
    let totalSf = 0;
    const src = zone.label + ', grid distance, screening-grade until a Kansas PLS signs the description';
    grids.forEach((ring, i) => {
      const P = shOpen(ring);
      const courses = shCourses(P);
      const suf = grids.length > 1 ? '-' + (i + 1) : '';
      const part = grids.length > 1 ? 'Part ' + (i + 1) + '. ' : '';
      h2(part + 'Point of beginning');
      const pob = P[0];
      p(line('pob' + suf, 'Point of beginning', 'AUTO', 'P1, Easting ' + cupNum(pob[0], 2) + ' ft, Northing ' + cupNum(pob[1], 2) + ' ft, ' + zone.label + '. This is not a monument and it is not a section corner.', 'first stored vertex, projected to ' + zone.label));
      h2(part + 'Calls');
      p('Calls follow stored vertex order and return to P1. Bearings are grid bearings from grid north. Distances are grid distances in US survey feet.');
      courses.forEach(course => {
        p(line('c' + suf + '-' + course.n, 'Course ' + course.n + ' (P' + course.from + ' to P' + course.to + ')', 'AUTO', course.brg + ', ' + cupNum(course.dist, 2) + ' ft', src));
      });
      const mis = typeof cupCallClose === 'function' ? cupCallClose(courses) : null;
      p(line('close' + suf, 'Closure of the printed calls', mis != null ? 'AUTO' : 'TBD', mis != null ? cupNum(mis, 2) + ' ft. Bearings are rounded to the nearest second and distances to 0.01 ft. This is the misclosure of those printed calls, not a field-traverse closure.' : '', 'sum of the printed grid courses'));
      const sf = Math.abs(shArea(ring));
      totalSf += sf;
      h2(part + 'Area statement');
      p(line('area' + suf, 'Grid area', 'AUTO', 'Said outline contains ' + cupNum(Math.round(sf), 0) + ' square feet, ' + cupNum(sf / 43560, 2) + ' acres, more or less, on the ' + zone.name + ' Zone grid.', 'shoelace of the State Plane grid coordinates. Not a surface area.'));
    });
    if (grids.length > 1) p(line('area-sum', 'Sum of the part grid areas', 'AUTO', cupNum(Math.round(totalSf), 0) + ' square feet, ' + cupNum(totalSf / 43560, 2) + ' acres, more or less. A survey may combine or except tracts. This sum does not do that.', 'sum of the part grid areas'));
    if (c.acres != null) p(line('area-asr', 'Assessor area, stated separately', 'AUTO', cupNum(c.acres, 2) + ' acres. Not used as the grid area above.', 'deal record acres'));
  }
  h2('Basis of bearings and grid versus surface');
  ul([
    line('basis', 'Basis of bearings', zone && grids.length ? 'AUTO' : 'ORDER', zone && grids.length ? 'Grid bearings of the ' + zone.label + '. Lambert conformal conic, GRS 80, NAD 83. Distances in the calls are grid distances, US survey feet, not ground distances.' : '', zone && grids.length ? 'EPSG:' + zone.epsg + ', county ' + (c.county || '') : (zone ? 'zone selected but the outline was not projected' : 'county is not mapped to EPSG:3419 or EPSG:3420'), '', CUP_SURVEY),
    line('cf', 'Combined factor, grid to surface', 'TBD', '', 'to be confirmed by a Kansas PLS. Ground distance = grid distance / combined factor. Surface distances are not stated.')
  ]);
  h2('Exceptions, deeds, and title');
  ul([
    line('plss', 'Assessor or deed aliquot text', c.plss ? 'AUTO' : 'ORDER', c.plss, c.plss ? 'deal record PLSS or deed text. It is not a substitute for the surveyed metes and bounds.' : 'record legal description', '', CUP_SURVEY),
    line('ex', 'Less-and-except tracts, easements, and reservations', 'ORDER', '', 'GIS bands in Site Planning are not recited. Easements of record come from title work.', '', CUP_SURVEY),
    line('deed', 'Recorded vesting deeds', 'ORDER', '', 'title commitment and the register of deeds, one current deed per parcel, without unrelated tracts', '', CUP_SURVEY)
  ]);
  p(CUP_BANNER);
  return { id: doc, title: 'Draft Legal Description', filename: '03-legal-description', blocks: B };
}

function cupBuild(input) {
  input = input || {};
  const pub = !!input.publicMode;
  const asOf = cupStr(input.asOf);
  const c = cupNorm(input);
  const fields = [];
  const F = (doc, spec) => cupPush(fields, doc, spec);
  const show = f => cupShow(f, pub);
  const mode = pub
    ? 'PUBLIC EXPORT. MW, generator counts, water volumes, parcel IDs, and owner names are withheld.'
    : 'ADMIN — NOT FOR DISTRIBUTION.';
  const docs = {
    operations: cupOps(c, F, show, asOf),
    application: cupApp(c, F, show, asOf),
    legal: cupLegal(c, F, show)
  };
  Object.keys(docs).forEach(k => {
    const d = docs[k];
    if (k !== 'legal') d.blocks.unshift({ t: 'note', text: mode });
    else d.blocks.splice(1, 0, { t: 'note', text: mode });
    d.text = cupBlocksText(d.blocks);
  });
  const built = { publicMode: pub, asOf: asOf || 'TBD', siteName: c.name, fields: fields, docs: docs };
  built.problems = cupAudit(built);
  return built;
}

function cupFromPlan(s, r, meta, opt) {
  s = s || {}; meta = meta || {}; opt = opt || {};
  const square = meta.polySrc === 'square';
  let rings = [];
  let geoRings = [];
  if (!square) {
    if (opt.geoRings && opt.geoRings.length) geoRings = opt.geoRings;
    else if (opt.rings && opt.rings.length && typeof cupLooksGeo === 'function' && cupLooksGeo(opt.rings[0])) geoRings = opt.rings;
    if (opt.rings && opt.rings.length && !(typeof cupLooksGeo === 'function' && cupLooksGeo(opt.rings[0]))) rings = opt.rings;
    else if (r && r.C && r.C.Q && r.C.un && typeof shOpen === 'function') rings = [shOpen(r.C.Q.map(r.C.un))];
  }
  const Z = meta.zone || {};
  const ordSrc = Z.has || Z.district ? 'zoning record' : '';
  const phases = (r && r.rows) || [];
  return cupBuild({
    publicMode: !!opt.publicMode,
    asOf: opt.asOf || '',
    water: opt.water || null,
    generators: opt.generators != null ? opt.generators : null,
    meta: meta,
    site: Object.assign({}, s, {
      zoningDistrict: Z.district || (typeof s.zoning === 'string' ? s.zoning : (s.zoning && s.zoning.district) || ''),
      zoningUse: Z.use || '',
      zoningSource: ordSrc || (s.zoning ? 'deal record zoning text' : ''),
      ordinance: { front: Z.front != null ? Z.front : null, side: Z.side != null ? Z.side : null, rear: Z.rear != null ? Z.rear : null, height: Z.maxH != null ? Z.maxH : (r && r.hgt && r.hgt.zoning != null ? r.hgt.zoning : null), source: ordSrc },
      floodAc: r && r.build && r.build.flood > 0.05 ? r.build.flood : null
    }),
    plan: {
      hasBoundary: !square && (rings.length > 0 || geoRings.length > 0),
      rings: rings,
      geoRings: geoRings,
      polySrc: meta.polySrc || '',
      boundarySource: meta.bsrc || (meta.polySrc === 'drawn' ? 'drawn in Site Planning' : 'Site Planning parcel outline'),
      co: r && r.co || 'land',
      halls: r && r.n || 0,
      stories: r && r.stories || null,
      heightFt: r && r.height || null,
      itMW: r && r.n ? r.it : null,
      facMW: r && r.n ? r.fac : null,
      footprintSf: r && r.n ? r.fp : null,
      stalls: r && r.stalls != null ? r.stalls : null,
      cool: r && r.E && r.E.cool || '',
      hasSub: !!(r && r.sub),
      hasGenYard: !!(r && r.halls && r.halls.some(h => h.gen)),
      detAcFt: r && r.sw && r.sw.Vac != null ? r.sw.Vac : null,
      edges: r ? cupEdgeSetbacks(r) : [],
      phases: phases.map(row => ({ k: row.k, halls: row.halls, it: row.itB, fac: row.fac }))
    }
  });
}

function cupSyntheticRing() { return [[0, 0], [1800, 40], [2200, 900], [700, 1600], [-80, 1000], [0, 0]]; }
// Invented vertices around 39.05 N, 95.80 W. Not a parcel. Offsets are only to place the figure; calls use the State Plane projection.
function cupSyntheticGeo() {
  const lat0 = 39.05, lon0 = -95.80;
  const fy = 1 / 364000, fx = 1 / (364000 * Math.cos(lat0 * Math.PI / 180));
  return cupSyntheticRing().map(([x, y]) => [lon0 + x * fx, lat0 + y * fy]);
}
function cupSyntheticSite() {
  return {
    id: 'synthetic-sample-ridge',
    name: 'Sample Ridge',
    address: '1000 Sample Road',
    city: 'Example',
    county: 'Shawnee',
    state: 'KS',
    zip: '66000',
    acres: 42.5,
    zoning: 'I-2',
    owner: { name: 'Sample Holdings LLC', mailing: '1 Example Street, Example, KS 66000' },
    parcels: [{ apn: 'SYN-100-200-300', quickRef: 'QREF-SYN-1' }, { apn: 'SYN-100-200-301' }],
    electric: [{ provider: 'Example Electric Cooperative', served_kv: 115 }],
    water: { provider: 'Example Rural Water District' },
    sewer: {},
    telecom: { provider: 'Example Fiber' },
    floodplain: { pct: 3.5, zones: ['AE'] },
    plss: 'Synthetic aliquot only: a portion of Section 99, Township 99 South, Range 99 East. Not a real description.',
    existing_use: 'pasture',
    annexation: { status: 'unincorporated', nearest_city: 'Example City' },
    power: { lines_by_class: [{ kv: 115, mi: 0.4 }] }
  };
}
function cupSampleBuild(publicMode, extra) {
  extra = extra || {};
  const geo = cupSyntheticGeo();
  const sp = cupSpcsZone('Shawnee');
  const grid = cupSpcsRing(geo, sp);
  const o = grid[0];
  const ring = grid.map(p => [p[0] - o[0], p[1] - o[1]]);
  if (typeof tfDC !== 'function' || typeof tfZone !== 'function' || typeof TF_DEF === 'undefined') throw new Error('cupSampleBuild needs the Site Planning solvers');
  const zone = { district: 'I-2', setbacks_ft: { front: { v: 25 }, side: { v: 15 }, rear: { v: 20 } }, max_height_ft: { v: 45 }, treatment: { data_center: { status: 'conditional' } } };
  const I = Object.assign({}, TF_DEF.land, { halls: 4, stories: 1, setF: 80, setS: 50, setR: 60, phases: 2, sw: 'off', park: 12, cool: 'air', front: 'S', subAc: 2, genAc: 0.5 });
  const r = tfDC(ring, I, { zone: tfZone(zone, 'land'), gridMW: 400 });
  const Z = tfZone(zone, 'land');
  return cupFromPlan(cupSyntheticSite(), r, { polySrc: 'parcel', bsrc: 'synthetic parcel outline (fixture, not a survey)', zone: Z }, { publicMode: !!publicMode, asOf: '2026-11-15', geoRings: [geo], water: extra.water || null, generators: extra.generators != null ? extra.generators : null });
}

// ---- PDF (text) and DOCX (Office Open XML). No third-party library, so this stays out of the plan-sheet exporter.
function cupPdfStr(s) {
  let o = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') o += '\\' + ch;
    else if (c === 0x2014 || c === 0x2013) o += '\\227';
    else if (c === 0x00B7) o += '\\267';
    else if (c === 0x00B0) o += '\\260';
    else if (c === 0x2022) o += '-';
    else if (c >= 32 && c <= 126) o += ch;
    else if (c === 0x00A0) o += ' ';
    else o += '?';
  }
  return '(' + o + ')';
}
function cupPlainLines(blocks) {
  const lines = [];
  const push = (text, opt) => cupWrap(text, opt.wrap || 92).forEach((t, i) => lines.push({ text: t, size: opt.size || 10, bold: !!opt.bold && i === 0, mono: !!opt.mono }));
  (blocks || []).forEach(b => {
    if (b.t === 'h1') push(b.text, { size: 14, bold: true, wrap: 72 });
    else if (b.t === 'h2') push(b.text, { size: 12, bold: true, wrap: 80 });
    else if (b.t === 'note') push(b.text, { size: 10, bold: true, wrap: 92 });
    else if (b.t === 'p') push(b.text, { size: 10, wrap: 92 });
    else if (b.t === 'ul') b.items.forEach(item => push('- ' + item, { size: 10, wrap: 90 }));
    else if (b.t === 'table') {
      const cols = Math.max(1, b.head.length);
      const w = Math.max(10, Math.floor((100 - (cols - 1) * 3) / cols));
      const emit = (cells, bold) => {
        const wrapped = cells.map(cell => cupWrap(String(cell), w));
        const n = Math.max.apply(null, wrapped.map(col => col.length));
        for (let i = 0; i < n; i++) lines.push({ text: wrapped.map(col => (col[i] || '').padEnd(w)).join(' | '), size: 8, bold: bold, mono: true });
      };
      emit(b.head, true);
      b.rows.forEach(r => emit(r, false));
      lines.push({ text: '', size: 6 });
    }
    lines.push({ text: '', size: 6 });
  });
  return lines;
}
function cupPdf(doc, built) {
  built = built || { publicMode: false, siteName: '' };
  const lines = cupPlainLines(doc.blocks);
  const pages = [];
  let cmds = [];
  let y = 740;
  const bottom = 56;
  const open = () => { cmds = []; y = 740; };
  const shut = () => pages.push(cmds.join('\n'));
  const cmd = (x, yy, size, bold, mono, text) => 'BT ' + (mono ? '/F3' : bold ? '/F2' : '/F1') + ' ' + size + ' Tf 1 0 0 1 ' + x.toFixed(1) + ' ' + yy.toFixed(1) + ' Tm ' + cupPdfStr(text) + ' Tj ET';
  open();
  lines.forEach(ln => {
    const h = (ln.size || 10) + 3;
    if (y - h < bottom) { shut(); open(); }
    if (ln.text) cmds.push(cmd(54, y, ln.size || 10, ln.bold, ln.mono, ln.text));
    y -= h;
  });
  shut();
  const n = pages.length;
  const mode = built.publicMode ? 'PUBLIC EXPORT' : 'ADMIN — NOT FOR DISTRIBUTION';
  const bodies = pages.map((body, i) => body + '\n' + cmd(54, 36, 8, false, false, 'Draft. Not a sealed filing. Not a survey.  ' + mode + '  ' + (i + 1) + ' / ' + n));
  const fontRes = '/F1 3 0 R /F2 4 0 R /F3 5 0 R';
  const objects = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
  const kids = [];
  let id = 6;
  bodies.forEach(stream => {
    const cid = id++;
    const pid = id++;
    objects[cid - 1] = '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream';
    objects[pid - 1] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + cid + ' 0 R /Resources << /Font << ' + fontRes + ' >> >> >>';
    kids.push(pid);
  });
  objects[1] = '<< /Type /Pages /Count ' + n + ' /Kids [' + kids.map(k => k + ' 0 R').join(' ') + '] >>';
  const info = id++;
  const title = cupPdfStr(doc.title + (built.siteName ? ' - ' + built.siteName : ''));
  const subject = cupPdfStr(built.publicMode ? 'Public draft conditional use packet' : 'Admin draft conditional use packet. Not for distribution.');
  objects[info - 1] = '<< /Title ' + title + ' /Author (Edifice deal app) /Subject ' + subject + ' /Creator (Edifice deal app) /Keywords () >>';
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => { offsets.push(out.length); out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'; });
  const xref = out.length;
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return new TextEncoder().encode(out);
}

function cupXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function cupDocxP(text, kind) {
  const sz = kind === 'h1' ? '32' : kind === 'h2' ? '26' : '20';
  const bold = kind === 'h1' || kind === 'h2' || kind === 'note';
  return '<w:p><w:pPr><w:spacing w:before="' + (kind === 'h1' ? '240' : '80') + '" w:after="60"/></w:pPr><w:r><w:rPr>' + (bold ? '<w:b/>' : '') + '<w:sz w:val="' + sz + '"/>' + (kind === 'note' ? '<w:color w:val="9A3412"/>' : '') + '</w:rPr><w:t xml:space="preserve">' + cupXml(text) + '</w:t></w:r></w:p>';
}
function cupDocxTbl(head, rows) {
  const cols = Math.max(1, head.length);
  const w = Math.floor(9360 / cols);
  const cell = (t, header) => '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr>' + (header ? '<w:b/>' : '') + '<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">' + cupXml(t) + '</w:t></w:r></w:p></w:tc>';
  const tr = (cells, header) => '<w:tr>' + cells.map(c => cell(c, header)).join('') + '</w:tr>';
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(x => '<w:' + x + ' w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>').join('');
  return '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>' + borders + '</w:tblBorders></w:tblPr>' + tr(head, true) + rows.map(r => tr(r, false)).join('') + '</w:tbl><w:p/>';
}
function cupDocxXml(doc) {
  let body = '';
  (doc.blocks || []).forEach(b => {
    if (b.t === 'ul') b.items.forEach(item => { body += cupDocxP('- ' + item, 'p'); });
    else if (b.t === 'table') body += cupDocxTbl(b.head, b.rows);
    else body += cupDocxP(b.text, b.t === 'h1' || b.t === 'h2' || b.t === 'note' ? b.t : 'p');
  });
  body += '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="864" w:right="864" w:bottom="864" w:left="864"/></w:sectPr>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>';
}
function cupCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function cupZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  files.forEach(f => {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = cupCrc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    locals.push(local);
    central.push(cen);
    offset += local.length;
  });
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  locals.forEach(b => { out.set(b, p); p += b.length; });
  central.forEach(b => { out.set(b, p); p += b.length; });
  out.set(eocd, p);
  return out;
}
function cupDocx(doc) {
  const enc = new TextEncoder();
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
  return cupZip([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(cupDocxXml(doc)) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) }
  ]);
}
function cupReadme(built) {
  return [
    'Draft conditional-use packet from the Edifice deal app.',
    'Site: ' + (built.siteName || 'TBD'),
    'Mode: ' + (built.publicMode ? 'PUBLIC EXPORT. MW, generator counts, water volumes, parcel IDs, and owner names are withheld.' : 'ADMIN — NOT FOR DISTRIBUTION.'),
    'Issue date: ' + (built.asOf || 'TBD'),
    '',
    'Not a sealed filing. Not a survey.',
    'The legal description is computed from the Site Planning outline. A Kansas PLS boundary or ALTA survey is to be ordered.',
    'Every figure is marked AUTO (with its source), ASSUMED, TBD, or TO BE ORDERED.',
    '',
    '01-operations-plan',
    '02-cup-application',
    '03-legal-description',
    'Each document is included as PDF and DOCX.',
    ''
  ].join('\n');
}
function cupPacket(built) {
  const enc = new TextEncoder();
  const files = [{ name: '00-README.txt', data: enc.encode(cupReadme(built)) }];
  ['operations', 'application', 'legal'].forEach(k => {
    const d = built.docs[k];
    files.push({ name: d.filename + '.pdf', data: cupPdf(d, built) });
    files.push({ name: d.filename + '.docx', data: cupDocx(d) });
  });
  return cupZip(files);
}
