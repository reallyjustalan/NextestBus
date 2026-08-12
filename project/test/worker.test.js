import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("the compact arrivals proxy excludes route and vehicle payloads", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl;
  globalThis.fetch = async (input) => {
    upstreamUrl = new URL(input);
    return new Response(JSON.stringify({
      updatedAt: "2026-08-12T04:00:00.000Z",
      stop: { id: "COM3", title: "COM 3" },
      services: [{
        key: "nus:D1",
        name: "D1",
        source: "nus",
        color: { background: "#fff", text: "#000" },
        arrivals: [{ minutes: 2 }],
        route: { path: [{ latitude: 1, longitude: 103 }] },
        vehicles: [{ id: "bus-1" }]
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const response = await worker.fetch(new Request(
      "https://app.test/api/nusbus?endpoint=%2Fstops%2FCOM3&compact=arrivals&locale=en"
    ), {}, {});
    const data = await response.json();

    assert.equal(upstreamUrl.pathname, "/api/stops/COM3");
    assert.equal(upstreamUrl.searchParams.get("locale"), "en");
    assert.equal(upstreamUrl.searchParams.has("compact"), false);
    assert.deepEqual(data.services[0].arrivals, [{ minutes: 2 }]);
    assert.equal(data.services[0].route, undefined);
    assert.equal(data.services[0].vehicles, undefined);
    assert.match(response.headers.get("server-timing"), /^nusbus-upstream;dur=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
