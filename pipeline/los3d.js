// three.js massing scene for the line-of-sight package.
// Builds terrain, buildings, substation, fences, berms and trees (year 1 and
// maturity). Renders existing and proposed frames from the same camera.
// Roofline percentages come from los.js (analytic ray cast). This file also
// exposes a three.js ray cast so the scene and the number describe one model.
// Requires los.js. three.js is lazy-loaded from pipeline/vendor/.
// Every image is stamped "Illustrative — massing model, not photoreal".

const LOS3D_PHASE = ['#F14B21', '#3fa7ff', '#5ad17a', '#c77dff', '#ffb000', '#00c2c2', '#ff6fae', '#a0a0a0'];
// font8x8 basic, public domain (Daniel Hepper / Marcel Sondaar). Glyphs 32..126, 8 bytes each, LSB is the left pixel.
const LOS3D_FONT = '0000000000000000183c3c1818001800363600000000000036367f367f3636000c3e031e301f0c00006333180c6663001c361c6e3b336e000606030000000000180c0606060c1800060c1818180c060000663cff3c660000000c0c3f0c0c000000000000000c0c060000003f0000000000000000000c0c006030180c060301003e63737b6f673e000c0e0c0c0c0c3f001e33301c06333f001e33301c30331e00383c36337f3078003f031f3030331e001c06031f33331e003f3330180c0c0c001e33331e33331e001e33333e30180e00000c0c00000c0c00000c0c00000c0c06180c0603060c180000003f00003f0000060c1830180c06001e3330180c000c003e637b7b7b031e000c1e33333f3333003f66663e66663f003c66030303663c001f36666666361f007f46161e16467f007f46161e16060f003c66030373667c003333333f333333001e0c0c0c0c0c1e007830303033331e006766361e366667000f06060646667f0063777f7f6b63630063676f7b736363001c36636363361c003f66663e06060f001e3333333b1e38003f66663e366667001e33070e38331e003f2d0c0c0c0c1e003333333333333f0033333333331e0c006363636b7f7763006363361c1c3663003333331e0c0c1e007f6331184c667f001e06060606061e0003060c18306040001e18181818181e00081c36630000000000000000000000ff0c0c18000000000000001e303e336e000706063e66663b0000001e3303331e003830303e33336e0000001e333f031e001c36060f06060f0000006e33333e301f0706366e666667000c000e0c0c0c1e00300030303033331e070666361e3667000e0c0c0c0c0c1e000000337f7f6b630000001f333333330000001e3333331e0000003b66663e060f00006e33333e307800003b6e66060f0000003e031e301f00080c3e0c0c2c18000000333333336e0000003333331e0c000000636b7f7f3600000063361c36630000003333333e301f00003f190c263f00380c0c070c0c38001818180018181800070c0c380c0c07006e3b000000000000';
const LOS3D_EXTRA = {
  '—': [0x00, 0x00, 0x00, 0x00, 0x7e, 0x00, 0x00, 0x00],
  '–': [0x00, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x00],
  '·': [0x00, 0x00, 0x00, 0x18, 0x18, 0x00, 0x00, 0x00],
  '×': [0x00, 0x00, 0x66, 0x3c, 0x18, 0x3c, 0x66, 0x00],
  '°': [0x18, 0x24, 0x24, 0x18, 0x00, 0x00, 0x00, 0x00]
};

function los3dGlyph(ch) {
  if (LOS3D_EXTRA[ch]) return LOS3D_EXTRA[ch];
  const c = ch.codePointAt(0);
  if (c < 32 || c > 126) return null;
  const o = (c - 32) * 16;
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(parseInt(LOS3D_FONT.substr(o + i * 2, 2), 16));
  return rows;
}
function los3dTextWidth(text, scale) { return [...String(text)].length * 8 * scale; }

function los3dPlot(rgba, w, h, x, y, rgb) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
}
function los3dFillRect(rgba, w, h, x, y, rw, rh, rgb) {
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
  const x1 = Math.min(w, (x + rw) | 0), y1 = Math.min(h, (y + rh) | 0);
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const i = (yy * w + xx) * 4;
    rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
  }
}
function los3dDrawText(rgba, w, h, text, x, y, scale, rgb) {
  let cx = x;
  for (const ch of String(text)) {
    const rows = los3dGlyph(ch);
    if (rows) {
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if ((rows[r] >> c) & 1) {
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) los3dPlot(rgba, w, h, cx + c * scale + sx, y + r * scale + sy, rgb);
      }
    }
    cx += 8 * scale;
  }
}
function los3dHex(hex) {
  const s = String(hex || '#888').replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

async function los3dEnsureThree() {
  if (typeof globalThis !== 'undefined' && globalThis.THREE && globalThis.THREE.Scene) return globalThis.THREE;
  const urls = [];
  if (typeof globalThis !== 'undefined' && globalThis.LOS_THREE_URL) urls.push(globalThis.LOS_THREE_URL);
  if (typeof process !== 'undefined' && process.cwd) urls.push('file://' + process.cwd() + '/pipeline/vendor/three.module.min.js');
  for (const u of (typeof losVendorCandidates === 'function' ? losVendorCandidates('three.module.min.js') : [])) urls.push(u);
  let last;
  for (const u of urls) {
    try {
      const m = await import(u);
      if (m && m.Scene) { globalThis.THREE = m; return m; }
    } catch (e) { last = e; }
  }
  throw last || new Error('three.js not loaded');
}

function los3dGeom(THREE, positions) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return g;
}
function los3dMesh(THREE, positions, hex) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.86, metalness: 0.04 });
  return new THREE.Mesh(los3dGeom(THREE, positions), mat);
}
function los3dExtrude(THREE, ring, z0, z1, hex) {
  const tris = losTris(ring);
  const pos = [];
  const P = losOpen(ring);
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    pos.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1, a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
  }
  for (const t of tris) {
    pos.push(t[0][0], t[0][1], z1, t[1][0], t[1][1], z1, t[2][0], t[2][1], z1);
    pos.push(t[0][0], t[0][1], z0, t[2][0], t[2][1], z0, t[1][0], t[1][1], z0);
  }
  return los3dMesh(THREE, pos, hex);
}
function los3dRibbon(THREE, line, zAt, height, hex) {
  const pos = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const za = zAt(a[0], a[1]), zb = zAt(b[0], b[1]);
    pos.push(a[0], a[1], za, b[0], b[1], zb, b[0], b[1], zb + height, a[0], a[1], za, b[0], b[1], zb + height, a[0], a[1], za + height);
    pos.push(a[0], a[1], za, b[0], b[1], zb + height, b[0], b[1], zb, a[0], a[1], za + height, b[0], b[1], zb + height, a[0], a[1], za);
  }
  return pos.length ? los3dMesh(THREE, pos, hex) : null;
}
function los3dUnitCone(THREE) {
  const sides = 7, pos = [], rad = 0.5, base = 0.35, apex = 1;
  for (let i = 0; i < sides; i++) {
    const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
    const x0 = Math.cos(a0) * rad, y0 = Math.sin(a0) * rad, x1 = Math.cos(a1) * rad, y1 = Math.sin(a1) * rad;
    pos.push(0, 0, apex, x0, y0, base, x1, y1, base);
    pos.push(0, 0, base, x1, y1, base, x0, y0, base);
  }
  return los3dGeom(THREE, pos);
}
function los3dUnitTrunk(THREE) {
  const sides = 5, pos = [], rad = 0.07, top = 0.4;
  for (let i = 0; i < sides; i++) {
    const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
    const x0 = Math.cos(a0) * rad, y0 = Math.sin(a0) * rad, x1 = Math.cos(a1) * rad, y1 = Math.sin(a1) * rad;
    pos.push(x0, y0, 0, x1, y1, 0, x1, y1, top, x0, y0, 0, x1, y1, top, x0, y0, top);
  }
  return los3dGeom(THREE, pos);
}

function los3dTerrain(THREE, dem, berms, roads) {
  const nx = dem.nx, ny = dem.ny, pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = dem.x0 + i * dem.dx, y = dem.y0 + j * dem.dy;
    const g = dem.z[j * nx + i];
    const bh = berms ? losBermH(berms, x, y) : 0;
    const k = (j * nx + i) * 3;
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = (g == null ? 0 : g) + bh;
    let road = false;
    if (roads) for (const r of roads) if (losLineDist(x, y, r.line || r.L) <= ((r.widthFt || r.row || 24) / 2)) { road = true; break; }
    const rgb = road ? [0.32, 0.33, 0.34] : bh > 0.4 ? [0.42, 0.55, 0.30] : [0.46, 0.58, 0.34];
    col[k] = rgb[0]; col[k + 1] = rgb[1]; col[k + 2] = rgb[2];
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    if (dem.z[a] == null || dem.z[b] == null || dem.z[c] == null || dem.z[d] == null) continue;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  mesh.userData.kind = 'terrain';
  return mesh;
}

function los3dBox(THREE, cx, cy, z0, sx, sy, sz, yaw, hex) {
  const hx = sx / 2, hy = sy / 2, c = Math.cos(yaw), s = Math.sin(yaw);
  const ring = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  return los3dExtrude(THREE, ring, z0, z0 + sz, hex);
}

// view: 'existing' (terrain, and roads) or 'proposed' (massing, berms, trees at year).
function los3dBuild(THREE, model, opt) {
  opt = opt || {};
  const year = opt.year == null ? 1 : opt.year;
  const proposed = opt.view !== 'existing';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc5d6ea);
  scene.add(new THREE.HemisphereLight(0xdde7f2, 0x6d7a55, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(0.4, 0.2, 1);
  scene.add(sun);
  const dem = model.dem;
  if (dem) scene.add(los3dTerrain(THREE, dem, proposed ? model.berms : null, model.roads));
  const counts = { terrain: dem ? 1 : 0, buildings: 0, yards: 0, substation: 0, fences: 0, walls: 0, trees: 0 };
  if (proposed) {
    (model.buildings || []).forEach(b => {
      const z0 = losBuildingZ(model, b);
      const mesh = los3dExtrude(THREE, b.ring, z0, z0 + (+b.heightFt || 0), LOS3D_PHASE[((b.phase || 1) - 1) % LOS3D_PHASE.length]);
      mesh.userData = { kind: 'building', id: b.id, phase: b.phase || 1 };
      scene.add(mesh); counts.buildings++;
    });
    (model.yards || []).forEach(b => {
      const z0 = losBuildingZ(model, b);
      const mesh = los3dExtrude(THREE, b.ring, z0, z0 + (+b.heightFt || LOS_YARD_FT), '#8d8d92');
      mesh.userData = { kind: 'yard', id: b.id };
      scene.add(mesh); counts.yards++;
    });
    if (model.substation && model.substation.ring) {
      const b = model.substation, z0 = losBuildingZ(model, b);
      const mesh = los3dExtrude(THREE, b.ring, z0, z0 + (+b.heightFt || LOS_SUB_FT), '#e0c15a');
      mesh.userData = { kind: 'substation', id: b.id || 'substation', assumed: true };
      scene.add(mesh); counts.substation++;
    }
    const zAt = (x, y) => { const g = losZ(model.dem, x, y); return g == null ? 0 : g; };
    (model.fences || []).forEach(f => {
      const mesh = los3dRibbon(THREE, f.line || [], zAt, f.heightFt != null ? +f.heightFt : LOS_FENCE_FT, '#c5c5c8');
      if (mesh) { mesh.userData = { kind: 'fence', assumed: f.heightFt == null }; scene.add(mesh); counts.fences++; }
    });
    (model.screenWalls || model.walls || []).forEach(f => {
      const mesh = los3dRibbon(THREE, f.line || [], zAt, f.heightFt != null ? +f.heightFt : LOS_WALL_FT, '#d9d3c5');
      if (mesh) { mesh.userData = { kind: 'screen', assumed: f.heightFt == null }; scene.add(mesh); counts.walls++; }
    });
    const trees = model.trees || [];
    if (trees.length) {
      const canopy = new THREE.InstancedMesh(los3dUnitCone(THREE), new THREE.MeshStandardMaterial({ color: new THREE.Color('#2f6b3a'), roughness: 0.9 }), trees.length);
      const trunks = new THREE.InstancedMesh(los3dUnitTrunk(THREE), new THREE.MeshStandardMaterial({ color: new THREE.Color('#6b4a32'), roughness: 1 }), trees.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
      trees.forEach((t, i) => {
        const size = losTreeSize(t, year);
        const g = losZ(model.dem, t.x, t.y);
        p.set(t.x, t.y, g == null ? 0 : g);
        s.set(Math.max(0.5, size.spreadFt), Math.max(0.5, size.spreadFt), Math.max(0.5, size.heightFt));
        m.compose(p, q, s);
        canopy.setMatrixAt(i, m);
        trunks.setMatrixAt(i, m);
      });
      canopy.instanceMatrix.needsUpdate = true;
      trunks.instanceMatrix.needsUpdate = true;
      canopy.userData = { kind: 'trees', year: year === 'maturity' ? 'maturity' : year };
      trunks.userData = { kind: 'trunks' };
      scene.add(canopy); scene.add(trunks);
      counts.trees = trees.length;
    }
    if (opt.figures !== false && opt.camera) {
      const cam = opt.camera, h = (cam.headingDeg || 0) * Math.PI / 180;
      const fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
      const place = (ahead, side, sx, sy, sz, hex) => {
        const x = cam.eye[0] + fx * ahead + rx * side, y = cam.eye[1] + fy * ahead + ry * side;
        const g = losZ(model.dem, x, y);
        scene.add(los3dBox(THREE, x, y, g == null ? 0 : g, sx, sy, sz, h, hex));
      };
      // Length runs along the view (local Y). Kept on the shoulder so the massing stays in frame.
      place(80, 36, 6.2, 15, 4.8, '#e6e6ea');
      place(130, 40, 8.2, 40, 12.5, '#6a6e72');
    }
  }
  return { scene, counts, year: proposed ? (year === 'maturity' ? 'maturity' : year) : 'existing', view: proposed ? 'proposed' : 'existing' };
}

function los3dCamera(THREE, cam, w, h) {
  const hfov = ((cam.hfovDeg != null ? cam.hfovDeg : losHfov(cam.focalMm || 50)) * Math.PI) / 180;
  const aspect = w / h;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180 / Math.PI;
  const camera = new THREE.PerspectiveCamera(vfov, aspect, 1, 80000);
  camera.up.set(0, 0, 1);
  camera.position.set(cam.eye[0], cam.eye[1], cam.eye[2]);
  camera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
  camera.updateMatrixWorld(true);
  return camera;
}

function los3dRaster(THREE, scene, camera, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const zbuf = new Float32Array(w * h);
  zbuf.fill(2);
  for (let y = 0; y < h; y++) {
    const t = y / Math.max(1, h - 1);
    const r = (186 + (226 - 186) * t) | 0, g = (214 + (232 - 214) * t) | 0, b = (236 + (214 - 236) * t) | 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  scene.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const sun = [0.32, 0.22, 0.92];
  const sunL = Math.hypot(sun[0], sun[1], sun[2]);
  const drawTri = (a, b, c, rgb) => {
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 0.5) return;
    let minx = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    let maxx = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    let miny = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    let maxy = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const ax = b.wx - a.wx, ay = b.wy - a.wy, az = b.wz - a.wz;
    const bx = c.wx - a.wx, by = c.wy - a.wy, bz = c.wz - a.wz;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const nd = Math.abs(nx * sun[0] + ny * sun[1] + nz * sun[2]) / (nl * sunL);
    const lit = 0.38 + 0.62 * nd;
    const cr = Math.max(0, Math.min(255, rgb[0] * lit)) | 0;
    const cg = Math.max(0, Math.min(255, rgb[1] * lit)) | 0;
    const cb = Math.max(0, Math.min(255, rgb[2] * lit)) | 0;
    const A = Math.abs(area);
    for (let y = miny; y <= maxy; y++) {
      const py = y + 0.5;
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5;
        let w0 = (b.x - px) * (c.y - py) - (c.x - px) * (b.y - py);
        let w1 = (c.x - px) * (a.y - py) - (a.x - px) * (c.y - py);
        let w2 = (a.x - px) * (b.y - py) - (b.x - px) * (a.y - py);
        if (area < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = (w0 * a.z + w1 * b.z + w2 * c.z) / (w0 + w1 + w2);
        const zi = y * w + x;
        if (z < zbuf[zi] && z < 1.02 && z > -1.05) {
          zbuf[zi] = z;
          const i = zi * 4;
          rgba[i] = cr; rgba[i + 1] = cg; rgba[i + 2] = cb; rgba[i + 3] = 255;
        }
      }
    }
  };
  const toPix = (p) => {
    const iw = 1 / p.w;
    const ndx = p.x * iw, ndy = p.y * iw;
    return { x: (ndx * 0.5 + 0.5) * w, y: (1 - (ndy * 0.5 + 0.5)) * h, z: p.z * iw, wx: p.wx, wy: p.wy, wz: p.wz };
  };
  const clipNear = (poly) => {
    const near = 0.05, out = [];
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length];
      const ain = A.w >= near, bin = B.w >= near;
      const lerp = (t) => ({
        x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: A.z + (B.z - A.z) * t, w: A.w + (B.w - A.w) * t,
        wx: A.wx + (B.wx - A.wx) * t, wy: A.wy + (B.wy - A.wy) * t, wz: A.wz + (B.wz - A.wz) * t
      });
      if (ain && bin) out.push(B);
      else if (ain && !bin) out.push(lerp((A.w - near) / (A.w - B.w)));
      else if (!ain && bin) { const t = (A.w - near) / (A.w - B.w); out.push(lerp(t)); out.push(B); }
    }
    return out;
  };
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const geom = obj.geometry;
    const attr = geom.getAttribute('position');
    if (!attr) return;
    const colors = geom.getAttribute('color');
    const mat = obj.material && obj.material.color;
    const base = mat ? [mat.r * 255, mat.g * 255, mat.b * 255] : [180, 180, 180];
    const index = geom.index ? geom.index.array : null;
    const nTri = index ? index.length / 3 : attr.count / 3;
    const instances = obj.isInstancedMesh ? obj.count : 1;
    const inst = new THREE.Matrix4();
    const worldM = new THREE.Matrix4();
    const local = new THREE.Vector3();
    const world = new THREE.Vector3();
    const q = new THREE.Vector4();
    for (let n = 0; n < instances; n++) {
      if (obj.isInstancedMesh) obj.getMatrixAt(n, inst); else inst.identity();
      worldM.multiplyMatrices(obj.matrixWorld, inst);
      const clipM = new THREE.Matrix4().multiplyMatrices(vp, worldM);
      const wv = new Array(attr.count), cv = new Array(attr.count);
      for (let i = 0; i < attr.count; i++) {
        local.fromBufferAttribute(attr, i);
        world.copy(local).applyMatrix4(worldM);
        wv[i] = [world.x, world.y, world.z];
        q.set(local.x, local.y, local.z, 1).applyMatrix4(clipM);
        cv[i] = { x: q.x, y: q.y, z: q.z, w: q.w, wx: world.x, wy: world.y, wz: world.z };
      }
      for (let t = 0; t < nTri; t++) {
        const i0 = index ? index[t * 3] : t * 3;
        const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
        const i2 = index ? index[t * 3 + 2] : t * 3 + 2;
        let rgb = base;
        if (colors) rgb = [
          (colors.getX(i0) + colors.getX(i1) + colors.getX(i2)) / 3 * 255,
          (colors.getY(i0) + colors.getY(i1) + colors.getY(i2)) / 3 * 255,
          (colors.getZ(i0) + colors.getZ(i1) + colors.getZ(i2)) / 3 * 255
        ];
        const poly = clipNear([cv[i0], cv[i1], cv[i2]]);
        if (poly.length < 3) continue;
        const p0 = toPix(poly[0]);
        for (let k = 1; k < poly.length - 1; k++) drawTri(p0, toPix(poly[k]), toPix(poly[k + 1]), rgb);
      }
    }
  });
  return rgba;
}

function los3dKeyInset(rgba, w, h, model, cam, x, y, rw, rh) {
  los3dFillRect(rgba, w, h, x, y, rw, rh, [255, 255, 255]);
  for (let i = 0; i < rw; i++) { los3dPlot(rgba, w, h, x + i, y, [20, 20, 20]); los3dPlot(rgba, w, h, x + i, y + rh - 1, [20, 20, 20]); }
  for (let i = 0; i < rh; i++) { los3dPlot(rgba, w, h, x, y + i, [20, 20, 20]); los3dPlot(rgba, w, h, x + rw - 1, y + i, [20, 20, 20]); }
  const bb = losBounds(model, [{ x: cam.eye[0], y: cam.eye[1] }]);
  const sx = (bb[2] - bb[0]) || 1, sy = (bb[3] - bb[1]) || 1;
  const m = 8;
  const sc = Math.min((rw - m * 2) / sx, (rh - m * 2 - 10) / sy);
  const ox = x + m + ((rw - m * 2) - sx * sc) / 2, oy = y + m + ((rh - m * 2 - 10) - sy * sc) / 2;
  const X = px => ox + (px - bb[0]) * sc, Y = py => oy + (bb[3] - py) * sc;
  const fillRing = (ring, rgb) => {
    const P = losOpen(ring).map(p => [X(p[0]), Y(p[1])]);
    if (P.length < 3) return;
    let minx = rw, miny = rh, maxx = 0, maxy = 0;
    P.forEach(p => { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); });
    const x0 = Math.max(x, minx | 0), x1 = Math.min(x + rw - 1, maxx | 0);
    const y0 = Math.max(y, miny | 0), y1 = Math.min(y + rh - 1, maxy | 0);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if (losIn(xx, yy, P)) los3dPlot(rgba, w, h, xx, yy, rgb);
  };
  (model.buildings || []).forEach(b => fillRing(b.ring, los3dHex(LOS3D_PHASE[((b.phase || 1) - 1) % LOS3D_PHASE.length])));
  if (model.substation && model.substation.ring) fillRing(model.substation.ring, los3dHex('#e0c15a'));
  (model.berms || []).forEach(b => {
    const L = b.line || [];
    for (let i = 1; i < L.length; i++) {
      const x0 = X(L[i - 1][0]), y0 = Y(L[i - 1][1]), x1 = X(L[i][0]), y1 = Y(L[i][1]);
      const n = Math.max(1, Math.hypot(x1 - x0, y1 - y0) | 0);
      for (let k = 0; k <= n; k++) los3dPlot(rgba, w, h, x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, [30, 110, 40]);
    }
  });
  const heading = (cam.headingDeg || 0) * Math.PI / 180;
  const len = Math.min(rw, rh) * 0.28;
  const ax = X(cam.eye[0]), ay = Y(cam.eye[1]);
  const bx = ax + Math.sin(heading) * len, by = ay - Math.cos(heading) * len;
  const n = Math.max(1, Math.hypot(bx - ax, by - ay) | 0);
  for (let k = 0; k <= n; k++) {
    los3dPlot(rgba, w, h, ax + (bx - ax) * k / n, ay + (by - ay) * k / n, [208, 0, 0]);
    los3dPlot(rgba, w, h, ax + (bx - ax) * k / n + 1, ay + (by - ay) * k / n, [208, 0, 0]);
  }
  los3dFillRect(rgba, w, h, ax - 2, ay - 2, 4, 4, [208, 0, 0]);
  const nx = x + rw - 16, ny = y + 6;
  los3dFillRect(rgba, w, h, nx + 3, ny + 8, 2, 16, [10, 10, 10]);
  los3dDrawText(rgba, w, h, 'N', nx, ny, 1, [10, 10, 10]);
}

function los3dStamp(rgba, w, h, info) {
  const bar = 40;
  los3dFillRect(rgba, w, h, 0, h - bar, w, bar, [16, 16, 18]);
  const line1 = LOS_LABEL;
  const line2 = [info.dem || '', info.title || '', info.eye != null ? ('eye ' + info.eye + ' ft') : '', info.focal != null ? (info.focal + ' mm') : ''].filter(Boolean).join('  ·  ');
  let scale = 2;
  if (los3dTextWidth(line1, 2) > w - 12 || los3dTextWidth(line2, 2) > w - 12) scale = 1;
  los3dDrawText(rgba, w, h, line1, 8, h - bar + 4, scale, [255, 255, 255]);
  los3dDrawText(rgba, w, h, line2, 8, h - bar + 8 + 8 * scale, scale, [220, 220, 220]);
  const kw = Math.round(w * 0.21), kh = Math.round(h * 0.27);
  const kx = 10, ky = h - bar - kh - 8;
  if (info.model && info.camera && ky > 4) los3dKeyInset(rgba, w, h, info.model, info.camera, kx, ky, kw, kh);
  return { disclaimer: LOS_LABEL, dem: info.dem || '', title: info.title || '', line2 };
}

function los3dEncodePNG(rgba, w, h, text) {
  let zlib = null;
  if (typeof require === 'function') { try { zlib = require('zlib'); } catch (e) { zlib = null; } }
  if (!zlib) return null;
  const crcTable = los3dEncodePNG._crc || (los3dEncodePNG._crc = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })());
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    const c = crc32(out.subarray(4, 8 + data.length));
    out.writeUInt32BE(c, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = o + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  const idat = zlib.deflateSync(raw);
  const texts = [];
  const iTXt = (key, value) => {
    const kb = Buffer.from(key, 'latin1'), vb = Buffer.from(String(value), 'utf8');
    return Buffer.concat([kb, Buffer.from([0, 0, 0]), Buffer.from([0]), Buffer.from([0]), vb]);
  };
  texts.push(chunk('iTXt', iTXt('Disclaimer', (text && text.disclaimer) || LOS_LABEL)));
  if (text && text.dem) texts.push(chunk('iTXt', iTXt('DemResolution', text.dem)));
  if (text && text.title) texts.push(chunk('iTXt', iTXt('Title', text.title)));
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), ...texts, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function los3dPngText(png) {
  const buf = Buffer.isBuffer(png) ? png : Buffer.from(png);
  const out = {};
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'iTXt') {
      const z = data.indexOf(0);
      const key = data.toString('latin1', 0, z);
      // flag, method, lang\0, trans\0, then utf8
      let p = z + 1 + 2;
      const z2 = data.indexOf(0, p); p = z2 + 1;
      const z3 = data.indexOf(0, p); p = z3 + 1;
      out[key] = data.toString('utf8', p);
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}

async function los3dWebGL(THREE, scene, camera, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const pix = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pix);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(pix.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  if (renderer.dispose) renderer.dispose();
  return rgba;
}

async function los3dRender(model, cam, opt) {
  opt = opt || {};
  model = Object.assign({}, model, { dem: losDemNormalize(model.dem) || model.dem });
  const THREE = await los3dEnsureThree();
  const w = opt.width || 960, h = opt.height || 540;
  const built = los3dBuild(THREE, model, { year: opt.year, view: opt.view, camera: cam, figures: opt.figures });
  const camera = los3dCamera(THREE, cam, w, h);
  let rgba;
  if (typeof document !== 'undefined' && opt.webgl !== false) {
    try { rgba = await los3dWebGL(THREE, built.scene, camera, w, h); } catch (e) { rgba = null; }
  }
  if (!rgba) rgba = los3dRaster(THREE, built.scene, camera, w, h);
  const title = opt.title || (built.view === 'existing' ? 'Existing' : ('Proposed · ' + (built.year === 'maturity' ? 'maturity' : 'year ' + built.year)));
  const stamp = los3dStamp(rgba, w, h, {
    title, dem: model.dem ? model.dem.resLabel : '', eye: cam.eyeFt, focal: cam.focalMm || (cam.hfovDeg ? null : 50),
    model, camera: cam
  });
  if (cam.eyeFt == null && cam.eye) stamp.eye = null;
  const focal = cam.focalMm || null;
  const meta = { disclaimer: LOS_LABEL, dem: model.dem ? model.dem.resLabel : '', title, eyeFt: cam.eyeFt || null, focalMm: focal };
  // restamp line 2 with focal when the camera JSON uses focalMm
  if (focal) {
    // already included when cam.focalMm is set; oblique cameras set focalMm
  }
  const png = los3dEncodePNG(rgba, w, h, meta);
  return { rgba, png, width: w, height: h, counts: built.counts, view: built.view, year: built.year, meta, text: meta };
}

function los3dStack(a, b) {
  const w = a.width + b.width, h = Math.max(a.height, b.height);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (y < a.height) rgba.set(a.rgba.subarray(y * a.width * 4, (y + 1) * a.width * 4), y * w * 4);
    if (y < b.height) rgba.set(b.rgba.subarray(y * b.width * 4, (y + 1) * b.width * 4), y * w * 4 + a.width * 4);
    const i = (y * w + a.width) * 4;
    if (a.width < w) { rgba[i] = 208; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 255; }
  }
  return { rgba, width: w, height: h };
}

// three.js ray cast against the proposed scene. Returns the fraction of facing
// roof samples whose first hit is the target building (or nothing in front).
async function los3dRayFraction(model, vp, building, year) {
  const THREE = await los3dEnsureThree();
  const built = los3dBuild(THREE, model, { year, view: 'proposed', figures: false });
  const eye = losEye(model, vp);
  const z0 = losBuildingZ(model, building);
  const samples = losRoofSamples(building.ring, [eye.x, eye.y], z0 + (+building.heightFt || 0), 10);
  const ray = new THREE.Raycaster();
  let visible = 0;
  for (const s of samples) {
    const dir = new THREE.Vector3(s.x - eye.x, s.y - eye.y, s.z - eye.z);
    const dist = dir.length();
    dir.normalize();
    ray.set(new THREE.Vector3(eye.x, eye.y, eye.z), dir);
    ray.far = dist - 0.5;
    const hits = ray.intersectObjects(built.scene.children, true);
    const front = hits.filter(h => h.distance > 0.4 && h.distance < dist - 0.75);
    if (!front.length) visible++;
  }
  const total = samples.length;
  return { visible, total, pct: total ? Math.round(visible / total * 10000) / 100 : null };
}

async function los3dRenderPackage(model, opt) {
  opt = opt || {};
  const pkg = losPackage(model, { mode: opt.mode || model.mode || 'public' });
  const w = opt.width || 960, h = opt.height || 540;
  const byVp = {};
  for (const cam of pkg.cameras) byVp[cam.viewpointId] = cam;
  const existing = {};
  const frames = [];
  for (const pair of pkg.pairs) {
    const cam = byVp[pair.viewpointId];
    const who = (pair.caption && pair.caption.receptor) || 'Viewpoint';
    const yearLabel = pair.year === 'maturity' || pair.year === 'mature' ? 'maturity' : ('year ' + pair.year);
    if (!existing[pair.viewpointId]) {
      existing[pair.viewpointId] = await los3dRender(model, Object.assign({}, cam, { eyeFt: cam.eyeFt, focalMm: cam.focalMm }), { view: 'existing', year: 1, width: w, height: h, title: 'Existing · ' + who, figures: false });
    }
    const proposed = await los3dRender(model, cam, { view: 'proposed', year: pair.year, width: w, height: h, title: 'Proposed · ' + yearLabel + ' · ' + who, figures: opt.figures !== false });
    pair.existing = { width: w, height: h, meta: existing[pair.viewpointId].meta };
    pair.proposed = { width: w, height: h, meta: proposed.meta };
    const stack = los3dStack(existing[pair.viewpointId], proposed);
    const png = los3dEncodePNG(stack.rgba, stack.width, stack.height, {
      disclaimer: LOS_LABEL,
      dem: (proposed.meta && proposed.meta.dem) || (model.dem && model.dem.resLabel) || '',
      title: 'Existing | ' + proposed.meta.title
    });
    frames.push({
      viewpointId: pair.viewpointId,
      year: pair.year,
      width: stack.width,
      height: stack.height,
      png,
      meta: los3dPngText(png),
      existingMeta: existing[pair.viewpointId].meta,
      proposedMeta: proposed.meta,
      counts: proposed.counts
    });
  }
  let oblique = null;
  if (opt.oblique !== false && pkg.oblique && pkg.oblique.camera) {
    const ocam = Object.assign({}, pkg.oblique.camera, { focalMm: pkg.oblique.camera.focalMm || 35, eyeFt: null });
    const frame = await los3dRender(model, ocam, { view: 'proposed', year: 'maturity', width: w, height: h, title: 'Massing context', figures: false });
    oblique = { width: frame.width, height: frame.height, png: frame.png, meta: frame.meta, counts: frame.counts };
    pkg.oblique.png = true;
  }
  return { package: pkg, frames, oblique };
}

if (typeof globalThis !== 'undefined') {
  globalThis.los3dRenderPackage = los3dRenderPackage;
  globalThis.los3dBuild = los3dBuild;
  globalThis.los3dEnsureThree = los3dEnsureThree;
}
