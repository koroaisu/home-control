import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {headers,command,SwitchBot} from './switchbot.mjs';
test('認証署名が公式形式に一致する',()=>{assert.equal(headers('token','secret','123','nonce').sign,createHmac('sha256','secret').update('token123nonce').digest('base64'));});
test('電球のコマンドと範囲を検証する',()=>{assert.equal(command('toggle').command,'toggle');assert.equal(command('color',[255,0,40]).parameter,'255:0:40');for(const [a,v]of [['brightness',0],['brightness',101],['brightness',2.5],['temperature',6501],['color',[256,0,0]],['unknown',1]])assert.throws(()=>command(a,v));});
test('電球だけを公開し、未知の機器への送信を防ぐ',async()=>{const calls=[];const p=new SwitchBot(()=>({token:'t',secret:'s'}),async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({statusCode:100,body:url.endsWith('/devices')?{deviceList:[{deviceId:'bulb',deviceName:'電球',deviceType:'Color Bulb'},{deviceId:'lock',deviceType:'Lock'}]}:{}})};});assert.equal((await p.devices()).length,1);await assert.rejects(()=>p.execute('lock','on'));await p.execute('bulb','on');assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1].options.body).command,'turnOn');});
test('API失敗時に成功扱いせず再送しない',async()=>{let count=0;const p=new SwitchBot(()=>({token:'t',secret:'s'}),async()=>{count++;return {ok:true,json:async()=>({statusCode:190})};});await assert.rejects(()=>p.devices(),/190/);assert.equal(count,1);});
