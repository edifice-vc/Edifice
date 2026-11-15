"""ISO 9613-2 screening model. The reference case is recomputed here from the standard, not from the JS."""
import json, math, pathlib, shutil, subprocess, textwrap, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
JS = '\n'.join((ROOT / 'pipeline' / f).read_text() for f in ('screening.js', 'noise.js'))
F = [63, 125, 250, 500, 1000, 2000, 4000, 8000]
# ISO 9613-2 Table 2, 10 °C, 70% RH, dB/km, rounded.
TABLE = {63: 0.1, 125: 0.4, 250: 1.0, 500: 1.9, 1000: 3.7, 2000: 9.7, 4000: 32.8, 8000: 117}


def alpha_db_per_m(f, T=283.15, hr=70, pa=101.325):
    """ISO 9613-1 absorption, written out from the standard."""
    pr, T0, T01 = 101.325, 293.15, 273.16
    ps = 10 ** (-6.8346 * (T01 / T) ** 1.261 + 4.6151)
    h = hr * ps * (pr / pa)
    papr = pa / pr
    frO = papr * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h))
    frN = papr * (T / T0) ** -0.5 * (9 + 280 * h * math.exp(-4.17 * ((T / T0) ** (-1 / 3) - 1)))
    f2 = f * f
    term = (1.84e-11 * (1 / papr) * math.sqrt(T / T0)
            + (T / T0) ** -2.5 * (0.01275 * math.exp(-2239.1 / T) / (frO + f2 / frO)
                                  + 0.1068 * math.exp(-3352 / T) / (frN + f2 / frN)))
    return 8.686 * f2 * term


def aweight(f):
    f2 = f * f
    c = 12194 ** 2
    ra = c * f2 * f2 / ((f2 + 20.6 ** 2) * math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))
    r1 = c * 1e12 / ((1e6 + 20.6 ** 2) * math.sqrt((1e6 + 107.7 ** 2) * (1e6 + 737.9 ** 2)) * (1e6 + 12194 ** 2))
    return 20 * math.log10(ra) - 20 * math.log10(r1)


def cweight(f):
    f2 = f * f
    c = 12194 ** 2
    rc = c * f2 / ((f2 + 20.6 ** 2) * (f2 + 12194 ** 2))
    r1 = c * 1e6 / ((1e6 + 20.6 ** 2) * (1e6 + 12194 ** 2))
    return 20 * math.log10(rc) - 20 * math.log10(r1)


def agr(hs, hr, dp, G):
    def ap(h):
        return (1.5 + 3 * math.exp(-0.12 * (h - 5) ** 2) * (1 - math.exp(-dp / 50))
                + 5.7 * math.exp(-0.09 * h * h) * (1 - math.exp(-2.8e-6 * dp * dp)))
    q = 0 if dp <= 30 * (hs + hr) else 1 - 30 * (hs + hr) / dp
    return -1.5 + G * ap(hs) + -1.5 + G * ap(hr) + -3 * q * (1 - G)


def ref_pair(hs, hr, dist, lw500, barrier=None):
    """One-band hand case. Other bands are silent. barrier is (dss, dsr, d, z, lam) or None."""
    d = dist
    Adiv = 20 * math.log10(d) + 11
    dp = dist  # equal heights, or the caller passes the horizontal distance as dist when it equals the slant
    # For the flat case slant == horizontal. For the barrier case the caller passes slant as dist
    # and the ground distance separately via the same number when the height difference is tiny;
    # this helper uses `dist` as both, and the barrier case below passes the real slant.
    Aatm = alpha_db_per_m(500) * d
    G = agr(hs, hr, dist if barrier is None else barrier['dp'], 0.5)
    Abar = 0
    if barrier:
        z, dss, dsr, dd, lam = barrier['z'], barrier['dss'], barrier['dsr'], barrier['d'], barrier['lam']
        c = 343.2 * math.sqrt(283.15 / 293.15)
        lam = c / 500
        kmet = math.exp(-math.sqrt(dss * dsr * dd / (2 * z)) / 2000)
        Dz = 10 * math.log10(3 + (20 / lam) * z * kmet)
        Abar = max(0, Dz - G)
        Aatm = alpha_db_per_m(500) * dd
        Adiv = 20 * math.log10(dd) + 11
        d = dd
    A = Adiv + Aatm + G + Abar
    Lf = lw500 - A
    return {'Adiv': Adiv, 'Aatm': Aatm, 'Agr': G, 'Abar': Abar, 'Lf': Lf,
            'dBA': Lf + aweight(500), 'dBC': Lf + cweight(500), 'd': d}


@unittest.skipUnless(shutil.which('node'), 'node missing')
class Noise(unittest.TestCase):
    def js(self, body):
        src = JS + '\nconsole.log(JSON.stringify((()=>{' + body + '})()))'
        p = subprocess.run(['node'], input=src, capture_output=True, text=True)
        if p.returncode != 0:
            self.fail(p.stderr[-2000:])
        return json.loads(p.stdout)

    def test_divergence_and_hard_ground_anchors(self):
        # 20 log10(100) + 11 = 51 exactly. Hard ground, q = 0, Agr = -3 exactly (ISO coherent reflection).
        r = self.js("const p=nzPropagate({x:0,y:0,h:5,lw:NZ_F.map(()=>100)},{x:100,y:0,h:5},nzEnv(),{});"
                    "const g0=nzAgr(5,5,100,0);return {Adiv:p.Adiv,Agr:p.Agr,hard:g0.Agr,q:g0.q}")
        self.assertAlmostEqual(r['Adiv'], 51, places=9)
        self.assertAlmostEqual(r['hard'], -3, places=9)
        self.assertEqual(r['q'], 0)
        self.assertAlmostEqual(r['Agr'], agr(5, 5, 100, 0.5), places=9)

    def test_atmosphere_matches_iso_9613_1_and_the_published_table(self):
        got = self.js("const e=nzEnv();return e.alpha.map(a=>a*1000)")
        for f, a in zip(F, got):
            self.assertAlmostEqual(a, alpha_db_per_m(f) * 1000, places=6)
            self.assertAlmostEqual(a, TABLE[f], delta=max(0.15, 0.025 * TABLE[f]))

    def test_hand_calculated_reference_case(self):
        # 100 dB at 500 Hz only, 100 m, both heights 5 m, G=0.5, 10 °C / 70% RH, no barrier.
        # Other bands at -200 dB do not move the sum at 0.001 dB.
        expect = ref_pair(5, 5, 100, 100)
        lw = '[-200,-200,-200,100,-200,-200,-200,-200]'
        r = self.js("const src={x:0,y:0,h:5,lw:%s,lwSrc:'caller'};const rec={x:100,y:0,h:5};"
                    "const raw=nzPropagate(src,rec,nzEnv(),{});const tag=nzPair(src,rec,{});"
                    "return {dBA:raw.dBA,dBC:raw.dBC,Adiv:raw.Adiv,Aatm:raw.bands[3].Aatm,Agr:raw.Agr,Abar:raw.bands[3].Abar,"
                    "Lf:raw.bands[3].Lf,audit:sgAudit(tag),label:NZ_LABEL}" % lw)
        self.assertAlmostEqual(r['Adiv'], 51, places=6)
        self.assertAlmostEqual(r['Aatm'], expect['Aatm'], places=5)
        self.assertAlmostEqual(r['Agr'], expect['Agr'], places=5)
        self.assertAlmostEqual(r['Abar'], 0, places=9)
        self.assertAlmostEqual(r['Lf'], expect['Lf'], places=4)
        self.assertAlmostEqual(r['dBA'], expect['dBA'], delta=0.01)
        self.assertAlmostEqual(r['dBC'], expect['dBC'], delta=0.01)
        self.assertEqual(r['audit'], [])
        self.assertEqual(r['label'], 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY')
        # The number a reviewer can recompute on a calculator: about 44.45 dBA.
        self.assertAlmostEqual(expect['dBA'], 44.45, delta=0.02)

    def test_barrier_hand_case(self):
        # Source (0, h=1), receiver (100, h=1.5), thin wall at x=50, top z=6.
        S, R, E = (0, 0, 1), (100, 0, 1.5), (50, 0, 6)
        d = math.dist(S, R)
        dss, dsr = math.dist(S, E), math.dist(E, R)
        z = dss + dsr - d
        dp = 100
        G = agr(1, 1.5, dp, 0.5)
        c = 343.2 * math.sqrt(283.15 / 293.15)
        lam = c / 500
        kmet = math.exp(-math.sqrt(dss * dsr * d / (2 * z)) / 2000)
        Dz = 10 * math.log10(3 + (20 / lam) * z * kmet)
        Abar = max(0, Dz - G)
        Adiv = 20 * math.log10(d) + 11
        Aatm = alpha_db_per_m(500) * d
        Lf = 100 - (Adiv + Aatm + G + Abar)
        lw = '[-200,-200,-200,100,-200,-200,-200,-200]'
        r = self.js("""const src={x:0,y:0,h:1,lw:%s};const rec={x:100,y:0,h:1.5};
const job={barriers:[{kind:'wall',a:[50,-20],b:[50,20],z0:0,z1:6}]};
const raw=nzPropagate(src,rec,nzEnv(),job);
const clear=nzPropagate(src,rec,nzEnv(),{barriers:[{kind:'wall',a:[50,-20],b:[50,20],z0:0,z1:0.2}]});
const hi=nzPropagate(src,rec,nzEnv(),{barriers:[{kind:'wall',a:[50,-20],b:[50,20],z0:0,z1:12}]});
return {Abar:raw.bands[3].Abar,Dz:raw.bands[3].Dz,Agr:raw.Agr,Lf:raw.bands[3].Lf,dBA:raw.dBA,
 A2k:raw.bands[5].Abar,clear:clear.bands[3].Abar,hi:hi.bands[3].Dz,how:raw.bands[3].how}""" % lw)
        self.assertGreater(z, 0.4)
        self.assertAlmostEqual(r['Dz'], Dz, places=4)
        self.assertAlmostEqual(r['Agr'], G, places=4)
        self.assertAlmostEqual(r['Abar'], Abar, places=4)
        self.assertAlmostEqual(r['Lf'], Lf, places=3)
        self.assertAlmostEqual(r['dBA'], Lf + aweight(500), delta=0.02)
        self.assertEqual(r['how'], 'single')
        self.assertEqual(r['clear'], 0)          # wall below the ray is not a barrier
        self.assertGreater(r['hi'], r['Dz'])     # a taller wall diffracts more
        self.assertGreater(r['A2k'], r['Abar'])  # shorter wavelength, more barrier loss

    def test_weighting_and_energy_sum(self):
        r = self.js("return {A:NZ_F.map(nzAweightDb),C:NZ_F.map(nzCweightDb),s:sgEnergy([60,60])}")
        for f, a, c in zip(F, r['A'], r['C']):
            self.assertAlmostEqual(a, aweight(f), places=6)
            self.assertAlmostEqual(c, cweight(f), places=6)
        self.assertAlmostEqual(r['s'], 10 * math.log10(2 * 10 ** 6), places=6)

    def test_scenarios_catalog_and_receptor_table(self):
        r = self.js("""const g=nzPlace('genset',0,0), c=nzPlace('cooler',5,0);
const rec={id:'R1',kind:'residence',x:80,y:0,h:1.5,limits:{dBA:{day:{v:70,src:'test limit'},night:{v:45,src:'test limit'}}}};
const job={sources:[g,c],receptors:[rec]};
const md=nzRun(Object.assign({scenario:'maintenance',period:'day'},job));
const mn=nzRun(Object.assign({scenario:'maintenance',period:'night'},job));
const en=nzRun(Object.assign({scenario:'emergency',period:'night'},job));
const tn=nzRun(Object.assign({scenario:'typical',period:'night'},job));
const cat=nzCatalog();
const row=md.receptors[0];
return {md:row.dBA.v,mn:mn.receptors[0].dBA.v,en:en.receptors[0].dBA.v,tn:tn.receptors[0].dBA.v,
 pass:row.pass,dist:row.distance.v,lim:row.limit_dBA,epa:row.epa55.level,amb:row.ambient.L90,
 audit:sgAudit(md),label:md.label,assumed:md.equipmentAssumed,
 genset:cat.find(x=>x.kind==='genset'),
 lp:nzHemisphericLp(105,7),nrun:nzRunAll(job).runs.length}""")
        self.assertGreater(r['md'], r['mn'])          # daytime test adds the generator
        self.assertAlmostEqual(r['mn'], r['tn'], places=6)  # maintenance night is the same as typical night
        self.assertGreater(r['en'], r['tn'])          # emergency night runs the generator
        self.assertIsInstance(r['pass'], bool)
        self.assertAlmostEqual(r['dist'], 75, places=6)  # nearest operating source is the cooler at x = 5
        self.assertEqual(r['lim']['src'], 'test limit')
        self.assertEqual(r['epa']['v'], 55)
        self.assertEqual(r['amb']['src'], 'TBD')
        self.assertEqual(r['audit'], [])
        self.assertEqual(r['label'], 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY')
        self.assertTrue(r['assumed'])
        self.assertEqual(r['genset']['src'], 'assumed')
        self.assertEqual(r['genset']['run']['maintenance']['night'], False)
        self.assertEqual(r['genset']['run']['emergency']['night'], True)
        self.assertAlmostEqual(r['genset']['lwA']['v'], 105, places=6)
        # 80 dBA at 7 m, hemispherical: Lw = Lp + 20 log10(7) + 10 log10(2π) ≈ 105
        self.assertAlmostEqual(r['lp'], 80, delta=0.15)
        self.assertEqual(r['nrun'], 6)
        blob = json.dumps(r)
        self.assertNotIn('MW', blob)
        self.assertNotRegex(blob, r'APN|gpm|owner')

    def test_grid_contours_and_worker(self):
        r = self.js("""const src=nzPlace('cooler',0,0);
const job={sources:[src],receptors:[{id:'R1',x:30,y:0,h:1.5}],scenario:'typical',period:'day',
 grid:{x0:-30,y0:-30,x1:30,y1:30,step:15,height:1.5}};
const out=nzRun(job);
const cell=sgMarch([40,60,60,60],2,2,0,0,1,1,[50]);
return {nx:out.grid.nx,ny:out.grid.ny,dx:out.grid.dx,h:out.grid.height,lines:out.isolines.levels.length,
 cell:cell[0].segs.length,audit:sgAudit(out),center:out.grid.values[out.grid.ny*out.grid.nx>>1]}""")
        self.assertEqual(r['nx'], 5)
        self.assertEqual(r['dx']['v'], 15)
        self.assertEqual(r['dx']['src'], 'caller')
        self.assertEqual(r['h']['v'], 1.5)
        self.assertGreater(r['lines'], 0)
        self.assertEqual(r['cell'], 1)
        self.assertEqual(r['audit'], [])
        self.assertGreater(r['center'], 40)

        worker = r'''
const {Worker}=require('worker_threads');
const path=require('path');
const w=new Worker(path.join(%r,'pipeline','noise_worker.js'));
w.on('message',m=>{console.log(JSON.stringify(m));w.terminate();});
w.on('error',e=>{console.error(e);process.exit(1)});
w.postMessage({type:'run',job:{sources:[{x:0,y:0,h:2,lw:[90,90,90,90,90,90,90,90],lwSrc:'caller',run:{typical:{day:true,night:true}}}],
 receptors:[{id:'R1',x:50,y:0,h:1.5}],scenario:'typical',period:'day'}});
''' % str(ROOT)
        p = subprocess.run(['node', '-e', worker], capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr[-1500:])
        msg = json.loads(p.stdout)
        self.assertEqual(msg['type'], 'result')
        self.assertEqual(msg['result']['label'], 'EDIFICE SCREENING MODEL — NOT A SOUND STUDY')
        direct = self.js("return nzRun({sources:[{x:0,y:0,h:2,lw:[90,90,90,90,90,90,90,90],lwSrc:'caller',run:{typical:{day:true,night:true}}}],receptors:[{id:'R1',x:50,y:0,h:1.5}],scenario:'typical',period:'day'}).receptors[0].dBA.v")
        self.assertAlmostEqual(msg['result']['receptors'][0]['dBA']['v'], direct, places=6)

    def test_consultant_grid_import(self):
        csv = "# firm: Test Acoustics\nx,y,dBA,dBC\n0,0,40,50\n15,0,42,52\n0,15,41,51\n15,15,44,54\n"
        r = self.js("""const imp=nzImportCsv(%r);
const job={consultant:imp,receptors:[{id:'R1',x:0,y:0,h:1.5,limits:{dBA:{day:{v:55,src:'test'}}}}],period:'day'};
const out=nzFromConsultant(job);
const idw=nzImportCsv('0,0,30\\n10,0,50\\n0,10,70\\n');
return {label:out.label,v:out.receptors[0].dBA,pass:out.receptors[0].pass,audit:sgAudit(out),
 nx:imp.grid.nx,idw:nzSample(idw.grid,0,0).dBA,screen:NZ_LABEL}""" % csv)
        self.assertEqual(r['label'], 'MODEL BY Test Acoustics')
        self.assertNotEqual(r['label'], r['screen'])
        self.assertAlmostEqual(r['v']['v'], 40, places=6)
        self.assertEqual(r['v']['src'], 'consultant')
        self.assertTrue(r['pass'])
        self.assertEqual(r['nx'], 2)
        self.assertEqual(r['audit'], [])
        self.assertAlmostEqual(r['idw'], 30, places=6)


if __name__ == '__main__':
    unittest.main()
