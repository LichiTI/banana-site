/* eslint-disable no-console */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(ROOT, 'data');
const USERS_ROOT = path.join(DATA_ROOT, 'users');
const MAX_BODY_BYTES = 50 * 1024 * 1024; // allow base64 images
const HISTORY_LIMIT = 50;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecodeToBuffer(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.name === 'SyntaxError')) return fallback;
    throw e;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((chunk) => {
    const idx = chunk.indexOf('=');
    if (idx === -1) return;
    const k = chunk.slice(0, idx).trim();
    const v = chunk.slice(idx + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text || '{}');
  } catch (e) {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function loadOrCreateSecret() {
  const envSecret = process.env.BANANA_SECRET;
  if (envSecret && envSecret.trim()) return envSecret.trim();
  const secretPath = path.join(DATA_ROOT, 'secret.txt');
  try {
    const s = (await fsp.readFile(secretPath, 'utf8')).trim();
    if (s) return s;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await ensureDir(DATA_ROOT);
  const generated = crypto.randomBytes(32).toString('hex');
  await fsp.writeFile(secretPath, generated, 'utf8');
  return generated;
}

function signToken(secret, payloadB64) {
  return base64urlEncode(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

function createToken(secret, payload) {
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = signToken(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

function verifyToken(secret, token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = signToken(secret, payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(base64urlDecodeToBuffer(payloadB64).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    if (!payload.u) return null;
    return payload;
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  const isDev = (process.env.NODE_ENV || '').toLowerCase() !== 'production';
  const parts = [
    `banana_token=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (!isDev) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  const parts = [
    'banana_token=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function sanitizeUsername(username) {
  const u = String(username || '').trim();
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(u)) return null;
  return u;
}

async function listUsers() {
  await ensureDir(USERS_ROOT);
  const entries = await fsp.readdir(USERS_ROOT, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function loadUserMeta(username) {
  const metaPath = path.join(USERS_ROOT, username, 'meta.json');
  return await readJson(metaPath, null);
}

async function saveUserMeta(username, meta) {
  const metaPath = path.join(USERS_ROOT, username, 'meta.json');
  await writeJsonAtomic(metaPath, meta);
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const derived = crypto.pbkdf2Sync(password, salt, 150000, 32, 'sha256');
  return derived.toString('hex');
}

function parseDataUrl(dataUrl) {
  const str = String(dataUrl || '');
  const m = str.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, 'base64');
  return { mime, buf };
}

function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/jpg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return 'bin';
}

function guessContentTypeByExt(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function isHttpUrl(u) {
  if (typeof u !== 'string') return false;
  return u.startsWith('http://') || u.startsWith('https://');
}

function fetchUrlBuffer(urlStr, maxBytes = MAX_DOWNLOAD_BYTES, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
      const req = lib.get(u, (r) => {
        const status = r.statusCode || 0;
        const loc = r.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc && redirectsLeft > 0) {
          r.resume();
          const next = new URL(loc, u).toString();
          fetchUrlBuffer(next, maxBytes, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          r.resume();
          reject(Object.assign(new Error(`HTTP ${status}`), { statusCode: status }));
          return;
        }
        const chunks = [];
        let total = 0;
        r.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy();
            reject(Object.assign(new Error('Download too large'), { statusCode: 413 }));
            return;
          }
          chunks.push(chunk);
        });
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = String(r.headers['content-type'] || '');
          resolve({ buf, contentType: ct });
        });
      });
      req.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function serveStaticFile(res, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'content-type': guessContentTypeByExt(filePath),
      'cache-control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    if (e.code === 'ENOENT') return sendText(res, 404, 'Not found');
    console.error(e);
    return sendText(res, 500, 'Internal error');
  }
}

function requireAuth(secret, req) {
  const cookies = parseCookies(req);
  const token = cookies.banana_token || '';
  const payload = verifyToken(secret, token);
  return payload;
}

function ensureUserOwnsPath(auth, username) {
  return auth && (auth.u === username || auth.a === true);
}

function walkAndReplace(obj, replacer) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) obj[i] = walkAndReplace(obj[i], replacer);
    return obj;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) obj[k] = walkAndReplace(obj[k], replacer);
    return obj;
  }
  if (typeof obj === 'string') return replacer(obj);
  return obj;
}

async function copyFileIfExists(src, dst) {
  await ensureDir(path.dirname(dst));
  await fsp.copyFile(src, dst);
}

async function main() {
  await ensureDir(USERS_ROOT);
  const secret = await loadOrCreateSecret();

  // Optional admin bootstrap via env; if unset, the first registered user becomes admin.
  const adminUser = sanitizeUsername(process.env.BANANA_ADMIN_USER || '');
  const adminPass = String(process.env.BANANA_ADMIN_PASS || '');
  if (adminUser && adminPass.length >= 6) {
    const existing = await loadUserMeta(adminUser);
    const salt = existing?.salt || crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(adminPass, salt);
    await saveUserMeta(adminUser, {
      username: adminUser,
      salt,
      hash,
      isAdmin: true,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    });
    console.log(`[admin] ensured admin user: ${adminUser}`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      // Static: app
      if (req.method === 'GET' && (pathname === '/' || pathname === '/banana.html')) {
        return await serveStaticFile(res, path.join(ROOT, 'banana.html'));
      }
      if (req.method === 'GET' && pathname.startsWith('/assets/')) {
        const rel = pathname.replace(/^\/assets\//, '');
        const filePath = path.join(ROOT, 'assets', rel);
        if (!filePath.startsWith(path.join(ROOT, 'assets'))) return sendText(res, 400, 'Bad path');
        return await serveStaticFile(res, filePath);
      }

      // Protected file serving for images (cookie-based)
      if (req.method === 'GET' && pathname.startsWith('/files/')) {
        const parts = pathname.split('/').filter(Boolean); // ['files', username, ...rest]
        const username = parts[1];
        const rel = parts.slice(2).join('/');
        const auth = requireAuth(secret, req);
        if (!auth) return sendText(res, 401, 'Unauthorized');
        if (!ensureUserOwnsPath(auth, username)) return sendText(res, 403, 'Forbidden');
        const userRoot = path.join(USERS_ROOT, username);
        const filePath = path.join(userRoot, rel);
        if (!filePath.startsWith(userRoot)) return sendText(res, 400, 'Bad path');
        res.writeHead(200, {
          'content-type': guessContentTypeByExt(filePath),
          'cache-control': 'private, max-age=3600',
        });
        return fs.createReadStream(filePath).on('error', (e) => {
          if (e.code === 'ENOENT') return sendText(res, 404, 'Not found');
          console.error(e);
          return sendText(res, 500, 'Internal error');
        }).pipe(res);
      }

      // API
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/me' && req.method === 'GET') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 200, { user: null });
        const meta = await loadUserMeta(auth.u);
        if (!meta) return sendJson(res, 200, { user: null });
        return sendJson(res, 200, {
          user: { username: meta.username, isAdmin: !!meta.isAdmin },
        });
      }

      if (pathname === '/api/auth/register' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const username = sanitizeUsername(body.username);
        const password = String(body.password || '');
        if (!username) return sendJson(res, 400, { error: '用户名仅允许 3-32 位字母/数字/_/-' });
        if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
        const existing = await loadUserMeta(username);
        if (existing) return sendJson(res, 409, { error: '用户名已存在' });

        const users = await listUsers();
        const firstUserBecomesAdmin = users.length === 0;

        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashPassword(password, salt);
        await saveUserMeta(username, {
          username,
          salt,
          hash,
          isAdmin: firstUserBecomesAdmin,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        await ensureDir(path.join(USERS_ROOT, username, 'uploads'));
        await ensureDir(path.join(USERS_ROOT, username, 'generated'));
        await ensureDir(path.join(USERS_ROOT, username, 'favorites'));
        await ensureDir(path.join(USERS_ROOT, username, 'history'));
        return sendJson(res, 200, { ok: true, isAdmin: firstUserBecomesAdmin });
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const username = sanitizeUsername(body.username);
        const password = String(body.password || '');
        if (!username || !password) return sendJson(res, 400, { error: '缺少用户名或密码' });
        const meta = await loadUserMeta(username);
        if (!meta) return sendJson(res, 401, { error: '用户名或密码错误' });
        const hash = hashPassword(password, meta.salt);
        if (hash !== meta.hash) return sendJson(res, 401, { error: '用户名或密码错误' });
        const token = createToken(secret, {
          u: username,
          a: !!meta.isAdmin,
          exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        setAuthCookie(res, token);
        return sendJson(res, 200, { ok: true, user: { username, isAdmin: !!meta.isAdmin } });
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        clearAuthCookie(res);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/images/save' && req.method === 'POST') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const kind = String(body.kind || '').toLowerCase();
        if (!['uploads', 'generated'].includes(kind)) return sendJson(res, 400, { error: 'Invalid kind' });
        const parsed = parseDataUrl(body.dataUrl);
        if (!parsed) return sendJson(res, 400, { error: 'Invalid dataUrl' });
        const ext = mimeToExt(parsed.mime);
        const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
        const absPath = path.join(USERS_ROOT, auth.u, kind, fileName);
        await ensureDir(path.dirname(absPath));
        await fsp.writeFile(absPath, parsed.buf);
        const fileUri = `/files/${encodeURIComponent(auth.u)}/${kind}/${encodeURIComponent(fileName)}`;
        return sendJson(res, 200, { fileUri, mime: parsed.mime });
      }

      if (pathname === '/api/images/save-batch' && req.method === 'POST') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const kind = String(body.kind || '').toLowerCase();
        if (!['generated'].includes(kind)) return sendJson(res, 400, { error: 'Invalid kind' });
        const images = Array.isArray(body.images) ? body.images : [];
        const out = [];
        for (const img of images) {
          const parsed = parseDataUrl(img?.dataUrl);
          if (!parsed) {
            out.push(null);
            continue;
          }
          const ext = mimeToExt(parsed.mime);
          const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
          const absPath = path.join(USERS_ROOT, auth.u, kind, fileName);
          await ensureDir(path.dirname(absPath));
          await fsp.writeFile(absPath, parsed.buf);
          const fileUri = `/files/${encodeURIComponent(auth.u)}/${kind}/${encodeURIComponent(fileName)}`;
          out.push({ fileUri, mime: parsed.mime });
        }
        return sendJson(res, 200, { items: out });
      }

      if (pathname === '/api/images/fetch' && req.method === 'POST') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const kind = String(body.kind || '').toLowerCase();
        const urlStr = String(body.url || '');
        if (!['generated'].includes(kind)) return sendJson(res, 400, { error: 'Invalid kind' });
        if (!isHttpUrl(urlStr)) return sendJson(res, 400, { error: 'Invalid url' });

        const { buf, contentType } = await fetchUrlBuffer(urlStr);
        const mime = (contentType.split(';')[0] || '').trim().toLowerCase();
        if (!mime.startsWith('image/')) return sendJson(res, 400, { error: `Not an image: ${mime || 'unknown'}` });

        const ext = mimeToExt(mime) || 'png';
        const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
        const absPath = path.join(USERS_ROOT, auth.u, kind, fileName);
        await ensureDir(path.dirname(absPath));
        await fsp.writeFile(absPath, buf);
        const fileUri = `/files/${encodeURIComponent(auth.u)}/${kind}/${encodeURIComponent(fileName)}`;
        return sendJson(res, 200, { fileUri, mime });
      }

      if (pathname === '/api/favorites/add' && req.method === 'POST') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const type = String(body.type || '').toLowerCase();
        if (!['presets', 'chats', 'collections'].includes(type)) {
          return sendJson(res, 400, { error: 'Invalid type' });
        }
        const item = body.item;
        if (!item || typeof item !== 'object') return sendJson(res, 400, { error: 'Invalid item' });
        const favoriteId = String(item.id || Date.now());
        const favDir = path.join(USERS_ROOT, auth.u, 'favorites', type, favoriteId);
        await ensureDir(favDir);

        // 1) Replace data URLs across payload with stored files.
        const dataUrlMap = new Map(); // dataUrl -> newUrl
        const remoteUrlMap = new Map(); // http(s) url -> newUrl
        async function materializeDataUrl(dataUrl) {
          if (dataUrlMap.has(dataUrl)) return dataUrlMap.get(dataUrl);
          const parsed = parseDataUrl(dataUrl);
          if (!parsed) return dataUrl;
          const ext = mimeToExt(parsed.mime);
          const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
          const absPath = path.join(favDir, fileName);
          await fsp.writeFile(absPath, parsed.buf);
          const fileUri = `/files/${encodeURIComponent(auth.u)}/favorites/${type}/${encodeURIComponent(favoriteId)}/${encodeURIComponent(fileName)}`;
          dataUrlMap.set(dataUrl, fileUri);
          return fileUri;
        }

        async function materializeRemoteUrl(remoteUrl) {
          if (remoteUrlMap.has(remoteUrl)) return remoteUrlMap.get(remoteUrl);
          if (!isHttpUrl(remoteUrl)) return remoteUrl;
          const { buf, contentType } = await fetchUrlBuffer(remoteUrl);
          const mime = (String(contentType).split(';')[0] || '').trim().toLowerCase();
          if (!mime.startsWith('image/')) return remoteUrl;
          const ext = mimeToExt(mime);
          const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
          const absPath = path.join(favDir, fileName);
          await fsp.writeFile(absPath, buf);
          const fileUri = `/files/${encodeURIComponent(auth.u)}/favorites/${type}/${encodeURIComponent(favoriteId)}/${encodeURIComponent(fileName)}`;
          remoteUrlMap.set(remoteUrl, fileUri);
          return fileUri;
        }

        // 2) Copy existing user files into favorites snapshot (uploads/generated).
        async function snapshotFileUri(fileUri) {
          if (typeof fileUri !== 'string') return fileUri;
          if (!fileUri.startsWith(`/files/${auth.u}/`)) return fileUri;
          const rel = decodeURIComponent(fileUri.replace(`/files/${auth.u}/`, ''));
          const src = path.join(USERS_ROOT, auth.u, rel);
          const ext = path.extname(rel) || '';
          const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
          const dst = path.join(favDir, fileName);
          await copyFileIfExists(src, dst);
          return `/files/${encodeURIComponent(auth.u)}/favorites/${type}/${encodeURIComponent(favoriteId)}/${encodeURIComponent(fileName)}`;
        }

        // Deep clone to avoid mutating request object
        const stored = JSON.parse(JSON.stringify(item));

        // A) Convert known inline_data objects to file_data + file_uri.
        function convertInlineDataToDataUrl(o) {
          const inline = o?.inline_data || o?.inlineData || o?.inLineData;
          if (!inline || !inline.data) return null;
          const mime = inline.mime_type || inline.mimeType || 'image/png';
          const data = String(inline.data);
          return `data:${mime};base64,${data}`;
        }

        async function traverseAndMaterialize(node) {
          if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) node[i] = await traverseAndMaterialize(node[i]);
            return node;
          }
          if (node && typeof node === 'object') {
            // Special-case packed assets/images: { mime, data } or { mime_type, data }
            const assetMime = (typeof node.mime === 'string' && node.mime) || (typeof node.mime_type === 'string' && node.mime_type) || null;
            const assetData = typeof node.data === 'string' ? node.data : null;
            if (
              assetMime &&
              assetMime.startsWith('image/') &&
              assetData &&
              !node.file_uri &&
              !node.fileUri
            ) {
              const fileUri = await materializeDataUrl(`data:${assetMime};base64,${assetData}`);
              const next = { ...node, file_uri: fileUri };
              delete next.data;
              return next;
            }

            // Special-case Gemini-style parts: { inline_data } -> { file_data }
            const dataUrl = convertInlineDataToDataUrl(node);
            if (dataUrl) {
              const fileUri = await materializeDataUrl(dataUrl);
              const mime = (node.inline_data?.mime_type || node.inlineData?.mime_type || node.inlineData?.mimeType || node.inLineData?.mime_type || node.inLineData?.mimeType || 'image/png');
              return { file_data: { mime_type: mime, file_uri: fileUri } };
            }
            for (const k of Object.keys(node)) node[k] = await traverseAndMaterialize(node[k]);
            return node;
          }
          if (typeof node === 'string') {
            if (node.startsWith('data:image/') && node.includes(';base64,')) return await materializeDataUrl(node);
            if (node.startsWith(`/files/${auth.u}/`)) return await snapshotFileUri(node);
            if (isHttpUrl(node)) return await materializeRemoteUrl(node);
            return node;
          }
          return node;
        }

        const storedWithFiles = await traverseAndMaterialize(stored);

        const favPath = path.join(USERS_ROOT, auth.u, 'favorites', `${type}.json`);
        const list = await readJson(favPath, []);
        list.unshift(storedWithFiles);
        await writeJsonAtomic(favPath, list);
        return sendJson(res, 200, { ok: true, item: storedWithFiles });
      }

      if (pathname.startsWith('/api/favorites/') && req.method === 'GET') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const type = pathname.replace('/api/favorites/', '').toLowerCase();
        if (!['presets', 'chats', 'collections'].includes(type)) return sendJson(res, 400, { error: 'Invalid type' });
        const favPath = path.join(USERS_ROOT, auth.u, 'favorites', `${type}.json`);
        const list = await readJson(favPath, []);
        return sendJson(res, 200, { items: list });
      }

      if (pathname.startsWith('/api/favorites/') && req.method === 'DELETE') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const parts = pathname.split('/').filter(Boolean); // api favorites type id
        const type = parts[2];
        const id = parts[3];
        if (!['presets', 'chats', 'collections'].includes(type)) return sendJson(res, 400, { error: 'Invalid type' });
        const favPath = path.join(USERS_ROOT, auth.u, 'favorites', `${type}.json`);
        const list = await readJson(favPath, []);
        const next = list.filter((x) => String(x?.id) !== String(id));
        await writeJsonAtomic(favPath, next);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/history/sessions/add' && req.method === 'POST') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const body = await readJsonBody(req);
        const meta = await loadUserMeta(auth.u);
        const isAdmin = !!meta?.isAdmin;
        const entry = body?.entry;
        if (!entry || typeof entry !== 'object') return sendJson(res, 400, { error: 'Invalid entry' });
        const historyPath = path.join(USERS_ROOT, auth.u, 'history', 'sessions.json');
        const list = await readJson(historyPath, []);
        list.unshift({ ...entry, savedAt: nowIso() });
        const trimmed = isAdmin ? list : list.slice(0, HISTORY_LIMIT);
        await writeJsonAtomic(historyPath, trimmed);
        return sendJson(res, 200, { ok: true, count: trimmed.length, limit: isAdmin ? null : HISTORY_LIMIT });
      }

      if (pathname === '/api/history/sessions' && req.method === 'GET') {
        const auth = requireAuth(secret, req);
        if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });
        const historyPath = path.join(USERS_ROOT, auth.u, 'history', 'sessions.json');
        const list = await readJson(historyPath, []);
        return sendJson(res, 200, { items: list });
      }

      if (pathname === '/api/admin/users' && req.method === 'GET') {
        const auth = requireAuth(secret, req);
        if (!auth || auth.a !== true) return sendJson(res, 403, { error: 'Forbidden' });
        const users = await listUsers();
        const out = [];
        for (const u of users) {
          const meta = await loadUserMeta(u);
          if (!meta) continue;
          out.push({ username: u, isAdmin: !!meta.isAdmin, createdAt: meta.createdAt });
        }
        return sendJson(res, 200, { items: out });
      }

      if (pathname.startsWith('/api/admin/promote/') && req.method === 'POST') {
        const auth = requireAuth(secret, req);
        if (!auth || auth.a !== true) return sendJson(res, 403, { error: 'Forbidden' });
        const username = sanitizeUsername(pathname.replace('/api/admin/promote/', ''));
        if (!username) return sendJson(res, 400, { error: 'Invalid username' });
        const meta = await loadUserMeta(username);
        if (!meta) return sendJson(res, 404, { error: 'User not found' });
        meta.isAdmin = true;
        meta.updatedAt = nowIso();
        await saveUserMeta(username, meta);
        return sendJson(res, 200, { ok: true });
      }

      return sendText(res, 404, 'Not found');
    } catch (e) {
      const status = e.statusCode || 500;
      console.error(e);
      if (req.url && String(req.url).startsWith('/api/')) {
        return sendJson(res, status, { error: e.message || 'Internal error' });
      }
      return sendText(res, status, e.message || 'Internal error');
    }
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  server.listen(port, '0.0.0.0', () => {
    console.log(`banana server listening on http://0.0.0.0:${port}`);
    console.log(`data dir: ${DATA_ROOT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
