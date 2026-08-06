import { afterEach, describe, expect, jest, test } from '@jest/globals';
import TuyaDeviceManager from '../src/device/TuyaDeviceManager';
import TuyaDevice from '../src/device/TuyaDevice';
import { TuyaCloudAPI, TuyaMessageBus } from '../src/core/TuyaCloudAPI';

const success = (result: unknown) => ({ success: true as const, result, t: 1, tid: 'test' });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const messageBus = (): TuyaMessageBus => ({
  addMessageListener: jest.fn(),
  removeMessageListener: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
});

const advanceTimers = async (milliseconds: number) => {
  await jest.advanceTimersByTimeAsync(milliseconds);
};

const device = (values: Record<string, unknown> = {}) => new TuyaDevice({
  id: 'ir-ac',
  uuid: 'ir-ac',
  name: 'Bedroom AC',
  owner_id: 'home',
  product_id: 'product',
  product_name: 'IR AC',
  category: 'infrared_ac',
  schema: [],
  status: [
    { code: 'power', value: 1 },
    { code: 'mode', value: 0 },
    { code: 'temp', value: 25 },
    { code: 'wind', value: 0 },
  ],
  online: true,
  icon: '', ip: '', lat: '', lon: '', time_zone: '',
  create_time: 0, active_time: 0, update_time: 0,
  sub: true,
  parent_id: 'ir-hub',
  ...values,
});

const setup = () => {
  const bus = messageBus();
  const api = {
    tokenInfo: { access_token: '', refresh_token: '', uid: '', expire: 0 },
    get: jest.fn(),
    post: jest.fn(),
  } as unknown as TuyaCloudAPI;
  const manager = new TuyaDeviceManager(api, false, bus);
  const hub = device({
    id: 'ir-hub',
    uuid: 'ir-hub',
    name: 'IR Hub',
    category: 'hwktwkq',
    sub: false,
    parent_id: undefined,
    status: [{ code: 'online', value: true }],
  });
  const child = device();
  manager.devices = [hub, child];
  return { api, bus, manager, hub, child };
};

describe('IR AC cloud status reconciliation', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('merges a changed cloud status, emits once, and never sends an IR command', async () => {
    const { api, manager, child } = setup();
    const listener = jest.fn();
    manager.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, listener);
    jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 0, mode: 0, temp: 25, wind: 0,
    }));

    await expect(manager.ensureInfraredACStatusFresh(child.id, 0)).resolves.toBe(true);

    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(child, [{ code: 'power', value: 0 }]);
    expect(api.post).not.toHaveBeenCalled();
  });

  test('coalesces concurrent refreshes and freshness-window reads', async () => {
    const { manager, child } = setup();
    const request = deferred<ReturnType<typeof success>>();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockReturnValue(request.promise);

    const first = manager.ensureInfraredACStatusFresh(child.id, 2_000);
    const second = manager.ensureInfraredACStatusFresh(child.id, 2_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    request.resolve(success({ power: 1, mode: 0, temp: 25, wind: 0 }));
    await Promise.all([first, second]);

    await manager.ensureInfraredACStatusFresh(child.id, 2_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  test('discards an older cloud response after a newer child MQTT update', async () => {
    const { manager, child } = setup();
    const request = deferred<ReturnType<typeof success>>();
    jest.spyOn(manager, 'getInfraredACStatus').mockReturnValue(request.promise);

    const refresh = manager.ensureInfraredACStatusFresh(child.id, 0);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [
        { code: 'power', value: 0 },
        { code: 'mode', value: 0 },
        { code: 'temp', value: 25 },
      ],
    });
    request.resolve(success({ power: 1, mode: 2, temp: 24, wind: 0 }));
    await refresh;

    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    expect(child.status.find(status => status.code === 'mode')?.value).toBe(0);
  });

  test('coalesces parent MQTT activity into a delayed child refresh', async () => {
    jest.useFakeTimers();
    const { manager, hub, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 0, mode: 0, temp: 25, wind: 0,
    }));

    await manager.onMQTTMessage('device/topic', 4, {
      devId: hub.id,
      status: [{ code: 'online', value: true }],
    });
    await manager.onMQTTMessage('device/topic', 4, {
      devId: hub.id,
      status: [{ code: 'online', value: true }],
    });
    expect(getStatus).not.toHaveBeenCalled();

    await advanceTimers(1_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    manager.stop();
  });

  test('retries after parent activity that arrives during an older in-flight read', async () => {
    jest.useFakeTimers();
    const { manager, hub, child } = setup();
    const oldRequest = deferred<ReturnType<typeof success>>();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus')
      .mockResolvedValueOnce(success({ power: 1, mode: 0, temp: 25, wind: 0 }))
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValue(success({ power: 0, mode: 0, temp: 25, wind: 0 }));

    await manager.ensureInfraredACStatusFresh(child.id, 0);
    const firstRefresh = manager.ensureInfraredACStatusFresh(child.id, 0);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: hub.id,
      status: [{ code: 'online', value: true }],
    });
    await advanceTimers(1_000);
    oldRequest.resolve(success({ power: 1, mode: 2, temp: 24, wind: 0 }));
    await firstRefresh;
    await advanceTimers(0);

    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    expect(child.status.find(status => status.code === 'mode')?.value).toBe(0);
    await advanceTimers(15_000);
    expect(getStatus).toHaveBeenCalledTimes(3);
    manager.stop();
  });

  test('eventually reconciles parent activity after a recent successful read', async () => {
    jest.useFakeTimers();
    const { manager, hub, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus')
      .mockResolvedValueOnce(success({ power: 1, mode: 0, temp: 25, wind: 0 }))
      .mockResolvedValue(success({ power: 0, mode: 0, temp: 25, wind: 0 }));

    await manager.ensureInfraredACStatusFresh(child.id, 0);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: hub.id,
      status: [{ code: 'online', value: true }],
    });
    await advanceTimers(14_999);
    expect(getStatus).toHaveBeenCalledTimes(1);

    await advanceTimers(1);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    manager.stop();
  });

  test('promotes a queued parent refresh when a partial child update needs immediate reconciliation', async () => {
    jest.useFakeTimers();
    const { manager, hub, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus')
      .mockResolvedValueOnce(success({ power: 1, mode: 0, temp: 25, wind: 0 }))
      .mockResolvedValue(success({ power: 0, mode: 0, temp: 25, wind: 0 }));

    await manager.ensureInfraredACStatusFresh(child.id, 0);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: hub.id,
      status: [{ code: 'online', value: true }],
    });
    await advanceTimers(1_000);
    expect(getStatus).toHaveBeenCalledTimes(1);

    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [{ code: 'mode', value: 0 }],
    });
    await advanceTimers(1_000);

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    manager.stop();
  });

  test('keeps a partial child update pending through a slow command and its settling window', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 0, mode: 0, temp: 25, wind: 0,
    }));

    const commandGeneration = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, commandGeneration);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [{ code: 'mode', value: 0 }],
    });
    await advanceTimers(30_000);
    await manager.ensureInfraredACStatusFresh(child.id, 0);
    expect(getStatus).not.toHaveBeenCalled();

    manager.completeInfraredACLocalCommand(child.id, commandGeneration, true);
    await advanceTimers(4_999);
    expect(getStatus).not.toHaveBeenCalled();

    await advanceTimers(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    manager.stop();
  });

  test('ignores an older command failure while a newer command is pending', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 0, mode: 0, temp: 25, wind: 0,
    }));

    const olderCommand = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, olderCommand);
    const newerCommand = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, newerCommand);
    manager.completeInfraredACLocalCommand(child.id, olderCommand, false);
    await advanceTimers(10_000);
    await manager.ensureInfraredACStatusFresh(child.id, 0);
    expect(getStatus).not.toHaveBeenCalled();

    manager.completeInfraredACLocalCommand(child.id, newerCommand, true);
    await advanceTimers(5_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  test('waits for an older overlapping command after the latest command finishes first', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 0, mode: 0, temp: 25, wind: 0,
    }));

    const olderCommand = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, olderCommand);
    const newerCommand = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, newerCommand);
    manager.completeInfraredACLocalCommand(child.id, newerCommand, true);
    await advanceTimers(10_000);
    await manager.ensureInfraredACStatusFresh(child.id, 0);
    expect(getStatus).not.toHaveBeenCalled();

    manager.completeInfraredACLocalCommand(child.id, olderCommand, true);
    await advanceTimers(4_999);
    expect(getStatus).not.toHaveBeenCalled();
    await advanceTimers(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  test('defers conflicting child MQTT state while a local command is in flight', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const listener = jest.fn();
    manager.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, listener);
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 1, mode: 0, temp: 25, wind: 0,
    }));

    const commandGeneration = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, commandGeneration);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [
        { code: 'power', value: 1 },
        { code: 'mode', value: 2 },
        { code: 'temp', value: 24 },
      ],
    });

    expect(child.status.find(status => status.code === 'mode')?.value).toBe(0);
    expect(child.status.find(status => status.code === 'temp')?.value).toBe(25);
    expect(listener).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();

    manager.completeInfraredACLocalCommand(child.id, commandGeneration, true);
    await advanceTimers(4_999);
    expect(getStatus).not.toHaveBeenCalled();
    await advanceTimers(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  test('defers conflicting child MQTT state throughout local-command settling', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const listener = jest.fn();
    manager.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, listener);
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 1, mode: 0, temp: 25, wind: 0,
    }));

    const commandGeneration = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, commandGeneration);
    manager.completeInfraredACLocalCommand(child.id, commandGeneration, true);
    await advanceTimers(1_000);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [
        { code: 'power', value: 1 },
        { code: 'mode', value: 2 },
        { code: 'temp', value: 24 },
      ],
    });

    expect(child.status.find(status => status.code === 'mode')?.value).toBe(0);
    expect(child.status.find(status => status.code === 'temp')?.value).toBe(25);
    expect(listener).not.toHaveBeenCalled();
    await advanceTimers(3_999);
    expect(getStatus).not.toHaveBeenCalled();
    await advanceTimers(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  test('renews deferred reconciliation after a command outlasts the event deadline', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 1, mode: 0, temp: 25, wind: 0,
    }));

    const commandGeneration = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, commandGeneration);
    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [
        { code: 'power', value: 1 },
        { code: 'mode', value: 2 },
        { code: 'temp', value: 24 },
      ],
    });
    await advanceTimers(61_000);
    expect(getStatus).not.toHaveBeenCalled();

    manager.completeInfraredACLocalCommand(child.id, commandGeneration, true);
    await advanceTimers(4_999);
    expect(getStatus).not.toHaveBeenCalled();
    await advanceTimers(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(child.status.find(status => status.code === 'mode')?.value).toBe(0);
    manager.stop();
  });

  test('retries a failed event refresh after backoff without losing the update', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus')
      .mockResolvedValueOnce({ success: false, code: 500, msg: 'temporary' } as any)
      .mockResolvedValue(success({ power: 0, mode: 0, temp: 25, wind: 0 }));

    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [{ code: 'mode', value: 0 }],
    });
    await advanceTimers(1_000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(1);

    await advanceTimers(1_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    manager.stop();
  });

  test('stops event retries after the bounded failure window', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue({
      success: false, code: 500, msg: 'offline',
    } as any);

    await manager.onMQTTMessage('device/topic', 4, {
      devId: child.id,
      status: [{ code: 'mode', value: 0 }],
    });
    await advanceTimers(60_000);
    const callsAtDeadline = getStatus.mock.calls.length;
    expect(callsAtDeadline).toBeGreaterThan(1);
    expect(callsAtDeadline).toBeLessThan(10);

    await advanceTimers(300_000);
    expect(getStatus).toHaveBeenCalledTimes(callsAtDeadline);
    expect(jest.getTimerCount()).toBe(0);
    manager.stop();
  });

  test('uses a bounded watch while HomeKit is reading the thermostat', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 0, mode: 0, temp: 25, wind: 0,
    }));

    manager.watchInfraredACStatus(child.id);
    await advanceTimers(5_000);

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(0);
    manager.stop();
  });

  test('does not extend the bounded watch on repeated reads and observes its cooldown', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 1, mode: 0, temp: 25, wind: 0,
    }));

    manager.watchInfraredACStatus(child.id);
    for (let tick = 0; tick < 4; tick += 1) {
      await advanceTimers(5_000);
    }
    manager.watchInfraredACStatus(child.id);
    await advanceTimers(5_000);
    await advanceTimers(5_000);
    expect(getStatus).toHaveBeenCalledTimes(5);

    manager.watchInfraredACStatus(child.id);
    await advanceTimers(120_000);
    expect(getStatus).toHaveBeenCalledTimes(5);

    manager.watchInfraredACStatus(child.id);
    await advanceTimers(5_000);
    expect(getStatus).toHaveBeenCalledTimes(6);
    manager.stop();
  });

  test('protects optimistic local state from stale cloud responses during settling', async () => {
    jest.useFakeTimers();
    const { manager, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success({
      power: 1, mode: 2, temp: 24, wind: 0,
    }));
    child.status.find(status => status.code === 'mode')!.value = 0;

    const commandGeneration = manager.noteInfraredACLocalCommand(child.id);
    manager.beginInfraredACLocalCommand(child.id, commandGeneration);
    await manager.ensureInfraredACStatusFresh(child.id, 0);
    expect(getStatus).not.toHaveBeenCalled();

    manager.completeInfraredACLocalCommand(child.id, commandGeneration, true);
    await advanceTimers(5_000);
    await manager.ensureInfraredACStatusFresh(child.id, 0);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  test('preserves cached state on malformed responses and stops queued work on shutdown', async () => {
    jest.useFakeTimers();
    const { bus, manager, hub, child } = setup();
    const getStatus = jest.spyOn(manager, 'getInfraredACStatus').mockResolvedValue(success(null));

    await expect(manager.ensureInfraredACStatusFresh(child.id, 0)).resolves.toBe(false);
    expect(child.status.find(status => status.code === 'power')?.value).toBe(1);

    await manager.onMQTTMessage('device/topic', 4, {
      devId: hub.id,
      status: [{ code: 'online', value: true }],
    });
    manager.stop();
    await advanceTimers(5_000);

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(bus.stop).toHaveBeenCalledTimes(1);
  });

  test('does not apply or emit an in-flight response after shutdown', async () => {
    const { manager, child } = setup();
    const request = deferred<ReturnType<typeof success>>();
    const listener = jest.fn();
    manager.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, listener);
    jest.spyOn(manager, 'getInfraredACStatus').mockReturnValue(request.promise);

    const refresh = manager.ensureInfraredACStatusFresh(child.id, 0);
    manager.stop();
    request.resolve(success({ power: 0, mode: 0, temp: 25, wind: 0 }));
    await refresh;

    expect(child.status.find(status => status.code === 'power')?.value).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
