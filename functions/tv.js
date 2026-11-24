// Cloudflare Pages Function: GET /tv
// 实时抓取聚玩盒子(juwanhezi.com)每日测速极速源(紫色)，合并为单文件 TVBox/misaTV 配置。
// 边缘缓存 1 小时：导入链接永远指向 /tv，无需每天重新发布网站。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LIST_URL = 'https://www.juwanhezi.com/jsonlist';
const AJAX_URL = 'https://www.juwanhezi.com/ajax/load';
const GH_PROXY = 'https://gh-proxy.com/';

function hexToBuf(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
function bufToText(buf) { return new TextDecoder('utf-8').decode(buf); }

async function decrypt2423(text) {
  // 布局: 2423 + key(hex) + 2324 + 密文(hex) + 26位IV(hex)
  const h = text.replace(/\s+/g, '');
  const i = h.indexOf('2324', 4);
  if (!h.startsWith('2423') || i < 0) throw new Error('非2423格式');
  const keyAscii = bufToText(hexToBuf(h.slice(4, i))).padEnd(16, '0').slice(0, 16);
  const ivRaw = hexToBuf(h.slice(-26));                    // 13 字节
  const iv = new Uint8Array(16).fill(0x30);                // 右补 '0' 字符(0x30)，不是零字节！
  iv.set(ivRaw);
  const key = new TextEncoder().encode(keyAscii);
  const ct = hexToBuf(h.slice(i + 4, -26));
  const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']), ct);
  // WebCrypto 自动剥 PKCS7
  return bufToText(new Uint8Array(pt));
}

function stripComments(s) {
  let out = '', i = 0, instr = false, esc = false;
  while (i < s.length) {
    const c = s[i];
    if (instr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') instr = false;
      i++; continue;
    }
    if (c === '"') { instr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; continue; }
    if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2; continue; }
    out += c; i++;
  }
  return out;
}

function escapeCtrlInStrings(s) {
  let out = '', instr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], code = s.charCodeAt(i);
    if (instr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { instr = false; out += ch; continue; }
      if (code < 0x20) {
        out += code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t' : '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch; continue;
    }
    if (ch === '"') { instr = true; out += ch; continue; }
    out += ch;
  }
  return out;
}

function parseLoose(t) {
  let s = stripComments(t);
  s = s.replace(/^[ \t]*#.*$/gm, '');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = escapeCtrlInStrings(s);
  return JSON.parse(s);
}

function decodeConfig(text) {
  const t = text.trim();
  if (/^[0-9a-fA-F\s]+$/.test(t.slice(0, 100)) && t.replace(/\s+/g, '').startsWith('2423')) {
    return parseLoose(decrypt2423(t));  // await 由外层处理
  }
  return null;
}

async function fetchText(url, timeoutMs = 15000) {
  const u = encodeURI(url);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs), cf: { cacheTtl: 900 } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    if ((url.includes('raw.githubusercontent.com') || url.includes('gitlab.com')) && !url.startsWith(GH_PROXY)) {
      const r2 = await fetch(GH_PROXY + encodeURI(url), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r2.ok) throw new Error('HTTP ' + r2.status);
      return await r2.text();
    }
    throw e;
  }
}

async function decodeSource(url) {
  const t = (await fetchText(url)).trim();
  // 2423 加密
  if (/^[0-9a-fA-F\s]+$/.test(t.slice(0, 100)) && t.replace(/\s+/g, '').startsWith('2423')) {
    return { cfg: parseLoose(await decrypt2423(t)) };
  }
  // 图片隐写 base64/**
  const m = t.match(/[A-Za-z0-9+/=\s]{8}\*\*([A-Za-z0-9+/=\s]{100,})/);
  if (m) {
    try { return { cfg: JSON.parse(atob(m[1].replace(/\s+/g, ''))) }; } catch (e) { /* 继续 */ }
  }
  // 明文容错
  return { cfg: parseLoose(t) };
}

function absUrl(u, base) {
  if (typeof u !== 'string' || !u) return u;
  u = u.trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  const root = base.match(/^(https?:\/\/[^/]+)/)[1];
  const dirn = base.slice(0, base.lastIndexOf('/') + 1);
  if (u.startsWith('/')) return root + u;
  let rel = u, d = dirn;
  while (rel.startsWith('../')) { d = d.slice(0, d.replace(/\/$/, '').lastIndexOf('/') + 1); rel = rel.slice(3); }
  while (rel.startsWith('./')) rel = rel.slice(2);
  return d + rel;
}

async function gatherList() {
  const pages = [await fetchText(LIST_URL)];
  for (let p = 2; p <= 8; p++) {
    try {
      const r = await fetch(AJAX_URL, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': LIST_URL },
        body: `page=source&type=one&action=load&paged=${p}&append=list-home`,
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.text();
      if (!body.trim()) break;
      pages.push(body);
    } catch (e) { break; }
  }
  const entries = [], seen = new Set();
  for (const h of pages) {
    const badges = [];
    const bre = /class="btn (btn-\w+)"[^>]*data-name="([^"]*)"\s+data-status="(\d+)"\s+data-speed="(\d+)"[^>]*title="([^"]*)"/g;
    let bm;
    while ((bm = bre.exec(h)) !== null) badges.push({ pos: bm.index, cls: bm[1], speed: +bm[4] });
    const ure = /value="([^"]+\.json[^"]*)"/g;
    let um;
    while ((um = ure.exec(h)) !== null) {
      const url = um[1].trim();
      if (seen.has(url)) continue;
      const badge = badges.find(b => um.index < b.pos && b.pos < um.index + 500);
      if (badge && badge.cls === 'btn-purple') { seen.add(url); entries.push({ url, speed: badge.speed }); }
    }
  }
  entries.sort((a, b) => a.speed - b.speed);
  return entries;
}

async function buildConfig() {
  const entries = await gatherList();
  const sites = [], parses = new Map(), usedKeys = new Set(), seenApi = new Set();
  const results = await Promise.allSettled(entries.map(e => decodeSource(e.url)));
  for (let idx = 0; idx < results.length; idx++) {
    const r = results[idx];
    if (r.status !== 'fulfilled') continue;
    const j = r.value.cfg;
    const base = entries[idx].url;
    for (const s of (j.sites || [])) {
      if (!s || typeof s !== 'object') continue;
      const api = absUrl(s.api || '', base);
      if (!api || seenApi.has(api + '|' + s.type)) continue;
      seenApi.add(api + '|' + s.type);
      const s2 = { ...s, api };
      const jar = absUrl(s.jar || j.spider || '', base);
      if (jar) s2.jar = jar;
      if (typeof s2.ext === 'string' && /^\.{1,2}\//.test(s2.ext)) s2.ext = absUrl(s2.ext, base);
      let k = String(s2.key || s2.name || 'src'), k2 = k, n = 2;
      while (usedKeys.has(k2)) { k2 = k + n; n++; }
      s2.key = k2; usedKeys.add(k2);
      sites.push(s2);
    }
    for (const p of (j.parses || [])) {
      if (p && p.name && p.url) parses.set(p.name + '|' + p.url, p);
    }
  }
  return {
    spider: '',
    sites,
    parses: Array.from(parses.values()),
    flags: ['qq', 'qiyi', 'mgtv', 'douyin', 'bled', 'sync1', 'sing1'],
    _info: {
      build: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      origin: 'juwanhezi.com 每日测速 极速(紫) 源合并',
      speed_ranked: true,
      source_count: entries.length,
    },
  };
}

export async function onRequest(context) {
  const cache = caches.default;
  const url = new URL(context.request.url);
  const cacheKey = new Request(url.origin + '/tv?cache=v1');
  // 传 format=pretty 时绕过缓存强制重建（调试用）
  const force = url.searchParams.get('refresh') === '1';
  let cached = force ? null : await cache.match(cacheKey);
  if (cached) return cached;

  let cfg, status = 200;
  try {
    cfg = await buildConfig();
  } catch (e) {
    // 抓取失败：回退到仓库内静态合并
    const staticR = await fetch(url.origin + '/tv.json', { cf: { cacheTtl: 300 } });
    if (staticR.ok) {
      cfg = await staticR.json();
      if (cfg._info) cfg._info.note = '实时抓取失败，返回静态快照: ' + e.message;
      status = 200;
    } else {
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });
    }
  }
  const body = JSON.stringify(cfg);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=3600',
  };
  const resp = new Response(body, { status, headers });
  if (!force) context.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}
