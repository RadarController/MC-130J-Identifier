const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const groqModel = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const cacheDir = process.env.CACHE_DIR || path.join(root, ".cache");
const imageCacheFile = path.join(cacheDir, "image-search-cache.json");
const databaseFile = path.join(cacheDir, "observations-db.json");
const databaseUrl = process.env.DATABASE_URL || "";
const imageCacheTtlMs = Number(process.env.IMAGE_CACHE_TTL_HOURS || 168) * 60 * 60 * 1000;
let pgPool;
let pgReady;
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
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function emptyDatabase() {
  return {
    version: 1,
    serials: {}
  };
}

async function getPgPool() {
  if (!databaseUrl) return null;
  if (!pgPool) {
    const { Pool } = require("pg");
    pgPool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("railway.internal") ? false : { rejectUnauthorized: false }
    });
  }
  if (!pgReady) {
    pgReady = (async () => {
      await pgPool.query(`
        create table if not exists manual_observations (
          id bigserial primary key,
          serial text not null,
          paint_line text default '',
          markings text default '',
          confidence integer default 0,
          created_at timestamptz not null default now()
        );
        create table if not exists groq_analyses (
          id bigserial primary key,
          serial text not null,
          model text not null,
          image_count integer not null default 0,
          images jsonb not null default '[]'::jsonb,
          batches jsonb not null default '[]'::jsonb,
          report text not null default '',
          context text not null default '',
          created_at timestamptz not null default now()
        );
        create index if not exists manual_observations_serial_created_idx
          on manual_observations (serial, created_at desc);
        create index if not exists groq_analyses_serial_created_idx
          on groq_analyses (serial, created_at desc);
      `);
    })();
  }
  await pgReady;
  return pgPool;
}

function manualRow(row) {
  return {
    id: String(row.id),
    serial: row.serial,
    paintLine: row.paint_line || "",
    markings: row.markings || "",
    confidence: Number(row.confidence || 0),
    createdAt: row.created_at
  };
}

function groqRow(row) {
  return {
    id: String(row.id),
    serial: row.serial,
    model: row.model,
    imageCount: Number(row.image_count || 0),
    images: row.images || [],
    batches: row.batches || [],
    report: row.report || "",
    context: row.context || "",
    createdAt: row.created_at
  };
}

async function readDatabase() {
  try {
    const data = JSON.parse(await fs.readFile(databaseFile, "utf8"));
    return data?.serials ? data : emptyDatabase();
  } catch (error) {
    return emptyDatabase();
  }
}

async function writeDatabase(database) {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(databaseFile, JSON.stringify(database, null, 2));
}

function serialRecord(database, serial) {
  if (!database.serials[serial]) {
    database.serials[serial] = {
      manualObservations: [],
      groqAnalyses: []
    };
  }
  return database.serials[serial];
}

function latest(items) {
  return items?.length ? items[items.length - 1] : null;
}

async function appendManualObservation(serial, observation) {
  const pool = await getPgPool();
  if (pool) {
    const result = await pool.query(
      `insert into manual_observations (serial, paint_line, markings, confidence)
       values ($1, $2, $3, $4)
       returning *`,
      [
        serial,
        observation.paintLine || "",
        observation.markings || "",
        Number(observation.confidence || 0)
      ]
    );
    const saved = manualRow(result.rows[0]);
    const record = await loadSerialRecord(serial);
    return { record, saved };
  }

  const database = await readDatabase();
  const record = serialRecord(database, serial);
  const saved = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    serial,
    paintLine: observation.paintLine || "",
    markings: observation.markings || "",
    confidence: Number(observation.confidence || 0),
    createdAt: new Date().toISOString()
  };
  record.manualObservations.push(saved);
  await writeDatabase(database);
  return { record, saved };
}

async function appendGroqAnalysis(serial, analysis) {
  const pool = await getPgPool();
  if (pool) {
    const result = await pool.query(
      `insert into groq_analyses (serial, model, image_count, images, batches, report, context)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       returning *`,
      [
        serial,
        analysis.model,
        Number(analysis.imageCount || 0),
        JSON.stringify(analysis.images || []),
        JSON.stringify(analysis.batches || []),
        analysis.report || "",
        analysis.context || ""
      ]
    );
    const saved = groqRow(result.rows[0]);
    const record = await loadSerialRecord(serial);
    return { record, saved };
  }

  const database = await readDatabase();
  const record = serialRecord(database, serial);
  const saved = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    serial,
    model: analysis.model,
    imageCount: analysis.imageCount,
    images: analysis.images || [],
    batches: analysis.batches || [],
    report: analysis.report || "",
    context: analysis.context || "",
    createdAt: new Date().toISOString()
  };
  record.groqAnalyses.push(saved);
  await writeDatabase(database);
  return { record, saved };
}

async function loadSerialRecord(serial) {
  const pool = await getPgPool();
  if (pool) {
    const [manual, groq] = await Promise.all([
      pool.query(
        `select * from manual_observations where serial = $1 order by created_at asc, id asc`,
        [serial]
      ),
      pool.query(
        `select * from groq_analyses where serial = $1 order by created_at asc, id asc`,
        [serial]
      )
    ]);
    const manualObservations = manual.rows.map(manualRow);
    const groqAnalyses = groq.rows.map(groqRow);
    return {
      manualObservations,
      groqAnalyses
    };
  }

  const database = await readDatabase();
  return database.serials[serial] || { manualObservations: [], groqAnalyses: [] };
}

async function loadAllRecords() {
  const pool = await getPgPool();
  if (pool) {
    const [manual, groq] = await Promise.all([
      pool.query(`select * from manual_observations order by serial asc, created_at asc, id asc`),
      pool.query(`select * from groq_analyses order by serial asc, created_at asc, id asc`)
    ]);
    const database = emptyDatabase();
    for (const row of manual.rows.map(manualRow)) {
      serialRecord(database, row.serial).manualObservations.push(row);
    }
    for (const row of groq.rows.map(groqRow)) {
      serialRecord(database, row.serial).groqAnalyses.push(row);
    }
    return database;
  }

  return readDatabase();
}

async function handleRecords(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const serial = url.searchParams.get("serial");

  if (!serial) {
    const database = await loadAllRecords();
    sendJson(res, 200, database);
    return;
  }

  const record = await loadSerialRecord(serial);
  sendJson(res, 200, {
    serial,
    manualObservations: record.manualObservations || [],
    groqAnalyses: record.groqAnalyses || [],
    latestManualObservation: latest(record.manualObservations),
    latestGroqAnalysis: latest(record.groqAnalyses)
  });
}

async function handleObservationSave(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const serial = String(body.serial || "").trim();

  if (!serial) {
    sendJson(res, 400, { error: "Missing serial" });
    return;
  }

  const { record, saved } = await appendManualObservation(serial, body);
  sendJson(res, 200, {
    saved,
    latestManualObservation: saved,
    manualObservations: record.manualObservations,
    groqAnalyses: record.groqAnalyses
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

  const analysis = {
    model,
    imageCount: images.length,
    images,
    batches,
    report,
    context
  };
  const { saved } = await appendGroqAnalysis(aircraft.serial, analysis);

  sendJson(res, 200, { ...analysis, savedAnalysis: saved });
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
    if (req.method === "GET" && url.pathname === "/api/records") {
      await handleRecords(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/observations") {
      await handleObservationSave(req, res);
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
