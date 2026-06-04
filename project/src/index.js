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
    data
  };
}

async function proxyNusBus(request) {
  const url = new URL(request.url);
  const endpoint = url.searchParams.get("endpoint");

  if (!endpoint || !endpoint.startsWith("/")) {
    return sendJson(
      { message: "Expected an endpoint beginning with /." },
      400
    );
  }

  const upstreamUrl = new URL(`${NUSBUS_API_BASE}${endpoint}`);

  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "endpoint" && value) {
      upstreamUrl.searchParams.set(key, value);
    }
  }

  try {
    const upstream = await fetchUpstreamJson(upstreamUrl);

    return new Response(JSON.stringify(upstream.data), {
      status: upstream.status,
      headers: {
        "content-type": upstream.contentType,
        "cache-control": "no-store"
      }
    });
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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/nusbus") {
      if (request.method !== "GET") {
        return sendJson({ message: "Method not allowed." }, 405);
      }

      return proxyNusBus(request);
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
