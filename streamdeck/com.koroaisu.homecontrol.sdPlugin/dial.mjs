import {actionPayload} from './controller.mjs';

export const DIAL_ACTION = 'com.koroaisu.homecontrol.brightness';
const clamp = value => Math.max(1, Math.min(100, value));
const verificationDelays = [1500, 3000, 5000];
const pressNames = {toggle: 'オン／オフ切り替え', on: 'オン', off: 'オフ', none: '何もしない'};
export function dialPressAction(settings) {
  // Removing the old status action must not turn an existing dial into a power switch unexpectedly.
  const action = settings.pressAction === 'status' ? 'none' : (settings.pressAction ?? 'none');
  if (!Object.hasOwn(pressNames, action)) throw new Error('押し込み時の動作を選び直してください');
  return action;
}
export function dialSettings(settings) {
  const targets = actionPayload({...settings, action: 'on'}).targets;
  const step = settings.step ?? 5;
  if (!Number.isInteger(step) || step < 1 || step > 25) throw new Error('1目盛りの変更幅は1〜25の整数で指定してください');
  return {targets: [...new Map(targets.map(t => [t.id, t])).values()], step, pressAction: dialPressAction(settings)};
}

export class BrightnessDial {
  constructor(bridge, send, {
    enqueue = work => Promise.resolve().then(work),
    schedule = setTimeout, cancel = clearTimeout, now = Date.now,
    onAction = () => {}, onStates = () => {},
    getDevices = async refresh => (await bridge.api('/api/v1/devices' + (refresh ? '?refresh=1' : ''))).devices,
  } = {}) {
    Object.assign(this, {bridge, send, enqueue, schedule, cancel, now, onAction, onStates, getDevices});
    this.entries = new Map();
    this.deviceNames = new Map();
  }

  active(entry) {return this.entries.get(entry.context) === entry;}

  deviceLabel(entry) {
    const targets = entry.settings.targets || [];
    if (!targets.length) return '電球を選択';
    const first = targets[0];
    const name = this.deviceNames.get(`${first.provider}:${first.id}`) || first.name || '電球';
    return targets.length === 1 ? name : `${name} ほか${targets.length - 1}台`;
  }

  updateDeviceNames(devices) {
    this.deviceNames = new Map(devices.map(d => [`${d.provider}:${d.id}`, d.name]));
    for (const entry of this.entries.values()) this.render(entry, entry.lastLabel);
  }

  async loadDeviceNames() {
    this.updateDeviceNames(await this.getDevices(false));
  }

  cancelVerification(entry) {
    if (entry?.verification?.timer !== undefined) this.cancel(entry.verification.timer);
    if (entry) entry.verification = null;
  }

  scheduleVerification(entry, verification) {
    verification.timer = this.schedule(() => {
      verification.timer = undefined;
      return this.verify(entry, verification);
    }, verificationDelays[verification.attempt]);
  }

  async readStates(targets) {
    const states = [];
    for (const target of targets) {
      const status = await this.bridge.api(`/api/v1/devices/${target.provider}/${encodeURIComponent(target.id)}/status`);
      const power = String(status.power || '').toLowerCase();
      if (!['on', 'off'].includes(power) || !Number.isInteger(status.brightness) || status.brightness < 1 || status.brightness > 100) {
        throw new Error('電球の電源状態または明るさを取得できませんでした');
      }
      states.push({...target, power, brightness: status.brightness});
    }
    return states;
  }

  applyStates(entry, states) {
    entry.states = states;
    entry.value = states[0].brightness;
    entry.accepted = states.every(s => s.brightness === entry.value) ? entry.value : null;
    entry.warning = false;
  }

  renderStates(entry, states, label) {
    const first = states[0];
    const samePower = states.every(s => s.power === first.power);
    const display = samePower ? (first.power === 'off' ? 0 : first.brightness) : null;
    this.render(entry, label, display);
  }

  stateText(states) {
    return states.map(s => `${s.id}: ${s.power === 'off' ? '消灯 0%' : s.power === 'on' ? '点灯 ' + (s.brightness ?? '?') + '%' : '状態を確認中'}`).join(' / ');
  }

  message(entry, message) {
    if (!this.active(entry)) return;
    entry.message = message;
    this.send({event: 'sendToPropertyInspector', context: entry.context, payload: {type: 'message', message}});
  }

  render(entry, label = '', display = entry.displayValue) {
    if (!this.active(entry)) return;
    const percent = display === null ? '--' : String(display);
    entry.displayValue = display;
    entry.lastLabel = label || '明るさ';
    this.send({event: 'setFeedback', context: entry.context, payload: {
      deviceName: this.deviceLabel(entry), status: entry.lastLabel,
      icon: entry.warning ? 'images/warning.svg' : (display === 0 ? 'images/dial-off.svg' : 'images/dial-on.svg'), value: `${percent}%`,
      indicator: {value: display ?? 0, range: {min: 0, max: 100}},
    }});
  }

  reset(context, settings) {
    const previous = this.entries.get(context);
    if (previous?.timer !== undefined) this.cancel(previous.timer);
    this.cancelVerification(previous);
    const entry = {context, settings, value: null, displayValue: null, accepted: null, dirty: false,
      pending: [], loading: null, busy: false, powerBusy: false, warning: false, verification: null,
      timer: undefined, lastSent: -Infinity};
    this.entries.set(context, entry);
    this.send({event: 'setFeedbackLayout', context, payload: {layout: 'brightness-layout.json'}});
    this.render(entry, '回して明るさ調整');
    this.send({event: 'setTriggerDescription', context, payload: {
      rotate: '明るさを調整', push: pressNames[settings.pressAction === 'status' ? 'none' : (settings.pressAction ?? 'none')] || '設定を確認', touch: '状態を再取得',
    }});
    return entry;
  }

  invalidate(targets, except) {
    const ids = new Set(targets.map(t => t.id));
    for (const [context, entry] of this.entries) {
      if (context !== except && entry.settings.targets?.some(t => ids.has(t.id))) this.reset(context, entry.settings);
    }
  }

  async beginButtonAction(payload) {
    const affected = new Set(payload.targets.map(t => `${t.provider}:${t.id}`));
    const notification = new Map();
    for (const [context, previous] of this.entries) {
      if (!previous.settings.targets?.some(t => affected.has(`${t.provider}:${t.id}`))) continue;
      const entry = this.reset(context, previous.settings);
      // Cancel unsent dial work but keep its last known values until the button result arrives.
      entry.states = previous.states;
      entry.value = previous.value;
      entry.accepted = previous.accepted;
      this.render(entry, 'ボタン操作中', previous.displayValue);
      notification.set(context, entry);
    }
    if (payload.action === 'toggle') {
      const reads = new Map();
      for (const entry of notification.values()) {
        if (entry.states?.length || !this.active(entry)) continue;
        try {
          const states = [];
          for (const target of dialSettings(entry.settings).targets) {
            const key = `${target.provider}:${target.id}`;
            if (!reads.has(key)) reads.set(key, this.readStates([target]));
            states.push(...await reads.get(key));
          }
          if (this.active(entry)) {this.applyStates(entry, states); this.onStates(states);}
        } catch {
          // A failed optional preview read must not prevent the button's requested command.
        }
      }
    }
    return notification;
  }

  finishButtonAction(payload, result, notification = new Map()) {
    const accepted = new Set(result.results.filter(r => r.accepted).map(r => r.id));
    for (const entry of notification.values()) {
      if (!this.active(entry)) continue;
      const {targets} = dialSettings(entry.settings);
      const expected = targets.map(target => {
        const affected = accepted.has(target.id) && payload.targets.some(t => t.id === target.id && t.provider === target.provider);
        const known = entry.states?.find(s => s.id === target.id && s.provider === target.provider);
        let power = null, brightness = null;
        if (affected) {
          if (payload.action === 'on' || payload.action === 'off') power = payload.action;
          if (payload.action === 'toggle' && known?.power) power = known.power === 'on' ? 'off' : 'on';
          if (payload.action === 'brightness') brightness = payload.value;
          else if (power === 'on') brightness = known?.brightness ?? (targets.length === 1 ? entry.value : null);
        }
        return {...target, power, brightness};
      });
      const previousStates = entry.states || [];
      entry.states = accepted.size ? expected.map(state => {
        const previous = previousStates.find(s => s.id === state.id && s.provider === state.provider);
        return {...state, power: state.power ?? previous?.power ?? null, brightness: state.brightness ?? previous?.brightness ?? null};
      }) : undefined;
      let display = null;
      if (expected.every(s => s.power === 'off')) display = 0;
      else if (expected.every(s => s.power === 'on') && Number.isInteger(expected[0].brightness)) display = expected[0].brightness;
      else if (expected.every(s => s.brightness === payload.value) && payload.action === 'brightness') display = payload.value;
      this.render(entry, 'ボタン操作・確認待ち', display);
      this.message(entry, 'ボタン操作後の状態を自動確認します。消灯は0%で表示します。');
      const settleUnknown = payload.action === 'toggle' && expected.some(s => accepted.has(s.id) && s.power === null);
      const verification = {targets, expected, settleUnknown, timer: undefined, running: null, attempt: 0};
      entry.verification = verification;
      this.scheduleVerification(entry, verification);
    }
  }

  fail(entry, error) {
    if (!this.active(entry)) return;
    if (entry.timer !== undefined) this.cancel(entry.timer);
    entry.timer = undefined;
    entry.value = entry.accepted = null;
    entry.dirty = false;
    entry.pending = [];
    this.cancelVerification(entry);
    entry.warning = true;
    this.render(entry, '取得・送信エラー', null);
    this.send({event: 'showAlert', context: entry.context});
    this.message(entry, `${error.message} 自動再送はしません。画面をタップするか「状態を確認」で再確認してください。`);
  }

  async load(entry) {
    if (entry.loading) return entry.loading;
    const work = async () => {
      if (!this.active(entry)) return;
      const {targets} = dialSettings(entry.settings);
      this.render(entry, '状態を取得中');
      const states = await this.readStates(targets);
      if (!this.active(entry)) return;
      // Use the first selected bulb as the starting point; the next turn unifies the group.
      this.applyStates(entry, states);
      this.onStates(states);
      const mixed = states.some(s => s.power !== states[0].power || s.brightness !== states[0].brightness);
      this.renderStates(entry, states, mixed ? '混在・先頭の明るさ' : '状態を確認済み');
      this.message(entry, `現在：${this.stateText(states)}。複数台の明るさは先頭の電球を基準に調整します。`);
      for (const delta of entry.pending) entry.value = clamp(entry.value + delta);
      const rotated = entry.pending.length > 0;
      entry.pending = [];
      entry.dirty = rotated && entry.value !== entry.accepted;
      if (entry.dirty) {this.render(entry, '送信待ち', entry.value); this.arm(entry);}
    };
    entry.loading = this.enqueue(work);
    try {await entry.loading;} catch (error) {this.fail(entry, error);} finally {entry.loading = null;}
  }

  arm(entry) {
    if (!this.active(entry) || entry.busy || entry.powerBusy || !entry.dirty) return;
    if (entry.timer !== undefined) this.cancel(entry.timer);
    // Debounce fast rotations, and rate-limit successive batches while a request is in flight.
    entry.timer = this.schedule(() => {
      entry.timer = undefined;
      return this.flush(entry);
    }, Math.max(400, 1000 - (this.now() - entry.lastSent)));
  }

  async rotate(entry, ticks) {
    if (entry.powerBusy || entry.verification) {
      this.message(entry, '電源操作の確認中です。完了後にダイヤルを回してください。');
      return;
    }
    try {
      const {step} = dialSettings(entry.settings);
      if (!Number.isSafeInteger(ticks) || ticks === 0 || Math.abs(ticks) > 1000) return;
      if (entry.value === null) {
        if (entry.pending.length >= 1000) throw new Error('回転が多すぎます。少し待ってから操作してください');
        entry.pending.push(ticks * step);
        await this.load(entry);
      } else {
        entry.value = clamp(entry.value + ticks * step);
        entry.dirty = entry.value !== entry.accepted;
        this.render(entry, entry.dirty ? '送信待ち' : '明るさ', entry.value);
        if (!entry.dirty && entry.timer !== undefined) {this.cancel(entry.timer); entry.timer = undefined;}
        this.arm(entry);
      }
    } catch (error) {this.fail(entry, error);}
  }

  async flush(entry) {
    if (!this.active(entry) || entry.busy || !entry.dirty) return;
    entry.busy = true;
    try {
      await this.enqueue(async () => {
        if (!this.active(entry) || !entry.dirty) return;
        const {targets} = dialSettings(entry.settings);
        const value = entry.value;
        entry.lastSent = this.now();
        this.onAction(targets, entry.context);
        this.render(entry, '送信中', entry.value);
        const result = await this.bridge.api('/api/v1/actions', {targets, action: 'brightness', value});
        if (result.results?.length !== targets.length || result.results.some(r => !r.accepted)) {
          throw new Error('一部または全ての電球への操作に失敗しました');
        }
        if (!this.active(entry)) return;
        entry.accepted = value;
        entry.dirty = entry.value !== value;
        this.render(entry, entry.dirty ? '送信待ち' : '受付済み', entry.value);
        this.message(entry, `${value}%の設定を受け付けました。実際の状態は画面をタップするか「状態を確認」で確認できます。`);
      });
    } catch (error) {this.fail(entry, error);} finally {
      entry.busy = false;
      if (this.active(entry) && entry.dirty) this.arm(entry);
    }
  }

  async sync(entry) {
    if (entry.verification) {
      if (entry.verification.timer !== undefined) this.cancel(entry.verification.timer);
      await this.verify(entry, entry.verification);
      return;
    }
    if (entry.busy || entry.powerBusy || entry.dirty || entry.pending.length) {
      this.message(entry, '操作を送信中です。完了後にもう一度状態を確認してください。');
      return;
    }
    await this.load(entry);
  }

  async press(entry) {
    if (entry.powerBusy || entry.verification) return;
    try {
      const action = dialPressAction(entry.settings);
      if (action === 'none') return;
      const {targets} = dialSettings(entry.settings);
      entry.powerBusy = true;
      // A power request supersedes unsent brightness changes; an in-flight write finishes first.
      if (entry.timer !== undefined) this.cancel(entry.timer);
      entry.timer = undefined;
      entry.pending = [];
      entry.dirty = false;
      this.message(entry, `${pressNames[action]}を送信します。未送信の明るさ変更は取り消します。`);
      await this.enqueue(async () => {
        if (!this.active(entry)) return;
        const before = await this.readStates(targets);
        if (!this.active(entry)) return;
        const expected = before.map(state => ({...state, power: action === 'toggle' ? (state.power === 'on' ? 'off' : 'on') : action}));
        this.onAction(targets, entry.context);
        this.applyStates(entry, expected);
        entry.dirty = false;
        this.renderStates(entry, expected, '変更予定・送信中');
        const result = await this.bridge.api('/api/v1/actions', {targets, action});
        if (result.results?.length !== targets.length || result.results.some(r => !r.accepted)) {
          throw new Error('一部または全ての電球への電源操作に失敗しました');
        }
        if (!this.active(entry)) return;
        this.renderStates(entry, expected, '変更予定・確認待ち');
        this.message(entry, `予定：${this.stateText(expected)}。1.5秒後に自動確認します。`);
        const verification = {targets, expected, timer: undefined, running: null, attempt: 0};
        entry.verification = verification;
        this.scheduleVerification(entry, verification);
      });
    } catch (error) {this.fail(entry, error);} finally {entry.powerBusy = false;}
  }

  async verify(entry, verification) {
    if (!this.active(entry) || entry.verification !== verification) return;
    if (verification.running) return verification.running;
    verification.running = this.enqueue(async () => {
      if (!this.active(entry) || entry.verification !== verification) return;
      verification.attempt++;
      try {
        const states = await this.readStates(verification.targets);
        if (!this.active(entry) || entry.verification !== verification) return;
        const mismatches = states.filter((state, i) => {
          const expected = verification.expected[i];
          return (expected.power !== null && state.power !== expected.power)
            || (state.power === 'on' && Number.isInteger(expected.brightness) && state.brightness !== expected.brightness);
        });
        if ((mismatches.length || verification.settleUnknown) && verification.attempt < verificationDelays.length) {
          // Retry only status reads while the cloud may still report the pre-command state.
          this.renderStates(entry, verification.expected, `反映を確認中 ${verification.attempt}/3`);
          this.message(entry, `状態の反映を待っています。予定：${this.stateText(verification.expected)}。今回の取得：${this.stateText(states)}。時間を空けて再確認します。`);
          this.scheduleVerification(entry, verification);
        } else if (mismatches.length) {
          this.applyStates(entry, states);
          this.onStates(states);
          entry.verification = null;
          entry.warning = true;
          this.renderStates(entry, states, '警告：状態が不一致');
          this.send({event: 'showAlert', context: entry.context});
          this.message(entry, `予定と取得した状態が違います。予定：${this.stateText(verification.expected)}。取得：${this.stateText(states)}。反映待ちの可能性もあります。画面タップで再確認してください。操作の自動再送はしません。`);
        } else {
          this.applyStates(entry, states);
          this.onStates(states);
          entry.verification = null;
          this.renderStates(entry, states, '状態を確認済み');
          this.message(entry, `自動確認完了：${this.stateText(states)}`);
        }
      } catch (error) {
        if (this.active(entry) && entry.verification === verification) {
          if (verification.attempt < verificationDelays.length) {
            this.renderStates(entry, verification.expected, `再取得を待機中 ${verification.attempt}/3`);
            this.message(entry, `状態の取得に失敗したため、時間を空けて再確認します。${error.message} 電源操作は再送しません。`);
            this.scheduleVerification(entry, verification);
          } else {
            this.fail(entry, new Error(`電源操作後の状態を3回確認できませんでした。${error.message}`));
          }
        }
      }
    });
    try {await verification.running;} finally {verification.running = null;}
  }

  close() {
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.cancel(entry.timer);
      this.cancelVerification(entry);
    }
    this.entries.clear();
  }

  async handle(event) {
    if (event.action !== DIAL_ACTION) return;
    const {context, payload = {}} = event;
    if (event.event === 'willDisappear') {
      const entry = this.entries.get(context);
      if (entry?.timer !== undefined) this.cancel(entry.timer);
      this.cancelVerification(entry);
      this.entries.delete(context);
      return;
    }
    let entry = this.entries.get(context);
    if (event.event === 'willAppear' || event.event === 'didReceiveSettings') {
      this.reset(context, payload.settings || {});
      return;
    }
    if (!entry) entry = this.reset(context, payload.settings || {});
    if (event.event === 'dialRotate') await this.rotate(entry, payload.ticks);
    else if (event.event === 'dialDown') await this.press(entry);
    else if (event.event === 'touchTap') await this.sync(entry);
    else if (event.event === 'sendToPlugin') {
      try {
        if (payload.type === 'devices') {
          const devices = await this.getDevices(!!payload.refresh);
          this.updateDeviceNames(devices);
          this.send({event: 'sendToPropertyInspector', context, payload: {type: 'devices', devices}});
          this.message(entry, entry.message || '電球を選び、ダイヤルを回してください。');
        } else if (payload.type === 'status') await this.sync(entry);
        else if (payload.type === 'settings') {
          await this.bridge.ensure();
          this.send({event: 'openUrl', payload: {url: 'http://127.0.0.1:3210'}});
        }
      } catch (error) {this.message(entry, error.message);}
    }
  }
}
