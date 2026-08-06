import { EventEmitter } from 'events';
import https from 'https';

import TuyaOpenAPI from '../src/core/TuyaOpenAPI';

class FakeRequest extends EventEmitter {
  write = jest.fn();
  setTimeout = jest.fn();
  destroy = jest.fn((error?: Error) => {
    if (error) this.emit('error', error);
  });
  end = jest.fn();
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = 'OK';
  setEncoding = jest.fn();
  resume = jest.fn();
}

describe('TuyaOpenAPI response handling', () => {
  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  test('rejects malformed JSON instead of throwing outside the request promise', async () => {
    const request = new FakeRequest();
    const response = new FakeResponse();
    request.end.mockImplementation(() => {
      queueMicrotask(() => {
        response.emit('data', '{broken');
        response.emit('end');
      });
    });
    jest.spyOn(https, 'request').mockImplementation(((_options, callback) => {
      callback?.(response as never);
      return request;
    }) as never);
    const api = new TuyaOpenAPI('https://openapi.example.test', 'id', 'key', 'en', false, false, 1, 1000);

    await expect(api.get('/v1.0/test')).rejects.toThrow('malformed JSON');
  });

  test('turns an HTTP error into a structured response without hanging', async () => {
    const request = new FakeRequest();
    const response = new FakeResponse();
    response.statusCode = 503;
    response.statusMessage = 'Unavailable';
    response.resume.mockImplementation(() => {
      queueMicrotask(() => response.emit('error', new Error('truncated error response')));
    });
    jest.spyOn(https, 'request').mockImplementation(((_options, callback) => {
      callback?.(response as never);
      return request;
    }) as never);
    const api = new TuyaOpenAPI('https://openapi.example.test', 'id', 'key', 'en', false, false, 1, 1000);

    await expect(api.get('/v1.0/test')).resolves.toMatchObject({
      success: false,
      code: 503,
    });
    expect(response.resume).toHaveBeenCalled();
  });

  test('rejects a truncated response stream instead of leaving the request pending', async () => {
    const request = new FakeRequest();
    const response = new FakeResponse();
    request.end.mockImplementation(() => {
      queueMicrotask(() => {
        response.emit('data', '{"success":');
        response.emit('aborted');
      });
    });
    jest.spyOn(https, 'request').mockImplementation(((_options, callback) => {
      callback?.(response as never);
      return request;
    }) as never);
    const api = new TuyaOpenAPI('https://openapi.example.test', 'id', 'key', 'en', false, false, 1, 1000);

    await expect(api.get('/v1.0/test')).rejects.toThrow('aborted');
  });
});
