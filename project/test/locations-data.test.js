import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  LOCATIONS_SOURCE,
  NUSMODS_VENUE_LOCATIONS_SOURCE,
  buildLocationDataset,
  buildNusModsVenueDataset,
  nusModsSemesterVenuesSource,
  nusModsTerm,
  normalizeLocation
} from "../scripts/refresh-locations.mjs";

test("normalizes a map record into the app's location shape", () => {
  assert.deepEqual(
    normalizeLocation({
      id: "2",
      place_name: " Yusof  Ishak House ",
      location_name: "",
      building_name: "Yusof Ishak House",
      street_name: "Lower Kent Ridge Road",
      campus_name: "Kent Ridge Campus",
      lat: "1.298410586",
      long: "103.7745539",
      tbl: "building"
    }),
    {
      id: "building:2:yusof-ishak-house",
      type: "venue",
      title: "Yusof Ishak House",
      roomName: "Yusof Ishak House",
      category: "building",
      categoryLabel: "Building",
      campusName: "Kent Ridge Campus",
      placeCode: "",
      buildingName: "Yusof Ishak House",
      streetName: "Lower Kent Ridge Road",
      block: "",
      postal: "",
      unitNo: "",
      coordinates: { latitude: 1.298410586, longitude: 103.7745539 },
      sourceId: "2",
      sourceTable: "building"
    }
  );
});

test("filters map bus stops, class venues, invalid coordinates, and duplicate IDs", () => {
  const base = { id: "1", lat: "1.3", long: "103.7" };
  const dataset = buildLocationDataset(
    [
      { ...base, tbl: "building", place_name: "COM3" },
      { ...base, tbl: "building", place_name: "COM3" },
      { ...base, tbl: "bus_stop", place_name: "COM3 Bus Stop" },
      { ...base, tbl: "lecture", place_name: "LT 17" },
      { ...base, tbl: "faculty", place_name: "AS1 seminar rooms" },
      { ...base, tbl: "room", place_name: "Broken", lat: "not-a-number" }
    ],
    "2026-08-12T00:00:00.000Z"
  );

  assert.equal(dataset.count, 1);
  assert.equal(dataset.excludedCount, 5);
  assert.equal(dataset.locations[0].title, "COM3");
});

test("keeps mojibake from changing stable location IDs", () => {
  const location = normalizeLocation({
    id: "8",
    tbl: "food_outlet",
    place_name: "Good News CafÃƒÂ©",
    lat: "1.29807",
    long: "103.77115"
  });

  assert.equal(location.id, "food_outlet:8:good-news-caf");
});

test("the committed local snapshot is valid and self-consistent", async () => {
  const data = JSON.parse(
    await readFile(new URL("../public/data/nus-map-locations.json", import.meta.url), "utf8")
  );

  assert.equal(data.source, LOCATIONS_SOURCE);
  assert.equal(data.count, data.locations.length);
  assert.ok(data.locations.length > 700);
  assert.ok(
    data.locations.every(
      (location) =>
        location.id &&
        location.title &&
        Number.isFinite(location.coordinates?.latitude) &&
        Number.isFinite(location.coordinates?.longitude)
    )
  );
});

test("builds the union of NUSMods' curated and active-semester venues", () => {
  const term = { academicYear: "2026-2027", semester: 1 };
  const data = buildNusModsVenueDataset(
    {
      LT17: {
        roomName: "Lecture Theatre 17",
        floor: 1,
        location: { x: 103.774, y: 1.2936 }
      },
      "Y-Studio3": { roomName: "West Core - Studio 3", floor: "Ground" }
    },
    ["LT17", "EC-02-18"],
    term,
    "2026-08-12T00:00:00.000Z"
  );

  assert.equal(data.count, 3);
  assert.equal(data.coordinateCount, 1);
  assert.equal(data.activeSemesterCount, 2);
  assert.equal(data.locations.find((location) => location.title === "LT17").roomName, "Lecture Theatre 17");
  assert.equal(data.locations.find((location) => location.title === "EC-02-18").coordinates, null);
  assert.equal(data.sources.semesterVenues, nusModsSemesterVenuesSource(term));
});

test("derives the current NUSMods academic term", () => {
  assert.deepEqual(nusModsTerm(new Date("2026-08-12T00:00:00Z")), {
    academicYear: "2026-2027",
    semester: 1
  });
});

test("the committed NUSMods venue snapshot is valid and attributed", async () => {
  const data = JSON.parse(
    await readFile(new URL("../public/data/nusmods-venues.json", import.meta.url), "utf8")
  );

  assert.equal(data.sources.venueLocations, NUSMODS_VENUE_LOCATIONS_SOURCE);
  assert.equal(data.count, data.locations.length);
  assert.ok(data.locations.length > 700);
  assert.ok(data.coordinateCount > 690);
  assert.ok(data.locations.some((location) => location.title === "LT17"));
});
