import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { REDIRECT_URI, SCOPES } from "./constants.ts";
import { saveConfig, type Config } from "./config.ts";
import { OPCODE, encodeFrame, FrameDecoder, type Frame } from "./frames.ts";
import {
  applyChannel,
  applyChannels,
  applyGuilds,
  applySettings,
  applySpeaking,
  applyVoiceState,
  asRecord,
  nextSpeakingWait,
  blankModel,
  dismissNotice,
  dropMessage,
  patchMessage,
  pushMessage,
  pushNotice,
  setChatChannel,
  snapshot,
  snowflake,
  type ChatMessage,
  type Snapshot,
} from "./state.ts";

const VOICE_EVENTS = [
  "VOICE_STATE_CREATE",
  "VOICE_STATE_UPDATE",
  "VOICE_STATE_DELETE",
  "SPEAKING_START",
  "SPEAKING_STOP",
] as const;

const MESSAGE_EVENTS = ["MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE"] as const;

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}


export class Session {
  readonly model = blankModel();
  private readonly listeners = new Set<(snap: Snapshot) => void>();
  private config: Config;
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly avatars = new Map<string, { hash: string; bytes: Buffer; type: string }>();
  private ready = false;
  private stopped = false;
  private speakingTimer: NodeJS.Timeout | null = null;
  private looping = false;
  private allowPrompt = true;
  private watchedVoice: string | null = null;
  private watchedChat: string | null = null;
  private oauthState = "";
  private wake = (): void => {};

  constructor(config: Config) {
    this.config = config;
    this.model.configured = Boolean(config.clientId && config.clientSecret);
    this.model.clientId = config.clientId;
    this.model.micA = config.micA;
    this.model.micB = config.micB;
    this.model.phase = this.model.configured ? "discord-down" : "need-setup";
    this.model.detail = this.model.configured ? "Discord is not open." : "";
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

  start(): void {
    if (this.looping) return;
    this.looping = true;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.speakingTimer ?? undefined);
    this.speakingTimer = null;
    this.wake();
    this.rejectPending(new Error("stopped"));
  }

  async setup(input: { clientId: string; clientSecret: string }): Promise<{ ok: boolean; detail?: string }> {
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!/^\d{5,32}$/.test(clientId)) return { ok: false, detail: "Client ID is not a Discord application ID." };
    if (clientSecret.length < 8) return { ok: false, detail: "Client secret is missing." };
    this.config = {
      ...this.config,
      clientId,
      clientSecret,
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
    };
    saveConfig(this.config);
    this.model.configured = true;
    this.model.clientId = clientId;
    this.model.user = null;
    this.model.phase = "discord-down";
    this.model.detail = "Connecting to Discord…";
    this.emit();
    this.kick();
    return { ok: true };
  }

  async action(body: unknown): Promise<Record<string, unknown>> {
    const row = asRecord(body);
    if (!row || typeof row.type !== "string") return { ok: false, detail: "Unknown action." };
    try {
      switch (row.type) {
        case "authorize":
          this.kick();
          return { ok: true };
        case "browser-auth":
          this.openBrowserAuth();
          return { ok: true };
        case "clear":
          await this.clearCredentials();
          return { ok: true };
        case "mute":
          return await this.setVoice({ mute: !this.model.selfMute });
        case "deafen":
          return await this.setVoice({ deaf: !this.model.selfDeaf });
        case "leave":
          return await this.selectVoice(null, false);
        case "join": {
          const channelId = snowflake(row.channelId);
          if (!channelId) return { ok: false, detail: "Channel is missing." };
          return await this.selectVoice(channelId, row.force === true);
        }
        case "user-volume":
          return await this.setUserVolume(row);
        case "user-mute":
          return await this.setUserMute(row);
        case "input-device":
          return await this.setVoice({ input: { device_id: typeof row.deviceId === "string" ? row.deviceId : "" } });
        case "output-device":
          return await this.setVoice({ output: { device_id: typeof row.deviceId === "string" ? row.deviceId : "" } });
        case "switch-mic":
          return await this.switchMic();
        case "save-mics":
          return this.saveMics(row);
        case "channels": {
          const guildId = snowflake(row.guildId);
          if (!guildId) return { ok: false, detail: "Server is missing." };
          await this.loadChannels(guildId);
          this.emit();
          return { ok: true };
        }
        case "watch-chat": {
          const channelId = snowflake(row.channelId);
          if (!channelId) return { ok: false, detail: "Channel is missing." };
          await this.watchChat(channelId);
          return { ok: true };
        }
        case "dismiss":
          dismissNotice(this.model, typeof row.id === "string" ? row.id : "");
          this.emit();
          return { ok: true };
        default:
          return { ok: false, detail: "Unknown action." };
      }
    } catch (error) {
      const rpc = error instanceof RpcError ? error : null;
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "Action failed.",
        needsForce: rpc?.code === 5003,
      };
    }
  }

  async completeOauth(code: string, oauthState: string): Promise<boolean> {
    if (!code || !this.oauthState || oauthState !== this.oauthState) return false;
    this.oauthState = "";
    try {
      const tokens = await requestToken(this.config, new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }));
      this.storeTokens(tokens);
      if (this.ready) await this.afterToken();
      else this.kick();
      return true;
    } catch (error) {
      this.fail(error);
      return true;
    }
  }

  async avatar(id: string): Promise<{ bytes: Buffer; type: string } | null> {
    if (!/^\d{5,32}$/.test(id)) return null;
    const hash = this.model.members.get(id)?.avatar ?? (this.model.user?.id === id ? this.model.user.avatar : null);
    if (!hash) return null;
    const cached = this.avatars.get(id);
    if (cached?.hash === hash) return cached;
    const ext = hash.startsWith("a_") ? "gif" : "png";
    const response = await fetch(`https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=256`);
    if (!response.ok) return null;
    const stored = {
      hash,
      bytes: Buffer.from(await response.arrayBuffer()),
      type: ext === "gif" ? "image/gif" : "image/png",
    };
    this.avatars.set(id, stored);
    return stored;
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private scheduleSpeaking(): void {
    clearTimeout(this.speakingTimer ?? undefined);
    this.speakingTimer = null;
    const wait = nextSpeakingWait(this.model, Date.now());
    if (wait == null) return;
    this.speakingTimer = setTimeout(() => {
      this.speakingTimer = null;
      this.emit();
      this.scheduleSpeaking();
    }, wait);
  }

  private kick(): void {
    this.allowPrompt = true;
    this.socket?.destroy();
    this.wake();
    if (!this.looping) this.start();
  }

  private async clearCredentials(): Promise<void> {
    this.config = { ...this.config, clientSecret: "", accessToken: "", refreshToken: "", expiresAt: 0 };
    saveConfig(this.config);
    this.model.configured = false;
    this.model.clientId = this.config.clientId;
    this.model.phase = "need-setup";
    this.model.detail = "";
    this.model.user = null;
    this.socket?.destroy();
    this.emit();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (!this.config.clientId || !this.config.clientSecret) {
        if (this.model.phase !== "need-setup" || this.model.configured) {
          this.model.phase = "need-setup";
          this.model.configured = false;
          this.emit();
        }
        await this.sleep(400);
        continue;
      }
      try {
        await this.connectOnce();
      } catch (error) {
        if (this.stopped) return;
        if (this.model.phase !== "authorizing" && this.model.phase !== "error") {
          this.model.phase = "discord-down";
          this.model.detail = error instanceof Error ? error.message : "Discord is not open.";
          this.emit();
        }
      }
      if (!this.stopped) await this.sleep(2000);
    }
    this.looping = false;
  }

  private connectOnce(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    openPipe().then((socket) => {
      this.socket = socket;
      this.ready = false;
      this.decoder = new FrameDecoder();
      this.model.detail = "Discord found.";
      this.emit();
      socket.on("data", (chunk: Buffer) => {
        let frames: Frame[];
        try {
          frames = this.decoder.push(chunk);
        } catch (error) {
          this.fail(error);
          socket.destroy();
          return;
        }
        for (const frame of frames) this.onFrame(frame.opcode, frame.payload);
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        this.ready = false;
        this.socket = null;
        this.watchedVoice = null;
        this.rejectPending(new Error("Lost the connection to Discord."));
        resolve();
      });
      socket.write(encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: this.config.clientId }));
    }).catch(reject);
    return promise;
  }

  private onFrame(opcode: number, payload: unknown): void {
    if (opcode === OPCODE.PING) {
      this.socket?.write(encodeFrame(OPCODE.PONG, payload));
      return;
    }
    if (opcode === OPCODE.CLOSE) {
      this.socket?.destroy();
      return;
    }
    const row = asRecord(payload);
    if (opcode !== OPCODE.FRAME || !row) return;
    if (row.evt === "READY" && !this.ready) {
      void this.onReady();
      return;
    }
    const nonce = typeof row.nonce === "string" ? row.nonce : "";
    const waiting = nonce ? this.pending.get(nonce) : undefined;
    if (waiting) {
      this.pending.delete(nonce);
      clearTimeout(waiting.timer);
      if (row.evt === "ERROR") {
        const data = asRecord(row.data) ?? {};
        const code = typeof data.code === "number" ? data.code : 0;
        const message = typeof data.message === "string" ? data.message : "Discord error";
        waiting.reject(new RpcError(code, message));
      } else {
        waiting.resolve(row.data);
      }
      return;
    }
    if (row.cmd === "DISPATCH") this.onDispatch(typeof row.evt === "string" ? row.evt : "", row.data);
  }

  private async onReady(): Promise<void> {
    this.ready = true;
    try {
      if (await this.tryExistingToken()) return;
      if (!this.allowPrompt) {
        this.model.phase = "error";
        this.model.detail = "Not authorized. Tap Connect.";
        this.emit();
        return;
      }
      this.allowPrompt = false;
      await this.rpcAuthorize();
    } catch (error) {
      this.fail(error);
    }
  }

  private async tryExistingToken(): Promise<boolean> {
    try {
      if (this.config.accessToken && this.config.expiresAt > Date.now() + 60_000) {
        await this.afterToken();
        return true;
      }
      if (!this.config.refreshToken) return false;
      const tokens = await requestToken(this.config, new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken,
      }));
      this.storeTokens(tokens);
      await this.afterToken();
      return true;
    } catch (error) {
      this.config = { ...this.config, accessToken: "", refreshToken: "", expiresAt: 0 };
      saveConfig(this.config);
      this.model.detail = error instanceof Error ? error.message : "Token expired.";
      return false;
    }
  }

  private async rpcAuthorize(): Promise<void> {
    this.model.phase = "authorizing";
    this.model.detail = "Discord is asking for permission. Check its window.";
    this.emit();
    const data = await this.rpc("AUTHORIZE", { client_id: this.config.clientId, scopes: [...SCOPES] });
    const authorized = asRecord(data);
    const code = typeof authorized?.code === "string" ? authorized.code : "";
    if (!code) throw new Error("Discord did not send a code.");
    const tokens = await requestToken(this.config, new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }));
    this.storeTokens(tokens);
    await this.afterToken();
  }

  private openBrowserAuth(): void {
    if (!this.config.clientId || !this.config.clientSecret) {
      this.model.phase = "need-setup";
      this.model.detail = "Save a client ID and secret first.";
      this.emit();
      return;
    }
    this.oauthState = randomUUID();
    this.model.phase = "authorizing";
    this.model.detail = "Confirm in the browser.";
    this.emit();
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", this.oauthState);
    spawn("cmd", ["/c", "start", "", url.toString()], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  }

  private async afterToken(): Promise<void> {
    const data = await this.rpc("AUTHENTICATE", { access_token: this.config.accessToken });
    const user = asRecord(asRecord(data)?.user);
    if (user && typeof user.id === "string") {
      this.model.user = {
        id: user.id,
        name: typeof user.username === "string" ? user.username : "You",
        avatar: typeof user.avatar === "string" ? user.avatar : null,
      };
    }
    this.model.phase = "ready";
    this.model.detail = "";
    this.emit();
    await this.subscribeBasics();
    await this.sync();
  }

  private async subscribeBasics(): Promise<void> {
    for (const evt of ["VOICE_CHANNEL_SELECT", "VOICE_SETTINGS_UPDATE", "VOICE_CONNECTION_STATUS"]) {
      await this.rpc("SUBSCRIBE", undefined, evt);
    }
    try {
      await this.rpc("SUBSCRIBE", undefined, "NOTIFICATION_CREATE");
    } catch {
      this.model.detail = "Notifications are not enabled. Voice still works.";
    }
  }

  private async sync(): Promise<void> {
    applySettings(this.model, await this.rpc("GET_VOICE_SETTINGS"));
    applyChannel(this.model, await this.rpc("GET_SELECTED_VOICE_CHANNEL"), Date.now());
    await this.watchVoice(this.model.channelId);
    applyGuilds(this.model, await this.rpc("GET_GUILDS"));
    const guildId = this.model.guildId ?? this.model.guilds[0]?.id ?? null;
    if (guildId) await this.loadChannels(guildId);
    this.emit();
  }

  private async loadChannels(guildId: string): Promise<void> {
    applyChannels(this.model, guildId, await this.rpc("GET_CHANNELS", { guild_id: guildId }));
    this.keepCurrentVoiceChannel();
    await this.loadOccupants();
    const texts = this.model.channels.filter((channel) => channel.type === 0 || channel.type === 5);
    const text = texts.find((channel) => channel.name === "general") ?? texts[0];
    const watchingHere = texts.some((channel) => channel.id === this.model.chatChannelId);
    if (!watchingHere) {
      if (text) {
        try {
          await this.watchChat(text.id);
        } catch {
          this.model.chatError = "Chat is not available for this server.";
        }
      } else {
        await this.unwatchChat();
        setChatChannel(this.model, null, null);
        this.model.chatError = "Discord did not send this server's text channels. Mentions still show at the top.";
      }
    }
  }

  private keepCurrentVoiceChannel(): void {
    if (!this.model.channelId) return;
    if (this.model.channels.some((channel) => channel.id === this.model.channelId)) return;
    this.model.channels.unshift({
      id: this.model.channelId,
      name: this.model.channelName || "Voice",
      type: 2,
      guildId: this.model.guildId || "",
    });
  }

  private async loadOccupants(): Promise<void> {
    const voices = this.model.channels.filter((channel) => channel.type === 2 || channel.type === 13).slice(0, 12);
    for (const channel of voices) {
      if (channel.id === this.model.channelId) continue;
      try {
        const data = asRecord(await this.rpc("GET_CHANNEL", { channel_id: channel.id }));
        const states = Array.isArray(data?.voice_states) ? data.voice_states : [];
        const people = states.flatMap((state) => {
          const row = asRecord(state);
          const user = asRecord(row?.user);
          const id = typeof user?.id === "string" ? user.id : "";
          if (!id) return [];
          const name = typeof row?.nick === "string" && row.nick ? row.nick : typeof user?.username === "string" ? user.username : "Someone";
          return [{ id, name }];
        });
        this.model.occupants.set(channel.id, people);
      } catch {
        this.model.occupants.set(channel.id, []);
      }
    }
  }

  private async watchVoice(channelId: string | null): Promise<void> {
    if (this.watchedVoice === channelId) return;
    const previous = this.watchedVoice;
    this.watchedVoice = channelId;
    if (previous) {
      for (const evt of VOICE_EVENTS) {
        try {
          await this.rpc("UNSUBSCRIBE", { channel_id: previous }, evt);
        } catch {
          /* already gone */
        }
      }
    }
    if (!channelId) return;
    for (const evt of VOICE_EVENTS) await this.rpc("SUBSCRIBE", { channel_id: channelId }, evt);
  }

  private async unwatchChat(): Promise<void> {
    if (!this.watchedChat) return;
    const previous = this.watchedChat;
    this.watchedChat = null;
    for (const evt of MESSAGE_EVENTS) {
      try {
        await this.rpc("UNSUBSCRIBE", { channel_id: previous }, evt);
      } catch {
        /* already gone */
      }
    }
  }

  private async watchChat(channelId: string): Promise<void> {
    const known = this.model.channels.find((channel) => channel.id === channelId);
    if (this.watchedChat && this.watchedChat !== channelId) await this.unwatchChat();
    setChatChannel(this.model, channelId, known?.name ?? null);
    this.watchedChat = channelId;
    for (const evt of MESSAGE_EVENTS) await this.rpc("SUBSCRIBE", { channel_id: channelId }, evt);
    await this.loadHistory(channelId);
    this.emit();
  }

  private async loadHistory(channelId: string): Promise<void> {
    if (!this.config.accessToken) {
      this.model.history = "unavailable";
      return;
    }
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=20`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (!response.ok) {
      this.model.history = "unavailable";
      this.model.chatError = response.status === 401 || response.status === 403
        ? "History is not readable. New messages still arrive if Discord allows them."
        : `History ${response.status}`;
      return;
    }
    const list = await response.json() as unknown;
    if (!Array.isArray(list)) return;
    for (const item of list.reverse()) {
      const message = chatMessage(item);
      if (message) pushMessage(this.model, message);
    }
    this.model.history = "loaded";
    this.model.chatError = "";
  }

  private async selectVoice(channelId: string | null, force: boolean): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { channel_id: channelId };
    if (force) args.force = true;
    const data = await this.rpc("SELECT_VOICE_CHANNEL", args);
    applyChannel(this.model, data, Date.now());
    await this.watchVoice(this.model.channelId);
    this.emit();
    return { ok: true };
  }

  private async setVoice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    applySettings(this.model, await this.rpc("SET_VOICE_SETTINGS", args));
    this.emit();
    return { ok: true };
  }

  private async switchMic(): Promise<Record<string, unknown>> {
    const { micA, micB } = this.model;
    if (!micA || !micB) return { ok: false, detail: "Choose two microphones first." };
    const next = this.model.settings.inputDeviceId === micA ? micB : micA;
    return await this.setVoice({ input: { device_id: next } });
  }

  private saveMics(row: Record<string, unknown>): Record<string, unknown> {
    const a = typeof row.a === "string" ? row.a : "";
    const b = typeof row.b === "string" ? row.b : "";
    if (!a || !b || a === b) return { ok: false, detail: "Pick two different microphones." };
    this.config = { ...this.config, micA: a, micB: b };
    saveConfig(this.config);
    this.model.micA = a;
    this.model.micB = b;
    this.emit();
    return { ok: true };
  }

  private async setUserVolume(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = snowflake(body.userId);
    const volume = typeof body.volume === "number" ? Math.round(body.volume) : NaN;
    if (!userId || volume < 0 || volume > 200) return { ok: false, detail: "Volume is invalid." };
    await this.rpc("SET_USER_VOICE_SETTINGS", { user_id: userId, volume });
    const member = this.model.members.get(userId);
    if (member) member.volume = volume;
    this.emit();
    return { ok: true };
  }

  private async setUserMute(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = snowflake(body.userId);
    if (!userId) return { ok: false, detail: "User is missing." };
    const member = this.model.members.get(userId);
    const mute = typeof body.mute === "boolean" ? body.mute : !(member?.localMute ?? false);
    await this.rpc("SET_USER_VOICE_SETTINGS", { user_id: userId, mute });
    if (member) member.localMute = mute;
    this.emit();
    return { ok: true };
  }

  private async refreshChannel(): Promise<void> {
    applyChannel(this.model, await this.rpc("GET_SELECTED_VOICE_CHANNEL"), Date.now());
    await this.watchVoice(this.model.channelId);
    if (this.model.guildId) {
      const known = this.model.guilds.find((guild) => guild.id === this.model.guildId);
      if (known) this.model.guildName = known.name;
      if (this.model.activeGuildId !== this.model.guildId) await this.loadChannels(this.model.guildId);
    }
  }

  private onDispatch(evt: string, data: unknown): void {
    const now = Date.now();
    if (evt === "VOICE_CHANNEL_SELECT") {
      void this.refreshChannel().then(() => this.emit()).catch((error: unknown) => this.fail(error));
      return;
    }
    if (evt === "VOICE_STATE_CREATE" || evt === "VOICE_STATE_UPDATE" || evt === "VOICE_STATE_DELETE") {
      applyVoiceState(this.model, evt, data);
    } else if (evt === "SPEAKING_START" || evt === "SPEAKING_STOP") {
      const speaking = asRecord(data);
      applySpeaking(this.model, evt, typeof speaking?.user_id === "string" ? speaking.user_id : "", now);
      this.scheduleSpeaking();
    } else if (evt === "VOICE_SETTINGS_UPDATE") {
      applySettings(this.model, data);
    } else if (evt === "VOICE_CONNECTION_STATUS") {
      const status = asRecord(data);
      this.model.connection = typeof status?.state === "string" ? status.state : "";
    } else if (evt === "NOTIFICATION_CREATE") {
      this.onNotice(data);
    } else if (evt === "MESSAGE_CREATE" || evt === "MESSAGE_UPDATE" || evt === "MESSAGE_DELETE") {
      this.onMessage(evt, data);
    } else {
      return;
    }
    this.emit();
  }

  private onNotice(data: unknown): void {
    const row = asRecord(data) ?? {};
    const message = asRecord(row.message) ?? {};
    const id = typeof message.id === "string" ? message.id : randomUUID();
    pushNotice(this.model, {
      id,
      channelId: typeof row.channel_id === "string" ? row.channel_id : "",
      title: typeof row.title === "string" ? row.title : "Discord",
      body: typeof row.body === "string" ? row.body : typeof message.content === "string" ? message.content : "",
      at: Date.now(),
    });
  }

  private onMessage(evt: string, data: unknown): void {
    const row = asRecord(data) ?? {};
    const channelId = typeof row.channel_id === "string" ? row.channel_id : this.model.chatChannelId;
    if (channelId && this.model.chatChannelId && channelId !== this.model.chatChannelId) return;
    const raw = asRecord(row.message) ?? row;
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!id) return;
    if (evt === "MESSAGE_DELETE") {
      dropMessage(this.model, id);
      return;
    }
    const message = chatMessage(raw);
    if (!message) return;
    if (evt === "MESSAGE_UPDATE") patchMessage(this.model, message);
    else pushMessage(this.model, message);
  }

  private rpc(cmd: string, args?: Record<string, unknown>, evt?: string): Promise<unknown> {
    if (!this.socket || !this.ready) return Promise.reject(new Error("Discord is not connected."));
    const nonce = randomUUID();
    const payload: Record<string, unknown> = { cmd, nonce };
    if (args && Object.keys(args).length > 0) payload.args = args;
    if (evt) payload.evt = evt;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(nonce);
      reject(new Error(`${cmd} timed out`));
    }, cmd === "AUTHORIZE" ? 120_000 : 12_000);
    this.pending.set(nonce, { resolve, reject, timer });
    this.socket.write(encodeFrame(OPCODE.FRAME, payload));
    return promise;
  }

  private storeTokens(tokens: TokenResponse): void {
    this.config = {
      ...this.config,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || this.config.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    saveConfig(this.config);
  }

  private fail(error: unknown): void {
    this.model.phase = "error";
    this.model.detail = error instanceof Error ? error.message : "Discord error";
    this.emit();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    this.wake = () => {
      clearTimeout(timer);
      resolve();
    };
    return promise;
  }
}

function chatMessage(raw: unknown): ChatMessage | null {
  const row = asRecord(raw);
  if (!row || typeof row.id !== "string") return null;
  const author = asRecord(row.author) ?? {};
  return {
    id: row.id,
    author: typeof author.username === "string" ? author.username : "Someone",
    content: typeof row.content === "string" ? row.content : "",
    at: typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString(),
  };
}

async function requestToken(config: Config, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 280) || `Token ${response.status}`);
  const data = JSON.parse(text) as Partial<TokenResponse>;
  if (!data.access_token || typeof data.expires_in !== "number") throw new Error("Discord did not send a token.");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

function openPipe(): Promise<net.Socket> {
  const paths: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    paths.push(`\\\\.\\pipe\\discord-ipc-${index}`, `\\\\?\\pipe\\discord-ipc-${index}`);
  }
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  let index = 0;
  const next = (): void => {
    if (index >= paths.length) {
      reject(new Error("Discord is not open."));
      return;
    }
    const path = paths[index];
    index += 1;
    const socket = net.connect(path);
    const fail = (): void => {
      socket.removeListener("connect", ok);
      socket.destroy();
      next();
    };
    const ok = (): void => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      resolve(socket);
    };
    const timer = setTimeout(fail, 350);
    socket.once("error", fail);
    socket.once("connect", ok);
  };
  next();
  return promise;
}
