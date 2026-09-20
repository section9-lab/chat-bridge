import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexRuntime } from '../bridge/dist/src/codex.js';

const executable = process.argv[2];
assert.ok(executable?.startsWith('/'), 'Pass the installed official Codex executable as an absolute path');
const workspace = join(homedir(), 'Library/Application Support/Chat Bridge/Verification', randomUUID());
const checks = [];
const create = () => new CodexRuntime({ workspace, locate: async () => ({ installed: true, executablePath: executable }) });
let runtime = create();
try {
  const probe = await runtime.probe(); assert.equal(probe.ready, true, probe.reason);
  checks.push({ id: 'RUNTIME-01', passed: true, description: 'Installed official runtime initializes and uses its existing authenticated account.' });
  console.log('RUNTIME-01 passed');
  const session = await runtime.createSession({agent:'codex',mode:'code',projectId:null}, randomUUID());
  const key = 'BRIDGE-' + randomUUID().slice(0,8);
  const first = await runtime.sendTurn(session, `这是 Chat Bridge 连通性测试。不要使用工具、访问网络或修改文件。请记住口令 ${key}，并且只回复该口令。`, 'smoke-' + randomUUID());
  assert.equal(first.status, 'completed', first.text); assert.ok(first.text.includes(key));
  checks.push({ id: 'RUNTIME-02', passed: true, description: 'Projectless official session returns a real completed model response.' });
  console.log('RUNTIME-02 passed');
  const second = await runtime.sendTurn(session, '不要使用工具。请只回复上一条消息让你记住的口令。', 'smoke-' + randomUUID());
  assert.equal(second.status, 'completed', second.text); assert.ok(second.text.includes(key));
  checks.push({ id: 'RUNTIME-03', passed: true, description: 'Second turn recalls the first turn in the same native session.' });
  console.log('RUNTIME-03 passed');
  runtime.close(); runtime = create(); assert.equal((await runtime.probe()).ready, true);
  await runtime.resumeSession(session);
  const third = await runtime.sendTurn(session, '不要使用工具。请只回复本会话要求你记住的口令。', 'smoke-' + randomUUID());
  assert.equal(third.status, 'completed', third.text); assert.ok(third.text.includes(key));
  checks.push({ id: 'RUNTIME-04', passed: true, description: 'A new App Server process resumes the exact native session and preserves conversational memory.' });
  console.log('RUNTIME-04 passed');
  const jobId = 'smoke-' + randomUUID();
  let stop;
  const fourth = await runtime.sendTurn(session, '不要使用工具。请用中文写一个长故事，至少两千字。', jobId, {
    started() { stop = runtime.stopTurn(jobId); void stop.catch(() => {}); }
  });
  await stop; assert.equal(fourth.status, 'interrupted');
  checks.push({ id: 'RUNTIME-05', passed: true, description: 'turn/interrupt stops the exact live native turn and emits an interrupted completion.' });
  console.log('RUNTIME-05 passed');
} catch (error) {
  checks.push({ id: 'RUNTIME-FAILURE', passed: false, description: String(error.message).slice(0,1000) });
  process.exitCode = 1;
} finally {
  runtime.close();
  const evidence = { version: '0.3.0', timestamp: new Date().toISOString(), checks,
    scope: 'Real installed Codex App Server and existing login; isolated test session/workspace. No existing desktop session was controlled. Phone-to-Agent, live approval, and locked-screen behavior require separate verification.' };
  await mkdir(new URL('../docs/verification/', import.meta.url), { recursive:true });
  await writeFile(new URL('../docs/verification/codex-runtime-2026-09-18.json', import.meta.url), JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
}
