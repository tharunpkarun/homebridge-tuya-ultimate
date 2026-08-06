import crypto from 'crypto';
import { EventEmitter } from 'events';
import net from 'net';

import TuyaLocalCommandRouter from '../src/local/TuyaLocalCommandRouter';
import {
  decodeTuyaFrame,
  encodeTuyaFrame,
  encryptProtocol33Payload,
  TUYA_CONTROL_COMMAND,
  default as TuyaLanProtocol33Client,
} from '../src/local/TuyaLanProtocol33';
import TuyaDevice from '../src/device/TuyaDevice';

describe('Tuya LAN protocol 3.3', () => {
  const fakeSocket = () => Object.assign(new EventEmitter(), {
    setTimeout: jest.fn(),
    write: jest.fn(),
    destroy: jest.fn(),
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('frames encrypted commands with a validated checksum', () => {
    const encrypted = encryptProtocol33Payload({ dps: { 1: true } }, '0123456789abcdef');
    expect(encrypted.subarray(0, 3).toString()).toBe('3.3');

    const frame = encodeTuyaFrame(7, TUYA_CONTROL_COMMAND, encrypted);
    expect(decodeTuyaFrame(frame)).toMatchObject({ sequence: 7, command: TUYA_CONTROL_COMMAND });

    const cipherText = encrypted.subarray(15);
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('0123456789abcdef'), null);
    const plaintext = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString();
    expect(JSON.parse(plaintext)).toEqual({ dps: { 1: true } });
  });

  test('rejects a corrupted frame', () => {
    const frame = encodeTuyaFrame(1, TUYA_CONTROL_COMMAND, Buffer.from('payload'));
    frame[18] ^= 0xff;
    expect(() => decodeTuyaFrame(frame)).toThrow('checksum');
  });

  test('rejects promptly when a peer closes without an acknowledgement', async () => {
    const socket = fakeSocket();
    jest.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const client = new TuyaLanProtocol33Client();
    const result = client.send({
      id: 'device-1',
      ip: '127.0.0.1',
      localKey: '0123456789abcdef',
      timeoutMs: 1000,
    }, { 1: true });

    socket.emit('connect');
    socket.emit('end');
    await expect(result).rejects.toThrow(/closed/i);
  });

  test('rejects an oversized declared response before buffering its body', async () => {
    const socket = fakeSocket();
    jest.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const client = new TuyaLanProtocol33Client();
    const result = client.send({
      id: 'device-1',
      ip: '127.0.0.1',
      localKey: '0123456789abcdef',
      timeoutMs: 1000,
    }, { 1: true });
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x000055aa, 0);
    header.writeUInt32BE(0xffffffff, 12);

    socket.emit('connect');
    socket.emit('data', header);
    await expect(result).rejects.toThrow(/frame size/i);
  });
});

describe('Tuya local/cloud command routing', () => {
  const device = {
    id: 'device-1',
    name: 'Desk plug',
    ip: '192.0.2.10',
  } as TuyaDevice;

  test('maps codes to local DP IDs and avoids the cloud on success', async () => {
    const localClient = { send: jest.fn(async () => undefined) };
    const cloud = jest.fn(async () => 'cloud');
    const router = new TuyaLocalCommandRouter(() => ({
      mode: 'hybrid',
      localKey: '0123456789abcdef',
      protocolVersion: '3.3',
      dpMap: [{ code: 'switch_1', dpId: 1 }],
    }), jest.fn(), localClient);

    await expect(router.send(device, [{ code: 'switch_1', value: true }], cloud)).resolves.toBe(true);
    expect(localClient.send).toHaveBeenCalledWith(expect.objectContaining({ ip: '192.0.2.10' }), { 1: true });
    expect(cloud).not.toHaveBeenCalled();
  });

  test('falls back to cloud in hybrid mode but not local-only mode', async () => {
    const localClient = { send: jest.fn(async () => { throw new Error('offline'); }) };
    const cloud = jest.fn(async () => 'cloud');
    const attempts = jest.fn();
    const baseConfig = {
      localKey: '0123456789abcdef',
      protocolVersion: '3.3' as const,
      dpMap: [{ code: 'switch', dpId: 1 }],
    };
    const hybrid = new TuyaLocalCommandRouter(() => ({ ...baseConfig, mode: 'hybrid' }), jest.fn(), localClient);
    const local = new TuyaLocalCommandRouter(() => ({ ...baseConfig, mode: 'local' }), jest.fn(), localClient);

    await expect(hybrid.send(device, [{ code: 'switch', value: true }], cloud, attempts)).resolves.toBe('cloud');
    expect(attempts).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestedRoute: 'hybrid',
      attemptedRoute: 'local',
      outcome: 'failure',
    }));
    expect(attempts).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestedRoute: 'hybrid',
      attemptedRoute: 'cloud',
      outcome: 'success',
    }));
    await expect(local.send(device, [{ code: 'switch', value: true }], cloud)).rejects.toThrow('offline');
  });

  test('falls back rather than guessing an unmapped DP', async () => {
    const cloud = jest.fn(async () => 'cloud');
    const router = new TuyaLocalCommandRouter(() => ({
      mode: 'hybrid',
      localKey: '0123456789abcdef',
      dpMap: [],
    }), jest.fn(), { send: jest.fn() });

    await expect(router.send(device, [{ code: 'switch', value: true }], cloud)).resolves.toBe('cloud');
  });

  test('reports a completed cloud rejection as a failed attempt', async () => {
    const attempts = jest.fn();
    const router = new TuyaLocalCommandRouter(() => undefined, jest.fn(), { send: jest.fn() });

    await expect(router.send(
      device,
      [{ code: 'switch', value: true }],
      async () => false,
      attempts,
    )).resolves.toBe(false);
    expect(attempts).toHaveBeenCalledWith(expect.objectContaining({
      requestedRoute: 'cloud',
      attemptedRoute: 'cloud',
      outcome: 'failure',
    }));
  });
});
