# @homebridge-plugins/homebridge-tuya

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

![node](https://badgen.net/npm/node/@homebridge-plugins/homebridge-tuya)
<img alt="homebridge badge" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgithub.com%2Fhomebridge-plugins%2Fhomebridge-tuya%2Fraw%2Frefs%2Fheads%2Flatest%2Fpackage.json&query=%24.engines.homebridge&label=homebridge&color=%23491F59">


[![Sponsor](https://img.shields.io/badge/Sponsor-❤-ff69b4)](https://github.com/sponsors/tassy-h)
[![version](https://badgen.net/npm/v/@homebridge-plugins/homebridge-tuya)](https://npmjs.com/package/@homebridge-plugins/homebridge-tuya)
![size](https://img.shields.io/npm/unpacked-size/@homebridge-plugins/homebridge-tuya)
[![npm-downloads](https://badgen.net/npm/dt/@homebridge-plugins/homebridge-tuya)](https://npmjs.com/package/@homebridge-plugins/homebridge-tuya)
[![mit-license](https://badgen.net/npm/license/@homebridge-plugins/homebridge-tuya)](https://github.com/homebridge-plugins/homebridge-tuya/blob/main/LICENSE)
[![Build and Lint](https://github.com/homebridge-plugins/homebridge-tuya/actions/workflows/build.yml/badge.svg)](https://github.com/homebridge-plugins/homebridge-tuya/actions/workflows/build.yml)




Forked from 0x5e/homebridge-tuya-platform, with a focus on fixing bugs and adding new device support.




## Features

- Optimized and improved code for better readability and maintainability.
- Enhanced stability.
- Reduced duplicate code.
- Fewer API errors.
- Lower development costs for new accessory categories.
- Supports Tuya Scenes (Tap-to-Run).
- Supports Smart Life and Tuya Smart QR account authorization without a personal Tuya IoT developer project.
- Includes the ability to override device configurations, which enables support for "non-standard" DPs.
- Supports over 60+ device categories, including most light, switch, sensor, camera, lock, IR remote control, etc.


## Supported Tuya Devices
See [SUPPORTED_DEVICES.md](./SUPPORTED_DEVICES.md)


## Changelogs
See [CHANGELOG.md](./CHANGELOG.md)


## Installation
Before using this plugin, please make sure to uninstall `homebridge-tuya-platform` first as these two plugins cannot run simultaneously. However, the configuration files are compatible, so there's no need to delete them.

#### For Homebridge Web UI Users
Go to plugin page, search for `@homebridge-plugins/homebridge-tuya` and install it.


#### For Homebridge Command Line Users

Run the following command in the terminal:
```
npm install @homebridge-plugins/homebridge-tuya
```


## Configuration

There are three connection methods:

- `Smart Life / Tuya Smart QR login` (`projectType: "3"`) discovers the homes and devices shared by either app. Individual users do not create a Tuya IoT developer project and do not enter an Access ID or Access Secret.
- The `Custom` project pulls devices from the project's assets.
- The `Smart Home` project pulls devices from the user's home in the Tuya app.

For a personal account, use QR login. The two developer-project modes remain available for existing installations and services that require their APIs.

### Smart Life / Tuya Smart QR login

1. In Smart Life or Tuya Smart, open **Me → Settings → Account and Security** and copy **User Code**.
2. In the plugin settings, choose **Smart Life / Tuya Smart QR login**, select the matching app, and enter that User Code.
3. Select **Start QR login**, scan the fresh QR code with the selected app, and confirm the authorization.
4. Save the configuration and restart Homebridge.

The plugin stores the refresh token in Homebridge's persist directory with owner-only file permissions. It is not stored in `config.json`.

> Compatibility note: this branch defaults to Home Assistant's public Tuya client ID and `haauthorize` QR schema. Users still need no developer account or secret, but authorizing an account already connected to Home Assistant may replace or invalidate Home Assistant's Tuya session. Optional integration-specific values can be supplied with `TUYA_SHARING_CLIENT_ID` and `TUYA_SHARING_SCHEMA`.

#### Developer-project modes

Before you can configure, you must go to the [Tuya IoT Platform](https://iot.tuya.com):
- Create a cloud development project, and select the data center where your app account is located. See [Mappings Between OEM App Accounts and Data Centers](https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed?id=Kafi0ku9l07qb) or [Countries Regions and Tuya Data Center](https://github.com/tuya/tuya-home-assistant/wiki/Countries-Regions-and-Tuya-Data-Center)
- Go to the `Project Page` > `Devices Panel` > `Link Tuya App Account`, and link your app account.
- Go to the `Project Page` > `Service API` > `Go to Authorize`, and subscribe to the following APIs (it is free for trial):
    - Authorization Token Management
    - Device Status Notification
    - IoT Core
    - IoT Video Live Stream (for cameras)
    - Industry Project Client Service (for the `Custom` project)
    - IR Control Hub Open Service (for IR devices)
    - Smart Home Scene Linkage (for scenes)
    - Smart Lock Open Service (for Lock devices)
- **⚠️Remember to extend the API trial period every 6 months here [Tuya IoT Platform > Cloud > Cloud Services > IoT Core](https://iot.tuya.com/cloud/products/detail?abilityId=1442730014117204014&id=p1668587814138nv4h3n&abilityAuth=0&tab=1) (the first-time subscription only gives you 1 month).**

#### For "Custom" Project

- `platform` - **required** : Must be 'TuyaPlatform'
- `options.projectType` - **required** : Must be '1'
- `options.endpoint` - **required** : The endpoint URL taken from the [API Reference > Endpoints](https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4#title-1-Endpoints) table.
- `options.accessId` - **required** : The Access ID obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud)
- `options.accessKey` - **required** : The Access Secret obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud)
- `options.debug` - **optional**: Includes debugging output in the Homebridge log. (Default: `false`)
- `options.debugLevel` - **optional**: An optional list of strings seperated with comma `,`. `api` represents for HTTP API log, `mqtt` represents for MQTT log, and device ID represents for device log. If blank, all logs are outputed.

#### For "Smart Home" Project

- `platform` - **required** : Must be 'TuyaPlatform'
- `options.projectType` - **required** : Must be '2'
- `options.accessId` - **required** : The Access ID obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud)
- `options.accessKey` - **required** : The Access Secret obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud)
- `options.countryCode` - **required** : The country code of your app account's region.
- `options.username` - **required** : The app account's username.
- `options.password` - **required** : The app account's password. MD5 salted password is also available for increased security.
- `options.appSchema` - **required** : The app schema: 'tuyaSmart' for the Tuya Smart App, or 'smartlife' for the Smart Life App.
- `options.endpoint` - **optional** : The endpoint URL can be inferred from the [API Reference > Endpoints](https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4#title-1-Endpoints) table based on the country code provided. Only manually set this value if you encounter login issues and need to specify the endpoint for your account location.
- `options.homeWhitelist` - **optional**: An array of integer values for the home IDs you want to whitelist. If provided, only devices with matching Home IDs will be included. You can find the Home ID in the Homebridge log.
- `options.debug` - **optional**: Includes debugging output in the Homebridge log. (Default: `false`)
- `options.debugLevel` - **optional**: An optional list of strings seperated with comma `,`. `api` represents for API and MQTT log, device ID represents for specific device log. If blank, all logs are outputed.


#### Advanced options
See [ADVANCED_OPTIONS.md](./ADVANCED_OPTIONS.md)

Garage door controllers that keep `switch_1=true` can opt in to contact-sensor-only state reads with `garageDoorUseContactSensorForState` in `options.deviceOverrides`. This keeps commands on `switch_1`, but reads HomeKit state from `doorcontact_state`.


## Limitations
- QR account-sharing currently operates in Home Assistant compatibility mode. It is not an official Home Assistant component, and token coexistence is not guaranteed when both systems authorize the same Tuya account.
- Developer-project users must extend the Tuya API trial period when required. QR account-sharing users have no personal cloud-project trial to renew.
- Some services outside the device-sharing API, particularly product-specific IR, camera, and lock APIs, still require live permission testing even though their existing accessory mappings are retained.
- The plugin requires an internet connection to the Tuya Cloud and does not support the LAN protocol. See [#90](https://github.com/homebridge-plugins/homebridge-tuya/issues/90) for more information.

## FAQ

#### About Login issue

For most users, you can easily find your app account's data center through the [documentation](https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed?id=Kafi0ku9l07qb) and login without any issues. However, for some users, they may encounter error codes such as 1106 or 2406. If you encounter such errors, it's possible that there are differences between your data center and the documentation.

To determine the data center, follow these steps:

1. Open the app and navigate to "Me > Settings > Network Diagnosis".
2. Start the diagnosis and select "Upload Log > Copy the Log to Clipboard".
3. Paste the log anywhere and find the line beginning with "Region code:".
4. Look for the following codes: "AY" for China, "AZ" for the West US, "EU" for Central Europe, and "IN" for India.

Then manually specify endpoint in the plugin config.


#### What is "Standard DP" and "Non-standard DP"?

<!-- If your device is working properly, you don't need to know this. -->

"Standard DP" refers to device properties or functionalities that are specified in the Tuya IoT Development Platform documentation at [Tuya IoT Development Platform Documentation > Cloud Development > Standard Instruction Set](https://developer.tuya.com/en/docs/iot/standarddescription?id=K9i5ql6waswzq).

For example, a light bulb should have a standard DP code of `switch_led` for power on/off, and optional codes `bright_value`/`bright_value_v2` for brightness, `temp_value`/`temp_value_v2` for color temperature, and `work_mode` for changing the working mode. These codes can be found in the above documentation.

If your light bulb can be adjusted in the Tuya app but not with the plugin, it most likely has "Non-standard DP."


#### Can "Non-standard DP" be supportd by this plugin?

Yes. The device must be listed in the support list and the following steps must be completed before it will work:
1. Change the device's control mode on the Tuya Platform:
  - Go to "[Tuya Platform Cloud Development](https://iot.tuya.com/cloud/) > Your Project > Devices > All Devices > View Devices by Product".
  - Find the product related to your device, click the "pencil" icon (Change Control Instruction Mode).
  - <img width="500" alt="image" src="https://user-images.githubusercontent.com/5144674/202967707-8b934e05-36d6-4b42-bb7b-87e5b24474c4.png">
  - In the "Table of Instructions", you can see the cloud mapping and determine which DP codes are missing and need to be manually mapped later.
  - <img width="500" alt="image" src="https://user-images.githubusercontent.com/5144674/202967528-4838f9a1-0547-4102-afbb-180dc9b198b1.png">
  - Select "DP Instruction" and save.
2. Override the device schema, see [ADVANCED_OPTIONS.md](./ADVANCED_OPTIONS.md).


#### Local support
See [#90](https://github.com/homebridge-plugins/homebridge-tuya/issues/90).

Although the plugin didn't implemented tuya local protocol now, it still remains possibility in the future.


## Troubleshooting

If your device is not supported, please follow these steps to collect information.

#### 1. Get Device Information

After Homebridge has been successfully launched, the device information list will be saved in Homebridge's persist path. You can find the file path in the Homebridge log:
```
[2022/11/3 18:37:43] [TuyaPlatform] Device list saved at /path/to/TuyaDeviceList.{uid}.json
```

**⚠️Please make sure to remove sensitive information such as `ip`, `lon`, `lat`, `local_key`, and `uid` before submitting the file.**


#### 2. Enable Debug Mode

Add debug option in the plugin config, then restart Homebridge.

#### 3. Collect Logs

With debug mode enabled, you can now receive MQTT logs. Operate your device, either physically or through the Tuya App, to receive MQTT logs like this:

```
[2022/12/8 12:51:59] [TuyaPlatform] [TuyaOpenMQ] onMessage:
topic = cloud/token/in/xxx
protocol = 4
message = {
  "dataId": "xxx",
  "devId": "xxx",
  "productKey": "xxx",
  "status": [
    {
      "1": "double_click",
      "code": "switch1_value",
      "t": "1670475119766",
      "value": "double_click"
    }
  ]
}
```

If you are unable to receive any MQTT logs while controlling the device, it likely means that your device has "Non-standard DP".

By submitting the device information JSON and MQTT logs, you can help us support new device categories.


## Contributing

Please see https://github.com/homebridge/homebridge-plugin-template#setup-development-environment for setup development environment.

PRs and issues are welcome.

# 
Thank you for spend time using the project. If it helps you, don't hesitate to give it a star 🌟:-)
