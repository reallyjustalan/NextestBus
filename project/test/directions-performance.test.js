import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { compileRoutingNetwork, planDirections } from "../public/directions-planner.js";

const topology = JSON.parse(
  await readFile(new URL("../public/data/routing-topology.json", import.meta.url), "utf8")
);

test("the committed routing topology is complete and excludes live vehicle data", () => {
  assert.equal(topology.stopCount, topology.stops.length);
  assert.equal(topology.serviceCount, topology.services.length);
  assert.ok(topology.stops.length >= 30);
  assert.ok(topology.services.length >= 8);
  assert.ok(topology.services.every((service) => service.route.stops.length > 1));
  assert.ok(topology.services.reduce((total, service) => total + service.route.path.length, 0) > 4_000);
  assert.ok(topology.services.every((service) => !service.route.vehicles && !service.arrivals));
});

test("full-size cached direction searches stay below the interactive budget", async () => {
  const network = compileRoutingNetwork(topology.stops, topology.services);
  const fromItem = topology.stops.find((stop) => stop.id === "COM3") || topology.stops[0];
  const toItem = topology.stops.find((stop) => stop.id === "UTOWN") || topology.stops.at(-1);
  const durations = [];

  for (let index = 0; index < 12; index += 1) {
    const startedAt = performance.now();
    const result = await planDirections({
      fromItem,
      toItem,
      stops: topology.stops,
      services: topology.services,
      compiledNetwork: network,
      arrivalsByStop: new Map(),
      departureTime: "2026-08-12T12:00:00+08:00"
    });
    durations.push(performance.now() - startedAt);
    assert.ok(result.legs.length > 0);
  }

  durations.sort((left, right) => left - right);
  const p95 = durations[Math.floor((durations.length - 1) * 0.95)];
  assert.ok(p95 < 100, `expected p95 under 100ms, measured ${p95.toFixed(1)}ms`);
});
