import { PrefixLogger } from '../src/util/Logger';

describe('PrefixLogger secret masking', () => {
  test('redacts secrets even when debug output is promoted to info', () => {
    const sink = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const logger = new PrefixLogger(sink, 'test', true);

    logger.debug('headers=%s body=%s', JSON.stringify({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      sign: 'signature-secret',
      client_id: 'client-secret',
    }), JSON.stringify({ password: 'password-hash', localKey: 'local-secret' }));
    logger.info({ nested: { accessKey: 'access-key-secret', safe: 'visible' } });

    const output = JSON.stringify(sink.info.mock.calls);
    expect(output).toContain('visible');
    for (const secret of [
      'access-secret',
      'refresh-secret',
      'signature-secret',
      'client-secret',
      'password-hash',
      'local-secret',
      'access-key-secret',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
