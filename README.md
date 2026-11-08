# Home Control

SwitchBotスマート電球の共通操作サービス。Stream Deckと将来の専用アプリが同じAPIを利用します。追加パッケージは不要です。

GitHubから取得した場合は、先に [Node.js](https://nodejs.org/) 24以降をインストールしてください。このPCでは `runtime/` に配置したNode.jsを使用します。`runtime/`、認証設定の `data/`、生成した `buttons/` はGitの管理対象外です。

## 始め方

1. `start.cmd` をダブルクリックし、ウィンドウを開いたままにします。
2. ブラウザで http://127.0.0.1:3210 を開きます。初回に表示が間に合わなければ再読み込みしてください。
3. SwitchBotのトークン・シークレットを設定画面に入力し保存します。
4. 電球を選んで実行します。機器ごとのボタンは1台、一括ボタンは4台を選びます。
5. 操作を選び「Stream Deck用ファイルを作る」を押し、表示された .cmd をStream Deckの「システム → 開く」に指定します。

API Ninjaは不要になります。ボタン生成後にこのフォルダを移動するとパスが変わるため再生成してください。現段階では専用Stream Deckプラグインではなく、生成したファイルを開く方式です。ボタンの状態表示や自動起動は未実装です。

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

`runtime\node-v24.22.2-win-x64\node.exe --test`。モックによる署名・操作検証・対象制限・APIエラーのテストを含みます。実機確認にはユーザー自身の認証情報が必要です。

公式仕様: https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/lighting/color-bulb.md
