
export enum TuyaDeviceSchemaMode {
  UNKNOWN = '',
  READ_WRITE = 'rw',
  READ_ONLY = 'ro',
  WRITE_ONLY = 'wo',
}

export enum TuyaDeviceSchemaType {
  Boolean = 'Boolean',
  Integer = 'Integer',
  Enum = 'Enum',
  String = 'String',
  Json = 'Json',
  Raw = 'Raw',
}

export type TuyaDeviceSchemaIntegerProperty = {
  min: number;
  max: number;
  scale: number;
  step: number;
  unit: string;
};

export type TuyaDeviceSchemaEnumProperty = {
  range: string[];
};

export type TuyaDeviceSchemaStringProperty = string;

export type TuyaDeviceSchemaJSONProperty = object;

export type TuyaDeviceSchemaProperty = TuyaDeviceSchemaIntegerProperty
  | TuyaDeviceSchemaEnumProperty
  | TuyaDeviceSchemaStringProperty
  | TuyaDeviceSchemaJSONProperty;

export type TuyaDeviceSchema = {
  code: string;
  // name: string;
  mode: TuyaDeviceSchemaMode;
  type: TuyaDeviceSchemaType;
  property: TuyaDeviceSchemaProperty;
  /** Tuya account-sharing hint: incremental (`sum`) or absolute (`minux`). */
  report_type?: 'sum' | 'minux' | 'un_known' | string;
};

export type TuyaDeviceStatus = {
  code: string;
  value: string | number | boolean | object;
};

export type TuyaSharingLocalStrategy = {
  value_convert: string;
  status_code: string;
  config_item: {
    statusFormat: string;
    valueDesc: string;
    valueType: string;
    enumMappingMap?: Record<string, { value?: unknown }>;
    pid?: string;
  };
};

export type TuyaIRRemoteKeyListItem = {
  key: string;
  key_id: number;
  key_name: string;
  standard_key: boolean;
  learning_code?: string; // IR DIY device learning code.
};

export type TuyaIRRemoteTempListItem = {
  temp: number;
  temp_name: string;
  fan_list: TuyaIRRemoteFanListItem[];
};

export type TuyaIRRemoteKeyRangeItem = {
  mode: number;
  mode_name: string;
  temp_list: TuyaIRRemoteTempListItem[];
};

export type TuyaIRRemoteFanListItem = {
  fan: number;
  fan_name: string;
};

export type TuyaIRRemoteKeys = {
  category_id: number;
  org_category_id: number;
  brand_id: number;
  remote_index: number;
  single_air: boolean;
  duplicate_power: boolean;
  key_list: TuyaIRRemoteKeyListItem[];
  key_range: TuyaIRRemoteKeyRangeItem[];
};

export type TuyaInfraredACCommandMode = 'device-sharing';
export type TuyaInfraredRemoteCommandMode = 'device-sharing';

export default class TuyaDevice {

  // device
  id!: string;
  uuid!: string;
  name!: string;
  online!: boolean;
  owner_id!: string; // homeID or assetID

  // product
  product_id!: string;
  product_name!: string;
  model?: string;
  icon!: string;
  category!: string;
  hidden?: boolean;
  unbridged?: boolean;
  schema!: TuyaDeviceSchema[];

  // status
  status!: TuyaDeviceStatus[];

  // location
  ip!: string;
  lat!: string;
  lon!: string;
  time_zone!: string;

  // time
  create_time!: number;
  active_time!: number;
  update_time!: number;

  // ...
  sub!: boolean;
  parent_id?: string;
  remote_keys?: TuyaIRRemoteKeys;
  infrared_ac_command_mode?: TuyaInfraredACCommandMode;
  infrared_remote_command_mode?: TuyaInfraredRemoteCommandMode;
  infrared_ac_product_api_resolved?: boolean;
  infrared_ac_local_ip?: string;
  support_local?: boolean;
  local_strategy?: Record<number, TuyaSharingLocalStrategy>;
  /** DP-to-code metadata retained for targeted account-sharing command fallbacks. */
  sharing_dp_codes?: Record<number, string>;
  node_id?: string;
  set_up?: boolean;

  constructor(obj: Partial<TuyaDevice>) {
    Object.assign(this, obj);
    this.status.sort((a, b) => a.code > b.code ? 1 : -1);
  }

  isVirtualDevice() {
    return this.id.startsWith('vdevo');
  }

  isIRControlHub() {
    return ['wnykq', 'hwktwkq', 'wsdykq']
      .includes(this.category);
  }

  isIRRemoteControl() {
    return this.remote_keys !== undefined || this.category.startsWith('infrared_');
  }

}
