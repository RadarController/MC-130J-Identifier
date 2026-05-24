# MC-130J Identifier

A small browser app for researching USAF MC-130J serials, finding public images, and recording AI-assisted observations about visible markings.

## Features

- Lists MC-130J serial records, including production-list core records and newer public C-130.net candidates.
- Opens focused image searches for each serial.
- Scrapes public image search results for 6-10 candidate photos per selected serial.
- Caches image search results server-side so the same serial is not scraped on every request.
- Sends displayed image URLs to Groq's OpenAI-compatible Responses API for marking analysis.
- Stores manual observations and Groq comparison reports in Postgres when `DATABASE_URL` is configured.

## Run Locally

```powershell
npm start
```

Then open `http://localhost:3000`.

To run AI analysis locally, set:

```powershell
$env:GROQ_API_KEY="your-key"
$env:GROQ_MODEL="meta-llama/llama-4-scout-17b-16e-instruct"
npm start
```

`GROQ_MODEL` is optional; the app defaults to Llama 4 Scout.

Image search results are cached for 168 hours by default in `.cache/image-search-cache.json`. Override with:

```powershell
$env:CACHE_DIR="C:\path\to\cache"
$env:IMAGE_CACHE_TTL_HOURS="168"
```

Manual observations and Groq reports use Postgres when `DATABASE_URL` is set. Without `DATABASE_URL`, the app falls back to `.cache/observations-db.json` for local development.

## Deploy On Railway

1. Push this repo to GitHub.
2. Create a new Railway project from the GitHub repo.
3. Add a Railway variable named `GROQ_API_KEY`.
4. Optionally add `GROQ_MODEL` to override the default vision model.
5. Add a Railway Postgres database and make sure `DATABASE_URL` is available to the web service.
6. Optionally add a Railway Volume and set `CACHE_DIR` to the mounted path, such as `/data`, so image-search cache survives redeploys.
7. Railway should detect Node.js and run `npm start`.

## Data Notes

The app ships with a static public-source seed list. Treat image scraping and AI analysis as research aids, not proof of identity. Public records can differ depending on whether they count aircraft built as MC-130J, converted to AC-130J, or currently assigned as MC-130J. Groq vision models currently accept up to 5 images per request, so the server analyzes larger image sets in batches and synthesizes the reports.
