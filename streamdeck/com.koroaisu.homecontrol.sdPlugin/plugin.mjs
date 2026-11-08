import {readFileSync} from 'node:fs';
import {HomeControlBridge} from './bridge.mjs';
import {LightController} from './controller.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length - 1; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = args.get('-port');
if (!/^\d+$/.test(port || '')) throw new Error('Stream Deckから起動してください');
const connection = JSON.parse(readFileSync(new URL('./connection.json', import.meta.url), 'utf8'));
const bridge = new HomeControlBridge(connection.projectRoot);
const socket = new WebSocket(`ws://127.0.0.1:${port}`);
const send = value => {if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));};
const controller = new LightController(bridge, send);

socket.addEventListener('open', () => {
  send({event: args.get('-registerEvent'), uuid: args.get('-pluginUUID')});
  bridge.ensure().catch(() => {}); // Retry on the next user interaction; never send a device command here.
});
socket.addEventListener('message', event => {
  try {
    controller.handle(JSON.parse(event.data)).catch(() => {
      send({event: 'logMessage', payload: {message: 'Home Control event failed; see action settings.'}});
    });
  } catch {
    send({event: 'logMessage', payload: {message: 'Home Control received an invalid event.'}});
  }
});
function close() {bridge.close(); process.exit(0);}
socket.addEventListener('close', close);
socket.addEventListener('error', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
process.on('exit', () => bridge.close());
