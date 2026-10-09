const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, nativeImage, dialog, Notification, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const engine = require("./engine");
// Cursor köprüsü tek klasörde: providers/cursor
// Kaldırmak için bu satırı, aşağıdaki cursor.* çağrılarını ve renderer Cursor sekmesini sil.
const cursor = require("./providers/cursor");

const statePath = () => path.join(app.getPath("userData"), "cortex-state.json");
const keyPath = () => path.join(app.getPath("userData"), "cortex-key.bin");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function publicState() {
  const st = readJson(statePath(), {
    setupDone: false,
    enabledModels: [],
    activeModel: "",
    activeSource: "",
    grokBase: "https://grok.claude.gg",
    claudeBase: "https://claude.gg",
    openAtLogin: false,
    cursorModels: [],
  });
  return { ...st, hasKey: fs.existsSync(keyPath()) };
}

function writeState(patch) {
  const next = { ...publicState(), ...patch };
  delete next.hasKey;
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf8");
  return publicState();
}

function readKey() {
  if (!fs.existsSync(keyPath())) return "";
  const buf = fs.readFileSync(keyPath());
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
  } catch {}
  return buf.toString("utf8");
}

function writeKey(key) {
  fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
  if (!key) {
    if (fs.existsSync(keyPath())) fs.unlinkSync(keyPath());
    return;
  }
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key)
    : Buffer.from(key, "utf8");
  fs.writeFileSync(keyPath(), buf);
}

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 401/403 → yeniden deneme fayda sağlamaz
      const msg = String(err && err.message || err);
      if (/ 401 | 403 /.test(" " + msg + " ")) throw err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

async function fetchModels(base, key) {
  return withRetry(async () => {
    const url = base.replace(/\/$/, "") + "/v1/models";
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(base + " " + res.status + " " + text.slice(0, 180));
    const json = JSON.parse(text);
    const items = json.data || json.models || [];
    const host = new URL(base).host;
    return items
      .map((m) => {
        const id = typeof m === "string" ? m : m.id || m.model || "";
        const name = typeof m === "string" ? m : m.name || m.system_prompt_label || id;
        return { id, name, source: host };
      })
      .filter((m) => m.id);
  });
}

function keyRejected(status) {
  return status === 401 || status === 403;
}

let keyVerdict = { stamp: "", ok: false, at: 0 };

function keyStamp(key, bases, model) {
  return [key, model || "", ...(bases || [])].join("\n");
}

async function probeKey(base, key, model) {
  return withRetry(async () => {
    const url = String(base || "").replace(/\/$/, "") + "/v1/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "ping",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  });
}

async function assertKeyAccepted(key, bases, model) {
  const stamp = keyStamp(key, bases, model);
  if (keyVerdict.stamp === stamp && Date.now() - keyVerdict.at < 10 * 60 * 1000) {
    if (keyVerdict.ok) return;
    throw new Error("API anahtarı reddedildi. Köprü açılmadı.");
  }
  const errors = [];
  let asked = 0;
  for (const base of bases) {
    if (!base) continue;
    asked += 1;
    try {
      const status = await probeKey(base, key, model);
      if (!keyRejected(status)) {
        keyVerdict = { stamp, ok: true, at: Date.now() };
        return;
      }
      errors.push(status);
    } catch (err) {
      throw new Error("Anahtar doğrulanamadı: " + (err.message || err));
    }
  }
  if (errors.length) {
    keyVerdict = { stamp, ok: false, at: Date.now() };
    throw new Error("API anahtarı reddedildi. Lütfen anahtarı kontrol et.");
  }
  if (!asked) throw new Error("Anahtar doğrulanamadı: sunucu adresi tanımlı değil.");
}

let mainWindow = null;
let tray = null;
let quitting = false;
let engineStopping = false;

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

let trayBusy = false;

async function traySet(on) {
  if (trayBusy) return;
  trayBusy = true;
  try {
    if (!on) {
      await engine.stopEngine();
      const { response: choice } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
        type: "warning",
        buttons: ["Kapat ve devam et", "Vazgeç"],
        defaultId: 1,
        cancelId: 1,
        title: "AntiGravity kapanacak",
        message: "Yönlendirme ve sertifika kaldırılıyor. AntiGravity bu sırada kapanır.",
        detail: "Vazgeç dersen yalnızca motor durur. Yama ve yönlendirme yerinde kalır.",
      });
      if (choice === 0) engine.removeMachine();
    } else {
      const key = readKey();
      const st = publicState();
      const model = st.activeModel || (st.enabledModels || [])[0];
      if (!key || !model) {
        dialog.showErrorBox("Cortex", !key ? "Önce Ayarlar’dan API anahtarı kaydet." : "Önce bir model seç.");
      } else {
        await assertKeyAccepted(key, [st.grokBase, st.claudeBase], model);
        await engine.startEngine(key, st.grokBase, model);
        const up = await engine.waitListening(3001, 12000);
        if (up) engine.installMachine();
      }
    }
  } catch (err) {
    dialog.showErrorBox("Cortex", String(err.message || err));
  } finally {
    trayBusy = false;
    refreshTray();
  }
}

async function refreshTray() {
  if (!tray) return;
  let on = false;
  try {
    const rt = await engine.status();
    on = !!(rt.running && rt.hosts && rt.binary);
    tray.setToolTip(on ? "Cortex · açık" : "Cortex · kapalı");
  } catch {}
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Cortex'i aç", click: showMain },
    { label: on ? "Kapat" : "Aç", click: () => traySet(!on) },
    { type: "separator" },
    { label: "Tamamen çık", click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  const image = nativeImage.createFromPath(path.join(__dirname, "assets", "cortexlogo.png"));
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip("Cortex");
  tray.on("double-click", showMain);
  refreshTray();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#070b18",
    title: "Cortex",
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "assets", "cortexlogo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow = win;
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    const firstHide = !global.__cortexHidOnce;
    win.hide();
    if (firstHide && Notification.isSupported()) {
      global.__cortexHidOnce = true;
      new Notification({ title: "Cortex", body: "Cortex arka planda, köprü duruyor." }).show();
    }
    if (firstHide) refreshTray();
  });
  win.on("closed", () => { mainWindow = null; });
  ipcMain.on("win:min", () => win.minimize());
  ipcMain.on("win:max", () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on("win:close", () => win.close());
  ipcMain.handle("shell:open", (_e, url) => {
    let parsed;
    try { parsed = new URL(String(url || "")); } catch { return false; }
    if (parsed.protocol !== "https:" || parsed.hostname !== "discord.gg") return false;
    return shell.openExternal(parsed.href);
  });
}

app.whenReady().then(() => {
  // Motor beklenmedik çökerse UI'a bildir ve tray'i güncelle
  engine.onCrash((code) => {
    refreshTray();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("engine:crash", { code });
    }
    if (Notification.isSupported()) {
      new Notification({
        title: "Cortex — Motor Durdu",
        body: "AntiGravity motoru beklenmedik şekilde kapandı (kod: " + code + "). Yeniden açmak için aç/kapat düğmesini kullan.",
      }).show();
    }
  });
  ipcMain.handle("state:get", () => publicState());
  ipcMain.handle("state:set", (_e, patch) => {
    const next = writeState(patch || {});
    if (patch && Object.prototype.hasOwnProperty.call(patch, "openAtLogin")) {
      app.setLoginItemSettings({ openAtLogin: !!next.openAtLogin, args: [] });
    }
    try { cursor.setModels(cursorModels()); } catch {}
    return next;
  });
  ipcMain.handle("key:set", async (_e, key) => {
    const value = (key || "").trim();
    if (!value) {
      writeKey("");
      keyVerdict = { stamp: "", ok: false, at: 0 };
      return { hasKey: false };
    }
    const st = publicState();
    const model = st.activeModel || (st.enabledModels || [])[0] || "";
    try {
      await assertKeyAccepted(value, [st.grokBase, st.claudeBase], model);
    } catch (err) {
      return { hasKey: fs.existsSync(keyPath()), error: String(err.message || err) };
    }
    writeKey(value);
    try { cursor.setModels(cursorModels()); } catch {}
    return { hasKey: true };
  });
  ipcMain.handle("key:status", () => ({
    hasKey: fs.existsSync(keyPath()),
    masked: readKey() ? "sk-••••" + readKey().slice(-4) : "",
  }));
  function normalizeCursorModel(raw, fallbackKey) {
    const modelId = String(raw.modelId || raw.id || "").trim();
    const displayName = String(raw.displayName || raw.name || modelId).trim();
    const baseUrl = String(raw.baseUrl || "").trim().replace(/\/$/, "");
    const apiKey = String(raw.apiKey || fallbackKey || "").trim();
    if (!modelId) throw new Error("Model kimliği boş.");
    if (!displayName) throw new Error("Görünen ad boş.");
    if (!baseUrl) throw new Error("Base URL boş.");
    if (!apiKey) throw new Error("API anahtarı boş.");
    const endpoint = String(raw.openaiEndpoint || "/v1/chat/completions").trim();
    return {
      id: String(raw.id || modelId + "@" + baseUrl),
      displayName,
      modelId,
      baseUrl,
      apiKey,
      openaiEndpoint: endpoint === "/v1/responses" ? "/v1/responses" : "/v1/chat/completions",
      useFullUrl: !!raw.useFullUrl,
      tooltip: String(raw.tooltip || displayName).trim() || displayName,
      group: String(raw.group || "Cortex").trim() || "Cortex",
    };
  }

  function cursorModels() {
    const st = publicState();
    const fallback = readKey();
    const stored = Array.isArray(st.cursorModels) ? st.cursorModels : [];
    const out = [];
    for (const item of stored) {
      try { out.push(normalizeCursorModel(item, fallback)); } catch {}
    }
    const autoLike = out.length > 0 && out.every((m) => String(m.displayName || "") === "Cortex " + m.modelId && String(m.group || "") === "Cortex");
    if (out.length && !autoLike) return out;
    const ids = st.enabledModels && st.enabledModels.length
      ? st.enabledModels
      : (st.activeModel ? [st.activeModel] : []);
    const grok = String(st.grokBase || "https://grok.claude.gg").replace(/\/$/, "");
    const claude = String(st.claudeBase || "https://claude.gg").replace(/\/$/, "");
    const auto = ids.filter(Boolean).map((id) => normalizeCursorModel({
      id,
      displayName: "Cortex " + id,
      modelId: id,
      baseUrl: /claude/i.test(id) ? claude : grok,
      apiKey: fallback,
      openaiEndpoint: "/v1/chat/completions",
      group: "Cortex",
    }, fallback));
    if (autoLike && !auto.length) {
      try { writeState({ cursorModels: [] }); } catch {}
    }
    return auto;
  }

  function publicCursorModels() {
    return cursorModels().map((m) => ({
      id: m.id,
      displayName: m.displayName,
      modelId: m.modelId,
      baseUrl: m.baseUrl,
      openaiEndpoint: m.openaiEndpoint,
      group: m.group,
      hasKey: !!m.apiKey,
    }));
  }

  function saveCursorModels(list) {
    const seen = new Set();
    const next = [];
    for (const item of list) {
      const row = normalizeCursorModel(item, item.apiKey || readKey());
      const key = row.modelId + "|" + row.baseUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(row);
    }
    writeState({ cursorModels: next });
    cursor.setModels(cursorModels());
    return publicCursorModels();
  }

  ipcMain.handle("cursor:status", async () => { const st = await cursor.status(); return { ...st, models: publicCursorModels() }; });
  ipcMain.handle("cursor:models", () => publicCursorModels());
  ipcMain.handle("cursor:add", (_e, raw) => {
    const list = cursorModels();
    list.push(normalizeCursorModel(raw || {}, (raw && raw.apiKey) || readKey()));
    return saveCursorModels(list);
  });
  ipcMain.handle("cursor:addMany", (_e, rows) => {
    const list = cursorModels();
    const incoming = Array.isArray(rows) ? rows : [];
    if (!incoming.length) throw new Error("Eklenecek model yok.");
    for (const raw of incoming) list.push(normalizeCursorModel(raw || {}, (raw && raw.apiKey) || readKey()));
    return saveCursorModels(list);
  });
  ipcMain.handle("cursor:remove", (_e, id) => {
    const want = String(id || "");
    return saveCursorModels(cursorModels().filter((m) => m.id !== want));
  });
  ipcMain.handle("cursor:toggle", async (_e, on) => {
    const list = cursorModels();
    if (on && !list.length) throw new Error("Cursor sekmesinden en az bir model ekle.");
    if (on && list.some((m) => !m.apiKey)) throw new Error("Modelin API anahtarı yok.");
    if (on) cursor.setModels(list);
    const onStep = (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("cursor:step", info);
      }
    };
    const st = await cursor.toggle(!!on, on ? onStep : undefined);
    return { ...st, models: publicCursorModels() };
  });
  ipcMain.handle("runtime:status", () => engine.status());
  ipcMain.handle("runtime:activity", () => engine.activity());
  ipcMain.handle("runtime:export", () => engine.exportDiagnostic());
  ipcMain.handle("runtime:uninstall", async () => {
    try {
      return await engine.uninstallAll();
    } catch (err) {
      return { ...(await engine.status()), error: String(err.message || err) };
    }
  });
  ipcMain.handle("runtime:applyModel", async () => {
    const rt = await engine.status();
    if (!rt.running) return { applied: false, reason: "Motor kapalı. Seçim bir sonraki açılışta geçerli." };
    const key = readKey();
    const st = publicState();
    const model = st.activeModel || (st.enabledModels || [])[0];
    if (!key || !model) return { applied: false, reason: "Anahtar ya da model yok." };
    await engine.startEngine(key, st.grokBase, model);
    const up = await engine.waitListening(3001, 12000);
    return { applied: up, reason: up ? "" : "Motor yeni modelle ayağa kalkmadı." };
  });
  ipcMain.handle("runtime:toggle", async (_e, on) => {
    if (!on) {
      await engine.stopEngine();
      const { response: choice } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
        type: "warning",
        buttons: ["Kapat ve devam et", "Vazgeç"],
        defaultId: 1,
        cancelId: 1,
        title: "AntiGravity kapanacak",
        message: "Yönlendirme ve sertifika kaldırılıyor. AntiGravity bu sırada kapanır.",
        detail: "Vazgeç dersen yalnızca motor durur. Yama ve yönlendirme yerinde kalır.",
      });
      if (choice !== 0) {
        const rt = await engine.status();
        rt.error = "Yalnızca motor durdu. Yönlendirme duruyor, AntiGravity açık kaldı.";
        refreshTray();
        return rt;
      }
      try { engine.removeMachine(); } catch (err) {
        refreshTray();
        return { ...(await engine.status()), error: String(err.message || err) };
      }
      refreshTray();
      return engine.status();
    }
    const key = readKey();
    const st = publicState();
    if (!key) return { ...(await engine.status()), error: "Önce Ayarlar’dan API anahtarı kaydet." };
    if (!st.activeModel && !(st.enabledModels || []).length) {
      return { ...(await engine.status()), error: "Önce Modeller’den en az bir model aç." };
    }
    const model = st.activeModel || st.enabledModels[0];
    try {
      await assertKeyAccepted(key, [st.grokBase, st.claudeBase], model);
      await engine.startEngine(key, st.grokBase, model);
      const up = await engine.waitListening(3001, 12000);
      if (!up) return { ...(await engine.status()), error: "Motor 3001 portunda ayağa kalkmadı." };
      engine.installMachine();
      refreshTray();
      return engine.status();
    } catch (err) {
      await engine.stopEngine();
      return { ...(await engine.status()), error: String(err.message || err) };
    }
  });
  ipcMain.handle("models:list", async () => {
    const key = readKey();
    const st = publicState();
    if (!key) return { ok: false, reason: "anahtar-yok", models: [], errors: ["Önce Ayarlar'dan API anahtarı kaydet."] };
    const model = st.activeModel || (st.enabledModels || [])[0] || "";
    const stamp = keyStamp(key, [st.grokBase, st.claudeBase], model);
    if (keyVerdict.stamp === stamp && !keyVerdict.ok && Date.now() - keyVerdict.at < 10 * 60 * 1000) {
      return { ok: false, reason: "gecersiz-anahtar", models: [], errors: ["API anahtarı reddedildi. Lütfen anahtarı kontrol et."] };
    }
    const errors = [];
    const rejected = [];
    const all = [];
    for (const base of [st.grokBase, st.claudeBase]) {
      try {
        all.push(...(await fetchModels(base, key)));
      } catch (err) {
        const message = String(err.message || err);
        errors.push(message);
        if (/\s401\s|\s403\s/.test(" " + message + " ")) rejected.push(base);
      }
    }
    if (!all.length && rejected.length) {
      return { ok: false, reason: "gecersiz-anahtar", models: [], errors };
    }
    const seen = new Set();
    const models = [];
    for (const m of all) {
      const k = m.source + "|" + m.id;
      if (seen.has(k)) continue;
      seen.add(k);
      models.push(m);
    }
    return { ok: models.length > 0, models, errors };
  });
  const st = publicState();
  app.setLoginItemSettings({ openAtLogin: !!st.openAtLogin, args: [] });
  createTray();
  createWindow();
});

app.on("window-all-closed", () => {});

app.on("before-quit", (event) => {
  quitting = true;
  if (engineStopping) return;
  event.preventDefault();
  engineStopping = true;
  // 5 saniye içinde kapanmazsa zorla çık
  const forceQuit = setTimeout(() => app.quit(), 5000);
  Promise.allSettled([
    cursor.disable(),
    Promise.resolve(engine.stopEngine()),
  ]).finally(() => {
    clearTimeout(forceQuit);
    app.quit();
  });
});

app.on("activate", showMain);
