import {
  applyChannel,
  applyChannels,
  applyGuilds,
  applySpeaking,
  asRecord,
  blankModel,
  dismissNotice,
  pushNotice,
  setChatChannel,
  snapshot,
  type Snapshot,
} from "./state.ts";

const GUILD = "100000000000000001";
const VOICE = "100000000000000010";
const LOBBY = "100000000000000011";
const TEXT = "100000000000000020";

export class DemoBridge {
  private readonly model = blankModel();
  private readonly listeners = new Set<(snap: Snapshot) => void>();
  private readonly speakerIds = ["200000000000000002", "200000000000000003", "200000000000000004"];
  private speaker = 0;
  private timer: NodeJS.Timeout;

  constructor() {
    this.model.phase = "ready";
    this.model.configured = true;
    this.model.clientId = "demo";
    this.model.user = { id: "200000000000000001", name: "You", avatar: null };
    this.model.detail = "";
    applyGuilds(this.model, { guilds: [{ id: GUILD, name: "Night Run" }, { id: "100000000000000002", name: "Workshop" }] });
    applyChannels(this.model, GUILD, {
      channels: [
        { id: VOICE, name: "Ops", type: 2 },
        { id: LOBBY, name: "Lobby", type: 2 },
        { id: TEXT, name: "ops", type: 0 },
      ],
    });
    applyChannel(this.model, {
      id: VOICE,
      name: "Ops",
      guild_id: GUILD,
      voice_states: [
        voice("200000000000000001", "You", false),
        voice("200000000000000002", "Mira", false),
        voice("200000000000000003", "Jonas", true),
        voice("200000000000000004", "Ade", false),
        voice("200000000000000005", "Noor", false),
      ],
    }, Date.now() - 754_000);
    this.model.guildName = "Night Run";
    this.model.settings.inputDevices = [{ id: "default", name: "Microphone" }, { id: "headset", name: "Headset" }];
    this.model.settings.outputDevices = [{ id: "default", name: "Speakers" }, { id: "headset", name: "Headset" }];
    this.model.settings.inputDeviceId = "default";
    this.model.settings.outputDeviceId = "headset";
    setChatChannel(this.model, TEXT, "ops");
    this.model.messages = [
      { id: "m1", author: "Mira", content: "On the way to the boss.", at: new Date().toISOString() },
      { id: "m2", author: "Jonas", content: "Waiting at the bridge.", at: new Date().toISOString() },
    ];
    this.model.history = "loaded";
    pushNotice(this.model, {
      id: "n1",
      channelId: TEXT,
      title: "Mira",
      body: "come to Ops",
      at: Date.now(),
    });
    applySpeaking(this.model, "SPEAKING_START", this.speakerIds[0] ?? "", Date.now());
    this.timer = setInterval(() => this.rotate(), 1400);
  }

  snapshot(): Snapshot {
    return snapshot(this.model, Date.now());
  }
  subscribe(listener: (snap: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setup(): Promise<{ ok: boolean; detail?: string }> {
    this.model.configured = true;
    this.model.phase = "ready";
    this.emit();
    return { ok: true };
  }

  async action(body: unknown): Promise<Record<string, unknown>> {
    const row = asRecord(body) ?? {};
    const type = typeof row.type === "string" ? row.type : "";
    if (type === "mute") this.model.selfMute = !this.model.selfMute;
    if (type === "deafen") {
      this.model.selfDeaf = !this.model.selfDeaf;
      if (this.model.selfDeaf) this.model.selfMute = true;
    }
    if (type === "leave") applyChannel(this.model, null, Date.now());
    if (type === "join" && row.channelId === LOBBY) {
      applyChannel(this.model, {
        id: LOBBY,
        name: "Lobby",
        guild_id: GUILD,
        voice_states: [voice("200000000000000001", "You", false)],
      }, Date.now());
    }
    if (type === "join" && row.channelId === VOICE && row.force !== true && this.model.channelId === LOBBY) {
      return { ok: false, needsForce: true, detail: "You are already in a voice channel." };
    }
    if (type === "join" && row.channelId === VOICE && (row.force === true || this.model.channelId !== LOBBY)) {
      applyChannel(this.model, {
        id: VOICE,
        name: "Ops",
        guild_id: GUILD,
        voice_states: [voice("200000000000000001", "You", false), voice("200000000000000002", "Mira", false)],
      }, Date.now());
    }
    if (type === "user-volume" && typeof row.userId === "string" && typeof row.volume === "number") {
      const member = this.model.members.get(row.userId);
      if (member) member.volume = Math.max(0, Math.min(200, Math.round(row.volume)));
    }
    if (type === "user-mute" && typeof row.userId === "string") {
      const member = this.model.members.get(row.userId);
      if (member) member.localMute = typeof row.mute === "boolean" ? row.mute : !member.localMute;
    }
    if (type === "dismiss" && typeof row.id === "string") dismissNotice(this.model, row.id);
    if (type === "watch-chat") setChatChannel(this.model, TEXT, "ops");
    if (type === "clear") {
      this.model.phase = "need-setup";
      this.model.configured = false;
    }
    this.model.settings.mute = this.model.selfMute;
    this.model.settings.deaf = this.model.selfDeaf;
    this.emit();
    return { ok: true };
  }

  async avatar(): Promise<null> {
    return null;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private rotate(): void {
    const previous = this.speakerIds[this.speaker] ?? "";
    applySpeaking(this.model, "SPEAKING_STOP", previous, Date.now());
    this.speaker = (this.speaker + 1) % this.speakerIds.length;
    applySpeaking(this.model, "SPEAKING_START", this.speakerIds[this.speaker] ?? "", Date.now());
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}

function voice(id: string, name: string, selfMute: boolean): Record<string, unknown> {
  return {
    nick: name,
    volume: name === "Jonas" ? 80 : 100,
    mute: false,
    user: { id, username: name, avatar: null, bot: false },
    voice_state: { self_mute: selfMute, self_deaf: false, mute: false, deaf: false },
  };
}
