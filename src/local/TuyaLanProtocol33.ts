import crypto from 'crypto';
import net from 'net';

const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;
const HEADER_SIZE = 16;
const TRAILER_SIZE = 8;
const VERSION_HEADER_SIZE = 15;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export const TUYA_CONTROL_COMMAND = 7;
export const TUYA_DP_QUERY_COMMAND = 10;

let crcTable: number[] | undefined;

function table() {
  if (crcTable) {
    return crcTable;
  }
  crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    return value >>> 0;
  });
  return crcTable;
}

export function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ table()[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encryptProtocol33PayloadBody(payload: object, localKey: string) {
  const key = Buffer.from(localKey, 'utf8');
  if (key.length !== 16) {
    throw new Error('Tuya LAN local key must contain exactly 16 UTF-8 bytes.');
  }
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ]);
  return encrypted;
}

export function encryptProtocol33Payload(payload: object, localKey: string) {
  const encrypted = encryptProtocol33PayloadBody(payload, localKey);
  const version = Buffer.alloc(VERSION_HEADER_SIZE);
  version.write('3.3', 0, 'ascii');
  return Buffer.concat([version, encrypted]);
}

export function decryptProtocol33Payload(payload: Buffer, localKey: string) {
  const key = Buffer.from(localKey, 'utf8');
  if (key.length !== 16) {
    throw new Error('Tuya LAN local key must contain exactly 16 UTF-8 bytes.');
  }
  const encrypted = payload.subarray(0, 3).toString('ascii') === '3.3'
    ? payload.subarray(VERSION_HEADER_SIZE)
    : payload;
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as Record<string, unknown>;
}

export function encodeTuyaFrame(sequence: number, command: number, payload: Buffer) {
  const frame = Buffer.alloc(HEADER_SIZE + payload.length + TRAILER_SIZE);
  frame.writeUInt32BE(PREFIX, 0);
  frame.writeUInt32BE(sequence >>> 0, 4);
  frame.writeUInt32BE(command >>> 0, 8);
  frame.writeUInt32BE(payload.length + TRAILER_SIZE, 12);
  payload.copy(frame, HEADER_SIZE);
  frame.writeUInt32BE(crc32(frame.subarray(0, HEADER_SIZE + payload.length)), HEADER_SIZE + payload.length);
  frame.writeUInt32BE(SUFFIX, HEADER_SIZE + payload.length + 4);
  return frame;
}

export type DecodedTuyaFrame = {
  sequence: number;
  command: number;
  payload: Buffer;
};

export function decodeTuyaFrame(frame: Buffer): DecodedTuyaFrame {
  if (frame.length < HEADER_SIZE + TRAILER_SIZE || frame.readUInt32BE(0) !== PREFIX) {
    throw new Error('Invalid Tuya LAN frame header.');
  }
  const declaredLength = frame.readUInt32BE(12);
  const totalLength = HEADER_SIZE + declaredLength;
  if (declaredLength < TRAILER_SIZE || frame.length !== totalLength) {
    throw new Error('Invalid Tuya LAN frame length.');
  }
  if (frame.readUInt32BE(frame.length - 4) !== SUFFIX) {
    throw new Error('Invalid Tuya LAN frame suffix.');
  }
  const expectedCrc = frame.readUInt32BE(frame.length - 8);
  const actualCrc = crc32(frame.subarray(0, frame.length - 8));
  if (expectedCrc !== actualCrc) {
    throw new Error('Invalid Tuya LAN frame checksum.');
  }
  return {
    sequence: frame.readUInt32BE(4),
    command: frame.readUInt32BE(8),
    payload: frame.subarray(HEADER_SIZE, frame.length - TRAILER_SIZE),
  };
}

export type TuyaLanDevice = {
  id: string;
  ip: string;
  localKey: string;
  port?: number;
  timeoutMs?: number;
};

export default class TuyaLanProtocol33Client {
  private sequence = 0;

  async send(device: TuyaLanDevice, dps: Record<string, unknown>): Promise<void> {
    if (!net.isIP(device.ip)) {
      throw new Error('Tuya LAN device IP address is invalid.');
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = encryptProtocol33Payload({
      devId: device.id,
      gwId: device.id,
      uid: device.id,
      t: timestamp,
      dps,
    }, device.localKey);
    const frame = encodeTuyaFrame(++this.sequence, TUYA_CONTROL_COMMAND, payload);
    const configuredTimeout = device.timeoutMs ?? 3000;
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(30_000, Math.max(250, configuredTimeout))
      : 3000;
    await this.exchange(device.ip, device.port ?? 6668, frame, timeoutMs);
  }

  async query(device: TuyaLanDevice): Promise<Record<string, unknown>> {
    if (!net.isIP(device.ip)) {
      throw new Error('Tuya LAN device IP address is invalid.');
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Protocol 3.3 DP_QUERY is encrypted but, unlike CONTROL, has no 15-byte version header.
    const payload = encryptProtocol33PayloadBody({
      gwId: device.id,
      devId: device.id,
      uid: device.id,
      t: timestamp,
      dps: {},
    }, device.localKey);
    const frame = encodeTuyaFrame(++this.sequence, TUYA_DP_QUERY_COMMAND, payload);
    const configuredTimeout = device.timeoutMs ?? 3000;
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(30_000, Math.max(250, configuredTimeout))
      : 3000;
    const response = await this.exchange(device.ip, device.port ?? 6668, frame, timeoutMs);
    const responsePayload = response.payload.length >= 4
      ? response.payload.subarray(4)
      : response.payload;
    const decoded = decryptProtocol33Payload(responsePayload, device.localKey);
    const dps = decoded.dps;
    if (!dps || typeof dps !== 'object' || Array.isArray(dps)) {
      throw new Error('Tuya LAN status response did not contain datapoints.');
    }
    return dps as Record<string, unknown>;
  }

  private exchange(host: string, port: number, request: Buffer, timeoutMs: number): Promise<DecodedTuyaFrame> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let response = Buffer.alloc(0);
      let settled = false;

      const finish = (error?: Error, result?: DecodedTuyaFrame) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        error ? reject(error) : resolve(result!);
      };

      socket.setTimeout(timeoutMs, () => finish(new Error('Tuya LAN command timed out.')));
      socket.once('error', error => finish(error));
      socket.once('end', () => finish(new Error('Tuya LAN device closed before acknowledging the command.')));
      socket.once('close', () => finish(new Error('Tuya LAN connection closed before acknowledging the command.')));
      socket.once('connect', () => socket.write(request));
      socket.on('data', chunk => {
        if (response.length + chunk.length > MAX_RESPONSE_BYTES) {
          finish(new Error('Tuya LAN response exceeded the safety limit.'));
          return;
        }
        response = Buffer.concat([response, chunk]);
        if (response.length < HEADER_SIZE) {
          return;
        }
        if (response.readUInt32BE(0) !== PREFIX) {
          finish(new Error('Invalid Tuya LAN frame header.'));
          return;
        }
        const declaredLength = response.readUInt32BE(12);
        if (declaredLength < TRAILER_SIZE || declaredLength > MAX_RESPONSE_BYTES - HEADER_SIZE) {
          finish(new Error('Tuya LAN response declared an invalid frame size.'));
          return;
        }
        const totalLength = HEADER_SIZE + declaredLength;
        if (response.length < totalLength) {
          return;
        }
        try {
          const decoded = decodeTuyaFrame(response.subarray(0, totalLength));
          if (decoded.payload.length >= 4 && decoded.payload.readUInt32BE(0) !== 0) {
            finish(new Error(`Tuya LAN device rejected the command (${decoded.payload.readUInt32BE(0)}).`));
            return;
          }
          finish(undefined, decoded);
        } catch (error) {
          finish(error as Error);
        }
      });
    });
  }
}
