import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCATIONS_SOURCE = "https://map.nus.edu.sg/index.php/search/ajax_auto";
export const NUSMODS_VENUE_LOCATIONS_SOURCE =
  "https://raw.githubusercontent.com/nusmodifications/nusmods/master/website/src/data/venues.json";
export const DEFAULT_OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/data/nus-map-locations.json"
);
export const DEFAULT_NUSMODS_OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/data/nusmods-venues.json"
);

const EXCLUDED_TABLES = new Set(["bus_stop", "lecture"]);
const CLASS_VENUE_PATTERN = /\b(?:class(?:room)?|lecture|seminar|tutorial)\b/i;

function cleanText(value) {
  return value == null ? "" : String(value).trim().replace(/\s+/g, " ");
}

function slugify(value) {
  return cleanText(value)
    // The legacy endpoint contains mojibake such as "CafÃƒÂ©". Treat each
    // non-ASCII run as a separator so those broken bytes do not leak into IDs.
    .replace(/[^\x00-\x7f]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function categoryLabel(category) {
  return cleanText(category)
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeLocation(record) {
  const category = cleanText(record?.tbl).toLowerCase();
  const title = cleanText(record?.place_name || record?.building_name);
  const latitude = Number(record?.lat);
  const longitude = Number(record?.long);

  if (
    !category ||
    !title ||
    EXCLUDED_TABLES.has(category) ||
    CLASS_VENUE_PATTERN.test(title) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  const sourceId = cleanText(record.id || record.building_id);
  const buildingName = cleanText(record.building_name);
  const streetName = cleanText(record.street_name);

  return {
    id: `${category}:${sourceId || "unknown"}:${slugify(title)}`,
    type: "venue",
    title,
    roomName: cleanText(record.location_name) || buildingName || streetName,
    category,
    categoryLabel: categoryLabel(category),
    campusName: cleanText(record.campus_name),
    placeCode: cleanText(record.place_code),
    buildingName,
    streetName,
    block: cleanText(record.block),
    postal: cleanText(record.postal),
    unitNo: cleanText(record.unit_no),
    coordinates: { latitude, longitude },
    sourceId,
    sourceTable: category
  };
}

export function buildLocationDataset(records, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(records)) throw new Error("Expected the NUS map endpoint to return an array.");

  const locationsById = new Map();
  for (const record of records) {
    const location = normalizeLocation(record);
    if (location && !locationsById.has(location.id)) locationsById.set(location.id, location);
  }

  const locations = [...locationsById.values()].sort((left, right) => {
    const titleOrder = left.title.localeCompare(right.title, undefined, {
      numeric: true,
      sensitivity: "base"
    });
    return titleOrder || left.id.localeCompare(right.id);
  });

  if (!locations.length) throw new Error("The NUS map endpoint returned no usable campus locations.");

  return {
    generatedAt,
    source: LOCATIONS_SOURCE,
    note: "Normalized from the NUS campus map autocomplete endpoint. Bus stop and lecture-theatre records are excluded because the app loads official bus stops from the NUSBus API and directions autocomplete should target places/buildings rather than class venues.",
    count: locations.length,
    excludedCount: records.length - locations.length,
    locations
  };
}

export function nusModsTerm(date = new Date()) {
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();

  if (month >= 7) return { academicYear: `${year}-${year + 1}`, semester: 1 };
  if (month <= 3) return { academicYear: `${year - 1}-${year}`, semester: 2 };
  if (month === 4 || (month === 5 && date.getUTCDate() < 20)) {
    return { academicYear: `${year - 1}-${year}`, semester: 3 };
  }
  return { academicYear: `${year - 1}-${year}`, semester: 4 };
}

export function nusModsSemesterVenuesSource(term = nusModsTerm()) {
  return `https://api.nusmods.com/v2/${term.academicYear}/semesters/${term.semester}/venues.json`;
}

export function normalizeNusModsVenue(code, details = {}, activeThisSemester = false) {
  const venueCode = cleanText(code);
  if (!venueCode) return null;

  const longitude = Number(details.location?.x);
  const latitude = Number(details.location?.y);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const floor = details.floor == null ? "" : cleanText(details.floor);

  return {
    id: `nusmods:${venueCode}`,
    type: "venue",
    title: venueCode,
    roomName: cleanText(details.roomName) || "NUSMods venue",
    category: "nusmods_venue",
    categoryLabel: "NUSMods Venue",
    campusName: "",
    placeCode: venueCode,
    buildingName: "",
    streetName: "",
    block: "",
    postal: "",
    unitNo: floor ? `Floor ${floor}` : "",
    coordinates: hasCoordinates ? { latitude, longitude } : null,
    floor,
    activeThisSemester,
    sourceId: venueCode,
    sourceTable: "nusmods_venue"
  };
}

export function buildNusModsVenueDataset(
  venueLocations,
  semesterVenues,
  term = nusModsTerm(),
  generatedAt = new Date().toISOString()
) {
  if (!venueLocations || Array.isArray(venueLocations) || typeof venueLocations !== "object") {
    throw new Error("Expected the NUSMods venue map to be an object.");
  }
  if (!Array.isArray(semesterVenues)) {
    throw new Error("Expected the NUSMods semester venue list to be an array.");
  }

  const activeVenues = new Set(semesterVenues.map(cleanText).filter(Boolean));
  const venueCodes = new Set([...Object.keys(venueLocations), ...activeVenues]);
  const locations = [...venueCodes]
    .map((code) => normalizeNusModsVenue(code, venueLocations[code], activeVenues.has(code)))
    .filter(Boolean)
    .sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true }));

  return {
    generatedAt,
    sources: {
      venueLocations: NUSMODS_VENUE_LOCATIONS_SOURCE,
      semesterVenues: nusModsSemesterVenuesSource(term)
    },
    academicYear: term.academicYear,
    semester: term.semester,
    note: "NUSMods venue codes and its curated venue map, cached locally for directions search. Records without coordinates remain searchable but cannot be used for route planning.",
    count: locations.length,
    coordinateCount: locations.filter((location) => location.coordinates).length,
    activeSemesterCount: activeVenues.size,
    locations
  };
}

export async function refreshLocations(outputPath = DEFAULT_OUTPUT_PATH) {
  const term = nusModsTerm();
  const semesterVenuesSource = nusModsSemesterVenuesSource(term);
  const [mapResponse, nusModsLocationsResponse, nusModsSemesterResponse] = await Promise.all([
    fetch(LOCATIONS_SOURCE, { headers: { accept: "application/json" } }),
    fetch(NUSMODS_VENUE_LOCATIONS_SOURCE, { headers: { accept: "application/json" } }),
    fetch(semesterVenuesSource, { headers: { accept: "application/json" } })
  ]);

  if (!mapResponse.ok) throw new Error(`NUS map request failed with ${mapResponse.status}.`);
  if (!nusModsLocationsResponse.ok) {
    throw new Error(`NUSMods venue map request failed with ${nusModsLocationsResponse.status}.`);
  }
  if (!nusModsSemesterResponse.ok) {
    throw new Error(`NUSMods semester venue request failed with ${nusModsSemesterResponse.status}.`);
  }

  const generatedAt = new Date().toISOString();
  const dataset = buildLocationDataset(await mapResponse.json(), generatedAt);
  const nusModsDataset = buildNusModsVenueDataset(
    await nusModsLocationsResponse.json(),
    await nusModsSemesterResponse.json(),
    term,
    generatedAt
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([
    writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8"),
    writeFile(DEFAULT_NUSMODS_OUTPUT_PATH, `${JSON.stringify(nusModsDataset, null, 2)}\n`, "utf8")
  ]);
  return { campus: dataset, nusMods: nusModsDataset };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  refreshLocations()
    .then(({ campus, nusMods }) => {
      console.log(`Saved ${campus.count} campus places to ${DEFAULT_OUTPUT_PATH}`);
      console.log(
        `Saved ${nusMods.count} NUSMods venues (${nusMods.coordinateCount} with coordinates) to ${DEFAULT_NUSMODS_OUTPUT_PATH}`
      );
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
