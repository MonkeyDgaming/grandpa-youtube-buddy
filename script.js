/* =============================================================
   GRANDPA YOUTUBE BUDDY — script.js
   ============================================================= */
 
// ============================================================
// CONFIGURATION
// Replace the value below with your YouTube Data API v3 key.
//
// How to get an API key:
//   1. Go to https://console.cloud.google.com
//   2. Create a project (or select an existing one)
//   3. Click "Enable APIs & Services" → search for
//      "YouTube Data API v3" → click Enable
//   4. Go to "Credentials" → "Create Credentials" → "API key"
//   5. Copy the key and paste it between the quotes below
//
// How to secure your key (IMPORTANT):
//   After deploying to Netlify, return to Credentials in
//   Google Cloud Console and restrict the key:
//   - API restrictions → YouTube Data API v3 only
//   - Application restrictions → HTTP referrers →
//     add https://<your-site>.netlify.app/*
// ============================================================
const YOUTUBE_API_KEY = 'AIzaSyAv0M7qvtJLCbIO2XupjdtRtiIllsEAoKU';
 
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const RESULTS_COUNT      = 6;
const TOAST_DURATION_MS  = 5000;
// iOS SpeechRecognition silently times out without firing onerror.
// We force-stop after this many ms as a safety net.
const SPEECH_TIMEOUT_MS  = 8000;
 
// ── State ────────────────────────────────────────────────────
// Five mutually exclusive states:
//   IDLE → LISTENING → SEARCHING → RESULTS → PLAYING
//                   ↓               ↓           ↓
//                 IDLE            IDLE        RESULTS
const state = {
  current:      'IDLE',   // current state name (string)
  query:        '',       // last successful speech transcript
  results:      [],       // array of { videoId, title, thumbnail, channel }
  recognition:  null,     // SpeechRecognition instance (created once, reused)
  speechTimer:  null,     // setTimeout handle for the iOS safety-net
  toastTimer:   null,     // setTimeout handle for auto-dismiss toast
};
 
// ── DOM Reference Cache ───────────────────────────────────────
// Query once at startup; never query again during runtime.
const el = {};
 
function cacheDOMRefs() {
  el.screenHome      = document.getElementById('screen-home');
  el.screenResults   = document.getElementById('screen-results');
  el.btnSearch       = document.getElementById('btn-search');
  el.micIcon         = el.btnSearch.querySelector('.mic-icon');
  el.btnLabel        = el.btnSearch.querySelector('.btn-label');
  el.statusText      = document.getElementById('status-text');
  el.btnBack         = document.getElementById('btn-back');
  el.queryDisplay    = document.getElementById('query-display');
  el.resultsGrid     = document.getElementById('results-grid');
  el.overlayPlayer   = document.getElementById('overlay-player');
  el.btnClose        = document.getElementById('btn-close');
  el.playerTitle     = document.getElementById('player-title');
  el.iframeContainer = document.getElementById('iframe-container');
  el.toastError      = document.getElementById('toast-error');
  el.toastMessage    = document.getElementById('toast-message');
  el.toastDismiss    = document.getElementById('toast-dismiss');
}
 
// ── Browser Support Check ─────────────────────────────────────
function checkBrowserSupport() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    el.btnSearch.disabled = true;
    el.btnSearch.style.opacity = '0.4';
    el.btnLabel.textContent = 'NOT SUPPORTED';
    showToast(
      'Voice search is not supported in this browser. ' +
      'Please open this page in Chrome (Android) or Safari (iPhone).'
    );
    return false;
  }
  return true;
}
 
// ── Event Binding ─────────────────────────────────────────────
function bindEvents() {
  el.btnSearch.addEventListener('click', handleMicButtonClick);
  el.btnBack.addEventListener('click', () => transitionTo('IDLE'));
  el.btnClose.addEventListener('click', closePlayer);
  el.toastDismiss.addEventListener('click', hideToast);
 
  // Event delegation: cards don't exist yet at bind time
  el.resultsGrid.addEventListener('click', handleCardClick);
 
  // Android hardware back button / gesture: close player instead of leaving app
  window.addEventListener('popstate', handlePopState);
}
 
// ── Screen Helpers ────────────────────────────────────────────
function showScreen(screenEl) {
  screenEl.removeAttribute('hidden');
  // rAF ensures the browser has painted the un-hidden state before
  // we add 'active', giving the CSS opacity transition something to
  // transition FROM (0) rather than jumping straight to 1.
  requestAnimationFrame(() => screenEl.classList.add('active'));
}
 
function hideScreen(screenEl) {
  screenEl.classList.remove('active');
  // Wait for the fade-out transition to finish before hiding from layout
  screenEl.addEventListener('transitionend', function onEnd() {
    screenEl.removeEventListener('transitionend', onEnd);
    if (!screenEl.classList.contains('active')) {
      screenEl.setAttribute('hidden', '');
    }
  });
}
 
// ── State Transition ──────────────────────────────────────────
function transitionTo(newState, payload = {}) {
  state.current = newState;
  el.statusText.textContent = '';
 
  switch (newState) {
 
    case 'IDLE':
      stopListening();
      closePlayerSilent();
      showScreen(el.screenHome);
      hideScreen(el.screenResults);
      el.btnSearch.classList.remove('listening');
      el.btnSearch.disabled = false;
      el.micIcon.textContent  = '🎤';
      el.btnLabel.textContent = 'SEARCH FOR MUSIC';
      break;
 
    case 'LISTENING':
      showScreen(el.screenHome);
      el.btnSearch.classList.add('listening');
      el.micIcon.textContent  = '🔴';
      el.btnLabel.textContent = 'LISTENING…';
      el.statusText.textContent = 'Speak now — say a song, artist, or band…';
      startListening();
      break;
 
    case 'SEARCHING':
      stopListening();
      el.btnSearch.classList.remove('listening');
      el.btnSearch.disabled = true;
      el.micIcon.textContent  = '🔍';
      el.btnLabel.textContent = 'SEARCHING…';
      el.statusText.textContent = `Searching for "${state.query}"…`;
      fetchResults(state.query);
      break;
 
    case 'RESULTS':
      showScreen(el.screenResults);
      hideScreen(el.screenHome);
      el.btnSearch.disabled = false;
      el.micIcon.textContent  = '🎤';
      el.btnLabel.textContent = 'SEARCH FOR MUSIC';
      el.queryDisplay.textContent = `"${state.query}"`;
      renderCards(state.results);
      break;
 
    case 'PLAYING':
      openPlayer(payload.videoId, payload.title);
      break;
  }
}
 
// ── Speech Recognition ────────────────────────────────────────
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
 
  const r = new SR();
  r.lang             = 'en-US';
  r.interimResults   = false;  // only care about final results
  r.maxAlternatives  = 1;
  // continuous:true is broken on iOS WebKit — always use false
  r.continuous       = false;
 
  r.onresult = (event) => {
    clearTimeout(state.speechTimer);
    const transcript = event.results[0][0].transcript.trim();
    if (transcript) {
      state.query = transcript;
      transitionTo('SEARCHING');
    } else {
      showToast("Couldn't understand that. Please try again.");
      transitionTo('IDLE');
    }
  };
 
  r.onerror = (event) => {
    clearTimeout(state.speechTimer);
    const messages = {
      'not-allowed':         'Microphone access was denied. Please allow mic access in your browser settings, then try again.',
      'no-speech':           "No speech was detected. Please tap the button and speak clearly.",
      'network':             'Network error during voice recognition. Please check your connection.',
      'audio-capture':       'No microphone was found on this device.',
      'service-not-allowed': 'Voice recognition is not allowed. Please try in Chrome or Safari.',
    };
    showToast(messages[event.error] || `Voice error: ${event.error}. Please try again.`);
    transitionTo('IDLE');
  };
 
  r.onend = () => {
    clearTimeout(state.speechTimer);
    // iOS sometimes fires onend without onresult (silent timeout bug).
    // If we're still listening when this happens, treat it as no-speech.
    if (state.current === 'LISTENING') {
      showToast("Microphone stopped unexpectedly. Please try again.");
      transitionTo('IDLE');
    }
  };
 
  return r;
}
 
function startListening() {
  if (!state.recognition) {
    state.recognition = initRecognition();
  }
  if (!state.recognition) return;
 
  try {
    state.recognition.start();
 
    // iOS SpeechRecognition sometimes silently stops with no onend or onerror.
    // Force a transition to IDLE after SPEECH_TIMEOUT_MS as a safety net.
    state.speechTimer = setTimeout(() => {
      if (state.current === 'LISTENING') {
        showToast('Listening timed out. Please try again.');
        transitionTo('IDLE');
      }
    }, SPEECH_TIMEOUT_MS);
 
  } catch (e) {
    // InvalidStateError is thrown if .start() is called while already active
    // (e.g. user taps the button twice very quickly). Safe to ignore.
    if (e.name !== 'InvalidStateError') {
      showToast('Could not start the microphone. Please try again.');
      transitionTo('IDLE');
    }
  }
}
 
function stopListening() {
  clearTimeout(state.speechTimer);
  if (state.recognition) {
    try {
      // Use stop(), NOT abort(). On iOS, abort() corrupts the recognition
      // instance and subsequent calls to start() silently fail.
      state.recognition.stop();
    } catch (_) {
      // Ignore — may throw if already stopped
    }
  }
}
 
// ── Mic Button Click ──────────────────────────────────────────
function handleMicButtonClick() {
  if (state.current === 'IDLE') {
    transitionTo('LISTENING');
  } else if (state.current === 'LISTENING') {
    // Second tap cancels listening
    stopListening();
    transitionTo('IDLE');
  }
  // Ignore taps during SEARCHING / RESULTS / PLAYING
}
 
// ── YouTube API Fetch ─────────────────────────────────────────
async function fetchResults(query) {
  // Catch forgotten API key before making a useless network call
  if (YOUTUBE_API_KEY === 'YOUR_API_KEY_HERE') {
    showToast('No API key set. Open script.js and paste your YouTube API key.');
    transitionTo('IDLE');
    return;
  }
 
  const params = new URLSearchParams({
    part:            'snippet',
    // Append "music" to bias results away from talk shows / comedy clips
    q:               `${query} music`,
    type:            'video',
    videoCategoryId: '10',          // YouTube category 10 = Music (soft filter)
    maxResults:      RESULTS_COUNT,
    key:             YOUTUBE_API_KEY,
    safeSearch:      'moderate',
  });
 
  let data;
  try {
    const response = await fetch(`${YOUTUBE_SEARCH_URL}?${params}`);
 
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason || String(response.status);
      if (response.status === 403) {
        showToast('API key error or daily quota exceeded. Please try again later.');
      } else {
        showToast(`Search failed (${reason}). Please try again.`);
      }
      transitionTo('IDLE');
      return;
    }
 
    data = await response.json();
 
  } catch (e) {
    showToast('Network error. Please check your internet connection and try again.');
    transitionTo('IDLE');
    return;
  }
 
  const items = (data.items || []).filter(item => item.id?.videoId);
 
  if (items.length === 0) {
    showToast(`No results found for "${query}". Try different words.`);
    transitionTo('IDLE');
    return;
  }
 
  state.results = items.map(item => ({
    videoId:   item.id.videoId,
    title:     item.snippet.title,
    channel:   item.snippet.channelTitle,
    // Prefer medium thumbnail (320×180); fall back gracefully
    thumbnail: item.snippet.thumbnails?.medium?.url
            || item.snippet.thumbnails?.high?.url
            || item.snippet.thumbnails?.default?.url
            || '',
  }));
 
  transitionTo('RESULTS');
}
 
// ── Card Rendering ────────────────────────────────────────────
function renderCards(results) {
  // Clear any previous results
  el.resultsGrid.innerHTML = '';
 
  results.forEach(({ videoId, title, thumbnail, channel }) => {
    const decodedTitle = decodeHTMLEntities(title);
 
    // Use <button> for correct semantics and free keyboard/Enter support
    const btn = document.createElement('button');
    btn.className = 'card';
    btn.setAttribute('role', 'listitem');
    // Store video data in data-attributes for the click handler
    btn.dataset.videoId = videoId;
    btn.dataset.title   = decodedTitle;
 
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src       = thumbnail;
    img.alt       = `${decodedTitle} — ${channel}`;
    img.loading   = 'lazy';
    // If thumbnail fails to load, show a dark placeholder
    img.onerror   = () => {
      img.removeAttribute('src');
      img.style.minHeight = '80px';
    };
 
    const span = document.createElement('span');
    span.className   = 'card-title';
    span.textContent = decodedTitle;
 
    btn.appendChild(img);
    btn.appendChild(span);
    el.resultsGrid.appendChild(btn);
  });
}
 
// ── Card Click Handler ────────────────────────────────────────
function handleCardClick(event) {
  const card = event.target.closest('.card');
  if (!card) return;
  const { videoId, title } = card.dataset;
  if (videoId) {
    transitionTo('PLAYING', { videoId, title });
  }
}
 
// ── Video Player ──────────────────────────────────────────────
function openPlayer(videoId, title) {
  el.playerTitle.textContent = title;
  el.overlayPlayer.removeAttribute('hidden');
 
  const iframe = document.createElement('iframe');
  iframe.width  = '100%';
  iframe.height = '100%';
 
  // 'autoplay' must appear in the allow attribute for autoplay to work
  // in browsers that enforce Permissions Policy.
  iframe.allow = [
    'accelerometer',
    'autoplay',
    'clipboard-write',
    'encrypted-media',
    'gyroscope',
    'picture-in-picture',
    'web-share',
  ].join('; ');
 
  // Both the property and the attribute are needed for cross-browser fullscreen
  iframe.allowFullscreen = true;
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('webkitallowfullscreen', '');  // legacy Safari
 
  // YouTube embed parameters:
  //   autoplay=1        — start playing immediately
  //   playsinline=1     — CRITICAL for iOS: prevents Safari from hijacking
  //                       playback into its own native fullscreen player,
  //                       which would hide our close button
  //   rel=0             — don't show unrelated channel recommendations
  //   modestbranding=1  — minimal YouTube logo
  //   fs=1              — show YouTube's own fullscreen button
  //   iv_load_policy=3  — hide video annotations
  iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(videoId)
    + '?autoplay=1&playsinline=1&rel=0&modestbranding=1&fs=1&iv_load_policy=3';
 
  el.iframeContainer.appendChild(iframe);
 
  // Push a history entry so the Android back gesture closes the player
  // rather than navigating the browser away from the page.
  history.pushState({ player: true }, '');
}
 
function closePlayer() {
  // Destroy the iframe entirely — setting src='' does not reliably stop
  // audio in all browsers. Removing the element always does.
  el.iframeContainer.innerHTML = '';
  el.overlayPlayer.setAttribute('hidden', '');
  // Return to results so grandpa can pick another video
  state.current = 'RESULTS';
}
 
// Called when transitioning to IDLE (back button), skips state update
function closePlayerSilent() {
  el.iframeContainer.innerHTML = '';
  el.overlayPlayer.setAttribute('hidden', '');
}
 
function handlePopState() {
  if (state.current === 'PLAYING') {
    closePlayer();
  }
}
 
// ── Toast ─────────────────────────────────────────────────────
function showToast(message) {
  clearTimeout(state.toastTimer);
  // textContent prevents any injected HTML from the API error messages
  el.toastMessage.textContent = message;
  el.toastError.removeAttribute('hidden');
  state.toastTimer = setTimeout(hideToast, TOAST_DURATION_MS);
}
 
function hideToast() {
  clearTimeout(state.toastTimer);
  el.toastError.setAttribute('hidden', '');
}
 
// ── Utility ───────────────────────────────────────────────────
// YouTube API returns titles with HTML entities (e.g. &amp; &#39; &quot;).
// A throwaway <textarea> lets the browser decode them safely: textarea
// does not parse or execute child elements, so there is no XSS risk.
function decodeHTMLEntities(str) {
  const ta = document.createElement('textarea');
  ta.innerHTML = str;
  return ta.value;
}
 
// ── Bootstrap ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  cacheDOMRefs();
  const supported = checkBrowserSupport();
  bindEvents();
  transitionTo('IDLE');
 
  // Pre-warm the SpeechRecognition instance so the first tap is instant
  if (supported) {
    state.recognition = initRecognition();
  }
});
