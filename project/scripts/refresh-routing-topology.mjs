import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NUSBUS_API_BASE = "https://api.nusbus.com/api";
export const DEFAULT_ROUTING_TOPOLOGY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/data/routing-topology.json"
);

const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 3;

function isNusService(service) {
  return service?.source === "nus" || String(service?.key || service?.id || "").startsWith("nus:");
}

function compactStop(stop) {
  return {
    id: stop.id,
    title: stop.title || stop.name || stop.shortName || stop.id,
    subtitle: stop.subtitle || "",
    shortLabel: stop.shortLabel || stop.shortName || stop.name || stop.title || stop.id,
    busStopCode: stop.busStopCode || stop.code || null,
    coordinates: stop.coordinates,
    sourceModes: stop.sourceModes || { nus: true, lta: false },
    services: (stop.services || [])
      .filter(isNusService)
      .map((service) => ({
        key: service.key,
        name: service.name,
        source: service.source || "nus",
        color: service.color
      }))
  };
}

function compactRouteStop(stop) {
  return {
    sequence: stop.sequence,
    id: stop.id || stop.rawId || stop.code || stop.name,
    code: stop.code,
    name: stop.name || stop.title || stop.shortName || stop.id,
    shortName: stop.shortName || stop.shortLabel || stop.name || stop.title || stop.id,
    coordinates: stop.coordinates,
    rawId: stop.rawId,
    rawCode: stop.rawCode
  };
}

function compactPathPoint(point) {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    isStop: point.isStop === true,
    stopCode: point.stopCode || undefined
  };
}

export function compactRoutingService(service) {
  const route = service.route || {};
  return {
    id: service.id || service.key,
    key: service.key || service.id,
    name: service.name || route.code,
    source: service.source || "nus",
    color: service.color,
    description: service.description || "Campus shuttle service",
    stopCount: service.stopCount || route.stops?.length || service.stops?.length || 0,
    route: {
      code: route.code || service.name,
      destination: route.destination || "",
      schedule: route.schedule || null,
      stops: (route.stops || service.stops || []).map(compactRouteStop),
      path: (route.path || []).map(compactPathPoint)
    }
  };
}

export function buildRoutingTopology(stopsPayload, servicePayloads, generatedAt = new Date().toISOString()) {
  const stops = (stopsPayload?.stops || [])
    .filter((stop) => stop.sourceModes?.nus || (stop.services || []).some(isNusService))
    .map(compactStop);
  const services = servicePayloads
    .map((payload) => payload?.service || payload)
    .filter((service) => service && isNusService(service))
    .map(compactRoutingService)
    .filter((service) => service.key && service.route.stops.length > 1)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

  if (!stops.length) throw new Error("The NUSBus API returned no routable NUS stops.");
  if (!services.length) throw new Error("The NUSBus API returned no routable NUS services.");

  return {
    generatedAt,
    source: NUSBUS_API_BASE,
    updatedAt: stopsPayload.updatedAt || generatedAt,
    note: "Static routing topology generated from NUSBus. Live arrivals and vehicle data are deliberately excluded.",
    stopCount: stops.length,
    serviceCount: services.length,
    stops,
    services
  };
}

async function fetchJsonWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`${url} failed with ${response.status}.`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_ATTEMPTS) await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 250));
    }
  }
  throw lastError;
}

export async function refreshRoutingTopology(outputPath = DEFAULT_ROUTING_TOPOLOGY_PATH) {
  const [stopsPayload, servicesPayload] = await Promise.all([
    fetchJsonWithRetry(`${NUSBUS_API_BASE}/stops`),
    fetchJsonWithRetry(`${NUSBUS_API_BASE}/services`)
  ]);
  const serviceKeys = (servicesPayload.services || []).filter(isNusService).map((service) => service.key);
  const servicePayloads = await Promise.all(
    serviceKeys.map((serviceKey) => fetchJsonWithRetry(`${NUSBUS_API_BASE}/services/${encodeURIComponent(serviceKey)}`))
  );
  const topology = buildRoutingTopology(stopsPayload, servicePayloads);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(topology, null, 2)}\n`, "utf8");
  return topology;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  refreshRoutingTopology()
    .then((topology) => {
      console.log(
        `Saved ${topology.serviceCount} services and ${topology.stopCount} stops to ${DEFAULT_ROUTING_TOPOLOGY_PATH}`
      );
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
