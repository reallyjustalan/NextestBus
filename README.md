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
```

The route data can also be embedded inside stop arrival responses, so the app merges service data from `/services/:serviceKey` with service data found while loading stops.

## Project Layout

```text
project/
  public/
    index.html              Static app shell
    app.js                  Frontend state, rendering, routing, geolocation, PWA prompt
    styles.css              App styling
    sw.js                   Service worker for PWA shell caching
    manifest.webmanifest    PWA manifest
    icons/                  App icons
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
