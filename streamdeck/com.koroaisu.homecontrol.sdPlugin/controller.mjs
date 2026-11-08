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
  if (powers.length && powers.every(p => p === 'on')) return 1;
  if (powers.length && powers.every(p => p === 'off')) return 0;
  return 2;
}

export class LightController {
  constructor(bridge, send, {wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
    this.bridge = bridge;
    this.send = send;
    this.wait = wait;
    this.settings = new Map();
    this.busy = new Set();
    this.queue = Promise.resolve();
    this.statusCache = new Map();
    this.lastMessages = new Map();
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
    this.render(context, powerState(values));
    return values;
  }

  async execute(context) {
    if (this.busy.has(context)) return;
    this.busy.add(context);
    const settings = this.settings.get(context) || {};
    const run = async () => {
      try {
        const payload = actionPayload(settings);
        const affected = new Set(payload.targets.map(t => `${t.provider}:${t.id}`));
        for (const key of affected) this.statusCache.delete(key);
        for (const [other, value] of this.settings) {
          if (value.targets?.some(t => affected.has(`${t.provider}:${t.id}`))) this.render(other);
        }
        this.message(context, '送信中…');
        const result = await this.bridge.api('/api/v1/actions', payload);
        const failed = result.results.filter(r => !r.accepted);
        if (failed.length) throw new Error(`${failed.length}台の操作に失敗しました。${failed.map(r => r.error).join(' / ')}`);
        this.send({event: 'showOk', context});
        this.message(context, 'コマンド受付済み。状態を確認しています…');
        await this.wait(1500);
        try {
          for (const [other, value] of this.settings) {
            if (value.targets?.some(t => affected.has(`${t.provider}:${t.id}`))) await this.refresh(other);
          }
          this.message(context, '操作を受け付け、クラウド上の状態を確認しました。反映に時間がかかる場合は「状態を確認」を押してください。');
        } catch {
          this.message(context, '操作は受付済みですが、状態を取得できませんでした。「状態を確認」で再確認してください。');
        }
      } catch (error) {
        this.render(context);
        this.send({event: 'showAlert', context});
        this.message(context, error.message + ' 自動再送はしません。');
      }
    };
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => {});
    try {await pending;} finally {this.busy.delete(context);}
  }

  async handle(event) {
    if (event.action && event.action !== ACTION) return;
    const {context, payload = {}} = event;
    if (event.event === 'willAppear' || event.event === 'didReceiveSettings') {
      this.settings.set(context, payload.settings || {});
      this.render(context);
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
          const data = await this.bridge.api('/api/v1/devices' + (payload.refresh ? '?refresh=1' : ''));
          this.send({event: 'sendToPropertyInspector', context, payload: {type: 'devices', devices: data.devices}});
          this.message(context, this.lastMessages.get(context) || `${data.devices.length}台の電球を取得しました。`);
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
