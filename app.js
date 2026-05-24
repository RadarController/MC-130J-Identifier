const aircraft = [
  ["08-6202","5681","08-202","Unknown","core",1437],["08-6203","5682","08-203","Unknown","core",1437],
  ["08-6204","5694","08-204","Unknown","core",1437],["08-6205","5695","08-205","Unknown","core",1437],
  ["08-6206","5696","08-206","Unknown","core",1441],["09-5710","5710","09-710","07 Dec 2012","core",1441],
  ["09-5711","5711","09-711","Unknown","core",1456],["09-5713","5713","09-713","Unknown","core",1456],
  ["09-6207","5656","96207","Unknown","core",1456],["09-6208","5657","96208","Oct 2011","core",1456],
  ["09-6209","5658","96209","09 Oct 2011","core",1456],["09-6210","5659","96210","Oct 2011","core",1456],
  ["10-5714","5714","10-714","22 Feb 2013","core",1456],["11-5729","5729","11-729","Unknown","core",1471],
  ["11-5731","5731","11-731","Unknown","core",1471],["11-5733","5733","11-733","Unknown","core",1471],
  ["11-5735","5735","11-735","Unknown","core",1471],["11-5737","5737","11-737","20 Dec 2013","core",1471],
  ["12-5753","5753","25753","Unknown","core",1486],["12-5757","5757","25757","09 Oct 2014","core",1486],
  ["12-5759","5759","25759","06 Dec 2014","core",1486],["12-5760","5760","25760","03 Dec 2014","core",1486],
  ["12-5761","5761","25761","Unknown","core",1486],["12-5762","5762","25762","Unknown","core",1486],
  ["12-5763","5763","25763","19 Mar 2015","core",1486],["12-5772","5772","25772","Unknown","core",1486],
  ["13-5770","5770","35770","Unknown","core",1486],["13-5775","5775","35775","Jul 2015","core",1501],
  ["13-5776","5776","35776","Unknown","core",1501],["13-5777","5777","35777","Oct 2015","core",1501],
  ["13-5778","5778","35778","Oct 2015","core",1501],["13-5783","5783","35783","25 Feb 2016","core",1501],
  ["13-5786","5786","13-786","17 Jan 2016","core",1501],["14-5787","5787","45787","08 Mar 2016","core",1501],
  ["14-5789","5789","45789","06 May 2016","core",1501],["14-5793","5793","45793","09 Jun 2016","core",1501],
  ["14-5795","5795","45795","09 Jun 2016","core",1516],["14-5797","5797","45797","05 Aug 2016","core",1516],
  ["14-5800","5800","45800","Unknown","core",1516],["14-5803","5803","45803","16 Nov 2016","core",1516],
  ["14-5805","5805","45805","23 Dec 2016","core",1516],["14-5809","5809","45809","Unknown","core",1516],
  ["15-5811","5811","15-5811","24 Mar 2017","core",1516],["16-5835","5835","65835","Feb 2018","core",1531],
  ["16-5839","5839","65839","Unknown","core",1546],["16-5850","5850","","Unknown","core",1546],
  ["16-5862","5862","","Unknown","core",1561],["17-5875","5875","","Unknown","core",1561],
  ["17-5876","5876","75876","Unknown","core",1576],["17-5878","5878","75878","Unknown","core",1576],
  ["17-5898","5898","17898","Unknown","core",1576],["17-5903","5903","","Unknown","core",1576],
  ["18-5884","5884","","Unknown","core",1576],["18-5888","5888","","Unknown","core",1591],
  ["18-5916","5916","18-5916","Unknown","core",1591],["18-5920","5920","85920","Unknown","core",1591],
  ["19-5922","5922","95922","Unknown","core",1591],["19-5924","5924","","Unknown","core",1606],
  ["19-5926","5926","","Unknown","core",1606],["19-5931","5931","05931","Unknown","core",1606],
  ["20-5933","5933","05933","Unknown","core",1621],["19-5950","5950","","Oct 2023","newer",1606],
  ["19-5953","5953","95953","Unknown","newer",1606],["19-5957","5957","95967","Unknown","newer",1606],
  ["20-5935","5935","","Unknown","newer",1621],["20-5937","5937","20-5937","Unknown","newer",1621],
  ["20-5939","5939","","Unknown","newer",1621],["20-5941","5941","05941","Unknown","newer",1621],
  ["20-5943","5943","","Unknown","newer",1621],["20-5946","5946","20-5946","Unknown","newer",1621],
  ["20-5961","5961","05961","Unknown","newer",1621],["21-5965","5965","15965","Unknown","newer",1621],
  ["21-5973","5973","15973","Unknown","newer",1621],["21-5981","5981","15981","Unknown","newer",1636],
  ["21-5985","5985","21-5985","Unknown","newer",1636],["22-5989","5989","25989","Unknown","newer",1636],
  ["22-5994","5994","25994","Unknown","newer",1636]
].map(([serial, tv, local, delivered, set, page]) => ({
  serial, tv, local, delivered, set,
  source: `https://www.c-130.net/aircraft-database/C-130/serials-and-inventory/airforce/USAF/${page}/`
}));

const els = {
  list: document.querySelector("#serial-list"),
  search: document.querySelector("#search"),
  filter: document.querySelector("#record-filter"),
  visible: document.querySelector("#visible-count"),
  total: document.querySelector("#total-count"),
  title: document.querySelector("#selected-title"),
  tags: document.querySelector("#selected-tags"),
  google: document.querySelector("#google-link"),
  bing: document.querySelector("#bing-link"),
  jetphotos: document.querySelector("#jetphotos-link"),
  airhistory: document.querySelector("#airhistory-link"),
  source: document.querySelector("#source-link"),
  model: document.querySelector("#model"),
  context: document.querySelector("#context"),
  aiForm: document.querySelector("#ai-form"),
  imageGrid: document.querySelector("#image-grid"),
  imageStatus: document.querySelector("#image-status"),
  findImages: document.querySelector("#find-images"),
  output: document.querySelector("#ai-output"),
  paintLine: document.querySelector("#paint-line"),
  markings: document.querySelector("#markings"),
  confidence: document.querySelector("#confidence"),
  saveNote: document.querySelector("#save-note"),
  exportJson: document.querySelector("#export-json"),
  clearResult: document.querySelector("#clear-result")
};

let selected = aircraft[0];
let recordLoadToken = 0;
function readStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch (error) {
    localStorage.removeItem(key);
    return fallback;
  }
}

const imageCache = readStoredJson("mc130j-image-cache", {});
const observationCache = {};
els.total.textContent = aircraft.length;

function searchQuery(item) {
  return `"${item.serial}" "MC-130J" OR "${item.local}" "Commando II"`;
}

function updateLinks(item) {
  const q = encodeURIComponent(searchQuery(item));
  els.google.href = `https://www.google.com/search?tbm=isch&q=${q}`;
  els.bing.href = `https://www.bing.com/images/search?q=${q}`;
  els.jetphotos.href = `https://www.jetphotos.com/photo/keyword/${encodeURIComponent(item.serial)}`;
  els.airhistory.href = `https://www.airhistory.net/search?keywords=${encodeURIComponent(item.serial)}`;
  els.source.href = item.source;
}

function renderTags(item) {
  els.tags.innerHTML = "";
  [
    `T/V ${item.tv}`,
    item.local ? `Marked ${item.local}` : "No local S/N in source row",
    item.set === "core" ? "Production-list core" : "Newer candidate"
  ].forEach((text) => {
    const span = document.createElement("span");
    span.className = `badge${item.set === "newer" && text.includes("Newer") ? " warning" : ""}`;
    span.textContent = text;
    els.tags.appendChild(span);
  });
}

function selectAircraft(item) {
  selected = item;
  els.title.textContent = item.serial;
  renderTags(item);
  updateLinks(item);
  renderImages(item.serial);
  applySerialRecord(observationCache[item.serial]);
  loadSerialRecord(item.serial);
  document.querySelectorAll(".serial-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.serial === item.serial);
  });
}

function applySerialRecord(record) {
  const latestManual = record?.latestManualObservation;
  const latestGroq = record?.latestGroqAnalysis;
  els.paintLine.value = latestManual?.paintLine || "";
  els.markings.value = latestManual?.markings || "";
  els.confidence.value = latestManual?.confidence || 0;
  els.output.textContent = latestGroq?.report
    ? latestGroq.report
    : "No saved Groq analysis yet.";
}

async function loadSerialRecord(serial) {
  const token = ++recordLoadToken;
  try {
    const response = await fetch(`/api/records?serial=${encodeURIComponent(serial)}`);
    const record = await response.json();
    if (!response.ok) throw new Error(record.error || "Could not load saved record.");
    observationCache[serial] = record;
    if (token === recordLoadToken && selected.serial === serial) {
      applySerialRecord(record);
    }
  } catch (error) {
    if (token === recordLoadToken && selected.serial === serial) {
      els.output.textContent = `Could not load saved record: ${error.message}`;
    }
  }
}

function filteredAircraft() {
  const term = els.search.value.trim().toLowerCase();
  const filter = els.filter.value;
  return aircraft.filter((item) => {
    const inSet = filter === "all" || (filter === "production" ? item.set === "core" : item.set === "newer");
    const haystack = `${item.serial} ${item.tv} ${item.local} ${item.delivered}`.toLowerCase();
    return inSet && (!term || haystack.includes(term));
  });
}

function renderList() {
  const items = filteredAircraft();
  els.visible.textContent = `${items.length} shown`;
  els.list.innerHTML = "";
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "serial-item";
    button.dataset.serial = item.serial;
    button.innerHTML = `
      <span><strong>${item.serial}</strong><br><small>T/V ${item.tv} | Local ${item.local || "n/a"} | ${item.delivered}</small></span>
      <span class="badge${item.set === "newer" ? " warning" : ""}">${item.set}</span>
    `;
    button.addEventListener("click", () => selectAircraft(item));
    els.list.appendChild(button);
  });
  if (!items.includes(selected) && items[0]) selectAircraft(items[0]);
  else selectAircraft(selected);
}

function selectedImageUrls() {
  return Array.from(els.imageGrid.querySelectorAll("input[type='checkbox']:checked"))
    .map((input) => {
      const image = imageCache[selected.serial]?.[Number(input.value)];
      return image ? { url: image.url, source: image.source, query: image.query } : null;
    })
    .filter(Boolean);
}

function renderImages(serial) {
  const images = imageCache[serial] || [];
  els.imageGrid.innerHTML = "";

  if (images.length === 0) {
    els.imageStatus.textContent = "No images loaded.";
    return;
  }

  els.imageStatus.textContent = `${images.length} images loaded.`;
  images.forEach((image, index) => {
    const article = document.createElement("article");
    article.className = "image-card";
    article.innerHTML = `
      <img src="${image.url}" alt="${serial} candidate image ${index + 1}" loading="lazy" referrerpolicy="no-referrer">
      <footer>
        <label><input type="checkbox" value="${index}" checked> Include in AI comparison</label>
        <a href="${image.url}" target="_blank" rel="noreferrer">Open image</a>
      </footer>
    `;
    article.querySelector("img").addEventListener("error", () => {
      article.classList.add("broken");
      article.querySelector("img").alt = "Image could not be displayed";
    });
    els.imageGrid.appendChild(article);
  });
}

async function findImages() {
  els.imageStatus.textContent = `Searching images for ${selected.serial}...`;
  els.output.textContent = "Finding candidate images...";
  const params = new URLSearchParams({
    serial: selected.serial,
    local: selected.local || "",
    source: selected.source || "",
    limit: "10"
  });
  const response = await fetch(`/api/images?${params}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Image search failed.");
  }
  imageCache[selected.serial] = data.images || [];
  localStorage.setItem("mc130j-image-cache", JSON.stringify(imageCache));
  renderImages(selected.serial);
  els.output.textContent = imageCache[selected.serial].length
    ? `Found ${imageCache[selected.serial].length} candidate images for ${selected.serial}.`
    : `No candidate images found for ${selected.serial}. Try the manual image links above.`;
}

async function analyzeImage(event) {
  event.preventDefault();
  const images = selectedImageUrls();
  if (images.length === 0) {
    els.output.textContent = "Find images first, then leave at least one image selected.";
    return;
  }

  els.output.textContent = `Analyzing ${images.length} image${images.length === 1 ? "" : "s"} with Groq...`;
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      aircraft: selected,
      images,
      context: els.context.value.trim(),
      model: els.model.value.trim()
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Groq analysis failed.");
  }
  if (data.savedAnalysis) {
    observationCache[selected.serial] = {
      ...(observationCache[selected.serial] || {}),
      latestGroqAnalysis: data.savedAnalysis,
      groqAnalyses: [
        ...(observationCache[selected.serial]?.groqAnalyses || []),
        data.savedAnalysis
      ]
    };
  }
  els.output.textContent = data.report || JSON.stringify(data, null, 2);
}

async function saveObservation() {
  const response = await fetch("/api/observations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serial: selected.serial,
    paintLine: els.paintLine.value,
    markings: els.markings.value.trim(),
      confidence: els.confidence.value
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not save observation.");
  }
  observationCache[selected.serial] = {
    ...(observationCache[selected.serial] || {}),
    latestManualObservation: data.saved,
    manualObservations: data.manualObservations || []
  };
  els.output.textContent = `Saved observation for ${selected.serial}.`;
}

async function exportNotes() {
  const response = await fetch("/api/records");
  const database = await response.json();
  if (!response.ok) {
    throw new Error(database.error || "Could not export database.");
  }
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), database }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mc130j-database-export.json";
  a.click();
  URL.revokeObjectURL(url);
}

els.search.addEventListener("input", renderList);
els.filter.addEventListener("change", renderList);
els.findImages.addEventListener("click", () => findImages().catch((error) => {
  els.imageStatus.textContent = "Image search failed.";
  els.output.textContent = error.message;
}));
els.aiForm.addEventListener("submit", (event) => analyzeImage(event).catch((error) => {
  els.output.textContent = error.message;
}));
els.saveNote.addEventListener("click", () => saveObservation().catch((error) => {
  els.output.textContent = error.message;
}));
els.exportJson.addEventListener("click", () => exportNotes().catch((error) => {
  els.output.textContent = error.message;
}));
els.clearResult.addEventListener("click", () => {
  els.output.textContent = "No analysis yet.";
});

renderList();
