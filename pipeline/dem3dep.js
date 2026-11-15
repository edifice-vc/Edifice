// USGS 3DEP elevation fetch for the line-of-sight and grading sheets.
// Load after screening.js. The intended source is the public 3DEP Elevation ImageServer,
// which serves 1 m data where the program has it and a coarser DEM elsewhere.
// This module does not open a socket by itself: pass opts.fetch. Tests use synthetic bytes.
const DEM_3DEP_BASE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

// WGS84 meridional / parallel scale, metres per degree. Standard series, not a site measurement.
function demMetersPerDeg(latDeg) {
  const p = latDeg * Math.PI / 180;
  const latM = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const lonM = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
  return {
    lat: sgNum(latM, 'WGS84 meridional radius, metres per degree', 'm/deg'),
    lon: sgNum(lonM, 'WGS84 parallel radius, metres per degree', 'm/deg')
  };
}
function dem3depExportUrl(bbox, opts) {
  opts = opts || {};
  if (!(bbox.east > bbox.west) || !(bbox.north > bbox.south)) throw new Error('3DEP bbox is empty');
  const res = opts.resolution_m != null ? opts.resolution_m : 1;
  const mid = (bbox.south + bbox.north) / 2;
  const sc = demMetersPerDeg(mid);
  const widthM = (bbox.east - bbox.west) * sc.lon.v;
  const heightM = (bbox.north - bbox.south) * sc.lat.v;
  const width = Math.max(2, Math.round(widthM / res));
  const height = Math.max(2, Math.round(heightM / res));
  const q = [
    'bbox=' + [bbox.west, bbox.south, bbox.east, bbox.north].join(','),
    'bboxSR=4326', 'imageSR=4326',
    'size=' + width + ',' + height,
    'format=tiff', 'pixelType=F32', 'interpolation=RSP_Bilinear', 'f=image'
  ].join('&');
  return {
    url: DEM_3DEP_BASE + '/exportImage?' + q,
    endpoint: DEM_3DEP_BASE,
    width: sgNum(width, 'computed', 'px', 'request size at the asked spacing; the service resamples its best available DEM, which is 1 m where 3DEP has it'),
    height: sgNum(height, 'computed', 'px'),
    resolution_m: sgNum(res, opts.resolutionSrc || 'USGS 3DEP 1 m request', 'm'),
    vertical: sgNum(1, 'USGS 3DEP Elevation ImageServer', 'm', 'elevations are metres, NAVD88'),
    widthM: sgNum(widthM, 'computed', 'm'),
    heightM: sgNum(heightM, 'computed', 'm')
  };
}
function dem3depSamplesUrl(points) {
  const geom = JSON.stringify({points: points.map(p => [p.lon, p.lat]), spatialReference: {wkid: 4326}});
  return {
    url: DEM_3DEP_BASE + '/getSamples?geometry=' + encodeURIComponent(geom) + '&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json',
    count: sgNum(points.length, 'computed', 'points'),
    endpoint: DEM_3DEP_BASE
  };
}
function dem3depParseSamples(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o || o.error) throw new Error('3DEP: ' + (o && o.error && (o.error.message || o.error) || 'empty response'));
  const samples = (o.samples || []).map(s => ({
    value: sgNum(Number(s.value), 'USGS 3DEP Elevation ImageServer', 'm'),
    lon: s.location ? sgNum(s.location.x, 'USGS 3DEP', 'deg') : sgNum(null, 'TBD', 'deg'),
    lat: s.location ? sgNum(s.location.y, 'USGS 3DEP', 'deg') : sgNum(null, 'TBD', 'deg')
  }));
  return {samples: samples, source: 'USGS 3DEP Elevation ImageServer', count: sgNum(samples.length, 'computed', 'points')};
}
// GeoTIFF pixel-is-area: ModelTiepoint maps raster (i, j) to model (x, y), and (0, 0) is the
// upper-left corner of the upper-left pixel. Row 0 is north when scaleY is positive.
// The returned grid is south-up (row 0 has the smaller y) so it matches sgDem.
function dem3depFromTiff(bytes, meta) {
  meta = meta || {};
  const t = sgParseTiff(bytes);
  const nx = t.width, ny = t.height;
  let x0, y0, dx, dy, srcH, note;
  if (t.tie && t.scale && t.tie.length >= 6 && t.scale.length >= 2) {
    const i0 = t.tie[0], j0 = t.tie[1], X = t.tie[3], Y = t.tie[4];
    const scaleX = t.scale[0], scaleY = t.scale[1];
    // centre of TIFF pixel (i, j), j down
    const cx = i => X + (i + 0.5 - i0) * scaleX;
    const cy = j => Y - (j + 0.5 - j0) * scaleY;
    x0 = cx(0);
    y0 = cy(ny - 1); // southern row after the flip
    dx = scaleX;
    dy = scaleY;
    srcH = 'USGS 3DEP GeoTIFF ModelTiepoint, pixel-is-area';
    note = 'Row 0 is the southern row. Elevations are the raster values, metres NAVD88 when the source is 3DEP.';
  } else {
    x0 = 0; y0 = 0; dx = 1; dy = 1;
    srcH = 'TBD';
    note = 'TIFF has no ModelTiepoint; origin is 0 and spacing is 1 raster unit.';
  }
  const values = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = t.values[(ny - 1 - j) * nx + i];
  return {
    src: meta.src || 'USGS 3DEP Elevation ImageServer',
    nx: nx, ny: ny,
    x0: sgNum(x0, srcH, meta.unit || 'deg'),
    y0: sgNum(y0, srcH, meta.unit || 'deg'),
    dx: sgNum(dx, srcH, meta.unit || 'deg'),
    dy: sgNum(dy, srcH, meta.unit || 'deg'),
    values: values,
    vertical: sgNum(1, 'USGS 3DEP Elevation ImageServer', 'm', 'NAVD88 metres when this raster came from the 3DEP ImageServer'),
    note: note
  };
}
// Local east/north metres about an origin. Equirectangular, fine for a site a mile or two across. Not a survey projection.
function dem3depToLocal(grid, origin) {
  const sc = demMetersPerDeg(origin.lat);
  const x0 = sgV(grid.x0), y0 = sgV(grid.y0), dx = sgV(grid.dx), dy = sgV(grid.dy);
  const lx0 = (x0 - origin.lon) * sc.lon.v;
  const ly0 = (y0 - origin.lat) * sc.lat.v;
  return {
    src: grid.src,
    nx: grid.nx, ny: grid.ny,
    x0: sgNum(lx0, 'computed', 'm', 'equirectangular offset from the origin, WGS84 scale'),
    y0: sgNum(ly0, 'computed', 'm'),
    dx: sgNum(dx * sc.lon.v, 'computed', 'm'),
    dy: sgNum(dy * sc.lat.v, 'computed', 'm'),
    values: grid.values.slice(),
    vertical: grid.vertical,
    origin: {lon: sgNum(origin.lon, 'caller', 'deg'), lat: sgNum(origin.lat, 'caller', 'deg')},
    note: 'Horizontal metres are an equirectangular approximation. Do not use them as survey coordinates.'
  };
}
function dem3depGridFromSamples(samples, bbox, nx, ny) {
  const vals = samples.map(s => sgV(s.value != null ? s.value : s));
  if (vals.length !== nx * ny) throw new Error('3DEP sample count ' + vals.length + ' != ' + nx + '×' + ny);
  const sc = demMetersPerDeg((bbox.south + bbox.north) / 2);
  // samples are row-major north-up if the caller requested them that way; we store south-up
  const values = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = vals[(ny - 1 - j) * nx + i];
  const dx = (bbox.east - bbox.west) * sc.lon.v / Math.max(1, nx - 1);
  const dy = (bbox.north - bbox.south) * sc.lat.v / Math.max(1, ny - 1);
  return {
    src: 'USGS 3DEP Elevation ImageServer',
    nx: nx, ny: ny,
    x0: sgNum(0, 'computed', 'm', 'local easting of the southwest sample'),
    y0: sgNum(0, 'computed', 'm', 'local northing of the southwest sample'),
    dx: sgNum(dx, 'computed', 'm'), dy: sgNum(dy, 'computed', 'm'),
    values: values,
    vertical: sgNum(1, 'USGS 3DEP Elevation ImageServer', 'm'),
    bbox: {geom: true, west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north}
  };
}
async function dem3depFetch(bbox, opts) {
  opts = opts || {};
  if (typeof opts.fetch !== 'function') throw new Error('dem3depFetch requires opts.fetch; it does not call the network by itself');
  const spec = dem3depExportUrl(bbox, opts);
  const res = await opts.fetch(spec.url, {method: 'GET'});
  if (res && res.ok === false) throw new Error('3DEP HTTP ' + res.status);
  const buf = res && res.arrayBuffer ? await res.arrayBuffer() : res;
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  const grid = dem3depFromTiff(bytes, {src: 'USGS 3DEP Elevation ImageServer'});
  grid.request = {url: spec.url, resolution_m: spec.resolution_m};
  return grid;
}
