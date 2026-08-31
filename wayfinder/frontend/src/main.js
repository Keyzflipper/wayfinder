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
  lastTripId: null,     // from the most recent /api/identify response — powers "More from your guide nearby"
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

// ---- Trip state (client-side only, until D1 is wired up) ----
function renderTripName() {
  tripNameEl.textContent = appState.activeTripName || 'No trip set';
}

function handleTripButtonClick() {
  const name = window.prompt('Trip name', appState.activeTripName || '');
  if (name === null) return; // user cancelled
  const trimmed = name.trim();
  appState.activeTripName = trimmed.length > 0 ? trimmed : null;
  if (appState.activeTripName) {
    localStorage.setItem('wayfinder:activeTrip', appState.activeTripName);
  } else {
    localStorage.removeItem('wayfinder:activeTrip');
  }
  renderTripName();
  renderGuideSheetTripState();
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
  handleTripButtonClick();
  renderGuideSheetTripState();
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
    if (appState.position) {
      formData.append('lat', String(appState.position.lat));
      formData.append('lon', String(appState.position.lon));
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
  resultIdConfidence.textContent = result.confidence
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
}

async function handleResultGuideMoreClick() {
  if (!appState.lastTripId || !appState.position) return;

  resultGuideMoreButton.disabled = true;
  resultGuideMoreButton.textContent = 'Looking…';

  try {
    const params = new URLSearchParams({
      tripId: appState.lastTripId,
      lat: String(appState.position.lat),
      lon: String(appState.position.lon),
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
  tripButton.addEventListener('click', handleTripButtonClick);
  resultsCloseButton.addEventListener('click', closeResultsSheet);
  resultsBackdrop.addEventListener('click', closeResultsSheet);
  resultGuideMoreButton.addEventListener('click', handleResultGuideMoreClick);

  guideButton.addEventListener('click', openGuideSheet);
  guideSheetCloseButton.addEventListener('click', closeGuideSheet);
  guideBackdrop.addEventListener('click', closeGuideSheet);
  guideSetTripButton.addEventListener('click', handleGuideSetTripButtonClick);
  guideChooseFileButton.addEventListener('click', handleGuideChooseFileClick);
  guideFileInput.addEventListener('change', handleGuideFileChange);
  guideUploadButton.addEventListener('click', handleGuideUploadClick);
}

document.addEventListener('DOMContentLoaded', init);
