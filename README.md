# MC-130J Identifier

A small browser app for researching USAF MC-130J serials, finding public images, and recording AI-assisted observations about visible markings.

## Features

- Lists MC-130J serial records, including production-list core records and newer public C-130.net candidates.
- Opens focused image searches for each serial.
- Sends a selected image URL or local image file to OpenAI's Responses API for marking analysis.
- Stores manual observations in browser local storage and exports them as JSON.

## Run Locally

```powershell
npm start
```

Then open `http://localhost:3000`.

## Deploy On Railway

1. Push this repo to GitHub.
2. Create a new Railway project from the GitHub repo.
3. Railway should detect Node.js and run `npm start`.
4. No server-side environment variables are required. Users enter their OpenAI API key in the browser when running an analysis.

## Data Notes

The app ships with a static public-source seed list. Treat AI analysis as a research aid, not proof of identity. Public records can differ depending on whether they count aircraft built as MC-130J, converted to AC-130J, or currently assigned as MC-130J.
