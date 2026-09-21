"use strict";

const API_BASE = "https://api.asansports.com/v1";
const DAY_NAMES = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
const JALALI_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];
const TEHRAN_CENTER = [51.389, 35.6892];
const MAX_PAGES = 20; // safety cap against runaway pagination
const MAX_DAYS_AHEAD = 60; // how far into the future the date picker allows booking
const DEFAULT_FROM = "08:00";
const DEFAULT_TO = "23:00";
const SLOTS_PER_DAY = 48; // 30-minute slots: 0 = 00:00 … 47 = 23:30
// Loose bounding box around Iran. The API occasionally returns venues with
// corrupted coordinates (or venues from other cities leaking into a
// state-scoped query); such points would blow up the map's auto-fit zoom.
const IRAN_BBOX = { minLat: 24, maxLat: 40, minLng: 44, maxLng: 64 };

maplibregl.setRTLTextPlugin(
  "https://cdn.jsdelivr.net/npm/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js",
  null,
  true
);

const els = {
  category: document.getElementById("category"),
  state: document.getElementById("state"),
  district: document.getElementById("district"),
  dateTrigger: document.getElementById("dateTrigger"),
  dateTriggerLabel: document.getElementById("dateTriggerLabel"),
  datePopover: document.getElementById("datePopover"),
  calPrev: document.getElementById("calPrev"),
  calNext: document.getElementById("calNext"),
  calMonthLabel: document.getElementById("calMonthLabel"),
  calGrid: document.getElementById("calGrid"),
  fromTime: document.getElementById("fromTime"),
  toTime: document.getElementById("toTime"),
  form: document.getElementById("filters"),
  searchBtn: document.getElementById("searchBtn"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  locationActions: document.getElementById("locationActions"),
  sortDistanceBtn: document.getElementById("sortDistanceBtn"),
  pickLocationBtn: document.getElementById("pickLocationBtn"),
  clearLocationBtn: document.getElementById("clearLocationBtn"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  pickHint: document.getElementById("pickHint"),
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
let selectedDate = null;
let calViewJY = null;
let calViewJM = null;
let userCoords = null; // origin for distance sort: GPS fix or a spot picked on the map
let locationSource = null; // "gps" | "picked" | null
let originMarker = null;
let pickMode = false;
let sortByDistanceActive = false;
let urlReady = false; // URL is only rewritten once the incoming one has been applied
let urlDefaults = { category: null, state: null }; // form values after option loading; omitted from the URL
let copyLinkTimer = null;
let lastVenues = [];
let lastTargetDate = null;

function setStatus(message, kind) {
  if (!message) {
    els.status.hidden = true;
    els.statusText.textContent = "";
    els.status.classList.remove("error");
    return;
  }
  els.status.hidden = false;
  els.statusText.textContent = message;
  els.status.classList.toggle("error", kind === "error");
}

function statePanelHTML(iconId, message, { retry } = {}) {
  return `
    <div class="state-panel">
      <svg class="state-icon"><use href="#${iconId}"/></svg>
      <p>${message}</p>
      ${retry ? '<button type="button" class="retry-btn">دوباره تلاش کن</button>' : ""}
    </div>`;
}

function renderSkeleton(count) {
  const card = `
    <div class="venue-card skeleton">
      <div class="venue-card-head">
        <div class="venue-swatch shimmer"></div>
        <div class="venue-card-title">
          <div class="shimmer-bar w-70"></div>
          <div class="shimmer-bar w-40"></div>
        </div>
      </div>
      <div class="sessions">
        <div class="shimmer-chip"></div><div class="shimmer-chip"></div><div class="shimmer-chip"></div>
      </div>
    </div>`;
  els.list.innerHTML = card.repeat(count);
}

// Site's weekday order is شنبه..جمعه (Saturday-first); JS Date#getDay() is Sunday-first (0-6).
function apiDayIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const jsDay = new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat
  return (jsDay + 1) % 7; // 0=Sat..6=Fri
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function requestUserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { timeout: 8000 }
    );
  });
}

function timeOptionsHTML() {
  let html = "";
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const v = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      html += `<option value="${v}">${v}</option>`;
    }
  }
  return html;
}

// The API and all date arithmetic stay in Gregorian; only the calendar UI is
// relabeled to Jalali (Shamsi). `en-US` keeps digits ASCII so formatToParts
// is trivial to read; "u-ca-persian" is what actually converts the calendar.
function jalaliPartsOf(date) {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { jy: get("year"), jm: get("month"), jd: get("day") };
}

// Scans a window of Gregorian dates around an estimate of the target Jalali
// month and keeps whichever ones actually fall in it, sorted by day. This
// sidesteps hand-rolling Jalali leap-year rules — the browser's ICU data
// already knows them via jalaliPartsOf.
function jalaliMonthDays(jy, jm) {
  const seed = new Date(jy + 621, 2, 15); // ~mid-March, before any Farvardin 1
  seed.setDate(seed.getDate() + Math.round((jm - 1) * 30.44));
  const found = [];
  for (let offset = -20; offset <= 40; offset++) {
    const d = new Date(seed);
    d.setDate(seed.getDate() + offset);
    const parts = jalaliPartsOf(d);
    if (parts.jy === jy && parts.jm === jm) found.push({ jd: parts.jd, date: d });
  }
  found.sort((a, b) => a.jd - b.jd);
  return found;
}

function maxSelectableDate() {
  const d = new Date();
  d.setDate(d.getDate() + MAX_DAYS_AHEAD);
  return d;
}

function updateDateTriggerLabel() {
  const [y, m, d] = selectedDate.split("-").map(Number);
  const todayStr = toDateStr(new Date());
  const tomorrowStr = toDateStr(new Date(new Date().setDate(new Date().getDate() + 1)));
  const prefix =
    selectedDate === todayStr
      ? "امروز"
      : selectedDate === tomorrowStr
        ? "فردا"
        : DAY_NAMES[apiDayIndex(selectedDate)];
  const { jm, jd } = jalaliPartsOf(new Date(y, m - 1, d));
  els.dateTriggerLabel.textContent = `${prefix}، ${jd.toLocaleString("fa-IR")} ${JALALI_MONTHS[jm - 1]}`;
}

function renderCalendar() {
  const days = jalaliMonthDays(calViewJY, calViewJM);
  els.calMonthLabel.textContent = `${JALALI_MONTHS[calViewJM - 1]} ${calViewJY.toLocaleString("fa-IR", { useGrouping: false })}`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = maxSelectableDate();

  const firstDate = days[0].date;
  const lastDate = days[days.length - 1].date;
  const leadingEmpty = apiDayIndex(toDateStr(firstDate));

  let html = "";
  for (let i = 0; i < leadingEmpty; i++) {
    html += `<span class="cal-day empty"></span>`;
  }
  for (const { jd, date } of days) {
    const dateStr = toDateStr(date);
    const disabled = date < today || date > maxDate;
    const classes = ["cal-day"];
    if (dateStr === toDateStr(today)) classes.push("today");
    if (dateStr === selectedDate) classes.push("selected");
    html += `<button type="button" class="${classes.join(" ")}" data-date="${dateStr}"${disabled ? " disabled" : ""}>${jd.toLocaleString("fa-IR")}</button>`;
  }
  els.calGrid.innerHTML = html;

  const prevMonthLast = new Date(firstDate);
  prevMonthLast.setDate(prevMonthLast.getDate() - 1);
  els.calPrev.disabled = prevMonthLast < today;

  const nextMonthFirst = new Date(lastDate);
  nextMonthFirst.setDate(nextMonthFirst.getDate() + 1);
  els.calNext.disabled = nextMonthFirst > maxDate;
}

function openDatePopover() {
  const [y, m, d] = selectedDate.split("-").map(Number);
  const { jy, jm } = jalaliPartsOf(new Date(y, m - 1, d));
  calViewJY = jy;
  calViewJM = jm;
  renderCalendar();
  els.datePopover.hidden = false;
  els.dateTrigger.setAttribute("aria-expanded", "true");
}

function closeDatePopover() {
  els.datePopover.hidden = true;
  els.dateTrigger.setAttribute("aria-expanded", "false");
}

function pickDate(dateStr) {
  selectedDate = dateStr;
  updateDateTriggerLabel();
  closeDatePopover();
  els.dateTrigger.focus();
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
    .map((c) => `<option value="${c.name}" data-id="${c.id}">${c.name}</option>`)
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
      opt.value = d.id;
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

function createMarkerElement() {
  const el = document.createElement("div");
  el.className = "venue-marker";
  el.innerHTML = '<svg><use href="#icon-ball"/></svg>';
  return el;
}

function renderResults(venues, targetDate, { distanceFrom, fitMap = true } = {}) {
  clearMarkers();
  els.list.innerHTML = "";

  const entries = [];
  for (const venue of venues) {
    const sessions = venue.sessions.filter((s) => dateOf(s.start) === targetDate);
    if (sessions.length === 0) continue;
    if (!isWithinIran(venue.latitude, venue.longitude)) continue; // bad/foreign coordinates from the source API

    const distance = distanceFrom
      ? distanceKm(distanceFrom.lat, distanceFrom.lng, venue.latitude, venue.longitude)
      : null;
    entries.push({ venue, sessions, distance });
  }

  if (distanceFrom) {
    entries.sort((a, b) => a.distance - b.distance);
  }

  const bounds = new maplibregl.LngLatBounds();

  for (const { venue, sessions, distance } of entries) {
    const lngLat = [venue.longitude, venue.latitude];
    bounds.extend(lngLat);

    const popupHtml = `
      <div class="popup-title">${venue.name}</div>
      <div class="popup-sessions">
        ${sessions
          .map((s) => `<div>${timeRange(s)} · ${toman(s.price)}</div>`)
          .join("")}
      </div>
      <a class="popup-link" href="${venue.url}" target="_blank" rel="noopener">
        <svg><use href="#icon-external"/></svg>
        مشاهده در آسان اسپرت
      </a>`;

    const markerEl = createMarkerElement();
    const marker = new maplibregl.Marker({ element: markerEl })
      .setLngLat(lngLat)
      .setPopup(new maplibregl.Popup({ offset: 20 }).setHTML(popupHtml))
      .addTo(map);

    markerEl.addEventListener("click", () => selectVenue(venue.id));
    markers.push({ id: venue.id, marker, el: markerEl });

    const card = document.createElement("div");
    card.className = "venue-card";
    card.dataset.id = venue.id;
    card.innerHTML = `
      <div class="venue-card-head">
        <span class="venue-swatch"><svg><use href="#icon-ball"/></svg></span>
        <div class="venue-card-title">
          <p class="name">${venue.name}</p>
          <div class="venue-meta">
            ${venue.district ? `<span class="tag">${venue.district}</span>` : ""}
            <span class="rating"><svg><use href="#icon-star"/></svg>${venue.rating ?? "-"} (${venue.reviews_count})</span>
            ${distance != null ? `<span class="tag">${distance.toFixed(1)} کیلومتر</span>` : ""}
          </div>
        </div>
      </div>
      <div class="sessions">
        ${sessions
          .map(
            (s) =>
              `<span class="session-chip"><span class="chip-time">${timeRange(s)}</span><span class="chip-price">${toman(s.price)}</span></span>`
          )
          .join("")}
      </div>
      <a class="venue-link" href="${venue.url}" target="_blank" rel="noopener">
        <svg><use href="#icon-external"/></svg>
        مشاهده در آسان اسپرت
      </a>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".venue-link")) return;
      selectVenue(venue.id, { flyTo: true, ensurePopup: true });
    });
    els.list.appendChild(card);
  }

  if (entries.length === 0) {
    els.list.innerHTML = statePanelHTML(
      "icon-ball",
      "هیچ سالنی با این فیلتر، سانس خالی ندارد."
    );
  } else if (fitMap && !bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 60, maxZoom: 14 });
  }

  return entries.length;
}

// `ensurePopup` opens the popup only if it isn't already open. Marker clicks
// already toggle their own popup natively (maplibregl.Marker does this
// internally once a popup is bound) — calling togglePopup() again here would
// cancel that out, leaving the popup stuck in whatever state it started in.
// Card clicks don't touch the marker directly, so they need to open it explicitly.
function selectVenue(id, { flyTo = false, ensurePopup = false } = {}) {
  activeCardId = id;
  for (const card of els.list.querySelectorAll(".venue-card")) {
    card.classList.toggle("active", card.dataset.id === String(id));
  }
  for (const m of markers) {
    m.el.classList.toggle("active", m.id === id);
  }
  const entry = markers.find((m) => m.id === id);
  if (entry) {
    if (ensurePopup && !entry.marker.getPopup().isOpen()) {
      entry.marker.togglePopup();
    }
    if (flyTo) map.flyTo({ center: entry.marker.getLngLat(), zoom: 14 });
  }
}

const PICK_HINT = "روی نقشه کلیک کنید تا سالن‌ها بر اساس نزدیکی به آن نقطه مرتب شوند";
const PICK_HINT_GPS_FAILED = "موقعیت شما پیدا نشد؛ روی نقشه مکان دلخواه را انتخاب کنید";

function updateLocationUI() {
  els.sortDistanceBtn.classList.toggle("active", sortByDistanceActive);
  els.sortDistanceBtn.querySelector("span").textContent = sortByDistanceActive
    ? "مرتب‌شده بر اساس نزدیکی"
    : locationSource === "picked"
      ? "نزدیک‌ترین به نقطه انتخابی"
      : "نزدیک‌ترین به من";
  els.pickLocationBtn.classList.toggle("active", pickMode);
  els.pickLocationBtn.setAttribute("aria-pressed", String(pickMode));
  els.clearLocationBtn.hidden = !userCoords;
}

function startPickMode(hint = PICK_HINT) {
  pickMode = true;
  map.getCanvas().style.cursor = "crosshair";
  els.pickHint.textContent = hint;
  els.pickHint.hidden = false;
  updateLocationUI();
}

function stopPickMode() {
  if (!pickMode) return;
  pickMode = false;
  map.getCanvas().style.cursor = "";
  els.pickHint.hidden = true;
  updateLocationUI();
}

// Drops (or moves) the draggable origin pin and re-sorts venues by distance
// from it. Dragging the pin — even one that started as a GPS fix — turns it
// into a "picked" location, which lets the user correct a coarse IP-based fix.
function setOrigin(coords, source) {
  userCoords = coords;
  locationSource = source;

  if (originMarker) {
    originMarker.setLngLat([coords.lng, coords.lat]);
  } else {
    const el = document.createElement("div");
    el.className = "origin-marker";
    el.innerHTML = '<svg><use href="#icon-origin"/></svg>';
    originMarker = new maplibregl.Marker({ element: el, anchor: "bottom", draggable: true })
      .setLngLat([coords.lng, coords.lat])
      .addTo(map);
    originMarker.on("dragend", () => {
      const { lat, lng } = originMarker.getLngLat();
      setOrigin({ lat, lng }, "picked");
    });
  }

  sortByDistanceActive = true;
  updateLocationUI();
  renderResults(lastVenues, lastTargetDate, { distanceFrom: userCoords, fitMap: false });
  syncUrl(["p"]);
}

function clearLocation() {
  stopPickMode();
  if (originMarker) {
    originMarker.remove();
    originMarker = null;
  }
  userCoords = null;
  locationSource = null;
  sortByDistanceActive = false;
  updateLocationUI();
  renderResults(lastVenues, lastTargetDate, { fitMap: false });
  syncUrl(["p"]);
}

async function toggleSortByDistance() {
  if (sortByDistanceActive) {
    sortByDistanceActive = false;
    updateLocationUI();
    renderResults(lastVenues, lastTargetDate, { fitMap: false });
    return;
  }

  stopPickMode();

  if (userCoords) {
    setOrigin(userCoords, locationSource);
    return;
  }

  els.sortDistanceBtn.disabled = true;
  try {
    setOrigin(await requestUserLocation(), "gps");
  } catch (err) {
    // Laptops without GPS/network location land here; let the user point at the map instead.
    console.error(err);
    startPickMode(PICK_HINT_GPS_FAILED);
  } finally {
    els.sortDistanceBtn.disabled = false;
  }
}

function togglePickMode() {
  if (pickMode) stopPickMode();
  else startPickMode();
}

function handleMapClick(e) {
  if (!pickMode) return;
  // Markers live inside the map's canvas container, so their clicks bubble up here too.
  const target = e.originalEvent.target;
  if (target.closest(".venue-marker, .origin-marker")) return;
  stopPickMode();
  setOrigin({ lat: e.lngLat.lat, lng: e.lngLat.lng }, "picked");
}

// ---------- shareable URL state ----------
// Short single-letter query params; a value equal to its default is left out,
// so the default search is a bare URL. Each row validates its own input and
// silently ignores anything bad, so a stale or hand-edited link never breaks the page.

function timeToSlot(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 2 + m / 30;
}

function slotToTime(slot) {
  return `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
}

function selectedCategoryId() {
  return els.category.selectedOptions[0]?.dataset.id ?? null;
}

function hasOption(select, value) {
  return [...select.options].some((o) => o.value === value);
}

// read() -> encoded string, or null when the value is the default / unset.
// apply(raw) may be async; rows run in order, so `r` (district) follows `s` (city).
const URL_PARAMS = [
  {
    key: "c", // category id
    read: () => (selectedCategoryId() !== urlDefaults.category ? selectedCategoryId() : null),
    apply(raw) {
      const opt = [...els.category.options].find((o) => o.dataset.id === raw);
      if (opt) els.category.value = opt.value;
    },
  },
  {
    key: "s", // city (state) id
    read: () => (els.state.value !== urlDefaults.state ? els.state.value : null),
    async apply(raw) {
      if (raw === els.state.value || !hasOption(els.state, raw)) return;
      els.state.value = raw;
      await loadDistricts();
    },
  },
  {
    key: "r", // district id
    read: () => els.district.value || null,
    apply(raw) {
      if (raw && hasOption(els.district, raw)) els.district.value = raw;
    },
  },
  {
    key: "d", // date as yymmdd; absent = today
    read: () => (selectedDate === toDateStr(new Date()) ? null : selectedDate.slice(2).replaceAll("-", "")),
    apply(raw) {
      const m = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);
      if (!m) return;
      const dateStr = `20${m[1]}-${m[2]}-${m[3]}`;
      // Round-trip catches impossible dates like 260231, which Date would roll into March.
      if (toDateStr(new Date(2000 + +m[1], +m[2] - 1, +m[3])) !== dateStr) return;
      if (dateStr < toDateStr(new Date()) || dateStr > toDateStr(maxSelectableDate())) return;
      selectedDate = dateStr;
      updateDateTriggerLabel();
    },
  },
  {
    key: "t", // from-to as 30-minute slot indexes, e.g. 36-44 = 18:00-22:00
    read() {
      const from = els.fromTime.value;
      const to = els.toTime.value;
      return from === DEFAULT_FROM && to === DEFAULT_TO ? null : `${timeToSlot(from)}-${timeToSlot(to)}`;
    },
    apply(raw) {
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
      if (!m) return;
      const from = Number(m[1]);
      const to = Number(m[2]);
      if (from >= to || to >= SLOTS_PER_DAY) return;
      els.fromTime.value = slotToTime(from);
      els.toTime.value = slotToTime(to);
    },
  },
  {
    key: "p", // picked pin as lat,lng at 3 decimals (~110 m). A GPS fix is never shared.
    read: () =>
      userCoords && locationSource === "picked"
        ? `${userCoords.lat.toFixed(3)},${userCoords.lng.toFixed(3)}`
        : null,
    apply(raw) {
      const m = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(raw);
      if (!m) return;
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      // The pin itself is placed by performSearch once there are venues to sort.
      userCoords = { lat, lng };
      locationSource = "picked";
      updateLocationUI();
    },
  },
];

async function applyUrlState() {
  const params = new URLSearchParams(location.search);
  for (const row of URL_PARAMS) {
    if (params.has(row.key)) await row.apply(params.get(row.key));
  }
}

// `keys` limits the rewrite to those params, so dragging the pin doesn't also
// pick up filter edits the user hasn't searched with yet.
function syncUrl(keys) {
  if (!urlReady) return;
  const params = new URLSearchParams(location.search);
  for (const row of URL_PARAMS) {
    if (keys && !keys.includes(row.key)) continue;
    const value = row.read();
    if (value == null) params.delete(row.key);
    else params.set(row.key, value);
  }
  const query = params.toString().replaceAll("%2C", ",");
  try {
    history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
  } catch {
    // e.g. opened from file:// — the page still works, the URL just can't carry state
  }
}

async function copyLink() {
  const label = els.copyLinkBtn.querySelector("span");
  let text = "لینک کپی شد";
  try {
    await navigator.clipboard.writeText(location.href);
  } catch (err) {
    console.error(err);
    text = "کپی نشد";
  }
  label.textContent = text;
  clearTimeout(copyLinkTimer);
  copyLinkTimer = setTimeout(() => {
    label.textContent = "کپی لینک";
  }, 1800);
}

async function performSearch() {
  els.searchBtn.disabled = true;
  setStatus(null);
  syncUrl();
  stopPickMode();
  els.locationActions.hidden = true;
  clearMarkers();
  renderSkeleton(4);

  try {
    const dateStr = selectedDate;
    const day = apiDayIndex(dateStr);
    const raw = await fetchAllFreeSessions({
      category: els.category.value,
      stateId: els.state.value,
      district: els.district.value,
      day,
      fromTime: els.fromTime.value,
      toTime: els.toTime.value,
    });

    lastVenues = raw;
    lastTargetDate = dateStr;
    sortByDistanceActive = false;
    updateLocationUI();

    const count = renderResults(raw, dateStr);
    setStatus(`${DAY_NAMES[day]} ${dateStr} · ${count} مجموعه در این تاریخ سانس خالی دارند`);
    els.locationActions.hidden = count === 0;
    // A pin restored from the URL has coordinates but no marker yet.
    if (count > 0 && userCoords && !originMarker) setOrigin(userCoords, locationSource);
  } catch (err) {
    els.list.innerHTML = statePanelHTML(
      "icon-alert",
      "خطا در دریافت اطلاعات از سرور آسان اسپرت.",
      { retry: true }
    );
    els.list.querySelector(".retry-btn").addEventListener("click", () => performSearch());
    console.error(err);
  } finally {
    els.searchBtn.disabled = false;
  }
}

function handleSearch(event) {
  event.preventDefault();
  performSearch();
}

function init() {
  els.fromTime.innerHTML = timeOptionsHTML();
  els.fromTime.value = DEFAULT_FROM;
  els.toTime.innerHTML = timeOptionsHTML();
  els.toTime.value = DEFAULT_TO;

  selectedDate = toDateStr(new Date());
  updateDateTriggerLabel();

  els.dateTrigger.addEventListener("click", () => {
    if (els.datePopover.hidden) openDatePopover();
    else closeDatePopover();
  });

  els.datePopover.addEventListener("click", (e) => {
    const quick = e.target.closest(".quick-chip");
    if (quick) {
      const d = new Date();
      d.setDate(d.getDate() + Number(quick.dataset.offset));
      pickDate(toDateStr(d));
      return;
    }
    const day = e.target.closest(".cal-day");
    if (day && !day.disabled && !day.classList.contains("empty")) {
      pickDate(day.dataset.date);
    }
  });

  els.calPrev.addEventListener("click", () => {
    calViewJM -= 1;
    if (calViewJM < 1) {
      calViewJM = 12;
      calViewJY -= 1;
    }
    renderCalendar();
  });

  els.calNext.addEventListener("click", () => {
    calViewJM += 1;
    if (calViewJM > 12) {
      calViewJM = 1;
      calViewJY += 1;
    }
    renderCalendar();
  });

  document.addEventListener("click", (e) => {
    if (els.datePopover.hidden) return;
    if (els.datePopover.contains(e.target) || els.dateTrigger.contains(e.target)) return;
    closeDatePopover();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!els.datePopover.hidden) {
      closeDatePopover();
      els.dateTrigger.focus();
    } else {
      stopPickMode();
    }
  });

  els.state.addEventListener("change", loadDistricts);
  els.sortDistanceBtn.addEventListener("click", toggleSortByDistance);
  els.pickLocationBtn.addEventListener("click", togglePickMode);
  els.clearLocationBtn.addEventListener("click", clearLocation);
  els.copyLinkBtn.addEventListener("click", copyLink);
  map.on("click", handleMapClick);
  els.form.addEventListener("submit", handleSearch);

  loadFilterOptions()
    .then(async () => {
      urlDefaults = { category: selectedCategoryId(), state: els.state.value };
      await applyUrlState();
      urlReady = true;
      return performSearch();
    })
    .catch((err) => {
      setStatus("خطا در بارگذاری فیلترها.", "error");
      console.error(err);
    });
}

init();
