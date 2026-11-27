const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const PORT = 8902;
const catalogPath = path.join(__dirname, 'catalog.json');
const NARTO_ORIGIN = 'https://narto-drama.com';
const CDN = 'https://cdn.narto-drama.com';
const COOKIE = `nd_ck=${process.env.ND_CK || crypto.randomBytes(12).toString('hex')}; nd_lang=id-ID`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE_ALLOWED_HOSTS = new Set([
  'narto-drama.com',
  'nartodrama.com',
  'nartodrama-api.online',
  'api.sansekai.my.id'
]);
const allowedHosts = new Set(BASE_ALLOWED_HOSTS);
const sourceContexts = new Map();
const recentSources = new Map();

function normalizeCatalogItem(item) {
  if (!item || !item.slug || !item.title) return null;
  let poster = item.poster || '';
  if (poster) {
    try { poster = new URL(poster, NARTO_ORIGIN).href; }
    catch { poster = ''; }
  }
  return { slug: item.slug, title: item.title, poster };
}

let catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).map(normalizeCatalogItem).filter(Boolean);
let lastUpdated = fs.statSync(catalogPath).mtime.toISOString();
let lastAdded = 0;
let syncPromise = null;

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const ipType = net.isIP(host);
  if (ipType === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  } else if (ipType === 6) {
    if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  }
  return false;
}

function registerMediaUrl(rawUrl, base = NARTO_ORIGIN) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, base);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    const host = parsed.hostname.toLowerCase();
    if (isPrivateHost(host)) return '';
    if (!allowedHosts.has(host)) {
      if (allowedHosts.size >= 1500) {
        const first = allowedHosts.values().next().value;
        if (!BASE_ALLOWED_HOSTS.has(first)) allowedHosts.delete(first);
      }
      allowedHosts.add(host);
    }
    return parsed.href;
  } catch {
    return '';
  }
}

function isAllowedMediaUrl(target) {
  if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) return false;
  const host = target.hostname.toLowerCase();
  if (isPrivateHost(host)) return false;
  if (allowedHosts.has(host)) return true;
  for (const suffix of ['narto-drama.com', 'nartodrama.com', 'nartodrama-api.online']) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function request(target, headers = {}, redirects = 0, method = 'GET') {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers, timeout: 20000 }, upstream => {
      if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location && redirects < 4) {
        const nextUrl = new URL(upstream.headers.location, url);
        upstream.resume();
        if (isPrivateHost(nextUrl.hostname)) return reject(new Error('Blocked redirect host'));
        registerMediaUrl(nextUrl.href);
        return resolve(request(nextUrl.href, headers, redirects + 1, method));
      }
      resolve(upstream);
    });
    req.on('timeout', () => req.destroy(new Error('Upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function toDramaBoxDecryptBridge(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.includes('/api/dramabox/decrypt-stream?url=')) return raw;
  if (!lower.includes('.encrypt.mp4')) return raw;
  return `https://api.sansekai.my.id/api/dramabox/decrypt-stream?url=${encodeURIComponent(raw)}`;
}

function looksLikeHlsSource(rawUrl, provider = '', isHlsHint = false) {
  if (isHlsHint === true) return true;
  const source = String(rawUrl || '').trim();
  if (!source) return false;
  const lower = source.toLowerCase();
  if (lower.includes('.m3u8') || /[?&]mh=1(?:&|$)/.test(lower) || lower.includes('/e/m/')) return true;
  try {
    const parsed = new URL(source, NARTO_ORIGIN);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const nested = (parsed.searchParams.get('url') || '').trim().toLowerCase();
    if (nested && (nested.includes('.m3u8') || /[?&]mh=1(?:&|$)/.test(nested))) return true;
    if (host === 'dramabox.goodbos.online' && (pathname === '/proxy' || pathname.startsWith('/video/'))) return true;
    if (provider === 'dramabox' && pathname.startsWith('/video/')) return true;
  } catch {}
  return false;
}

function normalizeSubtitles(data, baseOrigin = NARTO_ORIGIN) {
  const seen = new Map();
  const list = Array.isArray(data?.multi_subtitles) ? data.multi_subtitles : [];
  for (const item of list) {
    const url = registerMediaUrl(item?.subtitle_url, baseOrigin);
    if (!url) continue;
    const code = String(item?.language_code || '').trim();
    const key = code.toLowerCase() || url;
    if (!seen.has(key)) {
      seen.set(key, {
        code: code || 'sub',
        label: String(item?.label || code || 'Subtitle').trim(),
        url,
        isDefault: item?.is_default === true
      });
    }
  }
  const directSub = registerMediaUrl(data?.subtitle_url, baseOrigin) || registerMediaUrl(data?.direct_subtitle_url, baseOrigin);
  const selectedCode = String(data?.selected_subtitle_language || '').trim().toLowerCase();
  const tracks = Array.from(seen.values());
  let defaultUrl = directSub;
  if (!defaultUrl && tracks.length) {
    const match = tracks.find(t => t.code.toLowerCase() === selectedCode)
      || tracks.find(t => t.code.toLowerCase().startsWith('id'))
      || tracks.find(t => t.isDefault)
      || tracks[0];
    defaultUrl = match.url;
  } else if (directSub && !tracks.length) {
    tracks.push({ code: selectedCode || 'id-ID', label: 'Subtitle', url: directSub, isDefault: true });
  }
  return { subtitleUrl: defaultUrl, subtitles: tracks };
}

function normalizeResolutions(rawList, provider, baseOrigin = NARTO_ORIGIN) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    let url = String(item?.stream_url || '').trim();
    if (provider === 'dramabox') url = toDramaBoxDecryptBridge(url);
    url = registerMediaUrl(url, baseOrigin);
    if (!url) continue;
    out.push({
      label: String(item?.label || (item?.resolution ? `${item.resolution}p` : 'Auto')).trim(),
      codec: String(item?.codec || '').toLowerCase(),
      url,
      isHls: looksLikeHlsSource(url, provider, false),
      isDefault: item?.is_default === true
    });
  }
  return out;
}

function buildEpisodeSource(data, provider = '', baseOrigin = NARTO_ORIGIN) {
  const normProvider = String(provider || '').trim().toLowerCase();
  let playUrl = String(data?.play_url || '').trim();
  let directPlayUrl = String(data?.direct_play_url || '').trim();
  if (normProvider === 'dramabox') {
    playUrl = toDramaBoxDecryptBridge(playUrl);
    directPlayUrl = toDramaBoxDecryptBridge(directPlayUrl);
  }
  playUrl = registerMediaUrl(playUrl, baseOrigin);
  directPlayUrl = registerMediaUrl(directPlayUrl, baseOrigin);

  const directIsLocal = data?.direct_play_is_local === true;
  const directIsHls = data?.direct_play_is_hls === true;
  const prefetchIsHls = data?.browser_prefetch_mode === 'hls';

  let url = '';
  let fallbackUrl = '';
  if (normProvider === 'dramabox' && directPlayUrl && !directIsLocal) {
    url = directPlayUrl;
    if (playUrl && playUrl !== directPlayUrl) fallbackUrl = playUrl;
  } else {
    url = playUrl || directPlayUrl;
    if (playUrl && directPlayUrl && directPlayUrl !== playUrl) fallbackUrl = directPlayUrl;
  }

  const isHlsFor = candidate => {
    if (!candidate) return false;
    if (candidate === directPlayUrl && directIsHls) return true;
    if (candidate === playUrl && directPlayUrl === playUrl && directIsHls) return true;
    return looksLikeHlsSource(candidate, normProvider, !playUrl ? directIsHls : (prefetchIsHls && !candidate.toLowerCase().includes('.mp4')));
  };

  const audioUrl = registerMediaUrl(data?.direct_audio_url, baseOrigin);
  const { subtitleUrl, subtitles } = normalizeSubtitles(data, baseOrigin);
  const resolutions = normalizeResolutions(data?.multi_resolutions, normProvider, baseOrigin);

  return {
    url,
    isHls: isHlsFor(url),
    fallbackUrl,
    fallbackIsHls: isHlsFor(fallbackUrl),
    audioUrl,
    subtitleUrl,
    subtitles,
    resolutions,
    hasDrm: Boolean(data?.drm && (data.drm.widevine?.dash_url || data.drm.fairplay?.hls_url)),
    provider: normProvider
  };
}

async function getEpisodes(slug) {
  const upstream = await request(`${NARTO_ORIGIN}/detail/watch/${encodeURIComponent(slug)}/1?lang=id-ID`, {
    Cookie: COOKIE, 'User-Agent': UA, Accept: 'text/html'
  });
  const html = (await readStream(upstream)).toString('utf8');
  if (upstream.statusCode !== 200) throw new Error(`Sumber episode HTTP ${upstream.statusCode}`);
  const match = html.match(/episodeItemsRaw\s*=\s*(\[.*?\]);/s);
  if (!match) throw new Error('Daftar episode tidak ditemukan');

  const provider = html.match(/const movieSourceAppName\s*=\s*"([^"]*)"/)?.[1]?.toLowerCase() || '';
  const edgeRaw = html.match(/const refreshSourceEdgeBase = ("(?:\\.|[^"])*")/);
  const edge = edgeRaw ? JSON.parse(edgeRaw[1]) : '';
  const edgeOrigin = registerMediaUrl(edge) ? new URL(edge).origin : NARTO_ORIGIN;
  const rawEpisodes = JSON.parse(match[1]);
  const initialSources = new Map();

  const episodes = rawEpisodes.map((ep, index) => {
    const number = Number(ep.number || ep.route_episode_number || index + 1);
    const routeNumber = Number(ep.route_episode_number || ep.number || index + 1);
    const initial = buildEpisodeSource(ep, provider, edgeOrigin);
    if (initial.url || initial.hasDrm) initialSources.set(routeNumber, initial);
    const thumb = registerMediaUrl(ep.thumb_url, NARTO_ORIGIN);
    return {
      number,
      routeNumber,
      title: ep.title || `Episode ${number}`,
      url: initial.url,
      isHls: initial.isHls,
      thumb
    };
  });

  sourceContexts.set(slug, {
    provider,
    token: html.match(/const refreshSourceContextToken = "([^"]*)"/)?.[1] || '',
    edge,
    useEdge: /const refreshSourceUseEdge = true/.test(html),
    directEdge: /const refreshSourceCandyjarEdgeDirect = true/.test(html),
    initialSources,
    fetchedAt: Date.now()
  });

  return episodes;
}

function buildRefreshTargets(context, slug, number, options = {}) {
  const route = `/detail/watch/${encodeURIComponent(slug)}/${number}/refresh-source`;
  const params = new URLSearchParams({ lang: 'id-ID', rs_ctx: context.token, force: '1' });
  if (options.noCache) params.set('no_cache', '1');
  if (options.forceEdge) params.set('force_edge', '1');
  const query = params.toString();

  const targets = [];
  const edgeBase = context.edge || NARTO_ORIGIN;
  if (context.useEdge) {
    targets.push({ href: `${edgeBase.replace(/\/+$/, '')}/e/rs${route}?${query}`, isEdge: true });
  } else if (context.directEdge && context.edge) {
    targets.push({ href: `${edgeBase.replace(/\/+$/, '')}${route}?${query}`, isEdge: true });
  } else {
    targets.push({ href: `${NARTO_ORIGIN}${route}?${query}`, isEdge: false });
    if (context.edge) targets.push({ href: `${edgeBase.replace(/\/+$/, '')}/e/rs${route}?${query}`, isEdge: true });
  }
  return targets;
}

async function requestEpisodeSource(context, slug, number, options = {}) {
  const targets = buildRefreshTargets(context, slug, number, options);
  let lastError = new Error('Pembaruan tautan gagal');

  for (const target of targets) {
    for (let retry = 0; retry < 2; retry++) {
      const headers = target.isEdge
        ? { 'User-Agent': UA, Accept: 'application/json', Origin: NARTO_ORIGIN, Referer: `${NARTO_ORIGIN}/` }
        : { Cookie: COOKIE, 'User-Agent': UA, Accept: 'application/json', Referer: `${NARTO_ORIGIN}/detail/watch/${encodeURIComponent(slug)}/${number}?lang=id-ID` };
      try {
        const upstream = await request(target.href, headers);
        const body = (await readStream(upstream)).toString('utf8');
        let parsedErr = null;
        if (upstream.statusCode !== 200) {
          try { parsedErr = JSON.parse(body); } catch {}
        }
        const retryable = upstream.statusCode === 429 || upstream.statusCode >= 500 || parsedErr?.retryable === true || parsedErr?.message === 'stream_temporarily_unavailable';
        if (retryable) {
          let waitMs = 450 * (retry + 1);
          if (parsedErr?.retry_after_seconds > 0) waitMs = Math.min(2500, Number(parsedErr.retry_after_seconds) * 1000);
          lastError = new Error(parsedErr?.message ? `Sumber: ${parsedErr.message} (HTTP ${upstream.statusCode})` : `Pembaruan tautan HTTP ${upstream.statusCode}`);
          if (retry === 0) { await new Promise(r => setTimeout(r, waitMs)); continue; }
          break;
        }
        if (upstream.statusCode !== 200) {
          lastError = new Error(parsedErr?.message ? `Sumber: ${parsedErr.message} (HTTP ${upstream.statusCode})` : `Pembaruan tautan HTTP ${upstream.statusCode}`);
          break;
        }
        let data;
        try { data = JSON.parse(body); }
        catch { lastError = new Error('Pembaruan tautan mengirim respons rusak'); break; }
        const built = buildEpisodeSource(data, context.provider, target.isEdge ? (context.edge || NARTO_ORIGIN) : NARTO_ORIGIN);
        if (!data.ok || (!built.url && !built.hasDrm)) {
          lastError = new Error(data.message || 'Sumber belum menyediakan tautan video baru');
          break;
        }
        return built;
      } catch (err) {
        lastError = err;
        if (retry === 0) await new Promise(r => setTimeout(r, 350));
      }
    }
  }
  throw lastError;
}

async function refreshEpisode(slug, number, options = {}) {
  let context = sourceContexts.get(slug);
  if (!context || Date.now() - context.fetchedAt > 5 * 60 * 1000) {
    await getEpisodes(slug);
    context = sourceContexts.get(slug);
  }
  const attempts = options.fresh
    ? [{ noCache: true }, { noCache: true, forceEdge: true }]
    : (options.noCache || options.forceEdge
      ? [options]
      : [{}, { noCache: true }, { noCache: true, forceEdge: true }]);

  let lastError;
  let tokenRefreshed = false;
  for (const attempt of attempts) {
    try {
      const source = await requestEpisodeSource(context, slug, number, attempt);
      if (source.url) recentSources.set(`${slug}:${number}`, { ...source, fetchedAt: Date.now() });
      return source;
    } catch (error) {
      lastError = error;
      if (!tokenRefreshed && /HTTP (401|403)/.test(error.message)) {
        tokenRefreshed = true;
        await getEpisodes(slug);
        context = sourceContexts.get(slug);
      }
    }
  }

  const fallbackInitial = context?.initialSources?.get(number);
  if (fallbackInitial?.url) {
    recentSources.set(`${slug}:${number}`, { ...fallbackInitial, fetchedAt: Date.now() });
    return fallbackInitial;
  }
  throw lastError;
}

async function searchCatalog(query) {
  const upstream = await request(`${NARTO_ORIGIN}/search?q=${encodeURIComponent(query)}&lang=id-ID`, {
    Cookie: COOKIE, 'User-Agent': UA, Accept: 'text/html'
  });
  const html = (await readStream(upstream)).toString('utf8');
  if (upstream.statusCode !== 200) throw new Error(`Pencarian sumber HTTP ${upstream.statusCode}`);
  return extractCatalog(html);
}

function extractCatalog(html) {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g);
  for (const script of scripts) {
    const data = JSON.parse(script[1]);
    if (data['@type'] !== 'CollectionPage') continue;
    return (data.mainEntity?.itemListElement || []).map(item => {
      const watch = new URL(item.url, NARTO_ORIGIN);
      return normalizeCatalogItem({
        slug: watch.pathname.split('/detail/watch/')[1],
        title: item.name,
        poster: item.image
      });
    }).filter(Boolean);
  }
  throw new Error('Hasil pencarian tidak ditemukan pada halaman sumber');
}

function updateCatalog(query = '') {
  if (syncPromise) return query ? syncPromise.then(() => updateCatalog(query)) : syncPromise;
  syncPromise = (async () => {
    const latest = [];
    for (let page = 1; page <= 3; page++) {
      const upstream = await request(`${NARTO_ORIGIN}/?lang=id-ID&page=${page}`, {
        Cookie: COOKIE, 'User-Agent': UA, Accept: 'text/html'
      });
      const html = (await readStream(upstream)).toString('utf8');
      if (upstream.statusCode !== 200) throw new Error(`Katalog sumber HTTP ${upstream.statusCode}`);
      latest.push(...extractCatalog(html));
      if (!html.includes('rel="next"')) break;
    }
    if (query) latest.push(...await searchCatalog(query));
    if (!latest.length) throw new Error('Halaman sumber tidak memuat judul');
    const existing = new Set(catalog.map(item => item.slug));
    const added = latest.filter(item => {
      if (existing.has(item.slug)) return false;
      existing.add(item.slug);
      return true;
    });
    const merged = [...added, ...catalog];
    const tempPath = `${catalogPath}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`);
    await fs.promises.rename(tempPath, catalogPath);
    catalog = merged;
    lastUpdated = new Date().toISOString();
    lastAdded = added.length;
    return { total: catalog.length, added: lastAdded, checked: latest.length, lastUpdated };
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

function proxyUrl(value, source) {
  let target;
  if (value.startsWith('/nd1/') && !new URL(source).hostname.includes('cdn.narto-drama.com')) {
    target = new URL(value, CDN);
  } else {
    target = new URL(value, source);
  }
  const href = registerMediaUrl(target.href);
  if (!href) return value;
  return `/proxy?url=${encodeURIComponent(href)}`;
}

function rewritePlaylist(body, source) {
  return body.split('\n').map(line => {
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${proxyUrl(value, source)}"`);
    return line.trim() ? proxyUrl(line.trim(), source) : line;
  }).join('\n');
}

function srtToVtt(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return 'WEBVTT\n\n';
  if (/^WEBVTT\b/i.test(clean)) return `${clean}\n`;
  const converted = clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${converted}\n`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/catalog') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 60));
      const items = q ? await searchCatalog(q) : catalog;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ total: items.length, page, items: items.slice((page - 1) * limit, page * limit) }));
    }

    if (url.pathname === '/api/catalog/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ total: catalog.length, lastUpdated, lastAdded, updating: Boolean(syncPromise) }));
    }

    if (url.pathname === '/api/catalog/update' && req.method === 'POST') {
      const result = await updateCatalog((url.searchParams.get('q') || '').trim().slice(0, 100));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === '/api/episodes') {
      const slug = url.searchParams.get('slug');
      if (!slug || !/^[a-zA-Z0-9._-]+$/.test(slug)) { res.writeHead(400); return res.end('Invalid slug'); }
      const episodes = await getEpisodes(slug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ slug, episodes }));
    }

    if (url.pathname === '/api/episode-source') {
      const slug = url.searchParams.get('slug');
      const number = Number(url.searchParams.get('number'));
      const fresh = url.searchParams.get('fresh') === '1';
      if (!slug || !/^[a-zA-Z0-9._-]+$/.test(slug) || !Number.isInteger(number) || number < 1) {
        res.writeHead(400); return res.end('Invalid episode');
      }
      const source = await refreshEpisode(slug, number, { fresh });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(source));
    }

    if (url.pathname === '/api/transcode') {
      const slug = url.searchParams.get('slug');
      const number = Number(url.searchParams.get('number'));
      const variant = url.searchParams.get('variant') || 'primary';
      if (!slug || !/^[a-zA-Z0-9._-]+$/.test(slug) || !Number.isInteger(number) || number < 1) {
        res.writeHead(400); return res.end('Invalid episode');
      }
      const cached = recentSources.get(`${slug}:${number}`);
      let source = cached && Date.now() - cached.fetchedAt < 60 * 1000 ? cached : await refreshEpisode(slug, number);
      let inputUrl = (variant === 'fallback' && source.fallbackUrl) ? source.fallbackUrl : source.url;
      if (!inputUrl) { res.writeHead(404); return res.end('No media source'); }

      let probe = await request(inputUrl, { 'User-Agent': UA, Range: 'bytes=0-0' });
      let sourceAvailable = probe.statusCode === 200 || probe.statusCode === 206;
      let probeCt = (probe.headers['content-type'] || '').toLowerCase();
      probe.destroy();
      if (!sourceAvailable) {
        source = await refreshEpisode(slug, number, { noCache: true, forceEdge: true });
        inputUrl = (variant === 'fallback' && source.fallbackUrl) ? source.fallbackUrl : source.url;
        probe = await request(inputUrl, { 'User-Agent': UA, Range: 'bytes=0-0' });
        probeCt = (probe.headers['content-type'] || '').toLowerCase();
        probe.destroy();
      }

      const isHlsInput = ((variant === 'fallback' && source.fallbackUrl) ? source.fallbackIsHls : source.isHls)
        || probeCt.includes('mpegurl');
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-user_agent', UA];
      if (isHlsInput) {
        args.push('-allowed_extensions', 'ALL', '-extension_picky', '0');
      }
      args.push('-i', inputUrl);
      if (source.audioUrl) {
        args.push('-user_agent', UA, '-i', source.audioUrl, '-map', '0:v:0', '-map', '1:a:0');
      }
      args.push(
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'
      );

      const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      ffmpeg.stderr.resume();
      ffmpeg.on('error', () => { if (!res.destroyed) res.destroy(); });
      const stopFfmpeg = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); };
      req.on('close', stopFfmpeg);
      res.on('close', stopFfmpeg);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
      return ffmpeg.stdout.pipe(res);
    }

    if (url.pathname === '/proxy') {
      const targetParam = url.searchParams.get('url');
      if (!targetParam) { res.writeHead(400); return res.end('Missing url'); }
      const target = new URL(targetParam);
      if (!isAllowedMediaUrl(target)) { res.writeHead(400); return res.end('Invalid media URL'); }

      const isSub = url.searchParams.get('sub') === '1';
      const headers = { 'User-Agent': UA };
      if (!isSub && req.headers.range) headers.Range = req.headers.range;

      const upstream = await request(target.href, headers, 0, req.method === 'HEAD' ? 'HEAD' : 'GET');
      if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
        upstream.resume();
        res.writeHead(upstream.statusCode || 502);
        return res.end(`Media source HTTP ${upstream.statusCode}`);
      }

      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      if (isSub || target.pathname.endsWith('.srt') || target.pathname.endsWith('.vtt') || ct.includes('text/vtt') || ct.includes('subrip')) {
        const rawText = (await readStream(upstream)).toString('utf8');
        res.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        });
        return res.end(srtToVtt(rawText));
      }

      const isPlaylist = target.pathname.endsWith('.m3u8')
        || target.pathname.includes('/e/m/')
        || /[?&]mh=1(?:&|$)/.test(target.search)
        || ct.includes('mpegurl');

      if (isPlaylist) {
        const body = (await readStream(upstream)).toString('utf8');
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        });
        return res.end(rewritePlaylist(body, target.href));
      }

      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}),
        ...(upstream.headers['content-range'] ? { 'Content-Range': upstream.headers['content-range'] } : {}),
        ...(upstream.headers['accept-ranges'] ? { 'Accept-Ranges': upstream.headers['accept-ranges'] } : {})
      });
      return upstream.pipe(res);
    }

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'test.html'].includes(file)) { res.writeHead(404); return res.end('Not found'); }
    const full = path.join(__dirname, file);
    const type = file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    return fs.createReadStream(full).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Narto player http://localhost:${PORT} (${catalog.length} dramas)`);
  updateCatalog().catch(error => console.error(`Catalog update failed: ${error.message}`));
});
setInterval(() => updateCatalog().catch(error => console.error(`Catalog update failed: ${error.message}`)), 60 * 60 * 1000);
