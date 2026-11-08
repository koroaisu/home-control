import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const BASE = 'http://127.0.0.1:3210';

// The service stays in the project so the future display app shares its credentials and API.
export class HomeControlBridge {
  constructor(root, {request = fetch, launch = spawn, node = process.execPath} = {}) {
    if (!path.isAbsolute(root) || !existsSync(path.join(root, 'server.mjs'))) {
      throw new Error('Home Controlの場所が見つかりません。install-plugin.ps1を再実行してください');
    }
    this.root = root;
    this.request = request;
    this.launch = launch;
    this.node = node;
    this.child = null;
    this.starting = null;
  }

  config() {
    return JSON.parse(readFileSync(path.join(this.root, 'data', 'config.json'), 'utf8'));
  }

  async probe() {
    let response;
    try {
      response = await this.request(BASE + '/api/setup', {signal: AbortSignal.timeout(1500)});
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return false;
      throw new Error('Home Controlへの接続を確認できません。ポート3210を確認してください');
    }
    if (!response.ok) throw new Error('ポート3210で別のサービスが動作しています');
    const setup = await response.json();
    if (setup.apiKey !== this.config().apiKey) {
      throw new Error('別のHome Controlが起動しています。接続先を確認してください');
    }
    return true;
  }

  async ensure() {
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {await this.starting;} finally {this.starting = null;}
  }

  async start() {
    if (await this.probe()) return;
    if (!this.child) {
      const child = this.launch(this.node, [path.join(this.root, 'server.mjs')], {
        cwd: this.root, windowsHide: true, stdio: 'ignore',
      });
      this.child = child;
      child.once('exit', () => {if (this.child === child) this.child = null;});
      child.once('error', () => {if (this.child === child) this.child = null;});
    }
    for (let attempt = 0; attempt < 25; attempt++) {
      await delay(200);
      if (await this.probe()) return;
      if (!this.child) break;
    }
    throw new Error('Home Controlを起動できませんでした。設定画面から再接続してください');
  }

  async api(route, payload) {
    await this.ensure();
    const response = await this.request(BASE + route, {
      method: payload ? 'POST' : 'GET',
      headers: {'Authorization': `Bearer ${this.config().apiKey}`, 'Content-Type': 'application/json'},
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(payload ? 180000 : 30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Home Control HTTP ${response.status}`);
    return data;
  }

  close() {
    // Never terminate a service that the user started separately.
    this.child?.kill();
    this.child = null;
  }
}
