"""Build backend/planner/data/truck_stops.json: where a truck can stop and park.

Run offline (monthly is plenty); the app never queries these services per request.

Sources
-------
1. Public sites with truck-space counts (rest areas, welcome centres, turnouts):
   U.S. DOT BTS, National Transportation Atlas Database, "Truck Stop Parking" (2019).
   Public domain. Download all records as GeoJSON from
   https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Truck_Stop_Parking/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson
2. Private truck stops (Pilot/Flying J, Love's, TA/Petro and others) and truck parking:
   OpenStreetMap, (c) OpenStreetMap contributors, ODbL. The resulting file is a derived
   database under ODbL. Query (Overpass QL, US area), e.g. on a regional instance:
     [out:json][timeout:900];
     area["ISO3166-1"="US"][admin_level=2]->.us;
     ( nwr["highway"="services"](area.us);
       nwr["amenity"="fuel"]["hgv"~"yes|designated"](area.us);
       nwr["amenity"="fuel"]["brand"~"Pilot|Flying J|Love's|TA|Petro|TravelCenters"](area.us);
       nwr["amenity"="parking"]["hgv"~"yes|designated"](area.us);
       nwr["highway"="rest_area"]["hgv"~"yes|designated"](area.us); );
     out center tags;

Usage: python build.py osm_us_truck.json ntad_truck_stop_parking.geojson ../../backend/planner/data/truck_stops.json

Record fields: lat, lon, k (truck_stop | public | truck_parking), n (name), b (brand),
r (highway), sp (truck spaces, when known), src (osm | ntad), id (OSM id).
"""
import json, sys, math, re, collections, gzip
osm_path, ntad_path, out_path = sys.argv[1:4]
E = json.load(open(osm_path))['elements']
N = json.load(open(ntad_path))['features']
def ll(e): return (e['lat'], e['lon']) if 'lat' in e else (e['center']['lat'], e['center']['lon'])
def mi(a, b):
    R = 6371008.8; la1, lo1 = map(math.radians, a); la2, lo2 = map(math.radians, b)
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))/1609.344
MAJOR = re.compile(r"pilot|flying j|love'?s|^ta$|ta express|petro|travelcenters|sapp bros|bosselman|road ranger|town pump|ambest|buc-ee|one9|little america|iowa 80", re.I)
NAMEY = re.compile(r"truck ?stop|travel (center|plaza|stop)|truck plaza|auto ?truck", re.I)
HGV = ('yes', 'designated')
grid = collections.defaultdict(list)   # 0.05 deg buckets for dedupe
def near(p, r_mi):
    gx, gy = int(p[0]/0.05), int(p[1]/0.05)
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            for rec in grid[(gx+dx, gy+dy)]:
                if mi(p, (rec['lat'], rec['lon'])) < r_mi: yield rec
def add(rec):
    grid[(int(rec['lat']/0.05), int(rec['lon']/0.05))].append(rec); out.append(rec)
out = []
# 1. public facilities from NTAD (have truck-space counts)
for f in N:
    p = f['properties']
    add(dict(lat=round(p['latitude'],5), lon=round(p['longitude'],5), k='public', n=p['nhs_rest_stop'],
             r=p['highway_route'], sp=p['number_of_spots'], src='ntad'))
# 2. private truck stops from OSM: services/fuel that are truck-oriented
cands = []
for e in E:
    t = e['tags']; label = ' '.join(t.get(k,'') for k in ('brand','name','operator'))
    truck = t.get('hgv') in HGV or bool(MAJOR.search(label)) or bool(NAMEY.search(label))
    if t.get('highway') == 'services' and truck: rank = 0
    elif t.get('amenity') == 'fuel' and truck: rank = 1
    else: continue
    cands.append((rank, 0 if t.get('brand') or t.get('name') else 1, e))
cands.sort(key=lambda x: (x[0], x[1]))
for _, _, e in cands:
    p = ll(e); t = e['tags']
    hit = next(near(p, 0.35), None)
    if hit:
        if hit['src'] == 'osm' and not hit.get('n') and (t.get('name') or t.get('brand')):
            hit['n'] = t.get('name') or t.get('brand')
        continue
    cap = t.get('capacity:hgv')
    add(dict(lat=round(p[0],5), lon=round(p[1],5), k='truck_stop', n=t.get('name') or t.get('brand'),
             b=t.get('brand'), sp=int(cap) if cap and cap.isdigit() else None, src='osm', id=f"{e['type'][0]}{e['id']}"))
# 3. standalone HGV parking / rest areas from OSM not near anything above
for e in E:
    t = e['tags']; p = ll(e)
    if t.get('amenity') == 'parking' and t.get('hgv') in HGV: k = 'truck_parking'
    elif t.get('highway') == 'rest_area' and t.get('hgv') in HGV: k = 'public'
    else: continue
    if next(near(p, 0.35), None): continue
    cap = t.get('capacity:hgv') or t.get('capacity')
    add(dict(lat=round(p[0],5), lon=round(p[1],5), k=k, n=t.get('name'), sp=int(cap) if cap and cap.isdigit() else None,
             src='osm', id=f"{e['type'][0]}{e['id']}"))
for r in out:
    for key in list(r):
        if r[key] is None: del r[key]
blob = json.dumps(out, separators=(',', ':'))
open(out_path, 'w').write(blob)
print('records', len(out), collections.Counter((r['k'], r['src']) for r in out))
print('with spaces', sum(1 for r in out if 'sp' in r), 'bytes', len(blob), 'gzip', len(gzip.compress(blob.encode())))
