// Admin-only map preview of the noise and photometric engines.
// Hooks tfDraw after it runs. Does not touch the sheet SVG. Default off.
// Contours are screening output: the bar repeats the engine label.

(function () {
  const state = { noise: false, photo: false, scenario: 'typical_night', token: 0 };

  function admin() { return typeof isAdm === 'function' && isAdm(); }

  function boot() {
    if (typeof tfDraw !== 'function' || tfDraw.__edificeScreen) return;
    const orig = tfDraw;
    const wrapped = function (r) {
      orig(r);
      try { edificeScreeningSync(r); } catch (e) { /* the preview must not break the plan */ }
    };
    wrapped.__edificeScreen = true;
    globalThis.tfDraw = wrapped;
  }

  function edificeScreeningSync(r) {
    if (typeof document === 'undefined') return;
    const plan = document.getElementById('tfPlan');
    if (!plan) return;
    if (!admin()) { clearLayers(); const bar = document.getElementById('edificeScreenBar'); if (bar) bar.remove(); return; }
    let bar = document.getElementById('edificeScreenBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'edificeScreenBar';
      bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:6px 0;font:11px/1.3 ui-monospace,monospace;color:#c8c4bc';
      bar.innerHTML = '<span style="letter-spacing:.08em;text-transform:uppercase">Screening preview · admin</span>'
        + '<label><input type="checkbox" id="edificeNzOn"> Noise</label>'
        + '<select id="edificeNzSc" aria-label="Noise scenario">'
        + '<option value="typical_day">Typical day</option><option value="typical_night" selected>Typical night</option>'
        + '<option value="maintenance_day">Maintenance day</option><option value="maintenance_night">Maintenance night</option>'
        + '<option value="emergency_day">Emergency day</option><option value="emergency_night">Emergency night</option></select>'
        + '<label><input type="checkbox" id="edificePhOn"> Photometric</label>'
        + '<span id="edificeScreenNote" style="color:#9a958c"></span>';
      plan.parentNode.insertBefore(bar, plan);
      bar.addEventListener('change', function (ev) {
        const t = ev.target;
        if (t.id === 'edificeNzOn') state.noise = t.checked;
        if (t.id === 'edificePhOn') state.photo = t.checked;
        if (t.id === 'edificeNzSc') state.scenario = t.value;
        edificeScreeningSync(typeof TF !== 'undefined' ? TF.r : r);
      });
    }
    const note = document.getElementById('edificeScreenNote');
    if (!state.noise && !state.photo) { if (note) note.textContent = ''; clearLayers(); return; }
    if (!(typeof SP !== 'undefined' && SP.map)) { if (note) note.textContent = 'Map is not ready.'; return; }
    const token = ++state.token;
    if (note) note.textContent = 'Computing…';
    const jobs = [];
    if (state.noise && typeof nzFromPlan === 'function' && typeof nzScreenAsync === 'function') {
      const spec = nzFromPlan(r, { scenarios: [state.scenario], contourMetrics: ['dBA'] });
      spec.grid = previewNoiseGrid(r, spec);
      jobs.push(nzScreenAsync(spec).then(function (out) {
        return { kind: 'noise', fc: projectFC(out.scenarios[state.scenario] && out.scenarios[state.scenario].contours.dBA), label: out.label, spacing: spec.grid && spec.grid.spacing_m };
      }));
    }
    if (state.photo && typeof phFromPlan === 'function' && typeof phCalcAsync === 'function') {
      const spec = phFromPlan(r);
      spec.grid = previewPhotoGrid(spec);
      jobs.push(phCalcAsync(spec).then(function (out) {
        return { kind: 'photo', fc: projectFC(out.isolines), label: out.label };
      }));
    }
    Promise.all(jobs).then(function (parts) {
      if (token !== state.token) return;
      const features = [];
      let text = '';
      parts.forEach(function (p) {
        if (p.fc && p.fc.features) p.fc.features.forEach(function (f) { f.properties = Object.assign({}, f.properties, { screen: p.kind }); features.push(f); });
        text += (text ? ' · ' : '') + p.label + (p.spacing && p.spacing !== 15 ? ' · preview grid ' + Math.round(p.spacing) + ' m' : '');
      });
      draw(features);
      if (note) note.textContent = text || 'No contours on this grid.';
    }).catch(function (e) {
      if (token !== state.token) return;
      if (note) note.textContent = 'Screening preview failed: ' + (e && e.message ? e.message : e);
    });
  }

  function previewNoiseGrid(r, spec) {
    const bb = worldBox(r);
    if (!bb) return null;
    let spacing = 15, span = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.3048 + 300;
    const n = span / spacing;
    if (n > 70) spacing = span / 70;
    const pad = 150 / 0.3048;
    return { xmin: bb.x0 - pad, ymin: bb.y0 - pad, xmax: bb.x1 + pad, ymax: bb.y1 + pad, spacing_m: Math.round(spacing * 10) / 10, height_m: 1.5 };
  }
  function previewPhotoGrid(spec) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (spec.areas || []).forEach(function (a) { (a.polygon || []).forEach(function (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }); });
    if (!isFinite(x0)) return null;
    const pad = 40, span = Math.max(x1 - x0, y1 - y0) + pad * 2;
    const spacing = Math.max(10, span / 60);
    return { xmin: x0 - pad, ymin: y0 - pad, xmax: x1 + pad, ymax: y1 + pad, spacing: Math.round(spacing * 10) / 10 };
  }
  function worldBox(r) {
    const un = r && r.C && r.C.un;
    const ring = r && r.C && r.C.Q;
    if (!un || !ring || !ring.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ring.forEach(function (p) { const q = un(p); x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); });
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function projectFC(fc) {
    const P = typeof TF !== 'undefined' && TF.P;
    if (!fc || !P || !P.b) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: (fc.features || []).map(function (f) {
        const g = f.geometry;
        if (!g || g.type !== 'LineString') return null;
        return { type: 'Feature', properties: f.properties || {}, geometry: { type: 'LineString', coordinates: g.coordinates.map(function (xy) { return P.b(xy); }) } };
      }).filter(Boolean)
    };
  }
  function draw(features) {
    const m = typeof SP !== 'undefined' && SP.map;
    if (!m || !m.getStyle) return;
    const data = { type: 'FeatureCollection', features: features };
    if (!m.getSource('edifice-screen')) {
      m.addSource('edifice-screen', { type: 'geojson', data: data });
      m.addLayer({ id: 'edifice-screen-line', type: 'line', source: 'edifice-screen', paint: { 'line-color': ['coalesce', ['get', 'color'], '#cccccc'], 'line-width': 1.6 } });
    } else m.getSource('edifice-screen').setData(data);
  }
  function clearLayers() {
    const m = typeof SP !== 'undefined' && SP.map;
    if (m && m.getSource && m.getSource('edifice-screen')) m.getSource('edifice-screen').setData({ type: 'FeatureCollection', features: [] });
  }

  if (typeof globalThis !== 'undefined') globalThis.edificeScreeningPreview = { sync: edificeScreeningSync, clear: clearLayers };
  if (typeof document !== 'undefined') boot();
})();
