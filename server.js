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
  "airplane-pictures.net",
  "c-130.net"
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
  return String(raw || "")
    .replaceAll("\\/", "/")
    .replaceAll("\\u002f", "/")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .trim();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function urlHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (error) {
    return "";
  }
}

function isBlockedHost(url) {
  const host = urlHost(url);
  return !host || blockedImageHosts.some((domain) => host.includes(domain));
}

function isAllowedHost(url, hosts = allowedImageHosts) {
  const host = urlHost(url);
  return Boolean(host) && hosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isNonAircraftAssetUrl(url) {
  return /(\.svg|sprite|logo|logotype|watermark|avatar|profile|icon|favicon|camera\.png|usaf\.gif|rss-feed|facebook|bluesky|banner|header|social|placeholder|pixel|tracking)/i.test(String(url || "")) ||
    /bing\.com\/th\?/i.test(String(url || ""));
}

function isUsefulImageUrl(url, options = {}) {
  const enforceAllowedHosts = options.enforceAllowedHosts !== false;
  try {
    const parsed = new URL(url);
    const allowed = isAllowedHost(url);
    return /^https?:$/i.test(parsed.protocol) &&
      (!enforceAllowedHosts || allowed) &&
      !isBlockedHost(url) &&
      !isNonAircraftAssetUrl(url);
  } catch (error) {
    return false;
  }
}

function isCandidateSourcePageUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return /^https?:$/i.test(parsed.protocol) &&
      !isBlockedHost(url) &&
      !/(^|\.)bing\.com$|(^|\.)google\.|facebook\.com|x\.com|twitter\.com|instagram\.com|pinterest\.com|youtube\.com/i.test(host);
  } catch (error) {
    return false;
  }
}

function normalizedIdentityTokens(serial, local) {
  return [serial, local]
    .map((token) => String(token || "").trim())
    .filter((token) => token && !/^unknown$/i.test(token))
    .flatMap((token) => {
      const compact = token.replace(/[^a-z0-9]/gi, "");
      return compact && compact !== token ? [token, compact] : [token];
    })
    .map((token) => token.toLowerCase());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identityIsConfirmed(text, serial, local) {
  const haystack = String(text || "").toLowerCase();
  if (!haystack) return false;

  for (const token of normalizedIdentityTokens(serial, local)) {
    const pattern = token.includes("-")
      ? escapeRegExp(token).replace(/\\-/g, "[-\\s]?")
      : escapeRegExp(token);
    const re = new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, "i");
    if (re.test(haystack)) return true;
  }

  return false;
}

function likelyMc130Context(text) {
  const haystack = String(text || "").toLowerCase();
  return /mc[-\s]?130j|mc[-\s]?130|commando ii|usaf|air force|lockheed|c[-\s]?130/.test(haystack);
}

function imageSizePreference(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (!w && !h) return "unknown";
  return Math.max(w, h) >= 1024 ? "preferred" : "small";
}

function imageScore(image) {
  const sizeScore = image.sizePreference === "preferred" ? 60 : image.sizePreference === "unknown" ? 25 : 0;
  const sourceScore = image.source === "C-130.net" ? 35 : image.source === "Bing Images" ? 20 : 15;
  const fullScore = image.url && !/\/thumbs\//i.test(image.url) ? 15 : 0;
  return sizeScore + sourceScore + fullScore;
}

function sortedImages(images) {
  return images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => imageScore(b.image) - imageScore(a.image) || a.index - b.index)
    .map((entry) => entry.image);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  if (!response.ok) return "";
  return response.text();
}

function isDirectImageUrl(url) {
  return /\.(?:jpe?g|png|webp|gif)(?:$|[?#])/i.test(String(url || ""));
}

function isC130GalleryImageUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return /(^|\.)c-130\.net$/i.test(parsed.hostname) &&
      (/\/g3\/var\/resizes\//i.test(pathname) || /\/g3\/var\/albums\//i.test(pathname));
  } catch (error) {
    return false;
  }
}

function isLikelySiteBrandingImage(url, width, height) {
  const value = String(url || "").toLowerCase();
  const w = Number(width || 0);
  const h = Number(height || 0);
  const ratio = w && h ? Math.max(w, h) / Math.max(1, Math.min(w, h)) : 0;
  return /logo|logotype|brand|banner|header|social|og-image|placeholder|ultimate[-_ ]?c[-_ ]?130/i.test(value) ||
    (w === 1200 && h === 628) ||
    (ratio > 2.05 && w >= 900);
}

function c130CandidateImageUrls(thumbUrl, linkedUrl) {
  const candidates = [];
  const add = (candidate) => {
    if (!candidate) return;
    const cleaned = normalizeImageUrl(candidate).replace(/\s+/g, "");
    if (!cleaned || candidates.some((item) => item.split("?")[0].toLowerCase() === cleaned.split("?")[0].toLowerCase())) return;
    candidates.push(cleaned);
  };

  if (linkedUrl && isDirectImageUrl(linkedUrl) && isC130GalleryImageUrl(linkedUrl) && !/\/g3\/var\/thumbs\//i.test(linkedUrl)) {
    add(linkedUrl);
  }

  if (thumbUrl && isC130GalleryImageUrl(thumbUrl)) {
    add(thumbUrl);
  }

  if (thumbUrl && /\/g3\/var\/thumbs\//i.test(thumbUrl)) {
    // Gallery3 thumbnails are not suitable for AI review. Try likely full-size variants,
    // but validate them before returning anything.
    add(thumbUrl.replace("/g3/var/thumbs/", "/g3/var/resizes/"));
    add(thumbUrl.replace(/\/thumbs\//i, "/resizes/"));
    add(thumbUrl.replace("/g3/var/thumbs/", "/g3/var/albums/"));
    add(thumbUrl.replace(/\/thumbs\//i, "/albums/"));
  }

  return candidates
    .map((candidate) => {
      try {
        const parsed = new URL(candidate);
        // Drop Gallery3 thumbnail resize timestamps and cache params from guessed direct image URLs.
        parsed.search = "";
        parsed.hash = "";
        return parsed.href;
      } catch (error) {
        return candidate.split("?")[0];
      }
    })
    .filter((candidate) => isC130GalleryImageUrl(candidate));
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return null;
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const type = buffer.toString("ascii", 12, 16);
  if (type === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (type === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (type === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  return null;
}

function imageDimensions(buffer) {
  return jpegSize(buffer) || pngSize(buffer) || webpSize(buffer) || null;
}

async function validateImageCandidate(url, options = {}) {
  if (!url || !isUsefulImageUrl(url, { enforceAllowedHosts: options.enforceAllowedHosts !== false })) return null;

  const headers = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
    "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "range": "bytes=0-65535"
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206) return null;

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/^image\//i.test(contentType) && !isDirectImageUrl(url)) return null;

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const dimensions = imageDimensions(buffer) || {};
    const length = Number(response.headers.get("content-length") || 0) || undefined;
    if (options.rejectBranding !== false && isLikelySiteBrandingImage(url, dimensions.width, dimensions.height)) return null;

    const sizePreference = imageSizePreference(dimensions.width, dimensions.height);

    return {
      url,
      width: dimensions.width,
      height: dimensions.height,
      contentLength: length,
      sizePreference,
      preferredSize: sizePreference !== "small"
    };
  } catch (error) {
    return null;
  }
}

function c130LinkedImagePairs(detailHtml, detailUrl) {
  const pairs = [];
  const addPair = (href, src, context) => {
    const cleanedHref = normalizeImageUrl(absolutizeUrl(href || "", detailUrl));
    const cleanedSrc = normalizeImageUrl(absolutizeUrl(src || "", detailUrl));
    if (!cleanedSrc && !cleanedHref) return;
    pairs.push({ href: cleanedHref, src: cleanedSrc, context: String(context || "") });
  };

  const linkedPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]{0,1800}?<img[^>]+src=["']([^"']+)["'][^>]*>[\s\S]{0,1800}?(?:<\/a>|$)/gi;
  for (const match of detailHtml.matchAll(linkedPattern)) {
    const start = Math.max(0, (match.index || 0) - 600);
    const end = Math.min(detailHtml.length, (match.index || 0) + match[0].length + 600);
    addPair(match[1], match[2], detailHtml.slice(start, end));
  }

  for (const match of detailHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const start = Math.max(0, (match.index || 0) - 600);
    const end = Math.min(detailHtml.length, (match.index || 0) + match[0].length + 600);
    addPair("", match[1], detailHtml.slice(start, end));
  }

  const seen = new Set();
  return pairs.filter((pair) => {
    const key = `${pair.href}|${pair.src}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function c130PhotoPageData(photoPageUrl, detailUrl, serial, local) {
  if (!photoPageUrl || !photoPageUrl.includes("c-130.net") || isDirectImageUrl(photoPageUrl)) {
    return { confirmed: false, candidates: [], reason: "not_photo_page" };
  }

  const html = await fetchText(photoPageUrl);
  if (!html) return { confirmed: false, candidates: [], reason: "photo_page_fetch_failed" };

  const evidence = `${photoPageUrl} ${html}`;
  const confirmed = identityIsConfirmed(evidence, serial, local) && likelyMc130Context(evidence);
  const candidates = [];
  const add = (raw) => {
    const url = normalizeImageUrl(absolutizeUrl(raw, photoPageUrl));
    if (url && !/\/g3\/var\/thumbs\//i.test(url) && isDirectImageUrl(url) && isC130GalleryImageUrl(url)) candidates.push(url);
  };

  const metaPatterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi
  ];
  for (const pattern of metaPatterns) {
    for (const match of html.matchAll(pattern)) add(match[1]);
  }

  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["'][^>]*>/gi)) add(match[1]);
  for (const match of html.matchAll(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["'][^>]*>/gi)) add(match[1]);

  return {
    confirmed,
    reason: confirmed ? "photo_page_identity_confirmed" : "photo_page_identity_not_confirmed",
    candidates: [...new Set(candidates.map((candidate) => absolutizeUrl(candidate, detailUrl) || candidate))]
  };
}

function addDebugSample(list, item, limit = 8) {
  if (!Array.isArray(list) || list.length >= limit) return;
  list.push(item);
}

async function fetchC130NetImages(serial, local, sourcePage, limit, debug) {
  if (!sourcePage || !sourcePage.includes("c-130.net")) return [];

  const c130Debug = debug?.c130Net;
  if (c130Debug) c130Debug.attempted = true;

  const sourceHtml = await fetchText(sourcePage);
  if (!sourceHtml) {
    c130Debug?.errors?.push("source_page_fetch_failed");
    return [];
  }

  const rowIndex = sourceHtml.indexOf(serial);
  if (rowIndex === -1) {
    c130Debug?.errors?.push("serial_not_found_on_source_page");
    return [];
  }

  const row = sourceHtml.slice(Math.max(0, rowIndex - 500), rowIndex + 3000);
  const detailMatch = row.match(/href=["']([^"']*display_airframe[^"']*id=\d+[^"']*)["']/i);
  if (!detailMatch) {
    c130Debug?.errors?.push("airframe_detail_link_not_found");
    return [];
  }

  const detailUrl = normalizeImageUrl(absolutizeUrl(detailMatch[1], sourcePage)).replace(/\s+/g, "");
  const detailHtml = await fetchText(detailUrl);
  if (!detailHtml) {
    c130Debug?.errors?.push("airframe_detail_fetch_failed");
    return [];
  }

  const detailText = detailHtml.toLowerCase();
  if (!identityIsConfirmed(detailText, serial, local)) {
    c130Debug?.errors?.push("airframe_detail_identity_not_confirmed");
    return [];
  }

  const images = [];
  const seen = new Set();
  const identityText = `${serial} ${local || ""}`.trim();
  const photoPageCache = new Map();

  for (const pair of c130LinkedImagePairs(detailHtml, detailUrl)) {
    const pairEvidence = `${pair.href} ${pair.src} ${pair.context}`;
    const pairContextConfirmed = identityIsConfirmed(pairEvidence, serial, local) && likelyMc130Context(pairEvidence);

    let photoData = { confirmed: false, candidates: [], reason: "no_photo_page" };
    if (pair.href && !isDirectImageUrl(pair.href)) {
      const pageKey = pair.href.split("?")[0].toLowerCase();
      if (!photoPageCache.has(pageKey)) {
        photoPageCache.set(pageKey, await c130PhotoPageData(pair.href, detailUrl, serial, local).catch((error) => ({
          confirmed: false,
          candidates: [],
          reason: error.message || "photo_page_error"
        })));
      }
      photoData = photoPageCache.get(pageKey);
    }

    if (!pairContextConfirmed && !photoData.confirmed) {
      debugCounter(c130Debug?.rejected, "image_not_serial_specific");
      addDebugSample(c130Debug?.rejectedSamples, {
        reason: "image_not_serial_specific",
        href: pair.href,
        src: pair.src,
        photoPageReason: photoData.reason
      });
      continue;
    }

    const possibleUrls = [
      ...c130CandidateImageUrls(pair.src, pair.href),
      ...photoData.candidates
    ];

    for (const candidate of possibleUrls) {
      const key = candidate.split("?")[0].toLowerCase();
      if (seen.has(key) || /\/g3\/var\/thumbs\//i.test(candidate)) {
        debugCounter(c130Debug?.rejected, "duplicate_or_thumbnail");
        continue;
      }
      if (!isC130GalleryImageUrl(candidate) || isLikelySiteBrandingImage(candidate)) {
        debugCounter(c130Debug?.rejected, "not_gallery_aircraft_image");
        addDebugSample(c130Debug?.rejectedSamples, { reason: "not_gallery_aircraft_image", url: candidate });
        continue;
      }
      const metadata = await validateImageCandidate(candidate, { rejectBranding: true });
      if (!metadata) {
        debugCounter(c130Debug?.rejected, "image_validation_failed");
        addDebugSample(c130Debug?.rejectedSamples, { reason: "image_validation_failed", url: candidate });
        continue;
      }
      seen.add(key);
      const accepted = {
        ...metadata,
        thumbnailUrl: pair.src || undefined,
        pageUrl: photoData.confirmed ? pair.href : detailUrl,
        source: "C-130.net",
        query: identityText,
        identityConfirmed: true,
        identityConfirmedBy: photoData.confirmed ? "C-130.net photo page contains exact serial/local marking" : "C-130.net image context contains exact serial/local marking"
      };
      images.push(accepted);
      addDebugSample(c130Debug?.acceptedSamples, {
        url: accepted.url,
        pageUrl: accepted.pageUrl,
        width: accepted.width,
        height: accepted.height,
        confirmedBy: accepted.identityConfirmedBy
      });
      break;
    }

    if (images.length >= limit) break;
  }

  if (c130Debug) c130Debug.found = images.length;
  return images;
}

function createImageSearchDebug(serial, local, limit, refresh) {
  return {
    serial,
    local,
    limit,
    refresh,
    startedAt: new Date().toISOString(),
    c130Net: {
      attempted: false,
      found: 0,
      acceptedInitial: 0,
      acceptedTopUp: 0,
      rejected: {},
      acceptedSamples: [],
      rejectedSamples: [],
      errors: []
    },
    bingImages: [],
    bingPages: [],
    final: { count: 0, sources: {} }
  };
}

function debugCounter(bucket, key, amount = 1) {
  if (!bucket) return;
  bucket[key] = (bucket[key] || 0) + amount;
}

function summarizeImageSearchDebug(debug) {
  const bingRaw = debug.bingImages.reduce((sum, item) => sum + (item.rawResults || 0), 0);
  const bingAccepted = debug.bingImages.reduce((sum, item) => sum + (item.accepted || 0), 0);
  const bingRejected = debug.bingImages.reduce((sum, item) => sum + Object.values(item.rejected || {}).reduce((a, b) => a + b, 0), 0);
  const pageCandidates = debug.bingPages.reduce((sum, item) => sum + (item.pages || 0), 0);
  const pageAccepted = debug.bingPages.reduce((sum, item) => sum + (item.accepted || 0), 0);
  return {
    serial: debug.serial,
    local: debug.local,
    c130Found: debug.c130Net.found,
    c130Accepted: debug.c130Net.acceptedInitial + debug.c130Net.acceptedTopUp,
    bingRaw,
    bingAccepted,
    bingRejected,
    pageCandidates,
    pageAccepted,
    finalCount: debug.final.count,
    finalSources: debug.final.sources
  };
}

function logImageSearchDebug(debug) {
  try {
    console.log(`[image-search] ${JSON.stringify(summarizeImageSearchDebug(debug))}`);
  } catch (error) {
    console.log(`[image-search] ${debug.serial}: ${debug.final.count} images returned`);
  }
}

function normalizeBingImageUrl(rawUrl) {
  return normalizeImageUrl(safeDecodeURIComponent(rawUrl));
}

async function pageConfirmsIdentity(pageUrl, serial, local) {
  if (!pageUrl || !isCandidateSourcePageUrl(pageUrl)) return false;
  const html = await fetchText(pageUrl).catch(() => "");
  if (!html) return false;
  return identityIsConfirmed(`${pageUrl} ${html}`, serial, local) && likelyMc130Context(`${pageUrl} ${html}`);
}


function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function decodeRepeatedURIComponent(value) {
  let current = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    const decoded = safeDecodeURIComponent(current);
    if (decoded === current) break;
    current = decoded;
  }
  return normalizeImageUrl(decodeHtmlEntities(current));
}

function tagAttribute(tag, name) {
  const match = String(tag || "").match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return match ? decodeHtmlEntities(match[1]) : "";
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function bingResultPageUrlFromDetailUrl(detailUrl) {
  try {
    const parsed = new URL(detailUrl, "https://www.bing.com");
    const candidates = [
      parsed.searchParams.get("purl"),
      parsed.searchParams.get("rurl"),
      parsed.searchParams.get("url"),
      parsed.searchParams.get("adurl")
    ];
    for (const candidate of candidates) {
      const decoded = decodeRepeatedURIComponent(candidate || "");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  } catch (error) {
    return "";
  }
  return "";
}

function bingImageUrlFromDetailUrl(detailUrl) {
  try {
    const parsed = new URL(detailUrl, "https://www.bing.com");
    const candidates = [
      parsed.searchParams.get("mediaurl"),
      parsed.searchParams.get("imgurl"),
      parsed.searchParams.get("murl")
    ];
    for (const candidate of candidates) {
      const decoded = decodeRepeatedURIComponent(candidate || "");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  } catch (error) {
    return "";
  }
  return "";
}

function bingDimensionsFromDetailUrl(detailUrl) {
  try {
    const parsed = new URL(detailUrl, "https://www.bing.com");
    return {
      width: Number(parsed.searchParams.get("expw") || parsed.searchParams.get("w") || parsed.searchParams.get("width") || 0),
      height: Number(parsed.searchParams.get("exph") || parsed.searchParams.get("h") || parsed.searchParams.get("height") || 0)
    };
  } catch (error) {
    return { width: 0, height: 0 };
  }
}

function collectBingDetailLinks(html, baseUrl) {
  const results = [];
  const add = (href, metadata = "", width = 0, height = 0) => {
    const decodedHref = decodeRepeatedURIComponent(href);
    let absolute = "";
    try {
      absolute = new URL(decodedHref, baseUrl).href;
    } catch (error) {
      return;
    }

    const imageUrl = bingImageUrlFromDetailUrl(absolute);
    if (!imageUrl) return;
    const pageUrl = bingResultPageUrlFromDetailUrl(absolute);
    const dimensions = bingDimensionsFromDetailUrl(absolute);
    results.push({
      imageUrl,
      pageUrl,
      metadata,
      width: Number(width || dimensions.width || 0),
      height: Number(height || dimensions.height || 0)
    });
  };

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*(?:mediaurl|imgurl|murl)=[^"']+)["'][^>]*>/gi)) {
    const tag = match[0];
    const start = Math.max(0, (match.index || 0) - 450);
    const end = Math.min(html.length, (match.index || 0) + tag.length + 450);
    const metadata = [
      tagAttribute(tag, "aria-label"),
      tagAttribute(tag, "title"),
      tagAttribute(tag, "data-title"),
      stripHtml(html.slice(start, end))
    ].filter(Boolean).join(" ");
    add(match[1], metadata);
  }

  // Bing often stores the clicked/detail view URL as escaped text rather than as a clean anchor href.
  for (const match of html.matchAll(/(?:href|murl|mediaurl|imgurl)["'=:\s]+([^"'<>\s]*(?:mediaurl|imgurl|murl)=[^"'<>\s]+)/gi)) {
    add(match[1], querySafeMetadataFromBingSnippet(html, match.index || 0));
  }

  return results;
}

function querySafeMetadataFromBingSnippet(html, index) {
  const start = Math.max(0, Number(index || 0) - 500);
  const end = Math.min(html.length, Number(index || 0) + 500);
  return stripHtml(html.slice(start, end));
}

function collectBingMetadataObjects(html) {
  const results = [];
  const parseItem = (raw, fallbackMetadata = "") => {
    try {
      const json = decodeHtmlEntities(raw)
        .replaceAll("\\/", "/")
        .replaceAll("\\u002f", "/");
      const item = JSON.parse(json);
      const imageUrl = item.murl || item.mediaurl || item.imgurl || "";
      if (!imageUrl) return;
      results.push({
        imageUrl,
        metadata: `${item.t || ""} ${item.desc || ""} ${item.snippet || ""} ${item.purl || ""} ${fallbackMetadata}`,
        width: item.w || item.width || item.expw || 0,
        height: item.h || item.height || item.exph || 0,
        pageUrl: item.purl || item.rurl || ""
      });
    } catch (error) {
      // Ignore malformed Bing metadata; other extraction paths handle the same page.
    }
  };

  for (const match of html.matchAll(/<a\b[^>]*\bm=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0];
    const metadata = [tagAttribute(tag, "aria-label"), tagAttribute(tag, "title")].filter(Boolean).join(" ");
    parseItem(match[1], metadata);
  }

  for (const match of html.matchAll(/\bm=(?:&quot;|")({[\s\S]*?})(?:&quot;|")/g)) {
    parseItem(match[1]);
  }

  return results;
}

async function fetchBingImages(query, serial, local, limit, debug) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC3&first=1&safeSearch=strict`;
  const debugEntry = {
    query,
    url,
    rawResults: 0,
    accepted: 0,
    rejected: {},
    pageChecks: 0,
    pageConfirmed: 0,
    error: "",
    acceptedSamples: [],
    rejectedSamples: [],
    rawSamples: []
  };
  debug?.bingImages?.push(debugEntry);

  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    debugEntry.error = `HTTP ${response.status}`;
    throw new Error(`Image search failed with HTTP ${response.status}`);
  }

  const html = await response.text();
  const rawResults = [];
  const rawSeen = new Set();

  const collectImage = (rawUrl, metadata = "", width = 0, height = 0, pageUrl = "") => {
    const imageUrl = normalizeBingImageUrl(rawUrl);
    const key = imageUrl.split("?")[0].toLowerCase();
    if (rawSeen.has(key)) {
      debugCounter(debugEntry.rejected, "duplicate_raw_url");
      return;
    }
    if (!isUsefulImageUrl(imageUrl, { enforceAllowedHosts: false })) {
      debugCounter(debugEntry.rejected, "not_useful_or_blocked_url");
      return;
    }
    rawSeen.add(key);
    rawResults.push({ imageUrl, metadata, width, height, pageUrl });
    addDebugSample(debugEntry.rawSamples, { imageUrl, pageUrl, metadata: String(metadata || "").slice(0, 220), width, height }, 8);
  };

  for (const item of collectBingMetadataObjects(html)) {
    collectImage(item.imageUrl, item.metadata, item.width, item.height, item.pageUrl);
  }

  for (const item of collectBingDetailLinks(html, url)) {
    collectImage(item.imageUrl, item.metadata, item.width, item.height, item.pageUrl);
  }

  const encodedParamPatterns = [
    /[?&](?:mediaurl|imgurl|murl)=([^&"'<>\s]+)/gi,
    /(?:mediaurl|imgurl|murl)(?:&quot;|"|')?\s*[:=]\s*(?:&quot;|"|')([^&"'<>\s]+)(?:&quot;|"|')?/gi
  ];

  for (const pattern of encodedParamPatterns) {
    for (const match of html.matchAll(pattern)) {
      collectImage(match[1], querySafeMetadataFromBingSnippet(html, match.index || 0));
    }
  }

  const directPatterns = [
    /murl&quot;:&quot;(https?:.*?)(?:&quot;|\\")/g,
    /"murl":"(https?:.*?)(?:"|\\")/g
  ];

  for (const pattern of directPatterns) {
    for (const match of html.matchAll(pattern)) {
      collectImage(match[1], querySafeMetadataFromBingSnippet(html, match.index || 0));
    }
  }

  debugEntry.rawResults = rawResults.length;

  const results = [];
  const seen = new Set();
  const pageIdentityCache = new Map();

  for (const raw of rawResults) {
    const key = raw.imageUrl.split("?")[0].toLowerCase();
    if (seen.has(key)) {
      debugCounter(debugEntry.rejected, "duplicate_final_url");
      continue;
    }

    const evidence = `${raw.metadata} ${raw.imageUrl} ${raw.pageUrl}`;
    const contextEvidence = `${query} ${evidence}`;
    let confirmed = identityIsConfirmed(evidence, serial, local);
    let confirmedBy = "Bing image-result metadata, detail URL, or image/source URL contains exact serial/local marking";

    if (!confirmed && raw.pageUrl) {
      const pageKey = raw.pageUrl.split("?")[0].toLowerCase();
      if (!pageIdentityCache.has(pageKey)) {
        debugEntry.pageChecks += 1;
        pageIdentityCache.set(pageKey, await pageConfirmsIdentity(raw.pageUrl, serial, local));
      }
      confirmed = pageIdentityCache.get(pageKey);
      if (confirmed) debugEntry.pageConfirmed += 1;
      confirmedBy = "Bing image result source page contains exact serial/local marking";
    }

    if (!confirmed) {
      debugCounter(debugEntry.rejected, "serial_or_local_not_confirmed");
      addDebugSample(debugEntry.rejectedSamples, { reason: "serial_or_local_not_confirmed", imageUrl: raw.imageUrl, pageUrl: raw.pageUrl, metadata: String(raw.metadata || "").slice(0, 220) });
      continue;
    }
    if (!likelyMc130Context(contextEvidence)) {
      debugCounter(debugEntry.rejected, "no_mc130_or_c130_context");
      addDebugSample(debugEntry.rejectedSamples, { reason: "no_mc130_or_c130_context", imageUrl: raw.imageUrl, pageUrl: raw.pageUrl, metadata: String(raw.metadata || "").slice(0, 220) });
      continue;
    }

    const validated = await validateImageCandidate(raw.imageUrl, { enforceAllowedHosts: false, rejectBranding: true });
    if (!validated) {
      debugCounter(debugEntry.rejected, "image_validation_failed");
      addDebugSample(debugEntry.rejectedSamples, { reason: "image_validation_failed", imageUrl: raw.imageUrl, pageUrl: raw.pageUrl, metadata: String(raw.metadata || "").slice(0, 220) });
      continue;
    }

    const width = Number(raw.width || validated.width || 0) || undefined;
    const height = Number(raw.height || validated.height || 0) || undefined;
    const sizePreference = imageSizePreference(width, height);
    results.push({
      ...validated,
      url: raw.imageUrl,
      pageUrl: raw.pageUrl || url,
      source: "Bing Images",
      query,
      width,
      height,
      sizePreference,
      preferredSize: sizePreference !== "small",
      identityConfirmed: true,
      identityConfirmedBy: confirmedBy
    });
    debugEntry.accepted += 1;
    addDebugSample(debugEntry.acceptedSamples, { imageUrl: raw.imageUrl, pageUrl: raw.pageUrl, width, height, confirmedBy, metadata: String(raw.metadata || "").slice(0, 220) }, 8);
    seen.add(key);
    if (results.length >= limit * 2) break;
  }

  return sortedImages(results).slice(0, limit);
}

function decodeBase64Url(value) {
  try {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "===".slice((normalized.length + 3) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch (error) {
    return "";
  }
}

function decodeBingResultUrl(rawHref, baseUrl = "https://www.bing.com") {
  try {
    const absolute = new URL(normalizeImageUrl(rawHref), baseUrl);
    if (!/(^|\.)bing\.com$/i.test(absolute.hostname)) return absolute.href;

    const u = absolute.searchParams.get("u") || absolute.searchParams.get("r") || "";
    if (u) {
      if (/^https?:\/\//i.test(u)) return u;
      const stripped = u.replace(/^a1/i, "");
      const decoded = decodeBase64Url(stripped) || decodeBase64Url(u);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }

    const urlParam = absolute.searchParams.get("url");
    if (urlParam && /^https?:\/\//i.test(urlParam)) return urlParam;
    return "";
  } catch (error) {
    return "";
  }
}

async function fetchBingPages(query, limit, debug) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=1&safeSearch=strict`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  const debugEntry = { query, url, pages: 0, accepted: 0, rejected: {}, samples: [], errors: [] };
  debug?.bingPages?.push(debugEntry);
  if (!response.ok) {
    debugEntry.errors.push(`HTTP ${response.status}`);
    return [];
  }

  const html = await response.text();
  const pages = [];
  const seen = new Set();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const decoded = decodeBingResultUrl(match[1], url);
    if (!decoded) {
      debugCounter(debugEntry.rejected, "undecodable_bing_href");
      continue;
    }
    const pageUrl = normalizeImageUrl(decoded);
    const key = pageUrl.split("?")[0].toLowerCase();
    if (seen.has(key)) {
      debugCounter(debugEntry.rejected, "duplicate_page_url");
      continue;
    }
    if (!isCandidateSourcePageUrl(pageUrl)) {
      debugCounter(debugEntry.rejected, "not_candidate_source_page");
      continue;
    }
    seen.add(key);
    pages.push(pageUrl);
    addDebugSample(debugEntry.samples, { pageUrl }, 6);
    debugEntry.pages = pages.length;
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

function attrValue(tag, attr) {
  const match = tag.match(new RegExp(`${attr}=["']?([^"'\\s>]+)`, "i"));
  return match ? match[1] : "";
}

async function extractImagesFromPage(pageUrl, query, limit, serial, local, debugEntry) {
  try {
    const response = await fetch(pageUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) {
      debugEntry?.errors?.push(`${pageUrl}: HTTP ${response.status}`);
      return [];
    }
    const html = await response.text();
    const pageEvidence = `${pageUrl} ${html}`;
    if (!identityIsConfirmed(pageEvidence, serial, local)) {
      debugEntry && debugCounter(debugEntry, "source_page_identity_not_confirmed");
      return [];
    }
    if (!likelyMc130Context(pageEvidence)) {
      debugEntry && debugCounter(debugEntry, "source_page_no_mc130_context");
      return [];
    }

    const candidates = [];
    const seen = new Set();
    const addCandidate = (rawUrl, sourceTag = "", width = 0, height = 0) => {
      const imageUrl = normalizeImageUrl(absolutizeUrl(rawUrl, pageUrl));
      const key = imageUrl.split("?")[0].toLowerCase();
      const evidence = `${pageUrl} ${sourceTag} ${imageUrl}`;
      if (seen.has(key)) {
        debugEntry && debugCounter(debugEntry, "duplicate_page_image");
        return false;
      }
      if (!isUsefulImageUrl(imageUrl, { enforceAllowedHosts: false })) {
        debugEntry && debugCounter(debugEntry, "page_image_not_useful_or_blocked");
        return false;
      }
      seen.add(key);
      candidates.push({
        url: imageUrl,
        pageUrl,
        source: new URL(pageUrl).hostname,
        query,
        width: Number(width || 0) || undefined,
        height: Number(height || 0) || undefined,
        sizePreference: imageSizePreference(width, height),
        preferredSize: imageSizePreference(width, height) !== "small",
        identityConfirmed: true,
        identityConfirmedBy: "Source page contains exact serial/local marking"
      });
      if (debugEntry) debugEntry.accepted = (debugEntry.accepted || 0) + 1;
      return candidates.length >= limit;
    };

    const metaPatterns = [
      /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi
    ];
    for (const pattern of metaPatterns) {
      for (const match of html.matchAll(pattern)) {
        if (addCandidate(match[1], match[0], 1024, 0)) return sortedImages(candidates).slice(0, limit);
      }
    }

    for (const match of html.matchAll(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["'][^>]*>/gi)) {
      const tag = match[0];
      const width = Number(attrValue(tag, "width") || 0);
      const height = Number(attrValue(tag, "height") || 0);
      if (addCandidate(match[1], tag, width, height)) return sortedImages(candidates).slice(0, limit);
    }

    return sortedImages(candidates).slice(0, limit);
  } catch (error) {
    debugEntry?.errors?.push(`${pageUrl}: ${error.message || "page extraction failed"}`);
    return [];
  }
}

function addUniqueImage(images, seen, image) {
  const imageKey = image.url.split("?")[0].toLowerCase();
  if (seen.has(imageKey) || !image.identityConfirmed) return false;
  seen.add(imageKey);
  images.push(image);
  return true;
}

async function handleImages(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const serial = url.searchParams.get("serial") || "";
  const local = url.searchParams.get("local") || "";
  const sourcePage = url.searchParams.get("source") || "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 10), 1), 10);
  const refresh = url.searchParams.get("refresh") === "1";
  const debugEnabled = url.searchParams.get("debug") === "1" || process.env.IMAGE_SEARCH_DEBUG === "1";
  const debug = createImageSearchDebug(serial, local, limit, refresh);

  if (!serial) {
    sendJson(res, 400, { error: "Missing serial" });
    return;
  }

  const cache = await readImageCache();
  const searchCacheKey = cacheKey(serial, local);
  if (!refresh && isFreshCache(cache[searchCacheKey])) {
    debug.final.count = cache[searchCacheKey].images.slice(0, limit).length;
    debug.final.sources = cache[searchCacheKey].images.slice(0, limit).reduce((acc, image) => {
      acc[image.source || "Unknown"] = (acc[image.source || "Unknown"] || 0) + 1;
      return acc;
    }, {});
    logImageSearchDebug(debug);
    sendJson(res, 200, { serial, local, cached: true, images: cache[searchCacheKey].images.slice(0, limit), ...(debugEnabled ? { debug } : {}) });
    return;
  }

  const queries = [
    `"${serial}" "MC-130J"`,
    local ? `"${local}" "MC-130J"` : "",
    local ? `"${local}" "Commando II"` : "",
    local ? `"${serial}" "${local}"` : "",
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
  debug.c130Net.attempted = Boolean(sourcePage);
  const c130Images = sortedImages(await fetchC130NetImages(serial, local, sourcePage, limit, debug).catch((error) => {
    debug.c130Net.errors.push(error.message || "C-130.net search failed");
    return [];
  }));
  debug.c130Net.found = c130Images.length;
  const c130InitialLimit = Math.min(c130Images.length, Math.max(3, Math.floor(limit / 2)));

  for (const image of c130Images.slice(0, c130InitialLimit)) {
    if (addUniqueImage(images, seen, image)) debug.c130Net.acceptedInitial += 1;
  }

  // Always run Bing image searches even when C-130.net returned candidates, so the result set includes independent imagery.
  for (const query of queries) {
    const found = await fetchBingImages(query, serial, local, limit, debug).catch((error) => {
      const last = debug.bingImages[debug.bingImages.length - 1];
      if (last && !last.error) last.error = error.message || "Bing image search failed";
      return [];
    });
    for (const image of found) {
      addUniqueImage(images, seen, image);
      if (images.length >= limit) break;
    }
    if (images.length >= limit) break;
  }

  // Fall back to source pages found through Bing only when image search has not filled the target set.
  if (images.length < limit) {
    for (const query of queries) {
      const pageDebug = { query, pages: 0, accepted: 0, errors: [] };
      const pages = await fetchBingPages(query, 8, debug).catch((error) => {
        pageDebug.errors.push(error.message || "Bing page search failed");
        return [];
      });
      const activePageDebug = debug.bingPages[debug.bingPages.length - 1] || pageDebug;
      for (const page of pages) {
        const found = await extractImagesFromPage(page, query, limit - images.length, serial, local, activePageDebug);
        for (const image of found) {
          addUniqueImage(images, seen, image);
          if (images.length >= limit) break;
        }
        if (images.length >= limit) break;
      }
      if (images.length >= limit) break;
    }
  }

  // If strict Bing confirmation is sparse, top up with remaining source-confirmed C-130.net full-size images.
  if (images.length < limit) {
    for (const image of c130Images.slice(c130InitialLimit)) {
      if (addUniqueImage(images, seen, image)) debug.c130Net.acceptedTopUp += 1;
      if (images.length >= limit) break;
    }
  }

  const finalImages = sortedImages(images).slice(0, limit);
  debug.final.count = finalImages.length;
  debug.final.sources = finalImages.reduce((acc, image) => {
    acc[image.source || "Unknown"] = (acc[image.source || "Unknown"] || 0) + 1;
    return acc;
  }, {});
  debug.finishedAt = new Date().toISOString();
  logImageSearchDebug(debug);
  cache[searchCacheKey] = { serial, local, images: finalImages, updatedAt: new Date().toISOString() };
  await writeImageCache(cache);
  sendJson(res, 200, { serial, local, cached: false, images: finalImages, ...(debugEnabled ? { debug } : {}) });
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
