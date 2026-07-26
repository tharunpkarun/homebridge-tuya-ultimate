import { convertSharingStatus, TuyaSharingStrategyConfig } from '../src/core/TuyaSharingStrategy';

function config(
  code: string,
  valueType = 'Integer',
  valueDesc = '{"min":0,"max":100}',
  enumMappingMap?: TuyaSharingStrategyConfig['enumMappingMap'],
): TuyaSharingStrategyConfig {
  return {
    statusFormat: JSON.stringify({ [code]: '$' }),
    valueType,
    valueDesc,
    enumMappingMap,
  };
}

describe('Tuya raw datapoint conversion', () => {
  test('uses Tuya defaults for missing values', () => {
    expect(convertSharingStatus('default', null, config('switch', 'Boolean'))).toEqual({
      code: 'switch',
      value: false,
    });
    expect(convertSharingStatus('default', '', config('mode', 'Enum', '{"range":["auto","manual"]}')))
      .toEqual({ code: 'mode', value: 'auto' });
  });

  test('maps enum keys case-insensitively', () => {
    expect(convertSharingStatus('enum', 'COOL', config('mode', 'Enum', '{"range":["off"]}', {
      cool: { value: 'cold' },
    }))).toEqual({ code: 'mode', value: 'cold' });
  });

  test('decodes Tuya circuit voltage, current, and power', () => {
    const raw = Buffer.alloc(8);
    raw.writeUInt16BE(2375, 0);
    raw.writeUIntBE(12422, 2, 3);
    raw.writeUIntBE(1710, 5, 3);

    const converted = convertSharingStatus('db_v1_params', raw.toString('base64'), config('phase_a'));
    expect(converted.code).toBe('phase_a');
    expect(JSON.parse(String(converted.value))).toEqual({
      voltage: 237.5,
      electricCurrent: 12.422,
      power: 1.71,
    });
  });

  test('decodes timer bitsets and minute values', () => {
    const raw = Buffer.from([1, 0b00101010, 0, 90, 5, 160]);
    const converted = convertSharingStatus('cz_timer1_alg', raw.toString('base64'), config('timer'));
    expect(JSON.parse(String(converted.value))).toEqual([{
      timer_switch: true,
      week_day: [1, 3, 5],
      start_time: '01:30',
      end_time: '24:00',
    }]);
  });

  test('fails closed on an unknown strategy instead of publishing a wrong value', () => {
    expect(() => convertSharingStatus('unknown-converter', 1, config('value')))
      .toThrow('Unsupported Tuya sharing conversion strategy');
  });
});
