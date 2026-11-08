export const ACTION = 'com.koroaisu.homecontrol.light';
const operationNames = {on: 'オン', off: 'オフ', toggle: '切り替え', brightness: '明るさ', temperature: '色温度', color: '色'};

export function actionPayload(settings) {
  if (!Array.isArray(settings.targets) || !settings.targets.length || settings.targets.length > 32) {
    throw new Error('設定画面で操作する電球を選んでください');
  }
  if (settings.targets.some(t => !t || t.provider !== 'switchbot' || typeof t.id !== 'string' || !t.id)) {
    throw new Error('電球の選択が不正です');
  }
  const action = settings.action || 'toggle';
  if (!Object.hasOwn(operationNames, action)) throw new Error('操作を選んでください');
  let value;
  if (action === 'brightness' || action === 'temperature') {
    value = settings.value;
    const [min, max] = action === 'brightness' ? [1, 100] : [2700, 6500];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${min}〜${max}の整数を入力してください`);
  }
  if (action === 'color') {
    if (!/^#[a-f\d]{6}$/i.test(settings.color || '')) throw new Error('色を選んでください');
    value = settings.color.slice(1).match(/../g).map(s => parseInt(s, 16));
  }
  return {targets: settings.targets.map(({provider, id}) => ({provider, id})), action, value};
}

export function powerState(values) {
  const powers = values.map(v => String(v?.power || '').toLowerCase());
  if (powers.includes('on')) return 1;
  if (powers.length && powers.every(p => p === 'off')) return 0;
  return 2;
}

export class LightController {
  constructor(bridge, send, {
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    onAction = () => {}, onResult = () => {}, onFailure = () => {},
    getDevices = async refresh => (await bridge.api('/api/v1/devices' + (refresh ? '?refresh=1' : ''))).devices,
  } = {}) {
    this.bridge = bridge;
    this.send = send;
    this.wait = wait;
    this.onAction = onAction;
    this.onResult = onResult;
    this.onFailure = onFailure;
    this.getDevices = getDevices;
    this.settings = new Map();
    this.busy = new Set();
    this.queue = Promise.resolve();
    this.statusCache = new Map();
    this.lastMessages = new Map();
    this.knownStates = new Map();
    this.revisions = new Map();
  }

  enqueue(work) {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }

  invalidate(targets) {
    const affected = new Set(targets.map(t => `${t.provider}:${t.id}`));
    for (const key of affected) {
      this.statusCache.delete(key);
      this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
    }
    for (const [context, settings] of this.settings) {
      if (settings.targets?.some(t => affected.has(`${t.provider}:${t.id}`))) this.renderKnown(context);
    }
  }

  renderKnown(context) {
    const targets = this.settings.get(context)?.targets || [];
    this.render(context, powerState(targets.map(t => this.knownStates.get(`${t.provider}:${t.id}`))));
  }

  receiveStates(states) {
    for (const state of states) this.knownStates.set(`${state.provider}:${state.id}`, state);
    for (const context of this.settings.keys()) this.renderKnown(context);
  }

  valid(check) {
    return check.targets.every(t => (this.revisions.get(`${t.provider}:${t.id}`) || 0) === check.revisions.get(`${t.provider}:${t.id}`));
  }

  async expectedStates(payload) {
    const states = [];
    for (const target of payload.targets) {
      let previous = this.knownStates.get(`${target.provider}:${target.id}`);
      if (!previous && payload.action === 'toggle') {
        try {previous = await this.status(target, true);} catch { /* State lookup must not prevent the command. */ }
      }
      const power = String(previous?.power || '').toLowerCase();
      const expectedPower = ['on', 'off'].includes(payload.action) ? payload.action
        : payload.action === 'toggle' && ['on', 'off'].includes(power) ? (power === 'on' ? 'off' : 'on') : null;
      states.push({...target, power: expectedPower, brightness: payload.action === 'brightness' ? payload.value : null});
    }
    return states;
  }

  async confirm(check) {
    for (const [attempt, delay] of [1500, 3000, 5000].entries()) {
      await this.wait(delay); // Keep waits outside the shared operation queue.
      if (!this.valid(check)) return;
      try {
        const states = await this.enqueue(async () => {
          if (!this.valid(check)) return null;
          const values = [];
          for (const target of check.targets) {
            const state = await this.status(target, true);
            if (!['on', 'off'].includes(String(state.power || '').toLowerCase())) throw new Error('電源状態が不明です');
            values.push({...state, ...target, power: String(state.power).toLowerCase()});
          }
          return values;
        });
        if (!states || !this.valid(check)) return;
        const mismatch = states.some((state, i) => {
          const expected = check.expected[i];
          return (expected.power !== null && state.power !== expected.power)
            || (state.power === 'on' && Number.isInteger(expected.brightness) && state.brightness !== expected.brightness);
        });
        const unknownToggle = check.action === 'toggle' && check.expected.some(s => s.power === null);
        if ((mismatch || unknownToggle) && attempt < 2) {
          this.message(check.context, `反映を確認中 ${attempt + 1}/3。操作は再送せず状態だけ再取得します。`);
          continue;
        }
        this.receiveStates(states);
        this.message(check.context, mismatch ? '操作は受付済みですが、3回確認しても予定の電源状態と一致しません。状態を確認してください。' : 'クラウド上の電源状態を確認しました。');
        if (mismatch) this.send({event: 'showAlert', context: check.context});
        return;
      } catch {
        if (!this.valid(check)) return;
        if (attempt < 2) {this.message(check.context, `状態の取得を再試行します ${attempt + 1}/3。`); continue;}
        for (const target of check.targets) this.knownStates.delete(`${target.provider}:${target.id}`);
        for (const context of this.settings.keys()) this.renderKnown(context);
        this.send({event: 'showAlert', context: check.context});
        this.message(check.context, '操作は受付済みですが、3回とも状態を取得できませんでした。「状態を確認」で再確認してください。');
      }
    }
  }

  message(context, message) {
    this.lastMessages.set(context, message);
    this.send({event: 'sendToPropertyInspector', context, payload: {type: 'message', message}});
  }

  render(context, state = 2) {
    this.send({event: 'setState', context, payload: {state}});
    // Titles belong to the user; states change the bulb icon only.
  }

  async status(target, force = false) {
    const key = `${target.provider}:${target.id}`;
    const cached = this.statusCache.get(key);
    if (!force && cached && Date.now() - cached.time < 5000) return cached.value;
    const value = await this.bridge.api(`/api/v1/devices/${target.provider}/${encodeURIComponent(target.id)}/status`);
    this.statusCache.set(key, {time: Date.now(), value});
    return value;
  }

  async refresh(context, force = false) {
    const settings = this.settings.get(context) || {};
    const payload = actionPayload(settings);
    const values = [];
    for (const target of payload.targets) values.push(await this.status(target, force));
    // A user can change the selected devices while a request is running.
    if (this.settings.get(context) !== settings) return;
    this.receiveStates(values.map((state, i) => ({...state, ...payload.targets[i]})));
    return values;
  }

  async execute(context) {
    if (this.busy.has(context)) return;
    this.busy.add(context);
    const settings = this.settings.get(context) || {};
    const run = async () => {
      let payload, notification, received = false;
      try {
        payload = actionPayload(settings);
        notification = await this.onAction(payload.targets, payload);
        this.invalidate(payload.targets);
        const expected = await this.expectedStates(payload);
        this.message(context, '送信中…');
        const result = await this.bridge.api('/api/v1/actions', payload);
        received = true;
        this.onResult(payload, result, notification);
        const failed = result.results.filter(r => !r.accepted);
        if (failed.length) throw new Error(`${failed.length}台の操作に失敗しました。${failed.map(r => r.error).join(' / ')}`);
        this.receiveStates(expected.map(state => {
          const previous = this.knownStates.get(`${state.provider}:${state.id}`);
          return {...previous, ...state, power: state.power ?? previous?.power, brightness: state.brightness ?? previous?.brightness};
        }));
        this.send({event: 'showOk', context});
        this.message(context, 'コマンド受付済み。状態を確認しています…');
        return {context, targets: payload.targets, action: payload.action, expected, revisions: new Map(this.revisions)};
      } catch (error) {
        if (payload && !received) this.onFailure(payload, notification);
        for (const target of payload?.targets || []) this.knownStates.delete(`${target.provider}:${target.id}`);
        for (const other of this.settings.keys()) this.renderKnown(other);
        this.send({event: 'showAlert', context});
        this.message(context, error.message + ' 自動再送はしません。');
      }
    };
    const pending = this.enqueue(run);
    let check;
    try {check = await pending;} finally {this.busy.delete(context);}
    if (check) await this.confirm(check);
  }

  async handle(event) {
    if (event.action && event.action !== ACTION) return;
    const {context, payload = {}} = event;
    if (event.event === 'willAppear' || event.event === 'didReceiveSettings') {
      this.settings.set(context, payload.settings || {});
      this.renderKnown(context);
    } else if (event.event === 'willDisappear') {
      this.settings.delete(context);
      this.lastMessages.delete(context);
    } else if (event.event === 'keyDown') {
      if (this.busy.has(context)) return;
      if (payload.settings) this.settings.set(context, payload.settings);
      await this.execute(context);
    } else if (event.event === 'sendToPlugin') {
      try {
        if (payload.type === 'devices') {
          const devices = await this.getDevices(!!payload.refresh);
          this.send({event: 'sendToPropertyInspector', context, payload: {type: 'devices', devices}});
          this.message(context, this.lastMessages.get(context) || `${devices.length}台の電球を取得しました。`);
        } else if (payload.type === 'status') {
          const values = await this.refresh(context, true);
          if (values) this.message(context, values.map((v, i) => `${i + 1}台目: ${v.power} / 明るさ ${v.brightness ?? '?'}%`).join('\n'));
        } else if (payload.type === 'settings') {
          await this.bridge.ensure();
          this.send({event: 'openUrl', payload: {url: 'http://127.0.0.1:3210'}});
        }
      } catch (error) {this.message(context, error.message);}
    }
  }
}
