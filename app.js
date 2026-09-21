"use strict";

const API_BASE = "https://api.asansports.com/v1";
const DAY_NAMES = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
const TEHRAN_CENTER = [51.389, 35.6892];
const MAX_PAGES = 20; // safety cap against runaway pagination
// Loose bounding box around Iran. The API occasionally returns venues with
// corrupted coordinates (or venues from other cities leaking into a
// state-scoped query); such points would blow up the map's auto-fit zoom.
const IRAN_BBOX = { minLat: 24, maxLat: 40, minLng: 44, maxLng: 64 };

maplibregl.setRTLTextPlugin(
  "https://cdn.jsdelivr.net/npm/@mapbox/mapbox-gl-rtl-text/mapbox-gl-rtl-text.min.js",
  null,
  true
);

const els = {
  category: document.getElementById("category"),
  state: document.getElementById("state"),
  district: document.getElementById("district"),
  date: document.getElementById("date"),
  fromTime: document.getElementById("fromTime"),
  toTime: document.getElementById("toTime"),
  form: document.getElementById("filters"),
  searchBtn: document.getElementById("searchBtn"),
  status: document.getElementById("status"),
  list: document.getElementById("list"),
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/bright",
  center: TEHRAN_CENTER,
  zoom: 11,
});
map.addControl(new maplibregl.NavigationControl(), "top-left");

let markers = [];
let activeCardId = null;

function setStatus(message, kind) {
  if (!message) {
    els.status.hidden = true;
    els.status.textContent = "";
    els.status.classList.remove("error");
    return;
  }
  els.status.hidden = false;
  els.status.textContent = message;
  els.status.classList.toggle("error", kind === "error");
}

// Site's weekday order is شنبه..جمعه (Saturday-first); JS Date#getDay() is Sunday-first (0-6).
function apiDayIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const jsDay = new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat
  return (jsDay + 1) % 7; // 0=Sat..6=Fri
}

function toman(n) {
  return n.toLocaleString("fa-IR") + " تومان";
}

function timeOf(datetimeStr) {
  return datetimeStr.slice(11, 16);
}

// Wrapped in an LTR span so "21:00–22:30" doesn't get visually reordered
// by the bidi algorithm inside the surrounding RTL page.
function timeRange(session) {
  return `<span dir="ltr">${timeOf(session.start)}–${timeOf(session.end)}</span>`;
}

function isWithinIran(lat, lng) {
  return (
    lat >= IRAN_BBOX.minLat &&
    lat <= IRAN_BBOX.maxLat &&
    lng >= IRAN_BBOX.minLng &&
    lng <= IRAN_BBOX.maxLng
  );
}

function dateOf(datetimeStr) {
  return datetimeStr.slice(0, 10);
}

async function loadFilterOptions() {
  const [statesRes, categoriesRes] = await Promise.all([
    fetch(`${API_BASE}/states`).then((r) => r.json()),
    fetch(`${API_BASE}/categories`).then((r) => r.json()),
  ]);

  const states = statesRes.data || statesRes;
  // Only the two venue types relevant to football: indoor multi-purpose hall
  // (used for futsal) and outdoor artificial turf.
  const relevantCategoryNames = ["سالن چند منظوره", "زمین چمن"];
  const categories = (categoriesRes.data || categoriesRes).filter((c) =>
    relevantCategoryNames.includes(c.name)
  );

  els.state.innerHTML = states
    .map((s) => `<option value="${s.id}">${s.name}</option>`)
    .join("");
  const tehran = states.find((s) => s.name === "تهران");
  if (tehran) els.state.value = tehran.id;

  els.category.innerHTML = categories
    .map((c) => `<option value="${c.name}">${c.name}</option>`)
    .join("");
  const multiPurpose = categories.find((c) => c.name === "سالن چند منظوره");
  if (multiPurpose) els.category.value = multiPurpose.name;

  await loadDistricts();
}

async function loadDistricts() {
  const stateId = els.state.value;
  els.district.innerHTML = '<option value="">همه مناطق</option>';
  if (!stateId) return;
  try {
    const res = await fetch(`${API_BASE}/districts?state_id=${stateId}`).then((r) =>
      r.json()
    );
    const districts = res.data || res;
    for (const d of districts) {
      const opt = document.createElement("option");
      opt.value = d.name;
      opt.textContent = d.name;
      els.district.appendChild(opt);
    }
  } catch {
    // districts are an optional refinement; silently skip on failure
  }
}

async function fetchAllFreeSessions({ category, stateId, district, day, fromTime, toTime }) {
  const results = [];
  let page = 1;
  let lastPage = 1;

  do {
    const params = new URLSearchParams({
      category,
      state: stateId,
      day: String(day),
      from_time: fromTime,
      to_time: toTime,
      per_page: "30",
      page: String(page),
    });
    if (district) params.set("district", district);

    const res = await fetch(`${API_BASE}/free-sessions?${params.toString()}`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const json = await res.json();
    results.push(...json.data);
    lastPage = json.meta ? json.meta.last_page : 1;
    page += 1;
  } while (page <= lastPage && page <= MAX_PAGES);

  return results;
}

function clearMarkers() {
  for (const m of markers) m.marker.remove();
  markers = [];
}

function renderResults(venues, targetDate) {
  clearMarkers();
  els.list.innerHTML = "";

  const bounds = new maplibregl.LngLatBounds();
  let renderedCount = 0;

  for (const venue of venues) {
    const sessions = venue.sessions.filter((s) => dateOf(s.start) === targetDate);
    if (sessions.length === 0) continue;
    if (!isWithinIran(venue.latitude, venue.longitude)) continue; // bad/foreign coordinates from the source API

    const lngLat = [venue.longitude, venue.latitude];
    bounds.extend(lngLat);

    const popupHtml = `
      <div class="popup-title">${venue.name}</div>
      <div class="popup-sessions">
        ${sessions
          .map((s) => `<div>${timeRange(s)} · ${toman(s.price)}</div>`)
          .join("")}
      </div>`;

    const marker = new maplibregl.Marker({ color: "#3ddc84" })
      .setLngLat(lngLat)
      .setPopup(new maplibregl.Popup({ offset: 24 }).setHTML(popupHtml))
      .addTo(map);

    marker.getElement().addEventListener("click", () => selectVenue(venue.id));
    markers.push({ id: venue.id, marker });

    const card = document.createElement("div");
    card.className = "venue-card";
    card.dataset.id = venue.id;
    card.innerHTML = `
      <p class="name">${venue.name}</p>
      <p class="meta">${venue.district || ""} · ${venue.rating ?? "-"} امتیاز (${venue.reviews_count} نظر)</p>
      <div class="sessions">
        ${sessions
          .map((s) => `<span class="session-chip">${timeRange(s)}</span>`)
          .join("")}
      </div>`;
    card.addEventListener("click", () => selectVenue(venue.id, true));
    els.list.appendChild(card);
    renderedCount += 1;
  }

  if (renderedCount === 0) {
    els.list.innerHTML =
      '<p class="list-empty">هیچ سالنی با این فیلتر، سانس خالی ندارد.</p>';
  } else if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 60, maxZoom: 14 });
  }

  return renderedCount;
}

function selectVenue(id, flyTo) {
  activeCardId = id;
  for (const card of els.list.querySelectorAll(".venue-card")) {
    card.classList.toggle("active", card.dataset.id === String(id));
  }
  const entry = markers.find((m) => m.id === id);
  if (entry) {
    entry.marker.togglePopup();
    if (flyTo) map.flyTo({ center: entry.marker.getLngLat(), zoom: 14 });
  }
}

async function handleSearch(event) {
  event.preventDefault();
  els.searchBtn.disabled = true;
  setStatus("در حال جستجو…");

  try {
    const dateStr = els.date.value;
    const day = apiDayIndex(dateStr);
    const raw = await fetchAllFreeSessions({
      category: els.category.value,
      stateId: els.state.value,
      district: els.district.value,
      day,
      fromTime: els.fromTime.value,
      toTime: els.toTime.value,
    });

    const count = renderResults(raw, dateStr);
    setStatus(`${DAY_NAMES[day]} ${dateStr} · ${count} مجموعه در این تاریخ سانس خالی دارند`);
  } catch (err) {
    setStatus("خطا در دریافت اطلاعات از سرور آسان اسپرت. دوباره تلاش کنید.", "error");
    console.error(err);
  } finally {
    els.searchBtn.disabled = false;
  }
}

function init() {
  const today = new Date();
  els.date.value = today.toISOString().slice(0, 10);

  els.state.addEventListener("change", loadDistricts);
  els.form.addEventListener("submit", handleSearch);

  loadFilterOptions().catch((err) => {
    setStatus("خطا در بارگذاری فیلترها.", "error");
    console.error(err);
  });
}

init();
