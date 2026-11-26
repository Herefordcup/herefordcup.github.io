import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const origin = 'http://127.0.0.1';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

const individual = {kind:'individual',matchId:'friday',roundId:'round-blue',label:'Friday singles · Alex',row:{id:'row-seven',round_id:'round-blue',hole_number:7,gross_score:5}};
const driver = {kind:'texas_scramble_hole',matchId:'scramble',label:'Blue · 8:00 AM',players:[{id:'one',name:'First golfer'},{id:'two',name:'Second golfer'}],row:{id:'drive-four',hole_number:4,gross_score:4,tee_shot_player_id:'two'}};
const outcome = {kind:'match_hole_outcome',matchId:'sunday',label:'Sunday · Singles',row:{id:'winner-eight',hole_number:8,winner:'halved'}};

async function editPage(t, target=individual, {width=390,height=844, fallback=false, allowed=true}={}) {
  const page=await browser.newPage({viewport:{width,height},serviceWorkers:'block'}); t.after(()=>page.close());
  const entries=Array.isArray(target)?target:[target];
  const calls=[],notices=[],reads=[]; const api={};
  await page.exposeFunction('savedApi',async(kind,args)=>{
    calls.push({kind,args});
    if(api.write)return api.write(kind,args);
    const {row}=entries.find(entry=>entry.row.id===(kind==='individual'?args.expectedScoreId:args.targetId));
    if(kind==='individual')return {score:{...row,gross_score:args.grossScore}};
    return {...row,...(args.winner?{winner:args.winner}:{gross_score:args.grossScore,tee_shot_player_id:args.teeShotPlayerId})};
  });
  await page.exposeFunction('savedRead',async(target,result)=>{reads.push({target,result});return api.refresh?.();});
  await page.exposeFunction('notice',(message,warning,target)=>notices.push({message,warning,id:target.row.id}));
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url()); if(u.origin!==origin)return route.abort();
    if(u.pathname==='/') return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/scorecard-edit.css"></head><body><p id="load"></p><script type="module">
      window.allowed=${allowed};const entries=${JSON.stringify(entries)};
      if (${fallback}) HTMLDialogElement.prototype.showModal=undefined;
      try {const {createHoleEditor}=await import('/src/scorecard-hole-editor.js');
        // Return structured errors as data across the binding; throw them in the browser as Supabase does.
        const rpc=async(kind,args)=>{const result=await savedApi(kind,args);if(result?.error)throw result.error;return result;};
        const options={canEdit:()=>window.allowed,correctHoleScore:a=>rpc('individual',a),correctTeamScoreEntry:a=>rpc('team',a),onSaved:savedRead,notify:notice};
        entries.forEach((entry,i)=>{const button=document.createElement('button');button.id=i?'row'+i:'row';
          button.dataset.editHole='';button.dataset.entryId=entry.row.id;button.textContent='Edit';document.getElementById('load').before(button);
          button.onclick=()=>createHoleEditor(options).open(entry,button);});
        document.getElementById('load').textContent='Ready';
      }catch{document.getElementById('load').textContent='No contextual score editor';}
    </script></body></html>`});
    if(!['/src/scorecard-hole-editor.js','/scorecard-edit.css'].includes(u.pathname))return route.abort();
    const body=await readFile(new URL('.'+u.pathname,root),'utf8').catch(()=>null);
    return route.fulfill({status:body===null?404:200,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css',body:body??''});
  });
  await page.goto(origin);await page.waitForFunction(()=>Boolean(document.querySelector('#load')?.textContent));
  assert.equal(await page.locator('#load').textContent(),'Ready','the contextual editor must be available on the scorecard');
  return {page,calls,notices,reads,api};
}

test('Edit opens the exact submitted hole with its score and saves through the audited individual RPC',async t=>{
  const {page,calls,notices,reads}=await editPage(t);
  await page.locator('#row').click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await expect(dialog).toHaveAttribute('data-entry-id','row-seven');
  await expect(dialog.getByRole('heading')).toContainText('7');await expect(dialog).toContainText('Friday singles · Alex');
  await expect(page.locator('#holeEditGross')).toHaveValue('5');await expect(page.locator('#holeEditDriver')).toBeHidden();await expect(page.locator('#holeEditWinner')).toBeHidden();
  await expect(dialog.getByRole('combobox')).toHaveCount(0); // No match, player or hole to pick again.
  await page.locator('#holeEditGross').fill('4');await page.locator('#holeEditReason').fill('  Verified on card  ');await page.locator('#holeEditSave').click();
  await expect(dialog).toBeHidden();await expect.poll(()=>notices.length).toBe(1);
  assert.deepEqual(calls,[{kind:'individual',args:{roundId:'round-blue',holeNumber:7,expectedScoreId:'row-seven',grossScore:4,reason:'Verified on card',deleteScore:false}}]);
  assert.equal(reads.length,1);assert.equal(reads[0].target.row.id,'row-seven');assert.match(notices[0].message,/Hole 7 corrected/);await expect(page.locator('#row')).toBeFocused();
});

test('a Scramble correction can change only the selected tee-shot player',async t=>{
  const {page,calls,notices}=await editPage(t,driver);
  await page.locator('#row').click();await expect(page.locator('#holeEditDialog')).toBeVisible({timeout:800});
  await expect(page.locator('#holeEditGross')).toHaveValue('4');await expect(page.locator('#holeEditDriver')).toHaveValue('two');
  await expect(page.locator('#holeEditDriver option')).toHaveCount(2);await expect(page.locator('#holeEditWinner')).toBeHidden();
  await page.selectOption('#holeEditDriver','one');await page.fill('#holeEditReason','Scorekeeper confirmed the drive');await page.click('#holeEditSave');
  await expect.poll(()=>notices.length).toBe(1);
  assert.deepEqual(calls,[{kind:'team',args:{targetType:'texas_scramble_hole',targetId:'drive-four',grossScore:4,teeShotPlayerId:'one',reason:'Scorekeeper confirmed the drive'}}]);
});

test('hole-winner entry presents only Blue, Halved and White and keeps a completion warning',async t=>{
  const {page,calls,notices,api}=await editPage(t,outcome);
  api.write=(_,a)=>({...outcome.row,winner:a.winner,completion_warning:'Check individual tee indexes.'});
  await page.locator('#row').click();await expect(page.locator('#holeEditDialog')).toBeVisible({timeout:800});
  await expect(page.locator('#holeEditGross')).toBeHidden();await expect(page.locator('#holeEditDriver')).toBeHidden();
  await expect(page.locator('#holeEditWinner option')).toHaveText(['Blue','Halved','White']);await expect(page.locator('#holeEditWinner')).toHaveValue('halved');
  await page.selectOption('#holeEditWinner','silver');await page.fill('#holeEditReason','Checked with both sides');await page.click('#holeEditSave');
  await expect.poll(()=>notices.length).toBe(1);
  assert.deepEqual(calls,[{kind:'team',args:{targetType:'match_hole_outcome',targetId:'winner-eight',winner:'silver',reason:'Checked with both sides'}}]);
  assert.match(notices[0].message,/Hole 8 corrected.*tee indexes/);assert.equal(notices[0].warning,true);
});

test('rejects an empty reason, an unchanged score, or loss of organizer access without writing',async t=>{
  const {page,calls}=await editPage(t,individual,{allowed:false});await page.click('#row');
  assert.equal(await page.locator('#holeEditDialog').count(),0);
  await page.evaluate(()=>{window.allowed=true;});await page.click('#row');await page.fill('#holeEditReason',' ');await page.click('#holeEditSave');
  await expect(page.locator('#holeEditFeedback')).toContainText('reason');await page.fill('#holeEditReason','Checked');await page.click('#holeEditSave');
  await expect(page.locator('#holeEditFeedback')).toContainText('Change');await page.fill('#holeEditGross','4');
  await page.evaluate(()=>{window.allowed=false;});await page.click('#holeEditSave');
  await expect(page.locator('#holeEditFeedback')).toContainText('no longer editable');assert.deepEqual(calls,[]);
  await page.click('#holeEditCancel');await expect(page.locator('#row')).toBeFocused();
});

test('a structured database refusal keeps the draft for a corrected retry',async t=>{
  const {page,calls,notices,reads,api}=await editPage(t,driver);
  api.write=()=>({error:{code:'P0001',message:'The selected tee shot must belong to this squad.'}});
  await page.click('#row');await page.fill('#holeEditGross','3');await page.fill('#holeEditReason','Signed card');await page.click('#holeEditSave');
  await expect(page.locator('#holeEditFeedback')).toHaveText('The selected tee shot must belong to this squad.');
  await expect(page.locator('#holeEditReason')).toHaveValue('Signed card');await expect(page.locator('#holeEditGross')).toHaveValue('3');
  await expect(page.locator('#holeEditCancel')).toBeEnabled();assert.equal(reads.length,0);
  delete api.write;await page.selectOption('#holeEditDriver','one');await page.click('#holeEditSave');
  await expect.poll(()=>notices.length).toBe(1);assert.equal(notices[0].warning,false);assert.equal(reads.length,1);
  assert.deepEqual(calls.map(c=>[c.args.grossScore,c.args.teeShotPlayerId,c.args.reason]),[[3,'two','Signed card'],[3,'one','Signed card']]);
});

test('a pending write submits once; a readback failure reports the confirmed correction with a warning',async t=>{
  const {page,calls,notices,api}=await editPage(t,driver);let release;
  api.write=()=>new Promise(resolve=>{release=()=>resolve({...driver.row,gross_score:3});});api.refresh=()=>{throw new Error('History offline');};
  await page.click('#row');await page.fill('#holeEditGross','3');await page.fill('#holeEditReason','Signed card');await page.click('#holeEditSave');
  await expect.poll(()=>calls.length).toBe(1);await page.keyboard.press('Escape');
  await expect(page.locator('#holeEditDialog')).toBeVisible();await expect(page.locator('#holeEditSave')).toBeDisabled();
  await page.locator('#holeEditDialog form').evaluate(f=>f.requestSubmit());release();
  await expect.poll(()=>notices.length).toBe(1);assert.match(notices[0].message,/Hole 4 corrected.*History offline/);assert.equal(notices[0].warning,true);
  assert.doesNotMatch(notices[0].message,/might have saved|could not be saved/i);assert.equal(calls.length,1);await expect(page.locator('#holeEditDialog')).toHaveCount(0);
});

test('a response lost after commit blocks only that row across submit and fresh editor instances until refresh',async t=>{
  const saved={...individual,row:{...individual.row}}, other={...individual,row:{...individual.row,id:'row-eight',hole_number:8}};
  const {page,calls,reads,api}=await editPage(t,[saved,other]);
  await page.evaluate(()=>{const draft=document.createElement('input');draft.id='unsavedHole';draft.value='6';document.body.append(draft);});
  api.write=(_,args)=>{
    const entry=[saved,other].find(e=>e.row.id===args.expectedScoreId);
    entry.row.gross_score=args.grossScore; // The database committed before the response was lost.
    return entry===saved?{error:{code:'',message:'Failed to fetch'}}:{score:entry.row};
  };
  await page.click('#row');await page.fill('#holeEditGross','4');await page.fill('#holeEditReason','Signed card');await page.click('#holeEditSave');
  const form=page.locator('#holeEditDialog form'), feedback=page.locator('#holeEditFeedback');
  await expect.poll(()=>saved.row.gross_score).toBe(4);await expect(form).not.toHaveAttribute('aria-busy','true');
  await form.evaluate(f=>f.requestSubmit());await expect(form).not.toHaveAttribute('aria-busy','true');
  assert.equal(calls.length,1,'A lost response must not allow a second write');assert.equal(reads.length,0);
  for(const reopen of [false,true]) {
    if(reopen)await page.click('#row'); // Each click constructs a fresh editor in this document.
    await expect(feedback).toContainText(/might have saved/i);await expect(feedback).toContainText(/refresh.*before trying again/i);
    await expect(page.locator('#holeEditSave')).toBeDisabled();await expect(page.locator('#holeEditCancel')).toBeFocused();
    await form.evaluate(f=>{f.querySelector('#holeEditGross').value='4';f.querySelector('#holeEditReason').value='Signed card';f.requestSubmit();});
    await page.click('#holeEditCancel');await expect(page.locator('#row')).toBeFocused();
  }
  await page.click('#row1');await page.fill('#holeEditGross','3');await page.fill('#holeEditReason','Other signed card');await page.click('#holeEditSave');
  await expect(form).toHaveCount(0);assert.equal(other.row.gross_score,3);assert.deepEqual(calls.map(c=>c.args.expectedScoreId),['row-seven','row-eight']);
  await expect(page.locator('#unsavedHole')).toHaveValue('6');
  await page.reload();await page.click('#row');await expect(page.locator('#holeEditGross')).toHaveValue('4');await expect(page.locator('#holeEditSave')).toBeEnabled();
});

test('timeout, gateway, unknown, and message-less errors do not unlock retry',async t=>{
  const errors=[{code:'57014',message:'Statement timed out'},{code:'504',message:'Gateway Timeout'},
    {code:'ZZ999',message:'The selected tee shot must belong to this squad.'},{code:'P0001',message:'  '}];
  const entries=errors.map((_,i)=>({...individual,row:{...individual.row,id:'entry-'+i,hole_number:i+1}}));
  const {page,api,calls,reads}=await editPage(t,entries);api.write=(_,args)=>({error:errors[args.holeNumber-1]});
  for(const {row} of entries) {
    await page.click(`button[data-entry-id="${row.id}"]`);await page.fill('#holeEditGross','4');await page.fill('#holeEditReason','Signed card');await page.click('#holeEditSave');
    await expect(page.locator('#holeEditFeedback')).toContainText(/might have saved/i);await expect(page.locator('#holeEditSave')).toBeDisabled();
    await page.locator('#holeEditDialog form').evaluate(f=>f.requestSubmit());await page.click('#holeEditCancel');
  }
  assert.deepEqual(calls.map(c=>c.args.expectedScoreId),entries.map(e=>e.row.id));assert.equal(reads.length,0);
});

test('an unconfirmed return identity neither claims success nor permits a second write to that entry',async t=>{
  const {page,api,calls,reads,notices}=await editPage(t);api.write=()=>({score:{...individual.row,id:'another-entry',gross_score:4}});
  await page.click('#row');await page.fill('#holeEditGross','4');await page.fill('#holeEditReason','Signed card');await page.click('#holeEditSave');
  await expect.poll(()=>notices.length).toBe(1);assert.equal(reads.length,0);assert.equal(notices[0].warning,true);
  assert.match(notices[0].message,/could not confirm|not confirmed/i);assert.doesNotMatch(notices[0].message,/Hole 7 corrected/);
  await page.click('#row');await page.locator('#holeEditDialog form').evaluate(f=>{
    f.querySelector('#holeEditGross').value='4';f.querySelector('#holeEditReason').value='Signed card';f.requestSubmit();
  });
  await expect(page.locator('#holeEditDialog form[aria-busy="true"]')).toHaveCount(0);
  assert.equal(calls.length,1,'A mismatched response cannot authorize another write');
  await expect(page.locator('#holeEditSave')).toBeDisabled();await expect(page.locator('#holeEditFeedback')).toContainText(/refresh/i);
  await page.click('#holeEditCancel');await expect(page.locator('#row')).toBeFocused();
});

test('legacy fallback opens a hole outcome, manually wraps both Tab directions, and contains focus without inert',async t=>{
  const {page,calls}=await editPage(t,outcome,{fallback:true});
  const state=await page.evaluate(()=>{
    // Mask these built-ins only during this synchronous interaction, never during Playwright's own calls.
    const hasOwn=Object.hasOwn, at=Array.prototype.at, inert=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'inert');
    try {
      Object.hasOwn=undefined;Array.prototype.at=undefined;delete HTMLElement.prototype.inert;
      const trigger=document.getElementById('row');trigger.click();const dialog=document.getElementById('holeEditDialog');
      if(!dialog)return {open:false};
      const tab=shiftKey=>{
        const event=new KeyboardEvent('keydown',{key:'Tab',shiftKey,bubbles:true,cancelable:true});
        document.activeElement.dispatchEvent(event);return [event.defaultPrevented,document.activeElement.id];
      };
      const open=dialog.hasAttribute('open'), initial=document.activeElement.id;
      const backwards=tab(true), forwards=tab(false);
      trigger.focus();const contained=dialog.contains(document.activeElement);
      dialog.querySelector('form').requestSubmit();const validation=document.getElementById('holeEditFeedback').textContent;
      return {open,initial,backwards,forwards,contained,validation};
    } finally {Object.hasOwn=hasOwn;Array.prototype.at=at;if(inert)Object.defineProperty(HTMLElement.prototype,'inert',inert);}
  });
  assert.equal(state.open,true,'An outcome must open even without Object.hasOwn or showModal');assert.equal(state.initial,'holeEditWinner');
  assert.deepEqual(state.backwards,[true,'holeEditSave']);assert.deepEqual(state.forwards,[true,'holeEditWinner']);
  assert.equal(state.contained,true,'Focus outside the dialog must be redirected without native inert');assert.match(state.validation,/reason/i);
  await page.keyboard.press('Escape');await expect(page.locator('#row')).toBeFocused();assert.equal(calls.length,0);
});

for (const [width,height,fallback] of [[320,568,false],[667,320,true],[1280,800,false]]) {
  test(`score editor stays within ${width}×${height}, with reachable controls and keyboard dismissal${fallback?' (fallback)':''}`,async t=>{
    const {page,calls}=await editPage(t,{...driver,label:'Blue · '+('Long golfer name '.repeat(22))},{width,height,fallback});
    await page.click('#row');const modal=page.locator('#holeEditDialog');await expect(modal).toBeVisible({timeout:900});
    await expect(page.locator('#holeEditGross')).toBeFocused();const g=await modal.evaluate(el=>{
      const r=el.getBoundingClientRect(),button=el.querySelector('#holeEditSave').getBoundingClientRect();
      return {fits:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,body:document.body.scrollWidth,w:innerWidth,buttonHeight:button.height};
    });assert.ok(g.fits,JSON.stringify(g));assert.ok(g.body<=g.w,JSON.stringify(g));assert.ok(g.buttonHeight>=44,'minimum 44px action height');
    await page.locator('#holeEditSave').scrollIntoViewIfNeeded();await expect(page.locator('#holeEditSave')).toBeInViewport();
    if(fallback){await page.locator('#holeEditSave').focus();await page.keyboard.press('Tab');await expect(page.locator('#holeEditGross')).toBeFocused();}
    await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);await expect(page.locator('#row')).toBeFocused();assert.deepEqual(calls,[]);
  });
}
