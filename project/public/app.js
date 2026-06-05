const API_BASE = "https://api.nusbus.com/api";
const PINNED_STOPS_KEY = "nusbus-pinned-stops";
const INSTALL_PROMPT_DISMISSED_KEY = "nusbus-install-prompt-dismissed";
const REFRESH_INTERVAL_MS = 30000;
const FRESHNESS_TICK_MS = 5000;
const LOCATIONS_SOURCE = "https://map.nus.edu.sg/index.php/search/ajax_auto";
const PULL_REFRESH_THRESHOLD_PX = 72;
const PULL_REFRESH_MAX_PX = 98;
const PULL_REFRESH_HOLD_MS = 700;
const ARRIVAL_REFRESH_ANIMATION_MS = 900;
const LOGO_REFRESH_SPIN_MS = 920;

const state = {
  stops: [],
  filteredStops: [],
  filteredLocations: [],
  locations: [],
  pinnedStopIds: loadPinnedStopIds(),
  openStopId: "",
  arrivalsByStop: new Map(),
  routeServicesByKey: new Map(),
  loadingStopId: "",
  sortOrigin: null,
  activeRouteKey: "",
  activeDirectionsField: "from",
  directionsFromItem: null,
  directionsToItem: null,
  directionsResult: null,
  directionsError: "",
  directionsLoading: false,
  directionsAutoSubmitTimer: null,
  directionsLastRequestKey: "",
  isLoadingLocations: false,
  locationsLoadPromise: null,
  pullRefresh: {
    tracking: false,
    startY: 0,
    distance: 0,
    armed: false
  },
  pendingArrivalRefreshAnimation: false,
  lastUpdatedAt: null,
  isRefreshing: false
};

let refreshTimerId = null;
let freshnessTimerId = null;
let arrivalRefreshAnimationTimer = null;
let logoRefreshSpinTimer = null;
let deferredInstallPrompt = null;
const routeTimingFetches = new Set();
const routeVehicleMemory = new Map();

const elements = {
  loadStatus: document.getElementById("loadStatus"),
  searchInput: document.getElementById("searchInput"),
  appHeader: document.querySelector(".app-header"),
  controls: document.querySelector(".controls"),
  homeButton: document.getElementById("homeButton"),
  logo: document.querySelector(".logo"),
  refreshButton: document.getElementById("refreshButton"),
  pullRefreshIndicator: document.getElementById("pullRefreshIndicator"),
  mainPageHeaderLink: document.getElementById("mainPageHeaderLink"),
  directionsHeaderLink: document.getElementById("directionsHeaderLink"),
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
  routeBody: document.getElementById("routeBody"),
  directionsView: document.getElementById("directionsView"),
  directionsForm: document.getElementById("directionsForm"),
  directionsFromInput: document.getElementById("directionsFromInput"),
  directionsToInput: document.getElementById("directionsToInput"),
  directionsSwapButton: document.getElementById("directionsSwapButton"),
  directionsCurrentLocationButton: document.getElementById("directionsCurrentLocationButton"),
  directionsSubmitButton: document.getElementById("directionsSubmitButton"),
  directionsSuggestions: document.getElementById("directionsSuggestions"),
  directionsResult: document.getElementById("directionsResult")
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

function locationSearchText(location) {
  return [
    location.id,
    location.title,
    location.roomName,
    location.placeCode,
    location.buildingName,
    location.streetName,
    location.postal,
    location.categoryLabel,
    location.category,
    location.campusName
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

async function loadLocations() {
  if (state.locations.length) return state.locations;
  if (state.locationsLoadPromise) return state.locationsLoadPromise;

  state.isLoadingLocations = true;
  state.locationsLoadPromise = (async () => {
    const data = await fetchJson(new URL("/api/locations", window.location.origin));
    if (data.source !== LOCATIONS_SOURCE) {
      throw new Error("Location dataset is stale. Refresh the app to load the NUS campus map locations.");
    }
    state.locations = data.locations || [];
    return state.locations;
  })();

  try {
    return await state.locationsLoadPromise;
  } catch (error) {
    state.directionsError = error.message || "Could not load locations.";
    return [];
  } finally {
    state.isLoadingLocations = false;
    state.locationsLoadPromise = null;
  }
}

function applyFilters() {
  const query = elements.searchInput.value.trim().toLowerCase();

  const stops = [...state.stops];
  if (query) {
    stops.sort((left, right) => {
      const leftMatch = searchText(left).includes(query);
      const rightMatch = searchText(right).includes(query);
      if (leftMatch !== rightMatch) return leftMatch ? -1 : 1;
      return compareStops(left, right);
    });
  } else {
    stops.sort(compareStops);
  }

  state.filteredStops = stops;
  state.filteredLocations = [];
  renderStopList();
  updateStatus();
}

function handleSearchInput() {
  applyFilters();
}

function renderStopList() {
  if (!state.filteredStops.length) {
    elements.stopList.innerHTML = `<div class="empty-state">No stops match your search.</div>`;
    return;
  }

  elements.stopList.replaceChildren(...state.filteredStops.map(renderStopCard));
}

function renderLocationSearchCard(item) {
  const card = document.createElement("article");
  card.className = "stop-card location-card";
  card.dataset.locationItemId = item.id;

  const nearestStop = routableStopForItem(item);
  const nearestText = nearestStop ? `Nearest stop: ${nearestStop.title}` : "No nearby routable stop found";

  card.innerHTML = `
    <div class="stop-top">
      <button class="stop-button location-result-button" type="button">
        <span>
          <span class="stop-title-line">
            <strong>${escapeHtml(item.title)}</strong>
            <span class="location-type">${escapeHtml(item.raw?.categoryLabel || locationCategoryLabel(item.raw?.category))}</span>
          </span>
          <small>${escapeHtml(item.subtitle || "NUS campus location")}</small>
        </span>
      </button>
    </div>
    <div class="service-row">
      <span class="no-services">${escapeHtml(nearestText)}</span>
    </div>
  `;

  return card;
}

function renderStopCard(stop) {
  const card = document.createElement("article");
  card.dataset.stopId = stop.id;

  const isOpen = state.openStopId === stop.id;
  const isPinned = state.pinnedStopIds.has(stop.id);
  card.className = `stop-card${isOpen ? " is-open" : ""}${isPinned ? " is-pinned" : ""}`;
  const services = renderServiceChips(stop.services || []);
  const distance = state.sortOrigin ? distanceLabel(distanceFromOrigin(stop)) : "";
  const meta = stopMetaLabel(stop);

  card.innerHTML = `
    <div class="stop-top">
      <button class="stop-button" type="button" aria-expanded="${isOpen}" aria-controls="arrivals-${escapeHtml(stop.id)}">
        <span>
          <span class="stop-title-line">
            <strong>${escapeHtml(stop.title)}</strong>
          </span>
          <small>${escapeHtml(meta || stop.id)}</small>
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

function stopMetaLabel(stop) {
  const code = String(stop.busStopCode || "").trim();
  let subtitle = String(stop.subtitle || "").trim();

  if (code && subtitle) {
    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const leadingCodePattern = new RegExp(`^${escapedCode}\\s*(?:[-•·|,]\\s*)?`, "i");
    while (leadingCodePattern.test(subtitle)) {
      subtitle = subtitle.replace(leadingCodePattern, "").trim();
    }
  }

  return [code, subtitle].filter(Boolean).join(subtitle ? " • " : "");
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
      <span class="service-destination">${escapeHtml(nextStop || cleanDirectionLabel(service.subtitle) || "Campus shuttle")}</span>
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
      ${renderEtaChip(arrival.display, arrival.minutes, `arrival-time ${loadClass(loadLevel)}`)}
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
  elements.directionsView.hidden = true;
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

async function openDirectionsView(options = {}) {
  elements.appHeader.hidden = false;
  elements.controls.hidden = true;
  elements.stopsSection.hidden = true;
  elements.routeView.hidden = true;
  elements.directionsView.hidden = false;
  state.activeRouteKey = "";
  if (options.pushHistory !== false) history.pushState({ view: "directions" }, "", "#directions");
  await loadLocations();
  const restored = await restoreDirectionsFromHash();
  renderDirectionsSuggestions();
  renderDirectionsResult();
  if (restored) elements.directionsSuggestions.hidden = true;
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeDirectionsView() {
  elements.directionsView.hidden = true;
  elements.directionsSuggestions.hidden = true;
  elements.directionsResult.replaceChildren();
}

function resetBrowsingExperience() {
  state.openStopId = "";
  state.sortOrigin = null;
  elements.searchInput.value = "";
  closeDirectionsView();
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
  elements.directionsView.hidden = true;
  elements.directionsSuggestions.hidden = true;
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
  if (historyState.view === "directions" || isDirectionsHash()) {
    await openDirectionsView({ pushHistory: false, scroll: false });
    return;
  }

  const serviceKey = historyState.view === "route" ? historyState.serviceKey : routeKeyFromHash();
  if (serviceKey) {
    await restoreRouteFromKey(serviceKey, { scroll: false });
  } else {
    closeDirectionsView();
    closeRouteView();
  }
}

async function handleHashChange() {
  if (isDirectionsHash()) {
    await openDirectionsView({ pushHistory: false, scroll: true });
    return;
  }

  const serviceKey = routeKeyFromHash();
  if (serviceKey) {
    await restoreRouteFromKey(serviceKey, { scroll: true });
  } else {
    closeDirectionsView();
    closeRouteView();
    history.replaceState({ view: "stops" }, "", window.location.pathname);
  }
}

function isDirectionsHash() {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "directions" || hash.startsWith("directions?");
}

function directionsHashParams() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("directions?")) return new URLSearchParams();
  return new URLSearchParams(hash.slice("directions?".length));
}

function directionItemById(itemId) {
  return directionItems().find((item) => item.id === itemId) || null;
}

async function restoreDirectionsFromHash() {
  const params = directionsHashParams();
  const fromId = params.get("from");
  const toId = params.get("to");
  if (!fromId || !toId) return false;

  const fromItem = directionItemById(fromId);
  const toItem = directionItemById(toId);
  if (!fromItem || !toItem) return false;

  state.directionsFromItem = fromItem;
  state.directionsToItem = toItem;
  elements.directionsFromInput.value = fromItem.title;
  elements.directionsToInput.value = toItem.title;
  state.activeDirectionsField = "from";
  await findDirections(null, { pushHistory: false });
  return true;
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

function directionItems() {
  return [...state.stops.map(stopToDirectionItem), ...state.locations.map(locationToDirectionItem)];
}

function stopToDirectionItem(stop) {
  return {
    id: `stop:${stop.id}`,
    type: "stop",
    title: stop.title,
    subtitle: [stop.busStopCode && `Stop ${stop.busStopCode}`, stop.subtitle].filter(Boolean).join(" - "),
    shortLabel: stop.shortLabel || "",
    services: stop.services || [],
    coordinates: stopCoordinates(stop),
    raw: stop
  };
}

function locationToDirectionItem(location) {
  return {
    id: `venue:${location.id}`,
    type: "venue",
    title: location.title || location.id,
    subtitle: [
      location.roomName,
      location.categoryLabel || locationCategoryLabel(location.category),
      location.campusName,
      location.coordinates ? "" : "No map location"
    ]
      .filter(Boolean)
      .join(" - "),
    shortLabel: location.placeCode || location.roomName || "",
    services: [],
    coordinates: location.coordinates,
    raw: location
  };
}

function directionInputValue(field) {
  return field === "from" ? elements.directionsFromInput.value : elements.directionsToInput.value;
}

function setDirectionInputValue(field, value) {
  const input = field === "from" ? elements.directionsFromInput : elements.directionsToInput;
  input.value = value;
}

function selectedDirectionItem(field) {
  return field === "from" ? state.directionsFromItem : state.directionsToItem;
}

function setSelectedDirectionItem(field, item) {
  if (field === "from") {
    state.directionsFromItem = item;
  } else {
    state.directionsToItem = item;
  }
}

function clearDirectionsRequestState() {
  state.directionsResult = null;
  state.directionsError = "";
  state.directionsLastRequestKey = "";
}

function directionSuggestions(query, limit = 10) {
  const items = directionItems();
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items.slice(0, limit);

  return items
    .map((item) => ({ item, score: directionScore(item, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (left.item.type !== right.item.type) return left.item.type === "stop" ? -1 : 1;
      return left.item.title.localeCompare(right.item.title, undefined, { numeric: true });
    })
    .slice(0, limit)
    .map((entry) => entry.item);
}

function nearbyDirectionSuggestions(origin, limit = 10) {
  return directionItems()
    .map((item) => {
      const distance = item.coordinates ? haversine(origin, item.coordinates) : Number.POSITIVE_INFINITY;
      return { item, distance };
    })
    .filter((entry) => Number.isFinite(entry.distance))
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      if (left.item.type !== right.item.type) return left.item.type === "stop" ? -1 : 1;
      return left.item.title.localeCompare(right.item.title, undefined, { numeric: true });
    })
    .slice(0, limit)
    .map((entry) => ({
      ...entry.item,
      nearbyDistance: entry.distance,
      subtitle: `${distanceLabel(entry.distance)} away - ${entry.item.subtitle || (entry.item.type === "venue" ? "NUS campus location" : "Bus stop")}`
    }));
}

function directionScore(item, query) {
  const fields = [
    [item.title, 900],
    [item.raw?.id, item.type === "stop" ? 1200 : 760],
    [item.raw?.busStopCode, 680],
    [item.raw?.placeCode, 720],
    [item.raw?.buildingName, 580],
    [item.raw?.streetName, 320],
    [item.raw?.postal, 260],
    [item.raw?.categoryLabel, 180],
    [item.raw?.category, 120],
    [item.shortLabel, 460],
    [item.subtitle, 260],
    ...item.services.map((service) => [service.name, 140])
  ];
  let score = item.type === "stop" ? 20 : 0;

  for (const [field, weight] of fields) {
    const value = String(field || "").toLowerCase();
    if (!value) continue;
    if (value === query) score += weight + 220;
    else if (value.startsWith(query)) score += weight;
    else if (value.includes(query)) score += Math.floor(weight * 0.55);
  }

  return score;
}

function exactDirectionMatch(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return directionItems().find((item) => {
    return [item.title, item.raw?.id, item.raw?.busStopCode, item.raw?.placeCode, item.raw?.postal, item.shortLabel].some((value) => {
      return String(value || "").trim().toLowerCase() === normalized;
    });
  });
}

function renderDirectionsSuggestions() {
  const activeField = state.activeDirectionsField;
  const query = directionInputValue(activeField);
  const suggestions = directionSuggestions(query);

  if (elements.directionsView.hidden || state.directionsResult || !suggestions.length) {
    elements.directionsSuggestions.hidden = true;
    elements.directionsSuggestions.replaceChildren();
    return;
  }

  elements.directionsSuggestions.hidden = false;
  elements.directionsSuggestions.replaceChildren(...suggestions.map(renderDirectionSuggestion));
}

async function suggestNearbyDirectionsItems() {
  if (!navigator.geolocation) {
    state.directionsError = "Browser location is not available.";
    renderDirectionsResult();
    return;
  }

  elements.directionsCurrentLocationButton.disabled = true;
  elements.directionsCurrentLocationButton.classList.add("is-loading");
  state.directionsError = "";
  state.directionsResult = null;
  renderDirectionsResult();

  try {
    await loadLocations();
    const position = await getCurrentPosition();
    const origin = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    };
    const suggestions = nearbyDirectionSuggestions(origin);
    if (!suggestions.length) {
      state.directionsError = "No nearby campus locations or stops found.";
      renderDirectionsResult();
      return;
    }
    elements.directionsSuggestions.hidden = false;
    elements.directionsSuggestions.replaceChildren(...suggestions.map(renderDirectionSuggestion));
    elements.directionsResult.replaceChildren();
  } catch (error) {
    state.directionsError = error.message || "Could not get browser location.";
    renderDirectionsResult();
  } finally {
    elements.directionsCurrentLocationButton.disabled = false;
    elements.directionsCurrentLocationButton.classList.remove("is-loading");
  }
}

function renderDirectionSuggestion(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "direction-suggestion";
  button.dataset.itemId = item.id;
  button.innerHTML = `
    <span class="direction-suggestion-icon" aria-hidden="true">${item.type === "venue" ? "⌂" : "BUS"}</span>
    <span>
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(item.subtitle || (item.type === "venue" ? "NUS venue" : "Bus stop"))}</small>
    </span>
  `;
  return button;
}

function pickDirectionSuggestion(itemId) {
  const item = directionItems().find((candidate) => candidate.id === itemId);
  if (!item) return;

  const field = state.activeDirectionsField;
  setSelectedDirectionItem(field, item);
  setDirectionInputValue(field, item.title);
  clearDirectionsRequestState();
  state.activeDirectionsField = field === "from" ? "to" : "from";
  renderDirectionsSuggestions();
  renderDirectionsResult();
  (state.activeDirectionsField === "from" ? elements.directionsFromInput : elements.directionsToInput).focus();
  scheduleDirectionsAutoSubmit();
}

async function useLocationSearchResult(itemId) {
  const item = directionItems().find((candidate) => candidate.id === itemId);
  if (!item) return;

  state.directionsFromItem = null;
  state.directionsToItem = item;
  elements.directionsFromInput.value = "";
  elements.directionsToInput.value = item.title;
  state.activeDirectionsField = "from";
  clearDirectionsRequestState();
  await openDirectionsView({ pushHistory: true });
  elements.directionsFromInput.focus();
}

function resolveDirectionItem(field) {
  const selected = selectedDirectionItem(field);
  if (selected) return selected;
  return exactDirectionMatch(directionInputValue(field));
}

function routableStopForItem(item) {
  if (!item) return null;
  if (item.type === "stop") return item.raw;

  const coords = item.coordinates;
  if (!coords) return null;
  const routableStops = state.stops.filter(isRoutableNusStop);
  const candidates = routableStops.length ? routableStops : state.stops;
  return candidates
    .map((stop) => {
      const stopCoords = stopCoordinates(stop);
      return { stop, distance: stopCoords ? haversine(coords, stopCoords) : Number.POSITIVE_INFINITY };
    })
    .filter((entry) => Number.isFinite(entry.distance))
    .sort((left, right) => left.distance - right.distance)[0]?.stop || null;
}

function isRoutableNusStop(stop) {
  if (stop.sourceModes?.nus) return true;
  return (stop.services || []).some((service) => service.source === "nus" || String(service.key || "").startsWith("nus:"));
}

async function findDirections(event, options = {}) {
  event?.preventDefault();
  state.directionsError = "";

  const fromItem = resolveDirectionItem("from");
  const toItem = resolveDirectionItem("to");
  const fromStop = routableStopForItem(fromItem);
  const toStop = routableStopForItem(toItem);
  const requestKey = fromStop && toStop ? `${fromStop.id}->${toStop.id}` : "";

  if (!fromItem || !toItem || !fromStop || !toStop) {
    state.directionsResult = null;
    if (fromItem && !fromStop) {
      state.directionsError = `No nearby bus stop location is available for ${fromItem.title}.`;
    } else if (toItem && !toStop) {
      state.directionsError = `No nearby bus stop location is available for ${toItem.title}.`;
    } else {
      state.directionsError = "Select both a start and an end point from the suggestions.";
    }
    renderDirectionsResult();
    return;
  }

  if (!options.force && requestKey && requestKey === state.directionsLastRequestKey && state.directionsResult) return;
  state.directionsLastRequestKey = requestKey;
  state.directionsResult = null;
  state.directionsLoading = true;
  renderDirectionsResult();

  try {
    const directions = await apiGet("/directions", {
      fromStopId: fromStop.id,
      toStopId: toStop.id
    });
    state.directionsResult = {
      directions,
      fromItem,
      toItem,
      fromStop,
      toStop
    };
    elements.directionsSuggestions.hidden = true;
    elements.directionsSuggestions.replaceChildren();
    if (options.pushHistory !== false) pushDirectionsGuideHistory(fromItem, toItem);
    markUpdated();
  } catch (error) {
    state.directionsError = error.message || "Could not find a route.";
  } finally {
    state.directionsLoading = false;
    renderDirectionsResult();
  }
}

function pushDirectionsGuideHistory(fromItem, toItem) {
  const hash = `#directions?from=${encodeURIComponent(fromItem.id)}&to=${encodeURIComponent(toItem.id)}`;
  const stateObject = { view: "directions", from: fromItem.id, to: toItem.id };
  if (window.location.hash === hash) {
    history.replaceState(stateObject, "", hash);
    return;
  }
  history.pushState(stateObject, "", hash);
}

function swapDirections() {
  const fromItem = state.directionsFromItem;
  const fromValue = elements.directionsFromInput.value;
  state.directionsFromItem = state.directionsToItem;
  elements.directionsFromInput.value = elements.directionsToInput.value;
  state.directionsToItem = fromItem;
  elements.directionsToInput.value = fromValue;
  state.activeDirectionsField = state.directionsFromItem ? "to" : "from";
  clearDirectionsRequestState();
  renderDirectionsSuggestions();
  renderDirectionsResult();
  scheduleDirectionsAutoSubmit();
}

function scheduleDirectionsAutoSubmit() {
  window.clearTimeout(state.directionsAutoSubmitTimer);
  state.directionsAutoSubmitTimer = window.setTimeout(() => {
    if (elements.directionsView.hidden || state.directionsLoading) return;
    const fromItem = resolveDirectionItem("from");
    const toItem = resolveDirectionItem("to");
    if (!fromItem || !toItem) return;
    if (!routableStopForItem(fromItem) || !routableStopForItem(toItem)) return;
    findDirections();
  }, 250);
}

function renderDirectionsResult() {
  if (elements.directionsView.hidden) return;

  if (state.directionsLoading) {
    elements.directionsResult.innerHTML = `<div class="empty-state compact">Finding route...</div>`;
    return;
  }

  if (state.directionsError) {
    elements.directionsResult.innerHTML = `<div class="empty-state compact error">${escapeHtml(state.directionsError)}</div>`;
    return;
  }

  const result = state.directionsResult;
  if (!result) {
    if (!elements.directionsSuggestions.hidden) {
      elements.directionsResult.replaceChildren();
      return;
    }
    elements.directionsResult.innerHTML = `<div class="empty-state compact">Choose two locations to preview the best route.</div>`;
    return;
  }

  elements.directionsResult.innerHTML = renderDirectionsPlan(result);
}

function renderDirectionsPlan(result) {
  const { directions, fromItem, toItem, fromStop, toStop } = result;
  const legs = directions.legs || [];
  const summary = legs.length ? legs.map((leg) => leg.routeCode).join(" → ") : "Same stop";
  const stopCount = legs.reduce((count, leg) => count + Math.max(0, (leg.stops || []).length - 1), 0);
  const transfers = directions.transfers || 0;
  const stopText = formatCount(stopCount, "stop");
  const routeMeta = renderDirectionsMeta(transfers, stopText);
  const nearestNotes = [
    fromItem.type === "venue" ? `${fromItem.title} → ${fromStop.title}` : "",
    toItem.type === "venue" ? `${toItem.title} → ${toStop.title}` : ""
  ].filter(Boolean);
  const stopAdvisory = renderDirectionsStopAdvisory(nearestNotes);

  if (!legs.length) {
    return `
      ${stopAdvisory}
      <section class="directions-plan-card">
        <header class="directions-plan-head">
          <div>
            <h3>${escapeHtml(directions.fromStop.title)} → ${escapeHtml(directions.toStop.title)}</h3>
            <p>No bus ride needed.</p>
          </div>
        </header>
      </section>
    `;
  }

  return `
    ${stopAdvisory}
    <section class="directions-plan-card">
      <header class="directions-plan-head">
        <div>
          <h3>${escapeHtml(directions.fromStop.title)} → ${escapeHtml(directions.toStop.title)}</h3>
          <p>${routeMeta}</p>
        </div>
      </header>
      <div class="directions-leg-list">
        ${legs.map(renderDirectionsLeg).join("")}
      </div>
    </section>
  `;
}

function renderDirectionsStopAdvisory(notes) {
  if (!notes.length) return "";
  return `
    <aside class="directions-stop-advisory">
      <strong>Closest bus stops</strong>
      <span>${notes.map(escapeHtml).join(" - ")}</span>
    </aside>
  `;
}

function renderDirectionsMeta(transfers, stopText) {
  const transferText = formatCount(transfers, "transfer");
  if (transfers <= 1) return `${escapeHtml(transferText)} - ${escapeHtml(stopText)}`;
  return `<span class="directions-transfer-count">${escapeHtml(transferText)}</span> - ${escapeHtml(stopText)}`;
}

function renderDirectionsRouteBadge(routeCode, className = "") {
  const color = routeColorForCode(routeCode);
  return `<span class="route-badge ${escapeHtml(className)}" style="background:${escapeHtml(color.background)};color:${escapeHtml(color.text)}">${escapeHtml(routeCode)}</span>`;
}

function renderDirectionsLeg(leg, index) {
  const stopCount = Math.max(0, (leg.stops || []).length - 1);
  return `
    <article class="directions-leg">
      ${renderDirectionsRouteBadge(leg.routeCode, "directions-leg-route")}
      <div class="directions-leg-body">
        <div class="directions-leg-top">
          <strong>${escapeHtml(leg.fromStop.title)} → ${escapeHtml(leg.toStop.title)}</strong>
          <span>${escapeHtml(formatCount(stopCount, "stop"))}</span>
        </div>
        <div class="directions-arrival-chips" aria-label="${escapeHtml(leg.routeCode)} arrival timings">
          ${(leg.boardingArrivals || []).slice(0, 3).map(renderDirectionsArrivalChip).join("")}
        </div>
        ${renderDirectionsStopTrail(leg.stops || [])}
        ${index > 0 ? `<p class="directions-transfer-note">Board after transfer</p>` : ""}
      </div>
    </article>
  `;
}

function routeColorForCode(routeCode) {
  const normalized = String(routeCode || "").trim().toLowerCase();
  const service = state.stops.flatMap((stop) => stop.services || []).find((candidate) => {
    return String(candidate.name || "").trim().toLowerCase() === normalized || String(candidate.key || "").split(":").pop().trim().toLowerCase() === normalized;
  });
  return {
    background: service?.color?.background || "#2f6f68",
    text: service?.color?.text || "#ffffff"
  };
}

function renderDirectionsArrivalChip(arrival) {
  const loadLevel = arrival.liveVehicle?.load?.crowdLevel || arrival.liveVehicle?.load?.crowdLabel;
  return renderEtaChip(arrival.display, arrival.minutes, `route-stop-eta ${loadClass(loadLevel)}`);
}

function renderDirectionsStopTrail(stops) {
  if (!stops.length) return "";
  return `
    <ol class="directions-stop-trail">
      ${stops.map((stop) => {
        const stopId = stop.id || stop.code || stop.name || "";
        const label = stop.shortLabel || stop.title || stop.id;
        return `
          <li>
            <a class="directions-stop-link" href="#stop=${encodeURIComponent(stopId)}" data-stop-id="${escapeHtml(stopId)}">${escapeHtml(label)}</a>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}

function locationCategoryLabel(category) {
  return String(category || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function refreshStopsList() {
  const data = await apiGet("/stops");
  state.stops = data.stops || [];
  markUpdated();
  applyFilters();
}

async function refreshVisibleData(options = {}) {
  if (state.isRefreshing) return;
  const includeStops = options.includeStops === true;
  if (!state.activeRouteKey && !state.openStopId) {
    if (state.directionsResult && !elements.directionsView.hidden) {
      state.isRefreshing = true;
      updateStatus();
      try {
        await findDirections(null, { pushHistory: false, force: true });
      } catch {
        // Keep the last good route visible when a refresh fails.
      } finally {
        state.isRefreshing = false;
        updateStatus();
        flushPendingArrivalRefreshAnimation();
      }
      return;
    }

    if (includeStops) {
      state.isRefreshing = true;
      updateStatus();
      try {
        await refreshStopsList();
      } catch {
        // Keep the current stop list visible when a refresh fails.
      } finally {
        state.isRefreshing = false;
        updateStatus();
        flushPendingArrivalRefreshAnimation();
      }
      return;
    }

    updateStatus();
    return;
  }

  state.isRefreshing = true;
  updateStatus();
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
    flushPendingArrivalRefreshAnimation();
  }
}

function handleManualRefresh() {
  triggerLogoRefreshSpin();
  refreshVisibleData({ includeStops: true });
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
    cleanDirectionLabel(route.destination),
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

function cleanDirectionLabel(label) {
  return String(label || "").replace(/^towards\s+/i, "").trim();
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
    return renderEtaChip(isLoadingStopTimings ? "..." : "No bus", Number.NaN, "route-stop-eta is-muted");
  }

  const load = arrival.liveVehicle?.load?.crowdLabel;
  const loadLevel = arrival.liveVehicle?.load?.crowdLevel || load;
  const vehicle = arrival.vehiclePlate || arrival.meta;
  const detail = [vehicle, load && `${load} load`].filter(Boolean).join(" - ");
  return renderEtaChip(arrival.display, arrival.minutes, `route-stop-eta ${loadClass(loadLevel)}`, detail || "Next bus");
}

function renderEtaChip(display, minutes, className, title = "") {
  const eta = etaParts(display, minutes);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  if (eta.unit) {
    return `<strong class="${escapeHtml(className)}"${titleAttr}><span class="eta-number">${escapeHtml(eta.value)}</span><span class="eta-unit">${escapeHtml(eta.unit)}</span></strong>`;
  }
  return `<strong class="${escapeHtml(className)} is-text"${titleAttr}>${escapeHtml(eta.value)}</strong>`;
}

function etaParts(display, minutes) {
  const label = String(display || minutesLabel(minutes)).trim();
  if (minutes === 0 || label.toLowerCase() === "arriving") return { value: "Arr", unit: "" };
  if (Number.isFinite(minutes)) return { value: String(Math.min(999, Math.max(0, Math.round(minutes)))), unit: "min" };

  const match = label.match(/^(\d{1,3})\s*(min|mins|minutes?)?$/i);
  if (match) return { value: match[1], unit: "min" };
  if (label === "...") return { value: "...", unit: "" };
  return { value: label.slice(0, 3), unit: "" };
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
  const leftJitter = [42, 52, 62][vehicleIndex % 3];
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
    markUpdated();
    applyFilters();
    if (isDirectionsHash()) {
      await openDirectionsView({ pushHistory: false, scroll: true });
      return;
    }
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
  elements.locationButton.classList.add("is-loading");
  elements.locationButton.setAttribute("aria-label", "Locating...");
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
    elements.locationButton.classList.remove("is-loading");
    elements.locationButton.setAttribute("aria-label", state.sortOrigin ? "Clear current location sort" : "Use current location");
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
  const hadPreviousUpdate = Boolean(state.lastUpdatedAt);
  state.lastUpdatedAt = Date.now();
  updateStatus();
  if (!hadPreviousUpdate) return;
  if (state.isRefreshing) {
    state.pendingArrivalRefreshAnimation = true;
    return;
  }
  triggerArrivalRefreshAnimation();
}

function triggerArrivalRefreshAnimation() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  clearTimeout(arrivalRefreshAnimationTimer);
  document.body.classList.remove("arrivals-just-refreshed");
  requestAnimationFrame(() => {
    document.body.classList.add("arrivals-just-refreshed");
    arrivalRefreshAnimationTimer = setTimeout(() => {
      document.body.classList.remove("arrivals-just-refreshed");
    }, ARRIVAL_REFRESH_ANIMATION_MS);
  });
}

function flushPendingArrivalRefreshAnimation() {
  if (!state.pendingArrivalRefreshAnimation) return;
  state.pendingArrivalRefreshAnimation = false;
  triggerArrivalRefreshAnimation();
}

function triggerLogoRefreshSpin() {
  if (!elements.logo || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  clearTimeout(logoRefreshSpinTimer);
  elements.logo.classList.remove("is-spinning");
  requestAnimationFrame(() => {
    elements.logo.classList.add("is-spinning");
    logoRefreshSpinTimer = setTimeout(() => {
      elements.logo.classList.remove("is-spinning");
    }, LOGO_REFRESH_SPIN_MS);
  });
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
  const freshnessText = freshnessLabel();
  elements.loadStatus.textContent = freshnessText || "Updating...";
  updateRefreshUi();
  if (!state.sortOrigin) {
    elements.locationButton.setAttribute("aria-label", "Use current location");
    return;
  }
  elements.locationButton.setAttribute("aria-label", "Clear current location sort");
}

function updateRefreshUi() {
  if (!elements.refreshButton) return;
  elements.refreshButton.disabled = state.isRefreshing;
  elements.refreshButton.classList.toggle("is-refreshing", state.isRefreshing);
  elements.refreshButton.setAttribute("aria-label", state.isRefreshing ? "Refreshing arrival data" : "Refresh arrival data");
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
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch(() => {
        // The app should keep working even if the installable shell cannot be cached.
      });
  });

  let isReloadingForServiceWorker = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (isReloadingForServiceWorker) return;
    isReloadingForServiceWorker = true;
    window.location.reload();
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

function isPullRefreshAvailable() {
  return window.matchMedia("(max-width: 620px) and (pointer: coarse)").matches;
}

function isPullRefreshIgnoredTarget(target) {
  return Boolean(target.closest("input, textarea, select"));
}

function handlePullRefreshStart(event) {
  if (!isPullRefreshAvailable() || state.isRefreshing || window.scrollY > 0 || event.touches.length !== 1) return;
  if (isPullRefreshIgnoredTarget(event.target)) return;

  state.pullRefresh.tracking = true;
  state.pullRefresh.startY = event.touches[0].clientY;
  state.pullRefresh.distance = 0;
  state.pullRefresh.armed = false;
}

function handlePullRefreshMove(event) {
  if (!state.pullRefresh.tracking || event.touches.length !== 1) return;

  const distance = event.touches[0].clientY - state.pullRefresh.startY;
  if (distance <= 0) {
    resetPullRefreshIndicator();
    return;
  }

  event.preventDefault();
  const easedDistance = Math.min(PULL_REFRESH_MAX_PX, distance * 0.62);
  const armed = distance >= PULL_REFRESH_THRESHOLD_PX;
  state.pullRefresh.distance = easedDistance;
  state.pullRefresh.armed = armed;
  updatePullRefreshIndicator(easedDistance, armed);
}

function handlePullRefreshEnd() {
  if (!state.pullRefresh.tracking) return;
  const shouldRefresh = state.pullRefresh.armed;
  resetPullRefreshIndicator({ keepVisible: shouldRefresh });
  if (!shouldRefresh) return;

  triggerLogoRefreshSpin();
  refreshVisibleData({ includeStops: true }).finally(() => {
    holdPullRefreshIndicator();
  });
}

function updatePullRefreshIndicator(distance, armed) {
  if (!elements.pullRefreshIndicator) return;
  document.body.classList.add("is-pulling-refresh");
  elements.pullRefreshIndicator.style.setProperty("--pull-offset", `${Math.round(Math.min(distance, PULL_REFRESH_MAX_PX))}px`);
  elements.pullRefreshIndicator.classList.add("is-visible");
  elements.pullRefreshIndicator.classList.toggle("is-armed", armed);
  elements.pullRefreshIndicator.classList.toggle("is-refreshing", false);
  elements.pullRefreshIndicator.querySelector("span").textContent = armed ? "Release to refresh" : "Pull to refresh";
}

function resetPullRefreshIndicator(options = {}) {
  state.pullRefresh.tracking = false;
  state.pullRefresh.startY = 0;
  state.pullRefresh.distance = 0;
  state.pullRefresh.armed = false;
  document.body.classList.remove("is-pulling-refresh");
  if (!elements.pullRefreshIndicator) return;

  if (options.keepVisible) {
    elements.pullRefreshIndicator.style.setProperty("--pull-offset", "62px");
    elements.pullRefreshIndicator.classList.add("is-visible", "is-refreshing");
    elements.pullRefreshIndicator.classList.remove("is-armed", "is-complete");
    elements.pullRefreshIndicator.querySelector("span").textContent = "Refreshing";
    return;
  }

  elements.pullRefreshIndicator.style.removeProperty("--pull-offset");
  elements.pullRefreshIndicator.classList.remove("is-visible", "is-armed", "is-refreshing", "is-complete");
  elements.pullRefreshIndicator.querySelector("span").textContent = "Pull to refresh";
}

function holdPullRefreshIndicator() {
  if (!elements.pullRefreshIndicator) return;
  elements.pullRefreshIndicator.style.setProperty("--pull-offset", "62px");
  elements.pullRefreshIndicator.classList.add("is-visible", "is-complete");
  elements.pullRefreshIndicator.classList.remove("is-armed", "is-refreshing");
  elements.pullRefreshIndicator.querySelector("span").textContent = "Updated";
  setTimeout(() => resetPullRefreshIndicator(), PULL_REFRESH_HOLD_MS);
}

elements.searchInput.addEventListener("input", handleSearchInput);
elements.locationButton.addEventListener("click", useBrowserLocation);
elements.homeButton.addEventListener("click", resetBrowsingExperience);
elements.refreshButton.addEventListener("click", handleManualRefresh);
elements.mainPageHeaderLink.addEventListener("click", resetBrowsingExperience);
elements.directionsHeaderLink.addEventListener("click", () => {
  openDirectionsView({ pushHistory: !isDirectionsHash() });
});
elements.installButton?.addEventListener("click", handleInstallPromptAction);
elements.installDismiss?.addEventListener("click", () => hideInstallPrompt(true));
elements.directionsFromInput.addEventListener("focus", () => {
  state.activeDirectionsField = "from";
  renderDirectionsSuggestions();
  loadLocations().then(renderDirectionsSuggestions);
});
elements.directionsToInput.addEventListener("focus", () => {
  state.activeDirectionsField = "to";
  renderDirectionsSuggestions();
  loadLocations().then(renderDirectionsSuggestions);
});
elements.directionsFromInput.addEventListener("input", () => {
  state.activeDirectionsField = "from";
  state.directionsFromItem = null;
  clearDirectionsRequestState();
  renderDirectionsSuggestions();
  loadLocations().then(() => {
    renderDirectionsSuggestions();
    scheduleDirectionsAutoSubmit();
  });
  renderDirectionsResult();
});
elements.directionsToInput.addEventListener("input", () => {
  state.activeDirectionsField = "to";
  state.directionsToItem = null;
  clearDirectionsRequestState();
  renderDirectionsSuggestions();
  loadLocations().then(() => {
    renderDirectionsSuggestions();
    scheduleDirectionsAutoSubmit();
  });
  renderDirectionsResult();
});
elements.directionsSuggestions.addEventListener("click", (event) => {
  const suggestion = event.target.closest(".direction-suggestion");
  if (suggestion?.dataset.itemId) pickDirectionSuggestion(suggestion.dataset.itemId);
});
elements.directionsForm.addEventListener("submit", findDirections);
elements.directionsSwapButton.addEventListener("click", swapDirections);
elements.directionsCurrentLocationButton.addEventListener("click", suggestNearbyDirectionsItems);
elements.stopList.addEventListener("click", (event) => {
  const locationCard = event.target.closest(".location-card");
  if (locationCard?.dataset.locationItemId) {
    useLocationSearchResult(locationCard.dataset.locationItemId);
    return;
  }

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
elements.directionsResult.addEventListener("click", (event) => {
  const stopLink = event.target.closest(".directions-stop-link");
  if (!stopLink?.dataset.stopId) return;
  event.preventDefault();
  openStopFromRoute(stopLink.dataset.stopId);
});
window.addEventListener("popstate", handleHistoryChange);
window.addEventListener("hashchange", handleHashChange);
window.addEventListener("touchstart", handlePullRefreshStart, { passive: true });
window.addEventListener("touchmove", handlePullRefreshMove, { passive: false });
window.addEventListener("touchend", handlePullRefreshEnd, { passive: true });
window.addEventListener("touchcancel", () => resetPullRefreshIndicator(), { passive: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshVisibleData();
});

const initialRouteKey = routeKeyFromHash();
const initialState = isDirectionsHash() ? { view: "directions" } : initialRouteKey ? { view: "route", serviceKey: initialRouteKey } : { view: "stops" };
history.replaceState(initialState, "", initialRouteKey || isDirectionsHash() ? window.location.href : window.location.pathname);
registerServiceWorker();
initInstallPrompt();
startAutoRefresh();
loadStops();
