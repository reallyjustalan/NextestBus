# NUS Bus Arrivals

A minimal, accessibility-oriented NUS bus arrivals web app. It lists every stop up front, lets users pin stops, opens arrival timings inline, and shows NUS shuttle routes as simple ordered stop timelines.

The app is designed to be installable as a PWA so mobile users can add it to their home screen and use it like a small bus app.

## Data Source

Bus stop, route, and arrival data come from [nusbus.com](https://nusbus.com/) through their public API at:

```text
https://api.nusbus.com/api
```

This project does not talk to the uNivUS private API directly. The Cloudflare Worker exposes a local proxy endpoint at `/api/nusbus`, forwards requests to `api.nusbus.com`, and returns the upstream JSON. API responses are marked `cache-control: no-store` because bus arrivals are live data.

The frontend currently uses:

```text
GET /stops
GET /stops/:stopId
GET /services/:serviceKey
GET /api/locations
```

The upstream `/directions` endpoint exists, but the frontend does not use it for optimal campus routing. It can return a path between selected stops, but it does not reason about walking to nearby or opposite stops, live-arrival tradeoffs, route overlaps, or whether a different boarding stop would be better for a venue-to-venue trip.

The route data can also be embedded inside stop arrival responses, so the app merges service data from `/services/:serviceKey` with service data found while loading stops. `/api/locations` returns the local `project/public/data/nus-map-locations.json` dataset for directions autocomplete and nearest-stop resolution. That file is generated from the NUS campus map autocomplete endpoint at `https://map.nus.edu.sg/index.php/search/ajax_auto`; map-provided bus stop records, lecture theatres, and classroom-like seminar/tutorial records are excluded because the app already loads bus stops from the NUSBus API and directions autocomplete should target campus places rather than class venues.

## Project Layout

```text
project/
  public/
    index.html              Static app shell
    app.js                  Frontend state, rendering, routing, geolocation, PWA prompt
    directions-planner.js   DOM-free client-side directions planner
    styles.css              App styling
    sw.js                   Service worker for PWA shell caching
    manifest.webmanifest    PWA manifest
    icons/                  App icons
  test/
    directions-planner.test.js
  src/
    index.js                Cloudflare Worker proxy and static asset handler
  wrangler.toml             Cloudflare configuration
  package.json              Wrangler scripts
```

## Run Locally

```bash
cd "project"
npm run dev
```

If the default port is busy:

```bash
npm run dev -- --port 5174
```

Deploy with:

```bash
npm run deploy
```

Dry-run deploy:

```bash
npm run deploy -- --dry-run
```

## Architecture

The app is a static frontend served by a Cloudflare Worker.

The Worker has two jobs:

1. Serve the files in `public/` through Cloudflare assets.
2. Proxy `/api/nusbus?endpoint=...` requests to `https://api.nusbus.com/api`.

The browser never calls `api.nusbus.com` directly. It calls the same-origin proxy instead, which avoids CORS problems and keeps the frontend deployment simple.

The frontend keeps state in memory:

- `stops`: all known stops from `/stops`
- `filteredStops`: the current rendered stop list after search, pins, and location sorting
- `pinnedStopIds`: saved in `localStorage`
- `arrivalsByStop`: cached stop-detail responses
- `routeServicesByKey`: cached/merged route service records
- `activeRouteKey`: currently opened route, if any
- `sortOrigin`: browser geolocation coordinates, if enabled
- `routeVehicleMemory`: short-lived memory of live bus locations

## Directions Planning Paradigm

Directions are planned in the browser by `project/public/directions-planner.js`, not by the upstream `/directions` endpoint. The module is intentionally DOM-free so it can be tested independently and called from `app.js` with stops, route services, selected locations, and live arrivals.

The core dilemma is that campus travel is not just "take a route between two known bus stops." A user can start from any NUS venue or stop, walk to several possible nearby stops, cross to an opposite stop, wait for live buses, transfer, or skip the bus and walk directly. The upstream API can provide route paths, but it does not choose the globally best combination of walking, waiting, boarding, riding, and alighting.

The app therefore treats directions as a lightweight graph-search problem:

```text
origin location
  -> walk edges to candidate origin stops
  -> bus edges along NUS shuttle service routes
  -> transfer-walk edges between nearby stops
  -> walk edges from candidate destination stops
  -> destination location
```

The planner runs Dijkstra search over that graph. Edge weights are estimated seconds, but the planner also keeps a separate route-ranking score so that display order can reflect user experience rather than only raw clock time.

### Planner Inputs

`app.js` remains responsible for UI resolution and data loading:

- resolve the selected `From` and `To` items from autocomplete
- load all NUS shuttle route services needed for planning
- reuse `state.arrivalsByStop` when live stop data is already available
- fetch live arrivals for origin candidate stops when needed
- pass the data into `planDirections(input)`

`directions-planner.js` remains responsible for the routing logic:

- choose candidate stops around the origin and destination coordinates
- build the route graph from NUS shuttle services only
- run Dijkstra search
- estimate walking, waiting, riding, transfers, and total duration
- return normalized `walk` and `bus` legs for rendering
- return alternatives so the UI can show useful bus options even when walking is fastest

### Candidate Stops

Candidate stops are chosen by distance from the location coordinates. The planner includes stops within the access radius and always keeps a small minimum set of nearest stops so sparse areas still get route options.

This is why venue directions can consider an opposite stop or a nearby downstream stop rather than blindly using only the nearest named bus stop.

### Walking Time

Walking time is estimated from Haversine distance with a walking distance factor:

```text
estimated walking seconds =
  distanceKm * walkingDistanceFactor / walkingSpeedKmh * 3600
```

The distance factor acknowledges that people do not walk in a perfectly straight line across campus. Walking is still an estimate, not a map-routed pedestrian path.

### Bus Ride Time

Bus segment duration is estimated from the service route geometry when route path points are available. If geometry is missing, the planner falls back to stop-to-stop distance with a road distance factor.

This is deliberately lightweight. We do not have reliable historical travel times between every stop pair, so the planner uses physical route length as a proxy. Dwell time is added per segment.

### Live Arrivals And Catchability

Live arrival times are used for the first boarding decision when available. The planner first accounts for walking time to the candidate stop, then checks whether the user can catch the bus.

The chosen behavior is:

- if the user can comfortably walk there before the bus, use that arrival
- if the user is slightly late but inside the `catchGraceSeconds` window, keep it as a `tight` catch
- if the bus is too early, skip it and try the next arrival
- if no usable live arrival exists, use `defaultWaitSeconds`

This supports the "maybe I can run for it" case without pretending every missed bus is catchable. Tight catches are shown in the UI as tight catches instead of being hidden.

### First-Bus Wait Versus Route Quality

One of the hardest tradeoffs is first-bus waiting time.

If first-bus wait time is fully included in route search, the planner can choose physically silly routes:

```text
walk away from the destination
board an earlier bus
ride through or past a better boarding point
walk longer at the end
```

That is bad UX because users generally prefer waiting at the sensible nearby stop over walking backward just to catch a bus sooner.

The current decision is:

- first-bus wait contributes to the displayed `totalSeconds`
- first-bus wait has little or no base cost in the Dijkstra route-shape score
- transfer waits still count because mid-route waiting affects the connection
- plausible tight first buses receive a bounded ranking boost
- final card ordering prefers faster `totalSeconds` when walking distance and transfers are comparable

This splits the problem into two ideas:

```text
What is a sane route shape?
What option gets the user there fastest among sane route shapes?
```

### Avoiding Regressive Boarding

The planner blocks a first bus edge when that same service will pass through a closer origin candidate before the alighting stop.

Example:

```text
Do not walk from Central Library to an upstream stop
just to board a bus that then passes Central Library.
```

This prevents live-arrival timing from making the user walk backward along the same route.

### Same-Service Continuation

The planner distinguishes between:

```text
continuing on the same physical service
boarding another bus with the same service code
```

If the search is already on `D1`, a following `D1` edge from the next stop is treated as continuation: zero additional wait, no transfer, and no "Board after transfer" note. Adjacent same-service bus legs are compressed into one displayed bus leg.

Walking or transferring clears the continuation state. If the user walks to another stop and boards `D1` again, that is still a real boarding.

This prevents directions like:

```text
take D1 from A to B
get off
take D1 from B to C
```

when the correct behavior is simply:

```text
stay on D1 from A to C
```

### Direct Walking

The planner always considers direct walking from origin to destination unless a bus route is explicitly required for an alternative. For short trips, direct walking can be the primary result.

Bus options are still generated as alternatives because a bus can be more comfortable than walking, especially in heat or rain, and live arrivals can make the bus faster in practice.

There are two hard boundary cases:

- if the origin and destination are the same place, the app does not run route finding and shows an "already there" message
- if a bus option involves more total walking than simply walking to the destination, bus alternatives are suppressed and only the walking route is shown

### Alternatives And Overlapping Routes

The planner generates more than one bus option:

- the best unconstrained bus route
- the best route starting with each available service
- slower overlapping services where they follow the same physical path

The app does not hide a bus option just because it arrives later. It may place it lower, but keeping it visible is useful because live arrival data can be wrong and some routes overlap.

Transfers are treated differently. Transfers inside NUS are uncommon because the shuttle network is designed to make most campus trips possible with one bus ride plus walking. Transfer routes are therefore capped and filtered:

- plans above `maxTransfers` are discarded
- if a no-transfer route exists, a transfer alternative must save a meaningful amount of time before it is shown
- transfer plans that walk back to a bus stop already used by the route are discarded as backtracking

This keeps "funny" routes out of the UI, such as riding away from Ventus, walking back to Ventus, then boarding another bus from Ventus.

### Final Plan Ranking

The current ranking logic is intentionally pragmatic:

1. Prefer less walking only when the walking difference is meaningful.
2. Prefer fewer transfers.
3. Otherwise prefer the lower displayed `totalSeconds`.
4. Use route-shape score only as a tie-breaker.

This is why, when two options have the same walking distance and no transfers, the bus that arrives first and gets the user there sooner should be shown first.

## Directions Display Decisions

Directions render as cards with a concise summary and normalized legs.

The summary shows:

```text
total duration
transfer count, only when there is at least one transfer
walking distance as an emphasized badge
less walking, when one visible option has a meaningfully shorter walk
```

The summary is deliberately user-facing. It uses the displayed estimated duration, including wait, not just the internal route-shape score.

Zero-transfer routes omit the transfer text because `0 transfers` adds noise without helping the user choose. When a slower option is ranked above a faster one because it involves much less walking, the walk badge makes that tradeoff visible instead of making the ordering look arbitrary.

### Walk And Bus Legs

Walking legs show:

- a walk badge
- start and end labels
- walking duration
- walking distance

Bus legs show:

- route badge
- start and end stops
- stop count
- the first three arrival chips
- a timing note such as `Catch the 6 min bus - 7 min ride`
- the stop trail

Tight catches are labeled as tight catches.

If a bus route has no live timings for its boarding service, it can still be shown as a possible route, but it is treated as not recommended:

- the card is sorted below timed bus and walking options
- the card header and badges are muted
- the timing note says live bus timings are unavailable

This avoids recommending shuttle routes that may not be running at that time.

### Grouping Duplicate Routes

The UI groups directions by physical leg shape. If two services take the same stop sequence between the same boarding and alighting stops, they are displayed in one card instead of duplicating the whole route.

Within a grouped bus leg, each service gets its own aligned row:

```text
D1  timings and note
R1  timings and note
```

This avoids repeated cards such as "Central Library -> Ventus" when every option brings the user through the same physical route.

Grouped cards are ordered by the fastest representative plan, so a coalesced option with an earlier useful bus appears before a slower one.

### Route Badges

Route badges reuse the service color data when available. When color data is missing, the app falls back to the accent green.

In directions, service route badges such as `D1` and `A2` are clickable and open the full route view. The larger walk/bus mode icon at the left of a card is decorative and does not navigate.

Stacked route badges must align with their corresponding timing rows. The CSS therefore treats each coalesced service as a two-column row:

```text
route badge column | service timing/details column
```

This prevents `D1` and `R1` badges from drifting vertically away from their own timing chips.

### Direction Mode Icons

Direction cards show a compact mode graphic:

- walking-only: person walking
- bus-only: bus
- mixed walk and bus: person walking plus bus

The app uses a tiny inline SVG sprite with only the Font Awesome `walking` and `bus-alt` paths. This was chosen over loading the Font Awesome kit because the app only needs two icons, should work locally and offline, and should avoid a runtime script that scans the DOM or downloads unused icon assets.

### Board After Transfer

`Board after transfer` is only shown when there was a previous bus leg. It is not shown after the initial walk to the first stop.

Same-service continuation is not a transfer and should not produce this note.

## Main Page Paradigm

The main page deliberately does not begin with a chooser. Every stop is listed immediately.

Users can:

- search stops by name, code, subtitle, or service
- pin stops with the heart button
- click a stop card to expand/collapse its timings
- click NUS shuttle service chips to open that route
- use browser location to sort stops closest-first

Public/SMRT/LTA style bus services are displayed passively. They are not clickable because the app is focused on NUS shuttle routes.

Pinned stops sort above unpinned stops. When location sorting is active, pinned stops still stay above the rest, and each group is ordered by distance.

## Browser Location

The app only uses browser-provided geolocation. Users do not enter coordinates manually.

When the user taps `Use Location`, the app calls:

```js
navigator.geolocation.getCurrentPosition(resolve, reject, {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 10000
});
```

The important decision is `maximumAge: 0`. This tells the browser not to intentionally reuse an older cached location. If a user moves and taps `Use Location` again, the app asks the browser for a fresh fix.

The app does not continuously track location. It does not call `watchPosition`. Location is only requested when the user taps the button.

When a location is available:

1. Each stop's coordinates are extracted from whichever known coordinate field exists on that stop object.
2. Distance is computed with the Haversine formula.
3. Stops are sorted closest-first, while still respecting pins.

When the user taps `Clear Location`, `sortOrigin` is cleared and the list returns to normal pin/name sorting.

## Route View Paradigm

Routes are opened through URL hashes:

```text
#route=nus%3AD1
```

This lets refreshes stay on the same route page and lets the browser Back button return to the stop list.

The route page shows:

- route badge and destination metadata
- ordered stops
- timing chips for each stop
- bus markers embedded on the left-side stop timeline

Clicking a stop inside route view returns to the main page, clears search/location filters, opens that stop, and scrolls to it.

The app treats the stop list itself as the road. The stop number is the physical stop location. Any bus marker is drawn from the left timeline toward the stop number instead of using a separate map panel.

## Timing Chips vs Bus Markers

This is one of the most important app decisions:

Timing chips and bus markers are not the same thing.

A timing chip answers:

```text
How long until the next bus reaches this stop?
```

A bus marker answers:

```text
Where do we have enough evidence to draw a bus on the route timeline?
```

Normal ETAs like `9 min`, `12 min`, or `14 min` do not create bus icons by themselves. They remain timing chips only.

This avoids pretending that a time estimate is the same as a physical bus position.

## When Bus Markers Are Generated

The app generates route bus markers only from stronger evidence:

1. An arrival says `Arriving` or has `minutes === 0`.
2. The arrival includes live vehicle coordinates.
3. A recently remembered live vehicle coordinate still exists after a refresh.

The code path is:

```text
routeVehiclesForService()
  -> vehicleFromArrival()
  -> stopForVehicle()
  -> canDrawArrivalMarker()
  -> addRouteVehicleCandidate()
```

`canDrawArrivalMarker()` currently allows a marker only if:

```text
arrival is Arriving
OR
vehicle has coordinates
```

No marker is drawn from a plain ETA alone.

## First Stop Rule

The app must never draw a bus before the first stop.

For loop routes, drawing a bus "toward stop 1" is visually confusing because the previous stop would be the last stop in the loop. That caused markers to appear above the first stop, which made it look like a bus existed before the route started.

Decision:

```text
No bus marker may target route sequence 1.
```

This is enforced in three places:

- route-level candidate collection skips first-stop targets
- row-level arriving-marker rendering skips the first stop
- remembered live locations skip the first stop

The first stop can still show timing chips such as `9 min`. It just cannot produce a bus icon.

## Arriving Rule

`Arriving` is treated as the strongest stop-level evidence that a bus is at the stop.

When a stop has an `Arriving` timing:

- the station number can be colored to match the bus route color
- a bus icon can be shown at that stop
- the bus is considered stopped, not moving between stops

Exception: the first stop rule still wins. If the first stop says `Arriving`, the app can show the timing chip, but it should not draw a bus icon before/at sequence 1.

## Live Location Memory

Live bus coordinates are not always present on every refresh.

To reduce marker flicker, the app remembers recent coordinate-backed bus markers in `routeVehicleMemory`. A remembered marker can be reused for up to:

```text
REFRESH_INTERVAL_MS * 4
```

With the current refresh interval, that is about 2 minutes.

This is not an ETA-based estimate. It is only preservation of a recently known live location. If there is no live coordinate history and no `Arriving` status, the app does not invent a bus position.

## Marker Placement

Bus markers sit in the route stop's left track column.

For stopped/arriving buses:

- the marker points at the stop number
- the stop number receives route color treatment

For moving buses:

- the marker is placed along the vertical segment leading into the target stop
- coordinates can qualify a candidate as drawable, but the current compact timeline placement is not a map-accurate GPS projection
- visual progress is derived from arrival state/minutes once the marker is allowed
- `Arriving` places the marker at the target stop; non-arriving candidates use a bounded progress value from the ETA
- markers get a small horizontal jitter so multiple buses do not sit exactly on top of one another

Markers include a hover/focus title with available details such as vehicle plate, status, speed, and load. License plates are not emphasized in the UI because the primary accessibility goal is route position and timing.

## Crowd / Load Colors

Arrival timing chips are color-coded by load when the API provides load information:

- low load: green
- medium load: amber
- high/crowded load: red
- unknown load: neutral

The numbers themselves carry the load color so the mobile timing row can stay compact.

## Refresh Behavior

Constants:

```text
REFRESH_INTERVAL_MS = 30000
FRESHNESS_TICK_MS = 5000
```

Every 30 seconds, the app refreshes visible live data:

- if a stop card is open, it refreshes that stop
- if a route is open, it refreshes the active route and its per-stop timings
- if nothing live is open, it only updates the freshness label

The app also refreshes visible data when the tab becomes visible again.

If a background refresh fails, the app keeps the last good timings visible instead of blanking the UI.

## PWA Behavior

The app is installable as a PWA:

- `manifest.webmanifest` defines the name, icon set, theme color, and standalone display mode
- `sw.js` caches the static app shell and icons
- API requests are excluded from service-worker caching

Static files use a network-first service-worker strategy with cached fallback. This helps mobile users receive code fixes while still keeping the app shell available offline.

The install prompt is intentionally small:

- Chromium-style browsers use the real `beforeinstallprompt` event when available
- iOS/iPadOS gets a short hint to use Share -> Add to Home Screen
- installed apps do not show the prompt
- dismissed prompts are remembered in `localStorage`

## Local Storage

The app uses `localStorage` for:

```text
nusbus-pinned-stops
nusbus-install-prompt-dismissed
```

Pinned stops are user preferences. The install prompt dismissal prevents repeated nagging.

## Accessibility Decisions

The app was built around fast, readable access to bus arrivals:

- all stops are visible up front
- stop cards expand inline instead of requiring nested pages
- route views use browser history instead of custom-only Back buttons
- timings are compact on mobile
- route bus markers are embedded in the stop list instead of living in a separate map that users must interpret
- NUS route colors are reused consistently for chips, markers, and stopped station numbers
- controls use real buttons and labels

## Known Limits

- The app depends on nusbus.com API shape and availability.
- Live vehicle coordinates are not guaranteed by the upstream data.
- Bus marker positions are visual indicators, not precise maps.
- The app does not estimate vehicle positions from normal ETAs alone.
- The first stop intentionally never receives a bus marker, even if the API returns data that could otherwise be interpreted as one.
- Directions use estimated walking and riding time, not map-routed pedestrian paths or historical per-stop bus travel times.
- Directions use live arrivals only where the app has loaded arrival data, mostly around candidate origin stops.
- Tight-catch routing is a UX heuristic. It can suggest a bus the user may miss if they walk slowly or the bus leaves early.
- Route alternatives are ranked for practical usefulness, not mathematically guaranteed real-world optimality under every live-data error.
