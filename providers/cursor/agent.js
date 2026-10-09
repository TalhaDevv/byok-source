"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");
const catalog = require("./catalog");
const proto = require("../../proto-utils");

const LOCAL_PATHS = new Set([
  "/agent.v1.AgentService/RunSSE",
  "/aiserver.v1.BidiService/BidiAppend",
  "/aiserver.v1.AiService/AvailableDocs",
  "/aiserver.v1.DashboardService/GetEffectiveUserPlugins",
  "/aiserver.v1.DashboardService/GetUserPrivacyMode",
  "/agent.v1.AgentService/UpdateConversationMetadata",
  "/aiserver.v1.AiService/GetServerConfig",
  "/aiserver.v1.ServerConfigService/GetServerConfig",
  "/aiserver.v1.AiService/AvailableModels",
  "/agent.v1.AgentService/GetUsableModels",
  "/aiserver.v1.AiService/GetUsableModels",
  "/agent.v1.AgentService/GetDefaultModelForCli",
  "/aiserver.v1.AiService/GetDefaultModelForCli",
  "/aiserver.v1.AiService/GetDefaultModel",
  "/aiserver.v1.AiService/GetDefaultModelNudgeData",
  "/aiserver.v1.AuthService/GetEmail",
  "/aiserver.v1.AuthService/GetUserMeta",
  "/aiserver.v1.DashboardService/GetMe",
  "/aiserver.v1.DashboardService/GetTeams",
  "/aiserver.v1.DashboardService/GetUserProfile",
  "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  "/aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants",
  "/aiserver.v1.AiService/KnowledgeBaseAdd",
  "/aiserver.v1.AiService/KnowledgeBaseList",
  "/aiserver.v1.AiService/KnowledgeBaseUpdate",
  "/aiserver.v1.AiService/KnowledgeBaseRemove",
  "/aiserver.v1.AiService/WriteGitCommitMessage",
  "/aiserver.v1.NetworkService/IsConnected",
  "/aiserver.v1.AnalyticsService/BootstrapStatsig",
  "/auth/full_stripe_profile",
  "/auth/stripe_profile",
  "/aiserver.v1.AiService/IsConnected",
  "/aiserver.v1.ChatService/IsConnected",
  "/aiserver.v1.AiService/RunSSE",
  "/agent.v1.AgentService/BidiAppend",
  "/aiserver.v1.AiService/BidiAppend",
]);

const ACCOUNT_HINTS = [
  "GetCurrentUser",
  "GetCachedUser",
  "GetUserPrivacy",
  "GetUserPrivacyMode",
  "GetMe",
  "GetEmail",
  "GetUserMeta",
  "GetUserProfile",
  "GetPlan",
  "GetUsage",
  "GetCurrentPeriodUsage",
  "GetUsageLimitStatusAndActiveGrants",
  "GetSubscription",
  "GetMembership",
  "GetAccount",
  "GetTeams",
  "GetTeam",
  "GetStripeProfile",
  "GetStripe",
  "full_stripe_profile",
  "stripe_profile",
  "CheckFeatureStatus",
  "GetFeatureStatus",
  "GetAvailablePlans",
];

function encodeVarint(value) { return proto.encodeVarint(value); }
function decodeVarint(buf, i) { return proto.decodeVarint(buf, i); }
function walkProto(buf, acc) { return proto.walkProto(buf, acc); }
function parseProto(buf) { return proto.parseProto(buf); }
function connectFrame(payload) { return proto.connectFrame(payload); }
function stringField(field, value) { return proto.stringField(field, value); }
function messageField(field, body) { return proto.messageField(field, body); }
function intField(field, value) { return proto.intField(field, value); }
function boolField(field, value) { return proto.boolField(field, value); }
function bytesField(field, body) { return proto.bytesField(field, body); }
function join(parts) { return proto.join(parts); }
function protoGetBytes(body, fieldNum) { return proto.protoGetBytes(body, fieldNum); }
function protoGetString(body, fieldNum) { return proto.protoGetString(body, fieldNum); }
function protoGetVarint(body, fieldNum) { return proto.protoGetVarint(body, fieldNum); }

// AgentServerMessage encode:
// field 1 = interaction_update (InteractionUpdate)
//   field 1 = text_delta (TextDeltaUpdate)
//     field 1 = text (string)
function textDeltaFrame(text) {
  if (!text) return null;
  const textDeltaUpdate = messageField(1, stringField(1, text));
  const interactionUpdate = messageField(1, textDeltaUpdate);
  const agentServerMsg = messageField(1, interactionUpdate);
  return proto.connectFrame(agentServerMsg);
}

// TurnEndedUpdate encode:
// AgentServerMessage.interaction_update.turn_ended (field 14) = TurnEndedUpdate {}
function turnEndedFrame() {
  const turnEnded = Buffer.alloc(0);
  const interactionUpdate = messageField(14, turnEnded);
  const agentServerMsg = messageField(1, interactionUpdate);
  return proto.connectFrame(agentServerMsg);
}

function rpcPath(pathname) {
  return catalog.rpcPath(pathname);
}

function isPluginsPath(pathname) {
  return rpcPath(pathname).includes("GetEffectiveUserPlugins");
}

function isAccountPath(pathname) {
  const path = rpcPath(pathname);
  if (isPluginsPath(path)) return false;
  return ACCOUNT_HINTS.some((hint) => path.includes(hint));
}

function isLocalPath(pathname) {
  const path = rpcPath(pathname);
  if (LOCAL_PATHS.has(path)) return true;
  if (path.endsWith("/RunSSE") || path.endsWith("/BidiAppend")) return true;
  if (path.endsWith("/IsConnected")) return true;
  if (isAccountPath(path)) return true;
  return catalog.isCatalogPath(path);
}

function ultraStripeJson() {
  return Buffer.from(JSON.stringify({
    membershipType: "ultra",
    individualMembershipType: "ultra",
    subscriptionStatus: "active",
    lastPaymentFailed: false,
    pendingCancellationDate: null,
    daysRemainingOnTrial: 0,
    paymentId: "cursor-local-user",
    isTeamMember: false,
  }), "utf8");
}

function isStripePath(pathname) {
  const path = rpcPath(pathname);
  return path.includes("stripe_profile") || path.includes("full_stripe_profile");
}

function accountContentType(pathname) {
  return isStripePath(pathname) ? "application/json" : "application/proto";
}

function accountBody(pathname) {
  const path = rpcPath(pathname);
  if (isStripePath(path)) return ultraStripeJson();
  if (path.includes("GetEmail")) {
    return join([stringField(1, "cursor@ai.com"), intField(2, 3)]);
  }
  if (path.includes("GetUserMeta")) {
    return join([
      stringField(1, "cursor@ai.com"),
      intField(2, 3),
      intField(3, 1),
    ]);
  }
  if (path.includes("GetMe")) {
    return join([
      stringField(1, "cursor-local-user"),
      intField(2, 1),
      stringField(3, "cursor@ai.com"),
      stringField(4, "Cursor"),
      stringField(5, "Local"),
      stringField(8, new Date().toISOString()),
      intField(9, 0),
      stringField(11, "personal"),
      stringField(12, "US"),
    ]);
  }
  if (path.includes("GetUserProfile")) {
    return join([intField(4, 1), stringField(5, "PUBLIC")]);
  }
  if (path.includes("GetTeams")) return Buffer.alloc(0);
  if (path.includes("GetCurrentPeriodUsage")) {
    const now = Date.now();
    const plan = join([
      intField(1, 0),
      intField(2, 20000),
      intField(4, 20000),
      intField(5, 20000),
      intField(6, 0),
      stringField(7, "Ultra local account mock is active."),
      intField(8, 0),
      intField(9, 0),
    ]);
    return join([
      intField(1, now - 30 * 86400000),
      intField(2, now + 10 * 365 * 86400000),
      bytesField(3, plan),
      bytesField(4, stringField(8, "user")),
      intField(5, 99999999),
      intField(6, 1),
      stringField(7, "Ultra plan active"),
      stringField(11, "Ultra plan active"),
      stringField(12, "Ultra plan active"),
    ]);
  }
  if (path.includes("GetUsageLimitStatus")) {
    return bytesField(1, join([
      intField(1, 0),
      intField(6, 1),
      intField(8, 0),
    ]));
  }
  return join([
    stringField(1, "cursor-local-user"),
    stringField(3, "cursor@ai.com"),
  ]);
}

function patchAccountBytes(buf) {
  if (!buf || !buf.length) return ultraStripeJson();
  const map = [
    [Buffer.from("hobby"), Buffer.from("ultra")],
    [Buffer.from("Hobby"), Buffer.from("Ultra")],
    [Buffer.from("HOBBY"), Buffer.from("ULTRA")],
    [Buffer.from("free"), Buffer.from("pro\0")],
    [Buffer.from("Free"), Buffer.from("Pro\0")],
    [Buffer.from("FREE"), Buffer.from("PRO\0")],
  ];
  let out = Buffer.from(buf);
  for (const [from, to] of map) {
    if (from.length !== to.length) continue;
    let i = 0;
    while ((i = out.indexOf(from, i)) >= 0) {
      to.copy(out, i);
      i += to.length;
    }
  }
  return Buffer.concat([out, ultraMembership()]);
}

function isBidi(path) {
  return rpcPath(path).endsWith("/BidiAppend");
}

function isRunSse(path) {
  return rpcPath(path).endsWith("/RunSSE");
}

function isConnected(path) {
  return rpcPath(path).endsWith("/IsConnected");
}

class TransportRegistry {
  constructor() {
    this.local = new Map();
    this.upstream = new Map();
    this.waiters = new Map();
    this._timestamps = new Map(); // id → son erişim zamanı (ms)
    // 5 dakikada bir eski kayıtları temizle (TTL: 30 dakika)
    this._cleanTimer = setInterval(() => this._purgeStale(), 5 * 60 * 1000);
    if (this._cleanTimer.unref) this._cleanTimer.unref();
  }

  _touch(id) {
    this._timestamps.set(id, Date.now());
  }

  _purgeStale() {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30 dakikadan eski
    for (const [id, ts] of this._timestamps) {
      if (ts < cutoff) {
        this.local.delete(id);
        this.upstream.delete(id);
        this.waiters.delete(id);
        this._timestamps.delete(id);
      }
    }
  }

  notify(id) {
    this._touch(id);
    const list = this.waiters.get(id) || [];
    this.waiters.delete(id);
    list.forEach((fn) => fn());
  }

  markUpstream(id) {
    this._touch(id);
    const gen = (this.upstream.get(id) || 0) + 1;
    this.upstream.set(id, gen);
    this.notify(id);
    return gen;
  }

  getOrCreateLocal(id, replaceClosing) {
    this._touch(id);
    const cur = this.local.get(id);
    if (cur && !cur.closing) return cur;
    if (cur && replaceClosing) this.local.delete(id);
    const handle = {
      id,
      generation: (cur ? cur.generation : 0) + 1,
      closing: false,
      seq: 0,
      messages: [],
      waiters: [],
      prompt: "",
      modelId: "",
      hash: "",
    };
    this.local.set(id, handle);
    this.notify(id);
    return handle;
  }

  append(id, seqno, message, modelId, prompt) {
    this._touch(id);
    const handle = this.getOrCreateLocal(id, !!modelId);
    handle.seq = seqno;
    if (modelId) handle.modelId = modelId;
    if (prompt) {
      handle.prompt = (handle.prompt ? handle.prompt + "\n" : "") + prompt;
      // Son 20 mesajı tut — bellek ve API token maliyetini sınırlandır
      if (handle.messages.length >= 20) handle.messages.shift();
      handle.messages.push({ role: "user", content: prompt });
    }
    handle.waiters.splice(0).forEach((fn) => fn());
    return handle;
  }

  waitRoute(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const self = this;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (self.local.has(id)) return resolve({ kind: "local", handle: self.local.get(id) });
        if (self.upstream.has(id)) return resolve({ kind: "upstream", generation: self.upstream.get(id) });
        if (Date.now() > deadline) return reject(new Error("missing_transport"));
        const list = self.waiters.get(id) || [];
        list.push(check);
        self.waiters.set(id, list);
        setTimeout(check, 50);
      };
      check();
    });
  }

  close(id, generation) {
    const cur = this.local.get(id);
    if (cur && cur.generation === generation) {
      cur.closing = true;
      this.local.delete(id);
      this._timestamps.delete(id);
    }
  }
}

const registry = new TransportRegistry();
let models = [];

function setModels(list) {
  models = Array.isArray(list) ? list : [];
}

function getModels() {
  return models;
}

function findModel(id) {
  const raw = String(id || "");
  return models.find((m) => m.hash === raw || m.modelId === raw || m.id === raw || raw.startsWith(m.hash));
}

function extractRequestId(req) {
  const headers = (req && req.headers) || {};
  const target = String((req && req.target) || "");
  const q = target.indexOf("?");
  if (q >= 0) {
    try {
      const params = new URLSearchParams(target.slice(q + 1));
      const fromQuery = params.get("request_id") || params.get("requestId") || "";
      if (fromQuery) return fromQuery;
    } catch {}
  }
  const fromHeader = headers["x-request-id"] || headers["request-id"] || headers["x-cursor-request-id"] || "";
  if (fromHeader) return String(fromHeader);
  try {
    const decoded = decodeBidi((req && req.body) || Buffer.alloc(0));
    if (decoded.requestId) return decoded.requestId;
  } catch {}
  return "";
}

// Proto'dan nested message'ı parse et (wire type 2, field numarasına göre)
function protoGetBytes(body, fieldNum) {
  let i = 0;
  while (i < body.length) {
    let tag = 0, shift = 0;
    while (i < body.length) { const b = body[i++]; tag |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) { while (i < body.length) { const b = body[i++]; if (!(b & 0x80)) break; } }
    else if (wire === 1) { i += 8; }
    else if (wire === 2) {
      let len = 0, shift2 = 0;
      while (i < body.length) { const b = body[i++]; len |= (b & 0x7f) << shift2; shift2 += 7; if (!(b & 0x80)) break; }
      const slice = body.slice(i, i + len); i += len;
      if (field === fieldNum) return slice;
    }
    else if (wire === 5) { i += 4; }
    else break;
  }
  return null;
}

// Proto'dan belirli field'ın string/bytes değerini oku (ilk eşleşme)
function protoGetString(body, fieldNum) {
  const b = protoGetBytes(body, fieldNum);
  return b ? b.toString("utf8") : null;
}

// Proto'dan belirli field'ın varint değerini oku
function protoGetVarint(body, fieldNum) {
  let i = 0;
  while (i < body.length) {
    let tag = 0, shift = 0;
    while (i < body.length) { const b = body[i++]; tag |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) {
      let val = 0, s2 = 0;
      while (i < body.length) { const b = body[i++]; val |= (b & 0x7f) << s2; s2 += 7; if (!(b & 0x80)) break; }
      if (field === fieldNum) return val;
    }
    else if (wire === 1) { i += 8; }
    else if (wire === 2) { let len = 0, s2 = 0; while (i < body.length) { const b = body[i++]; len |= (b & 0x7f) << s2; s2 += 7; if (!(b & 0x80)) break; } i += len; }
    else if (wire === 5) { i += 4; }
    else break;
  }
  return null;
}

function decodeBidi(body) {
  // gzip decompress kontrolü
  let raw = body;
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      raw = require("zlib").gunzipSync(body);
      console.log("[BIDI-GUNZIP] ok decompressed=" + raw.length);
    } catch (e) {
      console.log("[BIDI-GUNZIP-ERR]", e && e.message);
    }
  }

  // BidiAppendRequest (binary proto)
  // field 1: data (string, hex-encoded AgentClientMessage)
  // field 2: request_id (BidiRequestId nested message → field 1: request_id string)
  // field 3: append_seqno (int64)

  let requestId = "";
  let seqno = 0;
  let modelId = "";
  let prompt = "";
  let json = null;

  // Önce JSON dene (eski format)
  try { json = JSON.parse(raw.toString("utf8")); } catch { json = null; }

  if (json) {
    requestId = String(json.request_id || json.requestId || "");
    seqno = Number(json.append_seqno || json.appendSeqno || 0);
    if (json.data) {
      try {
        const buf = Buffer.from(String(json.data), "hex");
        const proto = parseProto(buf);
        const strings = proto.strings.map((s) => s.value);
        modelId = strings.find((s) => findModel(s)) || "";
        const long = strings.filter((s) => s.length > 8 && !findModel(s) && !/^https?:/.test(s));
        prompt = long.sort((a, b) => b.length - a.length)[0] || "";
      } catch {}
    }
    if (json.requested_model && json.requested_model.model_id) modelId = json.requested_model.model_id;
    if (!modelId && json.model_details && json.model_details.model_id) modelId = json.model_details.model_id;
    return { requestId, seqno, modelId, prompt, json };
  }

  // Binary proto format
  const requestIdMsg = protoGetBytes(raw, 2);
  if (requestIdMsg) requestId = protoGetString(requestIdMsg, 1) || "";
  seqno = protoGetVarint(raw, 3) || 0;

  const dataHex = protoGetString(raw, 1);
  if (dataHex) {
    try {
      const agentMsg = Buffer.from(dataHex, "hex");
      const runReq = protoGetBytes(agentMsg, 1);
      if (runReq) {
        const requestedModel = protoGetBytes(runReq, 9);
        if (requestedModel) modelId = protoGetString(requestedModel, 1) || "";
        if (!modelId) {
          const modelDetails = protoGetBytes(runReq, 3);
          if (modelDetails) modelId = protoGetString(modelDetails, 1) || "";
        }
        if (!prompt) {
          const proto = parseProto(runReq);
          const strings = proto.strings.map((s) => s.value);
          const long = strings.filter((s) => s.length > 10 && !findModel(s) && !/^https?:/.test(s) && !/^[0-9a-f-]{32,}$/.test(s));
          prompt = long.sort((a, b) => b.length - a.length)[0] || "";
        }
      }
    } catch (e) {
      console.log("[BIDI-DECODE-ERR]", e && e.message);
    }
  }

  console.log("[BIDI-DETAIL] requestId=" + requestId + " modelId=" + modelId + " seqno=" + seqno);
  return { requestId, seqno, modelId, prompt, json: null };
}

function pluginPrefix(id) {
  return String(id || "").startsWith("cursor-byok") || String(id || "").startsWith("plugin-");
}

function shouldLocal(modelId) {
  if (!modelId) return null;
  if (pluginPrefix(modelId)) return true;
  return !!findModel(modelId);
}

function openaiChat(entry, messages, onDelta) {
  const endpoint = catalog.openaiEndpoint(entry.openaiEndpoint || "/v1/chat/completions");
  let href;
  try {
    href = new URL(catalog.requestUrl(entry.baseUrl, endpoint, !!entry.useFullUrl));
  } catch {
    href = new URL(String(entry.baseUrl || "https://api.openai.com").replace(/\/$/, "") + endpoint);
  }
  const payload = JSON.stringify({
    model: entry.modelId,
    messages,
    stream: true,
    max_tokens: 4096,
  });
  const lib = href.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: href.protocol,
      hostname: href.hostname,
      port: href.port || (href.protocol === "http:" ? 80 : 443),
      path: href.pathname + href.search,
      method: "POST",
      headers: {
        Authorization: "Bearer " + entry.apiKey,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let buf = "";
      let fullText = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices && json.choices[0] && json.choices[0].delta
              ? (json.choices[0].delta.content || "")
              : (json.delta && json.delta.text) || "";
            if (delta) {
              fullText += delta;
              onDelta(delta);
            }
          } catch {}
        }
      });
      res.on("end", () => resolve(fullText));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function handleBidi(req) {
  const decoded = decodeBidi(req.body || Buffer.alloc(0));
  console.log("[BIDI] requestId=" + decoded.requestId + " modelId=" + decoded.modelId + " shouldLocal=" + shouldLocal(decoded.modelId));
  if (!decoded.requestId) {
    return { status: "400 Bad Request", body: Buffer.from("request_id zorunlu"), headers: { "content-type": "text/plain" } };
  }
  const local = shouldLocal(decoded.modelId);
  if (local === true || (local === null && registry.local.has(decoded.requestId))) {
    registry.append(decoded.requestId, decoded.seqno, decoded.json, decoded.modelId, decoded.prompt);
    return { status: "200 OK", body: Buffer.alloc(0), headers: { "content-type": "application/json" } };
  }
  if (local === false) {
    registry.markUpstream(decoded.requestId);
    return { forward: true };
  }
  if (registry.upstream.has(decoded.requestId)) return { forward: true };
  if (registry.local.has(decoded.requestId)) {
    registry.append(decoded.requestId, decoded.seqno, decoded.json, decoded.modelId, decoded.prompt);
    return { status: "200 OK", body: Buffer.alloc(0), headers: { "content-type": "application/json" } };
  }
  return { status: "409 Conflict", body: Buffer.from("missing_transport"), headers: { "content-type": "text/plain" } };
}

function writeChunk(socket, buf) {
  if (!buf || !buf.length || socket.destroyed) return;
  socket.write(buf.length.toString(16) + "\r\n");
  socket.write(buf);
  socket.write("\r\n");
}

async function streamLocalSse(socket, handle) {
  const entry = findModel(handle.modelId) || models[0];
  // RunSSE content-type: text/event-stream (cursor-byok-1.0.1 run_sse.rs gibi)
  const headers = {
    "content-type": "text/event-stream",
    "connect-protocol-version": "1",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "transfer-encoding": "chunked",
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
  };
  const lines = ["HTTP/1.1 200 OK"];
  for (const [k, v] of Object.entries(headers)) lines.push(k + ": " + v);
  socket.write(lines.join("\r\n") + "\r\n\r\n");
  if (!entry) {
    const errFrame = textDeltaFrame("Cursor BYOK: model kaydı yok.");
    if (errFrame) writeChunk(socket, errFrame);
    // END_STREAM frame (flags=0x02)
    const endFrame = Buffer.alloc(5); endFrame[0] = 0x02;
    writeChunk(socket, endFrame);
    if (!socket.destroyed) socket.write("0\r\n\r\n");
    registry.close(handle.id, handle.generation);
    return;
  }
  const messages = handle.messages && handle.messages.length
    ? handle.messages
    : [{ role: "user", content: handle.prompt || "Merhaba" }];
  try {
    await openaiChat(entry, messages, (delta) => {
      const frame = textDeltaFrame(delta);
      if (frame) writeChunk(socket, frame);
    });
    // turn_ended frame
    const doneFrame = turnEndedFrame();
    if (doneFrame) writeChunk(socket, doneFrame);
  } catch (err) {
    const frame = textDeltaFrame(String(err.message || err));
    if (frame) writeChunk(socket, frame);
  }
  // END_STREAM frame (flags=0x02, length=0)
  const endFrame = Buffer.alloc(5); endFrame[0] = 0x02;
  writeChunk(socket, endFrame);
  if (!socket.destroyed) socket.write("0\r\n\r\n");
  registry.close(handle.id, handle.generation);
}

module.exports = {
  isLocalPath,
  isBidi,
  isRunSse,
  isConnected,
  setModels,
  getModels,
  registry,
  handleBidi,
  extractRequestId,
  streamLocalSse,
  isAccountPath,
  isStripePath,
  accountContentType,
  patchAccountBytes,
  isPluginsPath,
  accountBody,
  rpcPath,
  connectFrame,
  decodeBidi,
  findModel,
};
