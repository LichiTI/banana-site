// --- STATE ---
const state = {
    images: [], // Global attachments (for simple mode)
    sessions: {},
    activeSessionId: null,
    selectedSessions: new Set(),
    presets: JSON.parse(localStorage.getItem('gem_presets_v3.7') || '[]'),
    savedChats: JSON.parse(localStorage.getItem('gem_chats_v3.7') || '[]'),
    collections: JSON.parse(localStorage.getItem('gem_collections_v1.0') || '[]'),
    currentLightboxSrc: null,
    
    // Builder State
    systemInstruction: '',
    promptBuilder: [], // { role, text, images: [] }

    // Quick system prompt & model prefill
    quickSystemInstruction: '',
    modelPrefill: '',

    // Config State
    config: {
        thinkingBudget: 128,
        includeThoughts: true,
        includeImageConfig: true,
        includeSafetySettings: true,
        safety: {
            HARM_CATEGORY_HARASSMENT: "OFF",
            HARM_CATEGORY_HATE_SPEECH: "OFF",
            HARM_CATEGORY_SEXUALLY_EXPLICIT: "OFF",
            HARM_CATEGORY_DANGEROUS_CONTENT: "OFF",
            HARM_CATEGORY_CIVIC_INTEGRITY: "BLOCK_NONE"
        },
        imageConfig: { imageSize: "2K", aspectRatio: "auto" },
        webpQuality: 95,
        useResponseModalities: false,
        customJson: ""
    },
    apiFormat: 'gemini', // 'gemini' or 'openai'
    activeBuilderRowIdx: null,
    cardSize: (typeof localStorage !== 'undefined' && localStorage.getItem('gem_card_size')) || 'md',
    cardDensity: (typeof localStorage !== 'undefined' && parseInt(localStorage.getItem('gem_card_density') || '3', 10)) || 3
};

const runtime = {
    serverAvailable: true,
    me: null, // { username, isAdmin }
    authMode: 'login',
    fileUriToInlineCache: new Map()
};

function isAuthed() {
    return !!runtime.me;
}

function isAdmin() {
    return !!runtime.me?.isAdmin;
}

function isLocalFileUri(uri) {
    if (!uri || typeof uri !== 'string') return false;
    if (uri.startsWith('/files/')) return true;
    try {
        const u = new URL(uri, window.location.href);
        return u.origin === window.location.origin && u.pathname.startsWith('/files/');
    } catch {
        return false;
    }
}

function isHttpUrl(uri) {
    return typeof uri === 'string' && (uri.startsWith('http://') || uri.startsWith('https://'));
}

async function apiFetchJson(apiPath, options = {}) {
    if (runtime.serverAvailable === false) {
        throw new Error('Server unavailable');
    }

    const fetchOptions = {
        method: options.method || 'GET',
        headers: { ...(options.headers || {}) },
        credentials: 'same-origin'
    };

    if (options.json !== undefined) {
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
        fetchOptions.body = options.body;
    }

    let res;
    try {
        res = await fetch(apiPath, fetchOptions);
    } catch (e) {
        runtime.serverAvailable = false;
        throw e;
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if (!res.ok) {
        const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return data;
}

// --- API Config Management ---
function saveApiConfig() {
    const url = dom.baseUrl.value.trim();
    const key = dom.apiKey.value.trim();
    const apiFormat = state.apiFormat || 'gemini';

    if (!url || !key) {
        alert('URL和密钥不能为空');
        return;
    }
    const name = prompt('为这个配置输入一个名称:', url);
    if (!name) return;

    let configs = JSON.parse(localStorage.getItem('gem_api_configs') || '[]');
    // 检查是否已存在（按 URL + Key 去重）
    const existingIndex = configs.findIndex(c => c.url === url && c.key === key);
    if (existingIndex > -1) {
        // 更新名称和 API 格式
        configs[existingIndex].name = name;
        configs[existingIndex].apiFormat = apiFormat;
    } else {
        configs.push({ name, url, key, apiFormat });
    }
    
    localStorage.setItem('gem_api_configs', JSON.stringify(configs));
    renderApiConfigs();
}

function loadApiConfig(index) {
    let configs = JSON.parse(localStorage.getItem('gem_api_configs') || '[]');
    const cfg = configs[index];
    if (cfg) {
        dom.baseUrl.value = cfg.url;
        dom.apiKey.value = cfg.key || '';
        // 同时更新localStorage中的当前值
        localStorage.setItem('gem_base', dom.baseUrl.value);
        localStorage.setItem('gem_key', dom.apiKey.value);

        // 如果保存了 API 格式，则一并恢复
        if (cfg.apiFormat) {
            state.apiFormat = cfg.apiFormat;
            localStorage.setItem('gem_api_format', state.apiFormat);

            // 与按钮点击逻辑保持一致：不同格式自动应用合适的版本 / 端点
            if (state.apiFormat === 'openai') {
                dom.apiVersion.value = 'v1';
                // 如果当前还是 Gemini 默认地址，则自动切换到 OpenAI 官方地址
                if (!dom.baseUrl.value || dom.baseUrl.value.includes('generativelanguage.googleapis.com')) {
                    dom.baseUrl.value = 'https://api.openai.com';
                    localStorage.setItem('gem_base', dom.baseUrl.value);
                }
            } else if (state.apiFormat === 'vertex') {
                dom.apiVersion.value = 'v1beta1';
                if (!dom.baseUrl.value) {
                    dom.baseUrl.value = 'https://aiplatform.googleapis.com';
                    localStorage.setItem('gem_base', dom.baseUrl.value);
                }
            } else {
                dom.apiVersion.value = 'v1beta';
                // 如果当前是 OpenAI 地址，则自动切回 Gemini 默认地址
                if (!dom.baseUrl.value || dom.baseUrl.value.includes('api.openai.com')) {
                    dom.baseUrl.value = 'https://generativelanguage.googleapis.com';
                    localStorage.setItem('gem_base', dom.baseUrl.value);
                }
            }
            localStorage.setItem('gem_ver', dom.apiVersion.value);
            updateApiFormatUI();
        }

        updateLiveEndpoint();
        alert(`配置 "${cfg.name}" 已加载`);
    }
}

function deleteApiConfig(index) {
    if (!confirm('确定要删除这个配置吗？')) return;
    let configs = JSON.parse(localStorage.getItem('gem_api_configs') || '[]');
    configs.splice(index, 1);
    localStorage.setItem('gem_api_configs', JSON.stringify(configs));
    renderApiConfigs();
}

function renderApiConfigs() {
    const listEl = document.getElementById('apiConfigList');
    const containerEl = document.getElementById('apiConfigListContainer');
    if (!listEl || !containerEl) return;

    const configs = JSON.parse(localStorage.getItem('gem_api_configs') || '[]');
    
    if (configs.length === 0) {
        containerEl.style.display = 'none';
        return;
    }
    
    containerEl.style.display = 'block';
    listEl.innerHTML = '';

    configs.forEach((config, index) => {
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between bg-gray-800/50 p-2 rounded-lg text-xs';
        item.innerHTML = `
            <div class="flex-1 overflow-hidden mr-2">
                <div class="font-bold text-gray-300 truncate">${config.name}</div>
                <div class="text-gray-500 font-mono text-[10px] truncate">${config.url}</div>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
                <button onclick="loadApiConfig(${index})" class="p-1 text-gray-400 hover:text-green-400 rounded hover:bg-green-900/20 transition-colors" title="加载"><span class="material-symbols-rounded text-sm">login</span></button>
                <button onclick="deleteApiConfig(${index})" class="p-1 text-gray-400 hover:text-red-400 rounded hover:bg-red-900/20 transition-colors" title="删除"><span class="material-symbols-rounded text-sm">delete</span></button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

const dom = {
    // ... existing refs ...
    baseUrl: document.getElementById('baseUrl'),
    apiVersion: document.getElementById('apiVersion'),
    apiKey: document.getElementById('apiKey'),
    modelId: document.getElementById('modelId'),
    vertexKeysContainer: document.getElementById('vertexKeysContainer'),
    vertexKeysInput: document.getElementById('vertexKeysInput'),
    concRange: document.getElementById('concRange'),
    concVal: document.getElementById('concVal'),
    tempRange: document.getElementById('tempRange'),
    tempVal: document.getElementById('tempVal'),
    systemPromptQuick: document.getElementById('systemPromptQuick'),
    modelPrefillQuick: document.getElementById('modelPrefillQuick'),
    
    promptInput: document.getElementById('promptInput'),
    fileInput: document.getElementById('fileInput'),
    previewStrip: document.getElementById('previewStrip'),
    grid: document.getElementById('gridContainer'),
    emptyState: document.getElementById('emptyState'),
    runBtn: document.getElementById('runBtn'),
    imgCount: document.getElementById('imgCount'),
    mainMediaBtnContainer: document.getElementById('mainMediaBtnContainer'),
    builderActiveIndicator: document.getElementById('builderActiveIndicator'),
    
    selectionToolbar: document.getElementById('selectionToolbar'),
    selectedCount: document.getElementById('selectedCount'),
    
    chatDrawer: document.getElementById('chatDrawer'),
    chatHistory: document.getElementById('chatHistoryContainer'),
    chatInput: document.getElementById('chatInput'),
    chatSessionId: document.getElementById('chatSessionId'),
    sendChatBtn: document.getElementById('sendChatBtn'),
    chatStopBtn: document.getElementById('chatStopBtn'),
    leftSidebar: document.getElementById('leftSidebar'),
    mobileSidebarBackdrop: document.getElementById('mobileSidebarBackdrop'),
    lightbox: document.getElementById('lightbox'),
    lightboxImg: document.getElementById('lightboxImg'),

    // New Refs
    configModal: document.getElementById('configModal'),
    configGuiPanel: document.getElementById('configGuiPanel'),
    configJsonPanel: document.getElementById('configJsonPanel'),
    configPreview: document.getElementById('configPreview'),
    customJsonInput: document.getElementById('customJsonInput'),
    tabGuiBtn: document.getElementById('tabGuiBtn'),
    tabJsonBtn: document.getElementById('tabJsonBtn'),

    collectionsModal: document.getElementById('collectionsModal'),
    libraryList: document.getElementById('libraryList'),
    tabPresetsBtn: document.getElementById('tabPresetsBtn'),
    tabChatsBtn: document.getElementById('tabChatsBtn'),
    tabCollectionsBtn: document.getElementById('tabCollectionsBtn'),
    importLibFile: document.getElementById('importLibFile'),

    promptModal: document.getElementById('promptModal'),
    builderMessages: document.getElementById('builderMessages'),
    systemInstructionInput: document.getElementById('systemInstructionInput'),
    builderRowInput: document.getElementById('builderRowInput'),
    promptBuilderContainer: document.getElementById('promptBuilderContainer'),

    dragOverlay: document.getElementById('dragOverlay'),
    clock: document.getElementById('clock'),
    cardSizeToggle: document.getElementById('cardSizeToggle'),
    cardDensityRange: document.getElementById('cardDensityRange'),
    
    // Live Endpoint
    epBase: document.getElementById('epBase'),
    epVer: document.getElementById('epVer'),
    epModel: document.getElementById('epModel'),

    // Raw data modal
    rawModal: document.getElementById('rawModal'),
    rawReqCode: document.getElementById('rawReqCode'),
    rawResCode: document.getElementById('rawResCode'),

    // Auth
    authArea: document.getElementById('authArea'),
    authUserPill: document.getElementById('authUserPill'),
    authUserLabel: document.getElementById('authUserLabel'),
    authAdminBadge: document.getElementById('authAdminBadge'),
    loginBtn: document.getElementById('loginBtn'),
    registerBtn: document.getElementById('registerBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    authModal: document.getElementById('authModal'),
    authTabLogin: document.getElementById('authTabLogin'),
    authTabRegister: document.getElementById('authTabRegister'),
    authUsername: document.getElementById('authUsername'),
    authPassword: document.getElementById('authPassword'),
    authSubmitBtn: document.getElementById('authSubmitBtn'),
    authError: document.getElementById('authError'),
    authHint: document.getElementById('authHint')
};

function setAuthError(message) {
    if (!dom.authError) return;
    if (!message) {
        dom.authError.classList.add('hidden');
        dom.authError.textContent = '';
        return;
    }
    dom.authError.textContent = String(message);
    dom.authError.classList.remove('hidden');
}

function updateAuthUI() {
    const authed = isAuthed();
    if (dom.authUserPill) dom.authUserPill.classList.toggle('hidden', !authed);
    if (dom.logoutBtn) dom.logoutBtn.classList.toggle('hidden', !authed);
    if (dom.loginBtn) dom.loginBtn.classList.toggle('hidden', authed);
    if (dom.registerBtn) dom.registerBtn.classList.toggle('hidden', authed);

    if (dom.authUserLabel) dom.authUserLabel.textContent = authed ? runtime.me.username : 'guest';
    if (dom.authAdminBadge) dom.authAdminBadge.classList.toggle('hidden', !isAdmin());
}

function switchAuthMode(mode) {
    runtime.authMode = mode === 'register' ? 'register' : 'login';
    setAuthError('');

    if (dom.authTabLogin && dom.authTabRegister) {
        const loginActive = runtime.authMode === 'login';
        dom.authTabLogin.className = loginActive
            ? 'flex-1 py-2 rounded-lg border bg-blue-600 border-blue-500 text-white text-xs font-medium transition-colors active:scale-95'
            : 'flex-1 py-2 rounded-lg border bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800 text-xs font-medium transition-colors active:scale-95';
        dom.authTabRegister.className = !loginActive
            ? 'flex-1 py-2 rounded-lg border bg-blue-600 border-blue-500 text-white text-xs font-medium transition-colors active:scale-95'
            : 'flex-1 py-2 rounded-lg border bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800 text-xs font-medium transition-colors active:scale-95';
    }

    if (dom.authSubmitBtn) dom.authSubmitBtn.textContent = runtime.authMode === 'login' ? '登录' : '注册';
}

function toggleAuthModal(show, mode) {
    if (!dom.authModal) return;
    if (show) {
        dom.authModal.classList.remove('hidden');
        switchAuthMode(mode || runtime.authMode);
        setTimeout(() => dom.authUsername?.focus(), 0);
    } else {
        dom.authModal.classList.add('hidden');
        setAuthError('');
    }
}

async function refreshMe() {
    try {
        const data = await apiFetchJson('/api/me');
        runtime.me = data?.user || null;
        runtime.serverAvailable = true;
    } catch {
        runtime.me = null;
        runtime.serverAvailable = false;
    }
    updateAuthUI();
    return runtime.me;
}

async function loadFavoritesFromServer() {
    if (!isAuthed()) return;
    const presets = await apiFetchJson('/api/favorites/presets');
    const chats = await apiFetchJson('/api/favorites/chats');
    const collections = await apiFetchJson('/api/favorites/collections');
    state.presets = Array.isArray(presets.items) ? presets.items : [];
    state.savedChats = Array.isArray(chats.items) ? chats.items : [];
    state.collections = Array.isArray(collections.items) ? collections.items : [];
}

async function submitAuth() {
    try {
        setAuthError('');
        const username = dom.authUsername?.value?.trim();
        const password = dom.authPassword?.value || '';
        if (!username || !password) return setAuthError('请输入用户名和密码');

        if (runtime.authMode === 'register') {
            await apiFetchJson('/api/auth/register', { method: 'POST', json: { username, password } });
        }
        await apiFetchJson('/api/auth/login', { method: 'POST', json: { username, password } });
        await refreshMe();
        if (isAuthed()) {
            await loadFavoritesFromServer();
        }
        toggleAuthModal(false);
        alert(isAdmin() ? '已登录（ADMIN）' : '已登录');
    } catch (e) {
        setAuthError(e?.message || '操作失败');
    }
}

async function logout() {
    try {
        await apiFetchJson('/api/auth/logout', { method: 'POST', json: {} });
    } catch {
        // ignore
    }
    runtime.me = null;
    updateAuthUI();
}

const vertexKeyManager = {
    keys: [],
    index: 0,
    parse(raw = '') {
        const list = [];
        raw.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const parts = trimmed.split('|');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const projectId = parts[1].trim();
                if (key && projectId) {
                    list.push({ key, projectId });
                }
            }
        });
        this.keys = list;
        return list.length;
    },
    loadFromStorage() {
        try {
            const raw = localStorage.getItem('gem_vertex_keys') || '';
            if (dom.vertexKeysInput) dom.vertexKeysInput.value = raw;
            this.parse(raw);
        } catch (e) {
            this.keys = [];
        }
    },
    updateFromTextarea(value) {
        localStorage.setItem('gem_vertex_keys', value);
        this.parse(value);
    },
    getNext() {
        if (!this.keys.length) return null;
        const cred = this.keys[this.index];
        this.index = (this.index + 1) % this.keys.length;
        return cred;
    }
};

const BASE64_COMPARE_LENGTH = 100;
let INLINE_IMAGE_ID_COUNTER = 0;

const RETRY_BASE_DELAY_MS = 1000;
const MAX_429_ATTEMPTS = 3;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cloneImages(images = []) {
    return (images || []).map(img => ({ ...img }));
}

function clonePromptBuilder(builder = []) {
    return (builder || []).map(msg => ({
        role: msg.role,
        text: msg.text || '',
        images: cloneImages(msg.images || [])
    }));
}

function normalizeBase64(data = '') {
    if(!data) return '';
    let clean = data
        .replace(/[\s\r\n\t]+/g, '')
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .replace(/[^A-Za-z0-9+/=]/g, '');
    clean = clean.replace(/=+$/, '');
    const pad = (4 - (clean.length % 4)) % 4;
    return clean + '='.repeat(pad);
}

function getInlineData(part = {}) {
    return part.inline_data || part.inlineData || part.inLineData;
}

async function convertBase64ToWebP(dataUrl, quality = 0.95) {
    return new Promise((resolve, reject) => {
        try {
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const webpDataUrl = canvas.toDataURL('image/webp', quality);
                    const parts = webpDataUrl.split(';base64,');
                    if (parts.length !== 2) {
                        reject(new Error('Unexpected WebP data URL format'));
                        return;
                    }
                    resolve({
                        mime: parts[0].split(':')[1] || 'image/webp',
                        data: parts[1]
                    });
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => reject(new Error('Failed to decode image for WebP conversion'));
            img.src = dataUrl;
        } catch (err) {
            reject(err);
        }
    });
}

async function ensureInlineImageWebP(inlineData) {
    if (!inlineData || !inlineData.data) return inlineData;
    const currentMime = inlineData.mime_type || inlineData.mimeType || 'image/png';
    if (currentMime === 'image/webp') {
        return { ...inlineData, mime_type: 'image/webp' };
    }
    try {
        const normalized = normalizeBase64(inlineData.data);
        const dataUrl = `data:${currentMime};base64,${normalized}`;
        const qInt = (typeof state.config?.webpQuality === 'number' && state.config.webpQuality > 0 && state.config.webpQuality <= 100)
            ? state.config.webpQuality
            : 95;
        const converted = await convertBase64ToWebP(dataUrl, qInt / 100);
        return {
            ...inlineData,
            mime_type: converted.mime,
            mimeType: converted.mime,
            data: converted.data
        };
    } catch (err) {
        console.warn('WebP conversion failed, using original image.', err);
        return {
            ...inlineData,
            mime_type: currentMime,
            data: normalizeBase64(inlineData.data)
        };
    }
}

async function fileUriToInlineData(fileUri) {
    if (!fileUri || typeof fileUri !== 'string') return null;
    const key = fileUri;
    if (runtime.fileUriToInlineCache.has(key)) return await runtime.fileUriToInlineCache.get(key);

    const task = (async () => {
        const res = await fetch(fileUri, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`读取图片失败: HTTP ${res.status}`);
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('读取图片失败'));
            reader.readAsDataURL(blob);
        });
        const str = String(dataUrl || '');
        const m = str.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return null;
        return { mime_type: m[1], data: m[2] };
    })();

    runtime.fileUriToInlineCache.set(key, task);
    try {
        return await task;
    } catch (e) {
        runtime.fileUriToInlineCache.delete(key);
        throw e;
    }
}

async function hydrateImagesInPlace(images = []) {
    const list = Array.isArray(images) ? images : [];
    for (const img of list) {
        if (!img || typeof img !== 'object') continue;
        if (img.data) continue;
        const uri = img.file_uri || img.fileUri || img.file_url || img.url;
        if (!uri || typeof uri !== 'string') continue;
        try {
            const inline = await fileUriToInlineData(uri);
            if (!inline?.data) continue;
            const mime = img.mime || inline.mime_type || 'image/png';
            img.mime = mime;
            img.data = inline.data;
            img.b64 = `data:${mime};base64,${inline.data}`;
        } catch (e) {
            console.warn('图片补全失败:', uri, e);
        }
    }
}

async function prepareMessagesForRequest(messages = []) {
    const prepared = [];
    for (const msg of messages || []) {
        const newParts = [];
        const parts = msg.parts || [];
        for (const part of parts) {
            // 标记了 thought: true 的文本块仅作为“思维链摘要”展示给用户，
            // 不需要在下一轮继续回传给模型。
            if (part && part.thought === true) {
                continue;
            }
            if (part && typeof part.text === 'string') {
                // 仅在 OpenAI 转接时过滤“思维过程”文本；Gemini / Vertex 现在依赖 thought 标记来区分思维链摘要
                if (
                    state.apiFormat === 'openai' &&
                    (part.text.startsWith(" pensée") || part.text.includes("Tool Code:"))
                ) {
                    continue;
                }
            }
            const inlineData = getInlineData(part);
            if ((!inlineData || !inlineData.data) && part) {
                const fileData = part.file_data || part.fileData;
                if (fileData?.file_uri && isLocalFileUri(fileData.file_uri)) {
                    const fetched = await fileUriToInlineData(fileData.file_uri);
                    if (fetched?.data) {
                        const cloned = { ...part, inline_data: fetched };
                        delete cloned.file_data;
                        delete cloned.fileData;
                        newParts.push(cloned);
                        continue;
                    }
                }
            }
            if (inlineData && inlineData.data && !part.__webpOptimized) {
                try {
                    const optimized = await ensureInlineImageWebP(inlineData);
                    if (part.inline_data) {
                        part.inline_data = optimized;
                    } else if (part.inlineData) {
                        part.inlineData = optimized;
                    } else if (part.inLineData) {
                        part.inLineData = optimized;
                    }
                    Object.defineProperty(part, '__webpOptimized', {
                        value: true,
                        enumerable: false,
                        configurable: true
                    });
                } catch (err) {
                    console.warn('Failed to optimize inline image to WebP, fallback to original.', err);
                }
            }
            newParts.push(part);
        }
        // 如果该轮消息全部是 thought:true 的摘要块，则 newParts 为空，直接丢弃整条消息，
        // 避免发送 role/parts 结构但没有任何有效内容。
        if (newParts.length > 0) {
            prepared.push({
                role: msg.role,
                parts: newParts
            });
        }
    }
    return prepared;
}

function getPartImageSource(part = {}) {
    const inlineData = getInlineData(part);
    if(inlineData?.data) {
        const inlineMime = inlineData.mime_type || inlineData.mimeType || 'image/png';
        return `data:${inlineMime};base64,${normalizeBase64(inlineData.data)}`;
    }
    const imageUrl = part.image?.url || part.media?.url || part.media?.imageUri || part.media?.uri;
    const fileData = part.file_data || part.fileData;
    if(fileData?.file_uri) return fileData.file_uri;
    return imageUrl || null;
}

function getPartImageKey(part = {}) {
    const inlineData = getInlineData(part);
    if(inlineData?.data) {
        const inlineMime = inlineData.mime_type || inlineData.mimeType || 'image/png';
        const normalized = normalizeBase64(inlineData.data);
        const sample = normalized.slice(0, BASE64_COMPARE_LENGTH);
        return `inline:${inlineMime}:${sample}`;
    }
    const fileData = part.file_data || part.fileData;
    if(fileData?.file_uri) return `file:${fileData.file_uri}`;
    const imageUrl = part.image?.url || part.media?.url || part.media?.imageUri || part.media?.uri;
    if(imageUrl) return `url:${imageUrl.trim()}`;
    return null;
}

function getLastImageIndexes(parts = []) {
    const indexes = new Set();
    const seen = new Set();
    for(let i = parts.length - 1; i >= 0; i--) {
        const key = getPartImageKey(parts[i]);
        const src = getPartImageSource(parts[i]);
        if(key && src && !seen.has(key)) {
            seen.add(key);
            indexes.add(i);
        }
    }
    return indexes;
}

// 为内联图片生成一个稳定且唯一的本地文件名（与 saved 对话 / 合集以及 ZIP 内路径统一）
function getInlineImageFilename(part) {
    const inlineData = getInlineData(part);
    if (!inlineData || !inlineData.data) return null;

    const inlineMime = inlineData.mime_type || inlineData.mimeType || 'image/png';
    const ext = (inlineMime.split('/')[1] || 'png').toLowerCase();

    // 如果这个 part 之前已经生成过文件名，则复用，避免同一张图片在不同保存路径下名称不一致
    if (part.__inlineFileName && typeof part.__inlineFileName === 'string') {
        return {
            filename: part.__inlineFileName,
            mime: inlineMime
        };
    }

    // 使用时间戳 + 递增计数器 + 一小段 base64 指纹，确保在不同对话 / 合集中也不会冲突
    const normalized = normalizeBase64(inlineData.data);
    const shortFingerprint = normalized.slice(0, 16);
    const uniqueId = `${Date.now()}_${INLINE_IMAGE_ID_COUNTER++}`;
    const rawName = `img_${uniqueId}_${shortFingerprint}`;
    const safeKey = rawName.replace(/[^a-zA-Z0-9_\-]+/g, '_');
    const filename = `save image/${safeKey}.${ext}`;

    // 存在非枚举属性上，既能在运行期多次复用，又不会污染保存到 localStorage 的 JSON
    Object.defineProperty(part, '__inlineFileName', {
        value: filename,
        writable: false,
        enumerable: false,
        configurable: true
    });

    return {
        filename,
        mime: inlineMime
    };
}

        // --- COLLECTION PACK/UNPACK & STORAGE HELPERS (avoid huge localStorage payloads) ---
        function makeMessagesStorageSafe(messages = []) {
            return (messages || []).map(msg => {
                const safeParts = [];
                (msg.parts || []).forEach(part => {
                    const inlineData = getInlineData(part);
                    if (inlineData && inlineData.data) {
                        // 对内联图片：丢弃 Base64，本地只保存一个指向 save image/ 的相对路径
                        const hasText = part.text && String(part.text).trim().length > 0;
                        if (hasText) {
                            // 文本单独存一份，避免把原来的 part 连同 inline_data 一起塞进 localStorage
                            safeParts.push({ text: part.text });
                        }
                        const fileInfo = getInlineImageFilename(part);
                        if (fileInfo) {
                            safeParts.push({
                                file_data: {
                                    mime_type: fileInfo.mime,
                                    file_uri: fileInfo.filename
                                }
                            });
                        } else if (!hasText) {
                            // 理论上不会走到这里，兜底兼容旧数据
                            safeParts.push({
                                text: '[图片已省略，请在原页面或导出的 ZIP 中查看]'
                            });
                        }
                        // 不拷贝 inline_data
                    } else {
                        // 非内联图片（远程 URL / 已有 file_data 等）原样保留
                        safeParts.push(part);
                    }
                });
                return { role: msg.role, parts: safeParts };
            });
        }

        function packCollectionSessions(sessions = []) {
            const assets = [];
            const keyToIndex = new Map();
            const packedSessions = sessions.map(sess => {
                // 先对消息做轻量化处理，确保不会把大图塞进合集
                const safeMessages = makeMessagesStorageSafe(sess.messages || []);
                const packedMessages = safeMessages.map(msg => {
                    const parts = (msg.parts || []).map(part => {
                        const inlineData = getInlineData(part);
                        if (inlineData && inlineData.data) {
                            // 理论上经过 makeMessagesStorageSafe 这里很少再命中，保留逻辑兼容旧调用
                            const key = getPartImageKey(part) || `inline:${(inlineData.mime_type || inlineData.mimeType || 'image/png')}:${normalizeBase64(inlineData.data).slice(0, BASE64_COMPARE_LENGTH)}`;
                            let idx = keyToIndex.get(key);
                            if (idx == null) {
                                idx = assets.length;
                                keyToIndex.set(key, idx);
                                assets.push({
                                    key,
                                    mime: inlineData.mime_type || inlineData.mimeType || 'image/png',
                                    data: normalizeBase64(inlineData.data)
                                });
                            }
                            return { file_data: { mime_type: inlineData.mime_type || inlineData.mimeType || 'image/png', file_uri: `asset:${idx}` } };
                        }
                        return part;
                    });
                    return { role: msg.role, parts };
                });
                return { timestamp: sess.timestamp, systemInstruction: sess.systemInstruction, messages: packedMessages };
            });
            return { assets, sessions: packedSessions, v: 1 };
        }

function unpackCollectionSessions(collection) {
    if (!collection || !Array.isArray(collection.assets)) {
        return collection.sessions || [];
    }
    const assets = collection.assets;
    return (collection.sessions || []).map(sess => {
        const restoredMessages = (sess.messages || []).map(msg => {
            const parts = (msg.parts || []).map(part => {
                const fileData = part.file_data || part.fileData;
                if (fileData && typeof fileData.file_uri === 'string' && fileData.file_uri.startsWith('asset:')) {
                    const idx = parseInt(fileData.file_uri.split(':')[1], 10);
                    const asset = assets[idx];
                    if (asset && asset.data) {
                        return { inline_data: { mime_type: asset.mime || 'image/png', data: asset.data } };
                    }
                    if (asset && asset.file_uri) {
                        return { file_data: { mime_type: asset.mime || 'image/png', file_uri: asset.file_uri } };
                    }
                }
                return part;
            });
            return { role: msg.role, parts };
        });
        return { timestamp: sess.timestamp, systemInstruction: sess.systemInstruction, messages: restoredMessages };
    });
}

// 一次性轻量化现有库数据，释放 localStorage 空间
function tryMigrateLibraryToLightweight() {
    const flagKey = 'gem_storage_migrated_v4_light';
    try {
        if (localStorage.getItem(flagKey) === '1') return;

        // savedChats: 只保留文本与非 inline 图片引用
        if (Array.isArray(state.savedChats) && state.savedChats.length) {
            state.savedChats = state.savedChats.map(chat => ({
                ...chat,
                messages: makeMessagesStorageSafe(chat.messages || [])
            }));
            localStorage.setItem('gem_chats_v3.7', JSON.stringify(state.savedChats));
        }

        // collections: 会话轻量化，同时丢弃打包的二进制 assets
        if (Array.isArray(state.collections) && state.collections.length) {
            state.collections = state.collections.map(col => {
                if (!col || !Array.isArray(col.sessions)) return col;
                const safeSessions = (col.sessions || []).map(sess => ({
                    ...sess,
                    messages: makeMessagesStorageSafe(sess.messages || [])
                }));
                return {
                    ...col,
                    sessions: safeSessions,
                    assets: [] // 不再在本地保存大图数据
                };
            });
            localStorage.setItem('gem_collections_v1.0', JSON.stringify(state.collections));
        }

        localStorage.setItem(flagKey, '1');
    } catch (e) {
        console.warn('轻量化本地库失败，可忽略:', e);
    }
}

let activeLibraryTab = 'presets';

// --- INIT ---
document.addEventListener('DOMContentLoaded', async () => {
    if(localStorage.getItem('gem_base')) dom.baseUrl.value = localStorage.getItem('gem_base');
    if(localStorage.getItem('gem_ver')) dom.apiVersion.value = localStorage.getItem('gem_ver');
    if(localStorage.getItem('gem_key')) dom.apiKey.value = localStorage.getItem('gem_key');
    if(localStorage.getItem('gem_model')) dom.modelId.value = localStorage.getItem('gem_model');
    state.apiFormat = localStorage.getItem('gem_api_format') || 'gemini';
    state.collections = JSON.parse(localStorage.getItem('gem_collections_v1.0') || '[]'); // 从 localStorage 加载合集

    await refreshMe();
    if (isAuthed()) {
        try {
            await loadFavoritesFromServer();
        } catch (e) {
            console.warn('加载服务器收藏失败，将继续使用本地库:', e);
        }
    }

    // 根据当前 apiFormat 自动校正默认 Base URL / 版本，避免 OpenAI 还指向谷歌或反之
    try {
        if (state.apiFormat === 'openai') {
            if (!dom.baseUrl.value || dom.baseUrl.value.includes('generativelanguage.googleapis.com')) {
                dom.baseUrl.value = 'https://api.openai.com';
                localStorage.setItem('gem_base', dom.baseUrl.value);
            }
            if (!dom.apiVersion.value) {
                dom.apiVersion.value = 'v1';
                localStorage.setItem('gem_ver', dom.apiVersion.value);
            }
        } else if (state.apiFormat === 'gemini') {
            if (!dom.baseUrl.value || dom.baseUrl.value.includes('api.openai.com')) {
                dom.baseUrl.value = 'https://generativelanguage.googleapis.com';
                localStorage.setItem('gem_base', dom.baseUrl.value);
            }
            if (!dom.apiVersion.value) {
                dom.apiVersion.value = 'v1beta';
                localStorage.setItem('gem_ver', dom.apiVersion.value);
            }
        }
    } catch (e) {
        console.warn('初始化时校正 API 配置失败，可忽略:', e);
    }

    // Load quick system prompt & model prefill
    const savedSysPromptQuick = localStorage.getItem('gem_sys_prompt_quick');
    if (savedSysPromptQuick !== null && dom.systemPromptQuick) {
        state.quickSystemInstruction = savedSysPromptQuick;
        dom.systemPromptQuick.value = savedSysPromptQuick;
    }
    const savedModelPrefillQuick = localStorage.getItem('gem_model_prefill_quick');
    if (savedModelPrefillQuick !== null && dom.modelPrefillQuick) {
        state.modelPrefill = savedModelPrefillQuick;
        dom.modelPrefillQuick.value = savedModelPrefillQuick;
    }

    renderApiConfigs(); // Initial render of saved configs
    vertexKeyManager.loadFromStorage();
    updateApiFormatUI();

    // Theme init
    const savedTheme = localStorage.getItem('gem_theme') || 'dark';
    document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    updateThemeToggleIcon();
    // B/W init
    const savedBW = localStorage.getItem('gem_bw') === '1';
    document.documentElement.classList.toggle('bw', savedBW);
    updateBWToggleIcon();
    
    dom.concRange.addEventListener('input', (e) => {
        dom.concVal.textContent = e.target.value;
        updateConfigPreview();
    });
    dom.tempRange.addEventListener('input', (e) => {
        dom.tempVal.textContent = e.target.value;
        updateConfigPreview();
    });
    
    if (dom.systemPromptQuick) {
        dom.systemPromptQuick.addEventListener('input', (e) => {
            state.quickSystemInstruction = e.target.value;
            localStorage.setItem('gem_sys_prompt_quick', state.quickSystemInstruction);
        });
    }
    if (dom.modelPrefillQuick) {
        dom.modelPrefillQuick.addEventListener('input', (e) => {
            state.modelPrefill = e.target.value;
            localStorage.setItem('gem_model_prefill_quick', state.modelPrefill);
        });
    }
    
    // Inputs
    dom.promptInput.addEventListener('input', () => { autoResize(dom.promptInput); syncInputToBuilder(); });
    dom.promptInput.addEventListener('keydown', handlePromptKeydown);
    dom.chatInput.addEventListener('keydown', (e) => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }});
    if (dom.authPassword) {
        dom.authPassword.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitAuth();
            }
        });
    }

    // File Handlers
    dom.fileInput.addEventListener('change', (e) => handleFileUpload(e.target.files, 'global'));
    dom.builderRowInput.addEventListener('change', (e) => handleFileUpload(e.target.files, 'row'));
    dom.importLibFile.addEventListener('change', handleLibraryImport);

    // Drag & Drop
    setupDragDrop();

    // Config Listeners
    setupConfigListeners();

    // Clock & Endpoint Update
    setInterval(() => { dom.clock.textContent = new Date().toLocaleTimeString('en-US', {hour12:false}); }, 1000);
    
    document.getElementById('fetchModelsBtn').addEventListener('click', fetchModels);
    ['baseUrl', 'apiVersion', 'apiKey'].forEach(id => {
        dom[id].addEventListener('input', () => {
            localStorage.setItem(id==='baseUrl'?'gem_base':id==='apiVersion'?'gem_ver':'gem_key', dom[id].value);
            updateLiveEndpoint();
        });
    });

    dom.modelId.addEventListener('input', () => {
        localStorage.setItem('gem_model', dom.modelId.value);
        updateLiveEndpoint();
    });

    // 解决当输入框有值时，点击无法显示完整列表的问题
    dom.modelId.onmousedown = () => {
        const currentValue = dom.modelId.value;
        if (currentValue) {
            dom.modelId.value = "";
            setTimeout(() => {
                dom.modelId.value = currentValue;
            }, 0);
        }
    };

    // Init Config Preview & Endpoint
    loadAdvancedConfig();
    updateConfigPreview();
    updateLiveEndpoint();

    // Card size toggle & initial apply
    if (dom.cardSizeToggle) {
        dom.cardSizeToggle.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-size]');
            if (!btn) return;
            const size = btn.dataset.size;
            applyCardSize(size);
        });
    }

    // Density slider (finer control of how many cards per row)
    if (dom.cardDensityRange) {
        dom.cardDensityRange.value = String(state.cardDensity);
        dom.cardDensityRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            applyCardDensity(Number.isFinite(v) ? v : 3);
        });
    }

    applyCardSize(state.cardSize);
    applyCardDensity(state.cardDensity);
    
    // 轻量化已有库：仅在“本地库模式”下执行，避免影响服务器收藏的完整图片策略
    if (!isAuthed()) {
        tryMigrateLibraryToLightweight();
    }
     
    // 历史数据轻量化迁移由 tryMigrateLibraryToLightweight 处理；
    // 新的“保存对话 / 保存合集”逻辑在各自函数内部处理体积控制。
});

// --- RESPONSIVE UI LOGIC ---
function toggleMobileSidebar(show) {
    if(show) {
        dom.leftSidebar.classList.remove('-translate-x-full');
        dom.mobileSidebarBackdrop.classList.remove('hidden');
        // Prevent body scroll
        document.body.style.overflow = 'hidden';
    } else {
        dom.leftSidebar.classList.add('-translate-x-full');
        dom.mobileSidebarBackdrop.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function updateLiveEndpoint() {
    const base = dom.baseUrl.value.replace(/^https?:\/\//, '').replace(/\/$/, '');
    dom.epBase.textContent = base;
    dom.epVer.textContent = dom.apiVersion.value;
    dom.epModel.textContent = dom.modelId.value;
}

// --- DRAG & DROP (GLOBAL) ---
function setupDragDrop() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    window.addEventListener('dragenter', (e) => {
        stop(e);
        const hasFiles = Array.from(e.dataTransfer?.types || []).includes('Files');
        if (!hasFiles) return;
        // Only show global overlay if not over a builder row (handled separately)
        if(!e.target.closest('#builderMessages')) dom.dragOverlay.classList.remove('hidden');
    });

    window.addEventListener('dragover', stop);

    window.addEventListener('dragleave', (e) => {
        stop(e);
        // Hide overlay when leaving the page/viewport or the overlay itself
        const outOfWindow = e.clientX <= 0 || e.clientY <= 0 ||
            e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;

        if (
            e.target === dom.dragOverlay ||
            e.target === document ||
            e.target === document.documentElement ||
            outOfWindow
        ) {
            dom.dragOverlay.classList.add('hidden');
        }
    });

    window.addEventListener('drop', (e) => {
        stop(e);
        dom.dragOverlay.classList.add('hidden');
        // If drop on global overlay
        if (e.dataTransfer.files.length > 0) {
            handleFileUpload(e.dataTransfer.files, 'global');
        }
    });
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result);
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

async function trySaveImageToServer(kind, dataUrl) {
    if (!isAuthed()) return null;
    try {
        const res = await apiFetchJson('/api/images/save', { method: 'POST', json: { kind, dataUrl } });
        return res;
    } catch (e) {
        console.warn('保存图片到服务器失败（将仅保留在浏览器内存中）:', e);
        return null;
    }
}

async function handleFileUpload(files, target, rowIdx = null) {
    const list = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'));
    for (const file of list) {
        const dataUrl = await readFileAsDataURL(file);
        const imgObj = { mime: dataUrl.split(';')[0].split(':')[1], data: dataUrl.split(',')[1], b64: dataUrl };

        // 按用户落盘：uploads/
        const stored = await trySaveImageToServer('uploads', dataUrl);
        if (stored?.fileUri) imgObj.file_uri = stored.fileUri;

        if (target === 'global') {
            state.images.push(imgObj);
            renderPreview();
        } else if (target === 'row') {
            const idx = rowIdx !== null ? rowIdx : state.activeBuilderRowIdx;
            if (idx !== null && state.promptBuilder[idx]) {
                state.promptBuilder[idx].images.push(imgObj);
                renderBuilder();
            }
        }
    }

    // Reset inputs
    dom.fileInput.value = '';
    dom.builderRowInput.value = '';
}

// --- CONFIGURATION ---
function setupConfigListeners() {
    // Vertex key textarea
    if (dom.vertexKeysInput) {
        dom.vertexKeysInput.addEventListener('input', (e) => {
            vertexKeyManager.updateFromTextarea(e.target.value);
        });
    }

    // Thinking
    document.getElementById('includeThoughtsCheck').addEventListener('change', (e) => {
        state.config.includeThoughts = e.target.checked;
        updateConfigPreview();
    });
    document.getElementById('includeImageConfigCheck').addEventListener('change', (e) => {
        state.config.includeImageConfig = e.target.checked;
        updateConfigPreview();
    });
    document.getElementById('includeSafetySettingsCheck').addEventListener('change', (e) => {
        state.config.includeSafetySettings = e.target.checked;
        updateConfigPreview();
    });
    document.getElementById('thinkingBudgetRange').addEventListener('input', (e) => {
        state.config.thinkingBudget = parseInt(e.target.value);
        document.getElementById('thinkingBudgetVal').textContent = state.config.thinkingBudget;
        updateConfigPreview();
    });
    const respCheck = document.getElementById('enableResponseModalitiesCheck');
    if (respCheck) {
        respCheck.checked = !!state.config.useResponseModalities;
        respCheck.addEventListener('change', (e) => {
            state.config.useResponseModalities = e.target.checked;
            updateConfigPreview();
        });
    }

    // Safety
    ['safeHarassment', 'safeHate', 'safeSex', 'safeDanger', 'safeCivic'].forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => {
            const catMap = {
                safeHarassment: 'HARM_CATEGORY_HARASSMENT',
                safeHate: 'HARM_CATEGORY_HATE_SPEECH',
                safeSex: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                safeDanger: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                safeCivic: 'HARM_CATEGORY_CIVIC_INTEGRITY',
            };
            const key = catMap[id] || id;
            state.config.safety[key] = e.target.value;
            updateConfigPreview();
        });
    });

    // JSON
    dom.customJsonInput.addEventListener('input', (e) => {
        state.config.customJson = e.target.value;
        updateConfigPreview();
    });

    // Image config buttons
    setupImageConfigControls();
    
    // WebP quality slider
    const webpRange = document.getElementById('webpQualityRange');
    const webpVal = document.getElementById('webpQualityVal');
    if (webpRange && webpVal) {
        const qInit = typeof state.config.webpQuality === 'number' ? state.config.webpQuality : 95;
        webpRange.value = qInit;
        webpVal.textContent = qInit;
        webpRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            const safe = Number.isFinite(v) ? Math.min(100, Math.max(50, v)) : 95;
            state.config.webpQuality = safe;
            webpVal.textContent = safe;
        });
    }
     
    // API Format buttons
   document.getElementById('apiFormatGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      state.apiFormat = btn.dataset.value;
      localStorage.setItem('gem_api_format', state.apiFormat);
      updateApiFormatUI();
      
      // Auto-update API version for common providers，并在必要时自动切换 Base URL
      if (state.apiFormat === 'openai') {
          dom.apiVersion.value = 'v1';
          if (!dom.baseUrl.value || dom.baseUrl.value.includes('generativelanguage.googleapis.com')) {
              dom.baseUrl.value = 'https://api.openai.com';
              localStorage.setItem('gem_base', dom.baseUrl.value);
          }
      } else if (state.apiFormat === 'vertex') {
          dom.apiVersion.value = 'v1beta1';
          dom.baseUrl.value = 'https://aiplatform.googleapis.com';
          localStorage.setItem('gem_base', dom.baseUrl.value);
      } else {
          dom.apiVersion.value = 'v1beta';
          if (!dom.baseUrl.value || dom.baseUrl.value.includes('api.openai.com')) {
              dom.baseUrl.value = 'https://generativelanguage.googleapis.com';
              localStorage.setItem('gem_base', dom.baseUrl.value);
          }
      }
      localStorage.setItem('gem_ver', dom.apiVersion.value);
      updateLiveEndpoint();
  });
}

function updateConfigPreview() {
    const payload = {};
    const tRaw = parseFloat(dom.tempRange.value);
    const temperature = Number.isFinite(tRaw) ? tRaw : 1.0;
    const generationConfig = {
        temperature,
    };

    if (state.config.includeImageConfig) {
        if (state.config.useResponseModalities) {
            generationConfig.responseModalities = ["TEXT", "IMAGE"];
        }

        const aspectRatio = state.config.imageConfig?.aspectRatio;
        const imageSize = state.config.imageConfig?.imageSize || state.config.imageConfig?.imagesize || "2K";

        // 构建 imageConfig 时：
        // - 始终发送 imageSize（有默认值 2K）
        // - 仅当比例不是 "auto" 且已设置时才发送 aspectRatio
        //   当为 "auto" 时不带该字段，避免官方端点报错
        const imageConfig = {
            imageSize
        };
        if (aspectRatio && aspectRatio !== "auto") {
            imageConfig.aspectRatio = aspectRatio;
        }

        generationConfig.imageConfig = imageConfig;
    }
    if (state.config.includeThoughts) {
        generationConfig.thinkingConfig = {
            thinkingBudget: state.config.thinkingBudget,
            includeThoughts: true
        };
    }


    payload.generationConfig = generationConfig;
    // Safety
    if (state.config.includeSafetySettings) {
        const safetySettings = [];
        Object.entries(state.config.safety).forEach(([cat, thresh]) => {
            if (!thresh || thresh === 'OFF') return;
            safetySettings.push({ category: cat, threshold: thresh });
        });
        if (safetySettings.length) payload.safetySettings = safetySettings;
    }
    // Custom JSON Merge
    let merged = payload;
    if (state.config.customJson.trim()) {
        try {
            const custom = JSON.parse(state.config.customJson);
            merged = {
                ...payload,
                ...custom,
                generationConfig: { ...payload.generationConfig, ...(custom.generationConfig || {}) },
                safetySettings: custom.safetySettings || payload.safetySettings,
            };
        } catch (e) {}
    }

    dom.configPreview.textContent = JSON.stringify(merged, null, 2);
    if (window.hljs) hljs.highlightElement(dom.configPreview);
    return merged; // Return for use in generation
}

// Image config controls
function setupImageConfigControls() {
    const sizeGroup = document.getElementById('imageSizeGroup');
    const ratioGroup = document.getElementById('aspectRatioGroup');

    if (sizeGroup) {
        sizeGroup.addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-value]');
            if (!btn) return;
            const val = btn.dataset.value;
            // 统一使用 imageSize 字段，避免总是落到默认 2K
            state.config.imageConfig = { ...(state.config.imageConfig || {}), imageSize: val };
            applyGroupActiveStyles('imageSizeGroup', val);
            updateConfigPreview();
        });
    }

    if (ratioGroup) {
        ratioGroup.addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-value]');
            if (!btn) return;
            const val = btn.dataset.value;
            state.config.imageConfig = { ...(state.config.imageConfig || {}), aspectRatio: val };
            applyGroupActiveStyles('aspectRatioGroup', val);
            updateConfigPreview();
        });
    }

    // Initialize active styles
    applyGroupActiveStyles('imageSizeGroup', state.config.imageConfig?.imageSize || state.config.imageConfig?.imagesize || '2K');
    applyGroupActiveStyles('aspectRatioGroup', state.config.imageConfig?.aspectRatio || 'auto');
}

function applyGroupActiveStyles(groupId, value) {
    const group = document.getElementById(groupId);
    if(!group) return;
    group.querySelectorAll('button[data-value]').forEach(btn => {
        const active = btn.dataset.value === String(value);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        const isAuto = btn.dataset.value === 'auto';
        const baseClasses = 'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors active:scale-95 flex items-center';
        const justifyClass = isAuto ? 'justify-center' : '';
        
        btn.className = active
            ? `${baseClasses} ${justifyClass} bg-blue-600 border-blue-500 text-white`
            : `${baseClasses} ${justifyClass} bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800`;
    });
}

function updateApiFormatUI() {
    applyGroupActiveStyles('apiFormatGroup', state.apiFormat);
    if (dom.vertexKeysContainer) {
        dom.vertexKeysContainer.classList.toggle('hidden', state.apiFormat !== 'vertex');
    }
}

// Save / Load advanced config
function saveAdvancedConfig() {
    try {
        localStorage.setItem('gem_adv_config_v4.0', JSON.stringify(state.config));
        alert('设置已保存');
    } catch(e) {
        alert('保存失败');
    }
}

function loadAdvancedConfig() {
    try {
        const raw = localStorage.getItem('gem_adv_config_v4.0');
        if (!raw) return;
        const cfg = JSON.parse(raw) || {};
        state.config = {
            ...state.config,
            ...cfg,
            safety: { ...state.config.safety, ...(cfg.safety || {}) },
            imageConfig: {
                imageSize: '2K',
                aspectRatio: 'auto',
                ...(cfg.imageConfig || {})
            }
        };

        // 兼容旧版本：如果只保存了 imagesize，则同步到 imageSize
        if (
            state.config.imageConfig &&
            !state.config.imageConfig.imageSize &&
            state.config.imageConfig.imagesize
        ) {
            state.config.imageConfig.imageSize = state.config.imageConfig.imagesize;
        }

        // Apply to UI
        const includeEl = document.getElementById('includeThoughtsCheck');
        const includeImageEl = document.getElementById('includeImageConfigCheck');
        const includeSafetyEl = document.getElementById('includeSafetySettingsCheck');
        const budgetEl = document.getElementById('thinkingBudgetRange');
        const budgetVal = document.getElementById('thinkingBudgetVal');
        if (includeEl) includeEl.checked = state.config.includeThoughts;
        if (includeImageEl) includeImageEl.checked = state.config.includeImageConfig;
        if (includeSafetyEl) includeSafetyEl.checked = state.config.includeSafetySettings;
        if (budgetEl) budgetEl.value = state.config.thinkingBudget;
        if (budgetVal) budgetVal.textContent = state.config.thinkingBudget;

        const webpRange = document.getElementById('webpQualityRange');
        const webpVal = document.getElementById('webpQualityVal');
        if (webpRange && webpVal) {
            const q = typeof state.config.webpQuality === 'number' ? state.config.webpQuality : 95;
            webpRange.value = q;
            webpVal.textContent = q;
        }

        const respCheck = document.getElementById('enableResponseModalitiesCheck');
        if (respCheck) respCheck.checked = !!state.config.useResponseModalities;

        const safetyMap = {
            safeHarassment: 'HARM_CATEGORY_HARASSMENT',
            safeHate: 'HARM_CATEGORY_HATE_SPEECH',
            safeSex: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            safeDanger: 'HARM_CATEGORY_DANGEROUS_CONTENT',
            safeCivic: 'HARM_CATEGORY_CIVIC_INTEGRITY'
        };
        Object.entries(safetyMap).forEach(([id, cat]) => {
            const el = document.getElementById(id);
            if (el && state.config.safety[cat]) el.value = state.config.safety[cat];
        });

        if (typeof state.config.customJson === 'string') {
            dom.customJsonInput.value = state.config.customJson;
        }

        applyGroupActiveStyles('imageSizeGroup', state.config.imageConfig.imageSize || state.config.imageConfig.imagesize);
        applyGroupActiveStyles('aspectRatioGroup', state.config.imageConfig.aspectRatio);
    } catch (e) {}
}

function toggleConfigModal(show) { 
    dom.configModal.classList.toggle('hidden', !show); 
    if (show && window.innerWidth < 768) toggleMobileSidebar(false); // Close sidebar on mobile
}

function switchConfigTab(tab) {
    if(tab === 'gui') {
        dom.configGuiPanel.classList.remove('hidden');
        dom.configJsonPanel.classList.add('hidden');
        dom.configJsonPanel.classList.remove('flex');
        dom.tabGuiBtn.className = "flex-1 md:flex-none px-6 py-3 text-xs font-medium text-blue-400 border-b-2 border-blue-500 bg-blue-900/10 focus:outline-none";
        dom.tabJsonBtn.className = "flex-1 md:flex-none px-6 py-3 text-xs font-medium text-gray-400 hover:text-gray-200 focus:outline-none";
    } else {
        dom.configGuiPanel.classList.add('hidden');
        dom.configJsonPanel.classList.remove('hidden');
        dom.configJsonPanel.classList.add('flex');
        dom.tabGuiBtn.className = "flex-1 md:flex-none px-6 py-3 text-xs font-medium text-gray-400 hover:text-gray-200 focus:outline-none";
        dom.tabJsonBtn.className = "flex-1 md:flex-none px-6 py-3 text-xs font-medium text-blue-400 border-b-2 border-blue-500 bg-blue-900/10 focus:outline-none";
    }
}

// --- BUILDER LOGIC ---
function syncInputToBuilder() {
    if(state.promptBuilder.length <= 1) {
        const text = dom.promptInput.value;
        if(state.promptBuilder.length === 0 && text) {
             state.promptBuilder = [{ role: 'user', text, images: [] }];
        } else if(state.promptBuilder.length === 1 && state.promptBuilder[0].role === 'user') {
            state.promptBuilder[0].text = text;
        }
    }
}

function isBuilderWorkflowActive() {
    if(state.promptBuilder.length === 0) return false;
    if(state.promptBuilder.length > 1) return true;
    if(state.systemInstruction.trim().length > 0) return true;
    return state.promptBuilder.some(msg => msg.role !== 'user' || (msg.images && msg.images.length > 0));
}

function updateUIForMode() {
    // Check if complex multi-turn
    const isComplex = isBuilderWorkflowActive();
    
    if(isComplex) {
        dom.mainMediaBtnContainer.classList.add('hidden');
        dom.builderActiveIndicator.classList.remove('hidden');
        dom.builderActiveIndicator.classList.add('flex');
        dom.promptInput.placeholder = "多轮对话模式...";
    } else {
        dom.mainMediaBtnContainer.classList.remove('hidden');
        dom.builderActiveIndicator.classList.add('hidden');
        dom.builderActiveIndicator.classList.remove('flex');
        dom.promptInput.placeholder = "输入提示词...";
    }
}

function togglePromptModal(show) {
    dom.promptModal.classList.toggle('hidden', !show);
    if(show) {
        const singleUser = state.promptBuilder.length === 1 && state.promptBuilder[0].role === 'user';
        if(state.promptBuilder.length === 0) {
            state.promptBuilder.push({ role: 'user', text: dom.promptInput.value, images: cloneImages(state.images) });
        } else if(singleUser && (!state.promptBuilder[0].images || state.promptBuilder[0].images.length === 0) && state.images.length) {
            state.promptBuilder[0].images = cloneImages(state.images);
            if(!state.promptBuilder[0].text) state.promptBuilder[0].text = dom.promptInput.value;
        }
        dom.systemInstructionInput.value = state.systemInstruction;
        renderBuilder();
    } else {
        state.systemInstruction = dom.systemInstructionInput.value;
        const singleUser = state.promptBuilder.length === 1 && state.promptBuilder[0].role === 'user';
        if(singleUser) {
            dom.promptInput.value = state.promptBuilder[0].text;
            if(!state.systemInstruction.trim()) {
                state.images = cloneImages(state.promptBuilder[0].images || []);
                state.promptBuilder = [];
                renderPreview();
            }
        }
        updateUIForMode();
    }
}

function renderBuilder() {
    dom.builderMessages.innerHTML = '';
    state.promptBuilder.forEach((msg, idx) => {
        const isUser = msg.role === 'user';
        const div = document.createElement('div');
        div.className = `group flex gap-3 md:gap-4 animate-fade-in`;
        
        // Thumbnails
        let imgsHtml = '';
        if(msg.images && msg.images.length > 0) {
            imgsHtml = `<div class="flex gap-2 mt-2 overflow-x-auto pb-1">` +
                msg.images.map((img, imgIdx) => `
                    <div class="relative w-12 h-12 flex-shrink-0 group/img ${imgIdx===0?'ring-2 ring-yellow-400 rounded':''}">
                        <img src="${img.b64}" class="w-full h-full object-cover rounded border ${imgIdx===0?'border-yellow-500':'border-gray-700'}">
                        <span class="absolute -top-1 -left-1 text-[10px] font-bold bg-black/70 text-white px-1 rounded">${imgIdx + 1}</span>
                        <button onclick="removeBuilderImage(${idx}, ${imgIdx})" class="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-100 md:opacity-0 md:group-hover/img:opacity-100 transition-opacity" title="移除"><span class="material-symbols-rounded text-[10px]">close</span></button>
                        <button onclick="setFirstBuilderImage(${idx}, ${imgIdx})" class="absolute -bottom-1 left-0 bg-yellow-600 text-white rounded-full p-0.5 opacity-100 md:opacity-0 md:group-hover/img:opacity-100 transition-opacity" title="设为第一"><span class="material-symbols-rounded text-[12px]">looks_one</span></button>
                    </div>
                `).join('') + `</div>`;
        }

        div.innerHTML = `
            <div class="w-8 flex flex-col items-center pt-2 gap-1">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center border ${isUser ? 'bg-blue-900/20 border-blue-800 text-blue-400' : 'bg-purple-900/20 border-purple-800 text-purple-400'}">
                    <span class="material-symbols-rounded text-lg">${isUser ? 'person' : 'smart_toy'}</span>
                </div>
            </div>
            <div class="flex-1 bg-[#111827] border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 transition-colors drop-zone" data-idx="${idx}">
                <div class="flex items-center justify-between px-3 py-1.5 bg-[#161b26] border-b border-gray-800">
                    <span class="text-[10px] font-bold uppercase tracking-wider ${isUser ? 'text-blue-500' : 'text-purple-500'}">
                        ${isUser ? '用户 (User)' : '模型 (Model)'}
                    </span>
                    <div class="flex items-center gap-1">
                        <button onclick="triggerBuilderUpload(${idx})" class="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-blue-400" title="Attach Image"><span class="material-symbols-rounded text-base">attachment</span></button>
                        <div class="w-px h-3 bg-gray-700 mx-1"></div>
                        <button onclick="moveBuilderMessage(${idx}, -1)" class="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300" ${idx===0?'disabled':''}><span class="material-symbols-rounded text-base">arrow_upward</span></button>
                        <button onclick="moveBuilderMessage(${idx}, 1)" class="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300" ${idx===state.promptBuilder.length-1?'disabled':''}><span class="material-symbols-rounded text-base">arrow_downward</span></button>
                        <button onclick="removeBuilderMessage(${idx})" class="p-1 hover:bg-red-900/30 rounded text-gray-500 hover:text-red-400"><span class="material-symbols-rounded text-base">delete</span></button>
                    </div>
                </div>
                <div class="p-3">
                    <textarea class="w-full bg-transparent text-sm text-gray-300 outline-none resize-none font-mono leading-relaxed min-h-[60px]" 
                        oninput="updateBuilderMessage(${idx}, this.value)"
                        placeholder="${isUser ? '输入指令...' : '输入响应...'}"
                    >${msg.text}</textarea>
                    ${imgsHtml}
                </div>
            </div>
        `;
        
        // Drag & Drop Logic for Row
        const dropZone = div.querySelector('.drop-zone');
        dropZone.addEventListener('dragover', (e) => { 
            e.preventDefault(); 
            e.stopPropagation();
            dropZone.classList.add('builder-drop-active');
        });
        dropZone.addEventListener('dragleave', (e) => { 
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('builder-drop-active');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('builder-drop-active');
            if(e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files, 'row', idx);
        });

        dom.builderMessages.appendChild(div);
        autoResize(div.querySelector('textarea'));
    });
}

window.addBuilderMessage = (role) => {
    state.promptBuilder.push({ role, text: '', images: [] });
    renderBuilder();
    dom.promptBuilderContainer.scrollTop = dom.promptBuilderContainer.scrollHeight;
};
window.removeBuilderMessage = (idx) => { state.promptBuilder.splice(idx, 1); renderBuilder(); };
window.moveBuilderMessage = (idx, dir) => {
    const temp = state.promptBuilder[idx];
    state.promptBuilder[idx] = state.promptBuilder[idx+dir];
    state.promptBuilder[idx+dir] = temp;
    renderBuilder();
};
window.updateBuilderMessage = (idx, val) => { state.promptBuilder[idx].text = val; };
window.triggerBuilderUpload = (idx) => {
    state.activeBuilderRowIdx = idx;
    dom.builderRowInput.click();
};
window.removeBuilderImage = (msgIdx, imgIdx) => {
    state.promptBuilder[msgIdx].images.splice(imgIdx, 1);
    renderBuilder();
};

// Reorder helpers: move selected image to front as "first"
function moveToFront(arr, idx) {
    if (!Array.isArray(arr) || idx <= 0 || idx >= arr.length) return;
    const [it] = arr.splice(idx, 1);
    arr.unshift(it);
}
window.setFirstGlobalImage = (idx) => {
    moveToFront(state.images, idx);
    renderPreview();
};
window.setFirstBuilderImage = (msgIdx, imgIdx) => {
    const imgs = state.promptBuilder[msgIdx]?.images;
    if (!imgs) return;
    moveToFront(imgs, imgIdx);
    renderBuilder();
};
function clearPrompt() {
    dom.promptInput.value = '';
    dom.systemInstructionInput.value = '';
    state.systemInstruction = '';
    state.promptBuilder = [];
    state.images = [];
    renderBuilder();
    renderPreview();
    updateUIForMode();
    dom.promptInput.focus();
}
function runFromModal() {
    state.systemInstruction = dom.systemInstructionInput.value;
    togglePromptModal(false);
    runBatchGeneration();
}

// --- CORE GENERATION ---
async function runBatchGeneration() {
    const key = dom.apiKey.value;
    if (state.apiFormat === 'vertex') {
        if (!vertexKeyManager.keys.length) {
            alert("需要配置 Vertex Keys（格式：API_KEY|PROJECT_ID，每行一个）");
            if (dom.vertexKeysContainer) {
                dom.vertexKeysContainer.classList.remove('hidden');
            }
            return;
        }
    } else {
        const trimmed = key.trim();
        if (!trimmed) {
            alert("需要 API 密钥");
            return;
        }
    }

    // Construct Contents
    let contents = [];
    let sysInst = null;

    const useBuilder = isBuilderWorkflowActive();
    const quickSysText = (state.quickSystemInstruction || '').trim();
    const modelPrefillText = (state.modelPrefill || '').trim();

    // If using builder state
    if (useBuilder) {
        const builderSys = (state.systemInstruction || '').trim();
        let mergedSys = '';
        if (quickSysText) mergedSys += quickSysText;
        if (builderSys) {
            if (mergedSys) mergedSys += '\n\n';
            mergedSys += builderSys;
        }
        sysInst = mergedSys ? { parts: [{ text: mergedSys }] } : null;

        contents = state.promptBuilder.map(msg => {
            const parts = [];
            if (msg.text) parts.push({ text: msg.text });
            msg.images.forEach(img => {
                parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
            });
            return { role: msg.role, parts };
        });
    } else {
        // Simple Mode
        const text = dom.promptInput.value;
        if (!text && state.images.length === 0) return;

        const parts = [];
        if (text) parts.push({ text });
        state.images.forEach(img => {
            parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
        });
        contents = [{ role: 'user', parts }];

        if (modelPrefillText) {
            contents.push({
                role: 'model',
                parts: [{ text: modelPrefillText }]
            });
        }

        sysInst = quickSysText ? { parts: [{ text: quickSysText }] } : null;
    }

    dom.emptyState.style.display = 'none';

    const count = parseInt(dom.concRange.value);
    const batchId = Date.now();
    
    // Get merged config
    let requestConfig = updateConfigPreview(); // Helper returns the config object

    // 如果本次请求中提前插入了“模型”消息（例如模型预填充或构建器中的模型轮次），
    // 且启用了思考模式（generationConfig.thinkingConfig），
    // 官方 thinking 接口会要求这些模型文本 part 上带有 thought_signature。
    // 由于这些内容是本地虚构的，我们拿不到合法的 thought_signature，这会触发
    // “Text part is missing a thought_signature ...” 400 错误。
    // 这里检测到这种情况时，仅对本次请求临时关闭 thinkingConfig，避免报错。
    try {
        const hasSyntheticModelText = contents.some(c =>
            c.role === 'model' &&
            Array.isArray(c.parts) &&
            c.parts.some(p => typeof p.text === 'string' && p.text.trim())
        );
        if (
            hasSyntheticModelText &&
            requestConfig &&
            requestConfig.generationConfig &&
            requestConfig.generationConfig.thinkingConfig
        ) {
            requestConfig = {
                ...requestConfig,
                generationConfig: { ...requestConfig.generationConfig }
            };
            delete requestConfig.generationConfig.thinkingConfig;
        }
    } catch (e) {
        console.warn('Prefill/thinking compatibility adjustment failed:', e);
    }

    const promises = [];
    for (let i = 0; i < count; i++) {
        const sessionId = `${batchId}_${i}`;
        state.sessions[sessionId] = {
            messages: JSON.parse(JSON.stringify(contents)), // Deep copy
            status: 'busy',
            timestamp: Date.now(),
            systemInstruction: sysInst
        };
        const previewText = contents.find(c => c.role === 'user')?.parts.find(p => p.text)?.text || "Image input";
        createCard(sessionId, i + 1, previewText);
        await new Promise(r => setTimeout(r, 50));
        promises.push(executeSessionTurn(sessionId, requestConfig, false));
    }

    await Promise.all(promises);
}

async function executeSessionTurn(sessionId, configOverride = null, isRetry = false) {
    const session = state.sessions[sessionId];
    const cardBody = document.getElementById(`body-${sessionId}`);
    const cardStatus = document.getElementById(`status-${sessionId}`);
    if (!session) return;

    session.status = 'busy';

    if (cardStatus) {
        if (isRetry) {
            cardStatus.className = "mr-2 flex items-center gap-1 text-[10px] text-blue-400 font-mono";
            cardStatus.innerHTML = `<span class="material-symbols-rounded text-sm">progress_activity</span> 重试中 1/${MAX_429_ATTEMPTS}`;
        } else {
            cardStatus.className = "mr-2 flex items-center gap-1 text-[10px] text-blue-400 font-mono";
            cardStatus.innerHTML = `<span class="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span> 生成中`;
        }
    }

    const base = dom.baseUrl.value.replace(/\/$/, '');
    let lastError = null;
    let wasAborted = false;

    for (let attempt = 1; attempt <= MAX_429_ATTEMPTS; attempt++) {
        try {
            const controller = new AbortController();
            session.abortController = controller;
            let url, headers, body;

            if (state.apiFormat === 'openai') {
                // --- OpenAI Payload & Request ---
                const ver = dom.apiVersion.value.trim();
                url = `${base}/${ver}/chat/completions`;
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${dom.apiKey.value}`
                };

                const oaiMessages = [];
                if (session.systemInstruction) {
                    oaiMessages.push({ role: 'system', content: session.systemInstruction.parts.map(p => p.text).join('') });
                }

                // 在发送给 OpenAI 之前，同样走一遍 prepareMessagesForRequest：
                //  - 统一对 inline_data 做 WebP 压缩
                //  - 过滤掉思维链摘要 / Tool Code 文本，只保留正文部分
                const preparedMessages = await prepareMessagesForRequest(session.messages);

                preparedMessages.forEach(msg => {
                    const role = msg.role === 'model' ? 'assistant' : 'user';
                    const content = [];
                    (msg.parts || []).forEach(part => {
                        if (part.text) {
                            content.push({ type: 'text', text: part.text });
                        }

                        // 内联图片（包括 user 上传和 AI 回复里的图片）
                        const inlineData = getInlineData(part);
                        if (inlineData && inlineData.data) {
                            const mime = inlineData.mime_type || inlineData.mimeType || 'image/png';
                            const data = normalizeBase64(inlineData.data);
                            content.push({
                                type: 'image_url',
                                image_url: { url: `data:${mime};base64,${data}` }
                            });
                        }

                        // 远程 / 文件形式图片（file_data）
                        const fileData = part.file_data || part.fileData;
                        if (fileData && fileData.file_uri && !isLocalFileUri(fileData.file_uri)) {
                            content.push({
                                type: 'image_url',
                                image_url: { url: fileData.file_uri }
                            });
                        }
                    });
                    oaiMessages.push({ role, content });
                });
                
                const mergedConfig = configOverride || updateConfigPreview();

                // 根据 baseUrl 判断是否为官方 OpenAI 端点
                const baseHost = dom.baseUrl.value
                    .trim()
                    .replace(/^https?:\/\//, '')
                    .split('/')[0]
                    .toLowerCase();
                const isOfficialOpenAI = baseHost === 'api.openai.com';

                const payload = {
                    model: dom.modelId.value,
                    messages: oaiMessages,
                    // 保持与 OpenAI 官方接口兼容的顶层 temperature
                    temperature: mergedConfig.generationConfig
                        ? mergedConfig.generationConfig.temperature
                        : 1.0
                };

                // 对非官方 OpenAI 端点（自建中转/聚合服务），附带高级配置（安全设置 & 图像参数等）
                if (!isOfficialOpenAI) {
                    Object.assign(payload, mergedConfig);
                }

                body = JSON.stringify(payload);
                session.lastRaw = { req: payload };

            } else if (state.apiFormat === 'vertex') {
                // --- Vertex (AIPLATFORM) Payload & Request ---
                const ver = dom.apiVersion.value.trim() || 'v1beta1';
                const model = dom.modelId.value.trim();
                const creds = vertexKeyManager.getNext();
                if (!creds) {
                    throw new Error('Vertex: 未配置 Keys（格式：API_KEY|PROJECT_ID）');
                }
                const location = 'us-central1';
                const publisher = 'google';

                url = `${base}/${ver}/projects/${creds.projectId}/locations/${location}/publishers/${publisher}/models/${model}:streamGenerateContent?key=${creds.key}`;
                headers = { 'Content-Type': 'application/json' };

                const payload = configOverride || updateConfigPreview();
                payload.contents = await prepareMessagesForRequest(session.messages);
                if (session.systemInstruction) payload.systemInstruction = session.systemInstruction;

                // 强制覆盖 Vertex 的安全设置，使用完整的列表以避免报错并绕过审查
                payload.safetySettings = [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_IMAGE_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'BLOCK_NONE' }
                ];

                body = JSON.stringify(payload);
                session.lastRaw = { req: payload, vertexProjectId: creds.projectId };

            } else {
                // --- Gemini Payload & Request ---
                const ver = dom.apiVersion.value.trim();
                let model = dom.modelId.value.trim();
                if (!model.startsWith('models/')) model = `models/${model}`;

                // 根据 Host 判断是直连官方 Gemini 还是通过代理（如 newapi）
                const baseHost = dom.baseUrl.value
                    .trim()
                    .replace(/^https?:\/\//, '')
                    .split('/')[0]
                    .toLowerCase();

                if (baseHost === 'generativelanguage.googleapis.com') {
                    // 官方端点：使用 ?key=AI... 方式鉴权
                    url = `${base}/${ver}/${model}:generateContent?key=${dom.apiKey.value}`;
                    headers = { 'Content-Type': 'application/json' };
                } else {
                    // 代理 / 网关（例如 newapi）：走 Authorization 头，避免把代理密钥当作 Google key
                    url = `${base}/${ver}/${model}:generateContent`;
                    headers = {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${dom.apiKey.value}`
                    };
                }

                const basePayload = configOverride || updateConfigPreview();
                const preparedContents = await prepareMessagesForRequest(session.messages);
                const { generationConfig, safetySettings, ...rest } = basePayload || {};

                // 严格组织顶层字段顺序：contents → tools/自定义字段 → generationConfig → safetySettings → systemInstruction
                const finalPayload = {
                    contents: preparedContents,
                    ...rest
                };
                if (generationConfig) finalPayload.generationConfig = generationConfig;
                if (safetySettings) finalPayload.safetySettings = safetySettings;
                if (session.systemInstruction) finalPayload.systemInstruction = session.systemInstruction;

                body = JSON.stringify(finalPayload);
                session.lastRaw = { req: finalPayload };
            }

            const startTime = performance.now();
            const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
            const status = res.status;
            
            // 增强的错误处理和响应解析
            let data;
            const contentType = res.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                try {
                    data = await res.json();
                } catch (e) {
                    throw new Error(`Failed to parse JSON response: ${e.message}`);
                }
            } else {
                const text = await res.text();
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    throw new Error(`API returned non-JSON response (${status}): ${text.substring(0, 200)}...`);
                }
            }

            const duration = ((performance.now() - startTime) / 1000).toFixed(1);
            session.lastRaw.res = data;

            if (!res.ok) {
                const errorMsg = data.error?.message || JSON.stringify(data.error) || `API Error ${status}`;
                if (status === 429 && attempt < MAX_429_ATTEMPTS) {
                    if (cardStatus) {
                        const nextAttempt = attempt + 1;
                        cardStatus.className = "mr-2 flex items-center gap-1 text-[10px] text-yellow-400 font-mono";
                        cardStatus.innerHTML = `<span class="material-symbols-rounded text-sm">schedule</span> 重试中 ${nextAttempt}/${MAX_429_ATTEMPTS}（429，等待重试）`;
                    }
                    const retryAfterHeader = res.headers.get('retry-after');
                    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
                    const delayMs = (!Number.isNaN(retryAfter) && retryAfter > 0)
                        ? retryAfter * 1000
                        : RETRY_BASE_DELAY_MS * attempt;
                    await sleep(delayMs);
                    continue;
                }
                throw new Error(errorMsg);
            }

            let newContent;
            if (state.apiFormat === 'openai') {
                const choice = data.choices?.[0];
                if (choice && choice.message) {
                    const parts = [];
                    const content = choice.message.content;

                    if (Array.isArray(content)) {
                        content.forEach(part => {
                            if (part.type === 'text') {
                                parts.push({ text: part.text || '' });
                            } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
                                const url = part.image_url.url;
                                try {
                                    if (url.startsWith('data:')) {
                                        const [meta, base64Data] = url.split(';base64,');
                                        const mimeMatch = meta && meta.match(/^data:(.*)$/);
                                        const mime = (mimeMatch && mimeMatch[1]) || 'image/png';
                                        parts.push({
                                            inline_data: {
                                                mime_type: mime,
                                                data: base64Data || ''
                                            }
                                        });
                                    } else {
                                        parts.push({
                                            file_data: {
                                                mime_type: 'image/png',
                                                file_uri: url
                                            }
                                        });
                                    }
                                } catch (err) {
                                    console.warn('Failed to parse OpenAI image_url content', err);
                                }
                            }
                        });
                    } else if (typeof content === 'string') {
                        const regex = /!\[.*?\]\((.*?)\)/g;
                        let lastIndex = 0;
                        let match;

                        while ((match = regex.exec(content)) !== null) {
                            if (match.index > lastIndex) {
                                parts.push({ text: content.substring(lastIndex, match.index) });
                            }
                            const imageUrl = match[1];
                            if (imageUrl.startsWith('data:')) {
                                const [mime_type, base64_data] = imageUrl.substring(5).split(';base64,');
                                parts.push({ inline_data: { mime_type, data: base64_data } });
                            } else {
                                parts.push({ file_data: { mime_type: 'image/png', file_uri: imageUrl } });
                            }
                            lastIndex = regex.lastIndex;
                        }

                        if (lastIndex < content.length) {
                            parts.push({ text: content.substring(lastIndex) });
                        }
                    }

                    newContent = { role: 'model', parts };
                }
            } else {
                // 兼容 Vertex streamGenerateContent 返回的数组结构
                // 或者是 Gemini generateContent 返回的对象结构
                const chunks = Array.isArray(data) ? data : [data];
                const parts = [];
                
                for (const chunk of chunks) {
                    const candidate = chunk.candidates?.[0];
                    if (candidate && candidate.content && candidate.content.parts) {
                        parts.push(...candidate.content.parts);
                    }
                }
                
                if (parts.length > 0) {
                    newContent = { role: 'model', parts };
                }
            }

            if (newContent) {
                session.messages.push(newContent);
                if (state.activeSessionId === sessionId) {
                    renderChatMessage('model', newContent.parts);
                }
                renderCardPreview(sessionId);
                if (cardStatus) {
                    cardStatus.className = "mr-2 flex items-center gap-1 text-[10px] text-green-400 font-mono";
                    const attemptInfo = attempt > 1 ? ` · 重试${attempt}次` : "";
                    cardStatus.innerHTML = `<span class="material-symbols-rounded text-sm">check_circle</span> ${duration}s${attemptInfo}`;
                }
                disableStopButton(sessionId);
                session.status = 'idle';
                session.abortController = null;
                persistGeneratedImagesInSession(sessionId).catch(() => {});
                return;
            } else {
                throw new Error(state.apiFormat === 'openai' ? "No valid choice in response" : "No content in response");
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                wasAborted = true;
                break;
            }
            lastError = e;
            break;
        }
    }

    if (wasAborted) {
        session.abortController = null;
        session.status = 'idle';
        return;
    }

    if (cardBody) {
        cardBody.innerHTML = `<div class="p-3 bg-red-900/20 border border-red-800 rounded text-red-200 text-xs font-mono">${lastError && lastError.message ? lastError.message : '请求失败'}</div>`;
    }
    if (cardStatus) {
        cardStatus.className = "mr-2 flex items-center gap-1 text-[10px] text-red-400 font-mono";
        cardStatus.innerHTML = `<span class="material-symbols-rounded text-sm">error</span> 错误`;
    }
    disableStopButton(sessionId);
    session.status = 'idle';
    session.abortController = null;
}

function getSessionPromptSummary(session) {
    if (!session?.messages) return '';
    const lastUser = [...session.messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const text = (lastUser.parts || []).map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim();
    return text.slice(0, 200);
}

async function persistHistorySession(sessionId) {
    if (!isAuthed()) return;
    const session = state.sessions[sessionId];
    if (!session) return;

    const images = [];
    (session.messages || []).forEach(msg => {
        if (msg.role !== 'model') return;
        (msg.parts || []).forEach(part => {
            const fileData = part.file_data || part.fileData;
            if (fileData?.file_uri) images.push(fileData.file_uri);
        });
    });

    const entry = {
        id: sessionId,
        timestamp: session.timestamp || Date.now(),
        prompt: getSessionPromptSummary(session),
        images,
        model: dom.modelId?.value || '',
        apiFormat: state.apiFormat || 'gemini'
    };

    try {
        await apiFetchJson('/api/history/sessions/add', { method: 'POST', json: { entry } });
    } catch (e) {
        console.warn('写入历史记录失败（可忽略）:', e);
    }
}

async function persistGeneratedImagesInSession(sessionId) {
    if (!isAuthed()) return;
    const session = state.sessions[sessionId];
    if (!session) return;

    const inlineJobs = [];
    const remoteJobs = [];
    const partRefs = []; // aligned to inlineJobs + remoteJobs

    (session.messages || []).forEach(msg => {
        if (msg.role !== 'model') return;
        (msg.parts || []).forEach(part => {
            const inlineData = getInlineData(part);
            if (inlineData?.data) {
                const mime = inlineData.mime_type || inlineData.mimeType || 'image/png';
                inlineJobs.push({ dataUrl: `data:${mime};base64,${normalizeBase64(inlineData.data)}` });
                partRefs.push(part);
                return;
            }
            const fileData = part.file_data || part.fileData;
            if (fileData?.file_uri && isHttpUrl(fileData.file_uri) && !isLocalFileUri(fileData.file_uri)) {
                remoteJobs.push({ url: fileData.file_uri });
                partRefs.push(part);
            }
        });
    });

    if (!inlineJobs.length && !remoteJobs.length) return;

    try {
        if (inlineJobs.length) {
            const res = await apiFetchJson('/api/images/save-batch', { method: 'POST', json: { kind: 'generated', images: inlineJobs } });
            const items = Array.isArray(res.items) ? res.items : [];
            for (let i = 0; i < items.length; i++) {
                const stored = items[i];
                const part = partRefs[i];
                if (!stored?.fileUri || !part) continue;
                part.file_data = { mime_type: stored.mime || 'image/png', file_uri: stored.fileUri };
                delete part.fileData;
                delete part.inline_data;
                delete part.inlineData;
                delete part.inLineData;
            }
        }

        if (remoteJobs.length) {
            for (let j = 0; j < remoteJobs.length; j++) {
                const part = partRefs[inlineJobs.length + j];
                const url = remoteJobs[j].url;
                try {
                    const stored = await apiFetchJson('/api/images/fetch', { method: 'POST', json: { kind: 'generated', url } });
                    if (stored?.fileUri && part) {
                        part.file_data = { mime_type: stored.mime || 'image/png', file_uri: stored.fileUri };
                        delete part.fileData;
                    }
                } catch (e) {
                    console.warn('拉取远程生成图失败（可忽略）:', url, e);
                }
            }
        }

        renderCardPreview(sessionId);
        if (state.activeSessionId === sessionId) {
            // 轻量更新：只刷新最后一次模型输出
            const lastModel = [...(session.messages || [])].reverse().find(m => m.role === 'model');
            if (lastModel) renderChatMessage('model', lastModel.parts);
        }

        await persistHistorySession(sessionId);
    } catch (e) {
        console.warn('保存模型生成图片失败（可忽略）:', e);
    }
}

async function retrySession(id) {
    const session = state.sessions[id];
    if (!session) return;
    const bodyEl = document.getElementById(`body-${id}`);
    const statusEl = document.getElementById(`status-${id}`);
    if (bodyEl) {
        bodyEl.innerHTML = `<div class="p-3 bg-blue-900/20 border border-blue-800 rounded text-blue-200 text-xs font-mono">重试中 1/${MAX_429_ATTEMPTS}...</div>`;
    }
    if (statusEl) {
        statusEl.className = "mr-2 flex items-center gap-1 text-[10px] text-blue-400 font-mono";
        statusEl.innerHTML = `<span class="material-symbols-rounded text-sm">progress_activity</span> 重试中 1/${MAX_429_ATTEMPTS}`;
    }
    await executeSessionTurn(id, null, true);
}

// --- UI COMPONENTS ---
function createCard(id, index, prompt) {
    const card = document.createElement('div');
    const isBusy = state.sessions[id]?.status === 'busy';
    const stopBtnDisabledAttr = isBusy ? '' : 'disabled';
    const stopBtnExtraClasses = isBusy ? '' : ' opacity-40 cursor-not-allowed';
    const sizeClass = state.cardSize === 'sm'
        ? 'card-size-sm'
        : state.cardSize === 'lg'
            ? 'card-size-lg'
            : 'card-size-md';
    card.className = `glass-panel rounded-xl flex flex-col relative shadow-xl animate-slide-in group border-gray-800 transition-all duration-200 ${sizeClass}`;
    card.id = `card-${id}`;
    card.innerHTML = `
        <div class="session-card-header bg-gray-900/80 border-b border-gray-800 px-3 rounded-t-xl relative z-10">
            <div class="session-card-header-left flex items-center gap-3">
                <input type="checkbox" class="custom-checkbox" onchange="toggleSelection('${id}', this.checked)">
                <div class="flex items-center gap-2 overflow-hidden">
                    <span class="text-[10px] font-bold text-gray-500 bg-gray-800 px-2 py-0.5 rounded">#${index}</span>
                    <span class="text-xs text-gray-300 truncate font-medium max-w-[80px] md:max-w-[120px]" title="${prompt}">${prompt.substring(0,30)}...</span>
                </div>
            </div>
            <div class="session-card-header-right flex items-center gap-1">
                <div id="status-${id}" class="mr-2 flex items-center gap-1 text-[10px] text-blue-400 font-mono"><span class="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span> 生成中</div>
                <button onclick="openChat('${id}')" class="p-1.5 text-gray-400 hover:text-purple-400 hover:bg-purple-900/20 rounded transition-colors active:scale-95"><span class="material-symbols-rounded text-lg">chat</span></button>
                <button onclick="viewRaw('${id}')" class="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors active:scale-95"><span class="material-symbols-rounded text-lg">data_object</span></button>
                <button id="stop-${id}" onclick="stopSession('${id}')" ${stopBtnDisabledAttr} class="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors active:scale-95${stopBtnExtraClasses}" title="停止生成"><span class="material-symbols-rounded text-lg">stop_circle</span></button>
                <button onclick="retrySession('${id}')" class="p-1.5 text-gray-400 hover:text-orange-400 hover:bg-orange-900/20 rounded transition-colors active:scale-95" title="重试此对话"><span class="material-symbols-rounded text-lg">refresh</span></button>
                <button onclick="deleteSession('${id}')" class="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors active:scale-95"><span class="material-symbols-rounded text-lg">delete</span></button>
            </div>
        </div>
        <div id="body-${id}" class="flex-1 overflow-y-auto p-4 md:p-5 prose prose-invert prose-sm max-w-none text-gray-300 custom-scrollbar">
             <div class="space-y-4 opacity-30 animate-pulse"><div class="h-2 bg-gray-500 rounded w-3/4"></div><div class="h-2 bg-gray-500 rounded w-1/2"></div></div>
        </div>
        <div id="overlay-${id}" class="absolute inset-0 bg-blue-500/10 border-2 border-blue-500 rounded-xl pointer-events-none opacity-0 transition-opacity z-0"></div>
    `;
    dom.grid.prepend(card);
    updateGridLayout();
}

function applyCardSize(size) {
    if (!['sm', 'md', 'lg'].includes(size)) size = 'md';
    state.cardSize = size;
    try {
        localStorage.setItem('gem_card_size', size);
    } catch (e) {}
    const cards = document.querySelectorAll('#gridContainer > .glass-panel');
    cards.forEach(card => {
        card.classList.remove('card-size-sm', 'card-size-md', 'card-size-lg');
        card.classList.add(
            size === 'sm' ? 'card-size-sm' :
            size === 'lg' ? 'card-size-lg' :
            'card-size-md'
        );
    });
    updateGridLayout();
    updateCardSizeToggleUI();
}

// 更细颗粒度控制：通过滑块调节一行中卡片的密度（列数）
function applyCardDensity(level) {
    let density = parseInt(level, 10);
    if (!Number.isFinite(density) || density < 1 || density > 5) density = 3;
    state.cardDensity = density;
    try {
        localStorage.setItem('gem_card_density', String(density));
    } catch (e) {}
    if (dom.cardDensityRange && dom.cardDensityRange.value !== String(density)) {
        dom.cardDensityRange.value = String(density);
    }
    updateGridLayout();
}

function updateGridLayout() {
    const gridEl = dom.grid;
    if (!gridEl) return;
    const d = state.cardDensity || 3;
    // 根据密度级别设置列数：1(最稀) - 5(最密)
    let className;
    switch (d) {
        case 1:
            // 更大卡片，列数少
            className = "grid grid-cols-1 gap-5 md:gap-6 max-w-[1400px] mx-auto";
            break;
        case 2:
            className = "grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-5 max-w-[1600px] mx-auto";
            break;
        case 3:
            className = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 md:gap-5 max-w-[2000px] mx-auto";
            break;
        case 4:
            className = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4 max-w-[2200px] mx-auto";
            break;
        case 5:
        default:
            // 最紧凑：尽量多列
            className = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 md:gap-4 max-w-[2400px] mx-auto";
            break;
    }
    gridEl.className = className;
}

function updateCardSizeToggleUI() {
    const wrap = dom.cardSizeToggle;
    if (!wrap) return;
    const size = state.cardSize;
    wrap.querySelectorAll('button[data-size]').forEach(btn => {
        const active = btn.dataset.size === size;
        btn.className = active
            ? "px-2 md:px-3 py-1 bg-blue-600 text-white text-[10px] font-medium"
            : "px-2 md:px-3 py-1 text-[10px] text-gray-400 hover:text-gray-100 hover:bg-gray-700/70";
    });
}

// --- LIBRARY (CHATS & PRESETS) ---
function toggleCollectionsModal(show) {
    dom.collectionsModal.classList.toggle('hidden', !show);
    if(show) renderLibrary();
}
function switchLibraryTab(tab) {
    activeLibraryTab = tab;
    ['presets', 'chats', 'collections'].forEach(t => {
        const btn = dom[`tab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`];
        if (btn) {
            btn.className = tab === t
                ? "flex-1 md:flex-none px-6 py-3 text-xs font-medium text-blue-400 border-b-2 border-blue-500 bg-blue-900/10 focus:outline-none"
                : "flex-1 md:flex-none px-6 py-3 text-xs font-medium text-gray-400 hover:text-gray-200 focus:outline-none";
        }
    });
    renderLibrary();
}
function renderLibrary() {
    dom.libraryList.innerHTML = '';
    const items = activeLibraryTab === 'presets' ? state.presets : (activeLibraryTab === 'chats' ? state.savedChats : state.collections);
    
    if(items.length === 0) {
        dom.libraryList.innerHTML = '<div class="text-center text-gray-500 py-10">没有找到项目。</div>';
        return;
    }

    items.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = "flex items-center justify-between p-3 hover:bg-gray-800/50 rounded-lg border border-transparent hover:border-gray-700 transition-all group mb-2";
        
        const icon = activeLibraryTab === 'presets' ? 'bookmark' : (activeLibraryTab === 'chats' ? 'chat' : 'collections_bookmark');
        let info;
        if (activeLibraryTab === 'presets') {
            info = `${item.promptBuilder?.length || 0} 轮 • ${new Date(item.id).toLocaleDateString()}`;
        } else if (activeLibraryTab === 'chats') {
            info = `${item.messages.length} 条消息 • ${new Date(item.timestamp).toLocaleDateString()}`;
        } else { // collections
            info = `${item.sessions?.length || 0} 个对话 • ${new Date(item.id).toLocaleDateString()}`;
        }

        div.innerHTML = `
            <div class="flex items-center gap-3 overflow-hidden">
                <div class="w-8 h-8 bg-blue-900/20 rounded-md flex items-center justify-center text-blue-400 border border-blue-900/30">
                    <span class="material-symbols-rounded">${icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <h4 class="text-sm font-bold text-gray-200 truncate">${item.name}</h4>
                    <p class="text-[10px] text-gray-500 truncate">${info}</p>
                </div>
            </div>
            <div class="flex items-center gap-2 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="loadLibraryItem(${idx})" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded shadow-lg font-medium active:scale-95">加载</button>
                <button onclick="deleteLibraryItem(${idx})" class="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors active:scale-95"><span class="material-symbols-rounded text-lg">delete</span></button>
            </div>
        `;
        dom.libraryList.appendChild(div);
    });
}

async function trySaveFavorite(type, item) {
    if (!isAuthed()) return null;
    const res = await apiFetchJson('/api/favorites/add', { method: 'POST', json: { type, item } });
    return res?.item || null;
}

async function savePreset() {
    const name = prompt("预设名称:");
    if(!name) return;
    const preset = { 
        id: Date.now(), 
        name, 
        promptBuilder: clonePromptBuilder(state.promptBuilder), 
        systemInstruction: state.systemInstruction, 
        images: cloneImages(state.images) 
    };
    if(state.promptBuilder.length === 0 && dom.promptInput.value) {
        preset.promptBuilder = [{role:'user', text: dom.promptInput.value, images: cloneImages(state.images)}];
    }

    if (isAuthed()) {
        try {
            const stored = await trySaveFavorite('presets', preset);
            if (stored) {
                state.presets.unshift(stored);
                alert("已保存到服务器收藏!");
                return;
            }
        } catch (e) {
            console.warn('保存预设到服务器失败，将回退到本地:', e);
        }
    }

    state.presets.unshift(preset);
    localStorage.setItem('gem_presets_v3.7', JSON.stringify(state.presets));
    alert("已保存!");
}

async function saveCurrentSessionToLibrary() {
    if (!state.activeSessionId) return;
    const session = state.sessions[state.activeSessionId];
    const name = prompt("保存对话为:", "对话 " + new Date().toLocaleTimeString());
    if (!name) return;

    const chatItem = {
        id: Date.now(),
        timestamp: Date.now(),
        name,
        // 服务器端会把 inline_data 落盘为 file_uri，从而实现“收藏包含图片”且不占 localStorage 配额
        messages: session.messages || [],
        systemInstruction: session.systemInstruction
    };

    if (isAuthed()) {
        try {
            const stored = await trySaveFavorite('chats', chatItem);
            if (stored) {
                state.savedChats.unshift(stored);
                alert("对话已保存到服务器收藏!");
            }
        } catch (e) {
            console.warn('保存对话到服务器失败，将回退到本地:', e);
        }
    }

    if (!isAuthed()) {
        try {
            // 本地保存：轻量化处理，避免 localStorage 配额问题
            const safeMessages = makeMessagesStorageSafe(session.messages || []);
            state.savedChats.unshift({ ...chatItem, messages: safeMessages });
            localStorage.setItem('gem_chats_v3.7', JSON.stringify(state.savedChats));
            alert("对话已保存至库!");
        } catch (e) {
            console.error('保存对话失败', e);
            state.savedChats.shift();
            alert('保存对话失败：本地存储空间可能不足，请导出或清理旧记录后重试。');
        }
    }

    // 自动导出当前对话相关图片为 ZIP（包含 save image 文件夹）
    const safeBaseName = (name || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || `chat_${chatItem.id}`;
    exportImagesForSessions([state.activeSessionId], `chat_${safeBaseName}`).catch(err => console.error('导出对话图片失败', err));
}

async function loadLibraryItem(idx) {
    if (activeLibraryTab === 'presets') {
        const p = state.presets[idx];
        state.promptBuilder = clonePromptBuilder(p.promptBuilder || []);
        state.systemInstruction = p.systemInstruction || '';
        state.images = cloneImages(p.images || []);
        // 服务器收藏里的图片可能只保留 file_uri，需要在运行前补全为 inline_data
        await hydrateImagesInPlace(state.images);
        for (const msg of state.promptBuilder) {
            await hydrateImagesInPlace(msg.images || []);
        }
        renderPreview();
        toggleCollectionsModal(false);
        togglePromptModal(true);
    } else if (activeLibraryTab === 'chats') {
        const c = state.savedChats[idx];
        const newId = `restored_${Date.now()}`;
        state.sessions[newId] = {
            messages: JSON.parse(JSON.stringify(c.messages)),
            status: 'idle',
            timestamp: Date.now(),
            systemInstruction: c.systemInstruction
        };
        toggleCollectionsModal(false);
        createCard(newId, 0, `已恢复: ${c.name}`);
        renderCardPreview(newId);
        document.getElementById(`status-${newId}`).innerHTML = `<span class="text-gray-500">已恢复</span>`;
    } else { // collections
        const collection = state.collections[idx];
        if (!collection || !collection.sessions) return;
        toggleCollectionsModal(false);

        // 如果包含资源包，先解包以恢复 inline_data
        const restoredSessions = Array.isArray(collection.assets)
            ? unpackCollectionSessions(collection)
            : collection.sessions;

        restoredSessions.forEach((sessionData, i) => {
            const newId = `restored_${Date.now()}_${i}`;
            state.sessions[newId] = {
                messages: JSON.parse(JSON.stringify(sessionData.messages)),
                status: 'idle',
                timestamp: sessionData.timestamp,
                systemInstruction: sessionData.systemInstruction
            };
            createCard(newId, i + 1, `合集: ${collection.name} #${i + 1}`);
            renderCardPreview(newId);
            document.getElementById(`status-${newId}`).innerHTML = `<span class="text-gray-500">已恢复</span>`;
        });
    }
}

async function deleteLibraryItem(idx) {
    if(!confirm("确认删除项目?")) return;
    if (isAuthed()) {
        const list = activeLibraryTab === 'presets' ? state.presets : (activeLibraryTab === 'chats' ? state.savedChats : state.collections);
        const item = list[idx];
        if (item?.id != null) {
            try {
                await apiFetchJson(`/api/favorites/${activeLibraryTab}/${encodeURIComponent(String(item.id))}`, { method: 'DELETE' });
            } catch (e) {
                console.warn('服务器删除失败（将仅删除本地视图）:', e);
            }
        }
    }

    if (activeLibraryTab === 'presets') {
        state.presets.splice(idx, 1);
        if (!isAuthed()) localStorage.setItem('gem_presets_v3.7', JSON.stringify(state.presets));
    } else if (activeLibraryTab === 'chats') {
        state.savedChats.splice(idx, 1);
        if (!isAuthed()) localStorage.setItem('gem_chats_v3.7', JSON.stringify(state.savedChats));
    } else { // collections
        state.collections.splice(idx, 1);
        if (!isAuthed()) localStorage.setItem('gem_collections_v1.0', JSON.stringify(state.collections));
    }
    renderLibrary();
}

function exportLibrary() {
    const data = { version: "4.0", presets: state.presets, chats: state.savedChats, collections: state.collections };
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gemini_library_${Date.now()}.json`;
    a.click();
}

function importLibrary() { dom.importLibFile.click(); }
function handleLibraryImport(e) {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const json = JSON.parse(ev.target.result);
            if(json.presets) state.presets = [...json.presets, ...state.presets];
            if(json.chats) state.savedChats = [...json.chats, ...state.savedChats];
            if(json.collections) state.collections = [...json.collections, ...state.collections];
            localStorage.setItem('gem_presets_v3.7', JSON.stringify(state.presets));
            localStorage.setItem('gem_chats_v3.7', JSON.stringify(state.savedChats));
            localStorage.setItem('gem_collections_v1.0', JSON.stringify(state.collections));
            renderLibrary();
            alert("导入成功!");
        } catch(e) { alert("无效的 JSON"); }
    };
    reader.readAsText(file);
}

// --- HELPER FUNCTIONS (Existing Logic) ---
function autoResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
function handlePromptKeydown(e) { if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runBatchGeneration(); } }
function togglePassword() { dom.apiKey.type = dom.apiKey.type === 'password' ? 'text' : 'password'; }

// Theme toggle
function updateThemeToggleIcon() {
    const isDark = document.documentElement.classList.contains('dark');
    
    // Desktop
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
        const icon = btn.querySelector('span.material-symbols-rounded');
        if (icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
        btn.title = isDark ? '切换为白色主题' : '切换为黑色主题';
    }

    // Mobile
    const mobileBtn = document.getElementById('mobileThemeToggleBtn');
    if (mobileBtn) {
        const icon = mobileBtn.querySelector('span.material-symbols-rounded');
        if (icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
        // mobileBtn.textContent updates might be needed if text changes, but here we just change icon
    }
}
function toggleTheme() {
    const isDarkNow = document.documentElement.classList.toggle('dark');
    localStorage.setItem('gem_theme', isDarkNow ? 'dark' : 'light');
    updateThemeToggleIcon();
}

// Black & White toggle
function updateBWToggleIcon() {
    const isBW = document.documentElement.classList.contains('bw');

    // Desktop
    const btn = document.getElementById('bwToggleBtn');
    if (btn) {
        const icon = btn.querySelector('span.material-symbols-rounded');
        if (icon) icon.textContent = isBW ? 'invert_colors_off' : 'invert_colors';
        btn.title = isBW ? '切换为彩色界面' : '切换为黑白界面';
    }

    // Mobile
    const mobileBtn = document.getElementById('mobileBwToggleBtn');
    if (mobileBtn) {
        const icon = mobileBtn.querySelector('span.material-symbols-rounded');
        if (icon) icon.textContent = isBW ? 'invert_colors_off' : 'invert_colors';
    }
}
function toggleBW() {
    const isBWNow = document.documentElement.classList.toggle('bw');
    localStorage.setItem('gem_bw', isBWNow ? '1' : '0');
    updateBWToggleIcon();
}

function renderContentParts(container, parts) {
    if(!parts) return;

    const lastImageIndexes = getLastImageIndexes(parts);
    const renderImage = (src) => {
        const imgDiv = document.createElement('div');
        imgDiv.className = "mt-3 relative group cursor-zoom-in";
        imgDiv.onclick = () => openLightbox(src);
        imgDiv.innerHTML = `
            <img src="${src}" class="rounded-lg border border-gray-700 w-full object-contain max-h-[400px] bg-black/20 transition-transform group-hover:brightness-110">
            <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                <span class="bg-black/70 text-white px-3 py-1.5 rounded-full text-xs backdrop-blur flex items-center gap-1">
                    <span class="material-symbols-rounded text-sm">zoom_in</span>
                    点击放大
                </span>
            </div>
        `;
        container.appendChild(imgDiv);
    };

    parts.forEach((part, idx) => {
        if (part && typeof part.text === 'string' && part.text.length) {
            const d = document.createElement('div');
            // 优先使用 thought 标记来识别“思维链摘要”，对用户折叠展示
            if (part.thought === true) {
                d.innerHTML = `
                    <details class="text-xs text-gray-500 my-2">
                        <summary class="cursor-pointer">查看思维过程</summary>
                        <div class="prose prose-sm max-w-none prose-invert">${marked.parse(part.text)}</div>
                    </details>
                `;
            }
            // 兼容旧版仅通过文本特征识别思维链内容的逻辑
            else if (part.text.startsWith(" pensée")) {
                const thoughtContent = part.text.substring(" pensée".length).trim();
                d.innerHTML = `
                    <details class="text-xs text-gray-500 my-2">
                        <summary class="cursor-pointer">查看思维过程</summary>
                        <div class="prose prose-sm max-w-none prose-invert">${marked.parse(thoughtContent)}</div>
                    </details>
                `;
            } else if (part.text.includes("Tool Code:")) {
                d.innerHTML = `
                    <details class="text-xs text-gray-500 my-2">
                        <summary class="cursor-pointer">查看思维过程</summary>
                        <div class="prose prose-sm max-w-none prose-invert">${marked.parse(part.text)}</div>
                    </details>
                `;
            } else {
                d.innerHTML = marked.parse(part.text);
            }
            d.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
            container.appendChild(d);
        }

        const src = getPartImageSource(part);
        if(lastImageIndexes.has(idx) && src) {
            renderImage(src);
        }
    });
}

function escapeHtml(str = '') {
    return str.replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char] || char));
}

function truncateText(str = '', limit = 600) {
    if(str.length <= limit) return str;
    return str.slice(0, limit).trim() + '…';
}

function buildPreviewFromParts(parts = []) {
    const chunks = [];
    const orderedKeys = [];
    const imageMap = new Map();

    parts.forEach(part => {
        if (part && typeof part.text === 'string' && part.text.length) {
            const rawText = part.text;
            // 与 renderContentParts 保持一致：思维链内容不参与卡片预览文案
            const isThought =
                part.thought === true ||
                rawText.startsWith(" pens&#233;e") ||
                rawText.includes("Tool Code:");
            if (!isThought) {
                const trimmed = rawText.trim();
                if (trimmed) chunks.push(trimmed);
            }
        }

        const key = getPartImageKey(part);
        const src = getPartImageSource(part);
        if(key && src) {
            if(imageMap.has(key)) {
                const idx = orderedKeys.indexOf(key);
                if(idx !== -1) orderedKeys.splice(idx, 1);
            }
            orderedKeys.push(key);
            imageMap.set(key, src);
        }
    });

    const finalImages = orderedKeys.map(key => imageMap.get(key)).filter(Boolean);

    return { text: chunks.join('\n\n').trim(), hasImages: finalImages.length > 0, images: finalImages };
}

function renderCardPreview(sessionId) {
    const session = state.sessions[sessionId];
    const cardBody = document.getElementById(`body-${sessionId}`);
    if (!session || !cardBody) return;

    const modelMessages = session.messages.filter(m => m.role !== 'user');
    if (modelMessages.length === 0) {
        cardBody.innerHTML = `<div class="text-gray-500 text-xs font-mono">等待 AI 回复...</div>`;
        return;
    }

    const latest = modelMessages[modelMessages.length - 1];
    const preview = buildPreviewFromParts(latest.parts || []);

    const imageBadge = preview.hasImages
        ? `<span class="flex items-center gap-0.5 text-[10px] text-gray-400"><span class="material-symbols-rounded text-xs">image</span>图像</span>`
        : '';

    const imageSection = preview.images?.length
        ? `<div class="grid ${preview.images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} gap-3">
                ${preview.images.map((src, idx) => {
                    const escapedSrc = escapeHtml(src);
                    const dataSrc = escapeHtml(encodeURIComponent(src));
                    return `
                        <div class="relative group rounded-lg border border-gray-700 bg-black/30 overflow-hidden cursor-zoom-in" data-preview-img="${dataSrc}" onclick="state.activeSessionId = '${sessionId}'; openLightbox(decodeURIComponent(this.dataset.previewImg));">
                            <img src="${escapedSrc}" loading="lazy" class="w-full h-36 md:h-40 object-contain bg-black/20 transition-transform duration-200 group-hover:scale-[1.02]" alt="AI 输出图像 ${idx + 1}">
                            <div class="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wider text-gray-200 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity">点击放大</div>
                        </div>
                    `;
                }).join('')}
           </div>`
        : '';

    cardBody.innerHTML = `
        <div class="space-y-3">
            <div class="text-[11px] uppercase tracking-widest text-gray-500 flex items-center gap-2">
                <span class="material-symbols-rounded text-sm text-blue-400">smart_toy</span>
                AI 回复
                ${imageBadge}
            </div>
            ${imageSection}
            <button class="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-200 transition-colors" onclick="openChat('${sessionId}')">
                查看完整回复
                <span class="material-symbols-rounded text-base">north_east</span>
            </button>
        </div>
    `;
}
function renderPreview() {
    dom.previewStrip.innerHTML = '';
    dom.previewStrip.classList.toggle('hidden', state.images.length === 0);
    dom.imgCount.textContent = state.images.length;
    dom.imgCount.classList.toggle('hidden', state.images.length === 0);
    state.images.forEach((img, idx) => {
        const isFirst = idx === 0;
        dom.previewStrip.innerHTML += `
            <div class="relative w-16 h-16 flex-shrink-0 rounded border ${isFirst ? 'border-yellow-500 ring-2 ring-yellow-400' : 'border-gray-700'} bg-gray-800 group">
                <img src="${img.b64}" class="w-full h-full object-cover rounded opacity-80 group-hover:opacity-100">
                <span class="absolute -top-1 -left-1 text-[10px] font-bold bg-black/70 text-white px-1 rounded">${idx + 1}</span>
                <div class="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 text-white transition-opacity">
                    <div class="flex gap-1">
                        <button onclick="state.images.splice(${idx},1);renderPreview()" class="p-1 rounded bg-red-600/80 hover:bg-red-500" title="移除">
                            <span class="material-symbols-rounded text-xs">close</span>
                        </button>
                        <button onclick="setFirstGlobalImage(${idx})" class="p-1 rounded bg-yellow-600/80 hover:bg-yellow-500" title="设为第一">
                            <span class="material-symbols-rounded text-xs">looks_one</span>
                        </button>
                    </div>
                </div>
            </div>`;
    });
}

function openChat(id) {
    state.activeSessionId = id;
    dom.chatSessionId.textContent = `ID: ${id}`;
    dom.chatHistory.innerHTML = '';
    state.sessions[id].messages.forEach(msg => renderChatMessage(msg.role, msg.parts));
    toggleChatDrawer(true);
    setTimeout(() => dom.chatHistory.scrollTop = dom.chatHistory.scrollHeight, 100);
}
function toggleChatDrawer(open) {
    if(open) dom.chatDrawer.classList.remove('translate-x-full');
    else { dom.chatDrawer.classList.add('translate-x-full'); state.activeSessionId = null; }
}
async function sendChatMessage() {
    const txt = dom.chatInput.value.trim();
    if (!txt || !state.activeSessionId) return;

    const sessionId = state.activeSessionId;
    const session = state.sessions[sessionId];
    if (!session) return;

    session.messages.push({ role: 'user', parts: [{ text: txt }] });
    renderChatMessage('user', [{ text: txt }]);
    dom.chatInput.value = '';

    if (dom.sendChatBtn) {
        dom.sendChatBtn.disabled = true;
    }
    if (dom.chatStopBtn) {
        dom.chatStopBtn.disabled = false;
    }

    try {
        await executeSessionTurn(sessionId, null, false);
    } finally {
        if (dom.sendChatBtn) {
            dom.sendChatBtn.disabled = false;
        }
        if (dom.chatStopBtn) {
            dom.chatStopBtn.disabled = true;
        }
    }
}

function stopActiveChat() {
    if (!state.activeSessionId) return;
    stopSession(state.activeSessionId);
    if (dom.chatStopBtn) {
        dom.chatStopBtn.disabled = true;
    }
    if (dom.sendChatBtn) {
        dom.sendChatBtn.disabled = false;
    }
}
function renderChatMessage(role, parts) {
    const div = document.createElement('div');
    div.className = `flex ${role==='user'?'justify-end':'justify-start'} mb-4 animate-fade-in`;
    const bubble = document.createElement('div');
    bubble.className = role==='user' ? "bg-purple-900/30 border border-purple-800 text-gray-200 rounded-2xl rounded-tr-sm px-4 py-3 max-w-[90%] md:max-w-[85%]" : "bg-gray-800/50 border border-gray-700 text-gray-300 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[90%] md:max-w-[85%] prose prose-invert prose-sm";
    renderContentParts(bubble, parts);
    div.appendChild(bubble);
    dom.chatHistory.appendChild(div);
    dom.chatHistory.scrollTop = dom.chatHistory.scrollHeight;
}

function disableStopButton(id) {
    const stopBtn = document.getElementById(`stop-${id}`);
    if (!stopBtn) return;
    stopBtn.disabled = true;
    stopBtn.classList.add('opacity-40', 'cursor-not-allowed');
}

function stopSession(id) {
    const session = state.sessions[id];
    if (!session || !session.abortController) return;
    try {
        session.abortController.abort();
    } catch (e) {}
    const statusEl = document.getElementById(`status-${id}`);
    if (statusEl) {
        statusEl.className = "mr-2 flex items-center gap-1 text-[10px] text-yellow-500 font-mono font-semibold stopped-status";
        statusEl.innerHTML = `<span class="material-symbols-rounded text-sm">do_not_disturb_on</span> 已停止`;
    }

    // 停止后移除卡片正文里的骨架加载动画，避免仍然显示“生成中”的流动条
    const bodyEl = document.getElementById(`body-${id}`);
    if (bodyEl && Array.isArray(session.messages)) {
        const hasModelMessage = session.messages.some(m => m.role !== 'user');
        // 只有在还没有任何模型回复时才覆盖成“已停止”提示，避免盖掉已有内容
        if (!hasModelMessage) {
            bodyEl.innerHTML = `<div class="p-3 rounded text-xs font-mono stopped-banner">已停止，本次未生成结果。</div>`;
        }
    }

    disableStopButton(id);
    session.status = 'cancelled';
}

// Selection & Batch Logic
function toggleSelection(id, checked) {
    if(checked) state.selectedSessions.add(id); else state.selectedSessions.delete(id);
    document.getElementById(`overlay-${id}`).classList.toggle('opacity-0', !checked);
    dom.selectedCount.textContent = state.selectedSessions.size;
    dom.selectionToolbar.classList.toggle('translate-y-32', state.selectedSessions.size === 0);
    dom.selectionToolbar.classList.toggle('opacity-0', state.selectedSessions.size === 0);
}
function clearSelection() {
    // 取消所有已选卡片的勾选与选中样式
    state.selectedSessions.forEach(id => {
        const checkbox = document.querySelector(`#card-${id} input[type="checkbox"]`);
        if (checkbox) checkbox.checked = false;
        const overlay = document.getElementById(`overlay-${id}`);
        if (overlay) overlay.classList.add('opacity-0');
    });

    // 清空选中集合
    state.selectedSessions.clear();

    // 重置计数并隐藏工具栏（与 toggleSelection 中 size === 0 的效果保持一致）
    dom.selectedCount.textContent = 0;
    dom.selectionToolbar.classList.add('translate-y-32');
    dom.selectionToolbar.classList.add('opacity-0');
}
function selectAll() {
    Object.keys(state.sessions).forEach(id => {
        const checkbox = document.querySelector(`#card-${id} input[type="checkbox"]`);
        if (checkbox && !checkbox.checked) {
            checkbox.checked = true;
            toggleSelection(id, true);
        }
    });
}
function deleteSession(id) { document.getElementById(`card-${id}`)?.remove(); delete state.sessions[id]; state.selectedSessions.delete(id); if(Object.keys(state.sessions).length===0) dom.emptyState.style.display='flex'; }
function deleteSelected() { state.selectedSessions.forEach(deleteSession); clearSelection(); }

async function saveSelectedSessions() {
    const selectedIds = Array.from(state.selectedSessions);
    const count = selectedIds.length;
    if (count === 0) return alert("没有选中的对话。");

    const name = prompt(`为 ${count} 个对话输入一个集合名称:`, `集合 ${new Date().toLocaleTimeString()}`);
    if (!name) return;

    // Build raw sessions snapshot（直接引用运行时 session，确保图片文件名在导出 ZIP 时保持一致）
    const rawSessions = [];
    selectedIds.forEach(id => {
        const session = state.sessions[id];
        if (session) {
            rawSessions.push({
                timestamp: session.timestamp,
                messages: session.messages,
                systemInstruction: session.systemInstruction
            });
        }
    });

    // Pack (deduplicate) images before persisting to avoid localStorage配额问题
    const packed = packCollectionSessions(rawSessions);
    const collection = {
        id: Date.now(),
        name,
        sessions: packed.sessions,
        assets: packed.assets,
        v: packed.v
    };

    if (isAuthed()) {
        try {
            const stored = await trySaveFavorite('collections', collection);
            if (stored) {
                state.collections.unshift(stored);
                alert(`包含 ${count} 个对话的合集已保存到服务器收藏!`);
            }
        } catch (e) {
            console.warn('保存合集到服务器失败，将回退到本地:', e);
        }
    }

    if (!isAuthed()) {
        // Persist with safety (localStorage)
        state.collections.unshift(collection);
        try {
            localStorage.setItem('gem_collections_v1.0', JSON.stringify(state.collections));
            alert(`包含 ${count} 个对话的合集已保存!`);
        } catch (e) {
            // 回滚内存里的插入，防止与磁盘状态不一致
            state.collections.shift();
            console.error('保存合集到 localStorage 失败:', e);
            alert('保存失败：数据体积过大。请尝试减少图片数量，或使用“库→导出”备份到文件。');
        }
    }

    // 自动导出合集所包含对话的图片为 ZIP（包含 save image 文件夹）
    const safeBaseName = (name || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || `collection_${collection.id}`;
    exportImagesForSessions(selectedIds, `collection_${safeBaseName}`).catch(e => console.error('导出合集图片失败', e));

    clearSelection();
}

function viewRaw(id) {
    const s = state.sessions[id];
    if(!s?.lastRaw) return;
    dom.rawReqCode.textContent = JSON.stringify(s.lastRaw.req, null, 2);
    dom.rawResCode.textContent = JSON.stringify(s.lastRaw.res, null, 2);
    hljs.highlightElement(dom.rawReqCode);
    hljs.highlightElement(dom.rawResCode);
    toggleRawModal(true);
}
function toggleRawModal(show) { dom.rawModal.classList.toggle('hidden', !show); }
function openLightbox(src) {
    state.currentLightboxSrc = src;
    dom.lightboxImg.src = src;
    dom.lightbox.classList.remove('hidden');
    setTimeout(() => {
        dom.lightbox.classList.remove('opacity-0');
        dom.lightboxImg.classList.remove('scale-95');
        dom.lightboxImg.classList.add('scale-100');
    }, 10);
}
function closeLightbox() {
    dom.lightbox.classList.add('opacity-0');
    dom.lightboxImg.classList.add('scale-95');
    dom.lightboxImg.classList.remove('scale-100');
    setTimeout(() => {
        dom.lightbox.classList.add('hidden');
        dom.lightboxImg.src = '';
        state.currentLightboxSrc = null;
    }, 300);
}
function downloadCurrentLightboxImage() { const a=document.createElement('a'); a.href=state.currentLightboxSrc; a.target = '_blank'; a.download=`img_${Date.now()}.png`; a.click(); }

document.addEventListener('keydown', (e) => {
    if (dom.lightbox.classList.contains('hidden')) return;

    if (e.key === 'ArrowLeft') {
        // Find current image in the session and move to the previous one
        navigateLightbox(-1);
    } else if (e.key === 'ArrowRight') {
        // Find current image in the session and move to the next one
        navigateLightbox(1);
    }
});

function navigateLightbox(direction) {
    if (!state.currentLightboxSrc) return;

    // 收集当前画布所有对话卡片里的模型图片，按卡片显示顺序 + 消息顺序排列
    const cards = Array.from(dom.grid.querySelectorAll('[id^="card-"]'));
    const globalImages = [];

    cards.forEach(card => {
        const sessionId = card.id.replace(/^card-/, '');
        const session = state.sessions[sessionId];
        if (!session || !Array.isArray(session.messages)) return;

        session.messages.forEach(msg => {
            if (msg.role === 'model' && Array.isArray(msg.parts)) {
                msg.parts.forEach(part => {
                    const src = getPartImageSource(part);
                    if (src) {
                        globalImages.push({ sessionId, src });
                    }
                });
            }
        });
    });

    if (globalImages.length <= 1) return;

    // 优先使用 (sessionId + src) 精确定位当前图片在全局序列中的位置
    let currentIndex = globalImages.findIndex(img =>
        img.src === state.currentLightboxSrc &&
        img.sessionId === state.activeSessionId
    );

    // 兜底：如果 activeSessionId 未设置或不匹配，则仅按 src 匹配
    if (currentIndex === -1) {
        currentIndex = globalImages.findIndex(img => img.src === state.currentLightboxSrc);
        if (currentIndex === -1) return;
    }

    let nextIndex = currentIndex + direction;

    if (nextIndex < 0) {
        nextIndex = globalImages.length - 1;
    } else if (nextIndex >= globalImages.length) {
        nextIndex = 0;
    }

    const next = globalImages[nextIndex];
    // 更新当前会话为目标图片所在的对话，实现“跨对话”切换
    state.activeSessionId = next.sessionId;
    openLightbox(next.src);
}

async function downloadSelectedImages() {
    // 复用通用导出函数，将当前选中对话的图片打成 ZIP
    const selectedIds = Array.from(state.selectedSessions);
    if (!selectedIds.length) {
        return alert("没有找到可下载的图片。");
    }
    await exportImagesForSessions(selectedIds, "images");
}

async function exportImagesForSessions(sessionIds, baseName = "images") {
    const zip = new JSZip();
    let imagePromises = [];

    sessionIds.forEach(id => {
        const session = state.sessions[id];
        if (!session || !Array.isArray(session.messages)) return;

        session.messages
            .filter(m => m.role === 'model')
            .forEach(m => {
                m.parts?.forEach((p, i) => {
                    const inlineData = p.inline_data || p.inlineData;
                    const fileData = p.file_data || p.fileData;

                    if (inlineData && inlineData.data) {
                        // 与 makeMessagesStorageSafe 中保存到库里的 file_uri 使用同一套命名规则
                        const info = getInlineImageFilename(p);
                        const inlineMime = inlineData.mime_type || inlineData.mimeType || 'image/png';
                        const ext = (inlineMime.split('/')[1] || 'png').toLowerCase();
                        const filename = (info && info.filename) ? info.filename : `save image/inline_${id}_${i}.${ext}`;
                        const data = normalizeBase64(inlineData.data);
                        zip.file(filename, data, { base64: true });
                    } else if (fileData && fileData.file_uri) {
                        const url = fileData.file_uri;
                        const extMatch = url.match(/\.([^.?]+)(?:\?.*)?$/);
                        const ext = extMatch ? extMatch[1] : 'png';

                        if (url.startsWith('data:')) {
                            try {
                                const parts = url.split(',');
                                const meta = parts[0];
                                const data = parts[1];
                                const mimeMatch = meta.match(/:(.*?);/);
                                const mime = mimeMatch ? mimeMatch[1] : 'image/png';
                                const extFromMime = (mime.split('/')[1] || 'png').toLowerCase();
                                zip.file(`save image/${id}_${i}.${extFromMime}`, data, { base64: true });
                            } catch(e) {
                                console.error("Error parsing data URL:", url, e);
                                zip.file(`save image/${id}_${i}_urldata.txt`, url);
                            }
                        } else {
                            const promise = fetch(url)
                                .then(response => {
                                    if (!response.ok) throw new Error(`Network response was not ok for ${url}`);
                                    return response.blob();
                                })
                                .then(blob => {
                                    zip.file(`save image/${id}_${i}.${ext}`, blob);
                                })
                                .catch(err => {
                                    console.error(`Fetch failed for ${url}, saving URL as .txt file instead. Error:`, err);
                                    zip.file(`save image/${id}_${i}_fallback.txt`, url);
                                });
                            imagePromises.push(promise);
                        }
                    }
                });
            });
    });

    // Wait for all remote images to be fetched
    await Promise.all(imagePromises);

    if (Object.keys(zip.files).length === 0) {
        return alert("没有找到可下载的图片。");
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `${baseName}_${timestamp}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
}
async function fetchModels() {
    const currentModel = dom.modelId.value; // 保存当前值
    dom.modelId.blur(); // 强制输入框失焦，关闭建议列表
    try {
        dom.modelId.value = ''; // 临时清空以确保datalist在填充时不会被过滤

        const apiFormat = state.apiFormat || 'gemini';
        const base = dom.baseUrl.value.replace(/\/$/, '');
        let url = '';
        const fetchOptions = { method: 'GET', headers: {} };

        if (apiFormat === 'openai') {
            // OpenAI 官方接口：GET /v1/models，使用 Bearer 鉴权
            const ver = dom.apiVersion.value.trim() || 'v1';
            url = `${base}/${ver}/models`;
            fetchOptions.headers['Authorization'] = `Bearer ${dom.apiKey.value}`;
        } else if (apiFormat === 'vertex') {
            // Vertex 模式下模型列表接口较复杂，这里先提示手动填写，避免错误请求
            alert('Vertex 通道暂不支持自动获取模型列表，请手动填写模型 ID。');
            dom.modelId.value = currentModel;
            return;
        } else {
            // 默认按 Gemini 官方接口处理
            url = `${base}/v1beta/models?key=${dom.apiKey.value}`;
        }

        const res = await fetch(url, fetchOptions);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        const modelListEl = document.getElementById('modelList');
        if (modelListEl) {
            if (apiFormat === 'openai') {
                const list = data.data || data.models || [];
                modelListEl.innerHTML = list
                    .map(m => {
                        const id = (m.id || m.name || '').replace(/^models\//, '');
                        return id ? `<option value="${id}"></option>` : '';
                    })
                    .join('');
            } else {
                modelListEl.innerHTML = (data.models || [])
                    .map(m => `<option value="${m.name.replace('models/','')}"></option>`)
                    .join('');
            }
        }
        alert("模型列表已更新");
    } catch (e) {
        console.error("获取模型列表失败:", e);
        alert("获取失败: " + e.message);
    } finally {
        dom.modelId.value = currentModel; // 恢复原值
    }
}
