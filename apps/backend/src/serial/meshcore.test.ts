import { validateSync } from 'class-validator';
import assert from 'node:assert/strict';

import { UpdateSerialConfigDto } from './dto/update-serial-config.dto';
import {
  encodeMeshcoreFrame,
  MC,
  MeshcoreFrameParser,
  MeshcoreReplyJoiner,
} from './meshcore-frame-parser';
import { SerialService } from './serial.service';
import { SerialParseResult } from './serial.types';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const channelMsg = (channel: number, text: string) =>
  Buffer.concat([
    Buffer.from([MC.RESP_CHANNEL_MSG, channel, 0xff, 0, 1, 2, 3, 4]),
    Buffer.from(text),
  ]);

async function main() {
  const written: Buffer[] = [];
  const fakePort = {
    isOpen: true,
    write: (buffer: Buffer, cb: (error?: Error | null) => void) => {
      written.push(Buffer.from(buffer));
      cb(null);
    },
    drain: (cb: (error?: Error | null) => void) => cb(null),
  };
  const service = new SerialService(
    { get: (_key: string, fallback?: unknown) => fallback } as never,
    {} as never,
  );
  const internals = service as unknown as {
    port?: unknown;
    connectionOptions?: { sendMode?: string };
    meshcoreCap: number;
    handleMeshcoreFrame(frame: Buffer): void;
    sendMeshcoreCommand(line: string): Promise<void>;
  };
  internals.port = fakePort;
  internals.connectionOptions = { sendMode: 'meshcore' };
  const parsed: SerialParseResult[] = [];
  service.getParsedStream().subscribe((event) => parsed.push(event));
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  console.log('meshcore');
  await test('config DTO accepts the meshcore send mode and rejects others', () => {
    const dto = (sendMode: string) => Object.assign(new UpdateSerialConfigDto(), { sendMode });
    assert.equal(validateSync(dto('meshcore')).length, 0);
    assert.equal(validateSync(dto('protobuf')).length, 0);
    assert.ok(validateSync(dto('bogus')).length > 0);
  });

  await test('parser reassembles a frame split across chunks and skips noise', () => {
    const parser = new MeshcoreFrameParser();
    const frames: Buffer[] = [];
    parser.on('data', (frame: Buffer) => frames.push(frame));
    parser.write(Buffer.from([0x41, 0x0a, MC.RADIO_TO_APP, 3]));
    parser.write(Buffer.from([0, 0x0a, 0x0b]));
    parser.write(Buffer.from([0x0c]));
    assert.deepEqual(frames, [Buffer.from([0x0a, 0x0b, 0x0c])]);
  });

  await test('SELF_INFO sets the text limit from the radio name', () => {
    const selfInfo = Buffer.concat([Buffer.alloc(MC.SELF_INFO_NAME_OFS), Buffer.from('MyRadio1')]);
    selfInfo[0] = MC.RESP_SELF_INFO;
    internals.handleMeshcoreFrame(selfInfo);
    assert.equal(internals.meshcoreCap, 150);
  });

  await test('channel 0 message strips the radio name and parses the node line', async () => {
    written.length = 0;
    parsed.length = 0;
    internals.handleMeshcoreFrame(
      channelMsg(0, 'MyRadio1: AH5: STATUS: Mode:BLE Scan:IDLE Hits:0 Temp:25.0C Up:00:05:00'),
    );
    await tick();
    assert.deepEqual(
      parsed.map((e) => e.kind),
      ['node-telemetry', 'command-result'],
    );
    assert.deepEqual(written, [encodeMeshcoreFrame(Buffer.from([MC.CMD_SYNC_NEXT]))]);
  });

  await test('a reply part ending in " +" is joined to the next part from that node', async () => {
    parsed.length = 0;
    internals.handleMeshcoreFrame(channelMsg(0, 'MyRadio1: AH5: STATUS: Mode:BLE Scan:IDLE +'));
    await tick();
    assert.equal(parsed.length, 0);
    internals.handleMeshcoreFrame(channelMsg(0, 'MyRadio1: AH5: Hits:0 Temp:25.0C Up:00:05:00'));
    await tick();
    assert.deepEqual(
      parsed.map((e) => e.kind),
      ['node-telemetry', 'command-result'],
    );
  });

  await test('a held part is sent alone after the hold time or on flush', async () => {
    const out: string[] = [];
    const joiner = new MeshcoreReplyJoiner((text) => out.push(text), 5);
    joiner.push('AH5: first half +');
    joiner.push('AH7: other node line');
    assert.deepEqual(out, ['AH7: other node line']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(out, ['AH7: other node line', 'AH5: first half']);
    joiner.push('AH5: again +');
    joiner.flush();
    assert.deepEqual(out.at(-1), 'AH5: again');
  });

  await test('message on another channel is ignored but still synced', async () => {
    written.length = 0;
    parsed.length = 0;
    internals.handleMeshcoreFrame(channelMsg(1, 'MyRadio1: AH5: STATUS: Mode:BLE'));
    await tick();
    assert.equal(parsed.length, 0);
    assert.equal(written.length, 1);
  });

  await test('send writes a channel 0 text frame and resolves on OK', async () => {
    written.length = 0;
    const sent = internals.sendMeshcoreCommand('@AH5 STATUS');
    await tick();
    const frame = written[0];
    assert.equal(frame[0], MC.APP_TO_RADIO);
    assert.equal(frame[1] | (frame[2] << 8), frame.length - 3);
    assert.equal(frame[3], MC.CMD_SEND_CHANNEL_TXT);
    assert.equal(frame[4], 0);
    assert.equal(frame[5], 0);
    assert.ok(Math.abs(frame.readUInt32LE(6) - Date.now() / 1000) < 5);
    assert.equal(frame.subarray(10).toString(), '@AH5 STATUS');
    internals.handleMeshcoreFrame(Buffer.from([MC.RESP_OK]));
    await sent;
  });

  await test('send rejects on ERR', async () => {
    const sent = internals.sendMeshcoreCommand('@AH5 STATUS');
    await tick();
    internals.handleMeshcoreFrame(Buffer.from([MC.RESP_ERR, 2]));
    await assert.rejects(sent, /rejected/);
  });

  await test('send refuses a line over the radio limit', async () => {
    written.length = 0;
    await assert.rejects(internals.sendMeshcoreCommand(`@AH5 ${'X'.repeat(200)}`), /limit is 150/);
    assert.equal(written.length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
