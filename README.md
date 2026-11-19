# Weather-aware truck routing

Plan a truck trip and get three routes, each scored on forecast wind, rain and snow at the time the truck will actually be at each point. The app recommends the safest route, shows why the others lost, and plays the next 48 hours of weather along the corridor.

**Live app:** https://weather-truck-routing-vert.vercel.app
**Walkthrough (Loom):** _link to be added_
**API docs:** https://weather-truck-routing-vert.vercel.app/api/docs

Stack: React 19 + TypeScript + MapLibre GL (Vite) on the front end, Django 6 + Django Ninja on the back end, deployed on Vercel. No database, no API keys.

## What it does

1. **Three routes.** Trips under 1,500 km use Valhalla's truck profile with the load's weight. Longer trips are truck-routed in legs (see [Routing](#routing)). If fewer than three distinct routes come back, the gap is filled by routing through a point pushed sideways from the straight line.
2. **Weather where the truck will be, when it will be there.** Checkpoints every 10, 25 or 50 miles (your choice) get the forecast for the truck's arrival time, including US hours-of-service breaks (on by default).
3. **Risk per checkpoint**, using the brief's thresholds and load rules exactly. The worst of wind, rain and snow sets the level.
4. **A recommendation** using the brief's order: fewest Severe miles, then fewest High miles, then lowest average risk, then shortest time. Each route gets one line explaining the deciding criterion.
5. **A map** with all three routes, the selected route coloured by risk, checkpoint popups (ETA, wind, gusts, rain, snow, what drove the level) and a smooth weather heatmap with a 0 to 48 hour slider and play button.

## How it works

```
Browser                                  Django API (stateless)              Free public services
───────                                  ──────────────────────              ─────────────────────
form ──── POST /api/plan ──────────────▶ validate, origin time zone
                                         routes ───────────────────────────▶ Valhalla (truck) / OSRM
                                         checkpoints + ETAs (HOS)
                                         corridor grid
          ◀── GeoJSON + signed token ───
fetch forecasts ─────────────────────────────────────────────────────────────▶ Open-Meteo
          ── POST /api/score (token + raw forecasts) ──▶ classify, rank, explain
          ◀── levels, summaries, ranking, heatmap ─────
map + cards
```

**Why the browser downloads the forecasts.** Open-Meteo's free tier is limited per IP address, and serverless hosts share outgoing IPs between many tenants, whose usage can exhaust the daily quota before this app makes a single call. Fetching in the browser spends the viewer's own quota. Django still does all the scoring; the plan is handed to the browser as a signed token, so `/score` can trust the checkpoints and times without storing anything.

### Routing

- **Valhalla (FOSSGIS public server), truck costing**, with gross weight = cargo + 34,000 lb tare, in tonnes, and a 65 mph top speed. A weight the server would silently clamp is treated as an error.
- **Long trips (over 1,500 km straight line)** exceed what the public server accepts in one request. OSRM sketches three corridors; each is cut into legs of about 650 road miles at the straightest nearby stretch of road; every leg is truck-routed with arrival and departure headings; the legs are stitched together. If a forced join makes the truck drive out to a point and straight back, that spur is cut out along with its time. Seattle to Washington DC: 5 legs per route, about 20 s the first time and under 3 s once cached.
- **Fallback.** Valhalla gets a 2.5 s head start; if it is slow, OSRM is asked in parallel and the first good answer wins. If Valhalla is down or a leg fails, the plan uses OSRM (car roads, truck speed capped at 65 mph) and the UI says so. "No road between these points" (an island, a lake) is a final answer, not a reason to fall back.
- **Routes into Canada** (Detroit to Buffalo goes through Ontario) are flagged and ranked after US-only routes, since a domestic load would need a border crossing.

### Weather

- Open-Meteo hourly `wind_speed_10m`, `wind_gusts_10m`, `rain`, `showers`, `snowfall`, requested directly in mph and inches.
- **Rain is `rain + showers`**, not `precipitation`, which already contains the melted snow and would count snow twice. Snowfall is snow depth in inches per hour.
- Rain, snow and gusts are totals or maxima for the hour that *ends* at each timestamp, so a truck arriving at 13:20 uses the 14:00 value. Sustained wind is a snapshot, so it uses the larger of 13:00 and 14:00.
- Up to 1,000 locations go in one request. Checkpoints come first, so routes are scored even if heatmap cells have to wait for the per-minute limit. Forecasts are cached in the tab for 30 minutes.
- A missing forecast is **Unknown**, never Low.

## Interpretations of the brief

Each of these is pinned by a test.

| Question the brief leaves open | Choice | Why |
|---|---|---|
| Band edges (is 0.25 in/hr Moderate or High?) | Lower edge inclusive: 25 mph, 0.10, 0.25, 0.50 in/hr start their band. Top rain and snow bands are strict as written (`> 1.00`, `> 3.0`), so exactly 1.00 in/hr is Severe. | Matches the table's own `≥ 55`. |
| Values between printed integers (34.5 mph) | Belong to the lower band: [25, 35) is Moderate. | No gaps in coverage. |
| Float noise (0.09 + 0.01 = 0.0999…) | Values are rounded to the forecast's precision before comparison. | Otherwise 0.10 in/hr reads as Low. |
| "Load weight" | Cargo weight, 0 to 80,000 lb. The load rules apply to it as written (`> 30,000`, `> 40,000`). | The rules' thresholds only make sense for cargo. |
| Sustained wind or gusts | Sustained by default (matches the table and a hand check), with a **Gusts** toggle for a conservative view. Both results come back in one response, so the toggle is instant. | Real high-wind closures (for example WYDOT's) are set on gusts. |
| No Travel in the ranking | No Travel miles are compared before Severe miles, and a route with any No Travel miles is never "Recommended". | No Travel is worse than Severe. |
| Missing forecasts | Ranked twice, once as Low and once as No Travel. A route is recommended only if it wins both ways. | Unknown weather must not decide or hide a recommendation. |
| Miles per checkpoint | Each checkpoint stands for the road halfway to each neighbour, so the miles add up exactly to the route length. | Fair at the ends and for short trips. |
| Departure time | Wall-clock time at the origin, in the origin's time zone (not the browser's). Times that do not exist (a spring-forward gap) are rejected. | A dispatcher in Denver means Denver time. |
| Travel time | Driving time plus hours-of-service stops: a 30-minute break after 8 hours and a 10-hour rest after 11 hours of driving. Can be switched off. | A 13-hour drive is a 24-hour trip. |
| Heatmap | Interpolated from each cell's actual severity value, not a point-density heatmap. Its whole-number part always equals the risk level, so it cannot disagree with the scoring. | A density heatmap shows where samples cluster, not where the weather is. |

The load rules make heavier trucks riskier in wind, as the brief says. In practice, empty high-profile trailers are often the ones restricted in high wind; a production version would make these rules configurable per fleet.

## Performance (measured)

Headless Chromium on an Apple M4:

- **Heatmap slider:** stepping through all 49 hours, one per frame, takes the same time per frame as an idle page (20 ms per two frames; worst frame 21 ms). The hour lives outside React; each change redraws one small canvas.
- **Plans:** Dallas to Denver about 2 s; Detroit to Buffalo planned, forecast and scored in about 2 to 3 s; Seattle to Washington DC (truck legs) about 20 s the first time, under 3 s cached.
- **Bundle (gzip):** app 79 KB; the map (MapLibre) loads separately at about 300 KB, in parallel with the form.

## Running it locally

Requirements: Python 3.13 with [uv](https://docs.astral.sh/uv/), Node 22 or later.

```bash
cd backend && DJANGO_DEBUG=1 uv run uvicorn config.asgi:application --port 8000
```

```bash
cd frontend && npm ci && npm run dev
```

Open http://localhost:5173 (Vite proxies `/api` to Django).

Checks:

```bash
cd backend && uv run pytest && uv run ruff check . && uv run mypy planner config
```

```bash
cd frontend && npm run typecheck && npm run build
```

After changing an API schema: `uv run python manage.py export_openapi` (backend), then `npm run gen:api` (frontend) regenerates the TypeScript types.

## Code map

```
backend/planner/
  domain/        pure logic, no I/O: geometry, polylines, ETAs, hours of service,
                 checkpoints, risk, scoring and ranking, corridor grid, Canada check
  providers/     Valhalla, OSRM, the router (hedging, fallback, legs, third routes)
  services.py    the two use cases: plan and score
  api.py         Django Ninja endpoints and error mapping
  schemas.py     request and response models (source of the OpenAPI spec)
backend/tests/   115 tests; recorded router responses, no network
frontend/src/
  api/           typed client; schema.d.ts is generated from the OpenAPI spec
  lib/           weather download, heatmap canvas, route segments, formatting
  components/    form, place search, route cards, map, timeline, legend
```

Django Ninja rather than Django REST Framework: the plan endpoint makes several outbound calls, Ninja runs them natively async, and its Pydantic schemas generate the OpenAPI spec the frontend's types come from. I know Spotter uses DRF; the domain and provider code would move over unchanged.

## Limitations

- **Free public routers.** FOSSGIS Valhalla and the OSRM demo have no uptime guarantee and ask for at most one request per second; routes are cached for 30 minutes. FOSSGIS Valhalla went down for a day or more three times in 2026; the OSRM fallback is labelled when it is used.
- **OSRM routes cars.** When it is used, roads may not be truck-legal; speeds are capped at 65 mph.
- **Forecast quota** is per network: about 5,000 forecast locations an hour. A 10-mile check on a coast-to-coast trip uses about 1,000.
- **Forecasts change.** Open-Meteo is moving its US model from HRRR to RRFS around 30 Nov 2026, so live values will differ from the walkthrough.
- Hours of service model one driver starting fresh; the 14-hour window and weekly limits are not modelled.
- The Canada check uses a coarse outline (good to a few miles), meant to warn, not to adjudicate.

## Data and licences

Code: MIT (see `LICENSE`). Data is not MIT:
routes © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) via [FOSSGIS Valhalla](https://valhalla.openstreetmap.de) and [OSRM](https://project-osrm.org);
weather by [Open-Meteo.com](https://open-meteo.com) (CC BY 4.0, non-commercial use);
basemap by [OpenFreeMap](https://openfreemap.org) / OpenMapTiles;
place search by [Photon](https://photon.komoot.io).
Places you type are sent to these services. There is no analytics or tracking.

## How this was built

I used AI coding assistants throughout, for research, implementation and testing, and reviewed what they produced. The design decisions, the interpretations above and the testing against real routes and real weather are mine to answer for.
