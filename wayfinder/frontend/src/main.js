// main.js — Wayfinder app entry point
// Owns: camera lifecycle, GPS watching, shutter capture, results sheet, trip state.
// ui.js and api.js will be extracted from here once built; for now this file
// is self-contained so it runs on its own.

const API_BASE = '/api';

const appState = {
  stream: null,
  watchId: null,
  position: null,       // { lat, lon, accuracy } | null
  activeTripName: localStorage.getItem('wayfinder:activeTrip') || null,
  lastPhotoBlob: null,
  lastTripId: null,        // from the most recent /api/identify response — powers "More from your guide nearby"
  lastFindPosition: null,  // the position actually SENT with that request — not live `position`, which can drift before "more" is tapped
  selectedGuideFile: null,
};

// ---- DOM refs ----
const videoEl = document.getElementById('camera-feed');
const canvasEl = document.getElementById('capture-canvas');
const cameraEmptyState = document.getElementById('camera-empty-state');
const cameraRetryButton = document.getElementById('camera-retry-button');

const gpsCoordsEl = document.getElementById('gps-coords');
const gpsAccuracyEl = document.getElementById('gps-accuracy');
const gpsIndicatorEl = document.getElementById('gps-indicator');
const gpsStripEl = document.getElementById('gps-strip');

const shutterButton = document.getElementById('shutter-button');

const loadingOverlay = document.getElementById('loading-overlay');
const loadingMessageEl = document.getElementById('loading-message');

const resultsSheet = document.getElementById('results-sheet');
const resultsBackdrop = document.getElementById('results-backdrop');
const resultsCloseButton = document.getElementById('results-close-button');

const resultIdName = document.getElementById('result-id-name');
const resultIdDetail = document.getElementById('result-id-detail');
const resultIdConfidence = document.getElementById('result-id-confidence');

const resultGuideSection = document.getElementById('result-guide');
const resultGuideText = document.getElementById('result-guide-text');
const resultGuideMoreButton = document.getElementById('result-guide-more-button');
const resultGuideMoreList = document.getElementById('result-guide-more-list');

const resultNearbySection = document.getElementById('result-nearby');
const resultNearbyList = document.getElementById('result-nearby-list');

const resultRestaurantsButton = document.getElementById('result-restaurants-button');
const resultRestaurantsList = document.getElementById('result-restaurants-list');

const tripButton = document.getElementById('trip-button');
const tripNameEl = document.getElementById('trip-name');

const guideButton = document.getElementById('guide-button');
const guideSheet = document.getElementById('guide-sheet');
const guideBackdrop = document.getElementById('guide-backdrop');
const guideSheetCloseButton = document.getElementById('guide-sheet-close-button');

const guideNoTrip = document.getElementById('guide-no-trip');
const guideSetTripButton = document.getElementById('guide-set-trip-button');

const guideUploadForm = document.getElementById('guide-upload-form');
const guideUploadTripNameEl = document.getElementById('guide-upload-trip-name');
const guideFileInput = document.getElementById('guide-file-input');
const guideChooseFileButton = document.getElementById('guide-choose-file-button');
const guideSelectedFileEl = document.getElementById('guide-selected-file');
const guideUploadButton = document.getElementById('guide-upload-button');

const guideStatusEl = document.getElementById('guide-status');

const tripsSheet = document.getElementById('trips-sheet');
const tripsBackdrop = document.getElementById('trips-backdrop');
const tripsSheetCloseButton = document.getElementById('trips-sheet-close-button');

const tripsListPane = document.getElementById('trips-list-pane');
const activeTripRow = document.getElementById('active-trip-row');
const activeTripNameEl = document.getElementById('active-trip-name');
const clearActiveTripButton = document.getElementById('clear-active-trip-button');
const newTripInput = document.getElementById('new-trip-input');
const newTripSetButton = document.getElementById('new-trip-set-button');
const tripsList = document.getElementById('trips-list');
const tripsEmptyMessage = document.getElementById('trips-empty-message');

const tripFindsPane = document.getElementById('trip-finds-pane');
const tripFindsBackButton = document.getElementById('trip-finds-back-button');
const tripFindsTitle = document.getElementById('trip-finds-title');
const tripFindsList = document.getElementById('trip-finds-list');
const tripFindsEmptyMessage = document.getElementById('trip-finds-empty-message');

// ---- Trip state ----
function renderTripName() {
  tripNameEl.textContent = appState.activeTripName || 'No trip set';
}

function setActiveTrip(name) {
  const trimmed = (name || '').trim();
  appState.activeTripName = trimmed.length > 0 ? trimmed : null;
  if (appState.activeTripName) {
    localStorage.setItem('wayfinder:activeTrip', appState.activeTripName);
  } else {
    localStorage.removeItem('wayfinder:activeTrip');
  }
  renderTripName();
  renderGuideSheetTripState();
}

// ---- Trips sheet ----
function formatShortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function openTripsSheet() {
  showTripsListPane();
  renderActiveTripRow();
  tripsSheet.classList.remove('translate-y-full');
  tripsBackdrop.classList.remove('hidden');
  await loadTripsList();
}

function closeTripsSheet() {
  tripsSheet.classList.add('translate-y-full');
  tripsBackdrop.classList.add('hidden');
}

function renderActiveTripRow() {
  if (appState.activeTripName) {
    activeTripNameEl.textContent = appState.activeTripName;
    activeTripRow.classList.remove('hidden');
    activeTripRow.classList.add('flex');
  } else {
    activeTripRow.classList.add('hidden');
    activeTripRow.classList.remove('flex');
  }
}

function handleClearActiveTripClick() {
  setActiveTrip(null);
  renderActiveTripRow();
  loadTripsList();
}

function showTripsListPane() {
  tripFindsPane.classList.add('hidden');
  tripFindsPane.classList.remove('flex');
  tripsListPane.classList.remove('hidden');
  tripsListPane.classList.add('flex');
}

async function loadTripsList() {
  tripsList.innerHTML = '<li class="py-3 font-body text-sm text-chart/50">Loading&hellip;</li>';
  tripsEmptyMessage.classList.add('hidden');

  try {
    const response = await fetch(`${API_BASE}/trips`);
    if (!response.ok) throw new Error(`Trips request failed: ${response.status}`);
    const { trips } = await response.json();
    renderTripsList(Array.isArray(trips) ? trips : []);
  } catch (err) {
    console.error('Loading trips failed:', err);
    tripsList.innerHTML = '<li class="py-3 font-body text-sm text-rust">Couldn\'t load trips — check your connection.</li>';
  }
}

function renderTripsList(trips) {
  tripsList.innerHTML = '';

  if (trips.length === 0) {
    tripsEmptyMessage.classList.remove('hidden');
    return;
  }
  tripsEmptyMessage.classList.add('hidden');

  trips.forEach((trip) => {
    const isActive = trip.name === appState.activeTripName;
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between py-3 cursor-pointer hover:bg-chart/5 transition-colors';
    li.innerHTML = `
      <div class="flex flex-col">
        <span class="font-body text-sm text-chart">${trip.name}${isActive ? ' <span class="text-brass">(active)</span>' : ''}</span>
        <span class="font-body text-xs text-chart/60">${trip.findCount} find${trip.findCount === 1 ? '' : 's'}</span>
      </div>
      <span class="font-data text-xs text-seaglass">&rsaquo;</span>
    `;
    li.addEventListener('click', () => handleTripRowClick(trip));
    tripsList.appendChild(li);
  });
}

function handleTripRowClick(trip) {
  setActiveTrip(trip.name);
  renderActiveTripRow();
  showTripFinds(trip.id, trip.name);
}

function handleNewTripSetClick() {
  const name = newTripInput.value;
  if (!name || name.trim().length === 0) return;
  setActiveTrip(name);
  renderActiveTripRow();
  newTripInput.value = '';
  loadTripsList();
}

async function showTripFinds(tripId, tripName) {
  tripsListPane.classList.add('hidden');
  tripsListPane.classList.remove('flex');
  tripFindsPane.classList.remove('hidden');
  tripFindsPane.classList.add('flex');

  tripFindsTitle.textContent = tripName;
  tripFindsList.innerHTML = '<li class="font-body text-sm text-chart/50">Loading&hellip;</li>';
  tripFindsEmptyMessage.classList.add('hidden');

  try {
    const params = new URLSearchParams({ tripId });
    const response = await fetch(`${API_BASE}/finds?${params}`);
    if (!response.ok) throw new Error(`Finds request failed: ${response.status}`);
    const { finds } = await response.json();
    renderTripFindsList(Array.isArray(finds) ? finds : []);
  } catch (err) {
    console.error('Loading finds failed:', err);
    tripFindsList.innerHTML = '<li class="font-body text-sm text-rust">Couldn\'t load finds — check your connection.</li>';
  }
}

function renderTripFindsList(finds) {
  tripFindsList.innerHTML = '';

  if (finds.length === 0) {
    tripFindsEmptyMessage.classList.remove('hidden');
    return;
  }
  tripFindsEmptyMessage.classList.add('hidden');

  finds.forEach((find) => {
    const li = document.createElement('li');
    li.className = 'flex gap-3';
    li.innerHTML = `
      <img src="${find.photoUrl}" alt="" class="h-16 w-16 rounded-sm object-cover flex-shrink-0 bg-chart/10" loading="lazy" />
      <div class="flex flex-col gap-0.5 min-w-0 justify-center">
        <p class="font-body text-sm text-chart truncate">${find.name || 'Unidentified'}</p>
        <p class="font-body text-xs text-chart/60 line-clamp-2">${find.detail || ''}</p>
        <p class="font-data text-xs text-brass">${formatShortDate(find.createdAt)}</p>
      </div>
    `;
    tripFindsList.appendChild(li);
  });
}

function handleTripFindsBackClick() {
  showTripsListPane();
  renderActiveTripRow();
  loadTripsList();
}

// ---- Guide upload sheet ----
function renderGuideSheetTripState() {
  if (appState.activeTripName) {
    guideNoTrip.classList.add('hidden');
    guideNoTrip.classList.remove('flex');
    guideUploadForm.classList.remove('hidden');
    guideUploadForm.classList.add('flex');
    guideUploadTripNameEl.textContent = appState.activeTripName;
  } else {
    guideUploadForm.classList.add('hidden');
    guideUploadForm.classList.remove('flex');
    guideNoTrip.classList.remove('hidden');
    guideNoTrip.classList.add('flex');
  }
}

function clearGuideFileSelection() {
  appState.selectedGuideFile = null;
  guideFileInput.value = '';
  guideSelectedFileEl.textContent = '';
  guideSelectedFileEl.classList.add('hidden');
  guideUploadButton.disabled = true;
}

function resetGuideUploadForm() {
  clearGuideFileSelection();
  guideStatusEl.innerHTML = '';
  guideStatusEl.classList.add('hidden');
  guideStatusEl.classList.remove('flex');
}

function openGuideSheet() {
  renderGuideSheetTripState();
  resetGuideUploadForm();
  guideSheet.classList.remove('translate-y-full');
  guideBackdrop.classList.remove('hidden');
}

function closeGuideSheet() {
  guideSheet.classList.add('translate-y-full');
  guideBackdrop.classList.add('hidden');
}

function handleGuideSetTripButtonClick() {
  closeGuideSheet();
  openTripsSheet();
}

function handleGuideChooseFileClick() {
  guideFileInput.click();
}

function handleGuideFileChange() {
  const file = guideFileInput.files?.[0] ?? null;
  appState.selectedGuideFile = file;
  if (file) {
    guideSelectedFileEl.textContent = file.name;
    guideSelectedFileEl.classList.remove('hidden');
  } else {
    guideSelectedFileEl.classList.add('hidden');
  }
  guideUploadButton.disabled = !file;
  guideStatusEl.innerHTML = '';
  guideStatusEl.classList.add('hidden');
  guideStatusEl.classList.remove('flex');
}

function showGuideStatus(html) {
  guideStatusEl.innerHTML = html;
  guideStatusEl.classList.remove('hidden');
  guideStatusEl.classList.add('flex');
}

async function handleGuideUploadClick() {
  if (!appState.selectedGuideFile || !appState.activeTripName) return;

  guideUploadButton.disabled = true;
  showGuideStatus('<p class="font-data text-xs text-seaglass">Reading your guide&hellip; this can take a little while.</p>');

  try {
    const formData = new FormData();
    formData.append('pdf', appState.selectedGuideFile);
    formData.append('tripName', appState.activeTripName);

    const response = await fetch(`${API_BASE}/guide`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Guide upload failed: ${response.status}`);
    }

    const result = await response.json();
    const truncatedNote = result.truncated
      ? '<p class="font-body text-xs text-seaglass mt-1">This guide had more than Wayfinder processes in one upload — only the first chunks were matched.</p>'
      : '';
    showGuideStatus(`
      <p class="font-body text-sm text-chart">Guide added — ${result.chunksCreated} excerpt${result.chunksCreated === 1 ? '' : 's'} from ${result.totalPages} page${result.totalPages === 1 ? '' : 's'}, ${result.chunksGeocoded} matched to a place.</p>
      ${truncatedNote}
    `);
    clearGuideFileSelection();
  } catch (err) {
    console.error('Guide upload failed:', err);
    showGuideStatus('<p class="font-body text-sm text-rust">Couldn\'t upload that guide — check your connection and try again.</p>');
    guideUploadButton.disabled = false;
  }
}

// ---- Camera ----
async function initCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraEmptyState();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    appState.stream = stream;
    videoEl.srcObject = stream;
    hideCameraEmptyState();
  } catch (err) {
    console.error('Camera permission denied or unavailable:', err);
    showCameraEmptyState();
  }
}

function showCameraEmptyState() {
  cameraEmptyState.classList.remove('hidden');
  cameraEmptyState.classList.add('flex');
  shutterButton.disabled = true;
  shutterButton.classList.add('opacity-40', 'pointer-events-none');
}

function hideCameraEmptyState() {
  cameraEmptyState.classList.add('hidden');
  cameraEmptyState.classList.remove('flex');
  shutterButton.disabled = false;
  shutterButton.classList.remove('opacity-40', 'pointer-events-none');
}

// ---- Geolocation ----
function initGeolocation() {
  if (!navigator.geolocation) {
    setGpsUnavailable('Location not supported');
    return;
  }

  appState.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      appState.position = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      renderGpsStrip();
    },
    (err) => {
      console.warn('Geolocation error:', err);
      appState.position = null;
      setGpsUnavailable(
        err.code === err.PERMISSION_DENIED ? 'Location denied — tap to retry' : 'Location unavailable — tap to retry'
      );
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function renderGpsStrip() {
  const { lat, lon, accuracy } = appState.position;
  gpsCoordsEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  gpsAccuracyEl.textContent = `±${Math.round(accuracy)}m`;
  gpsIndicatorEl.classList.remove('bg-seaglass/50');
  gpsIndicatorEl.classList.add('bg-brass');
}

function setGpsUnavailable(message) {
  gpsCoordsEl.textContent = message;
  gpsAccuracyEl.textContent = '';
  gpsIndicatorEl.classList.remove('bg-brass');
  gpsIndicatorEl.classList.add('bg-seaglass/50');
}

function handleGpsStripClick() {
  if (appState.position === null) {
    initGeolocation();
  }
}

// ---- Capture ----
function capturePhotoBlob() {
  const { videoWidth, videoHeight } = videoEl;
  canvasEl.width = videoWidth;
  canvasEl.height = videoHeight;
  const ctx = canvasEl.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, videoWidth, videoHeight);
  return new Promise((resolve) => {
    canvasEl.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
  });
}

async function handleShutterClick() {
  if (!appState.stream) return;

  showLoading('Looking it up…');
  try {
    const photoBlob = await capturePhotoBlob();
    appState.lastPhotoBlob = photoBlob;

    const formData = new FormData();
    formData.append('photo', photoBlob, 'capture.jpg');
    if (appState.activeTripName) formData.append('tripName', appState.activeTripName);
    // Snapshot now, not just read: appState.position keeps updating live via
    // watchPosition, and handleResultGuideMoreClick needs the position that
    // was actually SENT with this request, not wherever the device is by
    // the time the user taps "more" — those can diverge if they walk while
    // the results sheet is open.
    const capturePosition = appState.position;
    if (capturePosition) {
      formData.append('lat', String(capturePosition.lat));
      formData.append('lon', String(capturePosition.lon));
    }

    const response = await fetch(`${API_BASE}/identify`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Identify request failed: ${response.status}`);
    }

    const result = await response.json();
    appState.lastTripId = result.tripId ?? null;
    appState.lastFindPosition = capturePosition;
    renderResults(result);
    hideLoading();
    openResultsSheet();
  } catch (err) {
    console.error('Identification failed:', err);
    hideLoading();
    window.alert("Couldn't identify that — check your connection and try again.");
  }
}

// ---- Loading overlay ----
function showLoading(message) {
  loadingMessageEl.textContent = message;
  loadingOverlay.classList.remove('hidden');
  loadingOverlay.classList.add('flex');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
  loadingOverlay.classList.remove('flex');
}

// ---- Results sheet ----
function renderResults(result) {
  resultIdName.textContent = result.name || 'Unidentified';
  resultIdDetail.textContent = result.detail || '';
  resultIdConfidence.textContent = typeof result.confidence === 'number'
    ? `${Math.round(result.confidence * 100)}% confidence`
    : '';

  resultGuideMoreList.innerHTML = '';
  resultGuideMoreList.classList.add('hidden');
  resultGuideMoreList.classList.remove('flex');
  resultGuideMoreButton.classList.remove('hidden');
  resultGuideMoreButton.disabled = false;
  resultGuideMoreButton.textContent = 'More from your guide nearby';

  if (result.guideExcerpt) {
    resultGuideText.textContent = result.guideExcerpt;
    resultGuideSection.classList.remove('hidden');
    resultGuideSection.classList.add('flex');
  } else {
    resultGuideSection.classList.add('hidden');
    resultGuideSection.classList.remove('flex');
  }

  resultNearbyList.innerHTML = '';
  if (Array.isArray(result.nearby) && result.nearby.length > 0) {
    result.nearby.forEach((place) => {
      const li = document.createElement('li');
      li.className = 'flex items-center justify-between py-3';
      li.innerHTML = `
        <div class="flex flex-col">
          <span class="font-body text-sm text-chart">${place.name}</span>
          <span class="font-body text-xs text-chart/60">${place.category || ''}</span>
        </div>
        <span class="font-data text-xs text-brass">${place.distance || ''}</span>
      `;
      resultNearbyList.appendChild(li);
    });
    resultNearbySection.classList.remove('hidden');
  } else {
    resultNearbySection.classList.add('hidden');
  }

  resultRestaurantsList.innerHTML = '';
  resultRestaurantsList.classList.add('hidden');
  resultRestaurantsList.classList.remove('flex');
  resultRestaurantsButton.classList.remove('hidden');
  resultRestaurantsButton.disabled = false;
  resultRestaurantsButton.textContent = 'Show good restaurants nearby';
}

async function handleResultRestaurantsClick() {
  if (!appState.lastFindPosition) return;

  resultRestaurantsButton.disabled = true;
  resultRestaurantsButton.textContent = 'Looking…';

  try {
    const params = new URLSearchParams({
      lat: String(appState.lastFindPosition.lat),
      lon: String(appState.lastFindPosition.lon),
    });
    const response = await fetch(`${API_BASE}/restaurants?${params}`);
    if (!response.ok) {
      throw new Error(`Restaurants request failed: ${response.status}`);
    }

    const { restaurants } = await response.json();

    resultRestaurantsList.innerHTML = '';
    if (!Array.isArray(restaurants) || restaurants.length === 0) {
      resultRestaurantsButton.textContent = 'No well-reviewed restaurants nearby';
      return;
    }

    restaurants.forEach((restaurant) => {
      const li = document.createElement('li');
      li.className = 'flex items-center justify-between py-3';
      const ratingLabel = `${restaurant.rating.toFixed(1)}★ (${restaurant.userRatingsTotal})`;
      const meta = [ratingLabel, restaurant.priceLevel, restaurant.openNow === true ? 'Open now' : null]
        .filter(Boolean)
        .join(' · ');
      li.innerHTML = `
        <div class="flex flex-col">
          <span class="font-body text-sm text-chart">${restaurant.name}</span>
          <span class="font-body text-xs text-chart/60">${meta}</span>
        </div>
        <span class="font-data text-xs text-brass">${restaurant.distance || ''}</span>
      `;
      resultRestaurantsList.appendChild(li);
    });
    resultRestaurantsList.classList.remove('hidden');
    resultRestaurantsList.classList.add('flex');
    resultRestaurantsButton.classList.add('hidden');
  } catch (err) {
    console.error('Restaurants lookup failed:', err);
    resultRestaurantsButton.disabled = false;
    resultRestaurantsButton.textContent = "Couldn't load restaurants — try again";
  }
}

async function handleResultGuideMoreClick() {
  if (!appState.lastTripId || !appState.lastFindPosition) return;

  resultGuideMoreButton.disabled = true;
  resultGuideMoreButton.textContent = 'Looking…';

  try {
    const params = new URLSearchParams({
      tripId: appState.lastTripId,
      lat: String(appState.lastFindPosition.lat),
      lon: String(appState.lastFindPosition.lon),
    });
    const response = await fetch(`${API_BASE}/guide/nearby?${params}`);
    if (!response.ok) {
      throw new Error(`Guide lookup failed: ${response.status}`);
    }

    const { chunks } = await response.json();
    // The single nearest chunk is already shown above as the main excerpt —
    // exclude it here so "more" doesn't just repeat the same text.
    const rest = Array.isArray(chunks) ? chunks.filter((c) => c.text !== resultGuideText.textContent) : [];

    resultGuideMoreList.innerHTML = '';
    if (rest.length === 0) {
      resultGuideMoreButton.textContent = 'Nothing else nearby';
      return;
    }

    rest.forEach((chunk) => {
      const li = document.createElement('li');
      li.className = 'flex flex-col gap-1 border-l-2 border-brass/40 pl-3';
      li.innerHTML = `
        <p class="font-body text-sm leading-relaxed text-chart/90">${chunk.text}</p>
        <span class="font-data text-xs text-brass">${chunk.distance || ''}</span>
      `;
      resultGuideMoreList.appendChild(li);
    });
    resultGuideMoreList.classList.remove('hidden');
    resultGuideMoreList.classList.add('flex');
    resultGuideMoreButton.classList.add('hidden');
  } catch (err) {
    console.error('Guide lookup failed:', err);
    resultGuideMoreButton.disabled = false;
    resultGuideMoreButton.textContent = "Couldn't load more — try again";
  }
}

function openResultsSheet() {
  resultsSheet.classList.remove('translate-y-full');
  resultsBackdrop.classList.remove('hidden');
}

function closeResultsSheet() {
  resultsSheet.classList.add('translate-y-full');
  resultsBackdrop.classList.add('hidden');
}

// ---- Service worker ----
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }
}

// ---- Wire up ----
function init() {
  renderTripName();
  initCamera();
  initGeolocation();
  registerServiceWorker();

  cameraRetryButton.addEventListener('click', initCamera);
  gpsStripEl.addEventListener('click', handleGpsStripClick);
  shutterButton.addEventListener('click', handleShutterClick);
  tripButton.addEventListener('click', openTripsSheet);
  resultsCloseButton.addEventListener('click', closeResultsSheet);
  resultsBackdrop.addEventListener('click', closeResultsSheet);
  resultGuideMoreButton.addEventListener('click', handleResultGuideMoreClick);
  resultRestaurantsButton.addEventListener('click', handleResultRestaurantsClick);

  guideButton.addEventListener('click', openGuideSheet);
  guideSheetCloseButton.addEventListener('click', closeGuideSheet);
  guideBackdrop.addEventListener('click', closeGuideSheet);
  guideSetTripButton.addEventListener('click', handleGuideSetTripButtonClick);
  guideChooseFileButton.addEventListener('click', handleGuideChooseFileClick);
  guideFileInput.addEventListener('change', handleGuideFileChange);
  guideUploadButton.addEventListener('click', handleGuideUploadClick);

  tripsSheetCloseButton.addEventListener('click', closeTripsSheet);
  tripsBackdrop.addEventListener('click', closeTripsSheet);
  clearActiveTripButton.addEventListener('click', handleClearActiveTripClick);
  newTripSetButton.addEventListener('click', handleNewTripSetClick);
  newTripInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleNewTripSetClick();
  });
  tripFindsBackButton.addEventListener('click', handleTripFindsBackClick);
}

document.addEventListener('DOMContentLoaded', init);
