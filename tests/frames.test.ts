import assert from "node:assert/strict";
import test from "node:test";
import { OPCODE, FrameDecoder, encodeFrame } from "../src/frames.ts";

test("round-trips a command frame", () => {
  const encoded = encodeFrame(OPCODE.FRAME, { cmd: "AUTHORIZE", nonce: "n1" });
  const frames = new FrameDecoder().push(encoded);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.opcode, OPCODE.FRAME);
  assert.deepEqual(frames[0]?.payload, { cmd: "AUTHORIZE", nonce: "n1" });
});

test("reassembles a frame split across chunks", () => {
  const encoded = encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: "123" });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3, 10)), []);
  const frames = decoder.push(encoded.subarray(10));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]?.payload, { v: 1, client_id: "123" });
});

test("reads two frames from one chunk", () => {
  const chunk = Buffer.concat([
    encodeFrame(OPCODE.PING, { n: 1 }),
    encodeFrame(OPCODE.FRAME, { cmd: "DISPATCH", evt: "SPEAKING_START" }),
  ]);
  const frames = new FrameDecoder().push(chunk);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.opcode, OPCODE.PING);
  assert.equal(frames[1]?.opcode, OPCODE.FRAME);
});
