const API = location.origin;
const $ = id => document.getElementById(id);
const video = $('video');
let catalog = [];
let catalogTotal = 0;
let catalogPage = 1;
let currentDrama = null;
let episodes = [];
let currentEp = 0;
let hls = null;
let auxAudio = null;
let subtitleBlobUrl = '';
let selection = 0;
let searchTimer;
let localAbort = null;
let liveAbort = null;
let catalogRequest = 0;
let displayedTotal = 0;
let playRequest = 0;
let playbackState = null;

function setView(view) {
  document.body.dataset.view = view;
  if (view === 'catalog') {
    video.pause();
    if (auxAudio) auxAudio.pause();
    updateMiniDock();
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function updateMiniDock() {
  const dock = $('miniDock');
  if (!dock) return;
  if (!currentDrama || document.body.dataset.view === 'watch') {
    dock.hidden = true;
    return;
  }
  $('miniPoster').src = currentDrama.poster || '';
  $('miniTitle').textContent = currentDrama.title;
  const ep = episodes[currentEp];
  $('miniEp').textContent = ep ? (ep.title || `Episode ${ep.number}`) : 'Lanjutkan menonton';
  dock.hidden = false;
}

function message(text) {
  $('screenMessageText').textContent = text;
  $('screenMessage').classList.remove('hidden');
}

function hideMessage() {
  $('screenMessage').classList.add('hidden');
  $('retryBtn').hidden = true;
}

let hlsLoadPromise = null;
function ensureHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLoadPromise) return hlsLoadPromise;
  hlsLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsLoadPromise = null; reject(new Error('Gagal memuat pemutar HLS')); };
    document.head.append(s);
  });
  return hlsLoadPromise;
}

function makeIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'lucide');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function showAction(label, action, iconId = 'ic-rotate') {
  const button = $('retryBtn');
  button.replaceChildren();
  const text = document.createElement('span');
  text.textContent = label;
  button.append(makeIcon(iconId), text);
  button.onclick = action;
  button.hidden = false;
}

function proxyMediaUrl(url, isSub = false) {
  if (!url) return '';
  return `${API}/proxy?${isSub ? 'sub=1&' : ''}url=${encodeURIComponent(url)}`;
}

async function json(url, signal) {
  const response = await fetch(url, signal ? { signal } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function clearAuxAudio() {
  if (!auxAudio) return;
  try { auxAudio.pause(); } catch {}
  auxAudio.removeAttribute('src');
  auxAudio = null;
}

function clearSubtitleTracks() {
  for (const track of Array.from(video.querySelectorAll('track'))) track.remove();
  if (subtitleBlobUrl) {
    URL.revokeObjectURL(subtitleBlobUrl);
    subtitleBlobUrl = '';
  }
}

function resetMediaElement() {
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  clearAuxAudio();
  clearSubtitleTracks();
  video.removeAttribute('src');
  video.load();
}

function setupAuxAudio(audioUrl) {
  clearAuxAudio();
  if (!audioUrl) return;
  auxAudio = new Audio(proxyMediaUrl(audioUrl));
  auxAudio.preload = 'auto';
}

async function attachSubtitle(subUrl, label = 'Subtitle', srclang = 'id', token = playRequest) {
  clearSubtitleTracks();
  if (!subUrl) return;
  try {
    const resp = await fetch(proxyMediaUrl(subUrl, true));
    if (!resp.ok || token !== playRequest) return;
    const text = await resp.text();
    if (!text.trim() || token !== playRequest) return;
    subtitleBlobUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.srclang = (srclang || 'id').split('-')[0];
    track.src = subtitleBlobUrl;
    track.default = true;
    video.append(track);
    if (video.textTracks?.[0]) video.textTracks[0].mode = 'showing';
  } catch {}
}

function renderSubSelector(source) {
  const select = $('subSelect');
  const tracks = Array.isArray(source?.subtitles) ? source.subtitles : [];
  if (!tracks.length) {
    select.hidden = true;
    select.replaceChildren();
    return;
  }
  select.replaceChildren();
  const off = document.createElement('option');
  off.value = '';
  off.textContent = 'CC: Mati';
  select.append(off);
  for (const t of tracks) {
    const opt = document.createElement('option');
    opt.value = t.url;
    opt.textContent = `CC: ${t.label}`;
    if (t.url === source.subtitleUrl) opt.selected = true;
    select.append(opt);
  }
  select.hidden = false;
  select.onchange = () => {
    const chosen = tracks.find(t => t.url === select.value);
    if (!chosen) clearSubtitleTracks();
    else attachSubtitle(chosen.url, chosen.label, chosen.code, playRequest);
  };
}

function renderResSelector(source, activeUrl) {
  const select = $('resSelect');
  const list = Array.isArray(source?.resolutions) ? source.resolutions : [];
  if (list.length < 2) {
    select.hidden = true;
    select.replaceChildren();
    return;
  }
  select.replaceChildren();
  for (const r of list) {
    const opt = document.createElement('option');
    opt.value = r.url;
    opt.textContent = r.codec ? `${r.label} (${r.codec})` : r.label;
    if (r.url === activeUrl) opt.selected = true;
    select.append(opt);
  }
  select.hidden = false;
  select.onchange = () => {
    const picked = list.find(r => r.url === select.value);
    if (!picked || !playbackState) return;
    playbackState.transcoding = false;
    startMediaCandidate({ url: picked.url, isHls: picked.isHls, variant: 'primary' }, playbackState.token);
  };
}

function renderHero(query) {
  const hero = $('heroCard');
  if (!hero) return;
  const featured = catalog[0];
  if (query || !featured) {
    hero.hidden = true;
    return;
  }
  $('heroPoster').src = featured.poster || '';
  $('heroTitle').textContent = featured.title;
  $('heroPlayBtn').onclick = () => openDrama(featured);
  hero.hidden = false;
}

function renderCatalog() {
  const list = $('catalogList');
  list.replaceChildren();
  const q = $('searchInput').value.trim();
  renderHero(q);
  $('catalogHeading').textContent = q ? `Hasil untuk “${q}”` : 'Katalog Drama';
  $('catalogHint').textContent = q
    ? `${catalog.length} judul`
    : `${catalogTotal.toLocaleString('id-ID')} judul`;

  if (!catalog.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Judul tidak ditemukan.';
    list.append(empty);
    return;
  }
  for (let idx = 0; idx < catalog.length; idx++) {
    const drama = catalog[idx];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `drama-card${currentDrama?.slug === drama.slug ? ' active' : ''}`;
    const thumbBox = document.createElement('div');
    thumbBox.className = 'drama-thumb-box';
    const badge = document.createElement('span');
    badge.className = 'drama-badge';
    badge.textContent = 'Diputar';
    const image = document.createElement('img');
    image.src = drama.poster;
    image.alt = drama.title;
    image.width = 300;
    image.height = 400;
    image.decoding = 'async';
    if (idx < 6) {
      image.fetchPriority = 'high';
    } else {
      image.loading = 'lazy';
      image.fetchPriority = 'low';
    }
    image.referrerPolicy = 'no-referrer';
    thumbBox.append(badge, image);

    const meta = document.createElement('div');
    meta.className = 'drama-meta';
    const title = document.createElement('strong');
    title.textContent = drama.title;
    meta.append(title);

    button.append(thumbBox, meta);
    button.onclick = () => openDrama(drama);
    list.append(button);
  }
  if (!q && catalog.length < catalogTotal) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'catalog-more';
    const text = document.createElement('span');
    text.textContent = 'Muat lebih banyak';
    more.append(makeIcon('ic-plus'), text);
    more.onclick = () => loadCatalog('', catalogPage + 1, true);
    list.append(more);
  }
}

async function loadCatalog(query = '', page = 1, append = false, source = 'auto') {
  const requestId = ++catalogRequest;
  if (!append) {
    if (localAbort) localAbort.abort();
    if (source !== 'local' && liveAbort) liveAbort.abort();
  }
  const controller = new AbortController();
  if (source === 'local') localAbort = controller;
  else if (!append) liveAbort = controller;

  try {
    const data = await json(`${API}/api/catalog?limit=24&page=${page}&source=${encodeURIComponent(source)}&q=${encodeURIComponent(query)}`, controller.signal);
    if (requestId !== catalogRequest && source === 'local') return;
    if (query !== $('searchInput').value.trim()) return;
    catalogPage = page;
    catalogTotal = data.total;
    catalog = append ? [...catalog, ...data.items] : data.items;
    if (!query) displayedTotal = data.total;
    $('catalogStats').textContent = query
      ? `${data.total.toLocaleString('id-ID')} hasil`
      : `${data.total.toLocaleString('id-ID')} judul`;
    renderCatalog();
    if (query && source === 'local') {
      $('catalogHint').textContent = `${data.total.toLocaleString('id-ID')} lokal · mencari sumber...`;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (requestId === catalogRequest) $('catalogHint').textContent = `Gagal memuat katalog: ${error.message}`;
  }
}

function openDrama(drama, episodeNumber = null) {
  if (location.hash !== `#watch=${encodeURIComponent(drama.slug)}`) {
    history.pushState({ view: 'watch', slug: drama.slug }, '', `#watch=${encodeURIComponent(drama.slug)}`);
  }
  selectDrama(drama, episodeNumber, true);
}

async function selectDrama(drama, episodeNumber = null, autoPlay = true) {
  const requestId = ++selection;
  playRequest++;
  playbackState = null;
  currentDrama = drama;
  episodes = [];
  currentEp = 0;
  setView('watch');
  resetMediaElement();
  video.poster = drama.poster;
  $('retryBtn').hidden = true;
  $('resSelect').hidden = true;
  $('subSelect').hidden = true;
  $('dramaTitle').textContent = drama.title;
  $('dramaSubtitle').textContent = 'Mengambil daftar episode...';
  $('episodeBadge').textContent = '—';
  renderCatalog();
  renderEpisodes();
  message('Memuat episode...');
  try {
    const data = await json(`${API}/api/episodes?slug=${encodeURIComponent(drama.slug)}`);
    if (requestId !== selection) return;
    episodes = data.episodes || [];
    $('dramaSubtitle').textContent = `${episodes.length} episode tersedia`;
    renderEpisodes();
    const requested = episodes.findIndex(episode => episode.number === episodeNumber || episode.routeNumber === episodeNumber);
    if (!autoPlay && episodes.length) {
      currentEp = 0;
      $('episodeBadge').textContent = episodes[0].title || `Episode ${episodes[0].number}`;
      renderEpisodes();
      message('Pilih episode untuk mulai menonton.');
      showAction('Putar episode', () => playEpisode(0));
    } else if (requested >= 0) playEpisode(requested);
    else if (episodes.length) playEpisode(0);
    else message('Belum ada episode dari sumber.');
  } catch (error) {
    if (requestId === selection) message(`Episode gagal dimuat: ${error.message}`);
  }
}

function renderEpisodes() {
  const strip = $('epStrip');
  const ranges = $('epRanges');
  strip.replaceChildren();
  $('episodeCount').textContent = `${episodes.length} ep`;
  $('prevBtn').disabled = currentEp <= 0;
  $('nextBtn').disabled = currentEp >= episodes.length - 1;
  for (let i = 0; i < episodes.length; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ep${i === currentEp ? ' active' : ''}`;
    button.setAttribute('aria-label', episodes[i].title || `Episode ${episodes[i].number || i + 1}`);
    button.textContent = String(episodes[i].number || i + 1);
    button.onclick = () => playEpisode(i);
    strip.append(button);
  }
  if (ranges) {
    ranges.replaceChildren();
    if (episodes.length > 35) {
      const chunkSize = 30;
      for (let start = 0; start < episodes.length; start += chunkSize) {
        const end = Math.min(episodes.length, start + chunkSize);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ep-range-btn${currentEp >= start && currentEp < end ? ' active' : ''}`;
        btn.textContent = `${episodes[start].number || start + 1}–${episodes[end - 1].number || end}`;
        btn.onclick = () => {
          const target = strip.children[start];
          if (target) strip.scrollTop = Math.max(0, target.offsetTop - strip.offsetTop);
        };
        ranges.append(btn);
      }
      ranges.hidden = false;
    } else {
      ranges.hidden = true;
    }
  }
  const activeBtn = strip.children[currentEp];
  if (activeBtn && currentEp > 0) {
    strip.scrollTop = Math.max(0, activeBtn.offsetTop - strip.offsetTop - strip.clientHeight / 2 + activeBtn.clientHeight / 2);
  }
}

function buildCandidates(source) {
  const candidates = [];
  const seen = new Set();
  const push = (url, isHls, variant = 'primary') => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, isHls, variant });
  };
  const h264Res = (source.resolutions || []).find(r => r.codec === 'h264');
  if (h264Res) push(h264Res.url, h264Res.isHls, 'primary');
  push(source.url, source.isHls, 'primary');
  push(source.fallbackUrl, source.fallbackIsHls, 'fallback');
  return candidates;
}

async function startMediaCandidate(candidate, token) {
  if (token !== playRequest || !candidate?.url) return;
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.load();
  const proxied = proxyMediaUrl(candidate.url);
  if (candidate.isHls) {
    try { await ensureHls(); } catch { return handlePlaybackFailure(); }
    if (token !== playRequest) return;
  }
  if (candidate.isHls && window.Hls?.isSupported()) {
    hls = new Hls({ fragLoadingMaxRetry: 4, manifestLoadingMaxRetry: 3, levelLoadingMaxRetry: 3 });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (token !== playRequest || !data.fatal) return;
      const detail = String(data.details || '');
      if (detail === 'manifestIncompatibleCodecsError' || detail === 'bufferAddCodecError') {
        setTimeout(() => { if (token === playRequest) fallbackToTranscode(); }, 0);
      } else {
        setTimeout(() => { if (token === playRequest) handlePlaybackFailure(); }, 0);
      }
    });
    hls.loadSource(proxied);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (token === playRequest) video.play().catch(playRejection);
    });
  } else if (!candidate.isHls || video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxied;
    video.play().catch(playRejection);
  } else {
    handlePlaybackFailure();
  }
}

function applySourcePayload(source, token) {
  if (token !== playRequest) return;
  if (source.hasDrm && !source.url) {
    message('Episode ini dilindungi DRM dan tidak dapat diputar di player lokal.');
    return;
  }
  const candidates = buildCandidates(source);
  if (!candidates.length) {
    message('Sumber belum menyediakan tautan video untuk episode ini.');
    showAction('Coba lagi', () => playEpisode(currentEp));
    return;
  }
  playbackState = {
    token,
    source,
    candidates,
    candidateIndex: 0,
    freshRetried: playbackState?.freshRetried || false,
    transcoding: false
  };
  renderResSelector(source, candidates[0].url);
  renderSubSelector(source);
  if (source.audioUrl) setupAuxAudio(source.audioUrl);
  if (source.subtitleUrl) {
    const activeTrack = (source.subtitles || []).find(t => t.url === source.subtitleUrl);
    attachSubtitle(source.subtitleUrl, activeTrack?.label || 'Subtitle', activeTrack?.code || 'id', token);
  }
  startMediaCandidate(candidates[0], token);
}

async function playEpisode(index) {
  if (index < 0 || index >= episodes.length) return;
  const token = ++playRequest;
  currentEp = index;
  const episode = episodes[index];
  const epNum = episode.routeNumber || episode.number || index + 1;
  playbackState = null;
  $('episodeBadge').textContent = episode.title || `Episode ${episode.number || index + 1}`;
  renderEpisodes();
  updateMiniDock();
  message('Menyiapkan video...');
  $('retryBtn').hidden = true;
  $('resSelect').hidden = true;
  $('subSelect').hidden = true;
  resetMediaElement();
  try {
    const fresh = await json(`${API}/api/episode-source?slug=${encodeURIComponent(currentDrama.slug)}&number=${epNum}`);
    applySourcePayload(fresh, token);
  } catch (error) {
    if (token !== playRequest) return;
    message(`Gagal memperbarui tautan: ${error.message}`);
    showAction('Coba lagi', () => playEpisode(currentEp));
  }
}

function playRejection(error) {
  if (error.name === 'NotAllowedError') {
    message('Video siap. Tekan tombol putar untuk memulai.');
    showAction('Putar video', () => video.play().catch(playRejection));
  } else if (error.name !== 'AbortError') {
    handlePlaybackFailure();
  }
}

async function handlePlaybackFailure() {
  const st = playbackState;
  if (!st || st.token !== playRequest) return;
  if (!st.transcoding && st.candidateIndex + 1 < st.candidates.length) {
    st.candidateIndex += 1;
    message('Mencoba jalur cadangan...');
    return startMediaCandidate(st.candidates[st.candidateIndex], st.token);
  }
  if (!st.transcoding && !st.freshRetried) {
    st.freshRetried = true;
    message('Mengambil tautan baru dari sumber...');
    try {
      const episode = episodes[currentEp];
      const epNum = episode.routeNumber || episode.number || currentEp + 1;
      const fresh = await json(`${API}/api/episode-source?slug=${encodeURIComponent(currentDrama.slug)}&number=${epNum}&fresh=1`);
      return applySourcePayload(fresh, st.token);
    } catch {}
  }
  if (!st.transcoding) return fallbackToTranscode();
  message('Tautan video dari sumber gagal atau kedaluwarsa. Coba ambil ulang tautannya.');
  showAction('Coba lagi', () => playEpisode(currentEp));
}

function fallbackToTranscode() {
  const st = playbackState;
  if (!st || st.transcoding || !currentDrama || !episodes[currentEp]) return;
  st.transcoding = true;
  message('Menyesuaikan format video untuk browser...');
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  const episode = episodes[currentEp];
  const epNum = episode.routeNumber || episode.number || currentEp + 1;
  const activeCandidate = st.candidates[st.candidateIndex];
  const variant = activeCandidate?.variant || 'primary';
  video.src = `${API}/api/transcode?slug=${encodeURIComponent(currentDrama.slug)}&number=${epNum}&variant=${variant}`;
  video.play().catch(playRejection);
}

video.addEventListener('loadeddata', () => {
  if (video.videoWidth) hideMessage();
  else if (playbackState && !playbackState.transcoding) fallbackToTranscode();
});
video.addEventListener('playing', () => { if (video.videoWidth) hideMessage(); });
video.addEventListener('play', () => {
  if (auxAudio) {
    auxAudio.currentTime = video.currentTime || 0;
    auxAudio.play().catch(() => {});
  }
});
video.addEventListener('pause', () => { if (auxAudio) auxAudio.pause(); });
video.addEventListener('seeked', () => {
  if (auxAudio) auxAudio.currentTime = video.currentTime || 0;
});
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  handlePlaybackFailure();
});
video.addEventListener('ended', () => {
  if (currentEp + 1 < episodes.length) playEpisode(currentEp + 1);
});

$('prevBtn').onclick = () => { if (currentEp > 0) playEpisode(currentEp - 1); };
$('nextBtn').onclick = () => { if (currentEp + 1 < episodes.length) playEpisode(currentEp + 1); };

function goCatalog() {
  if (location.hash.startsWith('#watch=')) history.replaceState(null, '', location.pathname + location.search);
  setView('catalog');
}
$('backBtn').onclick = goCatalog;
$('brandBtn').onclick = goCatalog;
$('miniResumeBtn').onclick = () => {
  if (!currentDrama) return;
  history.pushState({ view: 'watch', slug: currentDrama.slug }, '', `#watch=${encodeURIComponent(currentDrama.slug)}`);
  setView('watch');
};
window.addEventListener('popstate', () => {
  if (!location.hash.startsWith('#watch=')) setView('catalog');
});

$('searchInput').oninput = event => {
  clearTimeout(searchTimer);
  const value = event.target.value.trim();
  if ($('searchClearBtn')) $('searchClearBtn').hidden = !event.target.value.length;
  if (value && document.body.dataset.view === 'watch') setView('catalog');
  if (!value) {
    if (localAbort) localAbort.abort();
    if (liveAbort) liveAbort.abort();
    loadCatalog('');
    return;
  }
  loadCatalog(value, 1, false, 'local');
  searchTimer = setTimeout(() => loadCatalog(value, 1, false, 'live'), 180);
};
if ($('searchClearBtn')) {
  $('searchClearBtn').onclick = () => {
    $('searchInput').value = '';
    $('searchClearBtn').hidden = true;
    if (localAbort) localAbort.abort();
    if (liveAbort) liveAbort.abort();
    loadCatalog('');
    $('searchInput').focus();
  };
}

$('updateBtn').onclick = async () => {
  const button = $('updateBtn');
  button.disabled = true;
  $('updateStatus').textContent = 'Memeriksa...';
  try {
    const query = $('searchInput').value.trim();
    const response = await fetch(`${API}/api/catalog/update?q=${encodeURIComponent(query)}`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    $('updateStatus').textContent = result.added ? `+${result.added} baru` : 'Terbaru';
    await loadCatalog($('searchInput').value.trim());
  } catch (error) {
    $('updateStatus').textContent = `Gagal: ${error.message}`;
  } finally {
    button.disabled = false;
  }
};

setInterval(async () => {
  try {
    const status = await json(`${API}/api/catalog/status`);
    if (!$('searchInput').value.trim() && status.total !== displayedTotal) loadCatalog();
  } catch (_) {}
}, 60 * 1000);

loadCatalog();
