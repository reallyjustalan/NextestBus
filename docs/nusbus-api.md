# `api.nusbus.com` Response Shape Notes

This is a practical reference for the public NUSBus API used by this repo.

Base URL:

```text
https://api.nusbus.com/api
```

These shapes were inferred from live responses sampled on `2026-06-10` and from how this project consumes them. They are useful for building other projects, but they are not an official stability guarantee from the API provider.

## Quick Endpoints

```text
GET /stops
GET /stops/:stopId
GET /services
GET /services/:serviceKey
GET /directions?fromStopId=...&toStopId=...
```

Examples:

```bash
curl https://api.nusbus.com/api/stops
curl https://api.nusbus.com/api/stops/COM3
curl https://api.nusbus.com/api/services
curl https://api.nusbus.com/api/services/nus:D1
curl "https://api.nusbus.com/api/directions?fromStopId=COM3&toStopId=UTOWN"
```

## Common Types

### Stop Summary

Used in `/stops`, `/stops/:stopId`, `/services`, `/services/:serviceKey`, and `/directions`.

```json
{
  "id": "COM3",
  "title": "COM 3",
  "subtitle": "",
  "shortLabel": "COM 3",
  "busStopCode": null,
  "coordinates": {
    "latitude": 1.294431,
    "longitude": 103.775217
  }
}
```

Common notes:

- `id` is the stable app-facing stop identifier.
- `busStopCode` may be `null` for NUS-internal stops.
- `subtitle` is often empty for NUS-only stops and populated for LTA/public-bus stops.

### Coordinates

```json
{
  "latitude": 1.294431,
  "longitude": 103.775217
}
```

### Service Ref

This lighter shape appears inside stop lists.

```json
{
  "key": "nus:D1",
  "name": "D1",
  "subtitle": "",
  "source": "nus",
  "color": {
    "background": "#C77DE0",
    "text": "#FFFFFF"
  },
  "arrivals": []
}
```

Notes:

- `key` is namespaced, for example `nus:D1` or `lta:95`.
- `source` is typically `nus` or `lta`.
- `arrivals` is empty in `/stops`, but populated in `/stops/:stopId`.

### Arrival

Used in `/stops/:stopId` and `/directions`.

```json
{
  "label": "Next",
  "minutes": 9,
  "display": "9 min",
  "estimatedArrival": "2026-06-10 15:12:00",
  "meta": "PD788A",
  "vehiclePlate": "PD788A",
  "liveVehicle": {
    "vehiclePlate": "PD788A",
    "coordinates": {
      "latitude": 1.298958,
      "longitude": 103.776104
    },
    "speed": 0,
    "direction": 99.7,
    "load": {
      "occupancy": 0.25,
      "crowdLevel": "low",
      "crowdLabel": "Low",
      "capacity": 88,
      "ridership": 22
    },
    "nextStop": {
      "id": "UHALL-OPP",
      "code": "18319",
      "name": "Opp University Hall"
    }
  }
}
```

Notes:

- `liveVehicle` may be `null`.
- `estimatedArrival` is a local-style datetime string, not ISO 8601.
- `meta` often duplicates or closely tracks the vehicle plate.

### Route Shape

Used in `/stops/:stopId` and `/services/:serviceKey`.

```json
{
  "code": "D1",
  "destination": "COM 3",
  "schedule": {
    "firstTime": "07:20",
    "lastTime": "23:00",
    "label": "Mon-Fri"
  },
  "stops": [
    {
      "sequence": 1,
      "id": "COM3",
      "code": "COM3-D1-S",
      "name": "COM 3",
      "shortName": "COM 3",
      "coordinates": {
        "latitude": 1.294431,
        "longitude": 103.775217
      },
      "rawId": "COM3-D1-S",
      "rawCode": "COM3-D1-S"
    }
  ],
  "path": [
    {
      "latitude": 1.29435,
      "longitude": 103.775239,
      "isStop": true,
      "stopCode": "COM3-D1-S"
    }
  ],
  "updatedAt": "2026-06-10T15:30:20+08:00",
  "activeBusCount": 2,
  "vehicles": [
    {
      "vehiclePlate": "PD726D",
      "coordinates": {
        "latitude": 1.296383,
        "longitude": 103.773944
      },
      "speed": 18,
      "direction": 299.6,
      "load": {
        "occupancy": 0.136,
        "crowdLevel": "low",
        "crowdLabel": "Low",
        "capacity": 88,
        "ridership": 12
      },
      "nextStop": {
        "id": "LT13",
        "code": "LT13",
        "name": "LT 13"
      }
    }
  ]
}
```

Notes:

- `route.path` can be very large.
- `route.stops` may include a repeated terminal stop with different raw codes, for example `COM3-D1-S` and `COM3-D1-E`.
- `vehicles` is present on full service detail responses.

## Endpoint Reference

### `GET /stops`

Top-level shape:

```json
{
  "updatedAt": "2026-06-10T07:10:33.666Z",
  "stops": [
    {
      "id": "COM3",
      "title": "COM 3",
      "subtitle": "",
      "shortLabel": "COM 3",
      "busStopCode": null,
      "coordinates": {
        "latitude": 1.294431,
        "longitude": 103.775217
      },
      "nus": {
        "caption": "COM 3",
        "name": "COM3",
        "longName": "COM 3",
        "shortName": "COM 3",
        "latitude": 1.294431,
        "longitude": 103.775217
      },
      "lta": null,
      "sourceModes": {
        "nus": true,
        "lta": false
      },
      "services": [
        {
          "key": "nus:D1",
          "name": "D1",
          "subtitle": "",
          "source": "nus",
          "color": {
            "background": "#C77DE0",
            "text": "#FFFFFF"
          },
          "arrivals": []
        }
      ]
    }
  ]
}
```

Notes:

- This is the broad catalog endpoint.
- Stops may be NUS-only, LTA-only, or mixed.
- `nus` and `lta` subobjects can be independently `null`.

### `GET /stops/:stopId`

Top-level shape:

```json
{
  "updatedAt": "2026-06-10T07:30:25.165Z",
  "stop": {
    "...": "Stop summary plus nus/lta/sourceModes/services"
  },
  "services": [
    {
      "key": "nus:D2",
      "name": "D2",
      "subtitle": "Opp University Hall",
      "source": "nus",
      "color": {
        "background": "#6E1D72",
        "text": "#FFFFFF"
      },
      "arrivals": [
        {
          "...": "Arrival object"
        }
      ],
      "routeCode": "D2",
      "routeId": 90295,
      "route": {
        "...": "Route shape"
      }
    }
  ]
}
```

Notes:

- This is the main live-arrivals endpoint.
- The `stop` object echoes stop metadata.
- Each service entry may include full route geometry and live vehicle information.

### `GET /services`

Top-level shape:

```json
{
  "updatedAt": "2026-06-10T07:10:33.666Z",
  "services": [
    {
      "id": "nus:D1",
      "key": "nus:D1",
      "name": "D1",
      "source": "nus",
      "color": {
        "background": "#C77DE0",
        "text": "#FFFFFF"
      },
      "description": "Campus shuttle service",
      "stopCount": 13,
      "previewStops": [
        {
          "...": "Stop summary"
        }
      ]
    }
  ]
}
```

Notes:

- This is a useful discovery/index endpoint.
- It includes both NUS and LTA services.
- `previewStops` is a short sample, not the full route.

### `GET /services/:serviceKey`

Top-level shape:

```json
{
  "updatedAt": "2026-06-10T07:10:33.666Z",
  "service": {
    "id": "nus:D1",
    "key": "nus:D1",
    "name": "D1",
    "source": "nus",
    "color": {
      "background": "#C77DE0",
      "text": "#FFFFFF"
    },
    "description": "Campus shuttle service",
    "stops": [
      {
        "...": "Stop summary"
      }
    ],
    "stopCount": 13,
    "route": {
      "...": "Route shape"
    }
  }
}
```

Notes:

- This is the most complete route-definition endpoint.
- It includes ordered stops, full path geometry, route schedule, and current vehicle snapshots.

### `GET /directions?fromStopId=...&toStopId=...`

Top-level shape:

```json
{
  "updatedAt": "2026-06-10T07:30:25.168Z",
  "fromStop": {
    "...": "Stop summary"
  },
  "toStop": {
    "...": "Stop summary"
  },
  "transfers": 0,
  "legs": [
    {
      "routeCode": "D1",
      "fromStop": {
        "...": "Stop summary"
      },
      "toStop": {
        "...": "Stop summary"
      },
      "stops": [
        {
          "...": "Stop summary"
        }
      ],
      "boardingArrivals": [
        {
          "label": "Next",
          "minutes": 19,
          "display": "19 min",
          "estimatedArrival": "2026-06-10 15:33:00"
        }
      ],
      "destination": "COM 3",
      "nextStop": "LT 13"
    }
  ]
}
```

Notes:

- The directions response is route-oriented and much lighter than this repo's in-browser planner output.
- `boardingArrivals` may omit `liveVehicle` details even when stop-detail endpoints include them.
- For this project, the frontend uses this endpoint only as background context and not as the final planner.

## Practical Integration Notes

- Cache `GET /stops` and `GET /services` more aggressively than `GET /stops/:stopId`.
- Treat `updatedAt` as the freshness marker for top-level responses.
- Do not assume `busStopCode` exists.
- Do not assume `liveVehicle` exists.
- Handle both `nus:*` and `lta:*` service keys.
- Expect large payloads for `/services/:serviceKey` because `route.path` is verbose.
- Be careful with terminal loops: some routes repeat the same logical stop with different raw route codes.
