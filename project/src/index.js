const NUSBUS_API_BASE = "https://api.nusbus.com/api";
const USER_AGENT = "NUSNextBusAccessibleViewer/0.2";

function sendJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

async function fetchUpstreamJson(url) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT
    }
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    status: response.status,
    contentType:
      response.headers.get("content-type") ||
      "application/json; charset=utf-8",
    data,
    durationMs: Date.now() - startedAt
  };
}

function cacheSecondsForEndpoint(endpoint) {
  if (/^\/stops\/[^/]+$/.test(endpoint) || endpoint === "/directions") return 15;
  if (endpoint === "/stops" || endpoint === "/services") return 300;
  if (/^\/services\/[^/]+$/.test(endpoint)) return 60;
  return 0;
}

function compactArrivalsPayload(data) {
  return {
    updatedAt: data.updatedAt,
    stop: data.stop,
    services: (data.services || []).map((service) => ({
      key: service.key,
      name: service.name,
      subtitle: service.subtitle,
      source: service.source,
      color: service.color,
      arrivals: service.arrivals || []
    }))
  };
}

async function proxyNusBus(request, context) {
  const url = new URL(request.url);
  const endpoint = url.searchParams.get("endpoint");
  const compact = url.searchParams.get("compact");

  if (!endpoint || !endpoint.startsWith("/")) {
    return sendJson(
      { message: "Expected an endpoint beginning with /." },
      400
    );
  }

  const upstreamUrl = new URL(`${NUSBUS_API_BASE}${endpoint}`);

  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "endpoint" && key !== "compact" && value) {
      upstreamUrl.searchParams.set(key, value);
    }
  }

  try {
    const cacheSeconds = cacheSecondsForEndpoint(endpoint);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache && cacheSeconds > 0) {
      const cached = await cache.match(request);
      if (cached) {
        const response = new Response(cached.body, cached);
        response.headers.set("x-nusbus-cache", "HIT");
        response.headers.set("server-timing", "nusbus-cache;desc=hit;dur=0");
        return response;
      }
    }

    const upstream = await fetchUpstreamJson(upstreamUrl);
    const data = compact === "arrivals" ? compactArrivalsPayload(upstream.data) : upstream.data;
    const response = new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: {
        "content-type": upstream.contentType,
        "cache-control": cacheSeconds > 0
          ? `public, max-age=${cacheSeconds}, stale-while-revalidate=75, stale-if-error=90`
          : "no-store",
        "x-nusbus-cache": "MISS",
        "server-timing": `nusbus-upstream;dur=${upstream.durationMs}`
      }
    });
    if (cache && cacheSeconds > 0 && upstream.status === 200) {
      context?.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch (error) {
    return sendJson(
      {
        message: error.message || "Unexpected server error"
      },
      500
    );
  }
}

async function fetchLocationsJson(request, env) {
  const url = new URL(request.url);
  const assetUrl = new URL("/data/nus-map-locations.json", url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));

  if (!response.ok) return response;

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600"
    }
  });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname === "/api/nusbus") {
      if (request.method !== "GET") {
        return sendJson({ message: "Method not allowed." }, 405);
      }

      return proxyNusBus(request, context);
    }

    if (url.pathname === "/api/locations") {
      if (request.method !== "GET") {
        return sendJson({ message: "Method not allowed." }, 405);
      }

      return fetchLocationsJson(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return sendJson({ message: "API route not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
