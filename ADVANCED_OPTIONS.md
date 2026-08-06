# Advanced Options

**During the beta version, the options are unstable, may get changed during updates.**

The main function of `deviceOverrides` is to convert "non-standard schema" to "standard schema", making the device compatible with this plugin.

Before configuring, you may need to:

- Have basic programming skills in JavaScript (Only used in `onGet`/`onSet` handlers).
- Understand the concept of device schema (also known as Data Type): [Tuya IoT Development Platform > Cloud Development > Standard Instruction Set > Data Type](https://developer.tuya.com/en/docs/iot/datatypedescription?id=K9i5ql2jo7j1k)
- Read the documentation of your device product in [SUPPORTED_DEVICES.md](./SUPPORTED_DEVICES.md).
- In QR mode, refresh the settings dashboard and inspect the bounded **Device inspector** view. Its copied override draft is intentionally minimal and is never applied automatically.
- When the inspector is unavailable, obtain device info JSON from `/path/to/persist/TuyaDeviceList.xxx.json` (the full path can be found from logs). This raw file can include private identifiers, locations, IP addresses, URLs, and values; never attach it without manual sanitization.
- Locate any "incorrect schema" in your device info json, and convert it to the "correct schema".


### Configuration

`options.deviceOverrides` is an **optional** array of device overriding config objects, which is used for converting "non-standard schema" to "standard schema", making the device compatible with this plugin. The structure of each element in the array is described as follows:

- `id` - **required**: Device ID, Product ID, Scene ID, or `global`.
- `category` - **optional**: Device category code. See [SUPPORTED_DEVICES.md](./SUPPORTED_DEVICES.md). Also you can use `hidden` to hide the device, product, or scene. **⚠️Overriding this property may lead to unexpected behaviors and exceptions, so please remove the accessory cache after making changes.**
- `unbridged` - **optional**: Unbridge accessories. Defaults to `false`.
- `adaptiveLighting` - **optional**: Adaptive Lighting. Defaults to `false`. Not all light device support this feature, please use it on demand.
- `garageDoorUseContactSensorForState` - **optional**: For garage door controllers. When `true`, `CurrentDoorState` and `TargetDoorState` reads use `doorcontact_state` only, while set commands still use `switch_1`. Defaults to `false`.
- `irAirConditionerPowerOnMode` - **optional**: For IR air conditioners, the mode used by a plain Apple Home **Turn On** request. One of `cool` (default), `heat`, `auto`, or `last`. If the selected mode is unsupported, the handler chooses an available climate mode.
- `localControl` - **optional, beta**: Per-device Tuya LAN protocol 3.3 command routing. Requires a route mode, verified IP/local key, and explicit schema-code-to-numeric-DP mappings. It does not provide local discovery or state updates.
- `schema` - **optional**: An array of schema overriding config objects, used for describing datapoint (DP). When your device has non-standard DP, you need to transform them manually with configuration. Each element in the schema array is described as follows:
  - `code` - **required**: DP code.
  - `newCode` - **optional**: New DP code.
  - `type` - **optional**: New DP type. One of `Boolean`, `Integer`, `Enum`, `String`, `Json`, or `Raw`.
  - `property` - **optional**: New DP property object. For `Integer` type, the object should contain `min`, `max`, `scale`, and `step`. For `Enum` type, the object should contain `range`. For more information, see `TuyaDeviceSchemaProperty` in [TuyaDevice.ts](./src/device/TuyaDevice.ts).
  - `onGet` - **optional**: A one-line JavaScript code to convert the old value to the new value. The function is called with two arguments: `device` and `value`.
  - `onSet` - **optional**: A one-line JavaScript code to convert the new value to the old value. The function is called with two arguments: `device` and `value`. Returning `undefined` means to skip sending the command.
  - `hidden` - **optional**: Hide the schema. Defaults to `false`.

Platform-level advanced options live directly under `options` rather than inside a device override:

- `capabilityAutoDetection` - **optional**: Defaults to `false`. Conservatively selects an existing handler for an otherwise unsupported category only when recognized standard datapoints are present. An explicit override to a registered category takes precedence.
- `energyHistory` - **optional**: Local retention settings for allowlisted energy reports observed while the plugin is running. Disabled by default.
- `developerCloudFallback` - **optional, QR mode only**: Secondary Tuya Developer Cloud credentials for IR, lock, and camera product endpoints. It does not replace QR discovery, MQTT state, or general commands.


## Examples

### Choose the IR air-conditioner power-on mode

Apple Home can send an `Active` write without first choosing a target climate mode. Set the desired behavior on the IR remote's device override. `cool` is the default; `last` reuses the last supported operating mode remembered by the accessory.

```json
{
  "options": {
    "deviceOverrides": [
      {
        "id": "{ir_remote_device_id}",
        "irAirConditionerPowerOnMode": "last"
      }
    ]
  }
}
```

Valid values are `cool`, `heat`, `auto`, and `last`. The accessory falls back to an available supported mode when the requested profile is not present in the remote's mode table. This option protects a plain power-on action from Apple Home's default Auto replay; while the accessory is already active, supported target-mode writes continue to change its mode normally.

### Enable conservative capability detection

```json
{
  "options": {
    "capabilityAutoDetection": true
  }
}
```

Detection runs only when the product ID and category have no registered handler. It matches narrow combinations of standard Tuya codes, then applies the selected handler's normal required-schema validation. It does not rename vendor datapoints, guess units, decode arbitrary payloads, or supersede an explicit device category override. Check the startup log for the inferred profile and matched codes before relying on the mapping.

### Enable local energy history

```json
{
  "options": {
    "energyHistory": {
      "enabled": true,
      "retentionDays": 30,
      "sampleIntervalMinutes": 5
    }
  }
}
```

The plugin writes owner-only `TuyaEnergyHistory.json` in the Homebridge persist directory. It records only numeric `cur_current`, `cur_power`, `cur_voltage`, `add_ele`, `forward_energy_total`, `reverse_energy_total`, and scalar `phase_a_*`, `phase_b_*`, or `phase_c_*` current/power/voltage reports. Schema scale and unit metadata are retained.

`retentionDays` accepts 1–365 and `sampleIntervalMinutes` accepts 1–1440. The sample interval controls bucket merging, not polling. No file or sample is created until a device supplies a recognized metric. A global safety cap retains the newest 100,000 samples across devices. The file contains actual device IDs, names, timestamps, and readings and is not suitable as a sanitized issue attachment. This feature does not import Tuya app/cloud history or create HomeKit history.

### Add a QR-mode Developer Cloud product fallback

```json
{
  "options": {
    "projectType": "3",
    "userCode": "{app_user_code}",
    "appSchema": "tuyaSmart",
    "developerCloudFallback": {
      "enabled": true,
      "accessId": "{developer_cloud_access_id}",
      "accessKey": "{developer_cloud_access_secret}",
      "countryCode": 91,
      "username": "{app_login}",
      "password": "{app_password}",
      "appSchema": "tuyaSmart"
    }
  }
}
```

The project must be linked to the app account, use the correct region, and have the relevant IR Control Hub, Smart Lock, or IoT Video API subscription. An optional `endpoint` can override automatic regional selection. When the secondary login succeeds, product-specific IR metadata/commands, lock operations, and camera RTSP allocation use it. Homes, devices, standard commands, and MQTT live updates remain on the QR connection. An unsuccessful Tuya login response is logged and leaves only the primary QR permissions active.

These credentials—including the app password and Access Secret—are stored in Homebridge `config.json`. Restrict access to that file and never include this block in an issue report.

### Beta Tuya LAN 3.3 command routing

Start with `hybrid` so a rejected local command falls back to the existing Tuya Cloud path:

```json
{
  "options": {
    "deviceOverrides": [
      {
        "id": "{device_id}",
        "localControl": {
          "mode": "hybrid",
          "ip": "192.0.2.10",
          "localKey": "0123456789abcdef",
          "protocolVersion": "3.3",
          "timeoutMs": 3000,
          "dpMap": [
            {
              "code": "switch_1",
              "dpId": 1
            }
          ]
        }
      }
    ]
  }
}
```

Replace every example value. The `localKey` must be exactly 16 UTF-8 bytes. A valid, stable IP must either be configured here or already be present on the discovered device, and it must be reachable from Homebridge. Each schema code that can be sent in a command must have a verified positive numeric `dpId`; the plugin intentionally does not derive DP IDs from order or names.

Route behavior:

- `cloud`: use the normal cloud command path; local settings are ignored.
- `hybrid`: validate and send the complete command locally, then use the original cloud request if local mapping, framing, connection, timeout, or device acknowledgement fails.
- `local`: attempt LAN only and surface any error to HomeKit; there is no cloud fallback.

This beta sends protocol 3.3 control frames only. It does not scan the LAN, negotiate or retrieve local keys, discover IP changes, support protocol 3.4/3.5, poll state, or listen for local state updates. Startup discovery, schema retrieval, scenes, and MQTT reports still require the configured cloud connection. A device remaining controllable locally during a brief cloud command outage does not make the plugin fully local.

### Use sanitized diagnostics safely

For connected QR accounts, the settings dashboard's **Device inspector** hides sensitive datapoint codes and non-scalar values before rendering. **Copy draft** creates only an inert `{ id, category }` (or `{ id }`) starting point; it never copies schema values or local-control settings and never modifies the saved configuration.

For issue reports, prefer **Sanitized support bundle → Copy bundle** or **Download JSON**. That export pseudonymizes home/device references and removes real names and IDs, product IDs, configuration, credentials, locations, URLs, local keys, override drafts, enum ranges, and all datapoint values. The inspector itself intentionally shows local identity fields, so a screenshot is not equivalent to the support bundle. Developer-project modes do not currently populate this dashboard inventory.

### Change category code

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "category": "xxx"
    }]
  }
}
```

### Hide device / scene

Just the same way as changing category code.

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id_or_scene_id}",
      "category": "hidden"
    }]
  }
}
```

### Hide DP

An example of hide camera's floodlight (`floodlight_switch`):
```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "floodlight_switch",
        "hidden": true
      }]
    }]
  }
}
```

### Enable Adaptive Lighting

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "adaptiveLighting": true
    }]
  }
}
```

### Use garage door contact sensor for state

Some `ckmkzq` garage door controllers keep `switch_1` as `true`, which can make HomeKit show the door as stuck Opening or Closing. Enable this per-device option to read the door state from `doorcontact_state`, while commands are still sent to `switch_1`.

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "garageDoorUseContactSensorForState": true
    }]
  }
}
```


### Offline as off

If you want to display off status when device is offline:
```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "{dp_code}",
        "onGet": "(device.online && value)"
      }]
    }]
  }
}
```


### Change DP code

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
          "code": "{old_dp_code}",
          "newCode": "{new_dp_code}"
      }]
    }]
  }
}
```


### Convert from enum DP to boolean DP

An example of convert `open`/`close` into `true`/`false`:
```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "{dp_code}",
        "type": "Boolean",
        "onGet": "(value === 'open') ? true : false;",
        "onSet": "(value === true) ? 'open' : 'close';"
      }]
    }]
  }
}
```


### Adjust integer DP ranges

Some odd thermostat stores double of the real value to keep the decimal part (0.5°C).

We need override both range and value in order to make it working. (Only override value is not enough, range is required too.)

Here's an example of the invalid schema:
```js
{
  code: 'temp_set',
  mode: 'rw',
  type: 'Integer',
  property: { unit: '℃', min: 10, max: 70, scale: 1, step: 5 }
}
```

The value `41` actually represents for `20.5°C`, the range `10~70` actually represents for `5.0°C~35.0°C`.

To fix this, first we need set scale to `1`, and convert `41` to `205` when getting, convert `205` to `41` when getting, which means `value x 5` when getting, and `value / 5` when setting.

Here's the example config:
```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "temp_set",
        "onGet": "(value * 5);",
        "onSet": "(value / 5);",
        "property": {
          "min": 50,
          "max": 350,
          "scale": 1,
          "step": 5
        }
      }]
    }]
  }
}
```

After transform value using `onGet` and `onSet`, and new range in `property`, it should be working now.


### Reverse curtain motor's on/off state

Most curtain motor have "reverse mode" setting in the Tuya App, if you don't have this, you can reverse `percent_control`/`position` and `percent_state` in the plugin config:

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "percent_control",
        "onGet": "(100 - value)",
        "onSet": "(100 - value)"
      }, {
        "code": "percent_state",
        "onGet": "(100 - value)",
        "onSet": "(100 - value)"
      }]
    }]
  }
}
```

### Set an offset for the device’s status value.

Some devices return status values without applying any offset, so we override onGet and onSet to apply a custom offset.
For example, if you want to apply an offset of `+10` to the `temperature` dpCode.

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "temperature",
        "onGet": "(value + 10)",
        "onSet": "(value - 10)"
      }]
    }]
  }
}
```

### Skip send on/off command when touching brightness/speed slider

Some products (dimmer, fan) having issue when sending brightness/speed command with on/off command together. Here's an example of skip on/off command.

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "switch_led",
        "onSet": "(value === device.status.find(status => status.code === 'switch_led').value) ? undefined : value"
      }]
    }]
  }
}
```


### Convert Fahrenheit to Celsius

F = 1.8 * C + 32

C = (F - 32) / 1.8

```js
{
  "options": {
    // ...
    "deviceOverrides": [{
      "id": "{device_id}",
      "schema": [{
        "code": "temp_current",
        "onGet": "Math.round((value - 32) / 1.8);",
        "onSet": "Math.round(1.8 * value + 32);"
      }]
    }]
  }
}
```
