const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8902;
const catalogPath = path.join(__dirname, 'catalog.json');
let catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
let lastUpdated = fs.statSync(catalogPath).mtime.toISOString();
let lastAdded = 0;
let syncPromise = null;
const sourceContexts = new Map();
const recentSources = new Map();
const COOKIE = `nd_ck=${process.env.ND_CK || crypto.randomBytes(12).toString('hex')}; nd_lang=id-ID`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CDN = 'https://cdn.narto-drama.com';

function isAllowedMediaUrl(target) {
  return target.protocol === 'https:' && (target.hostname === 'narto-drama.com' || target.hostname.endsWith('.narto-drama.com'));
}

function request(target, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { headers, timeout: 20000 }, upstream => {
      if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location && redirects < 3) {
        upstream.resume();
        return resolve(request(new URL(upstream.headers.location, url).href, headers, redirects + 1));
      }
      resolve(upstream);
    });
    req.on('timeout', () => req.destroy(new Error('Upstream timeout')));
    req.on('error', reject);
  });
}

async function getEpisodes(slug) {
  const upstream = await request(`https://narto-drama.com/detail/watch/${encodeURIComponent(slug)}/1?lang=id-ID`, {
    Cookie: COOKIE, 'User-Agent': UA, Accept: 'text/html'
  });
  let html = '';
  for await (const chunk of upstream) html += chunk;
  if (upstream.statusCode !== 200) throw new Error(`Sumber episode HTTP ${upstream.statusCode}`);
  const match = html.match(/episodeItemsRaw\s*=\s*(\[.*?\]);/s);
  if (!match) throw new Error('Daftar episode tidak ditemukan');
  const edgeRaw = html.match(/const refreshSourceEdgeBase = ("(?:\\.|[^"])*")/);
  sourceContexts.set(slug, {
    token: html.match(/const refreshSourceContextToken = "([^"]*)"/)?.[1] || '',
    edge: edgeRaw ? JSON.parse(edgeRaw[1]) : '',
    useEdge: /const refreshSourceUseEdge = true/.test(html),
    directEdge: /const refreshSourceCandyjarEdgeDirect = true/.test(html),
    fetchedAt: Date.now()
  });
  return JSON.parse(match[1]).map(ep => ({
    number: ep.number || ep.route_episode_number,
    title: ep.title || `Episode ${ep.number}`,
    url: ep.is_playable ? (ep.direct_play_url || ep.play_url || '') : '',
    isHls: ep.direct_play_url ? ep.direct_play_is_hls !== false : /\.m3u8(?:\?|$)/.test(ep.play_url || ''),
    thumb: ep.thumb_url || ''
  }));
}

async function requestEpisodeSource(context, slug, number, options = {}) {
  const route = `/detail/watch/${slug}/${number}/refresh-source`;
  const base = context.edge || 'https://narto-drama.com';
  const prefix = context.useEdge ? '/e/rs' : '';
  const target = new URL(`${prefix}${route}`, context.useEdge || context.directEdge ? base : 'https://narto-drama.com');
  const params = { lang: 'id-ID', rs_ctx: context.token, force: '1' };
  if (options.noCache) params.no_cache = '1';
  if (options.forceEdge) params.force_edge = '1';
  target.search = new URLSearchParams(params).toString();
  const upstream = await request(target.href, { Cookie: COOKIE, 'User-Agent': UA, Accept: 'application/json' });
  let body = '';
  for await (const chunk of upstream) body += chunk;
  if (upstream.statusCode !== 200) throw new Error(`Pembaruan tautan HTTP ${upstream.statusCode}`);
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error('Pembaruan tautan mengirim respons rusak'); }
  const url = data.direct_play_url || data.play_url || '';
  if (!data.ok || !url) throw new Error('Sumber belum menyediakan tautan video baru');
  return { url, isHls: data.direct_play_url ? data.direct_play_is_hls !== false : /\.m3u8(?:\?|$)/.test(data.play_url || '') };
}

async function refreshEpisode(slug, number, options = {}) {
  let context = sourceContexts.get(slug);
  if (!context || Date.now() - context.fetchedAt > 5 * 60 * 1000) {
    await getEpisodes(slug);
    context = sourceContexts.get(slug);
  }
  const attempts = options.noCache || options.forceEdge
    ? [options]
    : [{}, { noCache: true }, { noCache: true, forceEdge: true }];
  let lastError;
  for (const attempt of attempts) {
    try {
      const source = await requestEpisodeSource(context, slug, number, attempt);
      recentSources.set(`${slug}:${number}`, { ...source, fetchedAt: Date.now() });
      return source;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function searchCatalog(query) {
  const upstream = await request(`https://narto-drama.com/search?q=${encodeURIComponent(query)}&lang=id-ID`, {
    Cookie: COOKIE, 'User-Agent': UA, Accept: 'text/html'
  });
  let html = '';
  for await (const chunk of upstream) html += chunk;
  if (upstream.statusCode !== 200) throw new Error(`Pencarian sumber HTTP ${upstream.statusCode}`);
  return extractCatalog(html);
}

function extractCatalog(html) {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g);
  for (const script of scripts) {
    const data = JSON.parse(script[1]);
    if (data['@type'] !== 'CollectionPage') continue;
    return (data.mainEntity?.itemListElement || []).map(item => {
      const watch = new URL(item.url);
      return {
        slug: watch.pathname.split('/detail/watch/')[1],
        title: item.name,
        poster: new URL(item.image, 'https://narto-drama.com').href
      };
    }).filter(item => item.slug && item.title);
  }
  throw new Error('Hasil pencarian tidak ditemukan pada halaman sumber');
}

function updateCatalog(query = '') {
  if (syncPromise) return query ? syncPromise.then(() => updateCatalog(query)) : syncPromise;
  syncPromise = (async () => {
    const latest = [];
    for (let page = 1; page <= 2; page++) {
      const upstream = await request(`https://narto-drama.com/?lang=id-ID&page=${page}`, {
        Cookie: COOKIE, 'User-Agent': UA, Accept: 'text/html'
      });
      let html = '';
      for await (const chunk of upstream) html += chunk;
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
  const target = value.startsWith('/nd1/') ? new URL(value, CDN) : new URL(value, source);
  if (!isAllowedMediaUrl(target)) return value;
  return `/proxy?url=${encodeURIComponent(target.href)}`;
}

function rewritePlaylist(body, source) {
  return body.split('\n').map(line => {
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${proxyUrl(value, source)}"`);
    return line.trim() ? proxyUrl(line.trim(), source) : line;
  }).join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/catalog') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
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
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) { res.writeHead(400); return res.end('Invalid slug'); }
      const episodes = await getEpisodes(slug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ slug, episodes }));
    }

    if (url.pathname === '/api/episode-source') {
      const slug = url.searchParams.get('slug');
      const number = Number(url.searchParams.get('number'));
      if (!slug || !/^[a-z0-9-]+$/.test(slug) || !Number.isInteger(number) || number < 1) { res.writeHead(400); return res.end('Invalid episode'); }
      const source = await refreshEpisode(slug, number);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(source));
    }

    if (url.pathname === '/api/transcode') {
      const slug = url.searchParams.get('slug');
      const number = Number(url.searchParams.get('number'));
      if (!slug || !/^[a-z0-9-]+$/.test(slug) || !Number.isInteger(number) || number < 1) { res.writeHead(400); return res.end('Invalid episode'); }
      const cached = recentSources.get(`${slug}:${number}`);
      let source = cached && Date.now() - cached.fetchedAt < 60 * 1000 ? cached : await refreshEpisode(slug, number);
      const probe = await request(source.url, { 'User-Agent': UA, Range: 'bytes=0-0' });
      const sourceAvailable = probe.statusCode === 200 || probe.statusCode === 206;
      probe.destroy();
      if (!sourceAvailable) source = await refreshEpisode(slug, number, { noCache: true, forceEdge: true });
      const ffmpeg = spawn('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', source.url,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      ffmpeg.stderr.resume();
      ffmpeg.on('error', () => { if (!res.destroyed) res.destroy(); });
      res.on('close', () => ffmpeg.kill('SIGKILL'));
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
      return ffmpeg.stdout.pipe(res);
    }

    if (url.pathname === '/proxy') {
      const target = new URL(url.searchParams.get('url'));
      if (!isAllowedMediaUrl(target)) { res.writeHead(400); return res.end('Invalid media URL'); }
      const headers = { 'User-Agent': UA };
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await request(target.href, headers);
      if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
        upstream.resume();
        res.writeHead(upstream.statusCode || 502);
        return res.end(`Media source HTTP ${upstream.statusCode}`);
      }
      const isPlaylist = target.pathname.endsWith('.m3u8') || (upstream.headers['content-type'] || '').includes('mpegurl');
      if (isPlaylist) {
        let body = '';
        for await (const chunk of upstream) body += chunk;
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        return res.end(rewritePlaylist(body, target.href));
      }
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
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
