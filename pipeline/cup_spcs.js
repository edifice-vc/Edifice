// Kansas State Plane, NAD83, US survey feet. Lambert conformal conic, 2 standard parallels (Snyder).
// North Zone is EPSG:3419. South Zone is EPSG:3420. Counties are the EPSG area-of-use lists (105, no overlap).
// EPSG:2241 and EPSG:2242 are Idaho East and Idaho Central, not Kansas. They are not used.
// Geographic positions are taken as NAD83 (no datum shift). Output is US survey feet on the grid.
const CUP_SP_A = 6378137;
const CUP_SP_F = 1 / 298.257222101;
const CUP_SP_FT = 0.3048006096012192; // meters per US survey foot (1200/3937)
const CUP_SP_N = 'Atchison;Brown;Cheyenne;Clay;Cloud;Decatur;Dickinson;Doniphan;Douglas;Ellis;Ellsworth;Geary;Gove;Graham;Jackson;Jefferson;Jewell;Johnson;Leavenworth;Lincoln;Logan;Marshall;Mitchell;Morris;Nemaha;Norton;Osborne;Ottawa;Phillips;Pottawatomie;Rawlins;Republic;Riley;Rooks;Russell;Saline;Shawnee;Sheridan;Sherman;Smith;Thomas;Trego;Wabaunsee;Wallace;Washington;Wyandotte';
const CUP_SP_S = 'Allen;Anderson;Barber;Barton;Bourbon;Butler;Chase;Chautauqua;Cherokee;Clark;Coffey;Comanche;Cowley;Crawford;Edwards;Elk;Finney;Ford;Franklin;Grant;Gray;Greeley;Greenwood;Hamilton;Harper;Harvey;Haskell;Hodgeman;Kearny;Kingman;Kiowa;Labette;Lane;Linn;Lyon;Marion;McPherson;Meade;Miami;Montgomery;Morton;Neosho;Ness;Osage;Pawnee;Pratt;Reno;Rice;Rush;Scott;Sedgwick;Seward;Stafford;Stanton;Stevens;Sumner;Wichita;Wilson;Woodson';
// lat1, lat2, lat0, lon0 in degrees; false easting/northing in meters (the meter zone), then converted to US ft.
const CUP_SP_DEF = {
  N: { epsg: 3419, name: 'North', lat1: 39.7833333333333, lat2: 38.7166666666667, lat0: 38.3333333333333, lon0: -98, fe: 400000, fn: 0 },
  S: { epsg: 3420, name: 'South', lat1: 38.5666666666667, lat2: 37.2666666666667, lat0: 36.6666666666667, lon0: -98.5, fe: 400000, fn: 400000 }
};
const CUP_SP_FWD = {};
function cupSpcsLcc(def) {
  const e2 = CUP_SP_F * (2 - CUP_SP_F), e = Math.sqrt(e2), rad = Math.PI / 180;
  const m = phi => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) * Math.sin(phi));
  const t = phi => { const s = Math.sin(phi); return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - e * s) / (1 + e * s), e / 2); };
  const p1 = def.lat1 * rad, p2 = def.lat2 * rad, p0 = def.lat0 * rad;
  const m1 = m(p1), m2 = m(p2), t1 = t(p1), t2 = t(p2), t0 = t(p0);
  const n = Math.log(m1 / m2) / Math.log(t1 / t2);
  const F = m1 / (n * Math.pow(t1, n));
  const rho0 = CUP_SP_A * F * Math.pow(t0, n);
  return function (lon, lat) {
    const rho = CUP_SP_A * F * Math.pow(t(lat * rad), n);
    const th = n * (lon - def.lon0) * rad;
    return [(def.fe + rho * Math.sin(th)) / CUP_SP_FT, (def.fn + rho0 - rho * Math.cos(th)) / CUP_SP_FT];
  };
}
function cupSpcsZone(county) {
  let n = String(county == null ? '' : county).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/,?\s+(kansas|ks)$/, '').replace(/\s+county$/, '').replace(/\s+co$/, '').trim();
  if (!n) return null;
  const list = (id) => CUP_SP_DEF[id] && (id === 'N' ? CUP_SP_N : CUP_SP_S).split(';').some(x => x.toLowerCase() === n);
  const id = list('N') ? 'N' : list('S') ? 'S' : '';
  if (!id) return null;
  const d = CUP_SP_DEF[id];
  return { id: id, epsg: d.epsg, name: d.name, label: 'Kansas State Plane NAD 83, ' + d.name + ' Zone, EPSG:' + d.epsg + ', US survey feet' };
}
function cupSpcsFwd(zone, lon, lat) {
  if (!zone || !CUP_SP_DEF[zone.id]) return null;
  if (!CUP_SP_FWD[zone.id]) CUP_SP_FWD[zone.id] = cupSpcsLcc(CUP_SP_DEF[zone.id]);
  if (!isFinite(+lon) || !isFinite(+lat)) return null;
  return CUP_SP_FWD[zone.id](+lon, +lat);
}
function cupLooksGeo(ring) {
  if (!ring || ring.length < 3) return false;
  return ring.every(p => p && isFinite(+p[0]) && isFinite(+p[1]) && Math.abs(+p[0]) <= 180 && Math.abs(+p[1]) <= 90 && Math.abs(+p[0]) > 40);
}
// lon/lat ring -> State Plane US-ft ring. Null if it is not geographic.
function cupSpcsRing(ring, zone) {
  if (!cupLooksGeo(ring) || !zone) return null;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const g = cupSpcsFwd(zone, +ring[i][0], +ring[i][1]);
    if (!g) return null;
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev[0] - g[0]) > 1e-6 || Math.abs(prev[1] - g[1]) > 1e-6) out.push(g);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
  }
  return out.length >= 3 ? out : null;
}
// Azimuth (radians from grid north) of a quadrant bearing, as shBearing prints it.
function cupAzFromBrg(txt) {
  const m = String(txt).match(/([NS])\s+(\d+)\u00b0(\d+)'(\d+)"\s+([EW])/);
  if (!m) return null;
  const q = (+m[2]) + (+m[3]) / 60 + (+m[4]) / 3600;
  const ns = m[1], ew = m[5];
  const deg = ns === 'N' && ew === 'E' ? q : ns === 'S' && ew === 'E' ? 180 - q : ns === 'S' && ew === 'W' ? 180 + q : 360 - q;
  return deg * Math.PI / 180;
}
// Misclosure, in feet, of the calls as printed: bearing to the nearest second, distance to 0.01 ft.
function cupCallClose(courses) {
  let x = 0, y = 0;
  for (const c of courses || []) {
    const az = cupAzFromBrg(c.brg);
    if (az == null || !isFinite(+c.dist)) return null;
    const d = Math.round(+c.dist * 100) / 100;
    x += d * Math.sin(az);
    y += d * Math.cos(az);
  }
  return Math.hypot(x, y);
}
