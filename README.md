# node-red-contrib-linking-device

A Node-RED node for providing access to BLE(Bluetooth Low Energy) devices called <a href="https://linkingiot.com/en/devices.html">Linking devices</a>.

See <a href="https://linkingiot.com/en/index.html">Project Linking</a> for more information about the Linking Device.

There are following three nodes:

- linking-scanner : To get beacon(sensor) data from Linking device
- linking-sensor : To connect to Linking device and get sensor data
- linking-led : To connect to Linking device and turn on LED.

## Supported Devices

### Supported

- Tukeru TH (temperature, humidity, LED)
- Sizuku THA (temperature, humidity, pressure, LED)
- Tomoru / Tomoru full-color (LED)
- Sizuku LED
- Pochiru / Pochiru(eco) (button, LED)
- Sizuku 6x (gyroscope, accelerometer, orientation, LED)
- Sizuku Lux (illuminance, LED)

Note: Actual test has only be done with Tukeru TH and Sizuku THA.

### Unsupported

- Furueru (Vibration)
- Oshieru (door sensor)
- Kizuku (Vibration sensor)
- BLEAD-TSH-LK

## Dependencies

- Linux OS (Tested on Raspberry Pi 3)
- nodejs >= 8.0 (Tested by v8.11.3)
- node-red (Tested by v0.18.7)
- <a href="https://github.com/noble/noble">noble</a> : Using modified version maintained by <a href="https://github.com/jrobeson/noble">jrobeson/noble</a> which doesn't work on MacOS.
- <a href="https://github.com/futomi/node-linking">node-linking</a>

## Install guide

### Install bluetooth libraries

```
sudo apt-get -y install bluetooth libbluetooth-dev libudev-dev
```

### Install node-red-contrib-linking-device

In your node-red directory:

```
npm install node-red-contrib-linking-device
```

### Restart node-red

```
node-red-stop && node-red-start
```

## Usage

### Get beacon data by using linking-scanner

1.After installation you can see theree new nodes in `Linking device` category of pallete.

<img width="178" src="https://qiita-image-store.s3.amazonaws.com/0/12960/9abc86fd-80d6-997c-7f06-08da62847f92.png">

2.Drag-and-Drop the `linking-scanner` node into workspace, then double-click it.

- Check `Start automatically at startup`
- Set `Interval` to 60 (seconds).

<img width="500" src="https://qiita-image-store.s3.amazonaws.com/0/12960/ec7a0d07-a3cc-7445-2706-c3440d9788d4.png">

3.Drag-and-Drop `debug` node then connect it with `linking-scanner`.

<img width="414" src="https://qiita-image-store.s3.amazonaws.com/0/12960/cf7a3a3f-9075-3e3d-65e1-83787fddc43e.png">

4.Press `Deploy`

You can see output messages like below every 60 seconds in `debug tab`.

```
msg: {
  advertisement: object,
  payload: {
    device: "Sizuku_tha0141790",
    service: "temperature",
    value: 25.625
  },
  topic: "Sizuku_tha0141790_temperature"
}
```

`advertisement` is a <a href="https://github.com/futomi/node-linking/blob/master/README.md#LinkingAdvertisement-object">LinkingAdvertisement</a> object of node-linking. You can get detailed information like `rssi` from the object.

### Get sensor data by using linking-sensor

1.Drag-and-Drop the `linking-sensor` node into workspace, then double-click it.

- Select device
- Check `Start automatically at startup`
- Select type of sensor (you might have to wait 10~20 seconds to get available sensors).
- Set `Interval` to 60 (seconds).

<img width="502" src="https://qiita-image-store.s3.amazonaws.com/0/12960/1bb5ec5d-7d01-ece7-334e-412848bfe0cf.png">

2.Drag-and-Drop `debug` node then connect it with `linking-scanner`.

<img width="440" src="https://qiita-image-store.s3.amazonaws.com/0/12960/f8cad626-e13f-dea6-ae04-be231b975ce6.png">

3.Press `Deploy`

You can see output messages like below every 60 seconds in `debug tab`.

```
msg: {
  payload: {
    device: "Sizuku_tha0141790",
    service: "temperature",
    value: 25.625
  },
  topic: "Sizuku_tha0141790_temperature"
}
```

It's almost the same with linking-scanner except advertisement.

### Turn on LED by using linking-led

1.Drag-n-Drop the `linking-led` node into workspace, then double-click it.

- Select device
- Select color and pattern (you might have to wait 10~20 seconds to get available colors and patterns).
- Select type of sensor

<img width="496" src="https://qiita-image-store.s3.amazonaws.com/0/12960/414377b7-b6f2-d9fc-3d79-9012ebb20729.png">

2.Drag-n-Drop `inject` node then connect it with `linking-scanner`.

- Set payload of inject node to boolean `true`

<img width="403" src="https://qiita-image-store.s3.amazonaws.com/0/12960/8cdbedf3-8e93-d08c-bdf5-ecb7f8e5d50d.png">

3.Press deploy

4.Click inject node and see the LED turns on

You might have to wait 10~20 seconds to turn on LED.

## Notes

### Connection

Keeping connection extends battery life of Linking Device.

Range of Linking Device is not so long. If connection is unstable I recommend to use linking-scanner only.

### Use linking-sensor with linking-scanner

If you use linking-sensor, use also linking-scanner. If linking-sensor fails to connect to the device, linking-scanner ges sensor data.

### linking-led with linking-sensor

It takes 10-20 seconds to turn on LED when device is disconnected. Setting "Keep connection" in edit dialog will keep the device connectiong. But in the device is connected, linking-scanner can't get sensor from beacon signal. You should use linking-sensor in this case.

# Useful Links

- <a href="https://github.com/futomi/node-linking">node-linking</a> : node-red-contrib-linking-device is heavily relied on this library. Thanks!

# License

```
   Copyright (c) 2018 Takesh Inoue <inoue.takeshi@gmail.com>

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
