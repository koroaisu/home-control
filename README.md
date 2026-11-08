# Home Control

SwitchBotスマート電球の共通操作サービス。Stream Deck専用プラグインと将来の専用アプリが同じAPIを利用します。実行時の追加パッケージは不要です。プラグイン登録時には開発用のElgato公式CLIを使います。

GitHubから取得した場合は、先に [Node.js](https://nodejs.org/) 24以降をインストールしてください。このPCでは `runtime/` に配置したNode.jsを使用します。`runtime/`、認証設定の `data/`、生成した `buttons/` はGitの管理対象外です。

## Stream Deck専用プラグイン（推奨）

Windows 10以降、Stream Deck 7.6以降、Node.js 24以降を使用します。

1. 初回は下記のWeb設定画面でSwitchBotの認証情報を保存します。すでに保存済みなら再入力は不要です。
2. プロジェクト内で `npm ci` を実行し、登録用の公式CLIを準備します。
3. `install-plugin.cmd` を実行します。プロジェクト内のプラグインをStream DeckのPluginsフォルダへジャンクションで登録します。
4. 初回登録後はStream Deckを通知領域から終了し、再起動してください。開発者モードが無効だとCLIのrestartは成功表示でも再読み込みされない場合があります。
5. アクション一覧で「Home Control」を検索し、「電球を操作」を空きボタンにドラッグします。
6. 電球を選択し、オン・オフ・切り替え・明るさ・色温度・色を選びます。複数の電球を選ぶと一括操作になります。

プラグインがHome Controlを非表示で自動起動するため、通常は `start.cmd` のウィンドウを開いておく必要はありません。すでに手動起動しているサービスは再利用します。プラグインの終了処理では、自分で起動したサービスだけを停止対象にします。

アイコンは黄＝全台オン、灰＝全台オフ、青＝未確認または状態の混在です。操作後と「状態を確認」で更新し、常時監視はしません。クラウド上の状態と実機反映に時間差がある場合があります。連打中の同じボタンの追加操作は無視し、失敗した操作は自動再送しません。

登録先はプロジェクトへのリンクです。このフォルダを移動・削除するとプラグインが動かなくなるため、移動時は登録先と `connection.json` を確認してください。このファイルはインストーラが生成し、Gitの管理対象外です。

## Web設定画面・従来のファイル方式

1. `start.cmd` をダブルクリックし、ウィンドウを開いたままにします。
2. ブラウザで http://127.0.0.1:3210 を開きます。初回に表示が間に合わなければ再読み込みしてください。
3. SwitchBotのトークン・シークレットを設定画面に入力し保存します。
4. 電球を選んで実行します。機器ごとのボタンは1台、一括ボタンは4台を選びます。
5. 操作を選び「Stream Deck用ファイルを作る」を押し、表示された .cmd をStream Deckの「システム → 開く」に指定します。

API Ninjaは不要になります。従来の生成ファイル方式も引き続き使えます。ボタン生成後にこのフォルダを移動するとパスが変わるため再生成してください。

認証情報は `data/config.json` に平文でローカル保存します。このフォルダを共有・公開しないでください。認証情報をチャットに貼る必要はありません。現在は同一PC内での利用専用で、他のディスプレイ端末からは接続できません。

## 専用アプリ用API v1

同一PCのネイティブアプリは `data/config.json` の apiKey を読み取り、`Authorization: Bearer <apiKey>` を付けます。ブラウザ画面は同一オリジンで提供してください。

- `GET /api/v1/devices` → `{devices:[{provider,id,name,kind,capabilities}]}`。一覧を60秒キャッシュ。`?refresh=1` で再取得。
- `GET /api/v1/devices/switchbot/{id}/status` → SwitchBotから取得した状態。自動ポーリングは行いません。
- `POST /api/v1/actions` → 下記ボディ。`results` は機器ごとの受付結果。部分失敗でも各結果を確認してください。

```json
{"targets":[{"provider":"switchbot","id":"機器ID"}],"action":"on"}
```

action: `on`, `off`, `toggle`, `brightness`（value: 整数1〜100）, `temperature`（value: 整数2700〜6500）, `color`（value: [R,G,B]、各0〜255）。対象は明示指定、最大32台。一括操作は順番に送信するため完全同時ではありません。toggleは各電球の状態を反転します。通信失敗は再送せず、受付成功は実機反映の保証とは区別します。

## 拡張方針

`switchbot.mjs` は接続処理、`server.mjs` は共通HTTP API、`index.html` は設定・操作画面、`client.mjs` はStream Deckからの呼び出しを担当します。接続処理は `devices`, `execute`, `status` を持ち、機器は provider/kind/capabilities で表現します。

現在の実装は電球のみです。エアコン・掃除機を追加する際は機種別capabilitiesと操作の検証を追加します。Alexaの音楽や音量は別providerとして、使用する端末・音楽サービス・認証方式が決まった段階で実装します。外部端末対応時は認証情報の配布・TLS・接続許可を別途設計し、単純に待ち受けアドレスを変えないでください。

## 検証

`npm test` または `runtime\node-v24.22.2-win-x64\node.exe --test`。署名・操作検証・対象制限・APIエラーに加え、連打・部分失敗・サービスの再利用と自動起動など12件のモックテストを含みます。プラグイン形式は `npx streamdeck validate streamdeck/com.koroaisu.homecontrol.sdPlugin` で検証できます。

2026-11-08、Stream Deck 7.6.0.23012でプラグインの表示・接続を確認し、ユーザーから専用プラグインのボタンで電球を実際に操作できたとの報告を受けました。PC再起動後の自動起動や全操作種類の実機確認は未実施です。

公式仕様: https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/lighting/color-bulb.md
