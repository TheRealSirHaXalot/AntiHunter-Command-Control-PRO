import { Transform, TransformCallback } from 'node:stream';

// MeshCore companion radio serial protocol (examples/companion_radio/MyMesh.cpp, BaseSerialInterface.h).
export const MC = {
  APP_TO_RADIO: 0x3c,
  RADIO_TO_APP: 0x3e,
  MAX_FRAME: 176,
  CMD_APP_START: 0x01,
  CMD_SEND_CHANNEL_TXT: 0x03,
  CMD_SYNC_NEXT: 0x0a,
  RESP_OK: 0x00,
  RESP_ERR: 0x01,
  RESP_SELF_INFO: 0x05,
  RESP_CONTACT_MSG: 0x07,
  RESP_CHANNEL_MSG: 0x08,
  RESP_NO_MORE: 0x0a,
  RESP_CONTACT_MSG_V3: 0x10,
  RESP_CHANNEL_MSG_V3: 0x11,
  RESP_CHANNEL_DATA: 0x1b,
  PUSH_MSG_WAITING: 0x83,
  SELF_INFO_NAME_OFS: 58,
  RADIO_TEXT_LEN: 160,
  DEFAULT_TEXT_CAP: 127,
} as const;

const SEND_HEADER_LEN = 7;

export class MeshcoreFrameParser extends Transform {
  private len = 0;
  private hdr = -1;
  private buf: number[] = [];

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    for (const byte of chunk) {
      if (this.hdr < 0) {
        if (byte === MC.RADIO_TO_APP) {
          this.hdr = 0;
          this.len = 0;
          this.buf = [];
        }
      } else if (this.hdr < 2) {
        this.len |= byte << (8 * this.hdr);
        this.hdr += 1;
        if (this.hdr === 2 && (this.len === 0 || this.len > MC.MAX_FRAME)) this.hdr = -1;
      } else {
        this.buf.push(byte);
        if (this.buf.length === this.len) {
          this.push(Buffer.from(this.buf));
          this.hdr = -1;
        }
      }
    }
    callback();
  }
}

export function encodeMeshcoreFrame(payload: Buffer): Buffer {
  const header = Buffer.from([MC.APP_TO_RADIO, payload.length & 0xff, payload.length >> 8]);
  return Buffer.concat([header, payload]);
}

export function meshcoreAppStart(appName: string): Buffer {
  return Buffer.concat([
    Buffer.from([MC.CMD_APP_START, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from(appName),
  ]);
}

export function meshcoreChannelText(channel: number, epochSec: number, text: Buffer): Buffer {
  const head = Buffer.alloc(SEND_HEADER_LEN);
  head[0] = MC.CMD_SEND_CHANNEL_TXT;
  head[1] = 0;
  head[2] = channel;
  head.writeUInt32LE(epochSec >>> 0, 3);
  return Buffer.concat([head, text]);
}

export function meshcoreTextCap(selfInfo: Buffer): number | undefined {
  if (selfInfo.length < MC.SELF_INFO_NAME_OFS) return undefined;
  const nameLen = selfInfo.length - MC.SELF_INFO_NAME_OFS;
  const cap = MC.RADIO_TEXT_LEN - (nameLen + 2);
  return Math.max(1, Math.min(cap, MC.MAX_FRAME - SEND_HEADER_LEN));
}

export const MESHCORE_CONT = ' +';

// A node ends a reply part cut at a space with " +" and repeats "<node>: " on the next part (fw meshcore_link.cpp meshcoreWriteText).
export class MeshcoreReplyJoiner {
  private readonly pending = new Map<string, { text: string; timer: NodeJS.Timeout }>();

  constructor(
    private readonly emit: (text: string) => void,
    private readonly holdMs = 10_000,
  ) {}

  push(text: string): void {
    const sep = text.indexOf(': ');
    const node = sep > 0 ? text.slice(0, sep) : '';
    const held = node ? this.pending.get(node) : undefined;
    let full = text;
    if (held) {
      clearTimeout(held.timer);
      this.pending.delete(node);
      full = `${held.text} ${text.slice(sep + 2)}`;
    }
    if (node && full.endsWith(MESHCORE_CONT)) {
      const body = full.slice(0, -MESHCORE_CONT.length);
      const timer = setTimeout(() => {
        this.pending.delete(node);
        this.emit(body);
      }, this.holdMs);
      timer.unref?.();
      this.pending.set(node, { text: body, timer });
      return;
    }
    this.emit(full);
  }

  flush(): void {
    const held = [...this.pending.values()];
    this.pending.clear();
    for (const part of held) {
      clearTimeout(part.timer);
      this.emit(part.text);
    }
  }
}

// The radio prepends "<sender radio name>: " to every channel message (BaseChatMesh.cpp sendGroupMessage).
export function meshcoreChannelMessage(
  frame: Buffer,
): { channel: number; text: string } | undefined {
  const v3 = frame[0] === MC.RESP_CHANNEL_MSG_V3;
  if (!v3 && frame[0] !== MC.RESP_CHANNEL_MSG) return undefined;
  const chOfs = v3 ? 4 : 1;
  const txtOfs = v3 ? 11 : 8;
  if (frame.length <= txtOfs) return undefined;
  let text = frame.subarray(txtOfs).toString('utf8');
  const sep = text.indexOf(': ');
  if (sep >= 0) text = text.slice(sep + 2);
  return { channel: frame[chOfs], text: text.trim() };
}
