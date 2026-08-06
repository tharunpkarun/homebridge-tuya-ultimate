import { EventTriggerOption } from 'homebridge';

import type CameraAccessory from '../src/accessory/CameraAccessory';
import { isEncoderAvailable } from '../src/util/FfmpegStreamingProcess';
import { TuyaRecordingDelegate } from '../src/util/TuyaRecordingDelegate';
import { TuyaStreamingDelegate } from '../src/util/TuyaStreamDelegate';

jest.mock('../src/util/FfmpegStreamingProcess', () => ({
  ...jest.requireActual('../src/util/FfmpegStreamingProcess'),
  isEncoderAvailable: jest.fn(),
}));

class FakeCameraController {
  readonly recordingAudioCharacteristic = {
    value: false,
    on: jest.fn(),
  };
  readonly recordingManagement = {
    recordingManagementService: {
      getCharacteristic: jest.fn(() => this.recordingAudioCharacteristic),
    },
  };

  constructor(readonly options: Record<string, any>) {}
}

const createCamera = () => {
  const motionService = { name: 'motion' };
  const camera = {
    accessory: { displayName: 'Test Camera' },
    platform: {
      api: {
        hap: {
          AudioRecordingCodecType: { AAC_LC: 0 },
          AudioRecordingSamplerate: { KHZ_32: 3 },
          CameraController: FakeCameraController,
          Characteristic: { RecordingAudioActive: 'recording-audio-active' },
          VideoCodecType: { H264: 0 },
        },
      },
    },
    device: { online: true },
    deviceManager: {
      retrieveDeviceRTSP: jest.fn(async () => 'rtsp://example.test/live'),
    },
    getMotionService: jest.fn(() => motionService),
    hasMotionRecordingTrigger: jest.fn(() => true),
  } as unknown as CameraAccessory;

  return { camera, motionService };
};

describe('TuyaStreamingDelegate HKSV integration', () => {
  const encoderAvailable = jest.mocked(isEncoderAvailable);

  beforeEach(() => {
    encoderAvailable.mockReset();
  });

  test('wires the real recording delegate and existing motion service when required encoders exist', async () => {
    encoderAvailable.mockResolvedValue(true);
    const { camera, motionService } = createCamera();

    const stream = await TuyaStreamingDelegate.create(camera);
    const controller = stream.controller as unknown as FakeCameraController;

    expect(controller.options.recording.delegate).toBeInstanceOf(TuyaRecordingDelegate);
    expect(controller.options.recording.options.prebufferLength).toBe(4000);
    expect(controller.options.recording.options.mediaContainerConfiguration).toEqual([
      { type: 0, fragmentLength: 4000 },
    ]);
    expect(controller.options.recording.options.overrideEventTriggerOptions).toEqual([EventTriggerOption.MOTION]);
    expect(controller.options.sensors.motion).toBe(motionService);
    expect(encoderAvailable).toHaveBeenCalledWith(expect.any(String), 'libx264');
    expect(encoderAvailable).toHaveBeenCalledWith(expect.any(String), 'aac');

    stream.configureRecordingAudioActive();
    stream.configureRecordingAudioActive();
    expect(controller.recordingAudioCharacteristic.on).toHaveBeenCalledTimes(1);
    expect(controller.recordingAudioCharacteristic.on).toHaveBeenCalledWith('change', expect.any(Function));
  });

  test('does not advertise HKSV if the installed FFmpeg lacks a required encoder', async () => {
    encoderAvailable.mockImplementation(async (_path, encoder) => encoder !== 'aac');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { camera } = createCamera();

    try {
      const stream = await TuyaStreamingDelegate.create(camera);
      const controller = stream.controller as unknown as FakeCameraController;

      expect(controller.options.recording).toBeUndefined();
      expect(controller.options.sensors).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test('does not advertise HKSV for a stream without a real Tuya motion-event trigger', async () => {
    encoderAvailable.mockResolvedValue(true);
    const { camera } = createCamera();
    jest.mocked(camera.hasMotionRecordingTrigger).mockReturnValue(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const stream = await TuyaStreamingDelegate.create(camera);
      const controller = stream.controller as unknown as FakeCameraController;

      expect(controller.options.recording).toBeUndefined();
      expect(controller.options.sensors).toBeUndefined();
      expect(encoderAvailable).not.toHaveBeenCalledWith(expect.any(String), 'libx264');
      expect(encoderAvailable).not.toHaveBeenCalledWith(expect.any(String), 'aac');
    } finally {
      warn.mockRestore();
    }
  });
});
