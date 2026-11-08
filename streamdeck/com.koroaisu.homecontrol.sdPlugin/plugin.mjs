import {readFileSync} from 'node:fs';
import {HomeControlBridge} from './bridge.mjs';
import {LightController} from './controller.mjs';
import {BrightnessDial, DIAL_ACTION} from './dial.mjs';
import {DeviceCatalog} from './catalog.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length - 1; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = args.get('-port');
if (!/^\d+$/.test(port || '')) throw new Error('Stream Deckから起動してください');
const connection = JSON.parse(readFileSync(new URL('./connection.json', import.meta.url), 'utf8'));
const bridge = new HomeControlBridge(connection.projectRoot);
const socket = new WebSocket(`ws://127.0.0.1:${port}`);
const send = value => {if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));};
let dial, catalog;
const inspectors = new Set();
const controller = new LightController(bridge, send, {
  onAction: (targets, payload) => dial.beginButtonAction(payload),
  onResult: (payload, result, notification) => dial.finishButtonAction(payload, result, notification),
  onFailure: (payload, notification) => dial.finishButtonAction(payload, {results: []}, notification),
  getDevices: force => catalog.get(force),
});
dial = new BrightnessDial(bridge, send, {
  enqueue: work => controller.enqueue(work),
  onAction: (targets, context) => {controller.invalidate(targets); dial.invalidate(targets, context);},
  onStates: states => controller.receiveStates(states),
  getDevices: force => catalog.get(force),
});
catalog = new DeviceCatalog(bridge, devices => {
  dial.updateDeviceNames(devices);
  for (const context of inspectors) send({event: 'sendToPropertyInspector', context, payload: {type: 'devices', devices}});
});

socket.addEventListener('open', () => {
  send({event: args.get('-registerEvent'), uuid: args.get('-pluginUUID')});
  catalog.start(); // Refresh names once a minute without sending device commands.
});
socket.addEventListener('message', event => {
  try {
    const data = JSON.parse(event.data);
    if (data.event === 'propertyInspectorDidAppear' || (data.event === 'sendToPlugin' && data.payload?.type === 'devices')) inspectors.add(data.context);
    if (data.event === 'propertyInspectorDidDisappear' || data.event === 'willDisappear') inspectors.delete(data.context);
    (data.action === DIAL_ACTION ? dial : controller).handle(data).catch(() => {
      send({event: 'logMessage', payload: {message: 'Home Control event failed; see action settings.'}});
    });
  } catch {
    send({event: 'logMessage', payload: {message: 'Home Control received an invalid event.'}});
  }
});
function close() {catalog.stop(); dial.close(); bridge.close(); process.exit(0);}
socket.addEventListener('close', close);
socket.addEventListener('error', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
process.on('exit', () => bridge.close());
