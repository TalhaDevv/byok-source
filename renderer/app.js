const titles = { home: "Özet", ag: "AntiGravity", cursor: "Cursor", models: "Modeller", settings: "Ayarlar", traffic: "İstekler" };
const state = {
  setupDone: false,
  enabledModels: [],
  activeModel: "",
  activeSource: "",
  grokBase: "https://grok.claude.gg",
  claudeBase: "https://claude.gg",
  openAtLogin: false,
  hasKey: false,
  models: [],
};
let trafficTimer = null;
let familyFilter = "Tümü";
let tierFilter = "Tümü";

const $ = (id) => document.getElementById(id);

const PREVIEW = [
  { id: "önizleme-grok", name: "Önizleme kaydı", source: "örnek · gerçek değil" },
  { id: "önizleme-claude", name: "Önizleme kaydı", source: "örnek · gerçek değil" },
  { id: "önizleme-fast", name: "Önizleme kaydı", source: "örnek · gerçek değil" },
  { id: "önizleme-sonnet", name: "Önizleme kaydı", source: "örnek · gerçek değil" },
];

function show(tab) {
  if (trafficTimer) {
    clearInterval(trafficTimer);
    trafficTimer = null;
  }
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".page").forEach((v) => v.classList.remove("on"));
  $("view-" + tab).classList.add("on");
  $("title").textContent = titles[tab];
  $("view").scrollTop = 0;
  if (tab === "ag") { renderAg(); refreshPower(); }
  if (tab === "cursor") refreshCursor();
  if (tab === "models") renderModels();
  if (tab === "settings") renderSettings();
  if (tab === "traffic") {
    renderTraffic();
    trafficTimer = setInterval(renderTraffic, 5000);
  }
}

document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go)));
$("goAg").addEventListener("click", () => show("ag"));
$("goSettings").addEventListener("click", () => show("settings"));

function stepItem(done, title, detail, go) {
  const tag = go ? "button" : "div";
  const goAttr = go ? ` data-go="${go}" type="button"` : "";
  return `<li><${tag} class="step${done ? " done" : ""}"${goAttr}><span class="dot${done ? " ok" : ""}"></span><span class="grow"><strong>${title}</strong><span class="hint">${detail}</span></span><span class="state">${done ? "Hazır" : "Bekliyor"}</span></${tag}></li>`;
}

function paintPower(rt) {
  const on = !!(rt && rt.running && rt.hosts && rt.binary);
  const btn = $("power");
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-checked", on ? "true" : "false");
  $("powerLabel").textContent = on ? "Bağlı" : "Kapalı";
  $("ag-pill-dot").className = "dot" + (on ? " ok" : "");
  $("ag-orb").classList.toggle("live", on);
  $("ag-title").textContent = on ? "Köprü açık" : "Köprü kapalı";
  $("offWarn").hidden = on || !!(rt && rt.error);
  const errBox = $("errWarn");
  const drift = $("driftWarn");
  drift.hidden = !(rt && rt.patchDrift && !on);
  const streamError = rt && rt.lastError;
  const steps = (rt && rt.steps) || [];
  const done = steps.filter((step) => step.ok).length;
  $("ag-bar").style.width = steps.length ? (done / steps.length * 100) + "%" : "0%";
  if (rt && rt.error) {
    $("liveLine").textContent = rt.error;
    errBox.hidden = false;
    errBox.textContent = rt.error;
    return;
  }
  errBox.hidden = !streamError;
  errBox.textContent = streamError ? "Son istek tamamlanmadı: " + streamError : "";
  const cert = $("certLine");
  if (rt && rt.cert && typeof rt.certDays === "number") {
    cert.hidden = false;
    cert.textContent = rt.certDays < 0
      ? "Sertifikanın süresi dolmuş. Açık konumu yenisini yazar."
      : "Sertifika " + rt.certDays + " gün sonra bitiyor" + (rt.certUntil ? " (" + rt.certUntil + ")." : ".");
  } else if (rt && rt.certUntil) {
    cert.hidden = false;
    cert.textContent = "Sertifika bitiş: " + rt.certUntil;
  } else {
    cert.hidden = true;
    cert.textContent = "";
  }
  $("liveSteps").innerHTML = steps.map((step) =>
    `<li><div class="step${step.ok ? " done" : ""}"><span class="dot${step.ok ? " ok" : ""}"></span><span class="grow"><strong>${esc(step.title)}</strong><span class="hint">${esc(step.detail)}</span></span><span class="state">${step.ok ? "Hazır" : "Bekliyor"}</span></div></li>`
  ).join("");
  if (!rt) {
    $("liveLine").textContent = "Durum okunamadı.";
    return;
  }
  $("liveLine").textContent = on
    ? "AntiGravity istekleri Cortex üzerinden " + (state.activeModel || "seçili modele") + " gidiyor."
    : "AntiGravity şu an Google adreslerini normal şekilde kullanıyor.";
}

async function refreshPower() {
  try {
    const rt = await window.cortex.runtimeStatus();
    try {
      const act = await window.cortex.runtimeActivity();
      if (rt) rt.lastError = (act && act.lastError) || "";
    } catch {}
    paintPower(rt);
  }
  catch (err) { paintPower({ error: String(err.message || err) }); }
}

function pinText() {
  if (!state.activeModel) return "Sabit model yok. AntiGravity sekmesinden bir tane seç.";
  const source = state.activeSource ? " · " + state.activeSource : "";
  return "Sabit model: " + state.activeModel + source + ". Bütün Gemini adları bu modele gider.";
}

function kbText(size) {
  if (!size) return "0 KB";
  return Math.max(1, Math.round(size / 1024)) + " KB";
}

function clock(at) {
  const text = String(at || "");
  const hit = text.match(/(\d{2}:\d{2}:\d{2})/);
  return hit ? hit[1] : text.slice(11, 19);
}

function renderTraffic() {
  const list = $("trafficList");
  $("pinLine").textContent = pinText();
  window.cortex.runtimeActivity().then((act) => {
    const items = (act && act.items) || [];
    const streams = items.filter((it) => it.stream).length;
    const fails = items.filter((it) => it.error).length;
    const bytes = items.reduce((sum, it) => sum + (Number(it.size) || 0), 0);
    $("trafficError").hidden = !(act && act.lastError);
    $("trafficError").textContent = act && act.lastError ? "Son hata: " + act.lastError : "";
    $("trafficCount").textContent = String(items.length);
    $("statStream").textContent = String(streams);
    $("statSize").textContent = kbText(bytes);
    $("statFail").textContent = String(fails);
    if (!items.length) {
      list.innerHTML = `<tr><td colspan="6" class="empty">Henüz üretim isteği yok. AntiGravity bir yanıt istediğinde burada görünür.</td></tr>`;
      return;
    }
    list.innerHTML = items.map((it) => {
      const type = it.error ? "hata" : (it.stream ? "akış" : "tek yanıt");
      const path = it.error ? it.error : (it.path || "");
      return `<tr>
        <td class="dimc mono">${esc(it.id)}</td>
        <td class="muted mono">${esc(clock(it.at))}</td>
        <td><span class="mono muted">${esc(it.from || "model yok")}</span><span class="arrow">→</span><span class="mono">${esc(it.to || "yön yok")}</span></td>
        <td class="hide-sm"><span class="tag">${esc(type)}</span></td>
        <td class="hide-sm mono dimc">${esc(path)}</td>
        <td class="num mono">${esc(kbText(it.size))}</td>
      </tr>`;
    }).join("");
  }).catch((err) => {
    $("trafficCount").textContent = "—";
    list.innerHTML = `<tr><td colspan="6" class="empty">${esc(err.message || err)}</td></tr>`;
  });
}

$("reloadTraffic").addEventListener("click", renderTraffic);

function paintCursorModels(list) {
  const box = $("cursorModelList");
  const rows = Array.isArray(list) ? list : [];
  $("cursorModelCount").textContent = rows.length + " model";
  if (!rows.length) {
    box.innerHTML = `<div class="empty">Henüz Cursor modeli yok. Aşağıdan ekle veya toplu yapıştır.</div>`;
    return;
  }
  box.innerHTML = rows.map((m) => `
    <div class="row model">
      <div class="grow">
        <div class="name">${esc(m.displayName)}</div>
        <div class="meta"><span class="mono">${esc(m.modelId)}</span> · ${esc(m.baseUrl)}</div>
      </div>
      <button class="btn" type="button" data-del="${esc(m.id)}">Sil</button>
    </div>`).join("");
  box.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        paintCursorModels(await window.cortex.cursorRemove(btn.dataset.del));
      } catch (err) {
        $("cursorLine").textContent = String(err.message || err);
      }
    });
  });
}

function parseBulkModels(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/[\t,;|]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) throw new Error("Satır en az ad, model id, URL ister: " + line);
    return {
      displayName: parts[0],
      modelId: parts[1],
      baseUrl: parts[2],
      apiKey: parts[3] || "",
      openaiEndpoint: parts[4] || "/v1/chat/completions",
      group: "Cortex",
    };
  });
}

function paintCursor(rt) {
  const on = !!(rt && rt.enabled);
  const btn = $("cursorPower");
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-checked", on ? "true" : "false");
  $("cursorPowerLabel").textContent = on ? "Bağlı" : "Kapalı";
  $("cursor-pill-dot").className = "dot" + (on ? " ok" : "");
  $("cursor-orb").classList.toggle("live", on);
  $("cursor-title").textContent = on ? "Köprü açık" : "Köprü kapalı";
  $("cursorOff").hidden = on || !!(rt && rt.error);
  const errBox = $("cursorErr");
  if (rt && rt.error) {
    errBox.hidden = false;
    errBox.textContent = rt.error;
    $("cursorLine").textContent = rt.error;
  } else {
    errBox.hidden = true;
    errBox.textContent = "";
    $("cursorLine").textContent = on
      ? "Cursor istekleri " + (rt.proxyUrl || "yerel vekilden") + " geçiyor."
      : "Cursor ayarları normal. Vekil dinlemiyor.";
  }
  const caName = { ready: "güvenilir", untrusted: "yazıldı, güvenilmedi", missing: "yok" };
  $("cursorProxy").textContent = (rt && rt.proxyUrl) || "—";
  $("cursorCa").textContent = caName[(rt && rt.ca) || ""] || "—";
  $("cursorApp").textContent = rt && rt.cursorOpen ? "açık" : "kapalı";
  if (rt && rt.models) paintCursorModels(rt.models);
  else if (typeof rt.modelCount === "number") $("cursorModelCount").textContent = rt.modelCount + " model";
  const meta = $("cursorMeta");
  if (rt && rt.running && !rt.settingsApplied) {
    meta.hidden = false;
    meta.textContent = "Vekil ayakta ama Cursor ayarları yazılamadı. Anahtarı kapatıp yeniden aç.";
  } else {
    meta.hidden = true;
    meta.textContent = "";
  }
}

async function refreshCursor() {
  try {
    paintCursor(await window.cortex.cursorStatus());
  } catch (err) {
    paintCursor({ error: String(err.message || err) });
  }
}

$("cmAdd").addEventListener("click", async () => {
  try {
    paintCursorModels(await window.cortex.cursorAdd({
      displayName: $("cmName").value,
      modelId: $("cmId").value,
      baseUrl: $("cmBase").value,
      apiKey: $("cmKey").value,
      openaiEndpoint: $("cmEp").value,
    }));
    $("cmName").value = "";
    $("cmId").value = "";
    $("cmKey").value = "";
  } catch (err) {
    $("cursorLine").textContent = String(err.message || err);
  }
});

$("cmBulkAdd").addEventListener("click", async () => {
  try {
    const rows = parseBulkModels($("cmBulk").value);
    paintCursorModels(await window.cortex.cursorAddMany(rows));
    $("cmBulk").value = "";
  } catch (err) {
    $("cursorLine").textContent = String(err.message || err);
  }
});

$("cmImportEnabled").addEventListener("click", async () => {
  const ids = state.enabledModels && state.enabledModels.length
    ? state.enabledModels
    : (state.activeModel ? [state.activeModel] : []);
  if (!ids.length) {
    $("cursorLine").textContent = "Önce Modeller sekmesinde en az bir modeli aç.";
    return;
  }
  const grok = (state.grokBase || "https://grok.claude.gg").replace(/\/$/, "");
  const claude = (state.claudeBase || "https://claude.gg").replace(/\/$/, "");
  const rows = ids.map((id) => ({
    displayName: "Cortex " + id,
    modelId: id,
    baseUrl: /claude/i.test(id) ? claude : grok,
    openaiEndpoint: "/v1/chat/completions",
    group: "Cortex",
  }));
  try {
    paintCursorModels(await window.cortex.cursorAddMany(rows));
  } catch (err) {
    $("cursorLine").textContent = String(err.message || err);
  }
});

$("cursorPower").addEventListener("click", async () => {
  const btn = $("cursorPower");
  const turningOn = btn.getAttribute("aria-checked") !== "true";
  btn.disabled = true;
  $("cursorLine").textContent = turningOn
    ? "Cursor vekili açılıyor. Gerekirse sertifika için yönetici onayı istenir…"
    : "Cursor ayarları temizleniyor…";
  try {
    paintCursor(await window.cortex.cursorToggle(turningOn));
  } catch (err) {
    $("cursorLine").textContent = String(err.message || err);
  } finally {
    btn.disabled = false;
  }
});

$("power").addEventListener("click", async () => {
  const btn = $("power");
  const turningOn = btn.getAttribute("aria-checked") !== "true";
  btn.disabled = true;
  $("liveLine").textContent = turningOn ? "Kurulum açılıyor, yönetici onayı istenecek…" : "Kapatılıyor, yönetici onayı istenecek…";
  try {
    paintPower(await window.cortex.runtimeToggle(turningOn));
  } catch (err) {
    $("liveLine").textContent = String(err.message || err);
  } finally {
    btn.disabled = false;
  }
});

function splitEnabled(item) {
  const cut = String(item).lastIndexOf("|");
  if (cut < 0) return { id: item, source: "" };
  return { source: item.slice(0, cut), id: item.slice(cut + 1) };
}

function modelSource(id) {
  if (state.activeSource && id === state.activeModel) return state.activeSource;
  const hit = (state.models || []).find((m) => m.id === id);
  return hit ? hit.source : "";
}

function renderAg() {
  const ready = state.setupDone;
  $("agSetup").hidden = ready;
  $("agDone").hidden = !ready;
  if (!ready) {
    const keyOk = state.hasKey;
    const modelsOk = (state.enabledModels || []).length > 0;
    $("steps").innerHTML = [
      stepItem(keyOk, "API anahtarı", keyOk ? "Ayarlar’da kayıtlı." : "Ayarlar sekmesinden anahtarı kaydet.", "settings"),
      stepItem(modelsOk, "En az bir model açık", modelsOk ? state.enabledModels.length + " model açık." : "Modeller sekmesinde kullanacaklarını aç.", "models"),
      stepItem(false, "Kurulumu tamamla", "AntiGravity yalnızca açık modellerden birini kullanır."),
    ].join("");
    $("steps").querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go)));
    $("finishSetup").disabled = !(keyOk && modelsOk);
    $("setupHint").textContent = keyOk && modelsOk ? "" : "İki adım da yeşil olmadan kurulum kapanmaz.";
    return;
  }
  const source = state.activeSource || modelSource(state.activeModel);
  $("sumModel").textContent = state.activeModel
    ? state.activeModel + (source ? " · " + source : "")
    : "seçilmedi";
  $("sumGrok").textContent = state.grokBase;
  $("sumClaude").textContent = state.claudeBase;
  const sel = $("activePick");
  const enabled = (state.enabledModels || []).map(splitEnabled);
  sel.innerHTML = enabled.length
    ? enabled.map((item) => {
        const label = item.source ? item.id + " · " + item.source : item.id;
        const selected = item.id === state.activeModel && (!state.activeSource || !item.source || item.source === state.activeSource);
        return `<option value="${encodeURIComponent(item.id)}" data-source="${item.source}" ${selected ? "selected" : ""}>${label}</option>`;
      }).join("")
    : `<option value="">Açık model yok</option>`;
}

$("finishSetup").addEventListener("click", async () => {
  if (!state.hasKey || !(state.enabledModels || []).length) return;
  state.setupDone = true;
  if (!state.activeModel) {
    const first = splitEnabled(state.enabledModels[0] || "");
    state.activeModel = first.id;
    state.activeSource = first.source;
  }
  await window.cortex.setState({ setupDone: true, activeModel: state.activeModel, activeSource: state.activeSource });
  renderAg();
});

$("activePick").addEventListener("change", async (e) => {
  const opt = e.target.selectedOptions[0];
  const id = decodeURIComponent(e.target.value || "");
  if (!id) return;
  state.activeModel = id;
  state.activeSource = (opt && opt.dataset.source) || modelSource(id);
  await window.cortex.setState({ activeModel: state.activeModel, activeSource: state.activeSource });
  $("sumModel").textContent = state.activeModel + (state.activeSource ? " · " + state.activeSource : "");
  $("liveLine").textContent = "Model motora yazılıyor…";
  try {
    const out = await window.cortex.runtimeApplyModel();
    if (out && out.reason) $("liveLine").textContent = out.reason;
    else if (out && out.applied) $("liveLine").textContent = "Motor yeni modelle açıldı.";
    await refreshPower();
  } catch (err) {
    $("liveLine").textContent = String(err.message || err);
  }
});

function modelKey(m) {
  return m.source ? m.source + "|" + m.id : m.id;
}

const FAMILIES = ["Grok", "Claude", "Sonnet", "GPT", "Gemini", "Llama", "Mistral", "DeepSeek", "Qwen"];
const TIERS = ["Cyber", "Fast", "Low", "Medium", "High", "Max", "Mini", "Opus", "Haiku"];

function haystack(m) {
  return ((m.id || "") + " " + (m.name || "")).toLowerCase();
}

function familyOf(m) {
  const text = haystack(m);
  if (/\bsonnet\b/.test(text)) return "Sonnet";
  if (/\bgrok\b/.test(text)) return "Grok";
  if (/\bclaude\b/.test(text)) return "Claude";
  if (/\bgpt\b|\bo[134](?:-|\b)/.test(text)) return "GPT";
  if (/\bgemini\b/.test(text)) return "Gemini";
  if (/\bllama\b/.test(text)) return "Llama";
  if (/\bmistral\b|\bmixtral\b/.test(text)) return "Mistral";
  if (/\bdeepseek\b/.test(text)) return "DeepSeek";
  if (/\bqwen\b/.test(text)) return "Qwen";
  return "Diğer";
}

function tiersOf(m) {
  const text = haystack(m);
  const found = [];
  if (/\bcyber\b/.test(text)) found.push("Cyber");
  if (/\bfast\b|\bflash\b/.test(text)) found.push("Fast");
  if (/\blow\b/.test(text)) found.push("Low");
  if (/\bmedium\b|\bmed\b/.test(text)) found.push("Medium");
  if (/\bhigh\b/.test(text)) found.push("High");
  if (/\bmax\b/.test(text)) found.push("Max");
  if (/\bmini\b/.test(text)) found.push("Mini");
  if (/\bopus\b/.test(text)) found.push("Opus");
  if (/\bhaiku\b/.test(text)) found.push("Haiku");
  return found;
}

function blurbFor(m) {
  const family = familyOf(m);
  const tier = tiersOf(m)[0] || "";
  if (family === "Grok" && tier === "Cyber") return "Hızlı Grok, siber işler için.";
  if (family === "Grok" && tier === "Fast") return "Düşük gecikmeli Grok.";
  if (family === "Sonnet") return "Claude Sonnet, dengeli günlük model.";
  if (family === "Claude" && tier === "Opus") return "Claude Opus, uzun ve zor işler.";
  if (family === "Claude" && tier === "Haiku") return "Claude Haiku, kısa ve hızlı yanıt.";
  if (tier === "Low") return "Düşük maliyet, kısa işler.";
  if (tier === "Medium") return "Orta seviye, günlük kullanım.";
  if (tier === "High") return "Yüksek kalite, daha yavaş.";
  if (tier === "Max") return "En yüksek kalite katmanı.";
  if (tier === "Fast") return "Hız öncelikli varyant.";
  if (tier === "Mini") return "Küçük ve ucuz varyant.";
  if (family === "Diğer") return "Kaynak kataloğundan gelen model.";
  return family + " ailesinden bir model.";
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function row(m, preview) {
  const key = modelKey(m);
  const on = !preview && (state.enabledModels || []).includes(key);
  const family = familyOf(m);
  const tiers = tiersOf(m);
  const el = document.createElement("div");
  el.className = "row model";
  el.innerHTML = `
    <div class="av" aria-hidden="true">${esc(family.slice(0, 1))}</div>
    <div class="grow">
      <div class="name">${esc(m.name)}</div>
      <div class="meta"><span class="mono">${esc(m.id)}</span><span>·</span><span>${esc(m.source || blurbFor(m))}</span></div>
    </div>
    <div class="tags hide-sm">${tiers.map((tier) => `<span class="tag">${esc(tier)}</span>`).join("")}</div>
    <input type="checkbox" class="switch" role="switch" ${on ? "checked" : ""} ${preview ? "disabled" : ""} aria-label="${esc(m.name)} etkin" />`;
  if (!preview) {
    el.querySelector("input").addEventListener("change", async (ev) => {
      const set = new Set(state.enabledModels || []);
      if (ev.target.checked) set.add(key); else set.delete(key);
      state.enabledModels = [...set];
      const still = state.enabledModels.some((item) => item === state.activeModel || item.endsWith("|" + state.activeModel));
      if (!still) {
        const next = state.enabledModels[0] || "";
        const cut = next.lastIndexOf("|");
        state.activeModel = cut >= 0 ? next.slice(cut + 1) : next;
        state.activeSource = cut >= 0 ? next.slice(0, cut) : "";
      }
      await window.cortex.setState({
        enabledModels: state.enabledModels,
        activeModel: state.activeModel,
        activeSource: state.activeSource,
      });
      renderModels();
    });
  }
  el.dataset.q = (m.name + " " + m.id + " " + m.source + " " + family + " " + tiers.join(" ")).toLowerCase();
  el.dataset.family = family;
  el.dataset.tiers = tiers.join("|");
  return el;
}

function chips(box, labels, current, kind) {
  box.innerHTML = "";
  labels.forEach((label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.className = label === current ? "on" : "";
    btn.textContent = label;
    btn.setAttribute("aria-selected", label === current ? "true" : "false");
    btn.addEventListener("click", () => {
      if (kind === "family") familyFilter = label;
      else tierFilter = label;
      chips(box, labels, label, kind);
      applyFilter();
    });
    box.appendChild(btn);
  });
}

function paintChips(items) {
  const families = ["Tümü"];
  const tiers = ["Tümü"];
  items.forEach((m) => {
    const family = familyOf(m);
    tiersOf(m).forEach((tier) => {
      if (!tiers.includes(tier)) tiers.push(tier);
    });
    if (!families.includes(family)) families.push(family);
  });
  const familyOrder = ["Tümü", ...FAMILIES, "Diğer"];
  const tierOrder = ["Tümü", ...TIERS];
  families.sort((a, b) => familyOrder.indexOf(a) - familyOrder.indexOf(b));
  tiers.sort((a, b) => tierOrder.indexOf(a) - tierOrder.indexOf(b));
  if (!families.includes(familyFilter)) familyFilter = "Tümü";
  if (!tiers.includes(tierFilter)) tierFilter = "Tümü";
  chips($("familyChips"), families, familyFilter, "family");
  chips($("tierChips"), tiers, tierFilter, "tier");
}

function applyFilter() {
  const q = $("search").value.trim().toLowerCase();
  let n = 0;
  const list = $("modelList");
  const empty = list.querySelector(".empty");
  if (empty) empty.remove();
  document.querySelectorAll("#modelList .row.model").forEach((el) => {
    const familyOk = familyFilter === "Tümü" || el.dataset.family === familyFilter;
    const tierOk = tierFilter === "Tümü" || (el.dataset.tiers || "").split("|").includes(tierFilter);
    const show = familyOk && tierOk && (!q || el.dataset.q.includes(q));
    el.hidden = !show;
    if (show) n += 1;
  });
  if (!n) {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = "Eşleşen model yok.";
    list.appendChild(note);
  }
  const total = state.hasKey ? state.models.length : PREVIEW.length;
  const active = state.hasKey ? (state.enabledModels || []).length : 0;
  $("count").innerHTML = state.hasKey
    ? `<b>${active}</b> aktif · ${n} / ${total} model`
    : "önizleme";
}

async function renderModels() {
  const stage = $("modelStage");
  const list = $("modelList");
  list.innerHTML = "";
  if (!state.hasKey) {
    lockModels("Modelleri görüntülemek için Ayarlar’dan API anahtarı girin");
    return;
  }
  if (!state.models.length) {
    stage.classList.remove("locked");
    $("lock").hidden = true;
    $("count").textContent = "Modeller yükleniyor…";
    try {
      const r = await window.cortex.listModels();
      if (r && r.reason === "no-key") {
        state.hasKey = false;
        lockModels("Modelleri görüntülemek için Ayarlar’dan API anahtarı girin");
        return;
      }
      if (r && r.reason === "bad-key") {
        lockModels("API anahtarı kabul edilmedi. Ayarlar’dan doğru anahtarı kaydet.");
        return;
      }
      state.models = r.models || [];
      if (!state.models.length) $("count").textContent = (r.errors && r.errors[0]) || "Liste boş.";
    } catch (err) {
      $("count").textContent = String(err.message || err);
      return;
    }
  }
  stage.classList.remove("locked");
  $("lock").hidden = true;
  state.models.forEach((m) => list.appendChild(row(m, false)));
  paintChips(state.models);
  applyFilter();
}

$("search").addEventListener("input", applyFilter);
$("reload").addEventListener("click", async () => {
  if (!state.hasKey) return;
  state.models = [];
  await renderModels();
});

function renderSettings() {
  $("grokBase").value = state.grokBase;
  $("claudeBase").value = state.claudeBase;
  $("openAtLogin").checked = !!state.openAtLogin;
  $("keyStatus").textContent = state.hasKey ? "Kayıtlı anahtar var. Yeni değer yazarsan üzerine yazılır." : "Henüz anahtar yok.";
}

function lockModels(message) {
  const stage = $("modelStage");
  const list = $("modelList");
  stage.classList.add("locked");
  $("lock").hidden = false;
  $("lock").querySelector("p").textContent = message;
  list.innerHTML = "";
  PREVIEW.forEach((m) => list.appendChild(row(m, true)));
  paintChips(PREVIEW);
  $("count").textContent = "önizleme";
}

$("toggleKey").addEventListener("click", () => {
  const input = $("apiKey");
  const open = input.type === "password";
  input.type = open ? "text" : "password";
  $("toggleKey").textContent = open ? "Gizle" : "Göster";
  $("toggleKey").setAttribute("aria-pressed", open ? "true" : "false");
});

$("openAtLogin").addEventListener("change", async (e) => {
  state.openAtLogin = e.target.checked;
  await window.cortex.setState({ openAtLogin: state.openAtLogin });
  $("saveMsg").textContent = state.openAtLogin
    ? "Windows açılışında Cortex başlayacak."
    : "Windows açılışında Cortex başlamayacak.";
});

$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("apiKey").value.trim();
  state.grokBase = $("grokBase").value.trim() || state.grokBase;
  state.claudeBase = $("claudeBase").value.trim() || state.claudeBase;
  await window.cortex.setState({ grokBase: state.grokBase, claudeBase: state.claudeBase });
  if (key) {
    const st = await window.cortex.setKey(key);
    if (st.error) {
      $("saveMsg").textContent = st.error;
      renderSettings();
      return;
    }
    state.hasKey = st.hasKey;
    $("apiKey").value = "";
    state.models = [];
  }
  $("saveMsg").textContent = "Kaydedildi.";
  renderSettings();
});

$("exportDiag").addEventListener("click", async () => {
  $("saveMsg").textContent = "Tanı yazılıyor…";
  try {
    const out = await window.cortex.runtimeExport();
    $("saveMsg").textContent = "İndirilenler klasörüne yazıldı: " + (out.path || "");
  } catch (err) {
    $("saveMsg").textContent = String(err.message || err);
  }
});

$("uninstallAll").addEventListener("click", async () => {
  const first = window.confirm("Yönlendirme, sertifika ve yama silinecek. AntiGravity kapanır. Devam edilsin mi?");
  if (!first) return;
  const second = window.confirm("Bu geri alınmaz. Tamamen kaldırmayı onaylıyor musun?");
  if (!second) return;
  const btn = $("uninstallAll");
  btn.disabled = true;
  $("saveMsg").textContent = "Kaldırılıyor, yönetici onayı istenecek…";
  try {
    const rt = await window.cortex.runtimeUninstall();
    $("saveMsg").textContent = rt && rt.error ? rt.error : "Köprü kaldırıldı. AntiGravity kendi adreslerine döndü.";
    paintPower(rt);
  } catch (err) {
    $("saveMsg").textContent = String(err.message || err);
  } finally {
    btn.disabled = false;
  }
});

$("clearKey").addEventListener("click", async () => {
  await window.cortex.setKey("");
  state.hasKey = false;
  state.models = [];
  $("saveMsg").textContent = "Anahtar silindi.";
  renderSettings();
});

(async function init() {
  const s = await window.cortex.getState();
  Object.assign(state, s);
  const ks = await window.cortex.keyStatus();
  state.hasKey = ks.hasKey;
  show("home");
  $("discordLink").addEventListener("click", () => {
    window.cortex.openExternal("https://discord.gg/cortexai");
  });
  $("winMin").addEventListener("click", () => window.cortex.win.min());
  $("winMax").addEventListener("click", () => window.cortex.win.max());
  $("winClose").addEventListener("click", () => window.cortex.win.close());
})();
