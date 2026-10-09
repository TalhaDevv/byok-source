const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
];
const MARKER = "antigravity-byok-hijack";
const LOCAL = "http://127.0.0.1:3000";

// Güvenli hostname doğrulama — yalnızca geçerli DNS karakterlerine izin ver
function assertSafeHostname(value, label) {
  if (!/^[a-zA-Z0-9.\-]+$/.test(String(value || ""))) {
    throw new Error("Güvensiz " + (label || "değer") + " tespit edildi: " + value);
  }
}

// MARKER yalnızca alfanümerik + tire + alt çizgi içerebilir
function assertSafeMarker(value) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(value || ""))) {
    throw new Error("Güvensiz MARKER değeri: " + value);
  }
}

// Modül yüklenirken sabit değerleri doğrula
assertSafeMarker(MARKER);
HOSTS.forEach((h) => assertSafeHostname(h, "HOSTS"));

function pad(url, n) {
  if (url.length > n) throw new Error("url longer than slot");
  return Buffer.from(url + "/".repeat(n - url.length), "ascii");
}

const REPLACEMENTS = [
  [Buffer.from("https://daily-cloudcode-pa.googleapis.com", "ascii"), pad(LOCAL, 41)],
  [Buffer.from("https://cloudcode-pa.googleapis.com", "ascii"), pad(LOCAL, 35)],
];

function engineDir() {
  return path.join(
    os.homedir(),
    ".antigravity",
    "extensions",
    "yeqing.vertex-proxy-engine-1.2.0-universal",
    "engine"
  );
}

function languageServer() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Programs",
    "Antigravity",
    "resources",
    "bin",
    "language_server.exe"
  );
}

function etcDir() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc");
}

function hostsPath() {
  return path.join(etcDir(), "hosts");
}

function hostsTargets() {
  return [path.join(etcDir(), "hosts"), path.join(etcDir(), "hosts.ics")];
}

function caPath() {
  return path.join(engineDir(), "tls", "hijack-ca.crt");
}

let child = null;

function listening(port) {
  const net = require("net");
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => {
      s.end();
      resolve(true);
    });
    s.setTimeout(400, () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(false));
  });
}

function engineAlive() {
  return listening(3001);
}

function hostsLineOk(line, host) {
  const t = line.trim();
  if (!t || t.startsWith("#")) return false;
  const parts = t.split(/\s+/);
  if (parts.length < 2) return false;
  const ip = parts[0].toLowerCase();
  if (ip !== "127.0.0.1" && ip !== "::1") return false;
  return parts.slice(1).some((name) => name.toLowerCase() === host);
}

function hostsFileOk(text) {
  const lines = String(text || "").split(/\r?\n/);
  return HOSTS.every((host) => lines.some((line) => hostsLineOk(line, host)));
}

function hostsInstalled() {
  return hostsTargets().every((file) => {
    try {
      return hostsFileOk(fs.readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  });
}

function stampPath() {
  return path.join(engineDir(), "patch-stamp.json");
}

function binaryStamp() {
  const exe = languageServer();
  const bak = exe + ".byok.bak";
  const exeStat = fs.existsSync(exe) ? fs.statSync(exe) : null;
  const bakStat = fs.existsSync(bak) ? fs.statSync(bak) : null;
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(stampPath(), "utf8")); } catch {}
  const patched = !!(exeStat && fs.readFileSync(exe).includes(Buffer.from(LOCAL, "ascii")));
  const drifted = !!(stamp && exeStat && (stamp.size !== exeStat.size || stamp.mtimeMs !== exeStat.mtimeMs) && !patched);
  return {
    patched,
    drifted,
    exeSize: exeStat ? exeStat.size : 0,
    exeMtime: exeStat ? exeStat.mtimeMs : 0,
    bakSize: bakStat ? bakStat.size : 0,
  };
}

function rememberPatch() {
  const exe = languageServer();
  if (!fs.existsSync(exe)) return;
  const stat = fs.statSync(exe);
  fs.mkdirSync(engineDir(), { recursive: true });
  fs.writeFileSync(stampPath(), JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs }), "utf8");
}

function binaryPatched() {
  return binaryStamp().patched;
}

function certInfo() {
  const file = caPath();
  if (!fs.existsSync(file)) return { trusted: false, days: null, until: "" };
  let trusted = false;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "certutil",
      ["-store", "Root", "Antigravity BYOK Local CA"],
      { encoding: "utf8", windowsHide: true }
    );
    trusted = /================/i.test(out) && !/cannot find/i.test(out);
  } catch {
    trusted = false;
  }
  let days = null;
  let until = "";
  try {
    const { execFileSync } = require("child_process");
    const dump = execFileSync("certutil", ["-dump", file], { encoding: "utf8", windowsHide: true });
    const hit = dump.match(/NotAfter:\s*([0-9./: ]+)/i) || dump.match(/Not After:\s*(.+)/i);
    if (hit) {
      const raw = hit[1].trim();
      const parsed = Date.parse(raw.replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$2-$1"));
      if (!Number.isNaN(parsed)) {
        until = new Date(parsed).toISOString().slice(0, 10);
        days = Math.floor((parsed - Date.now()) / 86400000);
      } else {
        until = raw.slice(0, 24);
      }
    }
  } catch {}
  return { trusted, days, until };
}

function certTrusted() {
  return certInfo().trusted;
}

function stepsOf(partial) {
  const cert = partial.certInfo || { trusted: !!partial.cert, days: null, until: "" };
  const list = [
    { id: "engine", ok: !!partial.engine, title: "Motor dosyası", detail: partial.engine ? "engine.exe yerinde." : "engine.exe bulunamadı." },
    { id: "language", ok: !!partial.languageServer, title: "AntiGravity", detail: partial.languageServer ? "language_server.exe bulundu." : "AntiGravity kurulumu yok." },
    { id: "binary", ok: !!partial.binary && !partial.patchDrift, title: "Adres yaması", detail: partial.patchDrift ? "Yama düştü. AntiGravity güncellenmiş. Yeniden aç." : (partial.binary ? "İstekler 127.0.0.1:3000 adresine gidiyor." : "Yama yok. Açık konumu bunu yazar.") },
    { id: "hosts", ok: !!partial.hosts, title: "Yönlendirme", detail: partial.hosts ? "Google adresleri bu bilgisayara bakıyor." : "hosts satırları yok ya da bozuk." },
    { id: "cert", ok: !!partial.cert, title: "Sertifika", detail: cert.trusted ? "Kök depoya yüklü." : "Kök depoda yok." },
    { id: "running", ok: !!partial.running, title: "Canlı motor", detail: partial.running ? "3001 dinliyor." : "Motor kapalı." },
  ];
  return list;
}

async function status() {
  const dir = engineDir();
  const running = await engineAlive();
  const cert = certInfo();
  const bin = binaryStamp();
  const partial = {
    running,
    pid: running && child && child.exitCode === null ? child.pid : 0,
    hosts: hostsInstalled(),
    binary: bin.patched,
    patchDrift: bin.drifted,
    cert: cert.trusted,
    certDays: cert.days,
    certUntil: cert.until,
    engine: fs.existsSync(path.join(dir, "engine.exe")),
    languageServer: fs.existsSync(languageServer()),
  };
  partial.steps = stepsOf({ ...partial, certInfo: cert });
  return partial;
}

function runElevated(statements) {
  const { execFileSync } = require("child_process");
  const stamp = Date.now();
  const file = path.join(os.tmpdir(), "cortex-elevate-" + stamp + ".ps1");
  const log = path.join(os.tmpdir(), "cortex-elevate-" + stamp + ".log");
  const err = path.join(os.tmpdir(), "cortex-elevate-" + stamp + ".err");
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const body = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    ...statements.map((line) => "  " + line),
    "  Set-Content -Encoding ASCII -LiteralPath " + q(log) + " -Value 'OK'",
    "} catch {",
    "  Set-Content -Encoding UTF8 -LiteralPath " + q(err) + " -Value $_.Exception.Message",
    "  exit 1",
    "}",
  ].join("\r\n");
  fs.writeFileSync(file, body, "utf8");
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File'," + q(file) + ")",
      ],
      { windowsHide: true }
    );
    if (fs.existsSync(err)) {
      const detail = fs.readFileSync(err, "utf8").trim();
      throw new Error(detail || "Kurulum adımı başarısız.");
    }
    if (!fs.existsSync(log)) throw new Error("Yönetici onayı verilmedi.");
  } catch (e) {
    // Sadece err/log dosya içeriğiyle zenginleştir, temizlik finally'de yapılıyor
    if (!(e.message && (e.message.includes("Yönetici") || e.message.includes("Kurulum")))) {
      const detail = fs.existsSync(err) ? fs.readFileSync(err, "utf8").trim() : "";
      if (detail) throw new Error(detail);
      if (!fs.existsSync(log)) throw new Error("Yönetici onayı verilmedi.");
    }
    throw e;
  } finally {
    // Hata olsun olmasın geçici dosyaları temizle
    for (const f of [file, log, err]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

function patchBytes(data) {
  let next = Buffer.from(data);
  for (const [oldB, neu] of REPLACEMENTS) {
    const parts = [];
    let from = 0;
    let hits = 0;
    while (from < next.length) {
      const at = next.indexOf(oldB, from);
      if (at < 0) break;
      parts.push(next.subarray(from, at), neu);
      from = at + oldB.length;
      hits += 1;
    }
    parts.push(next.subarray(from));
    next = Buffer.concat(parts);
    if (!hits && !next.includes(neu)) {
      throw new Error("Cloud Code adresi ikilide yok. Antigravity sürümü farklı olabilir.");
    }
  }
  return next;
}

function installMachine() {
  const exe = languageServer();
  const bak = exe + ".byok.bak";
  if (!fs.existsSync(exe)) throw new Error("Antigravity language_server.exe bulunamadı.");
  if (!fs.existsSync(bak)) {
    try { fs.copyFileSync(exe, bak); }
    catch (err) {
      if (err.code !== "EBUSY" && err.code !== "EPERM") throw err;
    }
  }
  const source = fs.existsSync(bak) ? bak : exe;
  const patched = path.join(os.tmpdir(), "cortex-ls-" + Date.now() + ".bin");
  fs.writeFileSync(patched, patchBytes(fs.readFileSync(source)));

  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const block =
    "# " + MARKER + "\r\n" +
    "127.0.0.1 " + HOSTS[0] + "\r\n" +
    "::1 " + HOSTS[0] + "\r\n" +
    "127.0.0.1 " + HOSTS[1] + "\r\n" +
    "::1 " + HOSTS[1] + "\r\n" +
    "# end-" + MARKER;
  const blockPs = "@'\r\n" + block.replace(/'/g, "''") + "\r\n'@";
  const statements = [
    "Get-Process language_server, Antigravity -ErrorAction SilentlyContinue | Stop-Process -Force",
    "Start-Sleep -Milliseconds 700",
    "if (-not (Test-Path -LiteralPath " + q(bak) + ")) { Copy-Item -LiteralPath " + q(exe) + " -Destination " + q(bak) + " -Force }",
    "$moved = $false",
    "for ($i = 0; $i -lt 8 -and -not $moved; $i++) {",
    "  try { Move-Item -LiteralPath " + q(exe) + " -Destination (" + q(exe) + " + '.old') -Force -ErrorAction Stop; $moved = $true }",
    "  catch { Start-Sleep -Milliseconds 400 }",
    "}",
    "if (-not $moved) { throw 'language_server.exe kilitli. Antigravity kapanmadı.' }",
    "Copy-Item -LiteralPath " + q(patched) + " -Destination " + q(exe) + " -Force",
    "Remove-Item -LiteralPath (" + q(exe) + " + '.old') -Force -ErrorAction SilentlyContinue",
    "$block = " + blockPs,
    "$names = @(" + HOSTS.map(q).join(",") + ")",
    "function Strip-Hijack([string]$raw) {",
    "  $raw = $raw.Replace('# " + MARKER + "\\r\\n127.0.0.1', '')",
    "  $clean = [regex]::Replace($raw, '(?s)\\r?\\n?#\\s*" + MARKER + ".*?#\\s*end-" + MARKER + "\\r?\\n?', \"`r`n\")",
    "  $kept = @($clean -split \"`r`n|`n\" | Where-Object { $line = $_; -not ($names | Where-Object { $line -like ('*' + $_ + '*') }) })",
    "  return (($kept -join \"`r`n\").TrimEnd() + \"`r`n\")",
    "}",
    "foreach ($p in @(" + hostsTargets().map(q).join(",") + ")) {",
    "  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType File -Path $p -Force | Out-Null }",
    "  $item = Get-Item -LiteralPath $p -Force",
    "  $prev = $item.Attributes",
    "  $item.Attributes = [IO.FileAttributes]::Normal",
    "  $body = Strip-Hijack ([IO.File]::ReadAllText($p))",
    "  [IO.File]::WriteAllText($p, $body + $block + \"`r`n\")",
    "  (Get-Item -LiteralPath $p -Force).Attributes = $prev -band (-bnot [IO.FileAttributes]::ReadOnly)",
    "}",
    "if (Test-Path -LiteralPath " + q(caPath()) + ") { certutil -addstore -f Root " + q(caPath()) + " | Out-Null }",
    "Clear-DnsClientCache",
    "ipconfig /flushdns | Out-Null",
  ];
  try {
    runElevated(statements);
    rememberPatch();
  } finally {
    try { fs.unlinkSync(patched); } catch {}
  }
}

function removeMachine(opts) {
  const killApps = !(opts && opts.killApps === false);
  const exe = languageServer();
  const bak = exe + ".byok.bak";
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const statements = [
    ...(killApps
      ? [
          "Get-Process language_server, Antigravity -ErrorAction SilentlyContinue | Stop-Process -Force",
          "Start-Sleep -Milliseconds 700",
        ]
      : []),
    "if ((Test-Path -LiteralPath " + q(bak) + ") -and (Test-Path -LiteralPath " + q(exe) + ")) { Copy-Item -LiteralPath " + q(bak) + " -Destination " + q(exe) + " -Force }",
    "$names = @(" + HOSTS.map(q).join(",") + ")",
    "foreach ($p in @(" + hostsTargets().map(q).join(",") + ")) {",
    "  if (-not (Test-Path -LiteralPath $p)) { continue }",
    "  $item = Get-Item -LiteralPath $p -Force",
    "  $prev = $item.Attributes",
    "  $item.Attributes = [IO.FileAttributes]::Normal",
    "  $raw = [IO.File]::ReadAllText($p)",
    "  $clean = [regex]::Replace($raw, '(?s)\\r?\\n?#\\s*" + MARKER + ".*?#\\s*end-" + MARKER + "\\r?\\n?', \"`r`n\")",
    "  $kept = $clean -split \"`r`n|`n\" | Where-Object { $line = $_; -not ($names | Where-Object { $line -like ('*' + $_ + '*') }) }",
    "  [IO.File]::WriteAllText($p, ($kept -join \"`r`n\").TrimEnd() + \"`r`n\")",
    "  (Get-Item -LiteralPath $p -Force).Attributes = $prev -band (-bnot [IO.FileAttributes]::ReadOnly)",
    "}",
    "Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -match 'Antigravity BYOK' } | ForEach-Object {",
    "  $storeName = if ($_.PSParentPath -match 'LocalMachine') { 'LocalMachine' } else { 'CurrentUser' }",
    "  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', $storeName)",
    "  $store.Open('ReadWrite'); $store.Remove($_); $store.Close()",
    "}",
    "Clear-DnsClientCache -ErrorAction SilentlyContinue",
    "ipconfig /flushdns | Out-Null",
  ];
  runElevated(statements);
}

function killStaleEngine() {
  const { execFileSync } = require("child_process");
  const dir = engineDir().replace(/'/g, "''");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "$root = '" + dir + "'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'engine.exe' -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root)) -or ($_.CommandLine -and $_.CommandLine -match 'proxy-port=3000')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
    { windowsHide: true }
  );
}

async function portsFree() {
  const flags = await Promise.all([3000, 3001, 443].map((port) => listening(port)));
  const busy = [3000, 3001, 443].filter((_, i) => flags[i]);
  return { ok: busy.length === 0, busy };
}

async function ensureSingleEngine() {
  if (child && child.exitCode === null) {
    try { child.kill(); } catch {}
    child = null;
  }
  let last = { ok: false, busy: [3000, 3001, 443] };
  for (let i = 0; i < 12; i += 1) {
    last = await portsFree();
    if (last.ok) return;
    try { killStaleEngine(); } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!last.ok) {
    throw new Error("Eski motor şu portu bırakmadı: " + last.busy.join(", ") + ".");
  }
}

function parseEngineLog(text) {
  const lines = String(text || "").split(/\r?\n/);
  const items = [];
  let current = null;
  const push = () => {
    if (current) items.push(current);
    current = null;
  };
  for (const line of lines) {
    const head = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) (.*)$/);
    if (!head) continue;
    const at = head[1];
    const msg = head[2];
    const start = msg.match(/\[proxy\] ========== REQUEST #(\d+) ==========/);
    if (start) {
      push();
      current = { id: Number(start[1]), at, path: "", size: 0, turns: 0, from: "", to: "", stream: false, error: "", kind: "üretim" };
      continue;
    }
    if (!current) {
      const pass = msg.match(/\[passthrough\] (\w+) (\S+)/);
      if (pass) {
        items.push({ id: 0, at, path: pass[2], size: 0, turns: 0, from: "", to: "", stream: false, error: "", kind: "geçiş" });
      }
      continue;
    }
    const url = msg.match(/\[proxy\] #\d+ URL: (\S+)/);
    const size = msg.match(/\[proxy\] #\d+ Body size: (\d+)/);
    const ide = msg.match(/\[proxy\] #\d+ IDE model=([^,]+), contents turns=(\d+)/);
    const route = msg.match(/\[proxy\] #\d+ route: (\S+) → (\S+) \(stream=(true|false)\)/);
    const err = msg.match(/\[(?:openai-sse|openai|proxy)\].*((?:error|token too long).*)/i);
    if (url) current.path = url[1];
    if (size) current.size = Number(size[1]);
    if (ide) { current.from = ide[1]; current.turns = Number(ide[2]); }
    if (route) { current.to = route[2]; current.stream = route[3] === "true"; }
    if (err && !/\[proxy\] #/.test(msg)) current.error = err[1];
    if (/\[proxy\] in |\[passthrough\]/.test(msg)) push();
  }
  push();
  const errors = [];
  for (const line of lines) {
    if (/error|token too long|bind:/i.test(line)) errors.push(line.trim());
  }
  const last = errors.length ? errors[errors.length - 1] : "";
  const lastAt = (last.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || "";
  const recent = items.filter((it) => it.kind === "üretim").slice(-40);
  const newer = recent.some((it) => lastAt && it.at >= lastAt && !it.error);
  const lastError = last && !newer ? last.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /, "") : "";
  return { items: recent.reverse(), lastError };
}

function activity() {
  const file = path.join(engineDir(), "engine.log");
  let text = "";
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - 180000);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    text = "";
  }
  return parseEngineLog(text);
}

function rotateLog() {
  const file = path.join(engineDir(), "engine.log");
  try {
    const stat = fs.statSync(file);
    if (stat.size < 8 * 1024 * 1024) return;
    const prev = file + ".1";
    try { fs.unlinkSync(prev); } catch {}
    fs.renameSync(file, prev);
  } catch {}
}

function writeEngineConfig(apiKey, baseUrl, model) {
  const file = path.join(engineDir(), "config.json");
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { providers: {}, mappings: {} };
  cfg.providers = cfg.providers || {};
  cfg.providers.openai = { api_key: apiKey, base_url: baseUrl };
  cfg.default_route = { provider: "openai", model };
  const mappings = cfg.mappings || {};
  for (const name of Object.keys(mappings)) {
    mappings[name] = { provider: "openai", model };
  }
  const known = [
    "gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.8-pro",
    "gemini-3.8-pro-low", "gemini-3.8-pro-high", "gemini-3.1-flash-lite",
    "gemini-3.1-pro-low", "gemini-3.1-pro-high", "gemini-pro-agent",
    "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  ];
  for (const name of known) mappings[name] = { provider: "openai", model };
  cfg.mappings = mappings;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
}

let _onCrash = null;

function onCrash(fn) {
  _onCrash = typeof fn === "function" ? fn : null;
}

async function startEngine(apiKey, baseUrl, model) {
  const dir = engineDir();
  const exe = path.join(dir, "engine.exe");
  if (!fs.existsSync(exe)) throw new Error("engine.exe yok: " + exe);
  await ensureSingleEngine();
  writeEngineConfig(apiKey, baseUrl, model);
  rotateLog();
  const log = fs.openSync(path.join(dir, "engine.log"), "a");
  child = spawn(
    exe,
    [
      "--proxy-port=3000",
      "--admin-port=3001",
      "--tls-port=443",
      "--config-path=" + path.join(dir, "config.json"),
      "--db-path=" + path.join(dir, "proxy.db"),
      "--mode=proxy",
    ],
    { cwd: dir, stdio: ["pipe", log, log], windowsHide: true }
  );
  const timer = setInterval(() => {
    if (!child || child.exitCode !== null) {
      clearInterval(timer);
      return;
    }
    try { child.stdin.write("\n"); } catch { clearInterval(timer); }
  }, 4000);
  child.on("exit", (code) => {
    clearInterval(timer);
    // Beklenmedik çıkışı bildir (0 = normal çıkış)
    if (code !== 0 && code !== null && typeof _onCrash === "function") {
      try { _onCrash(code); } catch {}
    }
  });
  return status();
}

function redact(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-••••")
    .replace(/("api_key"\s*:\s*")[^"]+/g, "$1••••");
}

function exportDiagnostic() {
  const dir = engineDir();
  const bits = [];
  bits.push("Cortex tanı");
  bits.push("zaman: " + new Date().toISOString());
  const logFile = path.join(dir, "engine.log");
  try {
    const stat = fs.statSync(logFile);
    const start = Math.max(0, stat.size - 120000);
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    bits.push("");
    bits.push("--- engine.log (son) ---");
    bits.push(redact(buf.toString("utf8")));
  } catch (err) {
    bits.push("log okunamadı: " + err.message);
  }
  const cfgFile = path.join(dir, "config.json");
  try {
    bits.push("");
    bits.push("--- config.json ---");
    bits.push(redact(fs.readFileSync(cfgFile, "utf8")));
  } catch (err) {
    bits.push("config okunamadı: " + err.message);
  }
  for (const file of hostsTargets()) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const kept = raw.split(/\r?\n/).filter((line) => /cloudcode|antigravity-byok/i.test(line));
      bits.push("");
      bits.push("--- " + file + " ---");
      bits.push(kept.join("\n") || "(hijack satırı yok)");
    } catch (err) {
      bits.push(file + " okunamadı: " + err.message);
    }
  }
  const downloads = path.join(os.homedir(), "Downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const out = path.join(downloads, "cortex-tani-" + Date.now() + ".txt");
  fs.writeFileSync(out, bits.join("\n"), "utf8");
  try { spawn("explorer.exe", ["/select,", out], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); } catch {}
  return { path: out };
}

async function uninstallAll() {
  await stopEngine();
  removeMachine();
  const dir = engineDir();
  for (const name of ["config.json", "proxy.db", "engine.log", "engine.log.1"]) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
  const tls = path.join(dir, "tls");
  try {
    for (const name of fs.readdirSync(tls)) {
      try { fs.unlinkSync(path.join(tls, name)); } catch {}
    }
  } catch {}
  return status();
}

async function stopEngine() {
  if (child && child.exitCode === null) {
    try { child.kill(); } catch {}
  }
  child = null;
  try { killStaleEngine(); } catch {}
  return status();
}

async function waitListening(port, ms) {
  const net = require("net");
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => { s.end(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

module.exports = {
  status,
  activity,
  installMachine,
  removeMachine,
  startEngine,
  stopEngine,
  writeEngineConfig,
  waitListening,
  exportDiagnostic,
  uninstallAll,
  caPath,
  hostsFileOk,
  onCrash,
};
