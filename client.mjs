import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const id=process.argv[2];
if(!/^[a-f0-9]{16}$/.test(id||''))throw new Error('Invalid button');
try{
  const config=JSON.parse(readFileSync(new URL('./data/config.json',import.meta.url),'utf8'));
  const action=readFileSync(new URL(`./buttons/${id}.json`,import.meta.url),'utf8');
  const res=await fetch('http://127.0.0.1:3210/api/v1/actions',{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},body:action,signal:AbortSignal.timeout(180000)});
  const result=await res.json();
  if(!res.ok||result.results.some(r=>!r.accepted))throw new Error(JSON.stringify(result));
}catch(e){console.error('操作に失敗しました。Home Controlが起動しているか確認してください。',e.message);process.exitCode=1;}
