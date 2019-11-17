# node-red-contrib-linking-device

\[[English](./README.md)\]

これは、BLE(Bluetooth Low Energy)デバイスの一種、<a href="https://linkingiot.com/devices.html">Linkingデバイス</a>にアクセスするためのNode-REDカスタムノードです。 

Linkingデバイスについて、詳しくは <a href="https://linkingiot.com/index.html">Project Linking</a> のページを参照してください.

Linkingデバイス用ノードは以下の3つです

- linking-scanner : Linkingデバイスをスキャンし、ビーコン(センサー)データを取得します。
- linking-sensor : Linkingデバイスに接続して、センサー情報を取得します。
- linking-led : Linkingデバイスに接続して、LEDの点灯リクエストを出します。

## Linkingデバイスの対応状況

### 対応済み

- Tukeru TH (temperature, humidity, LED)
- Sizuku THA (temperature, humidity, pressure, LED)
- Tomoru / Tomoru full-color (LED)
- Sizuku LED
- Pochiru / Pochiru(eco) (button, LED)
- Sizuku 6x (gyroscope, accelerometer, orientation, LED)
- Sizuku Lux (illuminance, LED)
- Oruto (motion sensor)

※ 実際のテストはTukeru TH, Sizuku THA, Shizuku Lux, Pochiru(eco)でのみ行っています。

### 対応していない

- Furueru (Vibration)
- Oshieru (door sensor)
- Kizuku (Vibration sensor)
- BLEAD-TSH-LK

## Dependencies

- Linux OS (Tested on Raspberry Pi 3)
- nodejs >= 8.0 (Tested by v8.11.3)
- node-red (Tested by v0.18.7)
- <a href="https://github.com/noble/noble">noble</a> : <a href="https://github.com/jrobeson/noble">jrobeson/noble</a> の改変バージョンを使用。MacOSでは動きません。
- <a href="https://github.com/futomi/node-linking">node-linking</a>: Linkingデバイスを使うためのNodejsライブラリ

## インストール

### Bluooth関連ライブラリのインストール

```
sudo apt-get -y install bluetooth libbluetooth-dev libudev-dev
```

## node-red-contrib-linking-deviceのインストール

```
cd ~/.node-red
npm install node-red-contrib-linking-device
```

node-redを再起動

```
node-red-stop && node-red-start
```

## 利用方法

### linking-scannerでビーコン(センサー)データを収集する

1.インストールすると、Node-REDのパレットの linking device カテゴリーにノードが追加されます。

<img width="178" src="https://qiita-image-store.s3.amazonaws.com/0/12960/9abc86fd-80d6-997c-7f06-08da62847f92.png">

2.まず、linking-scannerノードをワークスペースにドラッグ＆ドロップし、ダブルクリックして設定を開きます。

- `Start automatically at startup` をチェック
- Intervalを60(秒)に設定

<img width="500" src="https://qiita-image-store.s3.amazonaws.com/0/12960/ec7a0d07-a3cc-7445-2706-c3440d9788d4.png">

3.次に、debugノードをワークスペースにドラッグ＆ドロップして、linking-scannerと接続します。

<img width="414" src="https://qiita-image-store.s3.amazonaws.com/0/12960/cf7a3a3f-9075-3e3d-65e1-83787fddc43e.png">

4.デプロイします。デバッグタブにLinkingデバイスからのビーコンデータが表示されれば正常動作してます。

上記設定だと、だいたい1分間隔で各センサからの以下のようなデータが表示されます。

```
msg: {
  advertisement: object,
  payload: {
    device: "Sizuku_tha0141790",
    service: "temperature",
    data: 25.625
  },
  topic: "Sizuku_tha0141790_temperature"
}
```

advertisementはnode-linkingの [LinkingAdvertisement](https://github.com/futomi/node-linking/blob/master/README_ja.md#LinkingAdvertisement-object)オブジェクトそのままです。rssiやdistanceなどの詳細情報を取りたいときに参照します。 

### linking-sensorでセンサーデータを収集する

このノードを使う場合、安定して接続できるぐらいデバイスが近くにある必要があります。取れる情報は原則linking-scannerとほぼ同じですが、電池の持ちが良くなるのが利点です。

1.まず、linking-sensorノードをワークスペースにドラッグ＆ドロップし、ダブルクリックして設定を開きます。

- デバイスを選択
- `Start automatically at startup` をチェック
- しばらく時間がかかりますが、センサーの対応状況が読み込まれ、battery以外はデフォルトでチェックされます
- Intervalを60(秒)に設定

<img width="502" src="https://qiita-image-store.s3.amazonaws.com/0/12960/1bb5ec5d-7d01-ece7-334e-412848bfe0cf.png">

2.次に、debugノードをワークスペースにドラッグ＆ドロップして、linking-scannerと接続します。

<img width="440" src="https://qiita-image-store.s3.amazonaws.com/0/12960/f8cad626-e13f-dea6-ae04-be231b975ce6.png">

3.デプロイします。デバッグタブにLinkingデバイスからのビーコンデータが表示されれば正常動作してます。

上記設定だと、だいたい1分間隔で各センサからの以下のようなデータが表示されます。
advertisementがない意外は、linking-scannerと同じ内容です。

```
msg: {
  payload: {
    device: "Sizuku_tha0141790",
    service: "temperature",
    data: 25.625
  },
  topic: "Sizuku_tha0141790_temperature"
}
```

### linking-ledでLEDを点灯する

このノードを使う場合、安定して接続できるぐらいデバイスが近くにある必要があります。

1.まず、linking-ledノードをワークスペースにドラッグ＆ドロップし、ダブルクリックして設定を開きます。

- デバイスを選択
- しばらく時間がかかりますが、対応しているLEDの色・点灯パターンが読み込まれ、リストに表示されます。表示されない場合はリフレッシュボタンを押してください。
- ここでTestボタンを押してLEDを点灯させてみることもできます。

<img width="496" src="https://qiita-image-store.s3.amazonaws.com/0/12960/414377b7-b6f2-d9fc-3d79-9012ebb20729.png">

2.Injectノードをワークスペースにドラッグ＆ドロップし、trueを出力するように設定して、linking-ledとつなげます。

<img width="403" src="https://qiita-image-store.s3.amazonaws.com/0/12960/8cdbedf3-8e93-d08c-bdf5-ecb7f8e5d50d.png">
3.Injectノードをクリックすると、10～20秒後にLEDが点灯します。

## Notes

### Linkingデバイスとの接続について

linking-sernsorを使ってLinkingデバイスと接続した状態で使用すると、デバイスのバッテリーを長持ちさせることが出来ます。
一方、接続が可能な距離はそんなに長くありません(Raspberry Pi3では数メートル程度)。接続が不安定な場合は、linking-scannerだけでの使用をお勧めします。

### linking-sensorを使う場合はlinking-scannerもつかう

linking-sensorでデータ収集を行う場合でも、接続がうまくいかない場合を考慮して、linking-scannerをバックアップとして併用するのをおすすめします。デバイスが接続中の場合はlinking-sensorが、接続できない場合はlinking-scannerがデータを収集します。

### linking-led を使う場合はlinking-sensorも使う

デバイスが接続されていない状態だと、点灯リクエストを出して実際にLEDが点灯するまで10〜20秒程度かかります。すぐに点灯させたい場合は、"Keep connection"オプションをチェックしておく必要があります。ただし、接続中はlinking-scannerでのセンサーデータの収集はできません。代わりにlinking-sensorを使う必要があります。

# 参考リンク

- <a href="https://github.com/futomi/node-linking">node-linking</a>

node-red-contrib-linking-device はこのライブラリが無ければ出来ませんでした。ありがとうございます。Linkingデバイスに関するドキュメントが充実しているので、ぜひ一読をお勧めします。

# License

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
