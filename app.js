const API = location.origin;
const $ = id => document.getElementById(id);
const video = $('video');
let catalog = [];
let currentDrama = null;
let episodes = [];
let currentEp = 0;
let hls = null;
let selection = 0;
let searchTimer;
let catalogRequest = 0;
let displayedTotal = 0;
let playRequest = 0;
let transcoding = false;

function message(text) {
  $('screenMessageText').textContent = text;
  $('screenMessage').classList.remove('hidden');
}

function hideMessage() {
  $('screenMessage').classList.add('hidden');
  $('retryBtn').hidden = true;
}

function showAction(label, action) {
  const button = $('retryBtn');
  button.textContent = label;
  button.onclick = action;
  button.hidden = false;
}

async function json(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function renderCatalog() {
  const list = $('catalogList');
  list.replaceChildren();
  if (!catalog.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Judul tidak ditemukan.';
    list.append(empty);
    return;
  }
  for (const drama of catalog) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `drama${currentDrama?.slug === drama.slug ? ' active' : ''}`;
    const image = document.createElement('img');
    image.src = drama.poster;
    image.alt = '';
    image.loading = 'lazy';
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = drama.title;
    const hint = document.createElement('small');
    hint.textContent = 'Tonton episode';
    text.append(title, hint);
    button.append(image, text);
    button.onclick = () => selectDrama(drama);
    list.append(button);
  }
}

async function loadCatalog(query = '') {
  const requestId = ++catalogRequest;
  try {
    const data = await json(`${API}/api/catalog?limit=60&q=${encodeURIComponent(query)}`);
    if (requestId !== catalogRequest) return;
    catalog = data.items;
    if (!query) displayedTotal = data.total;
    $('catalogStats').textContent = query
      ? `${data.total.toLocaleString('id-ID')} ditampilkan`
      : `${data.total.toLocaleString('id-ID')} tersimpan`;
    renderCatalog();
    if (!currentDrama && catalog.length) selectDrama(catalog[0], null, false);
    if (!catalog.length && !currentDrama) message('Tidak ada drama yang tersedia.');
  } catch (error) {
    if (requestId === catalogRequest) message(`Katalog gagal dimuat: ${error.message}`);
  }
}

async function selectDrama(drama, episodeNumber = null, autoPlay = true) {
  const requestId = ++selection;
  playRequest++;
  transcoding = false;
  currentDrama = drama;
  episodes = [];
  currentEp = 0;
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.poster = drama.poster;
  video.load();
  $('retryBtn').hidden = true;
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
    $('dramaSubtitle').textContent = `${episodes.length} episode`;
    renderEpisodes();
    const requested = episodes.findIndex(episode => episode.number === episodeNumber);
    if (!autoPlay && episodes.length) {
      currentEp = 0;
      $('episodeBadge').textContent = `Episode ${episodes[0].number}`;
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
  strip.replaceChildren();
  $('episodeCount').textContent = `${episodes.length} episode`;
  $('prevBtn').disabled = currentEp <= 0;
  $('nextBtn').disabled = currentEp >= episodes.length - 1;
  for (let i = 0; i < episodes.length; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ep${i === currentEp ? ' active' : ''}`;
    button.setAttribute('aria-label', `Episode ${episodes[i].number || i + 1}`);
    const label = document.createElement('span');
    label.textContent = 'EPISODE';
    button.append(label, String(episodes[i].number || i + 1));
    button.onclick = () => playEpisode(i);
    strip.append(button);
  }
}

async function playEpisode(index) {
  if (index < 0 || index >= episodes.length) return;
  const requestId = ++playRequest;
  transcoding = false;
  currentEp = index;
  const episode = episodes[index];
  $('episodeBadge').textContent = `Episode ${episode.number || index + 1}`;
  renderEpisodes();
  message('Menyiapkan video...');
  $('retryBtn').hidden = true;
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.load();
  try {
    const fresh = await json(`${API}/api/episode-source?slug=${encodeURIComponent(currentDrama.slug)}&number=${episode.number}`);
    if (requestId !== playRequest) return;
    const source = fresh.isHls ? `${API}/proxy?url=${encodeURIComponent(fresh.url)}` : fresh.url;
    if (fresh.isHls && window.Hls?.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) playbackError();
      });
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(playRejection));
    } else if (!fresh.isHls || video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source;
      video.play().catch(playRejection);
    } else {
      message('Browser ini tidak mendukung HLS. Coba browser terbaru.');
    }
  } catch (error) {
    if (requestId !== playRequest) return;
    message(`Gagal memperbarui tautan: ${error.message}`);
    showAction('Coba lagi', () => playEpisode(currentEp));
  }
}

function playRejection(error) {
  if (error.name === 'NotAllowedError') {
    message('Video siap. Tekan tombol putar untuk memulai.');
    showAction('Putar video', () => video.play().catch(playRejection));
  }
  else if (error.name !== 'AbortError') playbackError();
}

function playbackError() {
  if (!transcoding) return fallbackToTranscode();
  message('Tautan video dari sumber gagal atau kedaluwarsa. Coba ambil ulang tautannya.');
  showAction('Coba lagi', () => playEpisode(currentEp));
}

function fallbackToTranscode() {
  if (transcoding || !currentDrama || !episodes[currentEp]) return;
  transcoding = true;
  message('Menyesuaikan format video untuk browser...');
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  video.src = `${API}/api/transcode?slug=${encodeURIComponent(currentDrama.slug)}&number=${episodes[currentEp].number}`;
  video.play().catch(playRejection);
}

video.addEventListener('loadeddata', () => {
  if (video.videoWidth) hideMessage();
  else if (!transcoding) fallbackToTranscode();
});
video.addEventListener('playing', () => { if (video.videoWidth) hideMessage(); });
video.addEventListener('error', playbackError);
video.addEventListener('ended', () => {
  if (currentEp + 1 < episodes.length) playEpisode(currentEp + 1);
});
$('prevBtn').onclick = () => {
  if (currentEp > 0) playEpisode(currentEp - 1);
};
$('nextBtn').onclick = () => {
  if (currentEp + 1 < episodes.length) playEpisode(currentEp + 1);
};
$('searchInput').oninput = event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCatalog(event.target.value.trim()), 250);
};

$('updateBtn').onclick = async () => {
  const button = $('updateBtn');
  button.disabled = true;
  $('updateStatus').textContent = 'Memeriksa sumber...';
  try {
    const query = $('searchInput').value.trim();
    const response = await fetch(`${API}/api/catalog/update?q=${encodeURIComponent(query)}`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    $('updateStatus').textContent = result.added ? `+${result.added} judul baru` : 'Sudah terbaru';
    await loadCatalog($('searchInput').value.trim());
  } catch (error) {
    $('updateStatus').textContent = `Update gagal: ${error.message}`;
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
