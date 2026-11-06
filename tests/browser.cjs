const fs = require('node:fs'), http = require('node:http'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
const root = path.resolve(__dirname, '..');
const files = new Map(), requests = []; let failStorage = false; let blockGeneration = false, releaseGeneration; const queuedResults = [];
const body = Array.from({ length: 30 }, () => 'I kept the small notebook.').join(' ');
const result = `TITLE: The small quiet notebook\n\n${body}`;
const mocks = {
 '/script.js': `
 export const event_types=Object.fromEntries(['SETTINGS_UPDATED','GENERATE_AFTER_DATA','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_COMPLETION_PROMPT_READY','CHAT_COMPLETION_SETTINGS_READY','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','CHAT_CHANGED','CHAT_LOADED'].map(x=>[x,x]));
 const hooks=new Map(); export const eventSource={on(n,fn){if(!hooks.has(n))hooks.set(n,[]);hooks.get(n).push(fn)},makeLast(n,fn){this.on(n,fn)},removeListener(n,fn){hooks.set(n,(hooks.get(n)||[]).filter(x=>x!==fn))},async emit(n,...args){for(const fn of [...hooks.get(n)||[]])await fn(...args)}};
 export const isGenerating=()=>!!globalThis.fixtureSendBusy || globalThis.realGeneration===true;export function setSendButtonState(v){globalThis.fixtureSendBusy=v};
 export const getRequestHeaders=()=>({'Content-Type':'application/json'});
 export async function saveSettings(){if(globalThis.failSettings)return;localStorage.setItem('fixture-settings',JSON.stringify(globalThis.fixtureSettings));await eventSource.emit('SETTINGS_UPDATED')};
 export async function Generate(type,options,dry){if(!dry)throw Error('Visible generation forbidden');globalThis.captureCount=(globalThis.captureCount||0)+1;await eventSource.emit('GENERATION_STARTED',type,options,true);const c=globalThis.fixture;const prompt=[{role:'system',content:'AVA CARD — HER WORLD: plant and mug.'},...c.chat.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))];await eventSource.emit('GENERATE_AFTER_DATA',{prompt},true)};
 globalThis.host={eventSource,event_types,setSendButtonState};`,
 '/scripts/extensions.js': `
 export const extension_settings=globalThis.fixtureSettings=JSON.parse(localStorage.getItem('fixture-settings')||'{}');
 export const getContext=()=>globalThis.fixture;
 globalThis.fixture={mainApi:'openai',characterId:0,characters:[{avatar:'Ava.png'}],chatId:'chat-a',name1:'Joe',name2:'Ava',chat:[],chatCompletionSettings:{chat_completion_source:'custom',custom_url:'https://fixture.invalid',temp_openai:0.61,stream_openai:true,openai_max_tokens:120,openai_max_context:16000,function_calling:true},getTokenCountAsync:async text=>Math.ceil(text.length/4),getRequestHeaders:()=>({'Content-Type':'application/json'})};
 for(let i=0;i<8;i++)fixture.chat.push({is_user:i%2===0,mes:'Recorded day message '+i,send_date:Date.parse('2026-11-06T12:00:00Z')+i*1000});`,
 '/scripts/openai.js': `export const getChatCompletionModel=()=> 'fixture-model';export const createGenerationParameters=async(settings,model,type,messages)=>({generate_data:{model,type,messages,temperature:settings.temp_openai,stream:settings.stream_openai,max_tokens:settings.openai_max_tokens,custom_include_body:'{}'}});`,
 '/scripts/tokenizers.js': `export const countTokensOpenAIAsync=async message=>4+Math.ceil((message.content||'').length/4);`,
 '/scripts/chats.js': `export const hasPendingFileAttachment=()=>false;`,
 '/scripts/user.js': `export const getCurrentUserHandle=()=>globalThis.fixtureUser||'test-user';`,
 '/scripts/utils.js': `export const timestampToMoment=x=>({valueOf:()=>typeof x==='number'?x:Date.parse(x)});`,
 '/lib.js': `export const yaml={parse:text=>{if(text.trim().startsWith('{')||text.trim().startsWith('['))return JSON.parse(text);return Object.fromEntries(text.split('\\n').filter(Boolean).map(line=>{const n=line.indexOf(':');const key=line.slice(0,n),v=line.slice(n+1).trim();return [key,v.startsWith('"')?JSON.parse(v):v]}))}};`,
};
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/scripts/extensions/third-party/ava-journal/style.css"><style>*{box-sizing:border-box}body{background:#222;color:#eee;font:16px system-ui;margin:12px}.inline-drawer-content{display:block}a{color:#b6d4e8}button,input{font:inherit}.menu_button{background:#444;color:white;border:1px solid #777;border-radius:5px}#send_textarea{width:100%;height:60px}</style></head><body><div id="extensions_settings"></div><textarea id="send_textarea"></textarea><script type="module">import {boot} from '/scripts/extensions/third-party/ava-journal/index.js';globalThis.app=await boot();</script></body></html>`;
function frozenClock() {
 const OriginalDate=Date;globalThis.fixtureNow=OriginalDate.parse('2026-11-06T12:01:00Z');
 globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[globalThis.fixtureNow]))}static now(){return globalThis.fixtureNow}};
}
(async()=>{
 const server=http.createServer(async(req,res)=>{
  const p=req.url.split('?')[0];
  if(p==='/'){res.setHeader('Content-Type','text/html');res.end(html);return}
  if(mocks[p]){res.setHeader('Content-Type','text/javascript');res.end(mocks[p]);return}
  if(p.startsWith('/scripts/extensions/third-party/ava-journal/')){const file=path.join(root,p.split('/').at(-1));if(fs.existsSync(file)){res.setHeader('Content-Type',p.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));return}}
  if(p.startsWith('/user/files/')){if(files.has(p)){res.end(files.get(p));return}res.statusCode=404;res.end();return}
  let raw='';for await(const chunk of req)raw+=chunk;
  const data=raw?JSON.parse(raw):{};res.setHeader('Content-Type','application/json');
  if(p==='/api/files/verify'){if(failStorage){res.statusCode=503;res.end('{}');return}res.end(JSON.stringify(Object.fromEntries(data.urls.map(url=>[url,files.has(url)]))));return}
  if(p==='/api/files/delete'){assert.match(data.path,/^\/user\/files\/ava-journal-check-[a-f0-9-]{36}\.txt$/);files.delete(data.path);res.end('{}');return}
  if(p==='/api/files/upload'){assert.ok(!files.has('/user/files/'+data.name),'must not overwrite');files.set('/user/files/'+data.name,Buffer.from(data.data,'base64').toString('utf8'));res.end(JSON.stringify({path:'/user/files/'+data.name}));return}
  if(p==='/api/backends/chat-completions/generate'){requests.push(data);if(blockGeneration)await new Promise(resolve=>releaseGeneration=resolve);if(!res.destroyed)res.end(JSON.stringify({choices:[{message:{content:queuedResults.shift() ?? result},finish_reason:'stop'}]}));return}
  res.statusCode=404;res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/tmp/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--disable-gpu'],headless:true});
 try{
  const context=await browser.newContext({viewport:{width:393,height:852}});await context.addInitScript(frozenClock);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>!!globalThis.app);
  failStorage=true;
  await page.locator('#aj-enabled').click();await page.waitForFunction(()=>document.querySelector('#aj-storage-status').textContent.includes('failed'));
  assert.equal(await page.locator('#aj-enabled').isChecked(),false,'failed storage check leaves journal disabled');
  await page.evaluate(()=>app.tick(true));assert.equal(requests.length,0,'failed storage blocks manual generation');
  assert.equal(files.size,0);
  failStorage=false;await page.locator('#aj-storage').click();await page.waitForFunction(()=>document.querySelector('#aj-storage-status').textContent.startsWith('Storage verified'));
  assert.equal(files.size,0,'storage probe removed itself');assert.equal(requests.length,0,'storage check never calls model');
  await page.locator('#aj-enabled').check();await page.waitForFunction(()=>!document.querySelector('#aj-write').disabled);
  await page.evaluate(()=>app.tick());
  assert.equal(requests.length,0,'context snapshot makes no model request');
  assert.equal(await page.evaluate(()=>fixtureSendBusy),false,'snapshot-only run releases the actual ST busy flag');
  const configBefore=await page.evaluate(()=>structuredClone(fixtureSettings['ava-journal']));
  await page.evaluate(()=>{globalThis.failSettings=true});await page.locator('#aj-hold').click();await page.waitForFunction(()=>document.querySelector('#aj-status').textContent.includes('not saved'));
  assert.deepEqual(await page.evaluate(()=>fixtureSettings['ava-journal']),configBefore,'failed settings save rolls memory back');
  assert.equal(await page.locator('#aj-hold').isChecked(),false,'failed toggle is restored');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-settings'))['ava-journal']),configBefore,'server saved settings unchanged');
  await page.evaluate(()=>{globalThis.failSettings=false});
  await page.locator('#aj-hold').check();await page.locator('#aj-write').click();await page.waitForFunction(()=>document.querySelector('#aj-entries').children.length===1);
  assert.equal(await page.evaluate(()=>fixtureSendBusy),false,'completed journal releases its busy flag');
  assert.equal(requests.length,1);assert.equal(requests[0].messages.at(-1).role,'user');assert.equal(requests[0].temperature,.95);
  assert.equal(await page.evaluate(()=>fixture.chat.length),8,'no transcript append');
  assert.equal(await page.evaluate(()=>fixture.chatCompletionSettings.temp_openai),.61);
  assert.equal(await page.evaluate(()=>fixtureSettings.disabled_attachments.length),1);
  await page.waitForFunction(()=>!document.querySelector('#aj-write').disabled);await page.locator('#aj-write').click();await page.waitForFunction(()=>document.querySelector('#aj-entries').children.length===2);
  assert.ok(files.has('/user/files/ava-log-2026-11-06-2.md'));
  const beforeDraft=requests.length;await page.locator('#send_textarea').fill('unfinished draft');await page.evaluate(()=>app.tick(true));assert.equal(requests.length,beforeDraft);await page.locator('#send_textarea').fill('');
  await page.locator('#aj-telegram').check();
  const beforeRetry=requests.length;
  queuedResults.push('TITLE: Short entry needs retry\n\nToo short.', result);
  await page.locator('#aj-write').click();await page.waitForFunction(()=>document.querySelector('#aj-entries').children.length===3);
  await page.waitForFunction(()=>!document.querySelector('#aj-write').disabled);
  assert.match(await page.locator('#aj-status').textContent(),/^Saved ava-log-.*Telegram ping failed/,'success survives notification failure');
  await page.locator('#aj-telegram').uncheck();
  assert.equal(requests.length,beforeRetry+2,'one word-count retry');
  assert.deepEqual(requests[beforeRetry],requests[beforeRetry+1],'retry request stays byte-identical');
  blockGeneration=true;await page.locator('#aj-write').click();await page.waitForFunction(()=>document.querySelector('#aj-status').textContent.startsWith('Writing'));
  while(!releaseGeneration)await new Promise(r=>setTimeout(r,10));
  const mirror=await context.newPage();await mirror.goto(url);await mirror.waitForFunction(()=>!!globalThis.app);const attemptsBefore=requests.length;await mirror.evaluate(()=>app.tick(true));assert.equal(requests.length,attemptsBefore,'second tab cannot issue a duplicate generation');
  await mirror.locator('#send_textarea').fill('conversation resumed in another tab');await page.waitForFunction(()=>document.querySelector('#aj-status').textContent.includes('discarded'));releaseGeneration();blockGeneration=false;releaseGeneration=null;await mirror.close();
  await page.waitForFunction(()=>!document.querySelector('#aj-write').disabled);
  assert.equal(files.size,3,'resumed conversation discards result');
  await page.locator('#send_textarea').fill('');
  blockGeneration=true;await page.locator('#aj-write').click();while(!releaseGeneration)await new Promise(r=>setTimeout(r,10));
  await page.evaluate(async()=>{globalThis.realGeneration=true;await host.eventSource.emit('GENERATION_STARTED','normal',{},false)});
  await page.waitForFunction(()=>!document.querySelector('#aj-write').disabled);
  assert.equal(await page.evaluate(()=>fixtureSendBusy),true,'journal cleanup does not re-enable Send during a real generation');
  releaseGeneration();blockGeneration=false;releaseGeneration=null;
  await page.evaluate(()=>{globalThis.realGeneration=false;host.setSendButtonState(false)});
  const ordinary=await page.evaluate(async()=>{await host.eventSource.emit('GENERATION_STARTED','normal',{},false);const event={chat:[],dryRun:false};await host.eventSource.emit('CHAT_COMPLETION_PROMPT_READY',event);return event.chat});
  assert.equal(ordinary.length,1);assert.ok(ordinary[0].content.startsWith("AVA'S OWN PAST JOURNAL"));
  const initiation=await page.evaluate(async()=>{await host.eventSource.emit('GENERATION_STARTED','normal',{automatic_trigger:true},false);const event={chat:[],dryRun:false};await host.eventSource.emit('CHAT_COMPLETION_PROMPT_READY',event);return event.chat});assert.equal(initiation.length,0);
  await page.reload();await page.waitForFunction(()=>!!globalThis.app);await page.evaluate(()=>app.tick());assert.equal(await page.locator('#aj-entries li').count(),3);
  await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('ava-journal:v1:test-user',1);r.onsuccess=()=>{const tx=r.result.transaction('journal','readwrite');tx.objectStore('journal').delete('state');tx.oncomplete=resolve;tx.onerror=reject}}));
  await page.reload();await page.waitForFunction(()=>!!globalThis.app);await page.evaluate(()=>app.tick());assert.equal(await page.locator('#aj-entries li').count(),3,'index rebuilt from disabled Data Bank registrations');
  assert.equal(await page.evaluate(()=>fixtureSendBusy),false,'reload and no-due-job path leave chats accessible');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.screenshot({path:path.join(root,'tests/mobile-preview.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const entriesBeforeRebind=await page.evaluate(()=>app.snapshot().entries.length);
  await page.evaluate(async()=>{fixture.characters.push({avatar:'Other.png'});fixture.characterId=1;fixture.chatId='other-chat';await host.eventSource.emit('CHAT_CHANGED')});
  await page.locator('#aj-rebind').click();await page.waitForFunction(()=>fixtureSettings['ava-journal'].avatar==='Other.png');
  assert.equal(await page.locator('#aj-enabled').isChecked(),false,'rebind does not auto-enable another character');
  assert.equal(await page.evaluate(()=>app.snapshot().entries.length),entriesBeforeRebind,'old journals retained');
  assert.equal(await page.locator('#aj-entries li').count(),0,'old character journals stay isolated');
  await page.evaluate(async()=>{fixture.characterId=0;fixture.chatId='chat-a';await host.eventSource.emit('CHAT_CHANGED')});
  await page.locator('#aj-rebind').click();await page.waitForFunction(()=>document.querySelector('#aj-entries').children.length===3);
  assert.equal(await page.evaluate(()=>fixture.characters.length),2,'no card is added or edited');
  await page.close();
  // New browser profile: record yesterday without writing, then load a different chat.
  files.clear();requests.length=0;
  await context.addInitScript(()=>{globalThis.fixtureUser='backfill-user';localStorage.removeItem('fixture-settings')});const second=await context.newPage();
  await second.goto(url);await second.waitForFunction(()=>!!globalThis.app);await second.locator('#aj-enabled').check();await second.waitForFunction(()=>fixtureSettings['ava-journal']?.enabled && document.querySelector('#aj-storage-status').textContent.startsWith('Storage verified') && !document.querySelector('#aj-write').disabled);await second.evaluate(()=>app.tick());
  assert.equal(requests.length,0);
  await second.evaluate(async()=>{
    fixture.chat.push({is_user:true,mes:'Last user message yesterday',send_date:Date.parse('2026-11-06T12:00:20Z')});
    await host.eventSource.emit('GENERATION_STARTED','normal',{},false);
    await host.eventSource.emit('CHAT_COMPLETION_SETTINGS_READY',{messages:[{role:'system',content:'AVA CARD — HER WORLD: plant. MEMORY INTERCEPTOR retained.'},...fixture.chat.map(m=>({role:m.is_user?'user':'assistant',content:m.mes}))]});
    fixture.chat.push({is_user:false,mes:'Actual final assistant answer',send_date:Date.parse('2026-11-06T12:00:30Z')});
    await host.eventSource.emit('MESSAGE_RECEIVED');await app.tick();
  });
  await second.evaluate(async()=>{fixtureNow=Date.parse('2026-11-07T10:00:00Z');fixture.chatId='chat-b';fixture.chat=[{is_user:true,mes:'Unrelated new chat today',send_date:fixtureNow}];await host.eventSource.emit('CHAT_CHANGED');await app.tick()});
  try { await second.waitForFunction(()=>document.querySelector('#aj-entries').children.length===1, {timeout:8000}); } catch(error) { console.error(await second.evaluate(()=>({status:document.querySelector('#aj-status').textContent,settings:fixtureSettings['ava-journal'],records:Object.values(app.snapshot().records).map(r=>({date:r.date,chatId:r.chatId,count:r.count,snapshot:!!r.snapshot})),realGeneration:globalThis.realGeneration}))); throw error; }
  assert.equal(requests.length,1);const sent=JSON.stringify(requests[0].messages);assert.ok(sent.includes('Recorded day message'));assert.ok(sent.includes('MEMORY INTERCEPTOR retained'));assert.ok(sent.includes('Actual final assistant answer'));assert.ok(!sent.includes('Unrelated new chat today'));assert.ok(sent.includes('2026-11-06'));
  assert.equal(await second.evaluate(()=>fixture.chatId),'chat-b');assert.ok(files.has('/user/files/ava-log-2026-11-06.md'));
  await context.close();
  console.log('Browser integration passed: in-app storage gate and recovery, snapshots without model calls, manual extras, identical-request word-count retry, safe rebind, draft guard, discard on resume, Data Bank exclusion, read-back isolation, reload, mobile layout, recorded-chat backfill.');
 }finally{releaseGeneration?.();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
