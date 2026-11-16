"""Published Exhibit B and Exhibit L numbers, compared only where the filing states them.

The synthetic plant below is not the site. Exhibit B does not publish sound power or
distances, and Exhibit L does not publish an IES file, a mounting height, or pole
coordinates (the sheet is NTS). Absolute deltas stay empty. Tolerances below are on
our own arithmetic and on the published tables, not an allowance to match the filing
by adjusting inputs.
"""
import json, math, pathlib, shutil, subprocess, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / 'pipeline' / 'tests' / 'fixtures'

def load(*names):
    return '\n'.join((ROOT / 'pipeline' / n).read_text() for n in names)

def js(body):
    src = load('isolines.js', 'noise.js', 'photometric.js')
    src += '\nconsole.log(JSON.stringify((()=>{' + body + '\n})()))'
    r = subprocess.run(['node'], input=src, capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(r.stderr[-2000:])
    return json.loads(r.stdout)


@unittest.skipUnless(shutil.which('node'), 'node missing')
class ExhibitB(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pub = json.loads((FIX / 'exhibit_b_published.json').read_text())

    def test_published_scenario_deltas_are_small_for_maintenance(self):
        # These deltas are the filing's own table, not our model.
        for layout, rows in self.pub['receptors_dBA'].items():
            for i in range(5):
                maint = rows['maintenance'][i] - rows['typical'][i]
                emerg = rows['emergency'][i] - rows['typical'][i]
                self.assertIn(maint, (0, 1), layout)
                self.assertGreaterEqual(emerg, 8)
                self.assertLessEqual(emerg, 14)
        self.assertIsNone(self.pub['contour_distance'])
        self.assertIn('sound power', ' '.join(self.pub['unpublished']))

    def test_library_duties_follow_the_published_rules_without_a_load_derate(self):
        r = js("""const g=nzDefaultDuty('genset_enclosed'), t=nzDefaultDuty('transformer'), c=nzDefaultDuty('dry_cooler');
          return {g, t, c}""")
        self.assertEqual(r['g']['typical'], {'day': 0, 'night': 0})
        self.assertEqual(r['g']['maintenance'], {'day': 1, 'night': 0})
        self.assertEqual(r['g']['emergency'], {'day': 1, 'night': 1})
        self.assertEqual(r['t']['emergency'], {'day': 0, 'night': 0})
        self.assertEqual(r['t']['typical']['day'], 1)
        self.assertEqual(r['c']['emergency']['day'], 1)

    def test_synthetic_plant_is_not_scored_against_the_receptors(self):
        # One cooler, one transformer, one genset. Positions are invented.
        # 100 m to the receptor is not a distance from the filing.
        r = js("""
          const sources=[
            nzEquipment('dry_cooler',{id:'c',x:0,y:0,z:3.5}),
            nzEquipment('transformer',{id:'t',x:15,y:0,z:3}),
            nzEquipment('genset_enclosed',{id:'g',x:5,y:8,z:2})];
          const input={units:'m', sources, receptors:[{id:'r',name:'R',x:100,y:0,z:1.5}],
            grid:{xmin:0,ymin:0,xmax:30,ymax:15,spacing_m:15},
            scenarios:['typical_day','typical_night','maintenance_day','emergency_day'], contourMetrics:[]};
          const s=nzScreen(input);
          const lv=s.receptors[0].levels;
          const cross=name=>{let prev=null; for(let x=20;x<=900;x+=10){const L=nzLevelAt(input,x,0,name,1.5).dBA;
            if(prev!=null && prev>=45 && L<45) return x-10*(prev-45)/(prev-L); prev=L} return null};
          const g0=nzPropagate({units:'m',ground:{G:0},met:{tempC:10,rh:70},source:{x:0,y:0,z:3.5,lw:sources[0].lw},receiver:{x:100,y:0,z:1.5}}).dBA;
          const g1=nzPropagate({units:'m',ground:{G:1},met:{tempC:10,rh:70},source:{x:0,y:0,z:3.5,lw:sources[0].lw},receiver:{x:100,y:0,z:1.5}}).dBA;
          return {t:lv.typical_day.dBA, tn:lv.typical_night.dBA, m:lv.maintenance_day.dBA, e:lv.emergency_day.dBA,
            d45:{t:cross('typical_day'), m:cross('maintenance_day'), e:cross('emergency_day')},
            gSwing:g0-g1, assumed:s.equipment.every(x=>x.tag==='ASSUMED')};
        """)
        # Day and night match because Exhibit B has no day/night split and neither does this duty.
        self.assertAlmostEqual(r['t'], r['tn'], places=1)
        # Adding the assumed genset raises the level by much more than the filing's 0–1 dB.
        # That gap is the missing sound-power data, not a cue to edit the library.
        self.assertGreater(r['m'] - r['t'], 8)
        self.assertAlmostEqual(r['e'], r['m'], delta=0.5)  # transformer is quiet next to the genset; turning it off barely moves emergency
        # Our own 45 dBA crossing on this invented plant. Not a filing distance.
        self.assertGreater(r['d45']['t'], 90)
        self.assertLess(r['d45']['t'], 140)
        self.assertGreater(r['d45']['m'], 400)
        self.assertLess(r['d45']['m'], 520)
        self.assertAlmostEqual(r['d45']['e'], r['d45']['m'], delta=20)
        # G from 0 to 1 moves this cooler by a few dB. Default stays 0.5; the swing is the uncertainty.
        self.assertGreater(r['gSwing'], 3)
        self.assertLess(r['gSwing'], 6)
        self.assertTrue(r['assumed'])
        # No absolute delta is claimed.
        for layout, rows in self.pub['receptors_dBA'].items():
            for i, published in enumerate(rows['typical']):
                self.assertIsInstance(published, int)
                self.assertIsNone(self.pub['contour_distance'])


@unittest.skipUnless(shutil.which('node'), 'node missing')
class ExhibitL(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pub = json.loads((FIX / 'exhibit_l_published.json').read_text())

    def test_schedule_and_summary_ratios(self):
        sch = self.pub['schedule']
        self.assertAlmostEqual(sch['qty'] * sch['watts'], sch['total_watts'], delta=0.01)
        self.assertEqual(sch['llf'], 0.85)
        self.assertEqual(sch['lumens'], 15357)
        blank = [row for row in self.pub['summary'] if row['avg'] is None]
        self.assertEqual([row['label'] for row in blank], ['Substation_Top'])
        highs = [row['max'] for row in self.pub['summary'] if row['max'] is not None]
        self.assertEqual(max(highs), 4.2)
        for row in self.pub['summary']:
            if row['min'] in (None, 0, 0.0):
                self.assertIsNone(row['avgMin'])
                self.assertIsNone(row['maxMin'])
            else:
                self.assertAlmostEqual(row['avgMin'], row['avg'] / row['min'], delta=0.02)
                self.assertAlmostEqual(row['maxMin'], row['max'] / row['min'], delta=0.02)
        self.assertEqual(self.pub['property_line_fc'], 0.0)
        self.assertEqual(self.pub['property_line_limit_fc'], 2.0)
        self.assertTrue(any('IES' in item for item in self.pub['unpublished']))

    def test_scaled_synthetic_nadir_is_not_their_area_maximum(self):
        # 15,357 lm scales the synthetic cosine-squared shape. It does not become their IES file.
        # 30 ft is still our assumed mounting height; the schedule has no height.
        r = js("""const ies=phScaleToLumens(phSyntheticFullCutoffIES(), 15357);
          const f=phDefaultFixture({x:0,y:0,z:30,llf:0.85,ies,assumed:true});
          return {nadir:phIlluminance(f,0,0,0), lumens:ies.lumensRated, from:ies.scaledFromLumens}""")
        expect = 10000 * (15357 / r['from']) / (30 * 30) * 0.85
        self.assertAlmostEqual(r['nadir'], expect, delta=0.05)
        self.assertGreater(r['nadir'], 4.2)  # brighter at nadir than every published area maximum
        # Their 0.0 fc property-line result is not something this fixture can confirm.
        self.assertEqual(self.pub['property_line_fc'], 0.0)


if __name__ == '__main__':
    unittest.main()
