import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceCatalog} from './streamdeck/com.koroaisu.homecontrol.sdPlugin/catalog.mjs';
import {BrightnessDial, DIAL_ACTION} from './streamdeck/com.koroaisu.homecontrol.sdPlugin/dial.mjs';

const bulb = name => ({provider: 'switchbot', id: 'one', name});
function fixture(api, update = () => {}) {
  const timers = new Map(), updates = [];
  let next = 0;
  const catalog = new DeviceCatalog({api}, devices => {updates.push(devices); update(devices);}, {
    schedule: (work, ms) => {const id = ++next; timers.set(id, {work, ms}); return id;},
    cancel: id => timers.delete(id),
  });
  const tick = async () => {
    const [id, timer] = [...timers][0]; timers.delete(id);
    assert.equal(timer.ms, 60000); await timer.work();
  };
  return {catalog, timers, updates, tick};
}

test('機器名を起動時と60秒ごとにキャッシュを回避して取得する', async () => {
  const routes = [];
  const f = fixture(async route => {routes.push(route); return {devices: [bulb(routes.length === 1 ? '電球1' : 'デスク照明')]};});
  await f.catalog.start(); await f.tick();
  assert.deepEqual(routes, ['/api/v1/devices?refresh=1', '/api/v1/devices?refresh=1']);
  assert.equal(f.updates[1][0].name, 'デスク照明');
  f.catalog.stop();
});

test('複数の利用先が同時に更新を要求しても一覧取得は1回にまとめる', async () => {
  let release, requests = 0;
  const gate = new Promise(resolve => {release = resolve;});
  const f = fixture(async () => {requests++; await gate; return {devices: [bulb('照明')]};});
  const a = f.catalog.get(true), b = f.catalog.get(true), c = f.catalog.get();
  release(); await Promise.all([a, b, c]);
  assert.equal(requests, 1); assert.equal(f.updates.length, 1);
});

test('通常の参照はキャッシュし、手動更新は最新の一覧を取得する', async () => {
  let requests = 0;
  const f = fixture(async () => ({devices: [bulb(`照明${++requests}`)]}));
  await f.catalog.get(); await f.catalog.get(); assert.equal(requests, 1);
  await f.catalog.get(true); assert.equal(requests, 2);
});

test('更新に失敗した場合は前の機器名を残して次の周期で復帰する', async () => {
  let requests = 0;
  const f = fixture(async () => {
    requests++; if (requests === 2) throw new Error('offline');
    return {devices: [bulb(requests === 1 ? '元の名前' : '新しい名前')]};
  });
  await f.catalog.start(); await f.tick();
  assert.equal(f.catalog.devices[0].name, '元の名前');
  assert.equal(f.updates.length, 1);
  await f.tick(); assert.equal(f.catalog.devices[0].name, '新しい名前');
  f.catalog.stop();
});

test('初回取得に失敗しても次の周期で再試行する', async () => {
  let requests = 0;
  const f = fixture(async () => {if (++requests === 1) throw new Error('offline'); return {devices: [bulb('復帰')]};});
  await f.catalog.start(); assert.equal(f.updates.length, 0);
  await f.tick(); assert.equal(f.updates[0][0].name, '復帰');
  f.catalog.stop();
});

test('二重起動は周期を増やさず、停止時に予約を取り消す', async () => {
  const f = fixture(async () => ({devices: [bulb('照明')]}));
  await Promise.all([f.catalog.start(), f.catalog.start()]);
  assert.equal(f.timers.size, 1); assert.equal(f.updates.length, 1);
  f.catalog.stop(); assert.equal(f.timers.size, 0);
});

test('停止後に通信が完了しても表示を更新せず、次回の予約もしない', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const f = fixture(async () => {await gate; return {devices: [bulb('照明')]};});
  const starting = f.catalog.start(); f.catalog.stop(); release(); await starting;
  assert.equal(f.updates.length, 0); assert.equal(f.timers.size, 0);
});

test('周期更新でダイヤル名が変わっても選択ID・消灯0%・操作状態を保持する', async () => {
  let name = '電球1';
  const events = [];
  const dial = new BrightnessDial({api: async () => ({power: 'OFF', brightness: 85})}, e => events.push(e));
  const f = fixture(async () => ({devices: [bulb(name)]}), devices => dial.updateDeviceNames(devices));
  const settings = {targets: [{provider: 'switchbot', id: 'one', name: '古い保存名'}], pressAction: 'off'};
  await dial.handle({action: DIAL_ACTION, context: 'dial', event: 'willAppear', payload: {settings}});
  await dial.handle({action: DIAL_ACTION, context: 'dial', event: 'touchTap'});
  const entry = dial.entries.get('dial');
  await f.catalog.start(); name = 'ベッド照明'; await f.tick();
  const feedback = events.filter(e => e.event === 'setFeedback').at(-1).payload;
  assert.equal(feedback.deviceName, 'ベッド照明'); assert.equal(feedback.value, '0%');
  assert.equal(dial.entries.get('dial'), entry); assert.equal(entry.settings, settings);
  f.catalog.stop(); dial.close();
});
