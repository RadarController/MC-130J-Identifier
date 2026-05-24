const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const groqModel = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const cacheDir = process.env.CACHE_DIR || path.join(root, ".cache");
const imageCacheFile = path.join(cacheDir, "image-search-cache.json");
const imageCacheTtlMs = Number(process.env.IMAGE_CACHE_TTL_HOURS || 168) * 60 * 60 * 1000;
const allowedImageHosts = [
  "airhistory.net",
  "airport-data.com",
  "abpic.co.uk",
  "planespotters.net",
  "jetphotos.com",
  "cdn.jetphotos.com",
  "airliners.net",
  "wikimedia.org",
  "wikipedia.org",
  "staticflickr.com",
  "flickr.com",
  "af.mil",
  "defense.gov",
  "dvidshub.net",
  "media.defense.gov",
  "theaviationist.com",
  "scramble.nl",
  "airplane-pictures.net"
];
const blockedImageHosts = [
  "hentai",
  "porn",
  "sex.com",
  "xxx",
  "adult"
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function safePath(requestUrl) {
  const url = new URL(requestUrl, `http://${host}:${port}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(root, requested);

  if (!resolved.startsWith(root)) {
    return null;
  }

  return resolved;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readImageCache() {
  try {
    return JSON.parse(await fs.readFile(imageCacheFile, "utf8"));
  } catch (error) {
    return {};
  }
}

async function writeImageCache(cache) {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(imageCacheFile, JSON.stringify(cache, null, 2));
}

function cacheKey(serial, local) {
  return `${serial}|${local || ""}`.toLowerCase();
}

function isFreshCache(entry) {
  return entry?.images?.length && Date.now() - new Date(entry.updatedAt).getTime() < imageCacheTtlMs;
}

function normalizeImageUrl(raw) {
  return raw
    .replaceAll("\\/", "/")
    .replaceAll("\\u002f", "/")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .trim();
}

function isUsefulImageUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const allowed = allowedImageHosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
    const blocked = blockedImageHosts.some((domain) => host.includes(domain));
    return /^https?:$/i.test(parsed.protocol) &&
      allowed &&
      !blocked &&
      !/(\.svg|sprite|logo|avatar|profile|icon)/i.test(url) &&
      !/bing\.com\/th\?/i.test(url);
  } catch (error) {
    return false;
  }
}

async function fetchBingImages(query, limit) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&safeSearch=strict`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(`Image search failed with HTTP ${response.status}`);
  }

  const html = await response.text();
  const results = [];
  const seen = new Set();
  const requiredTerms = ["mc-130", "mc130", "commando", query.match(/\d{2}-\d{4}/)?.[0]].filter(Boolean);
  const addImage = (rawUrl, metadata = "") => {
    const imageUrl = normalizeImageUrl(decodeURIComponent(rawUrl));
    const key = imageUrl.split("?")[0].toLowerCase();
    const haystack = `${metadata} ${imageUrl}`.toLowerCase();
    const looksRelevant = requiredTerms.some((term) => haystack.includes(term.toLowerCase()));
    if (seen.has(key) || !looksRelevant || !isUsefulImageUrl(imageUrl)) return false;
    seen.add(key);
    results.push({
      url: imageUrl,
      pageUrl: url,
      source: "Bing Images",
      query
    });
    return results.length >= limit;
  };

  for (const match of html.matchAll(/m=(?:&quot;|")({.*?})(?:&quot;|")/g)) {
    try {
      const json = normalizeImageUrl(match[1])
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", "\"");
      const item = JSON.parse(json);
      if (item.murl && addImage(item.murl, `${item.t || ""} ${item.purl || ""}`)) return results;
    } catch (error) {
      // Fall back to simpler URL extraction below.
    }
  }

  const patterns = [
    /murl&quot;:&quot;(https?:.*?)(?:&quot;|\\")/g,
    /"murl":"(https?:.*?)(?:"|\\")/g,
    /mediaurl=(https?:[^&"]+)/g
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (addImage(match[1], query)) return results;
    }
  }

  return results;
}

function isAllowedHost(url, hosts = allowedImageHosts) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch (error) {
    return false;
  }
}

async function fetchBingPages(query, limit) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=1&safeSearch=strict`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  if (!response.ok) return [];

  const html = await response.text();
  const pages = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)) {
    const pageUrl = normalizeImageUrl(match[1]);
    const key = pageUrl.split("?")[0].toLowerCase();
    if (seen.has(key) || !isAllowedHost(pageUrl)) continue;
    seen.add(key);
    pages.push(pageUrl);
    if (pages.length >= limit) break;
  }
  return pages;
}

function absolutizeUrl(candidate, pageUrl) {
  try {
    return new URL(candidate, pageUrl).href;
  } catch (error) {
    return "";
  }
}

async function extractImagesFromPage(pageUrl, query, limit) {
  try {
    const response = await fetch(pageUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) return [];
    const html = await response.text();
    const candidates = [];
    const patterns = [
      /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/gi,
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/gi,
      /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/gi
    ];
    for (const pattern of patterns) {
      for (const match of html.matchAll(pattern)) {
        const imageUrl = normalizeImageUrl(absolutizeUrl(match[1], pageUrl));
        if (isUsefulImageUrl(imageUrl)) {
          candidates.push({
            url: imageUrl,
            pageUrl,
            source: new URL(pageUrl).hostname,
            query
          });
        }
        if (candidates.length >= limit) return candidates;
      }
    }
    return candidates;
  } catch (error) {
    return [];
  }
}

async function handleImages(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const serial = url.searchParams.get("serial") || "";
  const local = url.searchParams.get("local") || "";
  const limit = Math.min(Number(url.searchParams.get("limit") || 10), 10);
  const refresh = url.searchParams.get("refresh") === "1";

  if (!serial) {
    sendJson(res, 400, { error: "Missing serial" });
    return;
  }

  const cache = await readImageCache();
  const searchCacheKey = cacheKey(serial, local);
  if (!refresh && isFreshCache(cache[searchCacheKey])) {
    sendJson(res, 200, { serial, local, cached: true, images: cache[searchCacheKey].images.slice(0, limit) });
    return;
  }

  const queries = [
    `"${serial}" "MC-130J"`,
    local ? `"${local}" "MC-130J" "Commando II"` : "",
    `"${serial}" "USAF" "Commando II"`,
    `"${serial}" "Lockheed Martin" "MC-130J"`,
    `"${serial}" "MC-130J" site:flickr.com`,
    `"${serial}" "MC-130J" site:airhistory.net`,
    `"${serial}" "MC-130J" site:jetphotos.com`,
    `"${serial}" "MC-130J" site:airport-data.com`,
    `"${serial}" "MC-130J" site:planespotters.net`
  ].filter(Boolean);

  const images = [];
  const seen = new Set();
  for (const query of queries) {
    const found = await fetchBingImages(query, limit);
    for (const image of found) {
      const imageKey = image.url.split("?")[0].toLowerCase();
      if (seen.has(imageKey)) continue;
      seen.add(imageKey);
      images.push(image);
      if (images.length >= limit) {
        cache[searchCacheKey] = { serial, local, images, updatedAt: new Date().toISOString() };
        await writeImageCache(cache);
        sendJson(res, 200, { serial, local, cached: false, images });
        return;
      }
    }
  }

  for (const query of queries) {
    const pages = await fetchBingPages(query, 8);
    for (const page of pages) {
      const found = await extractImagesFromPage(page, query, limit - images.length);
      for (const image of found) {
        const imageKey = image.url.split("?")[0].toLowerCase();
        if (seen.has(imageKey)) continue;
        seen.add(imageKey);
        images.push(image);
        if (images.length >= limit) {
          cache[searchCacheKey] = { serial, local, images, updatedAt: new Date().toISOString() };
          await writeImageCache(cache);
          sendJson(res, 200, { serial, local, cached: false, images });
          return;
        }
      }
    }
  }

  cache[searchCacheKey] = { serial, local, images, updatedAt: new Date().toISOString() };
  await writeImageCache(cache);
  sendJson(res, 200, { serial, local, cached: false, images });
}

function groqText(response) {
  return response.output_text ||
    response.output?.flatMap((item) => item.content || [])
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n") ||
    response.choices?.[0]?.message?.content ||
    JSON.stringify(response, null, 2);
}

async function groqResponse(input, model) {
  const response = await fetch("https://api.groq.com/openai/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({ model, input })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Groq request failed with HTTP ${response.status}`);
  }

  return groqText(data);
}

async function analyzeBatch({ aircraft, images, context, model, batchNumber }) {
  const prompt = [
    `You are comparing public photos to help identify a USAF MC-130J candidate: ${aircraft.serial}.`,
    `Known public local/tail marking from the source row: ${aircraft.local || "unknown"}.`,
    `This is image batch ${batchNumber}. Inspect only visible details and report uncertainty clearly.`,
    "Focus on serial/tail/nose traces, unit markings, antennas, EO/IR or terrain-following fairings, refueling pods, weathering, repair patches, and especially the dark grey vs light grey demarcation on the fuselage and wing fuel tanks.",
    "Return compact JSON with keys: candidate_serial, batch_confidence_0_100, visible_serials, fuselage_paint_line, tank_paint_line, distinctive_markings, image_by_image_notes, supports_candidate, contradicts_candidate, next_image_angle_needed.",
    context ? `User context: ${context}` : ""
  ].filter(Boolean).join("\n");

  return groqResponse([{
    role: "user",
    content: [
      { type: "input_text", text: prompt },
      ...images.map((image) => ({
        type: "input_image",
        detail: "auto",
        image_url: image.url
      }))
    ]
  }], model);
}

async function handleAnalyze(req, res) {
  if (!process.env.GROQ_API_KEY) {
    sendJson(res, 500, { error: "Missing GROQ_API_KEY server environment variable" });
    return;
  }

  const body = JSON.parse(await readBody(req) || "{}");
  const aircraft = body.aircraft || {};
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  const context = String(body.context || "").trim();
  const model = String(body.model || groqModel).trim();

  if (!aircraft.serial || images.length === 0) {
    sendJson(res, 400, { error: "Missing aircraft serial or image list" });
    return;
  }

  const batches = [];
  for (let index = 0; index < images.length; index += 5) {
    const batchImages = images.slice(index, index + 5);
    const text = await analyzeBatch({
      aircraft,
      images: batchImages,
      context,
      model,
      batchNumber: batches.length + 1
    });
    batches.push({ images: batchImages, text });
  }

  let report = batches[0].text;
  if (batches.length > 1) {
    report = await groqResponse([{
      role: "user",
      content: [{
        type: "input_text",
        text: [
          `Synthesize these MC-130J image batch reports for candidate ${aircraft.serial}.`,
          "Return concise JSON with keys: candidate_serial, overall_confidence_0_100, strongest_identity_evidence, paint_demarcation_summary, unique_marking_summary, contradictions, recommended_next_searches.",
          ...batches.map((batch, index) => `Batch ${index + 1}: ${batch.text}`)
        ].join("\n\n")
      }]
    }], model);
  }

  sendJson(res, 200, { model, imageCount: images.length, batches, report });
}

async function serveStatic(req, res) {
  const filePath = safePath(req.url);

  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "public, max-age=300"
    });
    res.end(data);
  } catch (error) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method === "GET" && url.pathname === "/api/images") {
      await handleImages(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      await handleAnalyze(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, host, () => {
  console.log(`MC-130J Identifier listening on http://${host}:${port}`);
});
