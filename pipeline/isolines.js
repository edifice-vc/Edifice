// Shared marching-squares isolines. Plain polylines in the grid's own coordinates.
// Used by the noise and photometric engines; the sheet renderer draws the GeoJSON.
// A cell value exactly equal to the level is nudged down so the line passes through that node.

function isoLines(values, nx, ny, xmin, ymin, dx, dy, levels) {
  const out = [];
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    const segs = isoSegments(values, nx, ny, xmin, ymin, dx, dy, level);
    const lines = isoStitch(segs, Math.max(Math.abs(dx), Math.abs(dy)) * 1e-4);
    if (lines.length) out.push({ level: level, lines: lines });
  }
  return out;
}

function isoSegments(values, nx, ny, xmin, ymin, dx, dy, level) {
  const segs = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const raw = [values[j * nx + i], values[j * nx + i + 1], values[(j + 1) * nx + i + 1], values[(j + 1) * nx + i]];
      if (raw.some(function (v) { return v == null || !isFinite(v); })) continue;
      const v = raw.map(function (x) { return x === level ? x - 1e-9 : x; });
      const p = [
        [xmin + i * dx, ymin + j * dy],
        [xmin + (i + 1) * dx, ymin + j * dy],
        [xmin + (i + 1) * dx, ymin + (j + 1) * dy],
        [xmin + i * dx, ymin + (j + 1) * dy]
      ];
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
      const hits = [];
      for (let e = 0; e < 4; e++) {
        const a = edges[e][0], b = edges[e][1];
        if ((v[a] < level) === (v[b] < level)) continue;
        const t = (level - v[a]) / (v[b] - v[a]);
        hits.push([p[a][0] + t * (p[b][0] - p[a][0]), p[a][1] + t * (p[b][1] - p[a][1])]);
      }
      if (hits.length === 2) segs.push(hits);
      else if (hits.length === 4) {
        const avg = (v[0] + v[1] + v[2] + v[3]) / 4;
        if (avg < level) segs.push([hits[0], hits[1]], [hits[2], hits[3]]);
        else segs.push([hits[0], hits[3]], [hits[1], hits[2]]);
      }
    }
  }
  return segs;
}

function isoStitch(segs, tol) {
  tol = tol > 0 ? tol : 1e-6;
  const tol2 = tol * tol;
  const left = segs.map(function (s) { return [s[0].slice(), s[1].slice()]; });
  const near = function (a, b) { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy <= tol2; };
  const lines = [];
  while (left.length) {
    const seg = left.pop();
    const line = [seg[0], seg[1]];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = left.length - 1; i >= 0; i--) {
        const s = left[i], a = line[0], b = line[line.length - 1];
        if (near(b, s[0])) { line.push(s[1]); left.splice(i, 1); grew = true; }
        else if (near(b, s[1])) { line.push(s[0]); left.splice(i, 1); grew = true; }
        else if (near(a, s[1])) { line.unshift(s[0]); left.splice(i, 1); grew = true; }
        else if (near(a, s[0])) { line.unshift(s[1]); left.splice(i, 1); grew = true; }
      }
    }
    if (line.length >= 2 && near(line[0], line[line.length - 1]) && line.length > 2) line.push(line[0].slice());
    if (line.length >= 2) lines.push(line);
  }
  return lines;
}

function isoFeatureCollection(groups, propsFor) {
  const features = [];
  groups.forEach(function (g) {
    g.lines.forEach(function (line) {
      features.push({
        type: 'Feature',
        properties: propsFor(g.level),
        geometry: { type: 'LineString', coordinates: line.map(function (p) { return [round6(p[0]), round6(p[1])]; }) }
      });
    });
  });
  return { type: 'FeatureCollection', features: features };
}

function round6(v) { return Math.round(v * 1e6) / 1e6; }
