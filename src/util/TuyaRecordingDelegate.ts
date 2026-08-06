import { defaultFfmpegPath } from '@homebridge/camera-utils';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import {
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  H264Level,
  H264Profile,
  HDSProtocolSpecificErrorReason,
  MediaContainerType,
  RecordingPacket,
} from 'homebridge';

import type Logger from './Logger';

const MAX_INITIALIZATION_BYTES = 4 * 1024 * 1024;
const MAX_PREBUFFER_BYTES = 32 * 1024 * 1024;
const MAX_MP4_BOX_SIZE = MAX_PREBUFFER_BYTES;
const MAX_SUBSCRIBER_QUEUE_BYTES = 32 * 1024 * 1024;
const MAX_SUBSCRIBER_QUEUE_DURATION_MS = 16 * 1000;
const MAX_PREBUFFER_DURATION_MS = 8 * 1000;
const MAX_FRAGMENT_DURATION_MS = 8 * 1000;
const EVENT_WINDOW_HOLD_MS = 10 * 1000;
const MAX_EVENT_WINDOW_DURATION_MS = 16 * 1000;
const PIPELINE_READY_TIMEOUT_MS = 15 * 1000;
const PIPELINE_RETRY_DELAY_MS = 5 * 1000;
const PROCESS_STOP_TIMEOUT_MS = 2 * 1000;
const H264_VIDEO_CODEC_TYPE = 0;

type RecordingProcessSpawner = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface TuyaRecordingDelegateOptions {
  getInputUrl: () => Promise<string>;
  isAudioActive: () => boolean;
  ffmpegPath?: string;
  log?: Logger;
  spawnProcess?: RecordingProcessSpawner;
}

interface BufferedFragment {
  data: Buffer;
  duration: number;
  completedAt: number;
}

interface SubscriberResult {
  data?: Buffer;
  done?: boolean;
  error?: Error;
}

interface RecordingSubscriber {
  fragments: BufferedFragment[];
  queuedBytes: number;
  queuedDuration: number;
  closed: boolean;
  error?: Error;
  waiter?: (result: SubscriberResult) => void;
}

interface RecordingPipeline {
  readonly configuration: CameraRecordingConfiguration;
  readonly configurationKey: string;
  readonly audioActive: boolean;
  cancelled: boolean;
  failure?: Error;
  process?: ChildProcessWithoutNullStreams;
  processStopRequested?: boolean;
  stopTimer?: NodeJS.Timeout;
  initialization?: Buffer;
  fragments: BufferedFragment[];
  bufferedBytes: number;
  bufferedDuration: number;
  subscribers: Set<RecordingSubscriber>;
  readyWaiters: Set<(error?: Error) => void>;
}

interface RecordingSession {
  readonly streamId: number;
  cancelled: boolean;
  pipeline?: RecordingPipeline;
  subscriber?: RecordingSubscriber;
  cancelReadyWait?: () => void;
}

interface RecordingEventWindow {
  readonly pipeline: RecordingPipeline;
  fragments: BufferedFragment[];
  bytes: number;
  duration: number;
  timer: NodeJS.Timeout;
}

interface ProcessResult {
  code: number | null;
  error?: Error;
}

interface Mp4Box {
  type: string;
  data: Buffer;
}

class FragmentedMp4Parser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Mp4Box[] {
    if (chunk.length === 0) {
      return [];
    }

    if (chunk.length > MAX_MP4_BOX_SIZE || this.buffer.length > MAX_MP4_BOX_SIZE - chunk.length) {
      throw new Error('FFmpeg produced an MP4 box that is too large.');
    }

    this.buffer = this.buffer.length === 0
      ? chunk
      : Buffer.concat([this.buffer, chunk]);

    const boxes: Mp4Box[] = [];
    while (this.buffer.length >= 8) {
      const size32 = this.buffer.readUInt32BE(0);
      let headerSize = 8;
      let boxSize: number;

      if (size32 === 0) {
        throw new Error('FFmpeg produced an MP4 box with an unsupported open-ended size.');
      } else if (size32 === 1) {
        if (this.buffer.length < 16) {
          break;
        }

        headerSize = 16;
        const extendedSize = this.buffer.readBigUInt64BE(8);
        if (extendedSize > BigInt(MAX_MP4_BOX_SIZE)) {
          throw new Error('FFmpeg produced an MP4 box that is too large.');
        }
        boxSize = Number(extendedSize);
      } else {
        boxSize = size32;
      }

      if (boxSize < headerSize) {
        throw new Error('FFmpeg produced an invalid MP4 box size.');
      }
      if (boxSize > MAX_MP4_BOX_SIZE) {
        throw new Error('FFmpeg produced an MP4 box that is too large.');
      }
      if (this.buffer.length < boxSize) {
        break;
      }

      boxes.push({
        type: this.buffer.toString('ascii', 4, 8),
        data: this.buffer.subarray(0, boxSize),
      });
      this.buffer = this.buffer.subarray(boxSize);
    }

    if (this.buffer.length > MAX_MP4_BOX_SIZE) {
      throw new Error('FFmpeg produced invalid fragmented MP4 data.');
    }

    return boxes;
  }

  assertComplete(): void {
    if (this.buffer.length !== 0) {
      throw new Error('FFmpeg ended with an incomplete MP4 box.');
    }
  }
}

export class TuyaRecordingDelegate implements CameraRecordingDelegate {
  private recordingActive = false;
  private recordingAudioActive?: boolean;
  private configuration?: CameraRecordingConfiguration;
  private pipeline?: RecordingPipeline;
  private currentSession?: RecordingSession;
  private retryTimer?: NodeJS.Timeout;
  private eventWindow?: RecordingEventWindow;

  private readonly ffmpegPath: string;
  private readonly getInputUrl: () => Promise<string>;
  private readonly isAudioActive: () => boolean;
  private readonly log?: Logger;
  private readonly spawnProcess: RecordingProcessSpawner;

  constructor(options: TuyaRecordingDelegateOptions) {
    this.ffmpegPath = options.ffmpegPath ?? defaultFfmpegPath;
    this.getInputUrl = options.getInputUrl;
    this.isAudioActive = options.isAudioActive;
    this.log = options.log;
    this.spawnProcess = options.spawnProcess ?? ((command, args) => spawn(command, args, { env: process.env }));
  }

  updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    if (!active) {
      this.cancelCurrentSession();
    }
    this.reconcilePipeline();
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration ? this.cloneConfiguration(configuration) : undefined;
    if (!configuration) {
      this.cancelCurrentSession();
    }
    this.reconcilePipeline();
  }

  updateRecordingAudioActive(active: boolean): void {
    if (this.recordingAudioActive === active) {
      return;
    }

    this.recordingAudioActive = active;
    if (this.pipeline && this.pipeline.audioActive !== active) {
      // Audio privacy changes take effect immediately, even if that means ending
      // the current download and letting HomeKit retry with a fresh pipeline.
      this.cancelCurrentSession();
      this.stopPipeline(this.pipeline);
    }
    this.reconcilePipeline();
  }

  async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    if (!this.recordingActive) {
      throw new Error('HomeKit Secure Video recording is not active.');
    }
    if (!this.configuration) {
      throw new Error('HomeKit Secure Video recording is not configured.');
    }
    if (this.currentSession) {
      throw new Error('A HomeKit Secure Video recording stream is already active.');
    }

    this.reconcilePipeline(true);
    const pipeline = this.pipeline;
    if (!pipeline) {
      throw new Error('HomeKit Secure Video recording pipeline is unavailable.');
    }

    const session: RecordingSession = { streamId, cancelled: false, pipeline };
    this.currentSession = session;
    const abortHandler = () => this.stopSession(session);
    signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      if (signal?.aborted) {
        this.stopSession(session);
        return;
      }

      const readyError = await this.waitForPipelineReady(pipeline, session);
      if (session.cancelled) {
        return;
      }
      if (readyError || !pipeline.initialization || pipeline.cancelled) {
        throw readyError ?? new Error('HomeKit Secure Video recording pipeline stopped before it became ready.');
      }

      // Snapshot and subscribe without awaiting between the two operations. This
      // makes the buffered/live hand-off gap-free in the JavaScript event loop.
      const subscriber = this.createSubscriber(pipeline);
      const initialization = pipeline.initialization;
      const prebuffer = this.takeEventWindow(pipeline);
      session.subscriber = subscriber;

      yield { data: initialization, isLast: false };
      for (const fragment of prebuffer) {
        if (session.cancelled) {
          return;
        }
        yield { data: fragment, isLast: false };
      }

      while (!session.cancelled) {
        const result = await this.nextSubscriberResult(subscriber);
        if (session.cancelled || result.done) {
          return;
        }
        if (result.error) {
          throw result.error;
        }
        if (result.data) {
          yield { data: result.data, isLast: false };
        }
      }
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      this.stopSession(session);
      if (session.subscriber && session.pipeline) {
        this.closeSubscriber(session.pipeline, session.subscriber);
      }
      if (this.currentSession === session) {
        this.currentSession = undefined;
      }
      this.log?.debug('Stopped HomeKit Secure Video recording stream %d.', streamId);
      this.reconcilePipeline();
    }
  }

  acknowledgeStream(streamId: number): void {
    if (this.currentSession?.streamId === streamId) {
      this.stopSession(this.currentSession);
    }
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    void reason;
    if (this.currentSession?.streamId === streamId) {
      this.stopSession(this.currentSession);
    }
  }

  /** Pins pre-trigger and subsequent fragments until HDS requests the event. */
  markRecordingEvent(): void {
    const pipeline = this.pipeline;
    if (!pipeline || pipeline.cancelled) {
      return;
    }
    if (this.eventWindow?.pipeline === pipeline) {
      return;
    }
    this.clearEventWindow();
    this.prunePrebuffer(pipeline);
    const fragments = [...pipeline.fragments];
    const eventWindow: RecordingEventWindow = {
      pipeline,
      fragments,
      bytes: fragments.reduce((total, fragment) => total + fragment.data.length, 0),
      duration: fragments.reduce((total, fragment) => total + fragment.duration, 0),
      timer: setTimeout(() => this.clearEventWindow(eventWindow), EVENT_WINDOW_HOLD_MS),
    };
    eventWindow.timer.unref();
    this.eventWindow = eventWindow;
  }

  private reconcilePipeline(forceRetry = false): void {
    if (forceRetry && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }

    if (!this.recordingActive || !this.configuration) {
      this.clearRetryTimer();
      if (this.pipeline) {
        this.stopPipeline(this.pipeline);
      }
      return;
    }

    // A selected configuration change must not alter an in-flight recording.
    // The desired pipeline will be started when that stream closes.
    if (this.currentSession) {
      return;
    }

    let configuration: CameraRecordingConfiguration;
    let audioActive: boolean;
    try {
      configuration = this.cloneConfiguration(this.configuration);
      this.validateConfiguration(configuration);
      audioActive = this.recordingAudioActive ?? this.isAudioActive();
    } catch {
      this.log?.error('HomeKit Secure Video recording configuration is invalid.');
      if (this.pipeline) {
        this.stopPipeline(this.pipeline);
      }
      return;
    }

    const configurationKey = JSON.stringify(configuration);
    if (this.pipeline
      && !this.pipeline.cancelled
      && this.pipeline.configurationKey === configurationKey
      && this.pipeline.audioActive === audioActive) {
      return;
    }

    if (this.pipeline) {
      this.stopPipeline(this.pipeline);
    }
    this.clearRetryTimer();

    const pipeline: RecordingPipeline = {
      configuration,
      configurationKey,
      audioActive,
      cancelled: false,
      fragments: [],
      bufferedBytes: 0,
      bufferedDuration: 0,
      subscribers: new Set(),
      readyWaiters: new Set(),
    };
    this.pipeline = pipeline;
    void this.runPipeline(pipeline);
  }

  private async runPipeline(pipeline: RecordingPipeline): Promise<void> {
    try {
      const inputUrl = await this.getInputUrl();
      if (pipeline.cancelled) {
        return;
      }
      if (typeof inputUrl !== 'string' || inputUrl.trim().length === 0) {
        throw new Error('No camera recording input is available.');
      }

      const args = this.buildFfmpegArguments(inputUrl, pipeline.configuration, pipeline.audioActive);
      const child = this.spawnProcess(this.ffmpegPath, args);
      pipeline.process = child;
      child.once('close', () => {
        if (pipeline.stopTimer) {
          clearTimeout(pipeline.stopTimer);
          pipeline.stopTimer = undefined;
        }
      });
      child.stderr.resume(); // Drain FFmpeg diagnostics without logging URLs or credentials.
      this.log?.debug('Started HomeKit Secure Video rolling recording buffer.');

      const completion = this.waitForProcess(child);
      const parser = new FragmentedMp4Parser();
      let initializationBoxes: Buffer[] = [];
      let initializationBytes = 0;
      let fragmentBoxes: Buffer[] = [];
      let fragmentBytes = 0;

      for await (const chunk of child.stdout) {
        if (pipeline.cancelled) {
          break;
        }

        for (const box of parser.push(Buffer.from(chunk))) {
          if (pipeline.cancelled) {
            break;
          }

          if (!pipeline.initialization) {
            if (box.type === 'moof' || box.type === 'mdat') {
              throw new Error('FFmpeg produced media before the MP4 initialization segment.');
            }
            initializationBoxes.push(box.data);
            initializationBytes += box.data.length;
            if (initializationBytes > MAX_INITIALIZATION_BYTES) {
              throw new Error('FFmpeg produced an oversized MP4 initialization segment.');
            }
            if (box.type === 'moov') {
              const initialization = Buffer.concat(initializationBoxes);
              pipeline.initialization = initialization;
              initializationBoxes = [];
              initializationBytes = 0;
              this.notifyPipelineReady(pipeline);
            }
            continue;
          }

          if (box.type === 'moof') {
            if (fragmentBoxes.length !== 0) {
              throw new Error('FFmpeg started a new MP4 fragment before finishing the previous fragment.');
            }
            fragmentBoxes.push(box.data);
            fragmentBytes = box.data.length;
          } else if (box.type === 'mdat') {
            if (fragmentBoxes.length === 0) {
              throw new Error('FFmpeg produced MP4 media data without a fragment header.');
            }
            fragmentBoxes.push(box.data);
            fragmentBytes += box.data.length;
            if (fragmentBytes > MAX_PREBUFFER_BYTES) {
              throw new Error('FFmpeg produced an MP4 fragment that exceeds the recording memory cap.');
            }
            const fragment = Buffer.concat(fragmentBoxes);
            fragmentBoxes = [];
            fragmentBytes = 0;
            this.publishFragment(pipeline, fragment);
          } else if (fragmentBoxes.length !== 0) {
            fragmentBoxes.push(box.data);
            fragmentBytes += box.data.length;
            if (fragmentBytes > MAX_PREBUFFER_BYTES) {
              throw new Error('FFmpeg produced an MP4 fragment that exceeds the recording memory cap.');
            }
          }
        }
      }

      const result = await completion;
      if (pipeline.cancelled) {
        return;
      }

      parser.assertComplete();
      if (result.error || result.code !== 0 || !pipeline.initialization || fragmentBoxes.length !== 0) {
        throw new Error('HomeKit Secure Video FFmpeg process ended unexpectedly.');
      }
      throw new Error('HomeKit Secure Video FFmpeg process ended unexpectedly.');
    } catch {
      if (!pipeline.cancelled) {
        this.failPipeline(pipeline);
      }
    } finally {
      this.terminatePipelineProcess(pipeline);
    }
  }

  private publishFragment(pipeline: RecordingPipeline, data: Buffer): void {
    if (data.length > MAX_PREBUFFER_BYTES) {
      throw new Error('FFmpeg produced an MP4 fragment that exceeds the recording memory cap.');
    }

    const duration = pipeline.configuration.mediaContainerConfiguration.fragmentLength;
    const fragment = { data, duration, completedAt: Date.now() };
    pipeline.fragments.push(fragment);
    pipeline.bufferedBytes += data.length;
    pipeline.bufferedDuration += duration;
    this.prunePrebuffer(pipeline);

    const eventWindow = this.eventWindow;
    if (eventWindow?.pipeline === pipeline) {
      if (eventWindow.bytes + data.length > MAX_PREBUFFER_BYTES
        || eventWindow.duration + duration > MAX_EVENT_WINDOW_DURATION_MS) {
        this.clearEventWindow(eventWindow);
        this.log?.warn('HomeKit Secure Video event window exceeded its memory or duration cap.');
      } else {
        eventWindow.fragments.push(fragment);
        eventWindow.bytes += data.length;
        eventWindow.duration += duration;
      }
    }

    for (const subscriber of [...pipeline.subscribers]) {
      this.enqueueSubscriberFragment(pipeline, subscriber, data, duration);
    }
  }

  private prunePrebuffer(pipeline: RecordingPipeline): void {
    const configuredDuration = Math.min(
      pipeline.configuration.prebufferLength,
      MAX_PREBUFFER_DURATION_MS,
    );
    const fragmentDuration = pipeline.configuration.mediaContainerConfiguration.fragmentLength;
    const oldestAllowed = Date.now() - configuredDuration - fragmentDuration;

    while (pipeline.fragments.length > 0
      && (pipeline.bufferedBytes > MAX_PREBUFFER_BYTES
        || configuredDuration === 0
        || (pipeline.bufferedDuration > configuredDuration && pipeline.fragments.length > 1)
        || pipeline.fragments[0].completedAt < oldestAllowed)) {
      const removed = pipeline.fragments.shift()!;
      pipeline.bufferedBytes -= removed.data.length;
      pipeline.bufferedDuration -= removed.duration;
    }
  }

  private takeEventWindow(pipeline: RecordingPipeline): Buffer[] {
    const eventWindow = this.eventWindow;
    if (eventWindow?.pipeline === pipeline) {
      const fragments = eventWindow.fragments.map(fragment => fragment.data);
      this.clearEventWindow(eventWindow);
      return fragments;
    }
    this.prunePrebuffer(pipeline);
    return pipeline.fragments.map(fragment => fragment.data);
  }

  private clearEventWindow(target = this.eventWindow): void {
    if (!target) {
      return;
    }
    clearTimeout(target.timer);
    target.fragments = [];
    target.bytes = 0;
    target.duration = 0;
    if (this.eventWindow === target) {
      this.eventWindow = undefined;
    }
  }

  private createSubscriber(pipeline: RecordingPipeline): RecordingSubscriber {
    const subscriber: RecordingSubscriber = {
      fragments: [],
      queuedBytes: 0,
      queuedDuration: 0,
      closed: false,
    };
    pipeline.subscribers.add(subscriber);
    this.log?.debug('Started HomeKit Secure Video recording stream from rolling buffer.');
    return subscriber;
  }

  private enqueueSubscriberFragment(
    pipeline: RecordingPipeline,
    subscriber: RecordingSubscriber,
    data: Buffer,
    duration: number,
  ): void {
    if (subscriber.closed) {
      return;
    }
    if (subscriber.waiter) {
      const waiter = subscriber.waiter;
      subscriber.waiter = undefined;
      waiter({ data });
      return;
    }
    if (subscriber.queuedBytes + data.length > MAX_SUBSCRIBER_QUEUE_BYTES
      || subscriber.queuedDuration + duration > MAX_SUBSCRIBER_QUEUE_DURATION_MS) {
      this.closeSubscriber(
        pipeline,
        subscriber,
        new Error('HomeKit Secure Video recording consumer exceeded its queue cap.'),
      );
      return;
    }

    subscriber.fragments.push({ data, duration, completedAt: Date.now() });
    subscriber.queuedBytes += data.length;
    subscriber.queuedDuration += duration;
  }

  private nextSubscriberResult(subscriber: RecordingSubscriber): Promise<SubscriberResult> {
    const fragment = subscriber.fragments.shift();
    if (fragment) {
      subscriber.queuedBytes -= fragment.data.length;
      subscriber.queuedDuration -= fragment.duration;
      return Promise.resolve({ data: fragment.data });
    }
    if (subscriber.closed) {
      return Promise.resolve(subscriber.error ? { error: subscriber.error } : { done: true });
    }
    return new Promise(resolve => {
      subscriber.waiter = resolve;
    });
  }

  private closeSubscriber(
    pipeline: RecordingPipeline,
    subscriber: RecordingSubscriber,
    error?: Error,
  ): void {
    if (subscriber.closed) {
      return;
    }

    subscriber.closed = true;
    subscriber.error = error;
    subscriber.fragments = [];
    subscriber.queuedBytes = 0;
    subscriber.queuedDuration = 0;
    pipeline.subscribers.delete(subscriber);
    if (subscriber.waiter) {
      const waiter = subscriber.waiter;
      subscriber.waiter = undefined;
      waiter(error ? { error } : { done: true });
    }
  }

  private waitForPipelineReady(
    pipeline: RecordingPipeline,
    session: RecordingSession,
  ): Promise<Error | undefined> {
    if (pipeline.initialization) {
      return Promise.resolve(undefined);
    }
    if (pipeline.failure) {
      return Promise.resolve(pipeline.failure);
    }

    return new Promise(resolve => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        pipeline.readyWaiters.delete(waiter);
        session.cancelReadyWait = undefined;
        resolve(error);
      };
      const waiter = (error?: Error) => finish(error);
      const timeout = setTimeout(() => {
        finish(new Error('HomeKit Secure Video recording pipeline did not become ready in time.'));
      }, PIPELINE_READY_TIMEOUT_MS);
      timeout.unref();
      pipeline.readyWaiters.add(waiter);
      session.cancelReadyWait = () => finish();
    });
  }

  private notifyPipelineReady(pipeline: RecordingPipeline, error?: Error): void {
    for (const waiter of [...pipeline.readyWaiters]) {
      waiter(error);
    }
    pipeline.readyWaiters.clear();
  }

  private failPipeline(pipeline: RecordingPipeline): void {
    const error = new Error('HomeKit Secure Video recording pipeline failed.');
    pipeline.failure = error;
    pipeline.cancelled = true;
    if (this.eventWindow?.pipeline === pipeline) {
      this.clearEventWindow();
    }
    this.notifyPipelineReady(pipeline, error);
    for (const subscriber of [...pipeline.subscribers]) {
      this.closeSubscriber(pipeline, subscriber, error);
    }
    this.terminatePipelineProcess(pipeline);
    if (this.pipeline === pipeline) {
      this.pipeline = undefined;
    }
    this.log?.warn('HomeKit Secure Video rolling recording buffer failed; retrying with a fresh input.');

    if (!this.currentSession) {
      this.schedulePipelineRetry();
    }
  }

  private stopPipeline(pipeline: RecordingPipeline): void {
    if (pipeline.cancelled) {
      if (this.pipeline === pipeline) {
        this.pipeline = undefined;
      }
      return;
    }

    pipeline.cancelled = true;
    if (this.eventWindow?.pipeline === pipeline) {
      this.clearEventWindow();
    }
    const error = new Error('HomeKit Secure Video recording pipeline stopped.');
    this.notifyPipelineReady(pipeline, error);
    for (const subscriber of [...pipeline.subscribers]) {
      this.closeSubscriber(pipeline, subscriber);
    }
    pipeline.fragments = [];
    pipeline.bufferedBytes = 0;
    pipeline.bufferedDuration = 0;
    pipeline.initialization = undefined;
    this.terminatePipelineProcess(pipeline);
    if (this.pipeline === pipeline) {
      this.pipeline = undefined;
    }
  }

  private terminatePipelineProcess(pipeline: RecordingPipeline): void {
    if (pipeline.processStopRequested) {
      return;
    }

    const child = pipeline.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    pipeline.processStopRequested = true;
    child.kill('SIGTERM');
    pipeline.stopTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, PROCESS_STOP_TIMEOUT_MS);
    pipeline.stopTimer.unref();
  }

  private schedulePipelineRetry(): void {
    if (this.retryTimer || !this.recordingActive || !this.configuration) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.reconcilePipeline();
    }, PIPELINE_RETRY_DELAY_MS);
    this.retryTimer.unref();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private cancelCurrentSession(): void {
    if (this.currentSession) {
      this.stopSession(this.currentSession);
    }
  }

  private stopSession(session: RecordingSession): void {
    if (session.cancelled) {
      return;
    }

    session.cancelled = true;
    session.cancelReadyWait?.();
    if (session.subscriber && session.pipeline) {
      this.closeSubscriber(session.pipeline, session.subscriber);
    }
  }

  private waitForProcess(child: ChildProcessWithoutNullStreams): Promise<ProcessResult> {
    return new Promise(resolve => {
      let settled = false;
      const settle = (result: ProcessResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      child.once('error', error => settle({ code: null, error }));
      child.once('close', code => settle({ code }));
    });
  }

  private buildFfmpegArguments(
    inputUrl: string,
    configuration: CameraRecordingConfiguration,
    includeAudio: boolean,
  ): string[] {
    const [width, height, fps] = configuration.videoCodec.resolution;
    const videoParameters = configuration.videoCodec.parameters;
    const fragmentLength = configuration.mediaContainerConfiguration.fragmentLength;
    const keyFrameInterval = Math.max(1, Math.round(fps * videoParameters.iFrameInterval / 1000));
    const fragmentSeconds = fragmentLength / 1000;

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-rtsp_transport', 'tcp',
      '-i', inputUrl,
      '-map', '0:v:0',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', this.profileName(videoParameters.profile),
      '-level:v', this.levelName(videoParameters.level),
      '-b:v', `${videoParameters.bitRate}k`,
      '-maxrate', `${videoParameters.bitRate}k`,
      '-bufsize', `${videoParameters.bitRate * 2}k`,
      '-r', fps.toString(),
      '-g', keyFrameInterval.toString(),
      '-keyint_min', keyFrameInterval.toString(),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${fragmentSeconds})`,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    ];

    if (includeAudio) {
      const audio = configuration.audioCodec;
      args.push(
        '-map', '0:a:0',
        '-c:a', 'aac',
        '-profile:a', 'aac_low',
        '-ar', this.audioSampleRate(audio.samplerate).toString(),
        '-ac', (audio.audioChannels ?? 1).toString(),
        '-b:a', `${audio.bitrate}k`,
      );
    } else {
      args.push('-an');
    }

    args.push(
      '-f', 'mp4',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', Math.round(fragmentLength * 1000).toString(),
      '-reset_timestamps', '1',
      'pipe:1',
    );
    return args;
  }

  private validateConfiguration(configuration: CameraRecordingConfiguration): void {
    const [width, height, fps] = configuration.videoCodec.resolution;
    const video = configuration.videoCodec.parameters;
    const audio = configuration.audioCodec;
    const fragmentLength = configuration.mediaContainerConfiguration.fragmentLength;

    if (configuration.mediaContainerConfiguration.type !== MediaContainerType.FRAGMENTED_MP4) {
      throw new Error('Unsupported HomeKit Secure Video media container.');
    }
    if (configuration.videoCodec.type !== H264_VIDEO_CODEC_TYPE) {
      throw new Error('Unsupported HomeKit Secure Video codec.');
    }
    if (![width, height, fps].every(Number.isInteger)
      || width < 1 || width > 7680 || height < 1 || height > 4320 || fps < 1 || fps > 120) {
      throw new Error('Invalid HomeKit Secure Video resolution.');
    }
    if (!Number.isInteger(configuration.prebufferLength)
      || configuration.prebufferLength < 0
      || configuration.prebufferLength > MAX_PREBUFFER_DURATION_MS) {
      throw new Error('Invalid HomeKit Secure Video prebuffer length.');
    }
    if (!Number.isInteger(fragmentLength) || fragmentLength < 250 || fragmentLength > MAX_FRAGMENT_DURATION_MS) {
      throw new Error('Invalid HomeKit Secure Video fragment length.');
    }
    if (!Number.isInteger(video.bitRate) || video.bitRate < 1 || video.bitRate > 100 * 1000) {
      throw new Error('Invalid HomeKit Secure Video bitrate.');
    }
    if (!Number.isInteger(video.iFrameInterval) || video.iFrameInterval < 1 || video.iFrameInterval > 60 * 1000) {
      throw new Error('Invalid HomeKit Secure Video key frame interval.');
    }
    this.profileName(video.profile);
    this.levelName(video.level);

    if (audio.type !== AudioRecordingCodecType.AAC_LC) {
      throw new Error('Unsupported HomeKit Secure Video audio codec.');
    }
    if (!Number.isInteger(audio.audioChannels ?? 1)
      || (audio.audioChannels ?? 1) < 1 || (audio.audioChannels ?? 1) > 2) {
      throw new Error('Invalid HomeKit Secure Video audio channel count.');
    }
    if (!Number.isInteger(audio.bitrate) || audio.bitrate < 1 || audio.bitrate > 512) {
      throw new Error('Invalid HomeKit Secure Video audio bitrate.');
    }
    this.audioSampleRate(audio.samplerate);
  }

  private profileName(profile: H264Profile): string {
    switch (profile) {
      case H264Profile.BASELINE:
        return 'baseline';
      case H264Profile.MAIN:
        return 'main';
      case H264Profile.HIGH:
        return 'high';
      default:
        throw new Error('Unsupported HomeKit Secure Video H.264 profile.');
    }
  }

  private levelName(level: H264Level): string {
    switch (level) {
      case H264Level.LEVEL3_1:
        return '3.1';
      case H264Level.LEVEL3_2:
        return '3.2';
      case H264Level.LEVEL4_0:
        return '4.0';
      default:
        throw new Error('Unsupported HomeKit Secure Video H.264 level.');
    }
  }

  private audioSampleRate(samplerate: AudioRecordingSamplerate): number {
    switch (samplerate) {
      case AudioRecordingSamplerate.KHZ_8:
        return 8000;
      case AudioRecordingSamplerate.KHZ_16:
        return 16000;
      case AudioRecordingSamplerate.KHZ_24:
        return 24000;
      case AudioRecordingSamplerate.KHZ_32:
        return 32000;
      case AudioRecordingSamplerate.KHZ_44_1:
        return 44100;
      case AudioRecordingSamplerate.KHZ_48:
        return 48000;
      default:
        throw new Error('Unsupported HomeKit Secure Video audio sample rate.');
    }
  }

  private cloneConfiguration(configuration: CameraRecordingConfiguration): CameraRecordingConfiguration {
    return {
      ...configuration,
      eventTriggerTypes: [...configuration.eventTriggerTypes],
      mediaContainerConfiguration: { ...configuration.mediaContainerConfiguration },
      videoCodec: {
        ...configuration.videoCodec,
        parameters: { ...configuration.videoCodec.parameters },
        resolution: [...configuration.videoCodec.resolution],
      },
      audioCodec: { ...configuration.audioCodec },
    };
  }
}
