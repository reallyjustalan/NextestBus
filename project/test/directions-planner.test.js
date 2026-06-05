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

test("selects the next catchable bus after walking to the stop", async () => {
  const stops = [stop("A", 1, 103), stop("B", 1.02, 103)];
  const services = [service("S", [stops[0], stops[1]])];
  const result = await planDirections({
    fromItem: place("Start", 1.003, 103),
    toItem: place("End", 1.02, 103),
    stops,
    services,
    arrivalsByStop: new Map([
      ["A", [{ key: "nus:S", arrivals: [arrival(3), arrival(10)] }]]
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
  assert.ok(result.alternatives?.some((plan) => plan.legs.some((leg) => leg.type === "bus")));
});

test("can prefer a faster transfer over a long single route", async () => {
  const a = stop("A", 1, 103);
  const b = stop("B", 1.01, 103);
  const d = stop("D", 1.02, 103);
  const slow = service("SLOW", [a, d], {
    route: {
      path: [
        pathPoint(1, 103, "A"),
        pathPoint(1, 103.08),
        pathPoint(1.02, 103.08),
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

  assert.deepEqual(result.legs.filter((leg) => leg.type === "bus").map((leg) => leg.routeCode), ["F1", "F2"]);
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
