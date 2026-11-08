/* The inspector never receives credentials; all HTTP traffic runs in the plugin. */
let socket, uuid, actionId, settings = {}, devices = [];
const $ = id => document.getElementById(id);
const send = value => {if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));};
function request(type, extra = {}) {
  send({event: 'sendToPlugin', action: actionId, context: uuid, payload: {type, ...extra}});
}
function save() {
  send({event: 'setSettings', action: actionId, context: uuid, payload: settings});
}
function controls() {
  const isDial = actionId === 'com.koroaisu.homecontrol.brightness';
  $('keyControls').hidden = isDial;
  $('dialControls').hidden = !isDial;
  $('intro').textContent = isDial ? 'このダイヤルで明るさを調整する電球を選びます。' : 'このボタンで操作する電球を選びます。';
  $('step').value = settings.step ?? 5;
  $('pressAction').value = settings.pressAction === 'status' ? 'none' : (settings.pressAction ?? 'none');
  $('stateHint').textContent = isDial ? '押し込み後は自動確認します。消灯＝0%、点灯＝1〜100%。電源が混在する場合は--%と表示します。警告時は画面タップで再確認できます。' : '黄：1台以上が点灯／灰：全台消灯／青：状態不明。明るさは色の判定に影響しません。操作後は自動で最大3回確認します。';
  const action = settings.action || 'toggle';
  $('action').value = action;
  $('numberRow').hidden = !['brightness', 'temperature'].includes(action);
  $('colorRow').hidden = action !== 'color';
  $('value').min = action === 'temperature' ? 2700 : 1;
  $('value').max = action === 'temperature' ? 6500 : 100;
  $('numberLabel').textContent = action === 'temperature' ? '色温度（2700〜6500K）' : '明るさ（1〜100%）';
  $('value').value = settings.value ?? (action === 'temperature' ? 4000 : 50);
  $('color').value = settings.color || '#ffffff';
}
function renderDevices() {
  $('devices').replaceChildren();
  const selected = new Set((settings.targets || []).map(t => t.id));
  const available = new Set(devices.map(d => d.id));
  for (const device of devices) {
    const label = document.createElement('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(device.id);
    checkbox.onchange = () => {
      const targets = (settings.targets || []).filter(t => t.id !== device.id);
      if (checkbox.checked) targets.push({provider: device.provider, id: device.id, name: device.name});
      settings.targets = targets; save();
    };
    label.append(checkbox, document.createTextNode(device.name)); $('devices').append(label);
  }
  for (const target of settings.targets || []) {
    if (!available.has(target.id)) {
      const text = document.createElement('p'); text.textContent = `未検出の電球：${target.id}`;
      const remove = document.createElement('button'); remove.textContent = '選択を解除';
      remove.onclick = () => {settings.targets = settings.targets.filter(t => t.id !== target.id); save(); renderDevices();};
      text.append(remove); $('devices').append(text);
    }
  }
  if (!devices.length) $('devices').append(document.createTextNode('電球が見つかりません。接続設定を確認してください。'));
}
window.connectElgatoStreamDeckSocket = (port, inUuid, registerEvent, info, actionInfo) => {
  uuid = inUuid;
  const action = JSON.parse(actionInfo); actionId = action.action; settings = action.payload.settings || {};
  controls();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.onopen = () => {send({event: registerEvent, uuid}); request('devices');};
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.event === 'sendToPropertyInspector') {
      if (data.payload.type === 'devices') {devices = data.payload.devices; renderDevices();}
      if (data.payload.type === 'message') $('message').textContent = data.payload.message;
    }
    if (data.event === 'didReceiveSettings') {settings = data.payload.settings || {}; controls(); renderDevices();}
  };
  socket.onclose = () => {$('message').textContent = 'Stream Deckとの接続が切れました。ボタンを選び直してください。';};
};
$('reload').onclick = () => request('devices', {refresh: true});
$('settings').onclick = () => request('settings');
$('status').onclick = () => request('status');
$('action').onchange = () => {
  settings.action = $('action').value;
  settings.value = settings.action === 'temperature' ? 4000 : 50;
  settings.color ||= '#ffffff'; controls(); save();
};
$('value').onchange = () => {
  if (!$('value').checkValidity() || $('value').value === '') {$('message').textContent = '範囲内の整数を入力してください。'; return;}
  settings.value = Number($('value').value); save();
};
$('color').onchange = () => {settings.color = $('color').value; save();};
$('step').onchange = () => {
  if (!$('step').checkValidity() || $('step').value === '') {$('message').textContent = '変更幅は1〜25の整数を入力してください。'; return;}
  settings.step = Number($('step').value); save();
};
$('pressAction').onchange = () => {settings.pressAction = $('pressAction').value; save();};
