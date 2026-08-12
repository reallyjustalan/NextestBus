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
  crossServiceDominanceMinimumSavingsSeconds: 180,
  crossServiceDominanceMinimumWalkingKm: 0.15,
  untimedRouteUncertaintySeconds: 300,
  sameLocationThresholdKm: 0.01,
  directWalkAccessToleranceKm: 0.01,
  accessRadiusKm: 0.45,
  minCandidateStops: 3,
  candidateStopLimit: 6,
  transferWalkRadiusKm: 0.25,
  fallbackSegmentSeconds: 90,
  maxAlternativePlans: 3,
  arrivalWaitBudgetMs: 1800,
  downstreamBoardingToleranceKm: 0.01,
  firstBusWaitCostMultiplier: 0,
  waitCostMultiplier: 1
};

const SINGAPORE_SERVICE_CLOCK = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

export function estimateWalkingTime(distanceKm, options = {}) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...options };
  if (!Number.isFinite(distanceKm)) return Number.POSITIVE_INFINITY;
  return (distanceKm * settings.walkingDistanceFactor) / settings.walkingSpeedKmh * 3600;
}

export async function planDirections(input) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...(input.options || {}) };
  settings.departureEpochMs = input.departureTime
    ? new Date(input.departureTime).getTime()
    : Date.now();
  const network = input.compiledNetwork || compileRoutingNetwork(input.stops || [], input.services || [], settings);
  const stops = network.stops;
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

  reportProgress(input, "candidates", {
    originCandidates: originCandidates.map(({ stop, distanceKm }) => ({ stop, distanceKm })),
    destinationCandidates: destinationCandidates.map(({ stop, distanceKm }) => ({ stop, distanceKm }))
  });
  const arrivalsByStop = await arrivalsForOriginCandidates(originCandidates, input);
  const services = network.services;

  const context = {
    fromItem: input.fromItem,
    toItem: input.toItem,
    fromCoords,
    toCoords,
    originCandidates,
    originCandidateDistanceByStopId: new Map(originCandidates.map((entry) => [entry.stop.id, entry.distanceKm])),
    destinationCandidates,
    graph: network,
    services,
    arrivalsByStop,
    departureTime: input.departureTime ? new Date(input.departureTime) : new Date(),
    settings
  };
  reportProgress(input, "routing", { serviceCount: services.length });
  const directWalk = directWalkingPlan(context);
  const transit = multiCriteriaTransitPlans(context);
  const rankedPlans = nonDominatedPlans(
    practicalPlans(uniquePlans([directWalk, ...transit]), settings),
    settings
  )
    .sort((left, right) => comparePlans(left, right, settings));
  if (!rankedPlans.length) throw new Error("No NUS shuttle route found between these locations.");
  const result = rankedPlans[0];
  const alternatives = rankedPlans
    .filter((plan) => !samePlan(result, plan))
    .slice(0, settings.maxAlternativePlans);
  if (alternatives.length) result.alternatives = alternatives;
  reportProgress(input, "complete", { planCount: rankedPlans.length });
  return result;
}

function reportProgress(input, phase, detail = {}) {
  if (typeof input.onProgress === "function") input.onProgress({ phase, ...detail });
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

export function compileRoutingNetwork(stopsInput, servicesInput, options = {}) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...options };
  const stops = (stopsInput || [])
    .filter((stop) => isNusStop(stop) && coordinatesFor(stop))
    .map((stop) => ({ ...stop, coordinates: coordinatesFor(stop) }));
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  const services = normalizeServices(servicesInput || [], settings);
  const serviceOccurrencesByStop = new Map();

  for (const service of services) {
    for (let index = 0; index < service.stops.length; index += 1) {
      const stopId = service.stops[index]?.id;
      if (!stopId || !stopsById.has(stopId)) continue;
      if (!serviceOccurrencesByStop.has(stopId)) serviceOccurrencesByStop.set(stopId, []);
      serviceOccurrencesByStop.get(stopId).push({ service, index });
    }
  }

  return {
    stops,
    stopsById,
    services,
    serviceOccurrencesByStop,
    transferWalksByStop: stopTransferWalks(stops, settings),
    compiledAt: Date.now()
  };
}

function directWalkingPlan(context) {
  const distanceKm = haversine(context.fromCoords, context.toCoords);
  const durationSeconds = estimateWalkingTime(distanceKm, context.settings);
  return {
    estimated: true,
    fromItem: context.fromItem,
    toItem: context.toItem,
    fromStop: null,
    toStop: null,
    totalSeconds: durationSeconds,
    scoreSeconds: durationSeconds,
    walkingDistanceKm: distanceKm,
    transfers: 0,
    hasBusTiming: true,
    legs: [walkLeg(context.fromItem, context.toItem, distanceKm, context.settings)]
  };
}

function multiCriteriaTransitPlans(context) {
  let labelsByStop = new Map();
  const destinationByStopId = new Map(context.destinationCandidates.map((entry) => [entry.stop.id, entry]));
  const destinationLabels = [];

  for (const entry of context.originCandidates) {
    const durationSeconds = estimateWalkingTime(entry.distanceKm, context.settings);
    addParetoLabel(labelsByStop, entry.stop.id, {
      stop: entry.stop,
      elapsedSeconds: durationSeconds,
      costSeconds: durationSeconds,
      walkingDistanceKm: entry.distanceKm,
      rides: 0,
      lastServiceKey: "",
      firstServiceKey: "",
      hasBusTiming: false,
      legs: [walkLeg(context.fromItem, entry.stop, entry.distanceKm, context.settings)],
      visitedBusStopIds: new Set()
    });
  }

  for (let rideRound = 1; rideRound <= context.settings.maxTransfers + 1; rideRound += 1) {
    const rideLabels = new Map();

    for (const service of context.services) {
      if (!serviceOperatesAt(service, context.departureTime || new Date())) continue;

      for (let boardIndex = 0; boardIndex < service.stops.length - 1; boardIndex += 1) {
        const boardStop = service.stops[boardIndex];
        const boardingLabels = labelsByStop.get(boardStop.id) || [];
        if (!boardingLabels.length) continue;

        for (const label of boardingLabels) {
          const isSameServiceContinuation = label.lastServiceKey === service.key;
          const wait = isSameServiceContinuation
            ? noWaitForServiceContinuation()
            : waitForServiceAtStop(
                boardStop.id,
                service.key,
                label.elapsedSeconds,
                context.arrivalsByStop,
                context.settings
              );
          const transferPenaltySeconds = label.rides && !isSameServiceContinuation
            ? context.settings.transferPenaltySeconds
            : 0;
          const waitCostSeconds = wait.waitSeconds * (
            label.rides ? context.settings.waitCostMultiplier : context.settings.firstBusWaitCostMultiplier
          );
          const prioritySeconds = firstBusDeparturePrioritySeconds(
            wait,
            { hasBus: label.rides > 0 },
            context.settings
          );

          for (let alightIndex = boardIndex + 1; alightIndex < service.stops.length; alightIndex += 1) {
            const alightStop = service.stops[alightIndex];
            if (!context.graph.stopsById.has(alightStop.id)) continue;
            if (!label.rides && hasCloserDownstreamBoardingCandidate(
              service,
              boardIndex,
              alightIndex,
              boardStop.id,
              context
            )) continue;

            const rideSeconds = rideSecondsBetween(service, boardIndex, alightIndex, context.settings);
            if (!Number.isFinite(rideSeconds) || rideSeconds <= 0) continue;
            const durationSeconds = wait.waitSeconds + rideSeconds;
            const costSeconds = Math.max(
              0,
              waitCostSeconds + transferPenaltySeconds + rideSeconds - prioritySeconds
            );
            const leg = {
              type: "bus",
              serviceKey: service.key,
              routeCode: service.routeCode,
              fromStop: boardStop,
              toStop: alightStop,
              stops: service.stops.slice(boardIndex, alightIndex + 1),
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
            };
            const visitedBusStopIds = new Set(label.visitedBusStopIds);
            for (const stop of leg.stops) visitedBusStopIds.add(stop.id);
            addParetoLabel(rideLabels, alightStop.id, {
              stop: alightStop,
              elapsedSeconds: label.elapsedSeconds + durationSeconds,
              costSeconds: label.costSeconds + costSeconds,
              walkingDistanceKm: label.walkingDistanceKm,
              rides: label.rides + (isSameServiceContinuation ? 0 : 1),
              lastServiceKey: service.key,
              firstServiceKey: label.firstServiceKey || service.key,
              hasBusTiming: label.hasBusTiming || hasLiveBusTiming(leg),
              legs: [...label.legs, leg],
              visitedBusStopIds
            });
          }
        }
      }
    }

    if (!rideLabels.size) break;
    labelsByStop = expandTransferWalkLabels(rideLabels, context);

    for (const [stopId, labels] of labelsByStop) {
      const destination = destinationByStopId.get(stopId);
      if (!destination) continue;
      for (const label of labels) destinationLabels.push(planFromTransitLabel(label, destination, context));
    }
  }

  return destinationLabels;
}

function expandTransferWalkLabels(labelsByStop, context) {
  const expanded = new Map();
  for (const [stopId, labels] of labelsByStop) {
    for (const label of labels) {
      addParetoLabel(expanded, stopId, label);
      for (const entry of context.graph.transferWalksByStop.get(stopId) || []) {
        if (label.visitedBusStopIds.has(entry.stop.id)) continue;
        const durationSeconds = estimateWalkingTime(entry.distanceKm, context.settings);
        addParetoLabel(expanded, entry.stop.id, {
          ...label,
          stop: entry.stop,
          elapsedSeconds: label.elapsedSeconds + durationSeconds,
          costSeconds: label.costSeconds + durationSeconds,
          walkingDistanceKm: label.walkingDistanceKm + entry.distanceKm,
          legs: [...label.legs, walkLeg(label.stop, entry.stop, entry.distanceKm, context.settings)]
        });
      }
    }
  }
  return expanded;
}

function addParetoLabel(labelsByStop, stopId, candidate) {
  const labels = labelsByStop.get(stopId) || [];
  const comparable = (label) => (
    label.lastServiceKey === candidate.lastServiceKey && label.firstServiceKey === candidate.firstServiceKey
  );
  const dominates = (left, right) => (
    left.elapsedSeconds <= right.elapsedSeconds
    && left.costSeconds <= right.costSeconds
    && left.walkingDistanceKm <= right.walkingDistanceKm
    && (
      left.elapsedSeconds < right.elapsedSeconds
      || left.costSeconds < right.costSeconds
      || left.walkingDistanceKm < right.walkingDistanceKm
    )
  );
  if (labels.some((label) => comparable(label) && dominates(label, candidate))) return;

  const survivors = labels.filter((label) => !(comparable(label) && dominates(candidate, label)));
  survivors.push(candidate);
  survivors.sort((left, right) => {
    if (left.costSeconds !== right.costSeconds) return left.costSeconds - right.costSeconds;
    if (left.elapsedSeconds !== right.elapsedSeconds) return left.elapsedSeconds - right.elapsedSeconds;
    return left.walkingDistanceKm - right.walkingDistanceKm;
  });
  labelsByStop.set(stopId, survivors.slice(0, 16));
}

function planFromTransitLabel(label, destination, context) {
  const egressSeconds = estimateWalkingTime(destination.distanceKm, context.settings);
  const legs = compressRouteLegs([
    ...label.legs,
    walkLeg(label.stop, context.toItem, destination.distanceKm, context.settings)
  ]);
  const busLegs = legs.filter((leg) => leg.type === "bus");
  return {
    estimated: true,
    fromItem: context.fromItem,
    toItem: context.toItem,
    fromStop: busLegs[0]?.fromStop || null,
    toStop: busLegs[busLegs.length - 1]?.toStop || null,
    totalSeconds: label.elapsedSeconds + egressSeconds,
    scoreSeconds: label.costSeconds + egressSeconds,
    walkingDistanceKm: label.walkingDistanceKm + destination.distanceKm,
    transfers: Math.max(0, busLegs.length - 1),
    hasBusTiming: label.hasBusTiming,
    legs
  };
}

function serviceOperatesAt(service, date) {
  const schedule = service.schedule;
  if (!schedule) return true;
  const label = String(schedule.label || "").toLowerCase();
  const clock = singaporeServiceClock(date);
  const day = clock.day;
  if (/mon\s*[-–]\s*fri/.test(label) && (day === 0 || day === 6)) return false;
  if (/mon\s*[-–]\s*sat/.test(label) && day === 0) return false;
  if (/weekend/.test(label) && day !== 0 && day !== 6) return false;

  const firstMinutes = clockMinutes(schedule.firstTime);
  const lastMinutes = clockMinutes(schedule.lastTime);
  if (!Number.isFinite(firstMinutes) || !Number.isFinite(lastMinutes)) return true;
  const nowMinutes = clock.hour * 60 + clock.minute;
  if (lastMinutes >= firstMinutes) return nowMinutes >= firstMinutes && nowMinutes <= lastMinutes;
  return nowMinutes >= firstMinutes || nowMinutes <= lastMinutes;
}

function singaporeServiceClock(date) {
  const values = Object.fromEntries(
    SINGAPORE_SERVICE_CLOCK.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday),
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function clockMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
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

export function comparePlans(left, right, options = {}) {
  const settings = { ...DIRECTIONS_PLANNER_DEFAULTS, ...options };
  const leftHasBus = left.legs?.some((leg) => leg.type === "bus");
  const rightHasBus = right.legs?.some((leg) => leg.type === "bus");
  if (leftHasBus && rightHasBus && hasUntimedBusPlan(left) !== hasUntimedBusPlan(right)) {
    return hasUntimedBusPlan(left) ? 1 : -1;
  }
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

function nonDominatedPlans(plans, settings) {
  return plans.filter((candidate, candidateIndex) => !plans.some((other, otherIndex) => {
    if (candidateIndex === otherIndex) return false;
    return planDominates(other, candidate, settings);
  }));
}

function planDominates(left, right, settings) {
  const sameServicePattern = planServicePattern(left) === planServicePattern(right);
  const timeToleranceSeconds = 5;
  const walkingToleranceKm = 0.01;
  const leftSeconds = Number(left.totalSeconds) || 0;
  const rightSeconds = Number(right.totalSeconds) || 0;
  const leftWalking = Number(left.walkingDistanceKm) || 0;
  const rightWalking = Number(right.walkingDistanceKm) || 0;
  const leftTransfers = Number(left.transfers) || 0;
  const rightTransfers = Number(right.transfers) || 0;
  const timingUncertainty = !left.hasBusTiming && right.hasBusTiming
    ? settings.untimedRouteUncertaintySeconds
    : 0;
  const comparableLeftSeconds = leftSeconds + timingUncertainty;
  const noWorse = comparableLeftSeconds <= rightSeconds + timeToleranceSeconds
    && leftWalking <= rightWalking + walkingToleranceKm
    && leftTransfers <= rightTransfers;
  if (!noWorse) return false;

  const timeSavings = rightSeconds - comparableLeftSeconds;
  const walkingSavings = rightWalking - leftWalking;
  if (!sameServicePattern) {
    return timeSavings >= settings.crossServiceDominanceMinimumSavingsSeconds
      && walkingSavings >= settings.crossServiceDominanceMinimumWalkingKm;
  }

  if (Boolean(left.hasBusTiming) < Boolean(right.hasBusTiming)) return false;
  return timeSavings > timeToleranceSeconds
    || walkingSavings > walkingToleranceKm
    || leftTransfers < rightTransfers
    || Boolean(left.hasBusTiming) > Boolean(right.hasBusTiming);
}

function planServicePattern(plan) {
  const services = (plan.legs || [])
    .filter((leg) => leg.type === "bus")
    .map((leg) => leg.serviceKey || leg.routeCode || "bus");
  return services.length ? services.join(">") : "walk";
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

  const missingCandidates = originCandidates.filter(({ stop }) => stop?.id && !arrivalsByStop.has(stop.id));
  reportProgress(input, "arrivals", {
    completed: originCandidates.length - missingCandidates.length,
    total: originCandidates.length
  });
  if (typeof input.getArrivalsForStop !== "function" || !missingCandidates.length) return arrivalsByStop;

  let completed = originCandidates.length - missingCandidates.length;
  let receivedAfterBudget = false;
  let budgetExpired = false;
  const pendingArrivals = Promise.allSettled(missingCandidates.map(async ({ stop }) => {
    try {
      const data = await input.getArrivalsForStop(stop.id);
      arrivalsByStop.set(stop.id, normalizeArrivalServices(data));
      if (budgetExpired) receivedAfterBudget = true;
    } finally {
      completed += 1;
      reportProgress(input, "arrivals", { completed, total: originCandidates.length, stop });
    }
  }));
  let allArrivalsReady = false;
  await Promise.race([
    pendingArrivals.then(() => {
      allArrivalsReady = true;
    }),
    new Promise((resolvePromise) => setTimeout(() => {
      budgetExpired = true;
      resolvePromise();
    }, input.options?.arrivalWaitBudgetMs ?? DIRECTIONS_PLANNER_DEFAULTS.arrivalWaitBudgetMs))
  ]);
  if (!allArrivalsReady) {
    pendingArrivals.then(() => {
      if (receivedAfterBudget && typeof input.onLateArrivals === "function") input.onLateArrivals();
    });
  }

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

    const estimatedArrivalMs = Date.parse(arrival.estimatedArrival || "");
    const snapshotUpdatedAtMs = Date.parse(arrival._snapshotUpdatedAt || "");
    const snapshotAgeSeconds = Number.isFinite(snapshotUpdatedAtMs)
      ? Math.max(0, settings.departureEpochMs - snapshotUpdatedAtMs) / 1000
      : 0;
    const estimatedSecondsAtSnapshot = Number.isFinite(estimatedArrivalMs) && Number.isFinite(snapshotUpdatedAtMs)
      ? (estimatedArrivalMs - snapshotUpdatedAtMs) / 1000
      : Number.NaN;
    const absoluteEstimateIsConsistent = Number.isFinite(estimatedArrivalMs) && (
      !Number.isFinite(estimatedSecondsAtSnapshot)
      || Math.abs(estimatedSecondsAtSnapshot - minutes * 60) <= 120
    );
    const arrivalSeconds = absoluteEstimateIsConsistent
      ? (estimatedArrivalMs - settings.departureEpochMs) / 1000
      : minutes * 60 - snapshotAgeSeconds;
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

function normalizeServices(services, settings = DIRECTIONS_PLANNER_DEFAULTS) {
  return services
    .filter((service) => service && isNusService(service))
    .map((service) => {
      const stops = (service.route?.stops || service.stops || [])
        .map((routeStop) => normalizeRouteStop(routeStop))
        .filter((stop) => stop.id && coordinatesFor(stop));
      const normalized = {
        key: service.key || service.id || `nus:${service.name || service.route?.code || ""}`,
        routeCode: service.name || service.route?.code || String(service.key || "").replace(/^nus:/, ""),
        color: service.color,
        stops,
        path: (service.route?.path || [])
          .map((point) => ({ ...point, coordinates: coordinatesFor(point) }))
          .filter((point) => point.coordinates),
        schedule: service.route?.schedule || service.schedule || null,
        raw: service
      };
      normalized.segmentSeconds = precomputeSegmentSeconds(normalized, settings);
      normalized.cumulativeRideSeconds = [0];
      for (const seconds of normalized.segmentSeconds) {
        normalized.cumulativeRideSeconds.push(
          normalized.cumulativeRideSeconds[normalized.cumulativeRideSeconds.length - 1] + seconds
        );
      }
      return normalized;
    })
    .filter((service) => service.key && service.stops.length > 1);
}

function precomputeSegmentSeconds(service, settings) {
  const pathStopIndices = [];
  let pathCursor = 0;
  for (const stop of service.stops) {
    const index = pathStopIndex(service.path, stop, pathCursor);
    pathStopIndices.push(index);
    if (index >= pathCursor) pathCursor = index + 1;
  }

  return service.stops.slice(0, -1).map((fromStop, index) => {
    const fromPathIndex = pathStopIndices[index];
    const toPathIndex = pathStopIndices[index + 1];
    let distanceKm = Number.NaN;
    if (fromPathIndex >= 0 && toPathIndex > fromPathIndex) {
      distanceKm = 0;
      for (let pathIndex = fromPathIndex + 1; pathIndex <= toPathIndex; pathIndex += 1) {
        distanceKm += haversine(
          service.path[pathIndex - 1].coordinates,
          service.path[pathIndex].coordinates
        );
      }
    }
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      distanceKm = haversine(fromStop.coordinates, service.stops[index + 1].coordinates) * settings.roadDistanceFactor;
    }
    return distanceKm / settings.busSpeedKmh * 3600 + settings.dwellSeconds;
  });
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
  if (service.cumulativeRideSeconds?.length > endIndex) {
    return service.cumulativeRideSeconds[endIndex] - service.cumulativeRideSeconds[startIndex];
  }
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
  const services = Array.isArray(value)
    ? value
    : Array.isArray(value.services)
      ? value.services
      : Array.isArray(value.data?.services)
        ? value.data.services
        : [];
  const snapshotUpdatedAt = value.updatedAt || value.data?.updatedAt || "";
  if (!snapshotUpdatedAt) return services;
  return services.map((service) => ({
    ...service,
    arrivals: (service.arrivals || []).map((arrival) => ({
      ...arrival,
      _snapshotUpdatedAt: snapshotUpdatedAt
    }))
  }));
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

function stopLabel(stop) {
  return stop?.title || stop?.name || stop?.shortLabel || stop?.shortName || stop?.id || "Location";
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}
