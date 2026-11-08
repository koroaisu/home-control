import {createHmac, randomUUID} from 'node:crypto';

export function headers(token, secret, t=String(Date.now()), nonce=randomUUID()) {
  return {Authorization:token, t, nonce, sign:createHmac('sha256',secret).update(token+t+nonce).digest('base64'), 'Content-Type':'application/json'};
}
export function command(action,value) {
  let name, parameter='default';
  if (['on','off','toggle'].includes(action)) name={on:'turnOn',off:'turnOff',toggle:'toggle'}[action];
  else if (action==='brightness' || action==='temperature') {
    const [min,max]=action==='brightness'?[1,100]:[2700,6500];
    if (!Number.isInteger(value) || value<min || value>max) throw new Error(`${action}: ${min}〜${max}の整数が必要です`);
    name=action==='brightness'?'setBrightness':'setColorTemperature'; parameter=String(value);
  } else if (action==='color') {
    if (!Array.isArray(value)||value.length!==3||!value.every(v=>Number.isInteger(v)&&v>=0&&v<=255)) throw new Error('color: RGBの整数配列が必要です');
    name='setColor'; parameter=value.join(':');
  } else throw new Error('未対応の操作です');
  return {command:name,parameter,commandType:'command'};
}
export class SwitchBot {
  constructor(credentials, request=fetch) {this.credentials=credentials; this.request=request; this.cached=null;}
  async call(path,body) {
    const {token,secret}=this.credentials();
    if (!token||!secret) throw new Error('先にトークンとシークレットを保存してください');
    const response=await this.request('https://api.switch-bot.com/v1.1'+path,{method:body?'POST':'GET',headers:headers(token,secret),body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error(`SwitchBot HTTP ${response.status}。操作の自動再送は行いません`);
    const result=await response.json();
    if (result.statusCode!==100) throw new Error(`SwitchBot エラー ${result.statusCode}`);
    return result.body;
  }
  async devices(refresh=false) {
    if (!refresh && this.cached && Date.now()-this.cached.time<60000) return this.cached.devices;
    const body=await this.call('/devices');
    const devices=body.deviceList.filter(d=>d.deviceType==='Color Bulb').map(d=>({id:d.deviceId,name:d.deviceName,provider:'switchbot',kind:'light',capabilities:['on','off','toggle','brightness','temperature','color']}));
    this.cached={time:Date.now(),devices}; return devices;
  }
  async execute(id,action,value) {
    const payload=command(action,value);
    if (!(await this.devices()).some(d=>d.id===id)) throw new Error('対応する電球が見つかりません');
    await this.call(`/devices/${encodeURIComponent(id)}/commands`,payload);
    return {id,accepted:true};
  }
  async status(id) {
    if (!(await this.devices()).some(d=>d.id===id)) throw new Error('対応する電球が見つかりません');
    return this.call(`/devices/${encodeURIComponent(id)}/status`);
  }
}
