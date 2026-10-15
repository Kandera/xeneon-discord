export const OPCODE = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
} as const;

const MAX_FRAME = 8_000_000;

export interface Frame {
  opcode: number;
  payload: unknown;
}

export function encodeFrame(opcode: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_FRAME) throw new Error("frame too large");
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > MAX_FRAME) throw new Error("frame too large");
      if (this.buffer.length < 8 + length) break;
      const json = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = Buffer.from(this.buffer.subarray(8 + length));
      frames.push({ opcode, payload: JSON.parse(json) as unknown });
    }
    if (this.buffer.length > MAX_FRAME) throw new Error("frame too large");
    return frames;
  }
}
