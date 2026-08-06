import TuyaDeviceManager from '../src/device/TuyaDeviceManager';
import TuyaDevice from '../src/device/TuyaDevice';
import { TuyaCloudAPI, TuyaMessageBus } from '../src/core/TuyaCloudAPI';

const messageBus = (): TuyaMessageBus => ({
  addMessageListener: jest.fn(),
  removeMessageListener: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
});

const manager = () => new TuyaDeviceManager({
  tokenInfo: { access_token: '', refresh_token: '', uid: '', expire: 0 },
  get: jest.fn(),
  post: jest.fn(),
} as unknown as TuyaCloudAPI, false, messageBus());

describe('Developer Cloud product API fallback', () => {
  test('routes product-specific APIs through the secondary manager', async () => {
    const primary = manager();
    const fallback = manager();
    fallback.getInfraredRemotes = jest.fn(async () => ({ success: true, result: ['remote'] })) as any;
    fallback.getInfraredACStatus = jest.fn(async () => ({
      success: true,
      result: { power: 0, mode: 0, temp: 25, wind: 0 },
    })) as any;
    fallback.sendInfraredACCommands = jest.fn(async () => ({ success: true })) as any;
    fallback.getLockTemporaryKey = jest.fn(async () => ({ success: true, result: { ticket_id: 'ticket' } })) as any;
    primary.setProductApiFallback(fallback);

    await expect(primary.getInfraredRemotes('hub')).resolves.toMatchObject({ success: true });
    await primary.sendInfraredACCommands('hub', 'remote', 1, 0, 25, 0);
    await primary.getLockTemporaryKey('lock');

    expect(fallback.getInfraredRemotes).toHaveBeenCalledWith('hub');
    expect(fallback.sendInfraredACCommands).toHaveBeenCalledWith('hub', 'remote', 1, 0, 25, 0);
    expect(fallback.getLockTemporaryKey).toHaveBeenCalledWith('lock');
  });

  test('reconciles IR AC status through the secondary manager without a second MQTT connection', async () => {
    const primary = manager();
    const fallback = manager();
    const remote = new TuyaDevice({
      id: 'remote', uuid: 'remote', name: 'AC', owner_id: 'home',
      product_id: 'product', product_name: 'IR AC', category: 'infrared_ac',
      schema: [],
      status: [
        { code: 'power', value: 1 },
        { code: 'mode', value: 0 },
        { code: 'temp', value: 25 },
      ],
      online: true, icon: '', ip: '', lat: '', lon: '', time_zone: '',
      create_time: 0, active_time: 0, update_time: 0, sub: true, parent_id: 'hub',
    });
    primary.devices = [remote];
    fallback.getInfraredACStatus = jest.fn(async () => ({
      success: true,
      result: { power: 0, mode: 0, temp: 25, wind: 0 },
    })) as any;
    primary.setProductApiFallback(fallback);

    await expect(primary.ensureInfraredACStatusFresh(remote.id, 0)).resolves.toBe(true);

    expect(fallback.getInfraredACStatus).toHaveBeenCalledWith('hub', 'remote');
    expect(remote.status.find(status => status.code === 'power')?.value).toBe(0);
    expect(primary.mq.start).not.toHaveBeenCalled();
    expect(fallback.mq.start).not.toHaveBeenCalled();
  });
});
