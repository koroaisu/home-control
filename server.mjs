import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {SwitchBot,command} from './switchbot.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(root,'data'),{recursive:true});
const configPath=path.join(root,'data','config.json');
let config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{apiKey:randomBytes(32).toString('hex')};
function save(){writeFileSync(configPath,JSON.stringify(config,null,2));}
save();
const provider=new SwitchBot(()=>config);
const providers=new Map([['switchbot',provider]]);
const equal=(a,b)=>typeof a==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>16384)throw new Error('リクエストが大きすぎます');}return JSON.parse(text||'{}');}
const server=http.createServer(async(req,res)=>{
  try {
    if (!['127.0.0.1:3210','localhost:3210'].includes(req.headers.host)) return json(res,403,{error:'Host rejected'});
    if (req.headers.origin && !['http://127.0.0.1:3210','http://localhost:3210'].includes(req.headers.origin)) return json(res,403,{error:'Origin rejected'});
    const url=new URL(req.url,'http://127.0.0.1:3210');
    if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});return res.end(readFileSync(path.join(root,'index.html')));}
    // Bootstrap is available only to the local settings page. Other clients use Bearer auth.
    if(req.method==='GET'&&url.pathname==='/api/setup')return json(res,200,{apiKey:config.apiKey,configured:!!(config.token&&config.secret)});
    if(!equal(req.headers.authorization,`Bearer ${config.apiKey}`))return json(res,401,{error:'認証が必要です'});
    if(req.method==='POST'&&url.pathname==='/api/settings'){
      const input=await body(req);
      if(typeof input.token!=='string'||typeof input.secret!=='string'||!input.token.trim()||!input.secret.trim())throw new Error('トークンとシークレットを入力してください');
      config.token=input.token.trim();config.secret=input.secret.trim();save();provider.cached=null;
      return json(res,200,{saved:true});
    }
    if(req.method==='GET'&&url.pathname==='/api/v1/devices')return json(res,200,{devices:await provider.devices(url.searchParams.get('refresh')==='1')});
    const match=url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/([^/]+)\/status$/);
    if(req.method==='GET'&&match){const p=providers.get(match[1]);if(!p)throw new Error('未対応の接続先');return json(res,200,await p.status(decodeURIComponent(match[2])));}
    if(req.method==='POST'&&['/api/v1/actions','/api/buttons'].includes(url.pathname)){
      const input=await body(req);
      command(input.action,input.value);
      if(!Array.isArray(input.targets)||!input.targets.length||input.targets.length>32)throw new Error('対象機器を1〜32台選んでください');
      const devices=await provider.devices();
      const targets=[...new Map(input.targets.map(t=>[`${t.provider}:${t.id}`,t])).values()];
      for(const t of targets)if(!providers.has(t.provider)||typeof t.id!=='string'||!devices.some(d=>d.id===t.id&&d.provider===t.provider))throw new Error('不明な機器です');
      if(url.pathname==='/api/buttons'){
        mkdirSync(path.join(root,'buttons'),{recursive:true});
        const id=randomBytes(8).toString('hex');
        writeFileSync(path.join(root,'buttons',id+'.json'),JSON.stringify({targets,action:input.action,value:input.value}));
        const filename=path.join(root,'buttons',id+'.cmd');
        writeFileSync(filename,`@echo off\r\n"${process.execPath}" "${path.join(root,'client.mjs')}" "${id}"\r\nif errorlevel 1 pause\r\n`);
        return json(res,200,{file:filename});
      }
      const results=[];
      for(const target of targets){try{results.push(await providers.get(target.provider).execute(target.id,input.action,input.value));}catch(e){results.push({id:target.id,accepted:false,error:e.message});}}
      return json(res,200,{results});
    }
    json(res,404,{error:'Not found'});
  }catch(e){json(res,400,{error:e.message.includes('fetch')?'通信に失敗しました。実行結果が不明な場合は状態を確認してください':e.message});}
});
server.listen(3210,'127.0.0.1',()=>console.log('Home Control: http://127.0.0.1:3210'));
