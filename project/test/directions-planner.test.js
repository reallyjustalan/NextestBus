import assert from "node:assert/strict";
import test from "node:test";
import { planDirections } from "../public/directions-planner.js";

const defaultOptions = {
  busSpeedKmh: 30,
  defaultWaitSeconds: 0,
  transferPenaltySeconds: 0,
  boardingBufferSeconds: 30,
  accessRadiusKm: 0.6,
  transferWalkRadiusKm: 0.2
};

test("returns an already-there plan for the same location", async () => {
  const result = await planDirections({
    fromItem: place("AS6", 1, 103),
    toItem: place("AS6", 1, 103),
    stops: [],
    services: [],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  assert.equal(result.kind, "already-there");
  assert.equal(result.totalSeconds, 0);
  assert.equal(result.legs.length, 0);
});

test("selects the next catchable bus after walking to the stop", async () => {
  const stops = [stop("A", 1, 103), stop("B", 1.02, 103)];
  const services = [service("S", [stops[0], stops[1]])];
  const result = await planDirections({
    fromItem: place("Start", 1.003, 103),
    toItem: place("End", 1.02, 103),
    stops,
    services,
    arrivalsByStop: new Map([
      ["A", [{ key: "nus:S", arrivals: [arrival(2), arrival(10)] }]]
    ]),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.selectedArrival.minutes, 10);
});

test("keeps a slightly early arrival as a tight catch", async () => {
  const stops = [stop("A", 1, 103), stop("B", 1.02, 103)];
  const services = [service("S", [stops[0], stops[1]])];
  const result = await planDirections({
    fromItem: place("Start", 1.0015, 103),
    toItem: place("End", 1.02, 103),
    stops,
    services,
    arrivalsByStop: new Map([
      ["A", [{ key: "nus:S", arrivals: [arrival(3), arrival(10)] }]]
    ]),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.selectedArrival.minutes, 3);
  assert.equal(busLeg.catchStatus, "tight");
});

test("prioritizes a plausible tight first bus over a later easier boarding", async () => {
  const close = stop("CLOSE", 1, 103, [{ key: "nus:LATE", source: "nus", name: "LATE" }]);
  const hurry = stop("HURRY", 1.0012, 103, [{ key: "nus:TIGHT", source: "nus", name: "TIGHT" }]);
  const end = stop("END", 1.005, 103, [
    { key: "nus:LATE", source: "nus", name: "LATE" },
    { key: "nus:TIGHT", source: "nus", name: "TIGHT" }
  ]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.005, 103),
    stops: [close, hurry, end],
    services: [
      service("LATE", [close, end]),
      service("TIGHT", [hurry, end])
    ],
    arrivalsByStop: new Map([
      ["CLOSE", [{ key: "nus:LATE", arrivals: [arrival(10)] }]],
      ["HURRY", [{ key: "nus:TIGHT", arrivals: [arrival(1)] }]]
    ]),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.routeCode, "TIGHT");
  assert.equal(busLeg.selectedArrival.minutes, 1);
  assert.equal(busLeg.catchStatus, "tight");
});

test("prioritizes the faster arrival when walking and transfers are comparable", async () => {
  const start = stop("START", 1, 103, [
    { key: "nus:R2", source: "nus", name: "R2" },
    { key: "nus:D1", source: "nus", name: "D1" }
  ]);
  const end = stop("END", 1.01, 103, [
    { key: "nus:R2", source: "nus", name: "R2" },
    { key: "nus:D1", source: "nus", name: "D1" }
  ]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.01, 103),
    stops: [start, end],
    services: [
      service("R2", [start, end], {
        route: {
          path: [
            pathPoint(1, 103, "START"),
            pathPoint(1.006, 103),
            pathPoint(1.01, 103, "END")
          ]
        }
      }),
      service("D1", [start, end], {
        route: {
          path: [
            pathPoint(1, 103, "START"),
            pathPoint(1.012, 103),
            pathPoint(1.01, 103, "END")
          ]
        }
      })
    ],
    arrivalsByStop: new Map([
      ["START", [
        { key: "nus:R2", arrivals: [arrival(9)] },
        { key: "nus:D1", arrivals: [arrival(6)] }
      ]]
    ]),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.routeCode, "D1");
  assert.equal(busLeg.selectedArrival.minutes, 6);
});

test("sorts bus routes without live timings below timed bus routes", async () => {
  const start = stop("START", 1, 103, [
    { key: "nus:LIVE", source: "nus", name: "LIVE" },
    { key: "nus:QUIET", source: "nus", name: "QUIET" }
  ]);
  const end = stop("END", 1.01, 103, [
    { key: "nus:LIVE", source: "nus", name: "LIVE" },
    { key: "nus:QUIET", source: "nus", name: "QUIET" }
  ]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.01, 103),
    stops: [start, end],
    services: [
      service("LIVE", [start, end]),
      service("QUIET", [start, end])
    ],
    arrivalsByStop: new Map([
      ["START", [
        { key: "nus:LIVE", arrivals: [arrival(8)] },
        { key: "nus:QUIET", arrivals: [] }
      ]]
    ]),
    options: { ...defaultOptions, defaultWaitSeconds: 0 }
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.routeCode, "LIVE");
  assert.equal(result.hasBusTiming, true);
  assert.ok(result.alternatives?.some((plan) => {
    const alternativeBusLeg = plan.legs.find((leg) => leg.type === "bus");
    return alternativeBusLeg?.routeCode === "QUIET" && plan.hasBusTiming === false;
  }));
});

test("filters transfer alternatives unless they save meaningful time", async () => {
  const start = stop("START", 1, 103, [
    { key: "nus:DIRECT", source: "nus", name: "DIRECT" },
    { key: "nus:FIRST", source: "nus", name: "FIRST" }
  ]);
  const middle = stop("MIDDLE", 1.005, 103, [
    { key: "nus:FIRST", source: "nus", name: "FIRST" },
    { key: "nus:SECOND", source: "nus", name: "SECOND" }
  ]);
  const end = stop("END", 1.01, 103, [
    { key: "nus:DIRECT", source: "nus", name: "DIRECT" },
    { key: "nus:SECOND", source: "nus", name: "SECOND" }
  ]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.01, 103),
    stops: [start, middle, end],
    services: [
      service("DIRECT", [start, end]),
      service("FIRST", [start, middle]),
      service("SECOND", [middle, end])
    ],
    arrivalsByStop: new Map([
      ["START", [
        { key: "nus:DIRECT", arrivals: [arrival(3)] },
        { key: "nus:FIRST", arrivals: [arrival(0)] }
      ]],
      ["MIDDLE", [{ key: "nus:SECOND", arrivals: [arrival(0)] }]]
    ]),
    options: defaultOptions
  });

  assert.equal(result.transfers, 0);
  assert.ok(!result.alternatives?.some((plan) => plan.transfers > 0));
});

test("filters transfer routes that walk back to an already used bus stop", async () => {
  const start = stop("START", 1, 103, [
    { key: "nus:DIRECT", source: "nus", name: "DIRECT" },
    { key: "nus:OUT", source: "nus", name: "OUT" },
    { key: "nus:CONTINUE", source: "nus", name: "CONTINUE" }
  ]);
  const away = stop("AWAY", 1.002, 103, [{ key: "nus:OUT", source: "nus", name: "OUT" }]);
  const end = stop("END", 1.01, 103, [
    { key: "nus:DIRECT", source: "nus", name: "DIRECT" },
    { key: "nus:CONTINUE", source: "nus", name: "CONTINUE" }
  ]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.01, 103),
    stops: [start, away, end],
    services: [
      service("DIRECT", [start, end]),
      service("OUT", [start, away]),
      service("CONTINUE", [start, end])
    ],
    arrivalsByStop: new Map([
      ["START", [
        { key: "nus:DIRECT", arrivals: [arrival(10)] },
        { key: "nus:OUT", arrivals: [arrival(0)] },
        { key: "nus:CONTINUE", arrivals: [arrival(0)] }
      ]]
    ]),
    options: { ...defaultOptions, transferWalkRadiusKm: 0.3 }
  });

  assert.ok(!result.alternatives?.some((plan) => {
    const walkedBackToStart = plan.legs.some((leg) => leg.type === "walk" && leg.to.id === "START");
    return plan.transfers > 0 && walkedBackToStart;
  }));
});

test("uses default wait when live arrivals are unavailable", async () => {
  const stops = [stop("A", 1, 103), stop("B", 1.02, 103)];
  const services = [service("S", [stops[0], stops[1]])];
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.02, 103),
    stops,
    services,
    arrivalsByStop: new Map(),
    options: { ...defaultOptions, defaultWaitSeconds: 420 }
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.waitSeconds, 420);
  assert.equal(busLeg.selectedArrival, null);
});

test("walks to an opposite stop when that is the routable choice", async () => {
  const near = stop("NEAR", 1, 103, []);
  const opposite = stop("OPP", 1.0015, 103);
  const end = stop("END", 1.02, 103);
  const result = await planDirections({
    fromItem: place("Start", 1.0001, 103),
    toItem: place("End", 1.02, 103),
    stops: [near, opposite, end],
    services: [service("S", [opposite, end])],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.fromStop.id, "OPP");
});

test("boards at the nearer downstream candidate instead of walking upstream on the same route", async () => {
  const upstream = stop("UPSTREAM", 0.997, 103);
  const near = stop("NEAR", 1, 103);
  const end = stop("END", 1.03, 103);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.03, 103),
    stops: [upstream, near, end],
    services: [service("S", [upstream, near, end])],
    arrivalsByStop: new Map([
      ["UPSTREAM", [{ key: "nus:S", arrivals: [arrival(0)] }]]
    ]),
    options: { ...defaultOptions, defaultWaitSeconds: 600 }
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.fromStop.id, "NEAR");
  assert.ok(!result.alternatives?.some((plan) => {
    const alternativeBusLeg = plan.legs.find((leg) => leg.type === "bus");
    return alternativeBusLeg?.fromStop.id === "UPSTREAM";
  }));
});

test("does not prefer a regressive first bus just because it arrives sooner", async () => {
  const close = stop("CLOSE", 1, 103, [{ key: "nus:A1", source: "nus", name: "A1" }]);
  const slightWalk = stop("SLIGHT_WALK", 1.0006, 103, [{ key: "nus:D1", source: "nus", name: "D1" }]);
  const farExit = stop("FAR_EXIT", 1.006, 103, [{ key: "nus:D1", source: "nus", name: "D1" }]);
  const closeExit = stop("CLOSE_EXIT", 1.009, 103, [{ key: "nus:A1", source: "nus", name: "A1" }]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.01, 103),
    stops: [close, slightWalk, farExit, closeExit],
    services: [
      service("A1", [close, closeExit]),
      service("D1", [slightWalk, farExit])
    ],
    arrivalsByStop: new Map([
      ["CLOSE", [{ key: "nus:A1", arrivals: [arrival(14)] }]],
      ["SLIGHT_WALK", [{ key: "nus:D1", arrivals: [arrival(4)] }]]
    ]),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.routeCode, "A1");
  assert.equal(busLeg.fromStop.id, "CLOSE");
  assert.equal(busLeg.waitSeconds, 14 * 60);
  assert.ok(result.totalSeconds > result.scoreSeconds);
});

test("continues same-service route segments without a transfer or second wait", async () => {
  const first = stop("FIRST", 1, 103, [{ key: "nus:D1", source: "nus", name: "D1" }]);
  const middle = stop("MIDDLE", 1.01, 103, [{ key: "nus:D1", source: "nus", name: "D1" }]);
  const last = stop("LAST", 1.02, 103, [{ key: "nus:D1", source: "nus", name: "D1" }]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.02, 103),
    stops: [first, middle, last],
    services: [
      service("D1", [first, middle]),
      service("D1", [middle, last])
    ],
    arrivalsByStop: new Map([
      ["FIRST", [{ key: "nus:D1", arrivals: [arrival(5)] }]],
      ["MIDDLE", [{ key: "nus:D1", arrivals: [arrival(6)] }]]
    ]),
    options: defaultOptions
  });

  const busLegs = result.legs.filter((leg) => leg.type === "bus");
  assert.equal(busLegs.length, 1);
  assert.equal(result.transfers, 0);
  assert.equal(busLegs[0].fromStop.id, "FIRST");
  assert.equal(busLegs[0].toStop.id, "LAST");
  assert.equal(busLegs[0].waitSeconds, 5 * 60);
  assert.equal(busLegs[0].selectedArrival.minutes, 5);
});

test("chooses direct walking for short trips", async () => {
  const stops = [stop("A", 1, 103), stop("B", 1.02, 103)];
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.0004, 103),
    stops,
    services: [service("S", stops)],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  assert.equal(result.legs.filter((leg) => leg.type === "bus").length, 0);
  assert.equal(result.legs[0].type, "walk");
});

test("does not show bus alternatives when total bus-route walking is longer than direct walking", async () => {
  const closeBoarding = stop("BOARD", 1.0005, 103);
  const farAlighting = stop("ALIGHT", 1.002, 103);
  const destinationStop = stop("DEST", 1.001, 103);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("Nearby", 1.001, 103),
    stops: [closeBoarding, farAlighting, destinationStop],
    services: [service("S", [closeBoarding, farAlighting])],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  assert.equal(result.legs.length, 1);
  assert.equal(result.legs[0].type, "walk");
  assert.equal(result.alternatives, undefined);
});

test("keeps a no-transfer route primary while still surfacing a much faster transfer alternative", async () => {
  const a = stop("A", 1, 103);
  const b = stop("B", 1.01, 103);
  const d = stop("D", 1.02, 103);
  // The detour keeps SLOW meaningfully slower than the transfer pair without
  // being so slow that walking partway and boarding mid-route beats it.
  const slow = service("SLOW", [a, d], {
    route: {
      path: [
        pathPoint(1, 103, "A"),
        pathPoint(1, 103.025),
        pathPoint(1.02, 103.025),
        pathPoint(1.02, 103, "D")
      ]
    }
  });
  const fastOne = service("F1", [a, b]);
  const fastTwo = service("F2", [b, d]);

  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.02, 103),
    stops: [a, b, d],
    services: [slow, fastOne, fastTwo],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  assert.deepEqual(result.legs.filter((leg) => leg.type === "bus").map((leg) => leg.routeCode), ["SLOW"]);
  assert.ok(result.alternatives?.some((plan) => {
    return JSON.stringify(plan.legs.filter((leg) => leg.type === "bus").map((leg) => leg.routeCode)) === JSON.stringify(["F1", "F2"]);
  }));
});

test("lists slower overlapping bus services as alternatives", async () => {
  const a = stop("A", 1, 103);
  const b = stop("B", 1.02, 103);
  const fast = service("FAST", [a, b]);
  const slow = service("SLOW", [a, b], {
    route: {
      path: [
        pathPoint(1, 103, "A"),
        pathPoint(1, 103.04),
        pathPoint(1.02, 103.04),
        pathPoint(1.02, 103, "B")
      ]
    }
  });
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.02, 103),
    stops: [a, b],
    services: [fast, slow],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  assert.equal(result.legs.find((leg) => leg.type === "bus").routeCode, "FAST");
  assert.ok(result.alternatives?.some((plan) => plan.legs.some((leg) => leg.type === "bus" && leg.routeCode === "SLOW")));
});

test("does not let a small walking advantage outrank a dramatically faster route", async () => {
  const nearStop = stop("NEAR", 1.0001, 103, [{ key: "nus:SLOW", source: "nus", name: "SLOW" }]);
  const farStop = stop("FAR", 1.003, 103, [{ key: "nus:FAST", source: "nus", name: "FAST" }]);
  const endStop = stop("END", 1.02, 103, [
    { key: "nus:SLOW", source: "nus", name: "SLOW" },
    { key: "nus:FAST", source: "nus", name: "FAST" }
  ]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.02, 103),
    stops: [nearStop, farStop, endStop],
    services: [
      // ~20 km of route geometry makes SLOW take far longer than FAST.
      service("SLOW", [nearStop, endStop], {
        route: {
          path: [
            pathPoint(1.0001, 103, "NEAR"),
            pathPoint(1.0001, 103.09),
            pathPoint(1.02, 103.09),
            pathPoint(1.02, 103, "END")
          ]
        }
      }),
      service("FAST", [farStop, endStop])
    ],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.routeCode, "FAST");
  assert.ok(result.alternatives?.some((plan) => {
    return plan.legs.some((leg) => leg.type === "bus" && leg.routeCode === "SLOW");
  }));
});

test("still prefers meaningfully less walking when only slightly slower", async () => {
  const nearStop = stop("NEAR", 1.0001, 103, [{ key: "nus:NEARBUS", source: "nus", name: "NEARBUS" }]);
  const farStop = stop("FAR", 1.003, 103, [{ key: "nus:FARBUS", source: "nus", name: "FARBUS" }]);
  const endStop = stop("END", 1.02, 103, [
    { key: "nus:NEARBUS", source: "nus", name: "NEARBUS" },
    { key: "nus:FARBUS", source: "nus", name: "FARBUS" }
  ]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.02, 103),
    stops: [nearStop, farStop, endStop],
    services: [
      // ~6.5 km of route geometry: a few minutes slower than FARBUS, but the
      // boarding stop is right next to the start.
      service("NEARBUS", [nearStop, endStop], {
        route: {
          path: [
            pathPoint(1.0001, 103, "NEAR"),
            pathPoint(1.0001, 103.02),
            pathPoint(1.02, 103.02),
            pathPoint(1.02, 103, "END")
          ]
        }
      }),
      service("FARBUS", [farStop, endStop])
    ],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.routeCode, "NEARBUS");
});

test("keeps the transfer penalty out of displayed leg and total durations", async () => {
  const start = stop("START", 1, 103, [{ key: "nus:FIRST", source: "nus", name: "FIRST" }]);
  const middle = stop("MIDDLE", 1.01, 103, [
    { key: "nus:FIRST", source: "nus", name: "FIRST" },
    { key: "nus:SECOND", source: "nus", name: "SECOND" }
  ]);
  const end = stop("END", 1.03, 103, [{ key: "nus:SECOND", source: "nus", name: "SECOND" }]);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.03, 103),
    stops: [start, middle, end],
    services: [
      service("FIRST", [start, middle]),
      service("SECOND", [middle, end])
    ],
    arrivalsByStop: new Map(),
    options: { ...defaultOptions, transferPenaltySeconds: 120, maxTransfers: 1, transferAlternativeMinimumSavingsSeconds: 0 }
  });

  const transferPlan = [result, ...(result.alternatives || [])]
    .find((plan) => (plan.transfers || 0) === 1);
  assert.ok(transferPlan, "expected a one-transfer plan");
  for (const leg of transferPlan.legs.filter((item) => item.type === "bus")) {
    assert.equal(leg.durationSeconds, leg.waitSeconds + leg.rideSeconds);
  }
  const legSeconds = transferPlan.legs.reduce((total, leg) => total + leg.durationSeconds, 0);
  assert.ok(Math.abs(transferPlan.totalSeconds - legSeconds) < 1);
});

test("falls back to stop distance when route path geometry is missing", async () => {
  const a = stop("A", 1, 103);
  const b = stop("B", 1.01, 103);
  const result = await planDirections({
    fromItem: place("Start", 1, 103),
    toItem: place("End", 1.01, 103),
    stops: [a, b],
    services: [service("S", [a, b], { route: { path: [] } })],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.ok(busLeg.rideSeconds > 0);
});

test("handles loop routes with duplicated stop occurrences", async () => {
  const a = stop("A", 1, 103);
  const b = stop("B", 1.01, 103);
  const result = await planDirections({
    fromItem: place("Start", 1.01, 103),
    toItem: place("End", 1, 103),
    stops: [a, b],
    services: [service("LOOP", [a, b, a])],
    arrivalsByStop: new Map(),
    options: defaultOptions
  });

  const busLeg = result.legs.find((leg) => leg.type === "bus");
  assert.equal(busLeg.fromStop.id, "B");
  assert.equal(busLeg.toStop.id, "A");
});

function stop(id, latitude, longitude, services = [{ key: "nus:S", source: "nus", name: "S" }]) {
  return {
    id,
    title: id,
    shortLabel: id,
    coordinates: { latitude, longitude },
    sourceModes: { nus: true },
    services
  };
}

function place(title, latitude, longitude) {
  return {
    id: `place:${title}`,
    type: "venue",
    title,
    coordinates: { latitude, longitude }
  };
}

function service(code, stops, overrides = {}) {
  const route = {
    code,
    stops: stops.map((item, index) => ({
      sequence: index + 1,
      id: item.id,
      code: item.id,
      name: item.title,
      shortName: item.shortLabel,
      coordinates: item.coordinates,
      rawCode: item.id
    })),
    path: stops.map((item) => pathPoint(item.coordinates.latitude, item.coordinates.longitude, item.id)),
    ...(overrides.route || {})
  };

  return {
    key: `nus:${code}`,
    name: code,
    source: "nus",
    ...overrides,
    route
  };
}

function pathPoint(latitude, longitude, stopCode = null) {
  return {
    latitude,
    longitude,
    isStop: Boolean(stopCode),
    stopCode
  };
}

function arrival(minutes) {
  return {
    minutes,
    display: `${minutes} min`
  };
}
