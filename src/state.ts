export type Phase = "need-setup" | "discord-down" | "authorizing" | "ready" | "error";

export interface Member {
  id: string;
  name: string;
  avatar: string | null;
  volume: number;
  localMute: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  speaking: boolean;
  bot: boolean;
}

export interface Device {
  id: string;
  name: string;
}

export interface Notice {
  id: string;
  channelId: string;
  title: string;
  body: string;
  at: number;
}

export interface ChatMessage {
  id: string;
  author: string;
  content: string;
  at: string;
}

export interface ChannelRef {
  id: string;
  name: string;
  type: number;
  guildId: string;
  people?: { id: string; name: string }[];
}

export interface Settings {
  mute: boolean;
  deaf: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  automaticGainControl: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  inputDevices: Device[];
  outputDevices: Device[];
}

export interface Model {
  phase: Phase;
  detail: string;
  configured: boolean;
  clientId: string;
  user: { id: string; name: string; avatar: string | null } | null;
  channelId: string | null;
  channelName: string | null;
  guildId: string | null;
  guildName: string | null;
  connection: string;
  selfMute: boolean;
  selfDeaf: boolean;
  since: number | null;
  members: Map<string, Member>;
  speakingUntil: Map<string, number>;
  settings: Settings;
  guilds: { id: string; name: string }[];
  channels: ChannelRef[];
  occupants: Map<string, { id: string; name: string }[]>;
  activeGuildId: string | null;
  notifications: Notice[];
  chatChannelId: string | null;
  chatChannelName: string | null;
  messages: ChatMessage[];
  history: "live" | "loaded" | "unavailable";
  chatError: string;
}

export interface Snapshot {
  ok: true;
  phase: Phase;
  detail: string;
  configured: boolean;
  clientId: string;
  user: Model["user"];
  voice: {
    channelId: string | null;
    channelName: string | null;
    guildId: string | null;
    guildName: string | null;
    connection: string;
    selfMute: boolean;
    selfDeaf: boolean;
    since: number | null;
    members: Array<Member & { self: boolean }>;
  };
  settings: Settings;
  guilds: { id: string; name: string }[];
  channels: ChannelRef[];
  activeGuildId: string | null;
  notifications: Notice[];
  chat: {
    channelId: string | null;
    channelName: string | null;
    messages: ChatMessage[];
    history: Model["history"];
    error: string;
  };
}

const SPEAKING_HOLD_MS = 2200;
const NOTICE_CAP = 6;
const MESSAGE_CAP = 40;

export function blankSettings(): Settings {
  return {
    mute: false,
    deaf: false,
    noiseSuppression: false,
    echoCancellation: false,
    automaticGainControl: false,
    inputDeviceId: "",
    outputDeviceId: "",
    inputDevices: [],
    outputDevices: [],
  };
}

export function blankModel(): Model {
  return {
    phase: "need-setup",
    detail: "",
    configured: false,
    clientId: "",
    user: null,
    channelId: null,
    channelName: null,
    guildId: null,
    guildName: null,
    connection: "",
    selfMute: false,
    selfDeaf: false,
    since: null,
    members: new Map(),
    speakingUntil: new Map(),
    settings: blankSettings(),
    guilds: [],
    channels: [],
    occupants: new Map(),
    activeGuildId: null,
    notifications: [],
    chatChannelId: null,
    chatChannelName: null,
    messages: [],
    history: "live",
    chatError: "",
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function memberFromVoice(raw: unknown): Member | null {
  const row = asRecord(raw);
  if (!row) return null;
  const user = asRecord(row.user);
  const id = text(user?.id) || text(row.user_id);
  if (!id) return null;
  const voice = asRecord(row.voice_state);
  const username = text(user?.username) || "Unknown";
  const nick = text(row.nick);
  return {
    id,
    name: nick || username,
    avatar: text(user?.avatar) || null,
    volume: Math.max(0, Math.min(200, Math.round(num(row.volume, 100)))),
    localMute: bool(row.mute),
    selfMute: bool(voice?.self_mute),
    selfDeaf: bool(voice?.self_deaf),
    serverMute: bool(voice?.mute),
    serverDeaf: bool(voice?.deaf),
    speaking: false,
    bot: bool(user?.bot),
  };
}

export function applyChannel(model: Model, data: unknown, now: number): void {
  const channel = asRecord(data);
  if (!channel || !text(channel.id)) {
    model.channelId = null;
    model.channelName = null;
    model.guildId = null;
    model.since = null;
    model.members.clear();
    model.speakingUntil.clear();
    return;
  }
  const nextId = text(channel.id);
  if (model.channelId !== nextId) {
    model.since = now;
    model.speakingUntil.clear();
  }
  model.channelId = nextId;
  model.channelName = text(channel.name) || model.channelName;
  model.guildId = text(channel.guild_id) || null;
  if (model.guildId) {
    const known = model.guilds.find((guild) => guild.id === model.guildId);
    if (known) model.guildName = known.name;
    model.activeGuildId = model.guildId;
  }
  const states = Array.isArray(channel.voice_states) ? channel.voice_states : [];
  const next = new Map<string, Member>();
  for (const state of states) {
    const member = memberFromVoice(state);
    if (!member) continue;
    const until = model.speakingUntil.get(member.id) ?? 0;
    member.speaking = model.members.get(member.id)?.speaking === true && until > now;
    next.set(member.id, member);
  }
  model.members = next;
}

export function applyVoiceState(model: Model, event: string, data: unknown): void {
  const member = memberFromVoice(data);
  if (!member) return;
  if (event === "VOICE_STATE_DELETE") {
    model.members.delete(member.id);
    model.speakingUntil.delete(member.id);
    return;
  }
  const until = model.speakingUntil.get(member.id) ?? 0;
  member.speaking = model.members.get(member.id)?.speaking === true && until > Date.now();
  model.members.set(member.id, member);
  if (model.user && member.id === model.user.id) {
    model.selfMute = member.selfMute;
    model.selfDeaf = member.selfDeaf;
    model.settings.mute = member.selfMute;
    model.settings.deaf = member.selfDeaf;
  }
}

export function applySpeaking(model: Model, event: string, userId: string, now: number): void {
  if (!userId) return;
  const member = model.members.get(userId);
  if (event === "SPEAKING_START") {
    model.speakingUntil.set(userId, now + SPEAKING_HOLD_MS);
    if (member) member.speaking = true;
    return;
  }
  model.speakingUntil.delete(userId);
  if (member) member.speaking = false;
}

export function applySettings(model: Model, data: unknown): void {
  const row = asRecord(data);
  if (!row) return;
  const input = asRecord(row.input);
  const output = asRecord(row.output);
  model.settings = {
    mute: bool(row.mute),
    deaf: bool(row.deaf),
    noiseSuppression: bool(row.noise_suppression),
    echoCancellation: bool(row.echo_cancellation),
    automaticGainControl: bool(row.automatic_gain_control),
    inputDeviceId: text(input?.device_id),
    outputDeviceId: text(output?.device_id),
    inputDevices: devices(input?.available_devices),
    outputDevices: devices(output?.available_devices),
  };
  model.selfMute = model.settings.mute;
  model.selfDeaf = model.settings.deaf;
}

function devices(value: unknown): Device[] {
  if (!Array.isArray(value)) return [];
  const list: Device[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row || !text(row.id)) continue;
    list.push({ id: text(row.id), name: text(row.name) || text(row.id) });
  }
  return list;
}

export function applyGuilds(model: Model, data: unknown): void {
  const row = asRecord(data);
  const list = Array.isArray(data) ? data : row && Array.isArray(row.guilds) ? row.guilds : [];
  model.guilds = list.flatMap((item) => {
    const guild = asRecord(item);
    if (!guild || !text(guild.id)) return [];
    return [{ id: text(guild.id), name: text(guild.name) || "Server" }];
  });
  if (model.guildId) {
    const known = model.guilds.find((guild) => guild.id === model.guildId);
    if (known) model.guildName = known.name;
  }
}

export function applyChannels(model: Model, guildId: string, data: unknown): void {
  const row = asRecord(data);
  const list = Array.isArray(data) ? data : row && Array.isArray(row.channels) ? row.channels : [];
  model.activeGuildId = guildId;
  model.channels = list.flatMap((item) => {
    const channel = asRecord(item);
    const id = text(channel?.id);
    if (!channel || !id) return [];
    return [{
      id,
      name: text(channel.name) || "Channel",
      type: num(channel.type, 0),
      guildId,
    }];
  });
}

export function pushNotice(model: Model, notice: Notice): void {
  model.notifications = [notice, ...model.notifications.filter((item) => item.id !== notice.id)].slice(0, NOTICE_CAP);
}

export function dismissNotice(model: Model, id: string): void {
  model.notifications = model.notifications.filter((item) => item.id !== id);
}

export function setChatChannel(model: Model, channelId: string | null, name: string | null): void {
  if (model.chatChannelId === channelId) {
    if (name) model.chatChannelName = name;
    return;
  }
  model.chatChannelId = channelId;
  model.chatChannelName = name;
  model.messages = [];
  model.history = "live";
  model.chatError = "";
}

export function pushMessage(model: Model, message: ChatMessage): void {
  if (model.messages.some((item) => item.id === message.id)) return;
  model.messages = [...model.messages, message].slice(-MESSAGE_CAP);
}

export function patchMessage(model: Model, message: ChatMessage): void {
  const index = model.messages.findIndex((item) => item.id === message.id);
  if (index < 0) {
    pushMessage(model, message);
    return;
  }
  const next = model.messages.slice();
  next[index] = message;
  model.messages = next;
}

export function dropMessage(model: Model, id: string): void {
  model.messages = model.messages.filter((item) => item.id !== id);
}

export function snapshot(model: Model, now: number): Snapshot {
  const members = [...model.members.values()].map((member) => {
    const until = model.speakingUntil.get(member.id);
    const speaking = member.speaking && (until === undefined || until > now);
    return { ...member, speaking, self: model.user?.id === member.id };
  });
  members.sort((a, b) => {
    if (a.speaking !== b.speaking) return a.speaking ? -1 : 1;
    if (a.self !== b.self) return a.self ? -1 : 1;
    return a.name.localeCompare(b.name, "de");
  });
  return {
    ok: true,
    phase: model.phase,
    detail: model.detail,
    configured: model.configured,
    clientId: model.clientId,
    user: model.user,
    voice: {
      channelId: model.channelId,
      channelName: model.channelName,
      guildId: model.guildId,
      guildName: model.guildName,
      connection: model.connection,
      selfMute: model.selfMute,
      selfDeaf: model.selfDeaf,
      since: model.since,
      members,
    },
    settings: model.settings,
    guilds: model.guilds,
    channels: model.channels.map((channel) => ({
      ...channel,
      people: channel.id === model.channelId
        ? members.map((member) => ({ id: member.id, name: member.name }))
        : model.occupants.get(channel.id) ?? [],
    })),
    activeGuildId: model.activeGuildId,
    notifications: model.notifications,
    chat: {
      channelId: model.chatChannelId,
      channelName: model.chatChannelName,
      messages: model.messages,
      history: model.history,
      error: model.chatError,
    },
  };
}

export function snowflake(value: unknown): string | null {
  return typeof value === "string" && /^\d{5,32}$/.test(value) ? value : null;
}
