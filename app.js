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

function message(text) {
  $('screenMessage').textContent = text;
  $('screenMessage').classList.remove('hidden');
}

function hideMessage() {
  $('screenMessage').classList.add('hidden');
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
    $('catalogStats').textContent = query
      ? `${data.total.toLocaleString('id-ID')} ditampilkan`
      : `${data.total.toLocaleString('id-ID')} tersimpan`;
    renderCatalog();
    if (!currentDrama && catalog.length) selectDrama(catalog.length > 1 ? catalog[1] : catalog[0]);
    if (!catalog.length && !currentDrama) message('Tidak ada drama yang tersedia.');
  } catch (error) {
    if (requestId === catalogRequest) message(`Katalog gagal dimuat: ${error.message}`);
  }
}

async function selectDrama(drama) {
  const requestId = ++selection;
  currentDrama = drama;
  episodes = [];
  currentEp = 0;
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.load();
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
    if (episodes.length) playEpisode(0);
    else message('Episode belum tersedia untuk judul ini.');
  } catch (error) {
    if (requestId === selection) message(`Episode gagal dimuat: ${error.message}`);
  }
}

function renderEpisodes() {
  const strip = $('epStrip');
  strip.replaceChildren();
  $('episodeCount').textContent = `${episodes.length} episode`;
  $('prevBtn').disabled = !episodes.length || currentEp === 0;
  $('nextBtn').disabled = !episodes.length || currentEp === episodes.length - 1;
  for (let i = 0; i < episodes.length; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ep${i === currentEp ? ' active' : ''}`;
    button.setAttribute('aria-label', `Putar episode ${episodes[i].number || i + 1}`);
    const label = document.createElement('span');
    label.textContent = 'EPISODE';
    button.append(label, String(episodes[i].number || i + 1));
    button.onclick = () => playEpisode(i);
    strip.append(button);
  }
}

function playEpisode(index) {
  if (index < 0 || index >= episodes.length) return;
  currentEp = index;
  const episode = episodes[index];
  $('episodeBadge').textContent = `Episode ${episode.number || index + 1}`;
  renderEpisodes();
  message('Menyiapkan video...');
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.load();
  const source = episode.isHls ? `${API}/proxy?url=${encodeURIComponent(episode.url)}` : episode.url;
  if (episode.isHls && window.Hls?.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) message('Video tidak tersedia dari sumber saat ini. Pilih episode atau judul lain.');
    });
    hls.loadSource(source);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => hideMessage()));
  } else if (!episode.isHls || video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = source;
    video.play().catch(() => hideMessage());
  } else {
    message('Browser ini tidak mendukung HLS. Coba browser terbaru.');
  }
}

video.addEventListener('loadeddata', hideMessage);
video.addEventListener('playing', hideMessage);
video.addEventListener('error', () => message('Video gagal diputar. Pilih episode atau judul lain.'));
video.addEventListener('ended', () => playEpisode(currentEp + 1));
$('prevBtn').onclick = () => playEpisode(currentEp - 1);
$('nextBtn').onclick = () => playEpisode(currentEp + 1);
$('searchInput').oninput = event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCatalog(event.target.value.trim()), 250);
};

loadCatalog();
