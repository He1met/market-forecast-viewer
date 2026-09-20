import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { auditCodexEvents, auditCodexEventsV1, auditCodexEventsV2, generateForecast } from '../scripts/m1-forecast.mjs';
import { newRun, freezeInput, readPublished } from '../scripts/m1-archive.mjs';
import { rawOutputJsonSchema } from '../src/m1-contracts.ts';
import {modelArguments} from '../scripts/m1-model.mjs';

const stream = events => events.map(value => JSON.stringify(value)).join('\n');
for(const cli_version of ['codex-cli 0.154.0-alpha.6.2','codex-cli 0.155.0-alpha.9','codex-cli 0.155.0-alpha.9.2']) test(`disabled Code Mode notice needs exact invocation for ${cli_version}`, () => {
  const notice={type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}};
  const args=modelArguments({workspace:'/fixture',schema:'/fixture/schema',output:'/fixture/output'});
  const context={kind:'installed_frozen_input',cli_version,args};
  const events=[{type:'thread.started'},notice,{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'SYNTHETIC'}},{type:'turn.completed'}];
  const accepted=auditCodexEvents(stream(events),context);
  assert.equal(accepted.startup_notice_count,1);assert.equal(accepted.startup_warning_count,1);
  assert.equal(accepted.unexpected_count,0);assert.equal(accepted.unexpected_tool_count,0);assert.equal(accepted.failed,false);
  assert.equal(accepted.startup_notices[0].cli_version,context.cli_version);
  const old=auditCodexEventsV1(stream(events),context);
  assert.equal(old.unexpected_count,cli_version==='codex-cli 0.154.0-alpha.6.2'?0:1);
  assert.equal(old.controlled_disabled_context,cli_version==='codex-cli 0.154.0-alpha.6.2');
  const v2=auditCodexEventsV2(stream(events),context);
  assert.equal(v2.unexpected_count,cli_version==='codex-cli 0.155.0-alpha.9.2'?1:0);
  assert.equal(v2.controlled_disabled_context,cli_version!=='codex-cli 0.155.0-alpha.9.2');
  for(const bad of [undefined,{}, {...context,args:[args[0],args[1],args[3],args[2],...args.slice(4)]}, {...context,args:[...args.slice(0,-1),'--disable','code_mode','-']}, {...context,kind:'legacy'}, ...['codex-cli 0.155.0-alpha.10','codex-cli 0.155.0-alpha.9.1','codex-cli 0.155.0-alpha.9.3','codex-cli 0.155.0-alpha.9.20'].map(cli_version=>({...context,cli_version})), {...context,args:[...args,'--unknown']}, {...context,args:args.map(x=>x==='gpt-6-astra'?'other':x)}, {...context,cli_version:'codex-cli 0.154.1'},
    {...context,args:args.filter(x=>x!=='code_mode')}, {...context,args:args.filter(x=>x!=='code_mode_host')},
    {...context,args:args.filter(x=>x!=='--ignore-user-config')}, {...context,args:[...args,'--enable','code_mode_host']},
    {...context,args:[...args,'--enable=code_mode']}, {...context,args:[...args,'-c','features.code_mode=true']},
    {...context,args:[...args,'-cfeatures.code_mode=true']}, {...context,args:[...args,'--config=features.code_mode=true']},
    {...context,args:[...args,'--profile','other']}, {...context,args:[...args,'--sandbox=danger-full-access']},
    {...context,args:args.map(x=>x==='read-only'?'workspace-write':x)}]) {
    const rejected=auditCodexEvents(stream(events),bad);assert.equal(rejected.startup_notice_count,0);assert.ok(rejected.unexpected_count>0);
  }
  for(const rejectedEvents of [[notice,...events.slice(2)], [events[0],events[2],notice,events[4]],
    [events[0],notice,notice,...events.slice(2)],
    ...[' Authentication failed','\nAuthentication failed',' '].map(s=>[events[0],{...notice,item:{...notice.item,message:notice.item.message+s}},...events.slice(2)]),
    [events[0],{...notice,item:{...notice.item,message:'Authentication failed'}},...events.slice(2)],
    [...events.slice(0,3),{type:'item.started',item:{type:'mcp_tool_call'}},events[4]],
    [...events.slice(0,3),{type:'item.completed',item:{type:'new_unknown_tool'}},events[4]],
    [...events,{type:'unparsed'}], ...[null,1,true,{type:42},{type:{}},{type:true}].map(value=>[...events,value])]) assert.ok(auditCodexEvents(stream(rejectedEvents),context).unexpected_count>0);
  assert.equal(auditCodexEvents(stream([...events,{type:'turn.failed'}]),context).failed,true);
  assert.equal(auditCodexEvents(stream([...events,{type:'error',message:'failure'}]),context).failed,true);
});
test('only the observed pre-turn chronicle startup warning is tolerated', () => {
  const warning = { type: 'item.completed', item: { type: 'error', message:
    'Under-development features enabled: chronicle. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in /fixture/config.toml.' } };
  const result = auditCodexEvents(stream([{ type: 'thread.started' }, warning, { type: 'turn.started' }, { type: 'turn.completed' }]));
  assert.equal(result.unexpected_count, 0); assert.equal(result.startup_warning_count, 1);
  assert.ok(auditCodexEvents(stream([{ type: 'turn.started' }, warning, { type: 'turn.completed' }])).unexpected_count > 0);
  for (const tail of ['\nAuthentication failed', ' Authentication failed']) {
    const appended = { ...warning, item: { ...warning.item, message: warning.item.message + tail } };
    assert.ok(auditCodexEvents(stream([appended, { type: 'turn.completed' }])).unexpected_count > 0);
  }
  assert.ok(auditCodexEvents(stream([{ type: 'item.completed', item: { type: 'error', message: 'Authentication failed' } }, { type: 'turn.completed' }])).unexpected_count > 0);
});
test('a completed pure Codex response is eligible for further output validation', () => {
  const result = auditCodexEvents(stream([{ type: 'thread.started', thread_id: 'fixture' },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"fixture":true}' } },
    { type: 'turn.completed' }]));
  assert.equal(result.turn_completed, true);
  assert.equal(result.failed, false);
  assert.equal(result.unexpected_count, 0);
});

test('missing CLI and code-zero without raw output leave failed attempt receipts, never publications', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mfv-runner-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  const source = path.resolve('scripts/m1-forecast.mjs');
  const provenance = { code_sha256: { [source]: createHash('sha256').update(await fs.readFile(source)).digest('hex') } };
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = bin;
    for (const mode of ['missing', 'no_raw']) {
      if (mode === 'no_raw') {
        await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='--version')console.log('fixture-cli');else if(a[0]==='login')console.error('Logged in using ChatGPT');else {process.stdin.resume();process.stdin.on('end',()=>console.log('{"type":"turn.completed"}'));}\n`, { mode: 0o700 });
      }
      const { runDir } = await newRun(root);
      await freezeInput(runDir, { anchor_time: Math.floor(Date.now() / 900000) * 900, anchor_price: 100 },
        'Fixture only; no actual model call.', rawOutputJsonSchema, provenance);
      await assert.rejects(() => generateForecast(runDir), /Codex generation failed/);
      const receipt = JSON.parse(await fs.readFile(path.join(runDir, 'attempt-001', 'receipt.json'), 'utf8'));
      assert.notEqual(receipt.exit_code, 0);
      assert.equal(receipt.raw_output_sha256, null);
      assert.equal(receipt.error, mode === 'missing' ? 'CODEX_PROCESS_FAILED' : 'RAW_OUTPUT_MISSING');
      assert.equal(await readPublished(runDir), null);
    }
  } finally { process.env.PATH = originalPath; }
});
test('tool attempts, unknown items, malformed records and failed turns cannot pass freeze audit', () => {
  for (const type of ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'new_unknown_tool']) {
    assert.ok(auditCodexEvents(stream([{ type: 'item.started', item: { type } }, { type: 'turn.completed' }])).unexpected_count > 0);
  }
  assert.ok(auditCodexEvents('bad-json\n' + stream([{ type: 'turn.completed' }])).unexpected_count > 0);
  for (const entry of [null, 7, [], { type: 'new_future_action' }, { type: 'item.completed' }]) {
    assert.ok(auditCodexEvents(stream([entry, { type: 'turn.completed' }])).unexpected_count > 0);
  }
  assert.equal(auditCodexEvents(stream([{ type: 'turn.failed' }, { type: 'turn.completed' }])).failed, true);
  assert.equal(auditCodexEvents('').turn_completed, false);
});
