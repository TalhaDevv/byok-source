"use strict";

const crypto = require("crypto");

const CONTEXTS = [
  ["200k", "200K"],
  ["356k", "356K"],
  ["500k", "500K"],
  ["800k", "800K"],
  ["1m", "1M"],
];
const EFFORTS = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
  ["max", "Max"],
];
const DEFAULT_CONTEXT = "200k";
const LOCAL_KEY = "cursor-byok-local";
const OPENAI_RESPONSES = "/v1/responses";
const OPENAI_CHAT = "/v1/chat/completions";

const CATALOG_PATHS = new Set([
  "/aiserver.v1.AiService/AvailableModels",
  "/agent.v1.AgentService/GetUsableModels",
  "/aiserver.v1.AiService/GetUsableModels",
  "/agent.v1.AgentService/GetDefaultModelForCli",
  "/aiserver.v1.AiService/GetDefaultModelForCli",
  "/aiserver.v1.AiService/GetDefaultModel",
  "/aiserver.v1.AiService/GetDefaultModelNudgeData",
]);

function openaiEndpoint(value) {
  const raw = String(value || "").trim();
  if (raw === "" || raw === OPENAI_RESPONSES) return OPENAI_RESPONSES;
  if (raw === OPENAI_CHAT) return OPENAI_CHAT;
  throw new Error("OpenAI uç noktası yalnızca /v1/responses veya /v1/chat/completions olabilir.");
}

function requestUrl(base, endpoint, useFullUrl) {
  const url = new URL(String(base || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model adresi http veya https olmalı.");
  }
  if (url.hash) throw new Error("Model adresinde parça olamaz.");
  if (useFullUrl) return url.href;
  const path = url.pathname.replace(/\/+$/, "");
  const last = path.split("/").pop() || "";
  const versioned = /^v\d+$/.test(last);
  const tail = versioned ? endpoint.replace(/^\/v1(?=\/|$)/, "") : endpoint;
  url.pathname = path + tail;
  url.hash = "";
  return url.href;
}

function modelHash(entry) {
  const endpoint = openaiEndpoint(entry.openaiEndpoint);
  const url = requestUrl(entry.baseUrl, endpoint, !!entry.useFullUrl);
  const parts = [url, entry.modelId, entry.apiKey, entry.displayName, endpoint];
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function normalize(raw, apiKey) {
  const displayName = String(raw.displayName || "").trim();
  const modelId = String(raw.modelId || "").trim();
  const baseUrl = String(raw.baseUrl || "").trim();
  if (!displayName) throw new Error("Görünecek ad boş olamaz.");
  if (!modelId) throw new Error("Gizli model adı boş olamaz.");
  if (!apiKey) throw new Error("API anahtarı yok.");
  const entry = {
    id: String(raw.id || crypto.randomUUID()),
    displayName,
    modelId,
    baseUrl,
    apiKey,
    openaiEndpoint: openaiEndpoint(raw.openaiEndpoint),
    useFullUrl: !!raw.useFullUrl,
    tooltip: String(raw.tooltip || displayName).trim() || displayName,
    group: String(raw.group || "").trim(),
  };
  entry.hash = modelHash(entry);
  return entry;
}

function publicEntry(entry) {
  return {
    id: entry.id,
    displayName: entry.displayName,
    modelId: entry.modelId,
    hash: entry.hash,
    baseUrl: entry.baseUrl,
    group: entry.group || hostOf(entry.baseUrl),
  };
}

function hostOf(base) {
  try { return new URL(base).host; } catch { return "Cursor"; }
}

function encodeVarint(value) {
  let n = value >>> 0;
  const out = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function key(field, wire) {
  return encodeVarint((field << 3) | wire);
}

function bytesField(field, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([key(field, 2), encodeVarint(body.length), body]);
}

function stringField(field, value) {
  if (value == null || value === "") return Buffer.alloc(0);
  return bytesField(field, value);
}

function boolField(field, value) {
  if (!value) return Buffer.alloc(0);
  return Buffer.concat([key(field, 0), encodeVarint(1)]);
}

function boolValue(field, value) {
  return Buffer.concat([key(field, 0), encodeVarint(value ? 1 : 0)]);
}

function optBool(field, value) {
  return boolValue(field, !!value);
}

function intField(field, value) {
  if (value == null) return Buffer.alloc(0);
  return Buffer.concat([key(field, 0), encodeVarint(value)]);
}

function messageField(field, body) {
  if (!body || !body.length) return Buffer.alloc(0);
  return bytesField(field, body);
}

function join(parts) {
  return Buffer.concat(parts.filter((part) => part && part.length));
}

function tooltip(text) {
  return stringField(7, text);
}

function enumParam(id, name, hint, values, cycleable) {
  const rows = values.map(([value, label]) => join([
    stringField(1, value),
    stringField(2, label),
  ]));
  return join([
    stringField(1, id),
    stringField(2, name),
    stringField(3, hint),
    messageField(4, messageField(2, join(rows.map((row) => messageField(1, row))))),
    boolValue(5, cycleable),
  ]);
}

function boolParam() {
  const off = stringField(1, "false");
  const on = join([
    stringField(1, "true"),
    stringField(2, "Fast"),
    boolField(3, true),
  ]);
  return join([
    stringField(1, "fast"),
    stringField(2, "Fast"),
    stringField(3, "Significantly faster but consumes more usage"),
    messageField(4, messageField(1, join([messageField(1, off), messageField(1, on)]))),
    boolValue(5, false),
  ]);
}

function parameters() {
  return [
    enumParam("context", "Context", "Context size used to trigger conversation compaction.", CONTEXTS, false),
    enumParam("reasoning", "Effort", "Effort the model uses to generate its response.", EFFORTS, true),
    boolParam(),
  ];
}

function variant(entry, context, contextName, effort, effortName, fast) {
  const suffix = [];
  if (context !== DEFAULT_CONTEXT) suffix.push(contextName);
  if (effort != null) suffix.push(effortName);
  if (fast) suffix.push("Fast");
  const label = suffix.length
    ? entry.displayName + ' <span style="color: var(--cursor-text-tertiary);">' + suffix.join(" ") + "</span>"
    : entry.displayName;
  const isDefault = context === DEFAULT_CONTEXT && !fast && (effort == null || effort === "high");

  const paramValues = [join([stringField(1, "context"), stringField(2, context)])];
  if (effort != null) paramValues.push(join([stringField(1, "reasoning"), stringField(2, effort)]));
  paramValues.push(join([stringField(1, "fast"), stringField(2, String(fast))]));

  const variantStr = effort != null
    ? entry.hash + "[context=" + context + ",reasoning=" + effort + ",fast=" + fast + "]"
    : entry.hash + "[context=" + context + ",fast=" + fast + "]";

  const legacySlug = effort != null
    ? entry.hash + "-" + context + "-" + effort + (fast ? "-fast" : "")
    : entry.hash + "-" + context + (fast ? "-fast" : "");

  return join([
    join(paramValues.map((v) => messageField(1, v))),
    stringField(2, label),
    Buffer.from([0x18, 0x00]),
    isDefault ? Buffer.from([0x20, 0x01]) : Buffer.alloc(0),
    isDefault ? Buffer.from([0x28, 0x01]) : Buffer.alloc(0),
    messageField(6, tooltip(entry.tooltip)),
    stringField(8, label),
    stringField(9, variantStr),
    stringField(11, legacySlug),
  ]);
}

// variants ve legacySlugs sonuçlarını model hash'ine göre önbellekle
const _variantsCache = new Map();
const _slugsCache = new Map();

function variants(entry) {
  if (_variantsCache.has(entry.hash)) return _variantsCache.get(entry.hash);
  const out = [];
  for (const [context, contextName] of CONTEXTS) {
    for (const [effort, effortName] of EFFORTS) {
      for (const fast of [false, true]) {
        out.push(variant(entry, context, contextName, effort, effortName, fast));
      }
    }
  }
  _variantsCache.set(entry.hash, out);
  return out;
}

function legacySlugs(entry) {
  if (_slugsCache.has(entry.hash)) return _slugsCache.get(entry.hash);
  const slugs = [];
  for (const [context] of CONTEXTS) {
    for (const [effort] of EFFORTS) {
      slugs.push(entry.hash + "-" + context + "-" + effort);
      slugs.push(entry.hash + "-" + context + "-" + effort + "-fast");
    }
  }
  _slugsCache.set(entry.hash, slugs);
  return slugs;
}

function availableModel(entry) {
  const rows = variants(entry);
  const slugs = legacySlugs(entry);
  return join([
    stringField(1, entry.hash),
    // field 2: default_on = true (bool, required)
    Buffer.from([0x10, 0x01]),
    // field 5: supports_agent = Some(true)
    Buffer.from([0x28, 0x01]),
    // field 6: degradation_status = Some(0) - must write 0 explicitly as optional i32
    Buffer.from([0x30, 0x00]),
    messageField(8, tooltip(entry.tooltip)),
    // field 9: supports_thinking = Some(true)
    Buffer.from([0x48, 0x01]),
    // field 10: supports_images = Some(true)
    Buffer.from([0x50, 0x01]),
    // field 14: supports_max_mode = Some(true)
    Buffer.from([0x70, 0x01]),
    stringField(17, entry.displayName),
    stringField(18, entry.hash),
    // field 19: supports_non_max_mode = Some(true)
    Buffer.from([0x98, 0x01, 0x01]),
    messageField(20, tooltip(entry.tooltip)),
    // field 21: is_recommended_for_background_composer = Some(false)
    // tag = (21 << 3) | 0 = 168 = varint [0xa8, 0x01], value = 0
    Buffer.from([0xa8, 0x01, 0x00]),
    // field 22: supports_plan_mode = Some(true)
    Buffer.from([0xb0, 0x01, 0x01]),
    stringField(24, entry.displayName),
    // field 23: is_user_added = Some(true) — Cursor model picker'da "User Added" bölümünde göster
    Buffer.from([0xb8, 0x01, 0x01]),
    // field 25: supports_sandboxing = Some(true)
    Buffer.from([0xc8, 0x01, 0x01]),
    // field 26: supports_cmd_k = Some(false)
    Buffer.from([0xd0, 0x01, 0x00]),
    join(parameters().map((row) => messageField(29, row))),
    join(rows.map((row) => messageField(30, row))),
    join(slugs.map((slug) => stringField(36, slug))),
    // field 38: named_model_section_index = Some(1)
    // tag = (38 << 3) | 0 = 304 = varint [0xB0, 0x02], value = 1 = [0x01]
    Buffer.from([0xb0, 0x02, 0x01]),
    stringField(41, "cursor"),
    messageField(42, join([intField(1, 6), stringField(2, "Cursor")])),
    messageField(48, join([
      stringField(1, entry.group || hostOf(entry.baseUrl)),
      intField(2, 1),
    ])),
  ]);
}

function availableAddition(entries) {
  return join([
    join(entries.map((entry) => stringField(1, entry.hash))),
    join(entries.map((entry) => messageField(2, availableModel(entry)))),
  ]);
}

function usableModel(entry) {
  return join([
    stringField(1, entry.hash),
    key(2, 2),
    encodeVarint(0),
    stringField(3, entry.hash),
    stringField(4, entry.displayName),
    stringField(5, entry.displayName),
    messageField(8, stringField(1, LOCAL_KEY)),
  ]);
}

function usableAddition(entries) {
  return join(entries.map((entry) => messageField(1, usableModel(entry))));
}

function defaultModel(entries) {
  const hash = entries[0] ? entries[0].hash : "";
  return join([
    stringField(1, hash),
    stringField(2, hash),
  ]);
}

function defaultCli(entries) {
  return entries[0] ? messageField(1, usableModel(entries[0])) : Buffer.alloc(0);
}

function defaultNudge(entries) {
  return join([
    stringField(1, "0"),
    optBool(2, false),
    join(entries.map((entry) => stringField(3, entry.hash))),
  ]);
}

function catalogBody(pathname, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const path = rpcPath(pathname);
  if (path.endsWith("/AvailableModels")) return availableModels(list);
  if (path.endsWith("/GetUsableModels")) return usableAddition(list);
  if (path.endsWith("/GetDefaultModelForCli")) return defaultCli(list);
  if (path.endsWith("/GetDefaultModelNudgeData")) return defaultNudge(list);
  if (path.endsWith("/GetDefaultModel")) return defaultModel(list);
  return null;
}

function rpcPath(target) {
  const raw = String(target || "/").trim() || "/";
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname || "/";
  } catch {}
  const cut = raw.split("?")[0];
  const i = cut.indexOf("/aiserver.");
  const j = cut.indexOf("/agent.");
  if (i >= 0) return cut.slice(i);
  if (j >= 0) return cut.slice(j);
  return cut.startsWith("/") ? cut : "/" + cut;
}

function isCatalogPath(pathname) {
  const path = rpcPath(pathname);
  if (CATALOG_PATHS.has(path)) return true;
  return /\/(AvailableModels|GetUsableModels|GetDefaultModelForCli|GetDefaultModelNudgeData|GetDefaultModel)$/.test(path);
}

function connectFrame(payload) {
  const body = payload || Buffer.alloc(0);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// ModelPickerDisplayConfiguration (field 15) — upstream 401 döndürdüğünde bunu biz ekleriz
// field 15 tag: (15 << 3) | 2 = 122 = 0x7A
// NamedModelsViewConfig (field 2 içinde):
//   named_view_to_routed_model_view_toggle (field 2): markdown text
// RoutedModelViewConfig (field 1 içinde):
//   routed_model_view_to_named_view_toggle (field 2): title_markdown
function displayConfiguration() {
  // RoutedModelViewConfig.RoutedModelViewToNamedViewToggle: field 1 = title_markdown
  const routedToNamedToggle = messageField(2, join([
    stringField(1, "Select model"),
    optBool(3, true), // set_to_last_named_model
  ]));
  const routedConfig = messageField(1, routedToNamedToggle);

  // NamedModelsViewConfig.NamedViewToRoutedModelViewToggle: field 1 = markdown
  const namedToRoutedToggle = messageField(2, stringField(1, "Auto"));
  const namedConfig = messageField(2, namedToRoutedToggle);

  return messageField(15, join([routedConfig, namedConfig]));
}

function availableModels(entries) {
  return join([
    join(entries.map((entry) => stringField(1, entry.hash))),
    join(entries.map((entry) => messageField(2, availableModel(entry)))),
    displayConfiguration(),
  ]);
}

function unaryPayload(body) {
  const zlib = require("zlib");
  let raw = body || Buffer.alloc(0);
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try { raw = zlib.gunzipSync(raw); } catch { /* keep */ }
  }
  if (raw.length < 5) return { framed: false, payload: raw };
  const flags = raw[0];
  const length = raw.readUInt32BE(1);
  if (length !== raw.length - 5) return { framed: false, payload: raw };
  let inner = raw.subarray(5);
  if (flags === 1) {
    try { inner = zlib.gunzipSync(inner); } catch {
      const err = new Error("cannot merge compressed model catalog frame");
      err.code = "CATALOG_FRAME";
      throw err;
    }
    return { framed: true, payload: inner };
  }
  if (flags !== 0) {
    const err = new Error("cannot merge compressed or terminal model catalog frame: flags=" + flags);
    err.code = "CATALOG_FRAME";
    throw err;
  }
  return { framed: true, payload: inner };
}

function mergeCatalog(upstream, extra, status) {
  const addition = extra || Buffer.alloc(0);
  if (!status || status < 200 || status >= 300) {
    // Upstream hata döndürdü — local_response gibi ham proto, frame YOK
    return { body: addition, contentType: "application/proto" };
  }
  const parsed = unaryPayload(upstream);
  const payload = parsed.payload || Buffer.alloc(0);
  let body;
  if (parsed.framed) {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length + addition.length, 1);
    body = Buffer.concat([head, payload, addition]);
  } else {
    body = Buffer.concat([payload, addition]);
  }
  return { body, contentType: null }; // upstream content-type'ı koru
}

module.exports = {
  CATALOG_PATHS,
  modelHash,
  normalize,
  publicEntry,
  isCatalogPath,
  catalogBody,
  mergeCatalog,
  connectFrame,
  requestUrl,
  openaiEndpoint,
  rpcPath,
};
