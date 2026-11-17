import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../arc/server-store.mjs';
import { registerRoutes } from '../arc/server.mjs';
import { createRecord, recordEncounter, derive, injectState, recordDaily, addDays } from '../arc/core.mjs';
import { createArcBridge, installArcBridge } from '../arc/client.mjs';
import { requestJournal, connectionId } from '../runtime.mjs';

const today='2026-11-15';
const record=()=>createRecord({avatar:'Ava.png',startDate:'2026-11-03',arcType:'cycle',today,id:'test-arc-0001'});
const temp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'ava-calendar-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
test('server record survives reload; two store objects serialize decisions with a durable receipt',async t=>{
    const root=temp(t),a=createFileStore(),b=createFileStore();
    a.transaction(root,e=>{e.record=record();},0);
    const event={id:'canonical-encounter',sequence:1,date:today,unprotected:true,penetrative:true,internalCompletion:true};let rolls=0;
    const outcomes=await Promise.all(Array.from({length:12},(_,i)=>Promise.resolve().then(()=>(i%2?a:b).transaction(root,e=>recordEncounter(e.record,event,today,()=>{rolls++;return true;})))));
    assert.equal(rolls,1);assert.equal(outcomes.filter(x=>!x.result.duplicate).length,1);
    assert.equal(createFileStore().read(root).record.arcType,'pregnancy');
    assert.throws(()=>b.transaction(root,e=>{e.record.override=null;},1),/changed/);
    assert.equal(fs.statSync(path.join(root,'ava-calendar/state.json')).mode & 0o777,0o600);
});
test('failed atomic replacement preserves old state; corrupt files are not silently reset',t=>{
    const root=temp(t),good=createFileStore();good.transaction(root,e=>{e.record=record();},0);
    const before=good.read(root);
    const bad=createFileStore({filesystem:{...fs,renameSync(){throw new Error('disk unavailable');}}});
    assert.throws(()=>bad.transaction(root,e=>{e.record.bellyOverride={arcId:e.record.arcId,value:'visible'};}),/disk unavailable/);
    assert.deepEqual(good.read(root),before);
    fs.writeFileSync(path.join(root,'ava-calendar/state.json'),'broken');
    assert.throws(()=>good.transaction(root,e=>{e.record=record();}),/unreadable/);
    assert.equal(fs.readFileSync(path.join(root,'ava-calendar/state.json'),'utf8'),'broken');
});
test('daily decision and birth transition persist atomically and replay after restart',t=>{
    const root=temp(t),store=createFileStore();
    store.transaction(root,e=>{e.record=createRecord({avatar:'Ava.png',startDate:addDays(today,-273),arcType:'pregnancy',today,id:'test-arc-0002'});},0);
    const event={date:today,kind:'birth',arcId:'test-arc-0002'};
    store.transaction(root,e=>recordDaily(e.record,event,()=>true));
    const replay=createFileStore().transaction(root,e=>recordDaily(e.record,event,()=>assert.fail()));
    assert.equal(replay.result.duplicate,true);assert.equal(replay.record.birthDate,today);assert.equal(replay.revision,2);
});
test('HTTP routes enforce user isolation, explicit binding and manual revision checks; other characters are inert',t=>{
    const root=temp(t),other=temp(t),routes=new Map();
    registerRoutes({post:(p,f)=>routes.set(p,f)},{now:()=>Date.parse(today+'T12:00:00Z'),id:()=> 'test-arc-0001'});
    const invoke=(route,body,userRoot=root,authenticated=true)=>{
        let output,status=200;
        routes.get(route)({body,user:authenticated?{profile:{handle:'joe'},directories:{root:userRoot}}:null},
            {setHeader(){},status(n){status=n;return this;},json(v){output=v;}});
        return {status,output};
    };
    assert.equal(invoke('/state',{avatar:'Ava.png'},root,false).status,401);
    assert.equal(invoke('/configure',{avatar:'Ava.png',startDate:today,expectedRevision:0}).status,400);
    const configured=invoke('/configure',{avatar:'Ava.png',startDate:today,arcType:'pregnancy',confirmAva:true,expectedRevision:0});
    assert.equal(configured.status,200);assert.equal(configured.output.revision,1);
    for(const avatar of ['Ríona.png','Eve.png','Marnie.png']) assert.equal(invoke('/state',{avatar}).output.state,null);
    assert.equal(invoke('/state',{avatar:'Ava.png'},other).output.state,null);
    assert.equal(invoke('/override',{avatar:'Ava.png',change:{kind:'stage',value:'birth'},expectedRevision:1}).output.state.arcType,'postpartum');
    assert.equal(invoke('/override',{avatar:'Ava.png',change:{kind:'stage',value:'birth'},expectedRevision:1}).status,409);
    assert.equal(invoke('/clear-override',{avatar:'Ava.png',expectedRevision:2}).output.record.override,null);
    assert.equal(routes.has('/event'),false);assert.equal(routes.has('/encounter'),false);
});

function clientHarness({configured=true,avatar='Ava.png',group=false}={}) {
    const calls=[];let date=today,fail=false,onRead=null;
    const owner=configured?{avatar:'Ava.png'}:null;
    const recipient={avatar,group,chatId:'active-chat'};
    const fetcher=async (url,options)=>{
        calls.push({url,options,data:options?.body?JSON.parse(options.body):null});
        if(url==='/api/plugins/ava-calendar/state') {
            if(onRead)onRead();
            return {ok:!fail,status:fail?503:200,json:async()=>({state:derive(record(),date)})};
        }
        return {ok:true,json:async()=>({choices:[{message:{content:'journal body'},finish_reason:'stop'}]})};
    };
    const bridge=createArcBridge({fetcher,headers:()=>({'x-csrf-token':'fixture'}),binding:()=>owner,target:()=>recipient,yaml:{parse:JSON.parse}});
    const send=data=>bridge.fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'hello'}],...data})});
    return {bridge,calls,recipient,fetcher,send,setDate:d=>date=d,setFail:v=>fail=v,setOnRead:f=>onRead=f};
}
test('inactive client makes no calendar request and leaves existing payload untouched',async()=>{
    const h=clientHarness({configured:false});await h.send();
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].data.messages.length,1);
});
test('request boundary refreshes date and removes old snapshot blocks, including automatic/quiet requests',async()=>{
    const h=clientHarness();const stale=injectState([{role:'user',content:'hello'}],derive(record(),today));
    await h.send({messages:stale});h.setDate(addDays(today,1));
    await h.send({messages:stale,type:'quiet',automatic_trigger:true});
    assert.equal(h.calls.length,4);
    const sent=h.calls.at(-1).data;
    assert.equal(sent.messages.length,2);assert.match(sent.messages.at(-1).content,/"date":"2026-11-16"/);
    assert.match(sent.messages.at(-1).content,/"day":14/);
});
test('non-Ava and group requests receive no calendar and no lookup, even with stale blocks',async()=>{
    for(const options of [{avatar:'Ríona.png'},{avatar:'Eve.png'},{avatar:'Marnie.png'},{avatar:'Ava.png',group:true}]) {
        const h=clientHarness(options);await h.send({messages:injectState([{role:'user',content:'hello'}],derive(record(),today))});
        assert.equal(h.calls.length,1);assert.equal(h.calls[0].data.messages.length,1);
    }
});
test('unavailable state, custom body replacement, cancellation and chat changes stop the model request',async()=>{
    const h=clientHarness();h.setFail(true);await assert.rejects(h.send(),/unavailable/);assert.equal(h.calls.length,1);
    for(const custom of [{custom_include_body:'{"messages":[]}'},{custom_exclude_body:'["messages"]'}]) {
        const x=clientHarness();await assert.rejects(x.send(custom),/Custom API/);assert.equal(x.calls.length,0);
    }
    const x=clientHarness();x.setOnRead(()=>{x.recipient.avatar='Eve.png';});await assert.rejects(x.send(),/Character changed/);assert.equal(x.calls.length,1);
    const y=clientHarness(),controller=new AbortController();y.setOnRead(()=>controller.abort());
    await assert.rejects(y.bridge.fetch('/api/backends/chat-completions/generate',{method:'POST',body:'{"messages":[]}',signal:controller.signal}));assert.equal(y.calls.length,1);
});
test('journal private request uses snapshot owner while another character is selected and uses today, not backfill date',async()=>{
    const h=clientHarness({avatar:'Eve.png'});
    const c={mainApi:'openai',chatCompletionSettings:{chat_completion_source:'custom',custom_url:'fixture',openai_max_context:16000},getRequestHeaders:()=>({})};
    const api={getChatCompletionModel:()=> 'deepseek-fixture',createGenerationParameters:async()=>({generate_data:{}})};
    const snapshot={messages:[{role:'system',content:'Ava character'},{role:'user',content:'Hello'}],avatar:'Ava.png',character:'Ava',user:'Joe',timezone:'Europe/London',connection:connectionId(c,api)};
    const args={c,api,yaml:{parse:JSON.parse},countMessageTokens:async()=>1,snapshot,date:'2026-11-14',guard(){},fetcher:h.bridge.forTarget({avatar:'Ava.png',group:false,chatId:'ava-chat'})};
    await requestJournal(args);
    const sent=h.calls.at(-1).data;
    assert.ok(sent.messages.some(m=>m.content.includes('"journal_date":"2026-11-14"')));
    assert.match(sent.messages.at(-1).content,/"date":"2026-11-15"/);
    const count=h.calls.length;
    await requestJournal({...args,snapshot:{...snapshot,avatar:'Eve.png'},fetcher:h.bridge.forTarget({avatar:'Eve.png',group:false,chatId:'eve-chat'})});
    assert.equal(h.calls.length,count+1);assert.ok(!h.calls.at(-1).data.messages.some(m=>m.content.includes('[AVA_ARC_STATE_V1]')));
});
test('installed browser adapter captures generation identity and unregisters cleanly',async()=>{
    const h=clientHarness();let context={characterId:0,characters:[{avatar:'Ava.png'}],chatId:'a'};
    const listeners=new Map(),eventSource={on:(n,f)=>listeners.set(n,f),removeListener:n=>listeners.delete(n)};
    const surface={fetch:h.fetcher},original=surface.fetch;
    const installed=installArcBridge({surface,host:{eventSource,event_types:{GENERATION_STARTED:'start',GENERATION_ENDED:'end',GENERATION_STOPPED:'stop'},getRequestHeaders:()=>({})},
        ext:{getContext:()=>context,extension_settings:{'ava-calendar':{avatar:'Ava.png'}}},yaml:{parse:JSON.parse}});
    listeners.get('start')('normal',{},false);context={...context,chatId:'b'};
    await assert.rejects(surface.fetch('/api/backends/chat-completions/generate',{method:'POST',body:'{"messages":[]}'}),/Chat changed/);
    assert.equal(h.calls.length,0);installed.uninstall();assert.equal(surface.fetch,original);assert.equal(listeners.size,0);
});
