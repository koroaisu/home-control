import test from 'node:test';
import assert from 'node:assert/strict';
import {BrightnessDial, DIAL_ACTION, dialSettings, dialPressAction} from './streamdeck/com.koroaisu.homecontrol.sdPlugin/dial.mjs';
import {LightController, ACTION} from './streamdeck/com.koroaisu.homecontrol.sdPlugin/controller.mjs';

const target = id => ({provider: 'switchbot', id});
const settings = {targets: [target('one')], step: 5};
function fixture(api, initial = settings, extras = {}) {
  const events = [], timers = new Map();
  let next = 0, now = 10000, queue = Promise.resolve();
  const dial = new BrightnessDial({api, ensure: async () => {}}, e => events.push(e), {
    enqueue: work => {const run = queue.then(work); queue = run.catch(() => {}); return run;},
    schedule: (callback, ms) => {const id = ++next; timers.set(id, {callback, at: now + ms}); return id;},
    cancel: id => timers.delete(id), now: () => now, ...extras,
  });
  const emit = (event, payload = {}, context = 'dial') => dial.handle({action: DIAL_ACTION, context, event, payload});
  emit('willAppear', {settings: initial});
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) {
      timers.delete(id); await timer.callback();
    }
  };
  return {dial, emit, advance, events, timers};
}

test('ダイヤルの対象と変更幅を検証し、重複する対象を除く', () => {
  assert.equal(dialSettings({targets: [target('one'), target('one')]}).targets.length, 1);
  assert.equal(dialSettings(settings).step, 5);
  for (const input of [{}, {...settings, step: 0}, {...settings, step: 26}, {...settings, step: 1.5}, {...settings, step: '5'}]) assert.throws(() => dialSettings(input));
});

test('表示と設定変更ではクラウドへアクセスせず、ダイヤル用フィードバックだけ送る', async () => {
  let calls = 0;
  const f = fixture(async () => {calls++;});
  await f.emit('didReceiveSettings', {settings});
  assert.equal(calls, 0);
  assert.ok(f.events.every(e => ['setFeedback', 'setTriggerDescription', 'setFeedbackLayout'].includes(e.event)));
});

test('現在値から増減し、連続回転は最後の絶対値1回にまとめる', async () => {
  const writes = [], reads = [];
  const f = fixture(async (route, body) => {
    if (!body) {reads.push(route); return {power: 'ON', brightness: 40};}
    writes.push(body); return {results: [{accepted: true}]};
  });
  await f.emit('dialRotate', {ticks: 1});
  await f.advance(200);
  await f.emit('dialRotate', {ticks: 3});
  await f.emit('dialRotate', {ticks: -1});
  await f.advance(399); assert.equal(writes.length, 0);
  await f.advance(1);
  assert.equal(reads.length, 1);
  assert.deepEqual(writes, [{targets: settings.targets, action: 'brightness', value: 55}]);
  assert.equal(f.events.filter(e => e.event === 'setFeedback').at(-1).payload.status, '受付済み');
});

test('初回取得中の回転を失わず、上限で折り返した回転も正しく扱う', async () => {
  let resolveStatus;
  const status = new Promise(resolve => {resolveStatus = resolve;});
  const writes = [];
  const f = fixture(async (route, body) => {
    if (!body) return status;
    writes.push(body); return {results: [{accepted: true}]};
  });
  const first = f.emit('dialRotate', {ticks: 2});
  const second = f.emit('dialRotate', {ticks: -1});
  resolveStatus({power: 'ON', brightness: 98}); await Promise.all([first, second]);
  await f.advance(400); assert.equal(writes[0].value, 95);
});

test('1〜100%に制限し、値が変わらなければ送信しない', async () => {
  const writes = [];
  const f = fixture(async (route, body) => {
    if (!body) return {power: 'ON', brightness: 100};
    writes.push(body); return {results: [{accepted: true}]};
  });
  await f.emit('dialRotate', {ticks: 20}); await f.advance(2000);
  assert.equal(writes.length, 0);
  await f.emit('dialRotate', {ticks: -100}); await f.advance(400);
  assert.equal(writes[0].value, 1);
});

test('複数の電球を先頭の値を基準に同じ明るさへ設定する', async () => {
  const writes = [];
  const initial = {targets: [target('one'), target('two')], step: 2};
  const f = fixture(async (route, body) => {
    if (!body) return {power: 'ON', brightness: route.includes('/one/') ? 40 : 80};
    writes.push(body); return {results: [{accepted: true}, {accepted: true}]};
  }, initial);
  await f.emit('dialRotate', {ticks: 1}); await f.advance(400);
  assert.deepEqual(writes[0], {targets: initial.targets, action: 'brightness', value: 42});
});

test('送信中の回転は並行送信せず、応答後に最新値だけ送る', async () => {
  const writes = [];
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const f = fixture(async (route, body) => {
    if (!body) return {power: 'ON', brightness: 50};
    writes.push(body.value); if (writes.length === 1) await gate;
    return {results: [{accepted: true}]};
  });
  await f.emit('dialRotate', {ticks: 1});
  const sending = f.advance(400);
  await new Promise(resolve => setImmediate(resolve));
  await f.emit('dialRotate', {ticks: 2});
  await f.emit('dialRotate', {ticks: -1});
  assert.deepEqual(writes, [55]);
  release(); await sending;
  await f.advance(999); assert.deepEqual(writes, [55]);
  await f.advance(1); assert.deepEqual(writes, [55, 60]);
});

test('設定変更・ページ非表示で未送信の回転を取り消す', async () => {
  for (const event of ['didReceiveSettings', 'willDisappear']) {
    const writes = [];
    const f = fixture(async (route, body) => {
      if (!body) return {power: 'ON', brightness: 50};
      writes.push(body); return {results: [{accepted: true}]};
    });
    await f.emit('dialRotate', {ticks: 1});
    await f.emit(event, {settings: {targets: [target('two')], step: 5}});
    await f.advance(5000); assert.equal(writes.length, 0);
  }
});

test('取得失敗・不正な状態値の場合は推測した明るさを送信しない', async () => {
  for (const status of [{power: 'ON', brightness: 0}, {}, new Error('offline')]) {
    let writes = 0;
    const f = fixture(async (route, body) => {
      if (body) {writes++; return {results: [{accepted: true}]};}
      if (status instanceof Error) throw status; return status;
    });
    await f.emit('dialRotate', {ticks: 1}); await f.advance(5000);
    assert.equal(writes, 0); assert.ok(f.events.some(e => e.event === 'showAlert'));
  }
});

test('通信結果不明・部分失敗は待機中の値も破棄し、再送しない', async () => {
  for (const result of [new Error('timeout'), {results: [{accepted: false}]}]) {
    let writes = 0;
    const f = fixture(async (route, body) => {
      if (!body) return {power: 'ON', brightness: 50};
      writes++; if (result instanceof Error) throw result; return result;
    });
    await f.emit('dialRotate', {ticks: 1}); await f.advance(400); await f.advance(10000);
    assert.equal(writes, 1); assert.equal(f.dial.entries.get('dial').value, null);
    assert.ok(f.events.at(-1).payload.message.includes('自動再送はしません'));
  }
});

test('押し込みの旧設定は何もせず、タップだけで再取得する', async () => {
  let calls = 0;
  const f = fixture(async (route, body) => {assert.equal(body, undefined); calls++; return {power: 'ON', brightness: 27};});
  await f.emit('dialDown'); await f.emit('dialUp'); await f.emit('touchTap');
  assert.equal(calls, 1);
  assert.equal(f.dial.entries.get('dial').value, 27);
});

test('共有キューで待機中に対象が変わった場合は古い対象へ送信しない', async () => {
  let enqueueWork;
  let writes = 0;
  const f = fixture(async (route, body) => {
    if (body) writes++;
    return {power: 'ON', brightness: 50, results: [{accepted: true}]};
  });
  await f.emit('dialRotate', {ticks: 1});
  f.dial.enqueue = work => new Promise(resolve => {enqueueWork = async () => {await work(); resolve();};});
  const waiting = f.advance(400);
  await f.emit('didReceiveSettings', {settings: {targets: [target('two')]}});
  await enqueueWork(); await waiting;
  assert.equal(writes, 0);
});

test('押し込みの状態取得は排除し、未設定・旧statusは何もしない', () => {
  assert.equal(dialPressAction({}), 'none');
  assert.equal(dialPressAction({pressAction: 'status'}), 'none');
  for (const pressAction of ['toggle', 'on', 'off', 'none']) assert.equal(dialPressAction({pressAction}), pressAction);
  for (const pressAction of ['brightness', 'constructor', '', 1]) assert.throws(() => dialPressAction({pressAction}));
});

test('押し込みで選択した電源操作だけを送信し、離すイベントでは送らない', async () => {
  for (const pressAction of ['toggle', 'on', 'off']) {
    const writes = [];
    const f = fixture(async (route, body) => {if (!body) return {power: 'ON', brightness: 50}; writes.push(body); return {results: [{accepted: true}]};}, {...settings, pressAction});
    await f.emit('dialDown'); await f.emit('dialUp');
    assert.deepEqual(writes, [{targets: settings.targets, action: pressAction}]);
    assert.equal(f.dial.entries.get('dial').value, 50);
    assert.ok(f.dial.entries.get('dial').verification);
    assert.ok(f.events.some(e => e.event === 'setTriggerDescription' && e.payload.push.includes(pressAction === 'off' ? 'オフ' : 'オン')));
  }
});

test('複数台の押し込みも同じ選択対象に一括送信する', async () => {
  const initial = {targets: [target('one'), target('two')], pressAction: 'off'};
  const writes = [];
  const f = fixture(async (route, body) => {if (!body) return {power: 'ON', brightness: 50}; writes.push(body); return {results: [{accepted: true}, {accepted: true}]};}, initial);
  await f.emit('dialDown');
  assert.deepEqual(writes, [{targets: initial.targets, action: 'off'}]);
});

test('何もしない設定は対象が未選択でも通信せず、タップでは電源操作をしない', async () => {
  let count = 0;
  const f = fixture(async (route, body) => {assert.equal(body, undefined); count++; return {power: 'ON', brightness: 30};}, {pressAction: 'none'});
  await f.emit('dialDown'); assert.equal(count, 0);
  await f.emit('didReceiveSettings', {settings: {...settings, pressAction: 'toggle'}});
  await f.emit('touchTap'); assert.equal(count, 1);
});

test('電源操作中の連打・回転は追加の操作を送信しない', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const writes = [];
  const f = fixture(async (route, body) => {if (!body) return {power: 'ON', brightness: 50}; writes.push(body); await gate; return {results: [{accepted: true}]};}, {...settings, pressAction: 'toggle'});
  const press = f.emit('dialDown');
  await f.emit('dialDown'); await f.emit('dialRotate', {ticks: 1}); await f.emit('touchTap');
  release(); await press; await f.advance(5000);
  assert.equal(writes.length, 1); assert.equal(writes[0].action, 'toggle');
});

test('押し込みの電源操作は未送信の明るさ変更を取り消す', async () => {
  const writes = [];
  const f = fixture(async (route, body) => {
    if (!body) return {power: 'ON', brightness: 40};
    writes.push(body); return {results: [{accepted: true}]};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialRotate', {ticks: 1});
  await f.emit('dialDown'); await f.advance(5000);
  assert.deepEqual(writes.map(w => w.action), ['off']);
});

test('送信中の明るさが終わってから電源操作し、自動確認まで回転を待つ', async () => {
  let release, reads = 0;
  const gate = new Promise(resolve => {release = resolve;});
  const writes = [];
  const f = fixture(async (route, body) => {
    if (!body) {reads++; return {power: 'ON', brightness: 40};}
    writes.push(body); if (writes.length === 1) await gate;
    return {results: [{accepted: true}]};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialRotate', {ticks: 1});
  const brightness = f.advance(400);
  await new Promise(resolve => setImmediate(resolve));
  const power = f.emit('dialDown');
  assert.deepEqual(writes.map(w => w.action), ['brightness']);
  release(); await Promise.all([brightness, power]);
  assert.deepEqual(writes.map(w => w.action), ['brightness', 'off']);
  const before = reads;
  await f.emit('dialRotate', {ticks: -1});
  assert.equal(reads, before);
  await f.advance(1500);
  assert.equal(reads, before + 1);
});

test('電源操作の失敗・結果不明は再送せず、確認方法にタップを案内する', async () => {
  for (const result of [new Error('timeout'), {results: [{accepted: false}]}]) {
    let writes = 0;
    const f = fixture(async (route, body) => {if (!body) return {power: 'ON', brightness: 50}; writes++; if (result instanceof Error) throw result; return result;}, {...settings, pressAction: 'toggle'});
    await f.emit('dialDown'); await f.advance(10000);
    assert.equal(writes, 1);
    assert.ok(f.events.some(e => e.event === 'showAlert'));
    assert.match(f.events.at(-1).payload.message, /画面をタップ/);
  }
});

test('待機中に設定が変わった場合は古い押し込み動作を送らない', async () => {
  let work, writes = 0;
  const f = fixture(async () => {writes++;}, {...settings, pressAction: 'on'}, {
    enqueue: callback => new Promise(resolve => {work = async () => {await callback(); resolve();};}),
  });
  const press = f.emit('dialDown');
  await f.emit('didReceiveSettings', {settings: {...settings, pressAction: 'off'}});
  await work(); await press;
  assert.equal(writes, 0);
});

const lastFeedback = f => f.events.filter(e => e.event === 'setFeedback').at(-1).payload;
async function finishVerification(f) {
  await f.advance(1500);
  await f.advance(3000);
  await f.advance(5000);
}

test('押し込み後は0%を予想表示し、1.5秒待ってから自動取得する', async () => {
  let reads = 0, writes = 0;
  const f = fixture(async (route, body) => {
    if (body) {writes++; return {results: [{accepted: true}]};}
    reads++; return {power: reads === 1 ? 'ON' : 'OFF', brightness: 65};
  }, {...settings, pressAction: 'toggle'});
  await f.emit('dialDown');
  assert.equal(lastFeedback(f).value, '0%');
  assert.match(lastFeedback(f).status, /確認待ち/);
  await f.advance(1499); assert.equal(reads, 1);
  await f.advance(1); assert.equal(reads, 2);
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(lastFeedback(f).icon, 'images/dial-off.svg');
  assert.equal(writes, 1);
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
});

test('消灯時の明るさ設定が残っても0%とし、点灯時は元の明るさを予想する', async () => {
  let on = false;
  const f = fixture(async (route, body) => {
    if (body) {on = true; return {results: [{accepted: true}]};}
    return {power: on ? 'ON' : 'OFF', brightness: 35};
  }, {...settings, pressAction: 'toggle'});
  await f.emit('touchTap'); assert.equal(lastFeedback(f).value, '0%');
  await f.emit('dialDown'); assert.equal(lastFeedback(f).value, '35%');
  await f.advance(1500);
  assert.equal(lastFeedback(f).value, '35%');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
});

test('消灯を予想したのに点灯のままなら実際の値と持続する警告を表示する', async () => {
  let writes = 0;
  const f = fixture(async (route, body) => {
    if (body) {writes++; return {results: [{accepted: true}]};}
    return {power: 'ON', brightness: 65};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await finishVerification(f);
  assert.equal(lastFeedback(f).value, '65%');
  assert.equal(lastFeedback(f).status, '警告：状態が不一致');
  assert.equal(lastFeedback(f).icon, 'images/warning.svg');
  assert.ok(f.events.some(e => e.event === 'showAlert'));
  await f.advance(10000); assert.equal(writes, 1);
  await f.emit('touchTap');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(lastFeedback(f).icon, 'images/dial-on.svg');
});

test('点灯状態が一致しても表示予定の明るさと異なれば警告する', async () => {
  let reads = 0;
  const f = fixture(async (route, body) => {
    if (body) return {results: [{accepted: true}]};
    return {power: 'ON', brightness: ++reads === 1 ? 50 : 70};
  }, {...settings, pressAction: 'on'});
  await f.emit('dialDown'); await finishVerification(f);
  assert.equal(lastFeedback(f).value, '70%');
  assert.equal(lastFeedback(f).icon, 'images/warning.svg');
});

test('消灯中の保持された明るさだけが異なる場合は表示0%が一致している', async () => {
  let reads = 0;
  const f = fixture(async (route, body) => {
    if (body) return {results: [{accepted: true}]};
    return {power: 'OFF', brightness: ++reads === 1 ? 30 : 60};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await f.advance(1500);
  assert.equal(lastFeedback(f).value, '0%');
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
});

test('コマンド受付後の再取得失敗は確認エラーとし、電源操作を再送しない', async () => {
  let reads = 0, writes = 0;
  const f = fixture(async (route, body) => {
    if (body) {writes++; return {results: [{accepted: true}]};}
    if (++reads > 1) throw new Error('offline');
    return {power: 'ON', brightness: 50};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await finishVerification(f); await f.advance(10000);
  assert.equal(lastFeedback(f).value, '--%');
  assert.equal(lastFeedback(f).icon, 'images/warning.svg');
  assert.match(f.events.at(-1).payload.message, /電源操作後の状態を3回確認できません/);
  assert.equal(writes, 1);
});

test('確認待ち中の画面タップは即時再取得し、予定していた重複取得を取り消す', async () => {
  let reads = 0;
  const f = fixture(async (route, body) => {
    if (body) return {results: [{accepted: true}]};
    return {power: ++reads === 1 ? 'ON' : 'OFF', brightness: 50};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await f.emit('touchTap');
  assert.equal(reads, 2); assert.equal(lastFeedback(f).value, '0%');
  await f.advance(5000); assert.equal(reads, 2);
});

test('複数台の混在は--%で表示し、各電球の予想状態を個別に照合する', async () => {
  let sent = false;
  const initial = {targets: [target('one'), target('two')], pressAction: 'toggle'};
  const f = fixture(async (route, body) => {
    if (body) {sent = true; return {results: [{accepted: true}, {accepted: true}]};}
    const first = route.includes('/one/');
    return {power: (sent ? !first : first) ? 'ON' : 'OFF', brightness: first ? 40 : 60};
  }, initial);
  await f.emit('dialDown'); assert.equal(lastFeedback(f).value, '--%');
  await f.advance(1500);
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
});

test('設定変更・非表示・終了は予約した自動取得を取り消す', async () => {
  for (const action of ['settings', 'hide', 'close']) {
    let reads = 0;
    const f = fixture(async (route, body) => {
      if (body) return {results: [{accepted: true}]};
      reads++; return {power: 'ON', brightness: 50};
    }, {...settings, pressAction: 'off'});
    await f.emit('dialDown');
    if (action === 'settings') await f.emit('didReceiveSettings', {settings: {...settings, pressAction: 'on'}});
    if (action === 'hide') await f.emit('willDisappear');
    if (action === 'close') f.dial.close();
    await f.advance(5000); assert.equal(reads, 1);
  }
});

test('自動取得中に対象が変更されたら古い結果で表示や警告を上書きしない', async () => {
  let reads = 0, release;
  const gate = new Promise(resolve => {release = resolve;});
  const f = fixture(async (route, body) => {
    if (body) return {results: [{accepted: true}]};
    if (++reads > 1) await gate;
    return {power: 'ON', brightness: 50};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown');
  const verification = f.advance(1500);
  await new Promise(resolve => setImmediate(resolve));
  await f.emit('didReceiveSettings', {settings: {targets: [target('two')], pressAction: 'on'}});
  const count = f.events.length;
  release(); await verification;
  assert.equal(f.events.length, count);
});

test('旧status設定の押し込みでも状態取得をしない', async () => {
  let calls = 0;
  const f = fixture(async () => {calls++; return {power: 'OFF', brightness: 50};}, {...settings, pressAction: 'status'});
  await f.emit('dialDown'); await f.emit('dialUp'); assert.equal(calls, 0);
  await f.emit('touchTap'); assert.equal(calls, 1);
  assert.equal(lastFeedback(f).value, '0%');
});

test('実際に取得した電源off・明るさ85の組合せは表示0%・調整基準85に分離する', async () => {
  const f = fixture(async () => ({power: 'off', brightness: 85}));
  await f.emit('touchTap');
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).indicator.value, 0);
  assert.equal(f.dial.entries.get('dial').value, 85);
});

test('状態の再取得中も保持した明るさへ戻さず消灯0%表示を維持する', async () => {
  let reads = 0, release;
  const gate = new Promise(resolve => {release = resolve;});
  const f = fixture(async () => {
    if (++reads > 1) await gate;
    return {power: 'OFF', brightness: 85};
  });
  await f.emit('touchTap');
  const reading = f.emit('touchTap');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lastFeedback(f).value, '0%');
  release(); await reading;
  assert.equal(lastFeedback(f).value, '0%');
});

test('機器一覧の名称を上段に表示し、状態メッセージは別欄に表示する', async () => {
  const f = fixture(async () => ({power: 'OFF', brightness: 85}));
  f.dial.updateDeviceNames([{...target('one'), name: 'デスクの電球'}]);
  await f.emit('touchTap');
  assert.equal(lastFeedback(f).deviceName, 'デスクの電球');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(lastFeedback(f).value, '0%');
  assert.ok(f.events.some(e => e.event === 'setFeedbackLayout' && e.payload.layout === 'brightness-layout.json'));
});

test('機器名の取得・更新で消灯0%の表示を保持し、改名を反映する', async () => {
  const f = fixture(async () => ({power: 'OFF', brightness: 85}));
  await f.emit('touchTap');
  f.dial.updateDeviceNames([{...target('one'), name: '電球1'}]);
  assert.equal(lastFeedback(f).deviceName, '電球1');
  assert.equal(lastFeedback(f).value, '0%');
  f.dial.updateDeviceNames([{...target('one'), name: 'ベッドサイド'}]);
  assert.equal(lastFeedback(f).deviceName, 'ベッドサイド');
  assert.equal(lastFeedback(f).value, '0%');
});

test('一覧未取得時も設定に保存した機器名を使い、複数台は先頭名と台数を表示する', () => {
  const f = fixture(async () => {}, {targets: [{...target('one'), name: '間接照明'}, {...target('two'), name: '天井照明'}]});
  assert.equal(lastFeedback(f).deviceName, '間接照明 ほか1台');
});

test('警告でも機器名は変わらず、状態欄とアイコンで異常を示す', async () => {
  const f = fixture(async (route, body) => body ? {results: [{accepted: true}]} : {power: 'ON', brightness: 50}, {...settings, pressAction: 'off'});
  f.dial.updateDeviceNames([{...target('one'), name: 'リビング照明'}]);
  await f.emit('dialDown');
  assert.equal(lastFeedback(f).deviceName, 'リビング照明');
  await finishVerification(f);
  assert.equal(lastFeedback(f).deviceName, 'リビング照明');
  assert.equal(lastFeedback(f).status, '警告：状態が不一致');
  assert.equal(lastFeedback(f).icon, 'images/warning.svg');
});

test('クラウドへの消灯反映が遅れても0%を保ち、3回目まで警告を出さない', async () => {
  let reads = 0, writes = 0;
  const f = fixture(async (route, body) => {
    if (body) {writes++; return {results: [{accepted: true}]};}
    return {power: ++reads < 4 ? 'ON' : 'OFF', brightness: 85};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown');
  await f.advance(1500);
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).status, '反映を確認中 1/3');
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
  await f.advance(2999); assert.equal(reads, 2);
  await f.advance(1);
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).status, '反映を確認中 2/3');
  await f.advance(4999); assert.equal(reads, 3);
  await f.advance(1);
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(reads, 4); assert.equal(writes, 1);
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
});

test('3回確認しても不一致なら初めて警告し、それ以上は再取得も操作再送もしない', async () => {
  let reads = 0, writes = 0;
  const f = fixture(async (route, body) => {
    if (body) {writes++; return {results: [{accepted: true}]};}
    reads++; return {power: 'ON', brightness: 85};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await f.advance(1500); await f.advance(3000);
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
  await f.advance(5000);
  assert.equal(lastFeedback(f).status, '警告：状態が不一致');
  assert.equal(f.events.filter(e => e.event === 'showAlert').length, 1);
  await f.advance(60000); assert.equal(reads, 4); assert.equal(writes, 1);
});

test('一時的な再取得エラーでも予想0%を保持し、次の確認が成功すれば警告しない', async () => {
  let reads = 0;
  const f = fixture(async (route, body) => {
    if (body) return {results: [{accepted: true}]};
    reads++;
    if (reads === 2) throw new Error('temporary timeout');
    return {power: reads === 1 ? 'ON' : 'OFF', brightness: 85};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await f.advance(1500);
  assert.equal(lastFeedback(f).value, '0%');
  assert.match(lastFeedback(f).status, /再取得を待機中/);
  await f.advance(3000);
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
});

test('反映待ちになった後もタップですぐ再確認でき、次の予約は残さない', async () => {
  let reads = 0;
  const f = fixture(async (route, body) => {
    if (body) return {results: [{accepted: true}]};
    return {power: ++reads < 3 ? 'ON' : 'OFF', brightness: 85};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await f.advance(1500);
  await f.emit('touchTap');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(lastFeedback(f).value, '0%');
  await f.advance(10000); assert.equal(reads, 3);
});

test('2回目の再取得予約も設定変更時に取り消す', async () => {
  let reads = 0;
  const f = fixture(async (route, body) => {
    if (body) return {results: [{accepted: true}]};
    reads++; return {power: 'ON', brightness: 85};
  }, {...settings, pressAction: 'off'});
  await f.emit('dialDown'); await f.advance(1500);
  await f.emit('didReceiveSettings', {settings: {targets: [target('two')], pressAction: 'off'}});
  await f.advance(10000); assert.equal(reads, 2);
});

function connectButton(f, api, action, targets = settings.targets) {
  const controller = new LightController({api}, e => f.events.push(e), {
    wait: async () => {},
    onAction: (targets, payload) => f.dial.beginButtonAction(payload),
    onResult: (payload, result, notification) => f.dial.finishButtonAction(payload, result, notification),
    onFailure: (payload, notification) => f.dial.finishButtonAction(payload, {results: []}, notification),
  });
  f.dial.enqueue = work => controller.enqueue(work);
  f.dial.onStates = states => controller.receiveStates(states);
  controller.handle({action: ACTION, event: 'willAppear', context: 'button', payload: {settings: {targets, action}}});
  return () => controller.handle({action: ACTION, event: 'keyDown', context: 'button'});
}

test('ボタンでオフにすると未使用のダイヤルにも0%を即時反映し、自動確認する', async () => {
  let writes = 0;
  const api = async (route, body) => {
    if (body) {writes++; return {results: [{id: 'one', accepted: true}]};}
    return {power: 'OFF', brightness: 85};
  };
  const f = fixture(api);
  const press = connectButton(f, api, 'off');
  await press();
  assert.equal(lastFeedback(f).value, '0%');
  await f.advance(1500);
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(writes, 1);
});

test('ボタンでオンにすると消灯0%から取得した明るさへ更新する', async () => {
  let on = false;
  const api = async (route, body) => {
    if (body) {on = true; return {results: [{id: 'one', accepted: true}]};}
    return {power: on ? 'ON' : 'OFF', brightness: 85};
  };
  const f = fixture(api);
  const press = connectButton(f, api, 'on');
  await f.emit('touchTap'); assert.equal(lastFeedback(f).value, '0%');
  await press(); assert.equal(lastFeedback(f).value, '85%');
  await f.advance(1500); assert.equal(lastFeedback(f).value, '85%');
});

test('ボタンの切り替えでもダイヤルの点灯状態を反転して0%へ同期する', async () => {
  let on = true;
  const api = async (route, body) => {
    if (body) {on = !on; return {results: [{id: 'one', accepted: true}]};}
    return {power: on ? 'ON' : 'OFF', brightness: 40};
  };
  const f = fixture(api);
  const press = connectButton(f, api, 'toggle');
  await f.emit('touchTap');
  await press(); assert.equal(lastFeedback(f).value, '0%');
  await f.advance(1500); assert.equal(lastFeedback(f).value, '0%');
});

test('まだ状態を取得していないダイヤルでもボタン切り替え前に状態を読み、オフを予想する', async () => {
  let on = true, readsBefore = 0, writes = 0;
  const api = async (route, body) => {
    if (body) {writes++; on = false; return {results: [{id: 'one', accepted: true}]};}
    if (!writes) readsBefore++;
    return {power: on ? 'ON' : 'OFF', brightness: 40};
  };
  const f = fixture(api);
  await connectButton(f, api, 'toggle')();
  assert.equal(readsBefore, 1); assert.equal(writes, 1);
  assert.equal(lastFeedback(f).value, '0%');
  await f.advance(1500); assert.equal(lastFeedback(f).status, '状態を確認済み');
});

test('ボタン操作の反映が遅れてもダイヤルの0%を保持して再確認する', async () => {
  let stale = true;
  const api = async (route, body) => body ? {results: [{id: 'one', accepted: true}]} : {power: stale ? 'ON' : 'OFF', brightness: 40};
  const f = fixture(api);
  await connectButton(f, api, 'off')();
  await f.advance(1500);
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).status, '反映を確認中 1/3');
  stale = false; await f.advance(3000);
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
});

test('違う電球を操作するボタンではダイヤルの表示を変更しない', async () => {
  const api = async (route, body) => body ? {results: [{id: 'two', accepted: true}]} : {power: 'ON', brightness: 40};
  const f = fixture(api);
  const press = connectButton(f, api, 'off', [target('two')]);
  await f.emit('touchTap');
  const previous = lastFeedback(f);
  await press(); await f.advance(10000);
  assert.equal(lastFeedback(f), previous);
});

test('複数台ダイヤルのうち1台だけオフの場合は全台消灯の0%と誤表示しない', async () => {
  let off = false;
  const api = async (route, body) => {
    if (body) {off = true; return {results: [{id: 'one', accepted: true}]};}
    return {power: off && route.includes('/one/') ? 'OFF' : 'ON', brightness: 40};
  };
  const f = fixture(api, {targets: [target('one'), target('two')]});
  const press = connectButton(f, api, 'off');
  await f.emit('touchTap'); await press();
  assert.equal(lastFeedback(f).value, '--%');
  await f.advance(1500); assert.equal(lastFeedback(f).value, '--%');
  assert.ok(!f.events.some(e => e.event === 'showAlert'));
});

test('ボタン操作が一部失敗した場合は成功した電球だけを予想に反映する', async () => {
  const targets = [target('one'), target('two')];
  const api = async (route, body) => body
    ? {results: [{id: 'one', accepted: true}, {id: 'two', accepted: false, error: 'offline'}]}
    : {power: route.includes('/one/') ? 'OFF' : 'ON', brightness: 40};
  const f = fixture(api, {targets});
  await connectButton(f, api, 'off', targets)();
  assert.equal(lastFeedback(f).value, '--%');
  await f.advance(1500); assert.equal(lastFeedback(f).value, '--%');
  assert.ok(f.events.some(e => e.event === 'showAlert' && e.context === 'button'));
});

test('ボタン操作の通信結果不明でもダイヤルの状態は取得し、操作は再送しない', async () => {
  let writes = 0;
  const api = async (route, body) => {
    if (body) {writes++; throw new Error('timeout');}
    return {power: 'OFF', brightness: 40};
  };
  const f = fixture(api);
  await connectButton(f, api, 'off')();
  await f.advance(1500);
  assert.equal(lastFeedback(f).value, '0%');
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(writes, 1);
});

test('自動確認前にボタンで再び切り替えても最新の予定状態を引き継ぐ', async () => {
  let on = true, writes = 0;
  const api = async (route, body) => {
    if (body) {on = !on; writes++; return {results: [{id: 'one', accepted: true}]};}
    return {power: on ? 'ON' : 'OFF', brightness: 40};
  };
  const f = fixture(api);
  const press = connectButton(f, api, 'toggle');
  await f.emit('touchTap');
  await press(); assert.equal(lastFeedback(f).value, '0%');
  await press(); assert.equal(lastFeedback(f).value, '40%');
  await f.advance(1500);
  assert.equal(lastFeedback(f).status, '状態を確認済み');
  assert.equal(lastFeedback(f).value, '40%');
  assert.equal(writes, 2);
});
