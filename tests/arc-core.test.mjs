import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, derive, addDays, dateInZone, normalizeRecord, setOverride, recordEncounter, recordDaily,
    catchUpDates, dailySeed, injectState, BIRTH_CURVE, daysBetween } from '../arc/core.mjs';
const start = '2026-01-01';
const make = (arcType = 'pregnancy', extra = {}) => createRecord({ avatar: 'Ava.png', arcType, startDate: start, today: start, id: 'arc-test-0001', ...extra });

test('calendar advances on civil dates, wraps without writes and handles leap years and DST', () => {
    const r = make('cycle'), before = structuredClone(r);
    for (const [offset, day] of [[0,1],[27,28],[28,1],[55,28],[56,1],[1000,21]]) {
        const state = derive(r, addDays(start, offset)); assert.equal(state.day, day);
        assert.equal(state.cycleStartDate, addDays(start, offset - day + 1));
    }
    assert.deepEqual(r, before);
    assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2);
    assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
    assert.equal(dateInZone(Date.parse('2026-07-01T23:30:00Z'), 'Europe/London'), '2026-07-02');
    assert.equal(dateInZone(Date.parse('2026-07-01T23:30:00Z'), 'America/New_York'), '2026-07-01');
    assert.throws(() => make('cycle', { startDate: '2026-02-30' }));
    assert.throws(() => make('cycle', { timezone: 'Invalid/Zone' }));
});
for (const [day, stage, belly] of [
    [0,'implantation','flat'],[13,'implantation','flat'],[14,'trimester-one','flat'],[41,'trimester-one','flat'],
    [42,'trimester-two-opening','bloat'],[55,'trimester-two-opening','bloat'],[56,'trimester-two-opening','soft swell'],
    [83,'trimester-two-opening','soft swell'],[84,'trimester-two-opening','visible'],[97,'trimester-two-opening','visible'],
    [98,'trimester-two-late','visible'],[139,'trimester-two-late','visible'],[140,'trimester-two-late','definite'],
    [181,'trimester-two-late','definite'],[182,'trimester-three','heavy'],[265,'trimester-three','heavy'],
    [266,'term','engaged'],[280,'term','engaged'],[287,'term','engaged'],[300,'term','engaged'],
]) test(`pregnancy boundary ${day}: ${stage}, ${belly}`, () => {
    const value = derive(make(), addDays(start, day));
    assert.equal(value.day, day); assert.equal(value.stage, stage); assert.equal(value.belly, belly);
});
test('stable daily symptoms, symptom onset and easing use date and identity only', () => {
    const r = make();
    assert.deepEqual(derive(r, addDays(start,7)).symptoms, []);
    assert.ok(['twinge','fatigue'].includes(derive(r,addDays(start,8)).symptoms[0]));
    const date = addDays(start,70), first = derive(r,date);
    assert.equal(first.symptomsEasing,true);
    for(let i=0;i<10;i++) assert.deepEqual(derive(structuredClone(r),date),first);
    assert.notEqual(dailySeed('Ava.png',date),dailySeed('Ava.png',addDays(date,1)));
    assert.notEqual(dailySeed('Ava.png',date),dailySeed('Eve.png',date));
    r.bellyOverride={arcId:r.arcId,value:'visible'};
    assert.equal(derive(r,start).belly,'visible');
});
test('anchored day and stage overrides continue and survive reload without touching conception date', () => {
    let r=make(); const date=addDays(start,10);
    setOverride(r,{kind:'day',value:60},date);
    r=JSON.parse(JSON.stringify(r));
    assert.equal(derive(r,addDays(date,1)).day,61); assert.equal(r.conceptionDate,start);
    setOverride(r,{kind:'stage',value:'trimester-three'},date);
    assert.equal(r.override.stageStartDay,182);
    assert.equal(derive(r,addDays(date,2)).day,184);
    r.override=null; assert.equal(derive(r,addDays(date,2)).day,12);
});
test('birth override transitions immediately; postpartum hand-off is absolute and first fertile date is day 93', () => {
    const r=make(); setOverride(r,{kind:'stage',value:'birth'},start);
    const override=structuredClone(r.override);
    assert.equal(r.arcType,'postpartum'); assert.equal(r.birthDate,start);
    for(const [day,stage] of [[0,'heavy'],[13,'heavy'],[14,'recovering'],[41,'recovering'],[42,'settling'],[83,'settling']]) {
        const state=derive(r,addDays(start,day)); assert.equal(state.stage,stage); assert.equal(state.fertile,false); assert.equal(state.belly,'postpartum-soft');
    }
    normalizeRecord(r,addDays(start,93));
    assert.equal(r.arcStartDate,addDays(start,84));
    assert.equal(derive(r,addDays(start,92)).fertile,false);
    assert.equal(derive(r,addDays(start,93)).day,10); assert.equal(derive(r,addDays(start,93)).fertile,true);
    assert.deepEqual(r.override,override);
    const copy=structuredClone(r); normalizeRecord(r,addDays(start,93)); assert.deepEqual(r,copy);
});
const encounter=(date, sequence=1, extra={})=>({id:'encounter-'+sequence,sequence,date,unprotected:true,penetrative:true,internalCompletion:true,...extra});
test('ineligible encounters do not roll or create receipts',()=>{
    for (const [type,day,extra] of [['cycle',1,{}],['cycle',17,{}],['pregnancy',13,{}],['postpartum',42,{}],['cycle',13,{unprotected:false}],['cycle',13,{penetrative:false}],['cycle',13,{internalCompletion:false}]]) {
        const r=make(type), date=addDays(start,day-(type==='cycle'?1:0));
        const outcome=recordEncounter(r,encounter(date,1,extra),date,()=>assert.fail('must not roll'));
        assert.equal(outcome.eligible,false); assert.equal(r.encounters.length,0); assert.equal(r.encounterHighWater,0);
    }
});
test('one encounter result survives a phase change and repeats; peak/edge probability is exact',()=>{
    for(const [day,p] of [[10,18],[12,18],[13,25],[15,25],[16,18]]) {
        const r=make('cycle'),date=addDays(start,day-1); let calls=0;
        const e=encounter(date);
        const a=recordEncounter(r,e,date,prob=>{assert.equal(prob,p);calls++;return true;});
        assert.equal(r.arcType,'pregnancy'); assert.equal(r.conceptionDate,date); assert.equal(r.arcStartDate,date);
        const b=recordEncounter(JSON.parse(JSON.stringify(r)),e,date,()=>assert.fail('duplicate roll'));
        assert.equal(b.duplicate,true); assert.deepEqual(b.receipt,a.receipt); assert.equal(calls,1);
    }
});
test('pruning keeps at most 50 and 30 days, expired sequences cannot reroll',()=>{
    const r=make('cycle'),date=addDays(start,12);
    for(let seq=1;seq<=51;seq++) recordEncounter(r,encounter(date,seq),date,()=>false);
    assert.equal(r.encounters.length,50);
    assert.throws(()=>recordEncounter(r,encounter(date,1),date,()=>assert.fail()),/expired|processed/);
    normalizeRecord(r,addDays(date,30)); assert.equal(r.encounters.length,0); assert.equal(r.encounterHighWater,51);
    assert.throws(()=>recordEncounter(r,encounter(date,51),addDays(date,30),()=>assert.fail()),/expired|processed/);
});
test('daily receipt and transition are replayable after birth; override is never changed by event',()=>{
    const r=make(); setOverride(r,{kind:'day',value:273},start);
    const old=structuredClone(r.override),event={date:start,kind:'birth',arcId:r.arcId};
    recordDaily(r,event,state=>{assert.equal(state.day,273);return true;});
    assert.equal(r.arcType,'postpartum'); assert.deepEqual(r.override,old);
    const replay=recordDaily(r,event,()=>assert.fail()); assert.equal(replay.duplicate,true);
    assert.equal(derive(r,start).day,0);
});
test('catch-up preserves chronological order and resumes after a bounded 60-date batch',()=>{
    const a=catchUpDates(start,addDays(start,79)); assert.equal(a.dates.length,60); assert.equal(a.nextDate,addDays(start,60));
    const b=catchUpDates(a.nextDate,addDays(start,79)); assert.equal(b.dates.length,20); assert.equal(b.nextDate,null);
    assert.equal(new Set([...a.dates,...b.dates]).size,80);
    assert.deepEqual(catchUpDates(addDays(start,1),start).dates,[]);
});
test('a processed day-287 birth event is forced without calling a random decision',()=>{
    const r=make(),date=addDays(start,287);
    recordDaily(r,{date,kind:'birth',arcId:r.arcId},()=>assert.fail('forced birth must not roll'));
    assert.equal(r.birthDate,date);assert.equal(r.arcType,'postpartum');
});
test('injection replaces stale blocks once and removes them for non-Ava targets',()=>{
    const base=[{role:'system',content:'Danny character instructions'},{role:'user',content:'Hello'}];
    const old=injectState(base,derive(make(),start));
    const current=injectState(old,derive(make(),addDays(start,1)));
    assert.equal(current.length,3); assert.match(current.at(-1).content,/"day":1/);
    assert.deepEqual(injectState(current,null),base);
});
test('exact accepted curve has median 278, survival to 287 below 0.01 percent',()=>{
    let survival=1,median;
    BIRTH_CURVE.slice(0,-1).forEach((p,i)=>{survival*=1-p/100;if(median===undefined&&survival<=.5)median=273+i;});
    assert.equal(median,278); assert.ok(survival<.0001); assert.equal(BIRTH_CURVE.at(-1),100);
});
