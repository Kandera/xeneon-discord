import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChannel,
  applyChannels,
  applySpeaking,
  applyVoiceState,
  blankModel,
  pushNotice,
  selectedChannelId,
  shouldFollowVoice,
  snapshot,
} from "../src/state.ts";

const channel = {
  id: "10",
  name: "Einsatz",
  guild_id: "1",
  voice_states: [
    {
      nick: "Mira",
      volume: 140,
      mute: false,
      user: { id: "2", username: "mira", avatar: "abc" },
      voice_state: { self_mute: false, self_deaf: false, mute: false, deaf: false },
    },
    {
      nick: "",
      volume: 100,
      mute: true,
      user: { id: "3", username: "jonas", avatar: null },
      voice_state: { self_mute: true, self_deaf: false, mute: true, deaf: false },
    },
  ],
};

test("channel snapshot keeps nick, volume, and local mute apart from server mute", () => {
  const model = blankModel();
  applyChannel(model, channel, 1_000);
  const snap = snapshot(model, 1_000);
  assert.equal(snap.voice.channelName, "Einsatz");
  assert.equal(snap.voice.since, 1_000);
  const mira = snap.voice.members.find((member) => member.id === "2");
  const jonas = snap.voice.members.find((member) => member.id === "3");
  assert.equal(mira?.name, "Mira");
  assert.equal(mira?.volume, 140);
  assert.equal(mira?.localMute, false);
  assert.equal(jonas?.name, "jonas");
  assert.equal(jonas?.localMute, true);
  assert.equal(jonas?.serverMute, true);
  assert.equal(jonas?.selfMute, true);
});

test("leaving the channel clears the roster and does not keep the old timer", () => {
  const model = blankModel();
  applyChannel(model, channel, 1_000);
  applyChannel(model, null, 2_000);
  const snap = snapshot(model, 2_000);
  assert.equal(snap.voice.channelId, null);
  assert.equal(snap.voice.since, null);
  assert.equal(snap.voice.members.length, 0);
});

test("a missed speaking-stop expires instead of sticking", () => {
  const model = blankModel();
  applyChannel(model, channel, 1_000);
  applySpeaking(model, "SPEAKING_START", "2", 5_000);
  assert.equal(snapshot(model, 5_100).voice.members.find((member) => member.id === "2")?.speaking, true);
  assert.equal(snapshot(model, 6_000).voice.members.find((member) => member.id === "2")?.speaking, true);
  assert.equal(snapshot(model, 8_000).voice.members.find((member) => member.id === "2")?.speaking, false);
});

test("a stopped blip does not stay lit or jump ahead", () => {
  const model = blankModel();
  applyChannel(model, channel, 1_000);
  const order = snapshot(model, 1_900).voice.members.map((member) => member.id);
  applySpeaking(model, "SPEAKING_START", "2", 2_000);
  applySpeaking(model, "SPEAKING_STOP", "2", 2_400);
  const snap = snapshot(model, 2_400);
  assert.equal(snap.voice.members.find((member) => member.id === "2")?.speaking, false);
  assert.deepEqual(snap.voice.members.map((member) => member.id), order);
});

test("speech lights immediately and stays in place", () => {
  const model = blankModel();
  applyChannel(model, channel, 1_000);
  const order = snapshot(model, 1_900).voice.members.map((member) => member.id);
  applySpeaking(model, "SPEAKING_START", "3", 2_000);
  const shown = snapshot(model, 2_000);
  assert.equal(shown.voice.members.find((member) => member.id === "3")?.speaking, true);
  assert.deepEqual(shown.voice.members.map((member) => member.id), order);
  applySpeaking(model, "SPEAKING_STOP", "3", 2_200);
  assert.equal(snapshot(model, 2_200).voice.members.find((member) => member.id === "3")?.speaking, false);
});

test("voice delete removes the person and their speaking flag", () => {
  const model = blankModel();
  applyChannel(model, channel, 1_000);
  applySpeaking(model, "SPEAKING_START", "2", 1_000);
  applyVoiceState(model, "VOICE_STATE_DELETE", { user: { id: "2", username: "mira" } });
  const snap = snapshot(model, 1_100);
  assert.equal(snap.voice.members.some((member) => member.id === "2"), false);
});

test("joining voice does not claim that server's channel list is loaded", () => {
  const model = blankModel();
  applyChannels(model, "9", { channels: [{ id: "8", name: "welcome", type: 0 }] });
  applyChannel(model, channel, 1_000);
  assert.equal(model.guildId, "1");
  assert.equal(model.activeGuildId, "9");
  assert.equal(model.channels[0]?.name, "welcome");
});

test("notices keep the newest six", () => {
  const model = blankModel();
  for (let index = 0; index < 8; index += 1) {
    pushNotice(model, { id: String(index), channelId: "9", title: "t", body: String(index), at: index });
  }
  const ids = snapshot(model, 0).notifications.map((notice) => notice.id);
  assert.deepEqual(ids, ["7", "6", "5", "4", "3", "2"]);
});

test("a drag or a self leave follows the selected channel, another person leaving does not", () => {
  assert.equal(shouldFollowVoice("VOICE_CHANNEL_SELECT", { channel_id: "20" }, "1", "VOICE_CONNECTED"), true);
  assert.equal(shouldFollowVoice("VOICE_STATE_DELETE", { user: { id: "1" } }, "1", "VOICE_CONNECTED"), true);
  assert.equal(shouldFollowVoice("VOICE_STATE_DELETE", { user_id: "2" }, "1", "VOICE_CONNECTED"), false);
  assert.equal(shouldFollowVoice("VOICE_CONNECTION_STATUS", { state: "VOICE_CONNECTED" }, "1", "VOICE_CONNECTING"), true);
  assert.equal(shouldFollowVoice("VOICE_CONNECTION_STATUS", { state: "VOICE_CONNECTED" }, "1", "VOICE_CONNECTED"), false);
  assert.equal(selectedChannelId({ channel_id: "20" }), "20");
  assert.equal(selectedChannelId({ channel_id: null }), null);
  assert.equal(selectedChannelId({}), undefined);
});
