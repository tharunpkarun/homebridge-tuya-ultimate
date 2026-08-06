import TuyaDeviceManager from '../src/device/TuyaDeviceManager';
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
});
