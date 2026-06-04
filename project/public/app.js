const API_BASE = "https://api.nusbus.com/api";
const PINNED_STOPS_KEY = "nusbus-pinned-stops";
const INSTALL_PROMPT_DISMISSED_KEY = "nusbus-install-prompt-dismissed";
const REFRESH_INTERVAL_MS = 30000;
const FRESHNESS_TICK_MS = 5000;

const state = {
  stops: [],
  filteredStops: [],
  pinnedStopIds: loadPinnedStopIds(),
  openStopId: "",
  arrivalsByStop: new Map(),
  routeServicesByKey: new Map(),
  loadingStopId: "",
  sortOrigin: null,
  activeRouteKey: "",
  lastUpdatedAt: null,
  isRefreshing: false
};

let refreshTimerId = null;
let freshnessTimerId = null;
let deferredInstallPrompt = null;
const routeTimingFetches = new Set();
const routeVehicleMemory = new Map();

const elements = {
  loadStatus: document.getElementById("loadStatus"),
  searchInput: document.getElementById("searchInput"),
  appHeader: document.querySelector(".app-header"),
  controls: document.querySelector(".controls"),
  homeButton: document.getElementById("homeButton"),
  installPrompt: document.getElementById("installPrompt"),
  installTitle: document.getElementById("installTitle"),
  installText: document.getElementById("installText"),
  installButton: document.getElementById("installButton"),
  installDismiss: document.getElementById("installDismiss"),
  stopsSection: document.querySelector(".stops-section"),
  stopList: document.getElementById("stopList"),
  locationButton: document.getElementById("locationButton"),
  routeView: document.getElementById("routeView"),
  routeBadge: document.getElementById("routeBadge"),
  routeTitle: document.getElementById("routeTitle"),
  routeMeta: document.getElementById("routeMeta"),
  routeBody: document.getElementById("routeBody")
};

async function apiGet(path, query = {}) {
  const proxyUrl = new URL("/api/nusbus", window.location.origin);
  proxyUrl.searchParams.set("endpoint", path);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      proxyUrl.searchParams.set(key, value);
    }
  });

  return fetchJson(proxyUrl);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text || "Invalid JSON response" };
  }

  if (!response.ok) {
    throw new Error(data.message || `Request failed with ${response.status}`);
  }

  return data;
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function searchText(stop) {
  return [stop.id, stop.title, stop.subtitle, stop.shortLabel, stop.busStopCode, ...(stop.services || []).map((service) => service.name)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function applyFilters() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const stops = query ? state.stops.filter((stop) => searchText(stop).includes(query)) : [...state.stops];

  stops.sort(compareStops);

  state.filteredStops = stops;
  renderStopList();
  updateStatus();
}

function renderStopList() {
  if (!state.filteredStops.length) {
    elements.stopList.innerHTML = `<div class="empty-state">No stops match your search.</div>`;
    return;
  }

  elements.stopList.replaceChildren(...state.filteredStops.map(renderStopCard));
}

function renderStopCard(stop) {
  const card = document.createElement("article");
  card.dataset.stopId = stop.id;

  const isOpen = state.openStopId === stop.id;
  const isPinned = state.pinnedStopIds.has(stop.id);
  card.className = `stop-card${isOpen ? " is-open" : ""}${isPinned ? " is-pinned" : ""}`;
  const services = renderServiceChips(stop.services || []);
  const distance = state.sortOrigin ? distanceLabel(distanceFromOrigin(stop)) : "";

  card.innerHTML = `
    <div class="stop-top">
      <button class="stop-button" type="button" aria-expanded="${isOpen}" aria-controls="arrivals-${escapeHtml(stop.id)}">
        <span>
          <span class="stop-title-line">
            <strong>${escapeHtml(stop.title)}</strong>
          </span>
          <small>${escapeHtml([stop.busStopCode, stop.subtitle].filter(Boolean).join(" - ") || stop.id)}</small>
        </span>
      </button>
      <button class="pin-button" type="button" aria-pressed="${isPinned}" aria-label="${isPinned ? "Unpin" : "Pin"} ${escapeHtml(stop.title)}">
        <span aria-hidden="true">${isPinned ? "♥" : "♡"}</span>
      </button>
      ${distance ? `<span class="distance">${escapeHtml(distance)}</span>` : ""}
    </div>
    <div class="service-row">${services || `<span class="no-services">No listed services</span>`}</div>
    <div id="arrivals-${escapeHtml(stop.id)}" class="inline-arrivals" ${isOpen ? "" : "hidden"} aria-live="polite"></div>
  `;

  if (isOpen) renderArrivalsInto(card.querySelector(".inline-arrivals"), stop.id);
  return card;
}

function compareStops(left, right) {
  const leftPinned = state.pinnedStopIds.has(left.id);
  const rightPinned = state.pinnedStopIds.has(right.id);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

  if (state.sortOrigin) {
    const leftDistance = distanceFromOrigin(left);
    const rightDistance = distanceFromOrigin(right);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  }

  return left.title.localeCompare(right.title);
}

function togglePinnedStop(stopId) {
  if (state.pinnedStopIds.has(stopId)) {
    state.pinnedStopIds.delete(stopId);
  } else {
    state.pinnedStopIds.add(stopId);
  }
  savePinnedStopIds();
  applyFilters();
}

function renderServiceChips(services) {
  return services
    .slice(0, 9)
    .map((service) => {
      const color = service.color?.background || "#eef3ef";
      const text = service.color?.text || "#15322e";
      if (!supportsRouteView(service)) {
        return `<span class="service-chip is-passive" style="background:${escapeHtml(color)};color:${escapeHtml(text)}">${escapeHtml(service.name)}</span>`;
      }
      return `<button class="service-chip" type="button" data-service-key="${escapeHtml(service.key || "")}" aria-label="Show ${escapeHtml(service.name)} route" style="background:${escapeHtml(color)};color:${escapeHtml(text)}">${escapeHtml(service.name)}</button>`;
    })
    .join("");
}

function supportsRouteView(service) {
  return service.source === "nus" || String(service.key || "").startsWith("nus:");
}

async function openStop(stopId) {
  if (state.openStopId === stopId) {
    state.openStopId = "";
    renderStopList();
    return;
  }

  state.openStopId = stopId;
  renderStopList();

  if (state.arrivalsByStop.has(stopId)) return;

  try {
    await loadStopDetails(stopId);
  } catch {
    // The stop card renders the cached error state.
  }
}

async function loadStopDetails(stopId, options = {}) {
  const force = options.force === true;
  const silent = options.silent === true;
  const cached = state.arrivalsByStop.get(stopId);
  if (!force && cached?.data) return cached.data;
  if (!force && cached?.error) throw cached.error;

  if (!silent) {
    state.loadingStopId = stopId;
    renderStopList();
  }

  try {
    const data = await apiGet(`/stops/${encodeURIComponent(stopId)}`);
    state.arrivalsByStop.set(stopId, { data });
    markUpdated();
    return data;
  } catch (error) {
    if (!(force && cached?.data)) state.arrivalsByStop.set(stopId, { error });
    throw error;
  } finally {
    if (state.loadingStopId === stopId) state.loadingStopId = "";
    if (!silent || state.openStopId === stopId) renderStopList();
  }
}

async function openRouteFromStop(stopId, serviceKey) {
  elements.loadStatus.textContent = "Loading route...";

  try {
    const data = await loadStopDetails(stopId);
    const service = (data.services || []).find((item) => item.key === serviceKey);
    if (!service) throw new Error("Route not found for this stop.");
    if (!supportsRouteView(service)) return;
    state.routeServicesByKey.set(serviceKey, { ...service, observedStopId: stopId });
    openRouteView(serviceKey);
    updateStatus();
  } catch (error) {
    elements.loadStatus.textContent = error.message || "Could not load route";
  }
}

async function loadRouteService(serviceKey, options = {}) {
  const force = options.force === true;
  const cached = state.routeServicesByKey.get(serviceKey);
  if (!force && (cached?.route || cached?.stops)) return cached;

  let routeService = null;
  try {
    const data = await apiGet(`/services/${serviceKey}`);
    routeService = data.service || null;
  } catch {
    routeService = null;
  }

  const stopService = await serviceFromKnownStop(serviceKey, routeService, options);
  const service = mergeRouteService(serviceKey, routeService, stopService);
  if (!service) throw new Error("Route not found.");

  state.routeServicesByKey.set(serviceKey, service);
  markUpdated();
  return service;
}

async function serviceFromKnownStop(serviceKey, routeService, options = {}) {
  const stopIds = [
    ...(routeService?.route?.stops || []).map((stop) => stop.id),
    ...(routeService?.stops || []).map((stop) => stop.id),
    ...state.stops
      .filter((stop) => (stop.services || []).some((service) => service.key === serviceKey))
      .map((stop) => stop.id)
  ].filter(Boolean);

  for (const stopId of [...new Set(stopIds)]) {
    try {
      const data = await loadStopDetails(stopId, { force: options.force === true, silent: options.silent === true });
      const service = (data.services || []).find((item) => item.key === serviceKey);
      if (service) return { ...service, observedStopId: stopId };
    } catch {
      // Try the next stop that serves this route.
    }
  }

  return null;
}

function mergeRouteService(serviceKey, routeService, stopService) {
  const service = routeService || stopService;
  if (!service) return null;

  return {
    ...service,
    ...stopService,
    key: service.key || stopService?.key || serviceKey,
    id: service.id || stopService?.id || serviceKey,
    name: service.name || stopService?.name || serviceKey.replace(/^nus:/, ""),
    source: service.source || stopService?.source || "nus",
    color: service.color || stopService?.color,
    route: stopService?.route || service.route,
    stops: stopService?.stops || service.stops,
    arrivals: stopService?.arrivals || service.arrivals || [],
    observedStopId: stopService?.observedStopId || service.observedStopId,
    stopArrivalsByStop: {
      ...(service.stopArrivalsByStop || {}),
      ...(stopService?.stopArrivalsByStop || {})
    }
  };
}

async function loadRouteStopTimings(serviceKey, options = {}) {
  if (routeTimingFetches.has(serviceKey)) return;

  const service = state.routeServicesByKey.get(serviceKey);
  const stops = service?.route?.stops || service?.stops || [];
  if (!service || !stops.length) return;
  if (!options.force && service.stopArrivalsByStop && Object.keys(service.stopArrivalsByStop).length) return;

  routeTimingFetches.add(serviceKey);
  if (!options.force) {
    state.routeServicesByKey.set(serviceKey, { ...service, isLoadingStopTimings: true });
    if (state.activeRouteKey === serviceKey) renderRouteView(state.routeServicesByKey.get(serviceKey));
  }

  try {
    const stopIds = [...new Set(stops.map((stop) => stop.id).filter(Boolean))];
    const results = await Promise.allSettled(
      stopIds.map(async (stopId) => {
        const data = await loadStopDetails(stopId, { force: options.force === true, silent: true });
        const stopService = (data.services || []).find((item) => item.key === serviceKey);
        return [stopId, stopService?.arrivals || []];
      })
    );

    const latestService = state.routeServicesByKey.get(serviceKey) || service;
    const stopArrivalsByStop = { ...(latestService.stopArrivalsByStop || {}) };
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const [stopId, arrivals] = result.value;
      stopArrivalsByStop[stopId] = arrivals.slice(0, 3);
    }

    state.routeServicesByKey.set(serviceKey, {
      ...latestService,
      stopArrivalsByStop,
      isLoadingStopTimings: false
    });

    if (state.activeRouteKey === serviceKey && options.rerender !== false) {
      renderRouteView(state.routeServicesByKey.get(serviceKey));
    }
  } finally {
    routeTimingFetches.delete(serviceKey);
  }
}

function renderArrivalsInto(container, stopId) {
  if (state.loadingStopId === stopId) {
    container.innerHTML = `<div class="empty-state compact">Loading arrivals...</div>`;
    return;
  }

  const entry = state.arrivalsByStop.get(stopId);
  if (!entry) {
    container.innerHTML = `<div class="empty-state compact">Loading arrivals...</div>`;
    return;
  }

  if (entry.error) {
    container.innerHTML = `<div class="empty-state compact error">Could not load arrivals: ${escapeHtml(entry.error.message)}</div>`;
    return;
  }

  const services = (entry.data.services || []).filter((service) => service.arrivals?.length);
  if (!services.length) {
    container.innerHTML = `<div class="empty-state compact">No upcoming buses right now.</div>`;
    return;
  }

  container.replaceChildren(...services.map((service) => renderService(service, stopId)));
}

function renderService(service, stopId = "") {
  const canOpenRoute = supportsRouteView(service);
  const routeService = stopId ? { ...service, observedStopId: stopId } : service;
  if (canOpenRoute && service.key) state.routeServicesByKey.set(service.key, routeService);

  const card = document.createElement(canOpenRoute ? "button" : "article");
  card.className = `service-card${canOpenRoute ? "" : " is-passive"}`;
  if (canOpenRoute) {
    card.type = "button";
    card.dataset.serviceKey = service.key || "";
    card.setAttribute("aria-label", `Show ${service.name} route`);
  }
  const color = service.color?.background || "#2f6f68";
  const text = service.color?.text || "#ffffff";
  const arrivals = service.arrivals.slice(0, 3);
  const nextStop = service.route?.destination || service.arrivals[0]?.liveVehicle?.nextStop?.name || "";

  card.innerHTML = `
    <div class="service-header">
      <span class="route-badge" style="background:${escapeHtml(color)};color:${escapeHtml(text)}">${escapeHtml(service.name)}</span>
      <span>${escapeHtml(nextStop ? `Towards ${nextStop}` : service.subtitle || "Campus shuttle")}</span>
    </div>
    <div class="arrival-grid">
      ${arrivals.map(renderArrival).join("")}
    </div>
  `;
  return card;
}

function renderArrival(arrival) {
  const load = arrival.liveVehicle?.load?.crowdLabel;
  const loadLevel = arrival.liveVehicle?.load?.crowdLevel || load;
  const vehicle = arrival.vehiclePlate || arrival.meta;
  return `
    <div class="arrival">
      <strong class="arrival-time ${escapeHtml(loadClass(loadLevel))}">${escapeHtml(arrival.display || minutesLabel(arrival.minutes))}</strong>
      <small>${escapeHtml([vehicle, load && `${load} load`].filter(Boolean).join(" - ") || "No vehicle info")}</small>
    </div>
  `;
}

async function openRouteView(serviceKey, options = {}) {
  const entry = state.routeServicesByKey.get(serviceKey);
  if (!entry) return;
  const shouldPush = options.pushHistory !== false;

  state.activeRouteKey = serviceKey;
  elements.appHeader.hidden = false;
  elements.controls.hidden = true;
  elements.stopsSection.hidden = true;
  elements.routeView.hidden = false;
  renderRouteView(entry);
  if (options.loadStopTimings !== false) loadRouteStopTimings(serviceKey);
  if (shouldPush) {
    history.pushState({ view: "route", serviceKey }, "", `#route=${encodeURIComponent(serviceKey)}`);
  }
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeRouteView() {
  state.activeRouteKey = "";
  elements.routeView.hidden = true;
  elements.appHeader.hidden = false;
  elements.controls.hidden = false;
  elements.stopsSection.hidden = false;
  elements.routeBody.replaceChildren();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetBrowsingExperience() {
  state.openStopId = "";
  state.sortOrigin = null;
  elements.searchInput.value = "";
  closeRouteView();
  applyFilters();
  history.replaceState({ view: "stops" }, "", window.location.pathname);
}

async function openStopFromRoute(stopId) {
  if (!stopId) return;

  state.activeRouteKey = "";
  state.openStopId = "";
  state.sortOrigin = null;
  elements.searchInput.value = "";
  elements.routeView.hidden = true;
  elements.controls.hidden = false;
  elements.stopsSection.hidden = false;
  elements.routeBody.replaceChildren();
  history.pushState({ view: "stops" }, "", window.location.pathname);
  applyFilters();

  await openStop(stopId);
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-stop-id="${CSS.escape(stopId)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function handleHistoryChange(event) {
  const historyState = event.state || { view: "stops" };
  const serviceKey = historyState.view === "route" ? historyState.serviceKey : routeKeyFromHash();
  if (serviceKey) {
    await restoreRouteFromKey(serviceKey, { scroll: false });
  } else {
    closeRouteView();
  }
}

async function handleHashChange() {
  const serviceKey = routeKeyFromHash();
  if (serviceKey) {
    await restoreRouteFromKey(serviceKey, { scroll: true });
  } else {
    closeRouteView();
    history.replaceState({ view: "stops" }, "", window.location.pathname);
  }
}

function routeKeyFromHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("route") || "";
}

async function restoreRouteFromKey(serviceKey, options = {}) {
  if (!supportsRouteView({ key: serviceKey, source: serviceKey.split(":")[0] })) {
    closeRouteView();
    return false;
  }

  elements.loadStatus.textContent = "Loading route...";
  try {
    await loadRouteService(serviceKey);
    openRouteView(serviceKey, { pushHistory: false, scroll: options.scroll });
    history.replaceState({ view: "route", serviceKey }, "", `#route=${encodeURIComponent(serviceKey)}`);
    updateStatus();
    return true;
  } catch (error) {
    closeRouteView();
    elements.loadStatus.textContent = error.message || "Could not load route";
    return false;
  }
}

async function refreshVisibleData() {
  if (state.isRefreshing) return;
  if (!state.activeRouteKey && !state.openStopId) {
    updateStatus();
    return;
  }

  state.isRefreshing = true;
  try {
    if (state.activeRouteKey) {
      await refreshActiveRoute();
    } else if (state.openStopId) {
      await loadStopDetails(state.openStopId, { force: true, silent: true });
    }
  } catch {
    // Keep the last good timings visible when a background refresh fails.
  } finally {
    state.isRefreshing = false;
    updateStatus();
  }
}

async function refreshActiveRoute() {
  const serviceKey = state.activeRouteKey;
  const cached = state.routeServicesByKey.get(serviceKey);
  if (!serviceKey) return;

  let refreshedService = null;
  if (cached?.observedStopId) {
    const data = await loadStopDetails(cached.observedStopId, { force: true, silent: true });
    const stopService = (data.services || []).find((item) => item.key === serviceKey);
    if (stopService) refreshedService = mergeRouteService(serviceKey, cached, { ...stopService, observedStopId: cached.observedStopId });
  }

  if (!refreshedService) {
    refreshedService = await loadRouteService(serviceKey, { force: true, silent: true });
  }

  state.routeServicesByKey.set(serviceKey, refreshedService);
  await loadRouteStopTimings(serviceKey, { force: true, rerender: false });
  openRouteView(serviceKey, { pushHistory: false, scroll: false, loadStopTimings: false });
}

function startAutoRefresh() {
  clearInterval(refreshTimerId);
  clearInterval(freshnessTimerId);
  refreshTimerId = setInterval(refreshVisibleData, REFRESH_INTERVAL_MS);
  freshnessTimerId = setInterval(updateStatus, FRESHNESS_TICK_MS);
}

function renderRouteView(service) {
  const color = service.color?.background || "#2f6f68";
  const text = service.color?.text || "#ffffff";
  const route = service.route || {};
  const stops = route.stops || service.stops || [];
  const stopArrivalsByStop = service.stopArrivalsByStop || {};
  const routeVehicles = routeVehiclesForService(service, stops, stopArrivalsByStop);
  const arrivingVehiclesByStop = arrivingVehiclesByStopForService(service);
  const isLoadingStopTimings = service.isLoadingStopTimings === true;

  elements.routeBadge.textContent = service.name;
  elements.routeBadge.style.background = color;
  elements.routeBadge.style.color = text;
  elements.routeTitle.textContent = `${service.name} Route`;
  elements.routeMeta.textContent = [
    route.destination && `Towards ${route.destination}`,
    route.schedule?.label,
    route.schedule?.firstTime && route.schedule?.lastTime ? `${route.schedule.firstTime}-${route.schedule.lastTime}` : "",
    `${stops.length} stops`
  ]
    .filter(Boolean)
    .join(" • ");

  try {
    elements.routeBody.textContent = "";
    elements.routeBody.appendChild(routeStopsElement(stops, routeVehicles, arrivingVehiclesByStop, stopArrivalsByStop, isLoadingStopTimings, color, text));
  } catch (error) {
    elements.routeBody.innerHTML = `<div class="empty-state error">Could not render route: ${escapeHtml(error.message || "Unknown error")}</div>`;
  }
}

function routeStopsElement(stops, routeVehicles, arrivingVehiclesByStop, stopArrivalsByStop, isLoadingStopTimings, color, text) {
  const wrapper = document.createElement("section");
  wrapper.className = "route-stops-card";

  if (!stops.length) {
    wrapper.innerHTML = `<div class="empty-state compact">No stop list available.</div>`;
    return wrapper;
  }

  wrapper.innerHTML = `
    <header class="route-stops-header">
      <h3>Stops</h3>
      <p>${escapeHtml(routeVehicles.length ? `${routeVehicles.length} live bus marker${routeVehicles.length === 1 ? "" : "s"} on this route` : "No live buses on this route right now")}</p>
    </header>
    <ol class="route-stop-list">
      ${stops.map((stop, index) => renderRouteStop(stop, index, routeVehicles, arrivingVehiclesByStop, stopArrivalsByStop, isLoadingStopTimings, stops, color, text)).join("")}
    </ol>
  `;
  return wrapper;
}

function renderRouteStop(stop, index, routeVehicles, arrivingVehiclesByStop, stopArrivalsByStop, isLoadingStopTimings, stops, color, text) {
  const isFirstStop = routeStopSequence(stop, index) <= 1;
  const matchingVehicles = isFirstStop ? [] : routeVehicles.filter((vehicle) => vehicle.targetStop === stop);
  const arrivingVehicles = isFirstStop
    ? []
    : uniqueVehicles([
        ...vehiclesArrivingAtStop(arrivingVehiclesByStop, stop),
        ...arrivalsForRouteStop(stop, stopArrivalsByStop).filter(isArrivingArrival).map(vehicleFromArrival)
      ]);
  const stoppedVehicles = uniqueVehicles([...matchingVehicles.filter((vehicle) => isVehicleAtStop(vehicle, stop) || vehicle.isArriving), ...arrivingVehicles]);
  const movingVehicles = matchingVehicles.filter((vehicle) => !hasVehicle(stoppedVehicles, vehicle));
  const stopName = stop.shortName || stop.name || stop.title || stop.id;
  const stoppedSummary = stoppedVehicles.map((vehicle) => vehicleSummary(vehicle, `At ${stopName}`)).join(" / ");
  const sequenceAttrs = [
    stoppedVehicles.length ? `style="--bus-bg:${escapeHtml(color)};--bus-fg:${escapeHtml(text)}"` : "",
    stoppedSummary ? `title="${escapeHtml(stoppedSummary)}" aria-label="${escapeHtml(stoppedSummary)}" tabindex="0"` : ""
  ].filter(Boolean).join(" ");
  return `
    <li class="route-stop-item${stoppedVehicles.length ? " has-stopped-bus" : ""}">
      <span class="route-track">
        <span class="stop-sequence"${sequenceAttrs ? ` ${sequenceAttrs}` : ""}>${escapeHtml(stop.sequence || index + 1)}</span>
        ${[...movingVehicles, ...stoppedVehicles].map((vehicle, vehicleIndex) => renderRouteBus(vehicle, stop, index, stops, vehicleIndex, color, text)).join("")}
      </span>
      <button class="route-stop-content" type="button" data-stop-id="${escapeHtml(stop.id || "")}" aria-label="Open ${escapeHtml(stop.name || stop.title || stop.shortName || stop.id)} arrivals">
        <strong>${escapeHtml(stop.name || stop.title || stop.shortName || stop.id)}</strong>
        <small>${escapeHtml([stop.code, stop.shortName && stop.shortName !== stop.name ? stop.shortName : ""].filter(Boolean).join(" • "))}</small>
        ${renderRouteStopTiming(stop, stopArrivalsByStop, isLoadingStopTimings)}
      </button>
    </li>
  `;
}

function renderRouteStopTiming(stop, stopArrivalsByStop, isLoadingStopTimings) {
  const arrivals = arrivalsForRouteStop(stop, stopArrivalsByStop);
  const arrival = arrivals[0];
  if (!arrival) {
    return `<span class="route-stop-eta is-muted">${isLoadingStopTimings ? "..." : "No bus"}</span>`;
  }

  const load = arrival.liveVehicle?.load?.crowdLabel;
  const loadLevel = arrival.liveVehicle?.load?.crowdLevel || load;
  const vehicle = arrival.vehiclePlate || arrival.meta;
  const detail = [vehicle, load && `${load} load`].filter(Boolean).join(" - ");
  return `<span class="route-stop-eta ${escapeHtml(loadClass(loadLevel))}" title="${escapeHtml(detail || "Next bus")}">${escapeHtml(arrival.display || minutesLabel(arrival.minutes))}</span>`;
}

function routeStopSequence(stop, index = -1) {
  const sequence = Number(stop?.sequence);
  if (Number.isFinite(sequence) && sequence > 0) return sequence;
  return index >= 0 ? index + 1 : Number.POSITIVE_INFINITY;
}

function isFirstRouteStop(stop, stops = []) {
  if (!stop) return false;
  if (stops[0] === stop) return true;
  return routeStopSequence(stop, stops.indexOf(stop)) <= 1;
}

function arrivalsForRouteStop(stop, stopArrivalsByStop) {
  return stopKeyCandidates(stop).flatMap((key) => stopArrivalsByStop[key] || []);
}

function renderRouteBus(vehicle, stop, index, stops, vehicleIndex, color, text) {
  const previousStop = stops[index - 1] || stops[stops.length - 1];
  const destination = stop.shortName || stop.name || stop.title || stop.id;
  const origin = previousStop?.shortName || previousStop?.name || previousStop?.title || previousStop?.id || "previous stop";
  const isStopped = vehicle.isArriving || isVehicleAtStop(vehicle, stop);
  const marker = routeBusMarkerPosition(vehicle, previousStop, stop, vehicleIndex, isStopped);
  const status = isStopped ? `At ${destination}` : `${origin} to ${destination}`;
  const title = vehicleSummary(vehicle, status);

  return `
    <span class="route-bus-marker ${isStopped ? "is-stopped" : "is-moving"}" title="${escapeHtml(title)}" tabindex="0" style="--bus-bg:${escapeHtml(color)};--bus-fg:${escapeHtml(text)};--bus-top:${marker.top}px;--bus-start-top:${marker.startTop}px;--bus-left:${marker.left}px">
      <span class="mini-bus">
        <span>BUS</span>
      </span>
    </span>
  `;
}

function vehicleSummary(vehicle, status) {
  const load = vehicle.load?.crowdLabel ? `${vehicle.load.crowdLabel} load` : "";
  const speed = Number.isFinite(vehicle.speed) ? `${Math.round(vehicle.speed)} km/h` : "";
  return [vehicle.vehiclePlate, status, speed, load].filter(Boolean).join(" • ");
}

function routeBusMarkerPosition(vehicle, previousStop, nextStop, vehicleIndex, isStopped) {
  const leftJitter = [62, 72, 82][vehicleIndex % 3];
  const stopCenterTop = 44;
  const markerDotOffset = 18;
  if (isStopped) {
    const top = stopCenterTop - markerDotOffset + vehicleIndex * 8;
    return { left: leftJitter, top, startTop: top };
  }

  const progress = vehicle.estimatedProgress ?? segmentProgress(vehicle.coordinates, previousStop?.coordinates, nextStop?.coordinates);
  const segmentStart = -44;
  const segmentEnd = stopCenterTop;
  const top = segmentStart + progress * (segmentEnd - segmentStart) - markerDotOffset;
  const clampedTop = Math.round(Math.min(stopCenterTop - markerDotOffset, Math.max(segmentStart - markerDotOffset, top)));
  return {
    left: leftJitter,
    top: clampedTop,
    startTop: Math.max(segmentStart - markerDotOffset, clampedTop - 18)
  };
}

function segmentProgress(point, start, end) {
  if (!point || !start || !end) return 0.72;

  const startX = Number(start.longitude);
  const startY = Number(start.latitude);
  const endX = Number(end.longitude);
  const endY = Number(end.latitude);
  const pointX = Number(point.longitude);
  const pointY = Number(point.latitude);
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  if (!Number.isFinite(lengthSquared) || lengthSquared === 0) return 0.72;

  const projection = ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared;
  return Math.min(0.92, Math.max(0.08, projection));
}

function liveVehiclesForService(service) {
  const vehicles = new Map();
  for (const arrival of service.arrivals || []) {
    const liveVehicle = arrival.liveVehicle;
    const coordinates = liveVehicle?.coordinates;
    if (!coordinates) continue;
    const key = liveVehicle.vehiclePlate || arrival.vehiclePlate || arrival.meta || `${coordinates.latitude},${coordinates.longitude}`;
    vehicles.set(key, {
      vehiclePlate: liveVehicle.vehiclePlate || arrival.vehiclePlate || arrival.meta || "Bus",
      coordinates,
      speed: liveVehicle.speed,
      direction: liveVehicle.direction,
      load: liveVehicle.load,
      nextStop: liveVehicle.nextStop
    });
  }
  return [...vehicles.values()];
}

function routeVehiclesForService(service, stops, stopArrivalsByStop) {
  const candidates = new Map();
  const serviceKey = service.key || service.id || "route";

  for (const arrival of service.arrivals || []) {
    const vehicle = vehicleFromArrival(arrival);
    const targetStop = stopForVehicle(vehicle, stops);
    if (isFirstRouteStop(targetStop, stops)) continue;
    if (targetStop && canDrawArrivalMarker(arrival, vehicle, targetStop)) addRouteVehicleCandidate(candidates, serviceKey, vehicle, targetStop, arrival);
  }

  for (const stop of stops) {
    if (isFirstRouteStop(stop, stops)) continue;
    for (const arrival of arrivalsForRouteStop(stop, stopArrivalsByStop)) {
      const vehicle = vehicleFromArrival(arrival);
      if (canDrawArrivalMarker(arrival, vehicle, stop)) addRouteVehicleCandidate(candidates, serviceKey, vehicle, stop, arrival);
    }
  }

  const now = Date.now();
  for (const [key, memory] of routeVehicleMemory.entries()) {
    if (!key.startsWith(`${serviceKey}:`) || candidates.has(key)) continue;
    if (now - memory.updatedAt > REFRESH_INTERVAL_MS * 4) continue;
    const targetStop = stops.find((stop) => stopKeyCandidates(stop).some((candidate) => normalizeStopKey(candidate) === memory.targetStopKey));
    if (!targetStop) continue;
    if (isFirstRouteStop(targetStop, stops)) continue;
    candidates.set(key, {
      ...memory.vehicle,
      targetStop,
      timingStatus: "Last known",
      estimatedProgress: memory.vehicle.estimatedProgress ?? 0.72
    });
  }

  return [...candidates.values()].sort((left, right) => {
    const leftSeq = Number(left.targetStop?.sequence || 0);
    const rightSeq = Number(right.targetStop?.sequence || 0);
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
    return vehicleKey(left).localeCompare(vehicleKey(right));
  });
}

function addRouteVehicleCandidate(candidates, serviceKey, vehicle, targetStop, arrival) {
  const targetSequence = Number(targetStop?.sequence);
  if (Number.isFinite(targetSequence) && targetSequence <= 1) return;
  const key = routeCandidateKey(serviceKey, vehicle, targetStop, arrival);
  if (!key) return;
  const remembered = routeVehicleMemory.get(key);
  const isArriving = isArrivingArrival(arrival);
  const etaMinutes = Number(arrival.minutes);
  const hasCoordinates = Boolean(vehicle.coordinates);
  const estimatedProgress = isArriving ? 1 : etaProgress(etaMinutes);
  const mergedVehicle = {
    ...vehicle,
    coordinates: vehicle.coordinates || remembered?.vehicle.coordinates,
    targetStop,
    etaMinutes,
    estimatedProgress,
    isArriving,
    timingStatus: isArriving ? "Arriving" : arrival.display || minutesLabel(etaMinutes)
  };
  const existing = candidates.get(key);

  if (!existing || vehicleCandidateRank(mergedVehicle, hasCoordinates) > vehicleCandidateRank(existing, Boolean(existing.coordinates))) {
    candidates.set(key, mergedVehicle);
  }

  if (mergedVehicle.coordinates) {
    routeVehicleMemory.set(key, {
      vehicle: mergedVehicle,
      targetStopKey: normalizeStopKey(targetStop.id || targetStop.code || targetStop.name),
      updatedAt: Date.now()
    });
  }
}

function canDrawArrivalMarker(arrival, vehicle, targetStop) {
  if (isArrivingArrival(arrival) || vehicle.coordinates) return true;
  return false;
}

function routeCandidateKey(serviceKey, vehicle, targetStop, arrival) {
  if (vehicle.vehiclePlate) return `${serviceKey}:${vehicle.vehiclePlate}`;
  if (vehicle.coordinates) return `${serviceKey}:${vehicle.coordinates.latitude},${vehicle.coordinates.longitude}`;
  if (isArrivingArrival(arrival)) return `${serviceKey}:arriving:${normalizeStopKey(targetStop.id || targetStop.code || targetStop.name)}`;
  return "";
}

function vehicleCandidateRank(vehicle, hasFreshCoordinates) {
  if (vehicle.isArriving) return 1000;
  const eta = Number.isFinite(vehicle.etaMinutes) ? Math.max(0, 300 - vehicle.etaMinutes) : 0;
  return eta + (hasFreshCoordinates ? 50 : 0);
}

function etaProgress(minutes) {
  if (!Number.isFinite(minutes)) return 0.72;
  if (minutes <= 0) return 1;
  return Math.min(0.92, Math.max(0.08, 1 - minutes / 8));
}

function arrivingVehiclesByStopForService(service) {
  const stopId = service.observedStopId;
  const arrivingVehicles = (service.arrivals || []).filter(isArrivingArrival).map(vehicleFromArrival);
  if (!stopId || !arrivingVehicles.length) return new Map();

  return new Map([[normalizeStopKey(stopId), uniqueVehicles(arrivingVehicles)]]);
}

function isArrivingArrival(arrival) {
  return Number(arrival.minutes) === 0 || String(arrival.display || "").trim().toLowerCase() === "arriving";
}

function vehicleFromArrival(arrival) {
  const liveVehicle = arrival.liveVehicle || {};
  return {
    vehiclePlate: liveVehicle.vehiclePlate || arrival.vehiclePlate || arrival.meta || "",
    coordinates: liveVehicle.coordinates,
    speed: liveVehicle.speed,
    direction: liveVehicle.direction,
    load: liveVehicle.load,
    nextStop: liveVehicle.nextStop,
    timingStatus: "Arriving"
  };
}

function vehiclesArrivingAtStop(arrivingVehiclesByStop, stop) {
  const vehicles = stopKeyCandidates(stop).flatMap((key) => arrivingVehiclesByStop.get(normalizeStopKey(key)) || []);
  return uniqueVehicles(vehicles);
}

function stopKeyCandidates(stop) {
  return [stop.id, stop.code, stop.rawId, stop.rawCode, stop.name, stop.shortName].filter(Boolean);
}

function normalizeStopKey(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueVehicles(vehicles) {
  const seen = new Set();
  return vehicles.filter((vehicle) => {
    const key = vehicleKey(vehicle);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasVehicle(vehicles, vehicle) {
  const key = vehicleKey(vehicle);
  return vehicles.some((item) => vehicleKey(item) === key);
}

function vehicleKey(vehicle) {
  return vehicle.vehiclePlate || `${vehicle.coordinates?.latitude || ""},${vehicle.coordinates?.longitude || ""},${vehicle.timingStatus || ""}`;
}

function stopForVehicle(vehicle, stops) {
  const matches = stops.filter((stop) => {
    return (
      stop.id === vehicle.nextStop?.id ||
      stop.code === vehicle.nextStop?.code ||
      stop.name === vehicle.nextStop?.name ||
      stop.shortName === vehicle.nextStop?.name
    );
  });
  return matches[matches.length - 1];
}

function isVehicleAtStop(vehicle, stop) {
  const coords = stop.coordinates;
  if (!vehicle.coordinates || !coords) return false;
  return haversine(vehicle.coordinates, coords) <= 0.045;
}

async function loadStops() {
  elements.loadStatus.textContent = "Loading stops...";

  try {
    const data = await apiGet("/stops");
    state.stops = data.stops || [];
    applyFilters();
    const routeKey = routeKeyFromHash();
    if (routeKey) await restoreRouteFromKey(routeKey, { scroll: true });
  } catch (error) {
    elements.loadStatus.textContent = "Could not load stops";
    elements.stopList.innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`;
  }
}

async function useBrowserLocation() {
  if (state.sortOrigin) {
    state.sortOrigin = null;
    applyFilters();
    return;
  }

  if (!navigator.geolocation) {
    elements.loadStatus.textContent = "Browser location is not available";
    return;
  }

  elements.locationButton.disabled = true;
  elements.locationButton.textContent = "Locating...";
  elements.loadStatus.textContent = "Requesting browser location...";

  try {
    const position = await getCurrentPosition();
    state.sortOrigin = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    };
    applyFilters();
  } catch (error) {
    elements.loadStatus.textContent = error.message || "Could not get browser location";
  } finally {
    elements.locationButton.disabled = false;
    elements.locationButton.textContent = state.sortOrigin ? "Clear Location" : "Use Location";
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    });
  });
}

function markUpdated() {
  state.lastUpdatedAt = Date.now();
  updateStatus();
}

function freshnessLabel() {
  if (!state.lastUpdatedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - state.lastUpdatedAt) / 1000));
  if (seconds < 5) return "updated just now";
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `updated ${minutes}m ago`;
}

function updateStatus() {
  const base = `${formatCount(state.filteredStops.length, "stop")} shown`;
  const pinnedCount = state.pinnedStopIds.size;
  const pinnedText = pinnedCount ? `, ${formatCount(pinnedCount, "pin")}` : "";
  const freshnessText = freshnessLabel();
  const freshness = freshnessText ? ` • ${freshnessText}` : "";
  if (!state.sortOrigin) {
    elements.loadStatus.textContent = `${formatCount(state.stops.length, "stop")} loaded${pinnedText}${freshness}`;
    elements.locationButton.textContent = "Use Location";
    return;
  }
  elements.loadStatus.textContent = `${base}, closest first${pinnedText}${freshness}`;
  elements.locationButton.textContent = "Clear Location";
}

function loadPinnedStopIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(PINNED_STOPS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function savePinnedStopIds() {
  localStorage.setItem(PINNED_STOPS_KEY, JSON.stringify([...state.pinnedStopIds]));
}

function distanceFromOrigin(stop) {
  const coords = stopCoordinates(stop);
  if (!state.sortOrigin || !coords) return Number.POSITIVE_INFINITY;
  return haversine(state.sortOrigin, coords);
}

function stopCoordinates(stop) {
  const directCandidates = [
    [stop.lat, stop.lng],
    [stop.lat, stop.lon],
    [stop.latitude, stop.longitude],
    [stop.location?.lat, stop.location?.lng],
    [stop.location?.lat, stop.location?.lon],
    [stop.location?.latitude, stop.location?.longitude],
    [stop.coordinate?.lat, stop.coordinate?.lng],
    [stop.coordinates?.latitude, stop.coordinates?.longitude]
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

function distanceLabel(distanceKm) {
  if (!Number.isFinite(distanceKm)) return "No location";
  if (distanceKm < 1) return `${Math.round(distanceKm * 1000)} m`;
  return `${distanceKm.toFixed(1)} km`;
}

function minutesLabel(minutes) {
  if (minutes === 0) return "Arriving";
  if (Number.isFinite(minutes)) return `${minutes} min`;
  return "Unknown";
}

function loadClass(value) {
  const slug = String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (slug.includes("low")) return "load-low";
  if (slug.includes("medium")) return "load-medium";
  if (slug.includes("high") || slug.includes("crowded")) return "load-high";
  return "load-unknown";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char];
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app should keep working even if the installable shell cannot be cached.
    });
  });
}

function initInstallPrompt() {
  if (!elements.installPrompt || isStandaloneApp() || wasInstallPromptDismissed()) return;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    showInstallPrompt("install");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    hideInstallPrompt(true);
  });

  if (isIosDevice()) {
    showInstallPrompt("ios");
  }
}

function showInstallPrompt(kind) {
  if (!elements.installPrompt || isStandaloneApp() || wasInstallPromptDismissed()) return;

  elements.installPrompt.dataset.kind = kind;
  elements.installTitle.textContent = kind === "ios" ? "Add this bus app" : "Use it like a bus app";
  elements.installText.textContent =
    kind === "ios" ? "On iPhone, use Share, then Add to Home Screen." : "Add it to your home screen for quick access.";
  elements.installButton.textContent = kind === "ios" ? "Got it" : "Add";
  elements.installPrompt.hidden = false;
}

async function handleInstallPromptAction() {
  if (!deferredInstallPrompt) {
    hideInstallPrompt(true);
    return;
  }

  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  promptEvent.prompt();
  const result = await promptEvent.userChoice.catch(() => null);
  if (!result || result.outcome !== "accepted") hideInstallPrompt(true);
}

function hideInstallPrompt(remember) {
  if (remember) {
    try {
      localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
    } catch {
      // Ignore storage failures; the prompt can simply reappear next visit.
    }
  }
  if (elements.installPrompt) elements.installPrompt.hidden = true;
}

function wasInstallPromptDismissed() {
  try {
    return localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

elements.searchInput.addEventListener("input", applyFilters);
elements.locationButton.addEventListener("click", useBrowserLocation);
elements.homeButton.addEventListener("click", resetBrowsingExperience);
elements.installButton?.addEventListener("click", handleInstallPromptAction);
elements.installDismiss?.addEventListener("click", () => hideInstallPrompt(true));
elements.stopList.addEventListener("click", (event) => {
  const stopCard = event.target.closest(".stop-card");

  const pinButton = event.target.closest(".pin-button");
  if (pinButton) {
    if (stopCard?.dataset.stopId) togglePinnedStop(stopCard.dataset.stopId);
    return;
  }

  const frontServiceChip = event.target.closest(".service-chip");
  if (frontServiceChip) {
    if (frontServiceChip.dataset.serviceKey && stopCard?.dataset.stopId) {
      openRouteFromStop(stopCard.dataset.stopId, frontServiceChip.dataset.serviceKey);
    }
    return;
  }

  const routeButton = event.target.closest(".service-card");
  if (routeButton) {
    if (routeButton.dataset.serviceKey) openRouteView(routeButton.dataset.serviceKey);
    return;
  }

  if (stopCard?.dataset.stopId) openStop(stopCard.dataset.stopId);
});
elements.routeBody.addEventListener("click", (event) => {
  const routeStopButton = event.target.closest(".route-stop-content");
  if (routeStopButton?.dataset.stopId) openStopFromRoute(routeStopButton.dataset.stopId);
});
window.addEventListener("popstate", handleHistoryChange);
window.addEventListener("hashchange", handleHashChange);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshVisibleData();
});

const initialRouteKey = routeKeyFromHash();
history.replaceState(initialRouteKey ? { view: "route", serviceKey: initialRouteKey } : { view: "stops" }, "", initialRouteKey ? window.location.href : window.location.pathname);
registerServiceWorker();
initInstallPrompt();
startAutoRefresh();
loadStops();
