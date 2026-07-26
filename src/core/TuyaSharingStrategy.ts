/**
 * Status converters used when Tuya MQTT reports a raw dpId instead of a
 * normalized status code. These mirror tuya-device-sharing-sdk's strategy_repo.
 */

export type TuyaSharingStrategyConfig = {
  statusFormat: string;
  valueDesc: string;
  valueType: string;
  enumMappingMap?: Record<string, { value?: unknown }>;
  pid?: string;
};

type Converter = (value: unknown, config: TuyaSharingStrategyConfig) => unknown;

export function convertSharingStatus(
  strategy: string,
  value: unknown,
  config: TuyaSharingStrategyConfig,
): { code: string; value: unknown } {
  const code = Object.keys(JSON.parse(config.statusFormat))[0];
  const converter = converters[strategy];
  if (!converter) {
    throw new Error(`Unsupported Tuya sharing conversion strategy: ${strategy}`);
  }
  return { code, value: converter(value, config) };
}

function defaultValue(config: TuyaSharingStrategyConfig): unknown {
  const description = parseJson(config.valueDesc, {});
  switch (capitalize(config.valueType)) {
    case 'Boolean': return false;
    case 'Integer': return description.min;
    case 'Enum': return description.range?.[0] ?? '';
    default: return '';
  }
}

function defaultConvert(value: unknown, config: TuyaSharingStrategyConfig): unknown {
  return value !== null && value !== undefined && value !== '' ? value : defaultValue(config);
}

function enumConvert(value: unknown, config: TuyaSharingStrategyConfig): unknown {
  const key = String(value);
  const mappings = config.enumMappingMap ?? {};
  return mappings[key]?.value ?? mappings[key.toLowerCase()]?.value ?? defaultValue(config);
}

function rawBytes(value: unknown): Buffer {
  return Buffer.from(String(value), 'base64');
}

function rawHex(value: unknown): string {
  return rawBytes(value).toString('hex');
}

function hex(value: string): number {
  return value ? Number.parseInt(value, 16) || 0 : 0;
}

function dbParams(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  const data = rawBytes(value);
  return JSON.stringify({
    voltage: data.readUInt16BE(0) / 10,
    electricCurrent: data.readUIntBE(2, 3) / 1000,
    power: data.readUIntBE(5, 3) / 1000,
  });
}

const ALARMS: Record<number, { alarmCode: string; scale?: number }> = {
  1: { alarmCode: 'overcurrent', scale: 0 },
  2: { alarmCode: 'three_phase_current_imbalance', scale: 0 },
  3: { alarmCode: 'ammeter_overvoltage', scale: 0 },
  4: { alarmCode: 'under_voltage', scale: 0 },
  5: { alarmCode: 'three_phase_current_loss' },
  6: { alarmCode: 'power_failure' },
  7: { alarmCode: 'magnetic' },
  8: { alarmCode: 'insufficient_balance', scale: 0 },
  9: { alarmCode: 'arrears' },
  10: { alarmCode: 'battery_overvoltage', scale: 2 },
  11: { alarmCode: 'cover_open' },
  12: { alarmCode: 'meter_cover_open' },
  13: { alarmCode: 'fault' },
};

function dbAlarm(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  const data = rawHex(value);
  const alarms: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset + 8 <= data.length; offset += 8) {
    const item = data.slice(offset, offset + 8);
    const definition = ALARMS[hex(item.slice(0, 2))];
    if (!definition) {
      continue;
    }
    const alarm: Record<string, unknown> = {
      alarmCode: definition.alarmCode,
      doAction: hex(item.slice(2, 4)) === 1,
    };
    if (definition.scale !== undefined) {
      const threshold = hex(item.slice(4, 8)) / 10 ** definition.scale;
      alarm.threshold = definition.scale > 0 ? String(threshold) : String(Math.trunc(threshold));
    }
    alarms.push(alarm);
  }
  return JSON.stringify(alarms);
}

function dbDaily(value: unknown): string {
  const data = rawHex(value);
  return JSON.stringify({
    startMonth: hex(data.slice(0, 2)),
    startDay: hex(data.slice(2, 4)),
    endMonth: hex(data.slice(4, 6)),
    endDay: hex(data.slice(6, 8)),
    electricTotal: hex(data.slice(8, 16)) / 100,
  });
}

function dbMonth(value: unknown): string {
  const data = rawHex(value);
  return JSON.stringify({
    startYear: hex(data.slice(0, 2)),
    startMonth: hex(data.slice(2, 4)),
    endYear: hex(data.slice(4, 6)),
    endMonth: hex(data.slice(6, 8)),
    electricTotal: hex(data.slice(8, 16)) / 100,
  });
}

function dbFrozen(value: unknown): string {
  const data = rawHex(value);
  return JSON.stringify({ day: hex(data.slice(0, 2)), hour: hex(data.slice(2, 4)) });
}

function dbData(value: unknown): string {
  const data = rawHex(value);
  return JSON.stringify({
    power: hex(data.slice(0, 8)) / 100,
    year: hex(data.slice(8, 10)),
    month: hex(data.slice(10, 12)),
    date: hex(data.slice(12, 14)),
    hour: hex(data.slice(14, 16)),
    minute: hex(data.slice(16, 18)),
    second: hex(data.slice(18, 20)),
  });
}

function dbTariff(value: unknown): string {
  const data = rawHex(value);
  const keys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const result: Record<string, Array<{ start_time: string; end_time: string }>> = {};
  for (let index = 0; index < keys.length; index++) {
    const day = data.slice(index * 12, index * 12 + 12);
    result[keys[index]] = [];
    if (!day || /^0+$/.test(day)) {
      continue;
    }
    for (let offset = 0; offset + 4 <= day.length; offset += 4) {
      result[keys[index]].push({
        start_time: String(hex(day.slice(offset, offset + 2))),
        end_time: String(hex(day.slice(offset + 2, offset + 4))),
      });
    }
  }
  return JSON.stringify(result);
}

function timer(value: unknown, extended: boolean): string {
  const data = rawBytes(value);
  const width = extended ? 10 : 6;
  const result: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset + width <= data.length; offset += width) {
    const item: Record<string, unknown> = {
      timer_switch: data[offset] > 0,
      week_day: Array.from({ length: 8 }, (_, bit) => bit).filter(bit => (data[offset + 1] & (1 << bit)) !== 0),
      start_time: minuteTime(data.readUInt16BE(offset + 2)),
      end_time: minuteTime(data.readUInt16BE(offset + 4)),
    };
    if (extended) {
      item.open_time = minuteTime(data.readUInt16BE(offset + 6));
      item.close_time = minuteTime(data.readUInt16BE(offset + 8));
    }
    result.push(item);
  }
  return JSON.stringify(result);
}

function minuteTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function hsvFromRgb(red: number, green: number, blue: number): { h: number; s: number; v: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) {
      hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      hue = 60 * ((b - r) / delta + 2);
    } else {
      hue = 60 * ((r - g) / delta + 4);
    }
  }
  if (hue < 0) {
    hue += 360;
  }
  return { h: round(hue, 1), s: round((max === 0 ? 0 : delta / max) * 255, 1), v: round(max * 255, 1) };
}

function djV1Hsv(value: unknown): string {
  const data = String(value);
  if (data.slice(6) === '0168ffff') {
    return JSON.stringify(hsvFromRgb(hex(data.slice(0, 2)), hex(data.slice(2, 4)), hex(data.slice(4, 6))));
  }
  return JSON.stringify({
    h: hex(data.slice(6, 10)),
    s: round((hex(data.slice(10, 12)) / 255) * 255, 1),
    v: round((hex(data.slice(12)) / 255) * 255, 1),
  });
}

function djV1Scene(value: unknown): string {
  const data = String(value);
  if (!data) {
    return '';
  }
  const hsv: Array<{ h: number; s: number; v: number }> = [];
  for (let offset = 8; offset + 6 <= data.length; offset += 6) {
    hsv.push(hsvFromRgb(
      hex(data.slice(offset, offset + 2)),
      hex(data.slice(offset + 2, offset + 4)),
      hex(data.slice(offset + 4, offset + 6)),
    ));
  }
  return JSON.stringify({
    frequency: hex(data.slice(4, 6)),
    bright: hex(data.slice(0, 2)),
    temperature: hex(data.slice(2, 4)),
    hsv,
  });
}

function djV2Color(value: unknown): string {
  const data = String(value);
  return JSON.stringify({ h: hex(data.slice(0, 4)), s: hex(data.slice(4, 8)), v: hex(data.slice(8, 12)) });
}

function djV2Control(value: unknown): string {
  const data = String(value);
  if (!data) {
    return '';
  }
  return JSON.stringify({
    change_mode: hex(data.slice(0, 1)) === 0 ? 'direct' : 'gradient',
    h: hex(data.slice(1, 5)),
    s: hex(data.slice(5, 9)),
    v: hex(data.slice(9, 13)),
    bright: hex(data.slice(13, 17)),
    temperature: hex(data.slice(17)),
  });
}

function djV2Scene(value: unknown): string {
  const data = String(value);
  const scene_units: Array<Record<string, number | string>> = [];
  for (let offset = 2; offset + 26 <= data.length; offset += 26) {
    const item = data.slice(offset, offset + 26);
    scene_units.push({
      unit_switch_duration: hex(item.slice(0, 2)),
      unit_gradient_duration: hex(item.slice(2, 4)),
      unit_change_mode: ['static', 'jump', 'gradient'][hex(item.slice(4, 6))] ?? '',
      h: hex(item.slice(6, 10)),
      s: hex(item.slice(10, 14)),
      v: hex(item.slice(14, 18)),
      bright: hex(item.slice(18, 22)),
      temperature: hex(item.slice(22)),
    });
  }
  return JSON.stringify({ scene_num: 1 + hex(data.slice(0, 2)), scene_units });
}

function hsvToRgbText(value: unknown): string {
  const color = JSON.parse(String(value));
  const h = Number(color.h) / 360;
  const s = Number(color.s) / 255;
  const v = Number(color.v) / 255;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const choices = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
  return choices[i % 6].map(channel => Math.trunc(channel * 255)).join('|');
}

function scaleRange(value: unknown, targetMin: number, targetMax: number, inputMin: number, inputMax: number): number {
  const input = Math.min(inputMax, Math.max(inputMin, Number(value)));
  return Math.floor(((targetMax - targetMin) / (inputMax - inputMin)) * (input - inputMin) + targetMin);
}

function lockDpSync(value: unknown): number[] {
  const data = rawBytes(value);
  const result = new Set<number>();
  for (let offset = 0; offset + 1 < data.length; offset += 2) {
    const partition = data[offset] & 0x7f;
    for (let bit = 0; bit < 8; bit++) {
      if ((data[offset + 1] & (1 << bit)) !== 0) {
        result.add((partition - 1) * 8 + bit);
      }
    }
  }
  return [...result];
}

function cleanRecord(value: unknown): string {
  const data = String(value);
  if (data.length === 6) {
    return JSON.stringify({
      record_time: '', clean_time: Number(data.slice(0, 3)), clean_area: Number(data.slice(3, 6)), map_id: '',
    });
  }
  if (data.length === 11) {
    return JSON.stringify({
      record_time: '', clean_time: Number(data.slice(0, 3)), clean_area: Number(data.slice(3, 6)), map_id: data.slice(6, 11),
    });
  }
  if (data.length === 18) {
    return JSON.stringify({
      record_time: data.slice(0, 12), clean_time: Number(data.slice(12, 15)),
      clean_area: Number(data.slice(15, 18)), map_id: '',
    });
  }
  return JSON.stringify({
    record_time: data.slice(0, 12), clean_time: Number(data.slice(12, 15)),
    clean_area: Number(data.slice(15, 18)), map_id: data.slice(18, 23),
  });
}

function parseJson(value: string, fallback: any): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const converters: Record<string, Converter> = {
  default: defaultConvert,
  enum: enumConvert,
  db_v1_params: value => dbParams(value),
  db_v1_alarm: value => dbAlarm(value),
  db_v1_daily: value => dbDaily(value),
  db_v1_data: value => dbData(value),
  db_v1_frozen: value => dbFrozen(value),
  db_v1_month: value => dbMonth(value),
  db_v1_tariff: value => dbTariff(value),
  cz_timer1_alg: value => timer(value, false),
  cz_timer2_alg: value => timer(value, true),
  dj_v1_hsv_alg: value => isNil(value) ? value : djV1Hsv(value),
  voice_atm_color: value => isNil(value) ? value : djV1Hsv(value),
  dj_v1_scene_alg: value => isNil(value) ? value : djV1Scene(value),
  dj_v2_color_alg: value => isNil(value) ? value : djV2Color(value),
  dj_v2_contr_alg: value => isNil(value) ? value : djV2Control(value),
  dj_v2_music_alg: value => isNil(value) ? value : djV2Control(value),
  dj_v2_scene_alg: value => isNil(value) ? value : djV2Scene(value),
  hb_djv1_color: value => isNil(value) ? value : hsvToRgbText(value),
  hb_jsq_lightv1: value => isNil(value) ? '' : `${value}|0|0`,
  hb_range_v1: value => isNil(value) ? '' : scaleRange(value, 0, 100, 25, 255),
  hb_range_v2: value => isNil(value) ? '' : scaleRange(value, 1000, 12000, 0, 255),
  ms_dp_syn_alg: value => isNil(value) ? value : lockDpSync(value),
  sd_clean_record: value => isNil(value) ? value : cleanRecord(value),
};

function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
