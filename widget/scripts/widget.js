const PORT = 47331;
const BASE = "http://127.0.0.1:" + PORT;
const REDIRECT = BASE + "/oauth/callback";
const HEADERS = { "X-Edge-Discord": "1", "Content-Type": "application/json" };

const gate = document.querySelector("#gate");
const call = document.querySelector("#call");
const sheet = document.querySelector("#sheet");
const roster = document.querySelector("#roster");
const channels = document.querySelector("#channels");
const side = document.querySelector("#side");
const cards = new Map();

let snap = null;

let pendingForce = null;
let rosterKey = "";
let channelKey = "";
let sideKey = "";
let gateKey = "";
let noticeKey = "";
let dockKey = "";
let started = false;
let volumeTimer = 0;
const volumeDrag = new Set();

icueEvents = {
  onICUEInitialized: init,
  onDataUpdated: applyColors,
};

if (typeof iCUE_initialized !== "undefined" && iCUE_initialized) init();
window.addEventListener("load", () => {
  if (!started) init();
});

function init() {
  if (started) return;
  started = true;
  applyColors();
  applyLayout(readLayout());
  document.querySelector("#app").addEventListener("click", onClick);
  document.querySelector("#app").addEventListener("change", onChange);
  new ResizeObserver(() => fitRoster()).observe(roster);
  connect();
  window.setInterval(paintTimer, 1000);
}

function applyColors() {
  const root = document.documentElement;
  root.style.setProperty("--text-color", colorOf("textColor", "#F3F5F8"));
  root.style.setProperty("--accent-color", colorOf("accentColor", "#8B97FF"));
  root.style.setProperty("--bg-color", colorOf("backgroundColor", "#0C0E12"));
}

function colorOf(name, fallback) {
  const value = getIcueProperty(name);
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

function getIcueProperty(name) {
  if (typeof window !== "undefined" && Object.prototype.hasOwnProperty.call(window, name)) {
    const value = window[name];
    if (value) return value;
  }
  try {
    const value = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
    if (value) return value;
  } catch (error) {
    return undefined;
  }
  return undefined;
}

function connect() {
  const source = new EventSource(BASE + "/v1/events");
  source.onmessage = (event) => {
    render(JSON.parse(event.data));
  };
  source.onerror = () => {
    source.close();
    if (!snap) showOffline();
    window.setTimeout(connect, 1500);
  };
}

function showOffline() {
  gate.hidden = false;
  call.hidden = true;
  gate.replaceChildren(el("h1", null, "Bridge is not running"));
  gate.append(el("p", "hint", "Discord Edge should be in the system tray. If it is not, run npm start once."));
}

function render(next) {
  snap = next;
  applyColors();
  if (next.phase !== "ready") {
    gate.hidden = false;
    call.hidden = true;
    renderGate(next);
    return;
  }
  gateKey = "";
  gate.hidden = true;
  call.hidden = false;
  renderCall(next);
}

function renderGate(next) {
  const key = next.phase + "|" + next.configured + "|" + (next.detail || "");
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest("#gate form");
  if (typing || (key === gateKey && gate.childElementCount > 0)) return;
  gateKey = key;
  gate.replaceChildren();
  gate.append(el("p", "kicker", "Discord Edge"));
  gate.append(el("h1", null, titleFor(next.phase)));
  if (next.detail) gate.append(el("p", next.phase === "error" ? "error" : "hint", next.detail));
  if (next.phase === "need-setup" || !next.configured) {
    gate.append(steps());
    gate.append(form());
  } else {
    const row = el("div", "row");
    row.append(button("Connect", "authorize", "primary"));
    row.append(button("Browser login", "browser-auth", "text-btn"));
    row.append(button("Clear credentials", "clear", "text-btn"));
    gate.append(row);
  }
}

function titleFor(phase) {
  if (phase === "authorizing") return "Discord is asking for permission";
  if (phase === "discord-down") return "Discord is not open";
  if (phase === "error") return "Connection failed";
  return "Your own Discord app, once";
}

function steps() {
  const list = document.createElement("ol");
  list.className = "steps";
  for (const line of [
    "discord.com/developers/applications → New Application.",
    "OAuth2 → Redirects → paste the URL below → Save Changes.",
    "Enter the client ID and secret here. The secret stays on this PC.",
  ]) {
    list.append(el("li", null, line));
  }
  const uri = el("p", "uri", REDIRECT);
  const copy = button("Copy URL", "copy", "text-btn");
  const wrap = el("div", "row");
  wrap.append(uri, copy);
  const block = el("div");
  block.append(list, wrap);
  return block;
}

function form() {
  const fields = el("form");
  fields.append(labeled("Client ID", "client-id", "text"));
  fields.append(labeled("Client secret", "client-secret", "password"));
  const submit = button("Save and connect", "setup", "primary");
  submit.type = "submit";
  fields.append(submit);
  fields.addEventListener("submit", (event) => {
    event.preventDefault();
    const clientId = fields.querySelector("#client-id").value;
    const clientSecret = fields.querySelector("#client-secret").value;
    void post("/v1/setup", { clientId, clientSecret }).then((result) => {
      if (result && result.ok === false) showFormError(fields, result.detail || "Could not save.");
      fields.querySelector("#client-secret").value = "";
    });
  });
  return fields;
}

function labeled(label, id, type) {
  const wrap = el("label", "hint", label);
  wrap.htmlFor = id;
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.autocomplete = "off";
  input.spellcheck = false;
  wrap.append(input);
  return wrap;
}

function showFormError(fields, text) {
  const old = fields.querySelector(".error");
  if (old) old.remove();
  fields.append(el("p", "error", text));
}

let channelLoad = "";
function ensureVoiceGuild(next) {
  const guildId = next.voice?.guildId || "";
  if (!guildId) return;
  if (guildId !== next.activeGuildId) {
    if (guildId === channelLoad) return;
    channelLoad = guildId;
    void actPost({ type: "channels", guildId });
    return;
  }
  const texts = guildChannels(next, 0).concat(guildChannels(next, 5));
  const chatId = next.chat?.channelId || "";
  if (!texts.length || texts.some((channel) => channel.id === chatId) || channelLoad === "chat:" + guildId) return;
  channelLoad = "chat:" + guildId;
  const text = texts.find((channel) => channel.name === "general") || texts[0];
  void actPost({ type: "watch-chat", channelId: text.id });
}

function guildChannels(next, type) {
  const guildId = next.voice?.guildId;
  return (next.channels || []).filter((channel) => channel.type === type && (!guildId || channel.guildId === guildId));
}

function renderCall(next) {
  ensureVoiceGuild(next);
  setText(document.querySelector("#guild"), next.voice.guildName || "Discord");
  setText(document.querySelector("#channel"), next.voice.channelName || "Not in voice");
  setText(document.querySelector("#count"), next.voice.members.length ? next.voice.members.length + " in call" : "No call");
  paintTimer();
  renderNotices(next);
  paintDock(next);
  const shown = next.voice.members.slice(0, 25);
  const nextRoster = shown.map((member) => member.id).join(",") + "|" + next.voice.members.length + "|" + (next.voice.channelId || "");
  if (nextRoster !== rosterKey) {
    rosterKey = nextRoster;
    buildRoster(next);
  } else {
    patchRoster(next);
  }
  const nextChannels = next.activeGuildId + "|" + next.voice.channelId + "|" + next.channels.map((channel) => channel.id + ":" + (channel.people || []).map((person) => person.id).join(".")).join(",");
  if (nextChannels !== channelKey) {
    channelKey = nextChannels;
    buildChannels(next);
  } else {
    patchOccupants(next);
  }
  const nextSide = [
    next.chat.channelId,
    next.chat.messages.map((message) => message.id).join(","),
    next.settings.inputDeviceId,
    next.settings.outputDeviceId,
  ].join("|");
  if (nextSide !== sideKey) {
    sideKey = nextSide;
    buildSide(next);
  }
}

function paintTimer() {
  const node = document.querySelector("#timer");
  if (!node || !snap || snap.phase !== "ready") return;
  setText(node, snap.voice.since ? elapsed(snap.voice.since) : "");
}

function elapsed(since) {
  const total = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? hours + ":" + pad(minutes) + ":" + pad(seconds) : minutes + ":" + pad(seconds);
}

function renderNotices(next) {
  const key = next.notifications.slice(0, 2).map((notice) => notice.id + "\n" + notice.title + "\n" + notice.body).join("|");
  if (key === noticeKey) return;
  noticeKey = key;
  const host = document.querySelector("#notices");
  host.replaceChildren();
  for (const notice of next.notifications.slice(0, 2)) {
    const item = button(notice.title + ": " + notice.body, "dismiss", "notice");
    item.dataset.id = notice.id;
    item.dataset.channel = notice.channelId || "";
    host.append(item);
  }
}

function paintDock(next) {
  const pair = next.mics || { a: "", b: "" };
  const devices = next.settings?.inputDevices || [];
  const nameOf = (id) => devices.find((item) => item.id === id)?.name || "";
  const target = pair.a && pair.b ? (next.settings.inputDeviceId === pair.a ? pair.b : pair.a) : "";
  const label = target ? shortDevice(nameOf(target) || "Mic") : "Mic";
  const key = [next.voice.selfMute, next.voice.selfDeaf, next.voice.channelId || "", label].join("|");
  if (key === dockKey) return;
  dockKey = key;
  document.querySelector("#mute").setAttribute("aria-pressed", String(next.voice.selfMute));
  document.querySelector("#deafen").setAttribute("aria-pressed", String(next.voice.selfDeaf));
  document.querySelector("#leave").disabled = !next.voice.channelId;
  const mic = document.querySelector("#mic");
  setText(mic.querySelector("span"), label);
  mic.title = target ? "Switch to " + (nameOf(target) || "the other microphone") : "Choose two microphones";
}

function buildRoster(next) {
  const shown = next.voice.members.slice(0, 25);
  const keep = new Set(shown.map((member) => member.id));
  for (const [id, node] of cards) {
    if (!keep.has(id)) {
      node.remove();
      cards.delete(id);
    }
  }
  if (shown.length === 0) {
    cards.clear();
    roster.dataset.count = "0";
    roster.replaceChildren(el("p", "empty", next.voice.channelId ? "Nobody else in the channel" : "Not in voice"));
    fitRoster();
    return;
  }
  roster.querySelector(":scope > .empty")?.remove();
  const countChanged = roster.dataset.count !== String(shown.length);
  for (const member of shown) {
    let node = cards.get(member.id);
    if (!node) {
      node = personButton(member);
      cards.set(member.id, node);
    }
    roster.append(node);
  }
  const extra = next.voice.members.length - shown.length;
  let hint = roster.querySelector(":scope > .hint");
  if (extra > 0) {
    const label = "+" + extra + " more";
    if (!hint) roster.append(el("p", "hint", label));
    else setText(hint, label);
  } else hint?.remove();
  if (countChanged) {
    roster.dataset.count = String(shown.length);
    roster.style.setProperty("--face", facePx(shown.length) + "px");
    fitRoster();
    requestAnimationFrame(fitRoster);
  }
  patchRoster(next);
}

function patchRoster(next) {
  for (const member of next.voice.members) {
    const node = cards.get(member.id);
    if (!node) continue;
    node.classList.toggle("speaking", member.speaking);
    node.classList.toggle("muted", member.selfMute || member.serverMute || member.localMute);

    const open = node.querySelector(".person-open");
    if (open && !member.self) {
      const pressed = String(member.localMute);
      if (open.getAttribute("aria-pressed") !== pressed) {
        open.setAttribute("aria-pressed", pressed);
        open.setAttribute("aria-label", (member.localMute ? "Unmute " : "Mute ") + member.name);
      }
    }
    setText(node.querySelector(".name"), member.name);
    setText(node.querySelector(".status"), statusText(member));
    syncBadge(node.querySelector(".face-wrap"), member);
    const face = node.querySelector(".face");
    const img = face?.querySelector("img");
    const url = avatarUrl(member);
    if (img) {
      if (img.getAttribute("src") !== url) img.src = url;
    } else if (member.avatar && face && face.textContent === initials(member.name)) {
      const nextImg = document.createElement("img");
      nextImg.alt = "";
      nextImg.decoding = "async";
      nextImg.src = url;
      nextImg.addEventListener("error", () => nextImg.remove());
      face.textContent = "";
      face.append(nextImg);
    }
    const note = node.querySelector(".self-state");
    if (note) setText(note, selfState(member));
    const range = node.querySelector(".vol");
    const read = node.querySelector(".vol-read");
    if (range && !volumeDrag.has(member.id)) paintVolume(range, read, member.volume);
  }
}

function avatarUrl(member) {
  return BASE + "/v1/avatar/" + member.id + (member.avatar ? "?h=" + encodeURIComponent(member.avatar) : "");
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function patchOccupants(next) {
  const speaking = new Set();
  for (const member of next.voice.members) if (member.speaking) speaking.add(member.id);
  for (const row of channels.querySelectorAll(".occupant")) row.classList.toggle("speaking", speaking.has(row.dataset.id));
}

function personButton(member) {
  const node = document.createElement("article");
  node.className = "person";
  node.dataset.person = member.id;
  node.classList.toggle("speaking", member.speaking);
  node.classList.toggle("self", member.self);
  node.classList.toggle("muted", member.selfMute || member.serverMute || member.localMute);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "person-open";
  open.dataset.act = "person";
  open.dataset.id = member.id;
  if (!member.self) {
    open.setAttribute("aria-pressed", String(member.localMute));
    open.setAttribute("aria-label", (member.localMute ? "Unmute " : "Mute ") + member.name);
  }
  const wrap = el("span", "face-wrap");
  const face = el("span", "face");
  face.style.setProperty("--face-color", faceColor(member.id));
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.src = avatarUrl(member);
  img.addEventListener("error", () => {
    img.remove();
    face.textContent = initials(member.name);
  });
  face.append(img);
  wrap.append(face);
  syncBadge(wrap, member);
  const copy = el("span", "who-copy");
  copy.append(el("span", "name", member.name), el("span", "status", statusText(member)));
  open.append(wrap, copy);
  const body = el("div", "person-body");
  body.append(open);
  if (member.self) body.append(selfNote(member));
  else body.append(personTools(member));
  node.append(body);
  return node;
}

function personTools(member) {
  const tools = el("div", "tools");
  tools.append(el("p", "tool-label", "Volume"));
  const line = el("div", "vol-line");
  const read = el("span", "vol-read", member.volume + "%");
  const range = document.createElement("input");
  range.type = "range";
  range.className = "vol";
  range.min = "0";
  range.max = "200";
  range.step = "1";
  range.value = String(member.volume);
  range.style.setProperty("--pct", (member.volume / 200) * 100 + "%");
  range.setAttribute("aria-label", "Volume for " + member.name);
  bindVolume(range, read, member.id);
  line.append(read, range);
  tools.append(line);
  return tools;
}

function bindVolume(range, read, userId) {
  const apply = (event) => {
    const volume = volumeFromPointer(range, event);
    paintVolume(range, read, volume);
    window.clearTimeout(volumeTimer);
    volumeTimer = window.setTimeout(() => sendVolume(userId, volume), 140);
  };
  let closed = false;
  const finish = () => {
    if (closed || !volumeDrag.has(userId)) return;
    closed = true;
    window.clearTimeout(volumeTimer);
    void sendVolume(userId, Number(range.value)).finally(() => volumeDrag.delete(userId));
  };
  range.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    volumeDrag.add(userId);
    range.setPointerCapture(event.pointerId);
    apply(event);
  });
  range.addEventListener("pointermove", (event) => {
    if (volumeDrag.has(userId)) apply(event);
  });
  range.addEventListener("pointerup", (event) => {
    if (closed || !volumeDrag.has(userId)) return;
    apply(event);
    finish();
  });
  range.addEventListener("pointercancel", finish);
  range.addEventListener("lostpointercapture", finish);
  range.addEventListener("input", () => {
    if (volumeDrag.has(userId)) return;
    paintVolume(range, read, Number(range.value));
    window.clearTimeout(volumeTimer);
    volumeTimer = window.setTimeout(() => sendVolume(userId, Number(range.value)), 140);
  });
  range.addEventListener("change", () => {
    if (volumeDrag.has(userId)) return;
    window.clearTimeout(volumeTimer);
    sendVolume(userId, Number(range.value));
  });
}

function paintVolume(range, read, volume) {
  const next = String(Math.max(0, Math.min(200, Math.round(volume))));
  if (range.value !== next) range.value = next;
  range.style.setProperty("--pct", (Number(next) / 200) * 100 + "%");
  if (read) setText(read, next + "%");
}

function volumeFromPointer(range, event) {
  const rect = range.getBoundingClientRect();
  if (rect.width < 8) return Number(range.value);
  const thumb = 22;
  const span = Math.max(1, rect.width - thumb);
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - thumb / 2) / span));
  return Math.round(ratio * 200);
}

function selfNote(member) {
  const note = el("div", "tools self-note");
  note.append(el("p", "tool-label", "You"));
  note.append(el("p", "self-state", selfState(member)));
  return note;
}

function selfState(member) {
  if (member.selfDeaf || member.serverDeaf) return "Deafened";
  if (member.selfMute || member.serverMute) return "Muted";
  return "Mic open";
}

function buildChannels(next) {
  channels.replaceChildren();
  const voices = guildChannels(next, 2).concat(guildChannels(next, 13));
  if (next.voice.channelId && !voices.some((channel) => channel.id === next.voice.channelId)) {
    voices.unshift({ id: next.voice.channelId, name: next.voice.channelName || "Voice", type: 2, guildId: next.voice.guildId || "", people: next.voice.members });
  }
  if (voices.length === 0) {
    channels.append(el("p", "hint", "Discord did not send any voice channels."));
    return;
  }
  for (const channel of voices) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "channel";
    item.dataset.act = "join";
    item.dataset.id = channel.id;
    if (channel.id === next.voice.channelId) item.classList.add("current");
    const people = channel.id === next.voice.channelId ? next.voice.members : channel.people || [];
    item.append(el("span", "mark"), el("span", null, channel.name));
    channels.append(item);
    for (const person of people) channels.append(occupantRow(person));
  }
}

function occupantRow(person) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "occupant";
  row.dataset.act = "person";
  row.dataset.id = person.id;
  if (person.speaking) row.classList.add("speaking");
  const face = el("span", "mini");
  face.style.setProperty("--face-color", faceColor(person.id));
  const img = document.createElement("img");
  img.alt = "";
  img.src = BASE + "/v1/avatar/" + person.id;
  img.addEventListener("error", () => {
    img.remove();
    face.textContent = initials(person.name);
  });
  face.append(img);
  row.append(face, el("span", null, person.name));
  return row;
}

function buildSide(next) {
  if (!side) return;
  const chat = next.chat || { channelId: null, channelName: null, messages: [], error: "" };
  side.replaceChildren(el("p", "panel-title", chat.channelName ? "#" + chat.channelName : "Chat"));
  const texts = guildChannels(next, 0).concat(guildChannels(next, 5));
  if (texts.length > 0) {
    const select = document.createElement("select");
    select.dataset.act = "watch-chat";
    for (const channel of texts) {
      const option = document.createElement("option");
      option.value = channel.id;
      option.textContent = "#" + channel.name;
      option.selected = channel.id === chat.channelId;
      select.append(option);
    }
    side.append(select);
  }
  if (chat.error) side.append(el("p", "hint", chat.error));
  else if (!chat.messages.length) side.append(el("p", "hint", "No messages yet. New ones show up here."));
  for (const message of (chat.messages || []).slice(-20)) {
    const row = el("div", "msg");
    const dot = el("span", "dot", initials(message.author));
    dot.style.setProperty("--face-color", faceColor(message.author));
    const copy = el("div", "bubble");
    copy.append(el("strong", null, message.author), el("p", null, message.content || "…"));
    row.append(dot, copy);
    side.append(row);
  }
}

function deviceSelect(label, act, devices, current) {
  const wrap = el("label", "hint", label);
  const select = document.createElement("select");
  select.dataset.act = act;
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.name;
    option.selected = device.id === current;
    select.append(option);
  }
  if (devices.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No devices";
    select.append(option);
    select.disabled = true;
  }
  wrap.append(select);
  return wrap;
}

function chatBlock(next) {
  const block = el("div", "chat");
  block.append(el("p", "panel-title", next.chat.channelName ? "Chat · #" + next.chat.channelName : "Chat"));
  const texts = next.channels.filter((channel) => channel.type === 0 || channel.type === 5);
  if (texts.length > 0) {
    const select = document.createElement("select");
    select.dataset.act = "watch-chat";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Channel";
    select.append(blank);
    for (const channel of texts) {
      const option = document.createElement("option");
      option.value = channel.id;
      option.textContent = "#" + channel.name;
      option.selected = channel.id === next.chat.channelId;
      select.append(option);
    }
    block.append(select);
  }
  if (next.chat.error) block.append(el("p", "hint", next.chat.error));
  if (next.chat.messages.length === 0 && !next.chat.error) block.append(el("p", "hint", "No messages yet."));
  for (const message of next.chat.messages.slice(-12)) {
    const row = el("div", "msg");
    const dot = el("span", "dot", initials(message.author));
    dot.style.setProperty("--face-color", faceColor(message.author));
    const copy = el("div", "bubble");
    copy.append(el("strong", null, message.author), el("p", null, message.content || "…"));
    row.append(dot, copy);
    block.append(row);
  }
  return block;
}

function onClick(event) {
  const target = event.target.closest("[data-act]");
  if (!target || target.tagName === "SELECT") return;
  const act = target.dataset.act;
  if (act === "layout") {
    applyLayout(!document.querySelector("#app").classList.contains("compact"));
    return;
  }
  if (act === "person") {
    const member = snap?.voice.members.find((item) => item.id === target.dataset.id);
    if (!member || member.self) return;
    void actPost({ type: "user-mute", userId: member.id, mute: !member.localMute });
    return;
  }
  if (act === "copy") {
    void navigator.clipboard?.writeText(REDIRECT);
    return;
  }
  if (act === "setup") return;
  if (act === "cancel") {
    sheet.hidden = true;
    pendingForce = null;
    return;
  }
  if (act === "force" && pendingForce) {
    void actPost({ type: "join", channelId: pendingForce, force: true });
    sheet.hidden = true;
    pendingForce = null;
    return;
  }
  if (act === "join") {
    void actPost({ type: "join", channelId: target.dataset.id });
    return;
  }
  if (act === "dismiss") {
    void actPost({ type: "dismiss", id: target.dataset.id });
    if (target.dataset.channel) void actPost({ type: "watch-chat", channelId: target.dataset.channel });
    return;
  }
  if (act === "authorize" || act === "browser-auth" || act === "clear" || act === "mute" || act === "deafen" || act === "leave") {
    void actPost({ type: act === "browser-auth" ? "browser-auth" : act === "authorize" ? "authorize" : act });
    return;
  }
  if (act === "mic-setup") {
    openMicSheet();
    return;
  }
  if (act === "switch-mic") {
    if (!snap?.mics?.a || !snap?.mics?.b) openMicSheet();
    else void actPost({ type: "switch-mic" });
    return;
  }
  if (act === "save-mics") {
    const a = document.querySelector("#mic-a")?.value || "";
    const b = document.querySelector("#mic-b")?.value || "";
    void post("/v1/action", { type: "save-mics", a, b }).then((result) => {
      const hint = sheet.querySelector(".hint");
      if (result && result.ok === false) {
        if (hint) hint.textContent = result.detail || "Could not save.";
        return;
      }
      sheet.hidden = true;
    });
    return;
  }
  if (act === "channels") void actPost({ type: "channels", guildId: target.dataset.id });
}

function onChange(event) {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  if (select.dataset.act === "watch-chat" && select.value) void actPost({ type: "watch-chat", channelId: select.value });
  if (select.dataset.act === "channels" && select.value) void actPost({ type: "channels", guildId: select.value });
  if (select.dataset.act === "input-device" || select.dataset.act === "output-device") {
    void actPost({ type: select.dataset.act, deviceId: select.value });
  }
}

async function actPost(body) {
  const result = await post("/v1/action", body);
  if (result && result.needsForce && body.channelId) {
    pendingForce = body.channelId;
    openForceSheet();
  }
}

function openForceSheet() {
  sheet.hidden = false;
  sheet.replaceChildren(
    el("p", "who", "You are already in a voice channel."),
    button("Switch", "force", "primary"),
    button("Stay", "cancel", "text-btn"),
  );
}


function openMicSheet() {
  if (!sheet || !snap) return;
  const devices = snap.settings.inputDevices || [];
  sheet.hidden = false;
  sheet.replaceChildren(
    el("p", "who", "Two microphones"),
    el("p", "hint", devices.length ? "The dock button switches between these." : "Discord has not sent any microphones yet."),
    micSelect("mic-a", "First", snap.mics?.a || "", devices),
    micSelect("mic-b", "Second", snap.mics?.b || "", devices),
    button("Save", "save-mics", "primary"),
    button("Close", "cancel", "text-btn"),
  );
}

function micSelect(id, label, current, devices) {
  const wrap = el("label", "hint", label);
  const select = document.createElement("select");
  select.id = id;
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose";
  select.append(blank);
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.name;
    option.selected = device.id === current;
    select.append(option);
  }
  wrap.append(select);
  return wrap;
}

function shortDevice(name) {
  const raw = String(name || "").trim();
  if (!raw) return "Mic";
  const match = raw.match(/^(.*)\(([^()]*)\)\s*$/);
  const inside = match ? productWord(match[2]) : "";
  if (inside) return clip(inside);
  const outside = (match ? match[1] : raw).trim();
  return clip(productWord(outside) || outside || raw);
}

function productWord(text) {
  const drop = new Set([
    "microphone", "mikrofon", "mikrofonarray", "mic", "headset", "headphone", "headphones",
    "kopfhörer", "kopfhoerer", "speaker", "lautsprecher", "usb", "audio", "device", "gerät", "gerat",
    "wireless", "default", "communication", "kommunikation", "chat", "game", "array",
    "steelseries", "logitech", "corsair", "razer", "hyperx", "sony", "jabra", "elgato",
    "rode", "samson", "fifine", "maono", "realtek", "nvidia", "amd", "microsoft", "blue",
  ]);
  const words = String(text || "").replace(/\(r\)/gi, " ").replace(/[®™]/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.find((word) => !drop.has(word.toLowerCase()) && !/^\d+$/.test(word)) || "";
}

function clip(name) {
  const text = String(name || "").trim();
  return text.length > 14 ? text.slice(0, 13).trim() + "…" : text;
}

function readLayout() {
  try { return localStorage.getItem("edge-discord-layout") === "compact"; } catch { return false; }
}

function applyLayout(compact) {
  document.querySelector("#app").classList.toggle("compact", compact);
  const button = document.querySelector("#layout");
  button.textContent = compact ? "Full" : "Compact";
  button.setAttribute("aria-pressed", String(compact));
  try { localStorage.setItem("edge-discord-layout", compact ? "compact" : "full"); } catch { /* iCUE may block storage */ }
  requestAnimationFrame(fitRoster);
}


function fitRoster() {
  if (!document.querySelector("#app").classList.contains("compact")) {
    for (const card of roster.querySelectorAll(".person")) card.style.removeProperty("--face");
    return;
  }
  const count = Number(roster.dataset.count || 0);
  const box = roster.getBoundingClientRect();
  if (box.width < 40 || box.height < 40) return;
  const fit = fitGrid(Math.max(count, 1), box.width, box.height);
  const cols = String(fit.cols);
  const rows = String(fit.rows);
  if (roster.style.getPropertyValue("--cols") !== cols || roster.style.getPropertyValue("--rows") !== rows) {
    roster.style.setProperty("--cols", cols);
    roster.style.setProperty("--rows", rows);
    requestAnimationFrame(fitFaces);
    return;
  }
  fitFaces();
}

function fitFaces() {
  if (!document.querySelector("#app").classList.contains("compact")) return;
  for (const card of roster.querySelectorAll(".person")) {
    const copy = card.querySelector(".who-copy");
    const tools = card.querySelector(".tools");
    const copyH = copy ? copy.offsetHeight : 0;
    const toolsH = tools && getComputedStyle(tools).display !== "none" ? tools.offsetHeight : 0;
    const availH = card.clientHeight - copyH - toolsH - 18;
    const availW = card.clientWidth - 16;
    const size = Math.max(28, Math.min(availW, availH, 340));
    const next = Math.floor(size) + "px";
    if (card.style.getPropertyValue("--face") !== next) card.style.setProperty("--face", next);
  }
}

function fitGrid(count, width, height) {
  if (count <= 1) return { cols: 1, rows: 1 };
  const gap = 10;
  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cw = (width - gap * (cols - 1)) / cols;
    const ch = (height - gap * (rows - 1)) / rows;
    if (cw < 88 || ch < 88) continue;
    const aspect = cw / ch;
    const aspectPenalty = aspect < 0.62 ? (0.62 - aspect) * 4 : aspect > 1.55 ? (aspect - 1.55) * 2.2 : 0;
    const empty = cols * rows - count;
    const score = cw * ch - aspectPenalty * 9000 - empty * 14000;
    if (!best || score > best.score) best = { cols, rows, score };
  }
  if (best) return best;
  const cols = Math.max(1, Math.min(count, Math.floor((width + gap) / (110 + gap))));
  return { cols, rows: Math.ceil(count / cols) };
}

function syncBadge(wrap, member) {
  if (!wrap) return;
  const deaf = member.serverDeaf || member.selfDeaf;
  const muted = member.selfMute || member.serverMute || member.localMute;
  const kind = deaf ? "deaf" : muted ? "mute" : "";
  const current = wrap.querySelector(".badge");
  if (!kind) {
    current?.remove();
    return;
  }
  if (current?.dataset.kind === kind) return;
  current?.remove();
  const badge = el("span", kind === "deaf" ? "badge deaf" : "badge");
  badge.dataset.kind = kind;
  badge.setAttribute("aria-hidden", "true");
  badge.innerHTML = kind === "deaf"
    ? '<svg viewBox="0 0 24 24"><path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-2v-7h4M4 13v5a2 2 0 0 0 2 2h2v-7H4M3 4l18 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  wrap.append(badge);
}

function facePx(count) {
  if (count <= 1) return 128;
  if (count <= 4) return 96;
  if (count <= 9) return 72;
  if (count <= 16) return 56;
  return 44;
}
function sendVolume(userId, volume) {
  return actPost({ type: "user-volume", userId, volume });
}

async function post(path, body) {
  try {
    const response = await fetch(BASE + path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
    if (!response.ok) return { ok: false, detail: "Bridge did not respond." };
    return await response.json();
  } catch (error) {
    showOffline();
    return { ok: false };
  }
}

function button(text, act, className) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.dataset.act = act;
  node.textContent = text;
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function initials(name) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.slice(0, 1)).join("").toUpperCase() || "?";
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, "");
}

function statusText(member) {
  if (member.speaking) return "speaking";
  if (member.serverDeaf || member.selfDeaf) return "deafened";
  if (member.serverMute) return "server muted";
  if (member.selfMute || member.localMute) return "muted";
  if (member.self) return "you";
  return member.volume + "%";
}

function faceColor(seed) {
  const colors = ["#8b97ff", "#3ddc8c", "#f0a35e", "#e06a9a", "#67c7e0", "#c7a0f0", "#e8c56a"];
  let hash = 0;
  for (const char of String(seed)) hash = (hash + char.charCodeAt(0) * 17) % colors.length;
  return colors[hash];
}
