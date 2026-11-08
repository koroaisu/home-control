import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HomeControlBridge} from './streamdeck/com.koroaisu.homecontrol.sdPlugin/bridge.mjs';
import {LightController, actionPayload, powerState, ACTION} from './streamdeck/com.koroaisu.homecontrol.sdPlugin/controller.mjs';

const targets = [{provider: 'switchbot', id: 'bulb-1'}];
function controller(api, options) {
  const events = [];
  const instance = new LightController({api, ensure: async () => {}}, value => events.push(value), {wait: async () => {}, ...options});
  instance.handle({event: 'willAppear', action: ACTION, context: 'key', payload: {settings: {targets, action: 'toggle'}}});
  return {instance, events};
}

test('選択・数値・色を検証し、共通APIの形式に変換する', () => {
  assert.deepEqual(actionPayload({targets, action: 'color', color: '#ff8010'}).value, [255, 128, 16]);
  for (const settings of [{}, {targets, action: 'brightness', value: 101}, {targets, action: 'temperature', value: '4000'}, {targets, action: 'color', color: 'bad'}, {targets, action: 'constructor'}]) {
    assert.throws(() => actionPayload(settings));
  }
  assert.equal(powerState([{power: 'ON'}, {power: 'on'}]), 1);
  assert.equal(powerState([{power: 'OFF'}]), 0);
  assert.equal(powerState([{power: 'ON'}, {power: 'OFF'}]), 1);
  assert.equal(powerState([{}]), 2);
});

test('ボタン表示だけでは家電APIを呼ばず、設定変更も操作を送信しない', async () => {
  let count = 0;
  const {instance} = controller(async () => {count++;});
  await instance.handle({event: 'didReceiveSettings', context: 'key', payload: {settings: {targets, action: 'on'}}});
  assert.equal(count, 0);
});

test('連打は1コマンドにまとめ、受付後は実際に取得した状態を表示する', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  let commands = 0;
  const {instance, events} = controller(async (route, payload) => {
    if (payload) {commands++; await gate; return {results: [{id: 'bulb-1', accepted: true}]};}
    return {power: commands ? 'ON' : 'OFF'};
  });
  const first = instance.handle({event: 'keyDown', context: 'key'});
  const second = instance.handle({event: 'keyDown', context: 'key'});
  release(); await Promise.all([first, second]);
  assert.equal(commands, 1);
  assert.ok(events.some(e => e.event === 'showOk'));
  assert.equal(events.filter(e => e.event === 'setState').at(-1).payload.state, 1);
});

test('部分失敗・通信結果不明は再送せず警告し、成功アイコンを出さない', async () => {
  for (const result of [{results: [{accepted: false, error: 'offline'}]}, new Error('timeout')]) {
    let calls = 0;
    const {instance, events} = controller(async (route, payload) => {if (!payload) return {power: 'OFF'}; calls++; if (result instanceof Error) throw result; return result;});
    await instance.handle({event: 'keyDown', context: 'key'});
    assert.equal(calls, 1);
    assert.ok(events.some(e => e.event === 'showAlert'));
    assert.ok(!events.some(e => e.event === 'showOk'));
    assert.equal(events.filter(e => e.event === 'setState').at(-1).payload.state, 2);
  }
});

test('操作受付と状態取得の失敗を区別する', async () => {
  const {instance, events} = controller(async (route, payload) => {
    if (payload) return {results: [{accepted: true}]};
    throw new Error('status unavailable');
  });
  await instance.handle({event: 'keyDown', context: 'key'});
  assert.ok(events.some(e => e.event === 'showOk'));
  assert.ok(events.some(e => e.event === 'showAlert'));
  assert.match(events.at(-1).payload.message, /操作は受付済み/);
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'home-control-test-'));
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'server.mjs'), '');
  writeFileSync(path.join(root, 'data', 'config.json'), JSON.stringify({apiKey: 'test-only'}));
  return root;
}
const ok = data => ({ok: true, json: async () => data});
const refused = () => {throw new Error('fetch failed', {cause: {code: 'ECONNREFUSED'}});};

test('起動済みサービスを再利用し、終了時に停止しない', async () => {
  let launches = 0;
  const bridge = new HomeControlBridge(fixture(), {request: async () => ok({apiKey: 'test-only'}), launch: () => {launches++;}});
  await Promise.all([bridge.ensure(), bridge.ensure()]);
  bridge.close(); assert.equal(launches, 0);
});

test('サービス不在時のみ非表示で1回起動し、所有するプロセスだけ終了する', async () => {
  let running = false, launches = 0, killed = 0;
  const bridge = new HomeControlBridge(fixture(), {
    request: async () => running ? ok({apiKey: 'test-only'}) : refused(),
    launch: (node, args, options) => {
      launches++; running = true;
      assert.equal(options.windowsHide, true); assert.equal(options.stdio, 'ignore');
      const child = new EventEmitter(); child.kill = () => {killed++;}; return child;
    },
  });
  await Promise.all([bridge.ensure(), bridge.ensure()]);
  assert.equal(launches, 1); bridge.close(); assert.equal(killed, 1);
});

test('別サービスや別設定に接続せず、プロセスも勝手に起動しない', async () => {
  for (const request of [async () => ok({apiKey: 'other'}), async () => ({ok: false}), async () => {throw new Error('timeout');}]) {
    let launches = 0;
    const bridge = new HomeControlBridge(fixture(), {request, launch: () => {launches++;}});
    await assert.rejects(() => bridge.ensure()); assert.equal(launches, 0);
  }
});

const lastState = events => events.filter(e => e.event === 'setState' && e.context === 'key').at(-1).payload.state;
const keySettings = action => ({event: 'didReceiveSettings', context: 'key', payload: {settings: {targets, action}}});

test('明るさ1%・50%・100%に関係なく点灯は黄色、1台でも点灯なら黄色', () => {
  for (const brightness of [1, 20, 50, 99, 100]) {
    assert.equal(powerState([{power: 'on', brightness}]), 1);
    assert.equal(powerState([{power: 'off', brightness: 100}, {power: 'on', brightness}]), 1);
  }
  assert.equal(powerState([{power: 'off', brightness: 85}, {power: 'off', brightness: 1}]), 0);
  assert.equal(powerState([{power: 'off'}, {}]), 2);
});

test('オフ受付直後は取得待ち中も灰色にし、青へ戻さない', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const {instance, events} = controller(async (route, body) => body ? {results: [{id: 'bulb-1', accepted: true}]} : {power: 'off', brightness: 85}, {wait: () => gate});
  await instance.handle(keySettings('off'));
  const pending = instance.handle({event: 'keyDown', context: 'key'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lastState(events), 0);
  release(); await pending;
  assert.equal(lastState(events), 0);
});

test('ボタンの確認も古いクラウド状態を3回まで読み直し、予想の色を保持する', async () => {
  let reads = 0, writes = 0;
  const waits = [];
  const {instance, events} = controller(async (route, body) => {
    if (body) {writes++; return {results: [{id: 'bulb-1', accepted: true}]};}
    return {power: ++reads < 3 ? 'ON' : 'OFF', brightness: 85};
  }, {wait: async ms => {waits.push(ms); assert.equal(lastState(events), 0);}});
  await instance.handle(keySettings('off'));
  await instance.handle({event: 'keyDown', context: 'key'});
  assert.deepEqual(waits, [1500, 3000, 5000]);
  assert.equal(reads, 3); assert.equal(writes, 1);
  assert.equal(lastState(events), 0);
  assert.ok(!events.some(e => e.event === 'showAlert'));
});

test('ダイヤルから受け取った点灯50%・消灯状態もボタンへ反映する', () => {
  const {instance, events} = controller(async () => {});
  instance.receiveStates([{...targets[0], power: 'on', brightness: 50}]);
  assert.equal(lastState(events), 1);
  instance.receiveStates([{...targets[0], power: 'off', brightness: 50}]);
  assert.equal(lastState(events), 0);
});

test('ボタンの待機時間が共有キューを占有せず他の操作を実行できる', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const {instance} = controller(async (route, body) => body ? {results: [{id: 'bulb-1', accepted: true}]} : {power: 'off'}, {wait: () => gate});
  await instance.handle(keySettings('off'));
  const pending = instance.handle({event: 'keyDown', context: 'key'});
  await new Promise(resolve => setImmediate(resolve));
  let ran = false;
  await instance.enqueue(async () => {ran = true;});
  assert.equal(ran, true);
  release(); await pending;
});

test('新しい操作後に古い確認結果でアイコンを上書きしない', async () => {
  const releases = [];
  let reads = 0;
  const {instance, events} = controller(async (route, body) => {
    if (body) return {results: [{id: 'bulb-1', accepted: true}]};
    reads++; return {power: 'on', brightness: 20};
  }, {wait: () => new Promise(resolve => releases.push(resolve))});
  await instance.handle(keySettings('off'));
  const first = instance.handle({event: 'keyDown', context: 'key'});
  await new Promise(resolve => setImmediate(resolve));
  await instance.handle(keySettings('on'));
  const second = instance.handle({event: 'keyDown', context: 'key'});
  await new Promise(resolve => setImmediate(resolve));
  releases[1](); await second;
  releases[0](); await first;
  assert.equal(reads, 1); assert.equal(lastState(events), 1);
});

test('3回とも状態が取得できないときだけ不明の青へ戻して警告する', async () => {
  let reads = 0, writes = 0;
  const {instance, events} = controller(async (route, body) => {
    if (body) {writes++; return {results: [{id: 'bulb-1', accepted: true}]};}
    reads++; throw new Error('offline');
  });
  await instance.handle(keySettings('on'));
  await instance.handle({event: 'keyDown', context: 'key'});
  assert.equal(reads, 3); assert.equal(writes, 1);
  assert.equal(lastState(events), 2);
  assert.ok(events.some(e => e.event === 'showAlert'));
});
