import { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import {
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  CameraRecordingConfiguration,
  EventTriggerOption,
  H264Level,
  H264Profile,
  MediaContainerType,
} from 'homebridge';
import { PassThrough } from 'stream';

import { TuyaRecordingDelegate } from '../src/util/TuyaRecordingDelegate';

class FakeRecordingProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  readonly kill = jest.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }

    this.killed = true;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  });

  finish(code: number): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, null));
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

const mp4Box = (type: string, payload = Buffer.alloc(0)): Buffer => {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, 'ascii');
  payload.copy(result, 8);
  return result;
};

const flushEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const configuration = (): CameraRecordingConfiguration => ({
  prebufferLength: 4000,
  eventTriggerTypes: [EventTriggerOption.MOTION],
  mediaContainerConfiguration: {
    type: MediaContainerType.FRAGMENTED_MP4,
    fragmentLength: 4000,
  },
  videoCodec: {
    type: 0,
    parameters: {
      profile: H264Profile.MAIN,
      level: H264Level.LEVEL3_2,
      bitRate: 2000,
      iFrameInterval: 4000,
    },
    resolution: [1280, 720, 30],
  },
  audioCodec: {
    type: AudioRecordingCodecType.AAC_LC,
    audioChannels: 1,
    samplerate: AudioRecordingSamplerate.KHZ_32,
    bitrate: 64,
  },
});

const createDelegate = (audioActive = false) => {
  const process = new FakeRecordingProcess();
  const spawnProcess = jest.fn((_command: string, _args: readonly string[]) => process.asChildProcess());
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const delegate = new TuyaRecordingDelegate({
    ffmpegPath: '/test/ffmpeg',
    getInputUrl: async () => 'rtsp://camera-user:camera-password@example.test/live',
    isAudioActive: () => audioActive,
    log,
    spawnProcess,
  });

  delegate.updateRecordingConfiguration(configuration());
  delegate.updateRecordingActive(true);
  return { delegate, log, process, spawnProcess };
};

describe('TuyaRecordingDelegate', () => {
  test('streams complete MP4 initialization and media fragments across arbitrary chunk boundaries', async () => {
    const { delegate, log, process, spawnProcess } = createDelegate();
    const generator = delegate.handleRecordingStreamRequest(41);
    const initializationPromise = generator.next();
    await Promise.resolve();

    const ftyp = mp4Box('ftyp', Buffer.from('isom'));
    const moov = mp4Box('moov', Buffer.from('metadata'));
    const moof = mp4Box('moof', Buffer.from('fragment-header'));
    const mdat = mp4Box('mdat', Buffer.from('fragment-data'));
    const output = Buffer.concat([ftyp, moov, moof, mdat]);
    process.stdout.write(output.subarray(0, 5));
    process.stdout.write(output.subarray(5, moov.length + 9));
    process.stdout.write(output.subarray(moov.length + 9));

    await expect(initializationPromise).resolves.toEqual({
      done: false,
      value: {
        data: Buffer.concat([ftyp, moov]),
        isLast: false,
      },
    });
    await expect(generator.next()).resolves.toEqual({
      done: false,
      value: {
        data: Buffer.concat([moof, mdat]),
        isLast: false,
      },
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args] = spawnProcess.mock.calls[0];
    expect(command).toBe('/test/ffmpeg');
    expect(args).toEqual(expect.arrayContaining([
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level:v', '3.2',
      '-b:v', '2000k',
      '-r', '30',
      '-g', '120',
      '-an',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '4000000',
      'pipe:1',
    ]));

    delegate.closeRecordingStream(41, undefined);
    await expect(generator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(process.kill).not.toHaveBeenCalled();
    delegate.updateRecordingActive(false);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('camera-password');
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('camera-user');
  });

  test('uses the selected AAC settings only while HomeKit recording audio is active', async () => {
    const { delegate, process, spawnProcess } = createDelegate(true);
    const abortController = new AbortController();
    const result = delegate.handleRecordingStreamRequest(12, abortController.signal).next();
    await Promise.resolve();

    expect(spawnProcess.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '-map', '0:a:0',
      '-c:a', 'aac',
      '-profile:a', 'aac_low',
      '-ar', '32000',
      '-ac', '1',
      '-b:a', '64k',
    ]));
    expect(spawnProcess.mock.calls[0][1]).not.toContain('-an');

    abortController.abort();
    await expect(result).resolves.toEqual({ done: true, value: undefined });
    expect(process.kill).not.toHaveBeenCalled();
    delegate.updateRecordingActive(false);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('starts before an HDS request and prepends only the bounded, most recent complete fragment', async () => {
    const { delegate, process, spawnProcess } = createDelegate();
    await flushEventLoop();
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    const ftyp = mp4Box('ftyp');
    const moov = mp4Box('moov');
    const firstFragment = Buffer.concat([
      mp4Box('moof', Buffer.from('first-header')),
      mp4Box('mdat', Buffer.from('first-data')),
    ]);
    const secondFragment = Buffer.concat([
      mp4Box('moof', Buffer.from('second-header')),
      mp4Box('mdat', Buffer.from('second-data')),
    ]);
    process.stdout.write(Buffer.concat([ftyp, moov, firstFragment, secondFragment]));
    await flushEventLoop();

    const generator = delegate.handleRecordingStreamRequest(55);
    await expect(generator.next()).resolves.toEqual({
      done: false,
      value: { data: Buffer.concat([ftyp, moov]), isLast: false },
    });
    await expect(generator.next()).resolves.toEqual({
      done: false,
      value: { data: secondFragment, isLast: false },
    });

    const liveFragment = Buffer.concat([
      mp4Box('moof', Buffer.from('live-header')),
      mp4Box('mdat', Buffer.from('live-data')),
    ]);
    const live = generator.next();
    process.stdout.write(liveFragment);
    await expect(live).resolves.toEqual({
      done: false,
      value: { data: liveFragment, isLast: false },
    });

    delegate.closeRecordingStream(55, undefined);
    await expect(generator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(process.kill).not.toHaveBeenCalled();
    delegate.updateRecordingActive(false);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('pins the trigger window until a delayed HDS request consumes it', async () => {
    const { delegate, process } = createDelegate();
    const initialization = Buffer.concat([mp4Box('ftyp'), mp4Box('moov')]);
    const eventFragment = Buffer.concat([mp4Box('moof', Buffer.from('event')), mp4Box('mdat')]);
    const afterEvent = Buffer.concat([mp4Box('moof', Buffer.from('after')), mp4Box('mdat')]);
    const latest = Buffer.concat([mp4Box('moof', Buffer.from('latest')), mp4Box('mdat')]);
    process.stdout.write(Buffer.concat([initialization, eventFragment]));
    await flushEventLoop();

    delegate.markRecordingEvent();
    process.stdout.write(afterEvent);
    await flushEventLoop();
    delegate.markRecordingEvent(); // A repeated report must not replace the onset window.
    process.stdout.write(latest);
    await flushEventLoop();

    const generator = delegate.handleRecordingStreamRequest(56);
    await expect(generator.next()).resolves.toEqual({
      done: false,
      value: { data: initialization, isLast: false },
    });
    for (const fragment of [eventFragment, afterEvent, latest]) {
      await expect(generator.next()).resolves.toEqual({
        done: false,
        value: { data: fragment, isLast: false },
      });
    }

    delegate.closeRecordingStream(56, undefined);
    await expect(generator.next()).resolves.toEqual({ done: true, value: undefined });
    delegate.updateRecordingActive(false);
  });

  test('rejects requests until recording is both configured and active', async () => {
    const process = new FakeRecordingProcess();
    const spawnProcess = jest.fn((_command: string, _args: readonly string[]) => process.asChildProcess());
    const delegate = new TuyaRecordingDelegate({
      getInputUrl: async () => 'rtsp://example.test/live',
      isAudioActive: () => false,
      spawnProcess,
    });

    await expect(delegate.handleRecordingStreamRequest(1).next())
      .rejects.toThrow('recording is not active');
    delegate.updateRecordingActive(true);
    await expect(delegate.handleRecordingStreamRequest(1).next())
      .rejects.toThrow('recording is not configured');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  test('cancels the current FFmpeg process when the selected configuration is cleared', async () => {
    const { delegate, process } = createDelegate();
    const pending = delegate.handleRecordingStreamRequest(7).next();
    await Promise.resolve();

    delegate.updateRecordingConfiguration(undefined);

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('keeps the current stream on its configuration snapshot and cancels it when recording is disabled', async () => {
    const { delegate, process } = createDelegate();
    const pending = delegate.handleRecordingStreamRequest(17).next();
    await Promise.resolve();
    const nextConfiguration = configuration();
    nextConfiguration.videoCodec.parameters.bitRate = 1500;

    delegate.updateRecordingConfiguration(nextConfiguration);
    expect(process.kill).not.toHaveBeenCalled();

    delegate.updateRecordingActive(false);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('drops complete buffered fragments once the hard wall-clock retention window expires', async () => {
    let now = 100_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { delegate, process } = createDelegate();

    try {
      const ftyp = mp4Box('ftyp');
      const moov = mp4Box('moov');
      const staleFragment = Buffer.concat([
        mp4Box('moof', Buffer.from('stale-header')),
        mp4Box('mdat', Buffer.from('stale-data')),
      ]);
      process.stdout.write(Buffer.concat([ftyp, moov, staleFragment]));
      await flushEventLoop();
      now += 9_000; // 4s prebuffer + one 4s in-progress fragment is the hard wall cap.

      const generator = delegate.handleRecordingStreamRequest(61);
      await expect(generator.next()).resolves.toEqual({
        done: false,
        value: { data: Buffer.concat([ftyp, moov]), isLast: false },
      });

      const freshFragment = Buffer.concat([
        mp4Box('moof', Buffer.from('fresh-header')),
        mp4Box('mdat', Buffer.from('fresh-data')),
      ]);
      const next = generator.next();
      process.stdout.write(freshFragment);
      await expect(next).resolves.toEqual({
        done: false,
        value: { data: freshFragment, isLast: false },
      });

      delegate.closeRecordingStream(61, undefined);
      await expect(generator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      delegate.updateRecordingActive(false);
      nowSpy.mockRestore();
    }
  });

  test('fails the pipeline from an MP4 header before allocating a fragment beyond the hard byte cap', async () => {
    const { delegate, process } = createDelegate();
    const generator = delegate.handleRecordingStreamRequest(62);
    const initialization = generator.next();
    process.stdout.write(Buffer.concat([mp4Box('ftyp'), mp4Box('moov')]));
    await expect(initialization).resolves.toMatchObject({ done: false });

    const oversizedMdatHeader = Buffer.alloc(8);
    oversizedMdatHeader.writeUInt32BE(32 * 1024 * 1024 + 1, 0);
    oversizedMdatHeader.write('mdat', 4, 4, 'ascii');
    const result = generator.next();
    process.stdout.write(Buffer.concat([mp4Box('moof'), oversizedMdatHeader]));

    await expect(result).rejects.toThrow('recording pipeline failed');
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    delegate.updateRecordingActive(false);
  });

  test('disconnects a slow HDS consumer instead of queueing more than the hard live-duration cap', async () => {
    const { delegate, process } = createDelegate();
    const generator = delegate.handleRecordingStreamRequest(63);
    const initialization = generator.next();
    process.stdout.write(Buffer.concat([mp4Box('ftyp'), mp4Box('moov')]));
    await expect(initialization).resolves.toMatchObject({ done: false });

    const fragments: Buffer[] = [];
    for (let index = 0; index < 5; index++) {
      fragments.push(mp4Box('moof', Buffer.from(`header-${index}`)));
      fragments.push(mp4Box('mdat', Buffer.from(`data-${index}`)));
    }
    process.stdout.write(Buffer.concat(fragments));
    await flushEventLoop();

    await expect(generator.next()).rejects.toThrow('consumer exceeded its queue cap');
    expect(process.kill).not.toHaveBeenCalled();
    delegate.updateRecordingActive(false);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('fails closed on malformed fragmented MP4 output', async () => {
    const { delegate, process } = createDelegate();
    const result = delegate.handleRecordingStreamRequest(8).next();
    await Promise.resolve();

    process.stdout.write(mp4Box('moof'));

    await expect(result).rejects.toThrow('recording pipeline failed');
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    delegate.updateRecordingActive(false);
  });

  test('does not turn an unexpected FFmpeg exit into a successful empty recording', async () => {
    const { delegate, process } = createDelegate();
    const result = delegate.handleRecordingStreamRequest(9).next();
    await Promise.resolve();

    process.finish(1);

    await expect(result).rejects.toThrow('recording pipeline failed');
    delegate.updateRecordingActive(false);
  });
});
