"use strict";

const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const net = require("net");
const tls = require("tls");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");
const forge = require("node-forge");
const catalog = require("./catalog");
const agent = require("./agent");

const PORT = 8788;
const CN = "Cursor BYOK Local CA";
const ORG = "Cursor BYOK";
const MANAGED = [
  "http.proxy",
  "http.proxyKerberosServicePrincipal",
  "http.proxySupport",
  "cursor.general.disableHttp2",
  "http.experimental.systemCertificatesV2",
];

let server = null;
let boundPort = 0;
let lastError = "";
let busy = null;
let models = [];
let injectTimer = null;
let catalogHits = 0;

function setModels(list) {
  models = Array.isArray(list)
    ? list.map((item) => safeModel(item)).filter((item) => item && item.hash && item.displayName)
    : [];
  agent.setModels(models);
}

function safeModel(item) {
  try {
    return catalog.normalize(item, item.apiKey);
  } catch {
    return null;
  }
}

function dataDir() {
  return path.join(app.getPath("userData"), "cursor-byok");
}

function certPath() {
  return path.join(dataDir(), "ca.crt");
}

function keyPath() {
  return path.join(dataDir(), "ca.key");
}

function opensslBin() {
  const hits = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "openssl.exe"),
    "openssl",
  ];
  return hits[hits.length - 1];
}

function opensslOk() {
  return new Promise((resolve) => {
    execFile("openssl", ["version"], { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

function settingsPath() {
  const root = process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming");
  return path.join(root, "Cursor", "User", "settings.json");
}

function proxyUrl() {
  return boundPort ? "http://127.0.0.1:" + boundPort : "";
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || "");
        err.stderr = String(stderr || "");
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function stripJsonc(text) {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function readSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(stripJsonc(raw));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".cortex.tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function applySettings(url) {
  const settings = readSettings();
  delete settings["http.noProxy"];
  delete settings["http.systemCertificates"];
  delete settings["http.proxyStrictSSL"];
  delete settings["http.proxyAuthorization"];
  settings["http.proxy"] = url;
  settings["http.proxyKerberosServicePrincipal"] = url;
  settings["http.proxySupport"] = "on";
  settings["cursor.general.disableHttp2"] = true;
  settings["http.experimental.systemCertificatesV2"] = true;
  // CA sertifikasını Cursor'un güven listesine ekle
  try {
    const cp = certPath();
    if (fs.existsSync(cp)) {
      settings["http.proxyCA"] = cp;
      settings["http.sslCaFile"] = cp;
    }
  } catch {}
  writeSettings(settings);
  stripIgnoreCertFlags();
}

function stateDbPath() {
  const root = process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming");
  return path.join(root, "Cursor", "User", "globalStorage", "state.vscdb");
}

// Session başına bir kez üretilir, uygulama yeniden başlayana kadar sabit kalır
const SESSION_SECRET = crypto.randomBytes(32).toString("hex");

function localCursorToken() {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: "cursor-local-user",
    email: "cursor@ai.com",
    type: "session",
    iss: "cursor-client",
    scope: "openid profile email",
    exp: 4070908800,
  })).toString("base64url");
  // İmza: HMAC-SHA256 ile session secret — kriptografik olarak doğrulanamaz ama tahmin edilemez
  const sig = crypto.createHmac("sha256", SESSION_SECRET)
    .update(header + "." + payload)
    .digest("base64url");
  return header + "." + payload + "." + sig;
}

function accountRows(token) {
  return [
    ["cursorAuth/accessToken", token],
    ["cursorAuth/refreshToken", token],
    ["cursorAuth/cachedEmail", "cursor@ai.com"],
    ["cursorAuth/cachedSignUpType", "Google"],
    ["cursorAuth/stripeMembershipAuthId", "cursor-local-user"],
    ["cursorAuth/stripeMembershipType", "ultra"],
    ["cursorAuth/stripeSubscriptionStatus", "active"],
  ];
}

function membershipRows() {
  return [
    ["cursorAuth/cachedEmail", "cursor@ai.com"],
    ["cursorAuth/cachedSignUpType", "Google"],
    ["cursorAuth/stripeMembershipAuthId", "cursor-local-user"],
    ["cursorAuth/stripeMembershipType", "ultra"],
    ["cursorAuth/stripeSubscriptionStatus", "active"],
  ];
}

function injectWithNodeSqlite(db, token) {
  const { DatabaseSync } = require("node:sqlite");
  const conn = new DatabaseSync(db);
  try {
    conn.exec("PRAGMA busy_timeout=8000");
    conn.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const stmt = conn.prepare("INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)");
    for (const [key, value] of accountRows(token)) stmt.run(key, value);
    const check = conn.prepare("SELECT CAST(value AS TEXT) AS v FROM ItemTable WHERE key = ?").get("cursorAuth/stripeMembershipType");
    if (!check || String(check.v) !== "ultra") throw new Error("state.vscdb ultra yazılmadı");
  } finally {
    conn.close();
  }
}

function injectWithPython(db, token) {
  const py = [
    "import sqlite3, os, sys",
    "p = sys.argv[1]",
    "t = sys.argv[2]",
    "os.makedirs(os.path.dirname(p), exist_ok=True)",
    "c = sqlite3.connect(p, timeout=8)",
    "c.execute('PRAGMA busy_timeout=8000')",
    "c.execute('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')",
    "rows = [",
    " ('cursorAuth/accessToken', t),",
    " ('cursorAuth/refreshToken', t),",
    " ('cursorAuth/cachedEmail', 'cursor@ai.com'),",
    " ('cursorAuth/cachedSignUpType', 'Google'),",
    " ('cursorAuth/stripeMembershipAuthId', 'cursor-local-user'),",
    " ('cursorAuth/stripeMembershipType', 'ultra'),",
    " ('cursorAuth/stripeSubscriptionStatus', 'active'),",
    "]",
    "for k,v in rows:",
    " c.execute('INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)', (k, v))",
    "c.commit()",
    "got = c.execute('SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = ?', ('cursorAuth/stripeMembershipType',)).fetchone()",
    "c.close()",
    "if not got or got[0] != 'ultra':",
    " raise SystemExit('ultra yazılmadı')",
  ].join("\n");
  const tmp = path.join(dataDir(), "inject_account.py");
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(tmp, py, "utf8");
  try {
    try {
      require("child_process").execFileSync("python", [tmp, db, token], { windowsHide: true, timeout: 15000 });
    } catch {
      require("child_process").execFileSync("py", ["-3", tmp, db, token], { windowsHide: true, timeout: 15000 });
    }
  } finally {
    // Hata olsun olmasın geçici Python betiğini sil
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectCursorAccount() {
  const db = stateDbPath();
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const token = localCursorToken();
  let last = "";
  for (let i = 0; i < 5; i++) {
    try {
      injectWithNodeSqlite(db, token);
      lastError = "";
      return;
    } catch (err) {
      last = String(err.message || err);
    }
    try {
      injectWithPython(db, token);
      lastError = "";
      return;
    } catch (err) {
      last = String(err.message || err);
    }
    // Bloklu Atomics.wait yerine async sleep
    await sleep(400);
  }
  throw new Error("Cursor hesap önbelleği yazılamadı: " + last);
}

function startInjectLoop() {
  stopInjectLoop();
  injectTimer = setInterval(() => {
    injectCursorAccount().catch((err) => { lastError = String(err.message || err); });
  }, 2500);
}

function stopInjectLoop() {
  if (injectTimer) {
    clearInterval(injectTimer);
    injectTimer = null;
  }
}

function argvPath() {
  const root = process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming");
  return path.join(root, "Cursor", "argv.json");
}

function stripIgnoreCertFlags() {
  const file = argvPath();
  try {
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data["ignore-certificate-errors"]) {
      delete data["ignore-certificate-errors"];
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    }
  } catch {}
  const flags = path.join(process.env.APPDATA || "", "Cursor", "Cursor.flags");
  try {
    if (fs.existsSync(flags)) fs.unlinkSync(flags);
  } catch {}
}

function clearSettings() {
  let settings = {};
  try { settings = readSettings(); } catch { return; }
  let changed = false;
  for (const key of MANAGED) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      delete settings[key];
      changed = true;
    }
  }
  if (changed) writeSettings(settings);
}

function settingsMatch(url) {
  if (!url) return false;
  try {
    const settings = readSettings();
    return settings["http.proxy"] === url
      && settings["http.proxyKerberosServicePrincipal"] === url
      && settings["http.proxySupport"] === "on"
      && settings["cursor.general.disableHttp2"] === true
      && settings["http.experimental.systemCertificatesV2"] === true;
  } catch {
    return false;
  }
}

function isCursorHost(host) {
  const name = String(host || "").split(":")[0].toLowerCase().replace(/\.$/, "");
  if (!name) return false;
  if (name === "cursor.sh" || name === "www.cursor.sh") return true;
  if (name === "cursor.com" || name === "www.cursor.com") return true;
  if (name === "api2.cursor.sh" || name === "api3.cursor.sh" || name === "api.cursor.sh") return true;
  if (name === "authenticator.cursor.sh") return true;
  return name.endsWith(".cursor.sh") || name.endsWith(".cursor.com");
}

// LRU cache — max 200 hostname sertifikası tutar, eskiler otomatik silinir
const LEAF_CACHE_MAX = 200;
const leafCache = new Map();
let caKeys = null;

function leafCacheSet(name, value) {
  if (leafCache.has(name)) leafCache.delete(name); // yenile (LRU sırası)
  leafCache.set(name, value);
  if (leafCache.size > LEAF_CACHE_MAX) {
    // En eski (ilk eklenen) girdiyi sil
    leafCache.delete(leafCache.keys().next().value);
  }
}

function ps(script) {
  return run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

function wipeHomemadeCa() {
  const dir = dataDir();
  try {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch {}
      }
    }
  } catch {}
  leafCache.clear();
  caKeys = null;
}

function purgeWindowsCa() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$stores = @('Cert:\\CurrentUser\\Root','Cert:\\CurrentUser\\CA','Cert:\\CurrentUser\\My','Cert:\\LocalMachine\\Root','Cert:\\LocalMachine\\CA','Cert:\\LocalMachine\\My')",
    "foreach ($s in $stores) { Get-ChildItem $s -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*Cursor BYOK*' -or $_.Issuer -like '*Cursor BYOK*' } | Remove-Item -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  try {
    const { execFileSync } = require("child_process");
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 15000 });
  } catch {}
}

function pemToDer(pem) {
  const match = String(pem).match(/-----BEGIN [^-]+-----([\s\S]+?)-----END [^-]+-----/);
  if (!match) throw new Error("PEM çözülemedi.");
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

function loadCa() {
  if (caKeys) return caKeys;
  const certPem = fs.readFileSync(certPath(), "utf8");
  const keyPem = fs.readFileSync(keyPath(), "utf8");
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  caKeys = { cert, key, certPem, keyPem };
  return caKeys;
}

function generateCa() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const keys = forge.pki.rsa.generateKeyPair({ bits: 3072, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + 3652);
  const attrs = [
    { name: "commonName", value: CN },
    { name: "organizationName", value: ORG },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  fs.writeFileSync(certPath(), certPem);
  fs.writeFileSync(keyPath(), keyPem);
  caKeys = { cert, key: keys.privateKey, certPem, keyPem };
  return caKeys;
}

function ensureCa() {
  fs.mkdirSync(dataDir(), { recursive: true });
  if (fs.existsSync(certPath()) && fs.existsSync(keyPath())) {
    try {
      return loadCa();
    } catch {
      wipeHomemadeCa();
    }
  }
  return generateCa();
}

function leafFor(host) {
  const name = String(host || "api2.cursor.sh").split(":")[0].toLowerCase();
  if (leafCache.has(name)) return leafCache.get(name);
  const ca = ensureCa();
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 2);
  cert.setSubject([{ name: "commonName", value: name }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: name }] },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  const out = {
    cert: forge.pki.certificateToPem(cert) + ca.certPem,
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  leafCacheSet(name, out);
  return out;
}

function clearCursorPins() {
  const root = process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming");
  const files = [
    path.join(root, "Cursor", "Network", "TransportSecurity"),
    path.join(root, "Cursor", "Partitions", "cursor-browser", "Network", "TransportSecurity"),
    path.join(root, "Cursor", "Partitions", "cursor-c18bf1311e2eed498cb737574e01a895-browser", "Network", "TransportSecurity"),
  ];
  try {
    const parts = path.join(root, "Cursor", "Partitions");
    if (fs.existsSync(parts)) {
      for (const name of fs.readdirSync(parts)) {
        files.push(path.join(parts, name, "Network", "TransportSecurity"));
      }
    }
  } catch {}
  for (const file of files) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
}

async function trusted() {
  if (!fs.existsSync(certPath())) return false;
  try {
    const out = await run("certutil", ["-user", "-store", "Root", CN]);
    if (/Cursor BYOK Local CA/i.test(out.stdout + out.stderr)) return true;
  } catch {}
  try {
    const out = await run("certutil", ["-store", "Root", CN]);
    if (/Cursor BYOK Local CA/i.test(out.stdout + out.stderr)) return true;
  } catch {}
  return false;
}

async function trustCa() {
  ensureCa();
  const file = certPath();
  try {
    await run("certutil", ["-user", "-addstore", "-f", "Root", file]);
  } catch (err) {
    lastError = String(err.message || err);
  }
  try {
    await run("certutil", ["-addstore", "-f", "Root", file]);
  } catch {}
  if (!(await trusted())) {
    throw new Error("CA kullanıcı Root deposuna yazılamadı: " + (lastError || "bilinmeyen hata"));
  }
}

function cursorRunning() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq Cursor.exe", "/NH"], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(!err && /Cursor\.exe/i.test(String(stdout || "")));
    });
  });
}

async function stopCursor() {
  if (!(await cursorRunning())) return false;
  // Önce nazikçe kapat (WM_CLOSE)
  try { await run("taskkill", ["/IM", "Cursor.exe"]); } catch {}
  // 3 saniye bekle — hâlâ çalışıyorsa zorla öldür
  await sleep(3000);
  if (await cursorRunning()) {
    try { await run("taskkill", ["/F", "/T", "/IM", "Cursor.exe"]); } catch {}
  }
  return true;
}

function cursorExe() {
  const local = process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local");
  const hits = [
    path.join(local, "Programs", "cursor", "Cursor.exe"),
    path.join(local, "cursor", "Cursor.exe"),
    "C:\\Program Files\\Cursor\\Cursor.exe",
  ];
  return hits.find((file) => fs.existsSync(file)) || hits[0];
}

function startCursor() {
  const exe = cursorExe();
  if (!fs.existsSync(exe)) return Promise.resolve();
  const env = Object.assign({}, process.env);
  // CA sertifikasını Electron/Node HTTPS için ek güven deposuna ekle
  try {
    const cp = certPath();
    if (fs.existsSync(cp)) env.NODE_EXTRA_CA_CERTS = cp;
  } catch {}
  return new Promise((resolve) => {
    execFile(exe, [
      "--ignore-certificate-errors",
      "--ignore-ssl-errors",
      "--allow-insecure-localhost",
    ], {
      windowsHide: false,
      detached: true,
      stdio: "ignore",
      env,
    }, () => {});
    resolve();
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("connect", onConnect);
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      boundPort = srv.address().port;
      server = srv;
      resolve(boundPort);
    });
  });
}

function onConnect(req, client, head) {
  const hostHeader = String(req.url || "");
  const host = hostHeader.split(":")[0];
  const port = Number(hostHeader.split(":")[1] || 443);
  // CONNECT logunu gizle — sadece önemli olanları göster
  if (!isCursorHost(host)) {
    const upstream = net.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    return;
  }
  let leaf;
  try {
    leaf = leafFor(host);
  } catch (err) {
    lastError = String(err.message || err);
    client.destroy();
    return;
  }
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const ctx = tls.createSecureContext({
    cert: leaf.cert,
    key: leaf.key,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
  });
  const secure = new tls.TLSSocket(client, {
    isServer: true,
    secureContext: ctx,
    SNICallback: (sni, cb) => {
      try {
        const next = leafFor(sni || host);
        cb(null, tls.createSecureContext({
          cert: next.cert,
          key: next.key,
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.3",
        }));
      } catch (err) {
        cb(err);
      }
    },
    requestCert: false,
    rejectUnauthorized: false,
    ALPNProtocols: ["http/1.1"],
  });
  secure.setMaxListeners(0);
  if (head && head.length) secure.unshift(head);
  secure.on("error", (err) => {
    const msg = String(err && err.message || err || "tls");
    console.log("[TLS-ERR]", host, msg);
    lastError = msg;
    secure.destroy();
  });
  secure.on("secureConnect", () => {
    console.log("[TLS-OK]", host, "protocol=" + secure.getProtocol(), "alpn=" + secure.alpnProtocol);
  });
  secure.on("tlsClientError", (err) => {
    console.log("[TLS-CLIENT-ERR]", host, String(err && err.message || err));
  });
  relayHttps(secure, host, port);
}

function decodeChunked(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl < 0) return null;
    const size = parseInt(buf.subarray(i, nl).toString("ascii").split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) return null;
    i = nl + 2;
    if (size === 0) {
      const end = buf.indexOf("\r\n\r\n", i - 2);
      if (end < 0) return null;
      return { body: Buffer.concat(parts), rest: buf.subarray(end + 4) };
    }
    if (i + size + 2 > buf.length) return null;
    parts.push(buf.subarray(i, i + size));
    i += size;
    if (buf[i] !== 13 || buf[i + 1] !== 10) return null;
    i += 2;
    if (Buffer.concat(parts).length > 8 * 1024 * 1024) return null;
  }
  return null;
}

function readRequest(socket) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error("Cursor bağlantısı kapandı."));
      return;
    }
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onFail);
      socket.removeListener("end", onFail);
      socket.removeListener("close", onFail);
    };
    const onFail = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error("Cursor bağlantısı kapandı."));
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const cut = buffered.indexOf("\r\n\r\n");
      if (cut < 0) {
        if (buffered.length > 1024 * 256) onFail(new Error("Cursor isteği çok büyük."));
        return;
      }
      const head = buffered.subarray(0, cut).toString("latin1");
      const rows = head.split("\r\n");
      const parts = (rows[0] || "").split(" ");
      const headers = {};
      rows.slice(1).forEach((row) => {
        const i = row.indexOf(":");
        if (i > 0) headers[row.slice(0, i).trim().toLowerCase()] = row.slice(i + 1).trim();
      });
      const bodyStart = cut + 4;
      const chunked = /chunked/i.test(headers["transfer-encoding"] || "");
      if (chunked) {
        const decoded = decodeChunked(buffered.subarray(bodyStart));
        if (!decoded) {
          if (buffered.length > 8 * 1024 * 1024) onFail(new Error("Cursor gövde boyutu geçersiz."));
          return;
        }
        cleanup();
        if (decoded.rest.length) socket.unshift(decoded.rest);
        resolve({
          method: parts[0] || "GET",
          target: parts[1] || "/",
          headers,
          body: decoded.body,
        });
        return;
      }
      const length = Number(headers["content-length"] || 0);
      if (!Number.isFinite(length) || length < 0 || length > 8 * 1024 * 1024) {
        onFail(new Error("Cursor gövde boyutu geçersiz."));
        return;
      }
      if (buffered.length < bodyStart + length) return;
      cleanup();
      const rest = buffered.subarray(bodyStart + length);
      if (rest.length) socket.unshift(rest);
      resolve({
        method: parts[0] || "GET",
        target: parts[1] || "/",
        headers,
        body: buffered.subarray(bodyStart, bodyStart + length),
      });
    };
    socket.on("data", onData);
    socket.once("error", onFail);
    socket.once("end", onFail);
    socket.once("close", onFail);
  });
}

function writeHttp(socket, status, headers, body) {
  const lines = ["HTTP/1.1 " + status];
  const payload = body || Buffer.alloc(0);
  const out = { ...headers };
  if (!out["content-length"] && !out["transfer-encoding"]) out["content-length"] = String(payload.length);
  for (const [name, value] of Object.entries(out)) {
    if (value == null) continue;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item) => lines.push(name + ": " + item));
  }
  socket.write(lines.join("\r\n") + "\r\n\r\n");
  if (payload.length) socket.write(payload);
}

function protoLocal(socket, body) {
  // Connect protokolü: 5 byte frame header + payload
  const framed = catalog.connectFrame(body || Buffer.alloc(0));
  writeHttp(socket, "200 OK", {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    "access-control-allow-origin": "*",
  }, framed);
}

function localCatalog(socket, target) {
  const path = String(target || "/").split("?")[0];
  const extra = catalog.catalogBody(path, models) || Buffer.alloc(0);
  protoLocal(socket, extra);
}

function handleCatalog(socket, req, host, port, path) {
  catalogHits += 1;
  const mc = models.length;
  console.log("[CATALOG]", path, "modelCount=" + mc, "catalogHits=" + catalogHits);
  lastError = mc
    ? ""
    : "Katalog isteği geldi ama Cortex'te Cursor modeli yok.";
  const extra = catalog.catalogBody(path, models) || Buffer.alloc(0);
  console.log("[CATALOG] extra bytes=" + extra.length);
  const merge = /AvailableModels$|GetUsableModels$|ListModels$/.test(path);
  if (!merge) {
    protoLocal(socket, extra);
    return Promise.resolve();
  }
  const skip = hopByHop();
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (skip.has(name)) continue;
    headers[name] = value;
  }
  headers.host = host;
  headers["content-length"] = String((req.body || Buffer.alloc(0)).length);
  delete headers["accept-encoding"];
  return new Promise((resolve) => {
    const chunks = [];
    const upstream = https.request({
      host,
      port,
      method: req.method,
      path: req.target,
      headers,
      servername: host,
      rejectUnauthorized: true,
    }, (res) => {
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let raw = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        if (enc.includes("gzip") || enc.includes("deflate")) {
          try {
            raw = enc.includes("gzip")
              ? require("zlib").gunzipSync(raw)
              : require("zlib").inflateSync(raw);
          } catch { /* keep compressed; merge falls back */ }
        }
        console.log("[MERGE] upstream=" + raw.length + " extra=" + extra.length + " status=" + res.statusCode);
        let mergeResult;
        try {
          mergeResult = catalog.mergeCatalog(raw, extra, res.statusCode);
        } catch (mergeErr) {
          console.log("[MERGE-ERR]", String(mergeErr && mergeErr.message || mergeErr));
          mergeResult = { body: extra, contentType: "application/proto" };
        }
        const body = mergeResult.body;
        console.log("[MERGE] result=" + body.length + " bytes ct=" + (mergeResult.contentType || "upstream"));
        const out = {};
        for (const [name, value] of Object.entries(res.headers)) {
          const key = String(name).toLowerCase();
          if (skip.has(key) || key === "content-length" || key === "content-encoding" || key === "transfer-encoding") continue;
          out[name] = value;
        }
        // contentType null ise upstream'in content-type'ını koru; değilse override et
        if (mergeResult.contentType) {
          out["content-type"] = mergeResult.contentType;
          delete out["connect-protocol-version"];
        }
        out["content-length"] = String(body.length);
        // Upstream 4xx/5xx olsa bile modelleri göstermek için 200 döndür
        const statusCode = (res.statusCode >= 200 && res.statusCode < 300) ? res.statusCode : 200;
        writeHttp(socket, statusCode + " OK", out, body);
        resolve();
      });
      res.on("error", () => {
        protoLocal(socket, extra);
        resolve();
      });
    });
    upstream.on("error", () => {
      protoLocal(socket, extra);
      resolve();
    });
    if (req.body && req.body.length) upstream.write(req.body);
    upstream.end();
  });
}

// Modül seviyesinde sabit — her çağrıda yeniden oluşturmaya gerek yok
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "proxy-connection",
]);

function hopByHop() {
  return HOP_BY_HOP;
}

function writeHead(socket, status, headers) {
  const lines = ["HTTP/1.1 " + status];
  for (const [name, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item) => lines.push(name + ": " + item));
  }
  socket.write(lines.join("\r\n") + "\r\n\r\n");
}

function connectedProto() {
  return catalog.catalogBody
    ? Buffer.concat([Buffer.from([0x08, 0x01])])
    : Buffer.from([0x08, 0x01]);
}

function handleLocal(socket, req, host, port) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") {
    writeHttp(socket, "204 No Content", {
      "access-control-allow-origin": req.headers.origin || "vscode-file://vscode-app",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": req.headers["access-control-request-headers"] || "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-max-age": "86400",
      vary: "Origin",
    }, Buffer.alloc(0));
    return Promise.resolve();
  }
  const path = catalog.rpcPath(req.target);
  if (catalog.isCatalogPath(path)) {
    return handleCatalog(socket, req, host, port, path);
  }
  if (agent.isPluginsPath && agent.isPluginsPath(path)) {
    protoLocal(socket, Buffer.alloc(0));
    return Promise.resolve();
  }
  if (agent.isAccountPath(path)) {
    const body = agent.accountBody(path);
    const json = agent.isStripePath && agent.isStripePath(path);
    writeHttp(socket, "200 OK", {
      "content-type": agent.accountContentType ? agent.accountContentType(path) : (json ? "application/json" : "application/proto"),
      "connect-protocol-version": json ? undefined : "1",
      "access-control-allow-origin": req.headers.origin || "vscode-file://vscode-app",
      "access-control-allow-credentials": "true",
      vary: "Origin",
    }, json ? body : catalog.connectFrame(body));
    return Promise.resolve();
  }
  if (agent.isConnected(path)) {
    writeHttp(socket, "200 OK", {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
    }, catalog.connectFrame(Buffer.from([0x08, 0x01])));
    return Promise.resolve();
  }
  if (agent.isBidi(path)) {
    return agent.handleBidi(req).then((result) => {
      if (result.forward) return forwardStream(socket, req, host, port);
      writeHttp(socket, result.status, result.headers, result.body);
    });
  }
  if (agent.isRunSse(path)) {
    const id = agent.extractRequestId(req);
    if (!id) {
      writeHttp(socket, "409 Conflict", { "content-type": "text/plain" }, Buffer.from("missing_transport"));
      return Promise.resolve();
    }
    return agent.registry.waitRoute(id, 15000).then((route) => {
      if (route.kind === "local") return agent.streamLocalSse(socket, route.handle);
      return forwardStream(socket, req, host, port);
    }).catch((err) => {
      lastError = String(err.message || err);
      writeHttp(socket, "409 Conflict", { "content-type": "text/plain" }, Buffer.from("missing_transport"));
    });
  }
  return forwardStream(socket, req, host, port);
}

function forwardBuffered(socket, req, host, port, mutate) {
  const skip = hopByHop();
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (skip.has(name)) continue;
    headers[name] = value;
  }
  headers.host = host;
  headers["content-length"] = String((req.body || Buffer.alloc(0)).length);
  return new Promise((resolve) => {
    const chunks = [];
    const upstream = https.request({
      host,
      port,
      method: req.method,
      path: req.target,
      headers,
      servername: host,
      rejectUnauthorized: true,
    }, (res) => {
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let body = Buffer.concat(chunks);
        try { body = mutate(body) || body; } catch {}
        const out = {};
        for (const [name, value] of Object.entries(res.headers)) {
          const key = String(name).toLowerCase();
          if (skip.has(key) || key === "content-length") continue;
          out[name] = value;
        }
        out["content-length"] = String(body.length);
        writeHttp(socket, res.statusCode + " " + (res.statusMessage || "OK"), out, body);
        resolve();
      });
      res.on("error", () => { socket.destroy(); resolve(); });
    });
    upstream.on("error", (err) => {
      lastError = String(err.message || err);
      socket.destroy();
      resolve();
    });
    if (req.body && req.body.length) upstream.write(req.body);
    upstream.end();
  });
}

function forwardStream(socket, req, host, port) {
  const skip = hopByHop();
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (skip.has(name)) continue;
    headers[name] = value;
  }
  headers.host = host;
  headers["content-length"] = String((req.body || Buffer.alloc(0)).length);
  return new Promise((resolve) => {
    const upstream = https.request({
      host,
      port,
      method: req.method,
      path: req.target,
      headers,
      servername: host,
      rejectUnauthorized: true,
    }, (res) => {
      const out = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (skip.has(String(name).toLowerCase())) continue;
        out[name] = value;
      }
      writeHead(socket, res.statusCode + " " + (res.statusMessage || ""), out);
      res.on("data", (chunk) => socket.write(chunk));
      res.on("end", () => resolve());
      res.on("error", () => { socket.destroy(); resolve(); });
    });
    upstream.on("error", (err) => {
      lastError = String(err.message || err);
      socket.destroy();
      resolve();
    });
    if (req.body && req.body.length) upstream.write(req.body);
    upstream.end();
  });
}

function relayHttps(socket, host, port) {
  const loop = () => {
    if (socket.destroyed) return;
    readRequest(socket).then((req) => {
      const path = catalog.rpcPath(req.target);
      const pathStr = String(req.target || "").split("?")[0];
      console.log("[REQ]", req.method, pathStr);
      // 409 döndüren isteği özellikle logla
      if (pathStr.includes("agent") || pathStr.includes("Agent") || pathStr.includes("Chat") || pathStr.includes("Bidi") || pathStr.includes("SSE") || pathStr.includes("Stream")) {
        console.log("[AGENT-REQ]", req.method, pathStr, "body_len=" + (req.body ? req.body.length : 0));
      }
      const job = agent.isLocalPath(path)
        ? handleLocal(socket, req, host, port)
        : forwardStream(socket, req, host, port);
      return job.then(() => loop());
    }).catch((err) => {
      lastError = String(err.message || err);
      socket.destroy();
    });
  };
  loop();
}

async function enable(onStep) {
  if (busy) return busy;
  const step = (name, done, error) => {
    try { if (typeof onStep === "function") onStep({ step: name, done: !!done, error: error || "" }); } catch {}
  };
  busy = (async () => {
    lastError = "";
    step("cursor-stop", false);
    try { await stopCursor(); } catch {}
    step("cursor-stop", true);

    step("ca", false);
    if (!fs.existsSync(certPath()) || !fs.existsSync(keyPath())) {
      wipeHomemadeCa();
      purgeWindowsCa();
    }
    leafCache.clear();
    try { loadCa(); } catch {
      wipeHomemadeCa();
      purgeWindowsCa();
    }
    ensureCa();
    step("ca", true);

    step("trust", false);
    if (!(await trusted())) await trustCa();
    step("trust", true);

    step("cursor-stop2", false);
    try { await stopCursor(); } catch {}
    step("cursor-stop2", true);

    clearCursorPins();

    step("proxy", false);
    if (!server) {
      try {
        await listen(PORT);
      } catch {
        await listen(0);
      }
    }
    step("proxy", true);

    step("settings", false);
    const url = proxyUrl();
    applySettings(url);
    step("settings", true);

    step("inject", false);
    try { await injectCursorAccount(); } catch (err) { lastError = String(err.message || err); }
    startInjectLoop();
    step("inject", true);

    step("cursor-start", false);
    try { await startCursor(); } catch {}
    step("cursor-start", true);

    setTimeout(() => { injectCursorAccount().catch(() => {}); }, 1500);
    setTimeout(() => { injectCursorAccount().catch(() => {}); }, 4000);
    return status();
  })();
  try { return await busy; }
  finally { busy = null; }
}

async function disable() {
  if (busy) await busy.catch(() => {});
  stopInjectLoop();
  clearSettings();
  if (server) {
    const current = server;
    server = null;
    boundPort = 0;
    try { current.closeAllConnections && current.closeAllConnections(); } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      current.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return status();
}

async function toggle(on, onStep) {
  return on ? enable(onStep) : disable();
}

async function status() {
  const url = proxyUrl();
  const running = !!(server && boundPort);
  let ca = "missing";
  if (fs.existsSync(certPath()) && fs.existsSync(keyPath())) {
    ca = (await trusted()) ? "ready" : "untrusted";
  }
  const applied = running && settingsMatch(url);
  return {
    running,
    settingsApplied: applied,
    enabled: running && applied,
    ca,
    proxyUrl: running ? url : "",
    port: running ? boundPort : 0,
    cursorOpen: await cursorRunning(),
    error: lastError,
    modelCount: models.length,
    catalogHits,
  };
}

module.exports = { status, toggle, enable, disable, PORT, setModels };
