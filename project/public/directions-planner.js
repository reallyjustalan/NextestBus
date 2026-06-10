export const DIRECTIONS_PLANNER_DEFAULTS = {
  walkingSpeedKmh: 4.8,
  walkingDistanceFactor: 1.25,
  busSpeedKmh: 16,
  roadDistanceFactor: 1.35,
  dwellSeconds: 15,
  defaultWaitSeconds: 300,
  transferPenaltySeconds: 90,
  boardingBufferSeconds: 30,
  catchGraceSeconds: 180,
  tightFirstBusPrioritySeconds: 180,
  soonFirstBusPrioritySeconds: 90,
  soonFirstBusWindowSeconds: 180,
  walkingDifferencePriorityKm: 0.2,
  walkingPriorityMaxSlowerSeconds: 600,
  maxTransfers: 1,
  transferAlternativeMinimumSavingsSeconds: 300,
  sameLocationThresholdKm: 0.01,
  directWalkAccessToleranceKm: 0.01,
  accessRadiusKm: 0.45,
  minCandidateStops: 3,
  candidateStopLimit: 6,
  transferWalkRadiusKm: 0.25,
  fallbackSegmentSeconds: 90,
  maxAlternativePlans: 3,
  downstreamBoardingToleranceKm: 0.01,
  firstBusWaitCostMultiplier: 0,
  waitCostMultiplier: 1
};

const DESTINATION_NODE = "destination";
const ORIGIN_NODE = "origin";

export function estimateWalkingTime(distanceKm, options = {}) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...options };
  if (!Number.isFinite(distanceKm)) return Number.POSITIVE_INFINITY;
  return (distanceKm * settings.walkingDistanceFactor) / settings.walkingSpeedKmh * 3600;
}

export async function planDirections(input) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...(input.options || {}) };
  const stops = (input.stops || []).filter((stop) => isNusStop(stop) && coordinatesFor(stop));
  const fromCoords = coordinatesFor(input.fromItem);
  const toCoords = coordinatesFor(input.toItem);

  if (!input.fromItem || !input.toItem) throw new Error("Select both a start and an end point from the suggestions.");
  if (!fromCoords) throw new Error(`No map location is available for ${input.fromItem.title}.`);
  if (!toCoords) throw new Error(`No map location is available for ${input.toItem.title}.`);
  if (isSameLocation(input.fromItem, input.toItem, fromCoords, toCoords, settings)) {
    return alreadyTherePlan(input.fromItem, input.toItem);
  }
  if (!stops.length) throw new Error("No NUS shuttle stops are available for routing.");

  const originCandidates = candidateStopsForPoint(fromCoords, stops, settings);
  const destinationCandidates = candidateStopsForPoint(toCoords, stops, settings);
  if (!originCandidates.length) throw new Error(`No nearby bus stop location is available for ${input.fromItem.title}.`);
  if (!destinationCandidates.length) throw new Error(`No nearby bus stop location is available for ${input.toItem.title}.`);

  const arrivalsByStop = await arrivalsForOriginCandidates(originCandidates, input);
  const services = normalizeServices(input.services || []);

  const graph = buildRoutingGraph(stops, services, destinationCandidates, settings);
  const context = {
    fromItem: input.fromItem,
    toItem: input.toItem,
    fromCoords,
    toCoords,
    originCandidates,
    originCandidateDistanceByStopId: new Map(originCandidates.map((entry) => [entry.stop.id, entry.distanceKm])),
    destinationCandidates,
    graph,
    services,
    arrivalsByStop,
    settings
  };
  const firstResult = shortestPath(context);

  if (!firstResult) throw new Error("No NUS shuttle route found between these locations.");
  const rankedPlans = practicalPlans(uniquePlans([firstResult, ...busAlternativePlans(context)]), settings)
    .sort((left, right) => comparePlans(left, right, settings));
  const result = rankedPlans[0];
  const alternatives = rankedPlans
    .filter((plan) => !samePlan(result, plan))
    .slice(0, settings.maxAlternativePlans);
  if (alternatives.length) result.alternatives = alternatives;
  return result;
}

export function candidateStopsForPoint(point, stops, options = {}) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...options };
  const entries = stops
    .map((stop) => {
      const coords = coordinatesFor(stop);
      return {
        stop,
        distanceKm: coords ? haversine(point, coords) : Number.POSITIVE_INFINITY
      };
    })
    .filter((entry) => Number.isFinite(entry.distanceKm))
    .sort((left, right) => {
      if (left.distanceKm !== right.distanceKm) return left.distanceKm - right.distanceKm;
      return stopLabel(left.stop).localeCompare(stopLabel(right.stop), undefined, { numeric: true });
    });

  const withinRadius = entries.filter((entry) => entry.distanceKm <= settings.accessRadiusKm);
  const minimum = entries.slice(0, settings.minCandidateStops);
  return uniqueStopEntries([...withinRadius, ...minimum]).slice(0, settings.candidateStopLimit);
}

function buildRoutingGraph(stops, services, destinationCandidates, settings) {
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  const destinationByStopId = new Map(destinationCandidates.map((entry) => [entry.stop.id, entry]));
  const transferWalksByStop = stopTransferWalks(stops, settings);
  const serviceOccurrencesByStop = new Map();

  for (const service of services) {
    for (let index = 0; index < service.stops.length; index += 1) {
      const stop = service.stops[index];
      const stopId = stop.id;
      if (!stopId || !stopsById.has(stopId)) continue;
      if (!serviceOccurrencesByStop.has(stopId)) serviceOccurrencesByStop.set(stopId, []);
      serviceOccurrencesByStop.get(stopId).push({ service, index });
    }
  }

  return {
    stopsById,
    destinationByStopId,
    transferWalksByStop,
    serviceOccurrencesByStop
  };
}

function shortestPath(context, options = {}) {
  const queue = new MinQueue();
  const best = new Map();
  const previous = new Map();
  const searchContext = {
    ...context,
    requireBus: options.requireBus === true,
    requiredFirstServiceKey: options.requiredFirstServiceKey || ""
  };

  best.set(ORIGIN_NODE, { costSeconds: 0, elapsedSeconds: 0 });
  queue.push(ORIGIN_NODE, 0);

  while (queue.size) {
    const { key, priority } = queue.pop();
    const current = best.get(key);
    if (!current || priority !== current.costSeconds) continue;

    if (key === DESTINATION_NODE) {
      return resultFromPath(previous, searchContext, current.elapsedSeconds, current.costSeconds);
    }

    for (const edge of edgesForState(key, current.elapsedSeconds, searchContext)) {
      const nextElapsedSeconds = current.elapsedSeconds + edge.durationSeconds;
      const nextCostSeconds = current.costSeconds + edge.costSeconds;
      const previousBest = best.get(edge.toKey);
      if (previousBest && nextCostSeconds >= previousBest.costSeconds) continue;
      best.set(edge.toKey, { costSeconds: nextCostSeconds, elapsedSeconds: nextElapsedSeconds });
      previous.set(edge.toKey, { fromKey: key, edge });
      queue.push(edge.toKey, nextCostSeconds);
    }
  }

  return null;
}

function edgesForState(key, elapsedSeconds, context) {
  if (key === ORIGIN_NODE) return originEdges(context);
  if (key === DESTINATION_NODE) return [];

  const state = parseStateKey(key);
  const stop = context.graph.stopsById.get(state.stopId);
  if (!stop) return [];

  return [
    ...destinationEdges(stop, state, context),
    ...transferWalkEdges(stop, state, context),
    ...busEdges(stop, state, elapsedSeconds, context)
  ];
}

function originEdges(context) {
  const directDistanceKm = haversine(context.fromCoords, context.toCoords);
  return [
    context.requireBus ? null : {
      toKey: DESTINATION_NODE,
      durationSeconds: estimateWalkingTime(directDistanceKm, context.settings),
      costSeconds: estimateWalkingTime(directDistanceKm, context.settings),
      leg: walkLeg(context.fromItem, context.toItem, directDistanceKm, context.settings)
    },
    ...context.originCandidates.map((entry) => ({
      toKey: stateKey(entry.stop.id, "", false, ""),
      durationSeconds: estimateWalkingTime(entry.distanceKm, context.settings),
      costSeconds: estimateWalkingTime(entry.distanceKm, context.settings),
      leg: walkLeg(context.fromItem, entry.stop, entry.distanceKm, context.settings)
    }))
  ].filter(Boolean);
}

function destinationEdges(stop, state, context) {
  if (context.requireBus && !state.hasBus) return [];
  const destinationEntry = context.graph.destinationByStopId.get(stop.id);
  if (!destinationEntry) return [];

  return [{
    toKey: DESTINATION_NODE,
    durationSeconds: estimateWalkingTime(destinationEntry.distanceKm, context.settings),
    costSeconds: estimateWalkingTime(destinationEntry.distanceKm, context.settings),
    leg: walkLeg(stop, context.toItem, destinationEntry.distanceKm, context.settings)
  }];
}

function transferWalkEdges(stop, state, context) {
  return (context.graph.transferWalksByStop.get(stop.id) || []).map((entry) => ({
    toKey: stateKey(entry.stop.id, state.lastServiceKey, state.hasBus, ""),
    durationSeconds: estimateWalkingTime(entry.distanceKm, context.settings),
    costSeconds: estimateWalkingTime(entry.distanceKm, context.settings),
    leg: walkLeg(stop, entry.stop, entry.distanceKm, context.settings)
  }));
}

function busEdges(stop, state, elapsedSeconds, context) {
  const occurrences = context.graph.serviceOccurrencesByStop.get(stop.id) || [];
  const edges = [];

  for (const occurrence of occurrences) {
    const { service, index } = occurrence;
    if (!state.hasBus && context.requiredFirstServiceKey && service.key !== context.requiredFirstServiceKey) continue;
    const isSameTripContinuation = state.continuationServiceKey === service.key;
    const wait = isSameTripContinuation
      ? noWaitForServiceContinuation()
      : waitForServiceAtStop(stop.id, service.key, elapsedSeconds, context.arrivalsByStop, context.settings);
    const transferPenaltySeconds = state.lastServiceKey && state.lastServiceKey !== service.key ? context.settings.transferPenaltySeconds : 0;

    for (let nextIndex = index + 1; nextIndex < service.stops.length; nextIndex += 1) {
      const toStop = service.stops[nextIndex];
      if (!toStop?.id || !context.graph.stopsById.has(toStop.id)) continue;
      if (!state.hasBus && hasCloserDownstreamBoardingCandidate(service, index, nextIndex, stop.id, context)) continue;
      const rideSeconds = rideSecondsBetween(service, index, nextIndex, context.settings);
      if (!Number.isFinite(rideSeconds) || rideSeconds <= 0) continue;
      const stops = service.stops.slice(index, nextIndex + 1);
      const durationSeconds = wait.waitSeconds + transferPenaltySeconds + rideSeconds;
      const waitCostSeconds = wait.waitSeconds * (state.hasBus ? context.settings.waitCostMultiplier : context.settings.firstBusWaitCostMultiplier);
      const prioritySeconds = firstBusDeparturePrioritySeconds(wait, state, context.settings);
      const costSeconds = Math.max(0, waitCostSeconds + transferPenaltySeconds + rideSeconds - prioritySeconds);
      edges.push({
        toKey: stateKey(toStop.id, service.key, true, service.key),
        durationSeconds,
        costSeconds,
        leg: {
          type: "bus",
          serviceKey: service.key,
          routeCode: service.routeCode,
          fromStop: stop,
          toStop,
          stops,
          durationSeconds,
          costSeconds,
          waitSeconds: wait.waitSeconds,
          rideSeconds,
          transferPenaltySeconds,
          prioritySeconds,
          boardingArrivals: wait.boardingArrivals,
          selectedArrival: wait.selectedArrival,
          catchStatus: wait.catchStatus,
          catchGapSeconds: wait.catchGapSeconds,
          missedArrivals: wait.missedArrivals
        }
      });
    }
  }

  return edges;
}

function hasCloserDownstreamBoardingCandidate(service, startIndex, endIndex, currentStopId, context) {
  const currentDistance = context.originCandidateDistanceByStopId.get(currentStopId) ?? Number.POSITIVE_INFINITY;

  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const stopId = service.stops[index]?.id;
    const downstreamDistance = context.originCandidateDistanceByStopId.get(stopId);
    if (!Number.isFinite(downstreamDistance)) continue;
    if (downstreamDistance + context.settings.downstreamBoardingToleranceKm < currentDistance) return true;
  }

  return false;
}

function firstBusDeparturePrioritySeconds(wait, state, settings) {
  if (state.hasBus || !wait.selectedArrival) return 0;
  if (wait.catchStatus === "tight") return settings.tightFirstBusPrioritySeconds;
  if (wait.catchStatus !== "comfortable") return 0;
  if (wait.waitSeconds > settings.soonFirstBusWindowSeconds) return 0;
  return settings.soonFirstBusPrioritySeconds * (1 - wait.waitSeconds / settings.soonFirstBusWindowSeconds);
}

function resultFromPath(previous, context, totalSeconds, scoreSeconds) {
  const legs = [];
  let key = DESTINATION_NODE;

  while (key !== ORIGIN_NODE) {
    const step = previous.get(key);
    if (!step) break;
    legs.push(step.edge.leg);
    key = step.fromKey;
  }

  legs.reverse();
  const compressedLegs = compressRouteLegs(legs);
  const busLegs = compressedLegs.filter((leg) => leg.type === "bus");
  const walkingDistanceKm = compressedLegs
    .filter((leg) => leg.type === "walk")
    .reduce((total, leg) => total + leg.distanceKm, 0);

  return {
    estimated: true,
    fromItem: context.fromItem,
    toItem: context.toItem,
    fromStop: busLegs[0]?.fromStop || null,
    toStop: busLegs[busLegs.length - 1]?.toStop || null,
    totalSeconds,
    scoreSeconds,
    walkingDistanceKm,
    transfers: Math.max(0, busLegs.length - 1),
    hasBusTiming: busLegs.length ? busLegs.some(hasLiveBusTiming) : true,
    legs: compressedLegs
  };
}

function busAlternativePlans(context) {
  const plans = [];
  const serviceKeys = [...new Set(context.services.map((service) => service.key).filter(Boolean))];
  const unconstrainedBus = shortestPath(context, { requireBus: true });
  if (unconstrainedBus) plans.push(unconstrainedBus);

  for (const serviceKey of serviceKeys) {
    const plan = shortestPath(context, { requireBus: true, requiredFirstServiceKey: serviceKey });
    if (plan) plans.push(plan);
  }

  return plans;
}

export function comparePlans(left, right, options = {}) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...options };
  if (hasUntimedBusPlan(left) !== hasUntimedBusPlan(right)) return hasUntimedBusPlan(left) ? 1 : -1;
  const walkDifferenceKm = (left.walkingDistanceKm || 0) - (right.walkingDistanceKm || 0);
  const totalDifferenceSeconds = (left.totalSeconds || 0) - (right.totalSeconds || 0);
  if (Math.abs(walkDifferenceKm) >= settings.walkingDifferencePriorityKm) {
    const lessWalkingSlowerBySeconds = walkDifferenceKm < 0 ? totalDifferenceSeconds : -totalDifferenceSeconds;
    if (lessWalkingSlowerBySeconds <= settings.walkingPriorityMaxSlowerSeconds) return walkDifferenceKm;
  }
  if ((left.transfers || 0) !== (right.transfers || 0)) return (left.transfers || 0) - (right.transfers || 0);
  if (totalDifferenceSeconds) return totalDifferenceSeconds;
  return planRankingScoreSeconds(left) - planRankingScoreSeconds(right);
}

function hasUntimedBusPlan(plan) {
  return plan.legs?.some((leg) => leg.type === "bus") && !plan.hasBusTiming;
}

function hasLiveBusTiming(leg) {
  return Boolean(leg.selectedArrival) || (leg.boardingArrivals || []).some((arrival) => Number.isFinite(Number(arrival.minutes)));
}

function practicalPlans(plans, settings) {
  const sanePlans = plans.filter((plan) => isReasonablePlan(plan, settings));
  const candidates = walkOnlyPracticalPlans(sanePlans.length ? sanePlans : plans, settings);
  const noTransferPlans = candidates.filter((plan) => (plan.transfers || 0) === 0);
  if (!noTransferPlans.length) return candidates;

  const bestNoTransferSeconds = Math.min(...noTransferPlans.map((plan) => plan.totalSeconds));
  return candidates.filter((plan) => {
    if ((plan.transfers || 0) === 0) return true;
    return plan.totalSeconds + settings.transferAlternativeMinimumSavingsSeconds < bestNoTransferSeconds;
  });
}

function walkOnlyPracticalPlans(plans, settings) {
  const directWalkPlan = plans
    .filter((plan) => isDirectWalkPlan(plan))
    .sort((left, right) => left.totalSeconds - right.totalSeconds)[0];
  if (!directWalkPlan) return plans;

  const directWalkDistanceKm = directWalkPlan.walkingDistanceKm || 0;
  return plans.filter((plan) => {
    if (plan === directWalkPlan) return true;
    if (!plan.legs?.some((leg) => leg.type === "bus")) return true;
    return (plan.walkingDistanceKm || 0) + settings.directWalkAccessToleranceKm < directWalkDistanceKm;
  });
}

function isDirectWalkPlan(plan) {
  const legs = plan.legs || [];
  return legs.length === 1 && legs[0].type === "walk" && !plan.alternatives?.length;
}

function isReasonablePlan(plan, settings) {
  if ((plan.transfers || 0) > settings.maxTransfers) return false;
  return !hasTransferBacktrack(plan);
}

function hasTransferBacktrack(plan) {
  const visitedBusStops = new Set();

  for (const leg of plan.legs || []) {
    if (leg.type === "bus") {
      for (const stop of leg.stops || []) {
        if (stop?.id) visitedBusStops.add(stop.id);
      }
      continue;
    }

    if (leg.type === "walk" && visitedBusStops.has(leg.to?.id)) return true;
  }

  return false;
}

function planRankingScoreSeconds(plan) {
  // First-bus priority is already deducted from edge costs inside the search,
  // so scoreSeconds carries it; deducting it again here would double-count it.
  return plan.scoreSeconds ?? plan.totalSeconds;
}

function uniquePlans(plans) {
  const seen = new Set();
  const unique = [];
  for (const plan of plans) {
    const key = planKey(plan);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(plan);
  }
  return unique;
}

function planKey(plan) {
  return (plan.legs || []).map((leg) => {
    if (leg.type === "bus") return `bus:${leg.serviceKey}:${leg.fromStop.id}->${leg.toStop.id}`;
    return `walk:${leg.from.id}->${leg.to.id}`;
  }).join("|");
}

function samePlan(left, right) {
  const leftBus = (left.legs || []).filter((leg) => leg.type === "bus").map((leg) => `${leg.serviceKey}:${leg.fromStop.id}->${leg.toStop.id}`);
  const rightBus = (right.legs || []).filter((leg) => leg.type === "bus").map((leg) => `${leg.serviceKey}:${leg.fromStop.id}->${leg.toStop.id}`);
  if (leftBus.length !== rightBus.length) return false;
  if (!leftBus.length && !rightBus.length) return true;
  return leftBus.every((item, index) => item === rightBus[index]);
}

function compressRouteLegs(legs) {
  const compressed = [];
  for (const leg of legs) {
    const previous = compressed[compressed.length - 1];
    if (leg.type === "walk" && previous?.type === "walk") {
      compressed[compressed.length - 1] = {
        ...previous,
        to: leg.to,
        distanceKm: previous.distanceKm + leg.distanceKm,
        durationSeconds: previous.durationSeconds + leg.durationSeconds
      };
      continue;
    }
    if (leg.type === "bus" && previous?.type === "bus" && previous.serviceKey === leg.serviceKey && previous.toStop.id === leg.fromStop.id) {
      compressed[compressed.length - 1] = mergeBusLegs(previous, leg);
      continue;
    }
    compressed.push(leg);
  }
  return compressed.filter((leg) => {
    if (leg.type !== "walk") return true;
    return leg.distanceKm > 0.01 || leg.durationSeconds > 10;
  });
}

function mergeBusLegs(previous, next) {
  return {
    ...previous,
    toStop: next.toStop,
    stops: [...(previous.stops || []), ...(next.stops || []).slice(1)],
    durationSeconds: previous.durationSeconds + next.durationSeconds,
    costSeconds: (previous.costSeconds || 0) + (next.costSeconds || 0),
    waitSeconds: previous.waitSeconds + next.waitSeconds,
    rideSeconds: previous.rideSeconds + next.rideSeconds,
    transferPenaltySeconds: previous.transferPenaltySeconds + next.transferPenaltySeconds,
    missedArrivals: [...(previous.missedArrivals || []), ...(next.missedArrivals || [])]
  };
}

function noWaitForServiceContinuation() {
  return {
    waitSeconds: 0,
    boardingArrivals: [],
    selectedArrival: null,
    catchStatus: "continuing",
    missedArrivals: []
  };
}

async function arrivalsForOriginCandidates(originCandidates, input) {
  const arrivalsByStop = new Map();
  for (const [stopId, value] of mapEntries(input.arrivalsByStop)) {
    arrivalsByStop.set(stopId, normalizeArrivalServices(value));
  }

  if (typeof input.getArrivalsForStop !== "function") return arrivalsByStop;

  await Promise.allSettled(originCandidates.map(async ({ stop }) => {
    if (!stop?.id || arrivalsByStop.has(stop.id)) return;
    const data = await input.getArrivalsForStop(stop.id);
    arrivalsByStop.set(stop.id, normalizeArrivalServices(data));
  }));

  return arrivalsByStop;
}

function waitForServiceAtStop(stopId, serviceKey, elapsedSeconds, arrivalsByStop, settings) {
  const services = arrivalsByStop.get(stopId) || [];
  const service = services.find((candidate) => candidate.key === serviceKey);
  const boardingArrivals = service?.arrivals || [];
  const missedArrivals = [];
  const readySeconds = elapsedSeconds + settings.boardingBufferSeconds;

  for (const arrival of boardingArrivals) {
    const minutes = Number(arrival.minutes);
    if (!Number.isFinite(minutes)) continue;

    const arrivalSeconds = minutes * 60;
    const earlyBySeconds = readySeconds - arrivalSeconds;
    if (earlyBySeconds <= 0) {
      return {
        waitSeconds: Math.max(0, arrivalSeconds - elapsedSeconds),
        boardingArrivals,
        selectedArrival: arrival,
        catchStatus: "comfortable",
        missedArrivals
      };
    }

    if (earlyBySeconds <= settings.catchGraceSeconds) {
      return {
        waitSeconds: 0,
        boardingArrivals,
        selectedArrival: arrival,
        catchStatus: "tight",
        catchGapSeconds: earlyBySeconds,
        missedArrivals
      };
    }

    missedArrivals.push({
      ...arrival,
      missedBySeconds: earlyBySeconds
    });
  }

  return {
    waitSeconds: settings.defaultWaitSeconds,
    boardingArrivals,
    selectedArrival: null,
    catchStatus: "default",
    missedArrivals
  };
}

function normalizeServices(services) {
  return services
    .filter((service) => service && isNusService(service))
    .map((service) => {
      const stops = (service.route?.stops || service.stops || [])
        .map((routeStop) => normalizeRouteStop(routeStop))
        .filter((stop) => stop.id && coordinatesFor(stop));
      return {
        key: service.key || service.id || `nus:${service.name || service.route?.code || ""}`,
        routeCode: service.name || service.route?.code || String(service.key || "").replace(/^nus:/, ""),
        color: service.color,
        stops,
        path: (service.route?.path || []).filter(coordinatesFor),
        raw: service
      };
    })
    .filter((service) => service.key && service.stops.length > 1);
}

function normalizeRouteStop(stop) {
  return {
    ...stop,
    id: stop.id || stop.rawId || stop.code || stop.name,
    title: stop.title || stop.name || stop.shortName || stop.id,
    shortLabel: stop.shortLabel || stop.shortName || stop.name || stop.title || stop.id,
    busStopCode: stop.busStopCode || stop.code,
    coordinates: coordinatesFor(stop),
    rawCode: stop.rawCode || stop.code,
    rawId: stop.rawId || stop.id
  };
}

function rideSecondsBetween(service, startIndex, endIndex, settings) {
  let totalSeconds = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    totalSeconds += segmentRideSeconds(service, index, settings);
  }
  return totalSeconds;
}

function segmentRideSeconds(service, index, settings) {
  const fromStop = service.stops[index];
  const toStop = service.stops[index + 1];
  const pathDistanceKm = routePathDistanceKm(service, fromStop, toStop);
  if (Number.isFinite(pathDistanceKm) && pathDistanceKm > 0) {
    return pathDistanceKm / settings.busSpeedKmh * 3600 + settings.dwellSeconds;
  }

  const fromCoords = coordinatesFor(fromStop);
  const toCoords = coordinatesFor(toStop);
  if (fromCoords && toCoords) {
    return haversine(fromCoords, toCoords) * settings.roadDistanceFactor / settings.busSpeedKmh * 3600 + settings.dwellSeconds;
  }

  return settings.fallbackSegmentSeconds + settings.dwellSeconds;
}

function routePathDistanceKm(service, fromStop, toStop) {
  if (!service.path?.length) return Number.NaN;
  const fromIndex = pathStopIndex(service.path, fromStop, 0);
  if (fromIndex < 0) return Number.NaN;
  const toIndex = pathStopIndex(service.path, toStop, fromIndex + 1);
  if (toIndex <= fromIndex) return Number.NaN;

  let distanceKm = 0;
  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    distanceKm += haversine(coordinatesFor(service.path[index - 1]), coordinatesFor(service.path[index]));
  }
  return distanceKm;
}

function pathStopIndex(path, stop, startIndex) {
  const candidates = new Set([stop.rawCode, stop.code, stop.busStopCode, stop.rawId, stop.id].filter(Boolean).map(normalizeKey));
  for (let index = startIndex; index < path.length; index += 1) {
    const stopCode = path[index].stopCode;
    if (stopCode && candidates.has(normalizeKey(stopCode))) return index;
  }
  return -1;
}

function stopTransferWalks(stops, settings) {
  const walks = new Map(stops.map((stop) => [stop.id, []]));
  for (let leftIndex = 0; leftIndex < stops.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < stops.length; rightIndex += 1) {
      const left = stops[leftIndex];
      const right = stops[rightIndex];
      const distanceKm = haversine(coordinatesFor(left), coordinatesFor(right));
      if (distanceKm > settings.transferWalkRadiusKm) continue;
      walks.get(left.id).push({ stop: right, distanceKm });
      walks.get(right.id).push({ stop: left, distanceKm });
    }
  }
  return walks;
}

function walkLeg(from, to, distanceKm, settings) {
  return {
    type: "walk",
    from: compactPlace(from),
    to: compactPlace(to),
    distanceKm,
    durationSeconds: estimateWalkingTime(distanceKm, settings)
  };
}

function alreadyTherePlan(fromItem, toItem) {
  return {
    estimated: true,
    kind: "already-there",
    message: "You are already there. This may be our fastest route yet.",
    fromItem,
    toItem,
    fromStop: null,
    toStop: null,
    totalSeconds: 0,
    scoreSeconds: 0,
    walkingDistanceKm: 0,
    transfers: 0,
    hasBusTiming: true,
    legs: []
  };
}

function isSameLocation(fromItem, toItem, fromCoords, toCoords, settings) {
  if (fromItem?.id && toItem?.id && fromItem.id === toItem.id) return true;
  return haversine(fromCoords, toCoords) <= settings.sameLocationThresholdKm;
}

function compactPlace(place) {
  return {
    id: place?.id || "",
    title: stopLabel(place),
    shortLabel: place?.shortLabel || place?.shortName || place?.title || place?.name || place?.id || "",
    coordinates: coordinatesFor(place)
  };
}

function normalizeArrivalServices(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.services)) return value.services;
  if (Array.isArray(value.data?.services)) return value.data.services;
  return [];
}

function mapEntries(value) {
  if (!value) return [];
  if (value instanceof Map) return value.entries();
  return Object.entries(value);
}

function uniqueStopEntries(entries) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    if (!entry.stop?.id || seen.has(entry.stop.id)) continue;
    seen.add(entry.stop.id);
    unique.push(entry);
  }
  return unique;
}

function isNusStop(stop) {
  if (stop.sourceModes?.nus) return true;
  return (stop.services || []).some(isNusService);
}

function isNusService(service) {
  return service.source === "nus" || String(service.key || service.id || "").startsWith("nus:");
}

function coordinatesFor(value) {
  const directCandidates = [
    [value?.lat, value?.lng],
    [value?.lat, value?.lon],
    [value?.latitude, value?.longitude],
    [value?.location?.lat, value?.location?.lng],
    [value?.location?.lat, value?.location?.lon],
    [value?.location?.latitude, value?.location?.longitude],
    [value?.coordinate?.lat, value?.coordinate?.lng],
    [value?.coordinates?.latitude, value?.coordinates?.longitude]
  ];

  for (const [latitude, longitude] of directCandidates) {
    const parsed = parseCoordinatePair(latitude, longitude);
    if (parsed) return parsed;
  }

  return null;
}

function parseCoordinatePair(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng };
}

function haversine(left, right) {
  const radiusKm = 6371;
  const dLat = toRadians(right.latitude - left.latitude);
  const dLng = toRadians(right.longitude - left.longitude);
  const lat1 = toRadians(left.latitude);
  const lat2 = toRadians(right.latitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(a));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function stateKey(stopId, lastServiceKey, hasBus = false, continuationServiceKey = "") {
  return `stop:${stopId}|service:${lastServiceKey || ""}|bus:${hasBus ? "1" : "0"}|continue:${continuationServiceKey || ""}`;
}

function parseStateKey(key) {
  const [stopPart, rest = ""] = key.split("|service:");
  const [servicePart = "", statePart = "bus:0"] = rest.split("|bus:");
  const [busPart = "0", continuationServiceKey = ""] = statePart.split("|continue:");
  return {
    stopId: stopPart.replace(/^stop:/, ""),
    lastServiceKey: servicePart || "",
    hasBus: busPart === "1",
    continuationServiceKey: continuationServiceKey || ""
  };
}

function stopLabel(stop) {
  return stop?.title || stop?.name || stop?.shortLabel || stop?.shortName || stop?.id || "Location";
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

class MinQueue {
  items = [];

  get size() {
    return this.items.length;
  }

  push(key, priority) {
    this.items.push({ key, priority });
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return first;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  sinkDown(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.items[left].priority < this.items[smallest].priority) smallest = left;
      if (right < this.items.length && this.items[right].priority < this.items[smallest].priority) smallest = right;
      if (smallest === index) break;
      [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
      index = smallest;
    }
  }
}
