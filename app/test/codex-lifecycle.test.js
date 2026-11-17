import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexRpc, AsyncQueue } from '../engines/rpc.js'
import { codexQuery } from '../engines/codex.js'

const holderSource = `const {spawn}=require('node:child_process');
const holder=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr],windowsHide:true});
console.log(JSON.stringify({holderPid:holder.pid}));holder.unref();`
const within = (promise, ms = 2000) => Promise.race([promise, delay(ms).then(() => { throw new Error('Lifecycle did not settle promptly') })])
async function stopHolder(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await once(child, 'close')
  } else { try { process.kill(pid, 'SIGTERM') } catch {} }
}

test('an exited app-server cannot retain a live RPC through descendant stdio handles', async t => {
  const diagnostics = [], failures = []; let holderPid
  const rpc = new CodexRpc({ command: process.execPath, args: ['-e', holderSource + 'setTimeout(()=>process.exit(0),80)'], env: process.env, onDiagnostic: d => diagnostics.push(d) })
  rpc.onError = e => failures.push(e)
  rpc.child.stdout.on('data', data => { holderPid = JSON.parse(data.toString()).holderPid })
  t.after(async () => { await stopHolder(holderPid); await rpc.close() })
  await within(rpc.exited)
  await within(rpc.close())
  assert.equal(failures.length, 1)
  assert.match(failures[0].message, /进程退出/)
  assert.equal(rpc.child.stdout.destroyed, true)
  assert.equal(rpc.child.stderr.destroyed, true)
  assert.ok(diagnostics.some(d => d.event === 'process-exit'))
  assert.ok(diagnostics.some(d => d.event === 'close-complete'))
})

test('closing an input channel after a completed turn releases the query; process loss also reaches the consumer', async t => {
  for (const exitAfterTurn of [true, false]) {
    const diagnostics = [], input = new AsyncQueue(); let holderPid, rpc
    const protocol = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);let result={};
      if(m.method==='config/read')result={config:{}};
      if(m.method==='thread/start')result={thread:{id:'lifecycle-thread'}};
      if(m.id)console.log(JSON.stringify({id:m.id,result}));
      if(m.method==='turn/start'){
        console.log(JSON.stringify({method:'turn/started',params:{turn:{id:'t1'}}}));
        console.log(JSON.stringify({method:'item/completed',params:{item:{type:'agentMessage',id:'m1',text:'OK'}}}));
        console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'t1',status:'completed'}}}));
        ${exitAfterTurn ? holderSource + 'setTimeout(()=>process.exit(0),80);' : ''}
      }
    })`
    const run = (async () => {
      for await (const event of codexQuery({ prompt: input, options: { cwd: process.cwd(), tools: [], onEngineDiagnostic: d => diagnostics.push(d) }, rpcFactory: args => {
        rpc = new CodexRpc({ ...args, command: process.execPath, args: ['-e', protocol], env: process.env })
        rpc.child.stdout.on('data', data => { for (const line of data.toString().trim().split('\n')) { try { holderPid ||= JSON.parse(line).holderPid } catch {} } })
        return rpc
      } })) {
        if (event.subtype === 'init') input.push('hello')
        if (event.type === 'result' && !exitAfterTurn) input.end()
      }
    })()
    t.after(async () => { input.end(); await stopHolder(holderPid); await rpc?.close() })
    if (exitAfterTurn) await assert.rejects(within(run), /进程退出/)
    else await within(run)
    assert.equal(rpc.closed, true)
    assert.ok(diagnostics.some(d => d.event === 'close-complete'))
    assert.ok(diagnostics.some(d => d.event === 'turn-completed'))
    assert.ok(!JSON.stringify(diagnostics).includes('hello'))
  }
})

test('unconfirmed process cleanup fails within its limit instead of hanging forever', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => false })
  const diagnostics = []
  const rpc = new CodexRpc({ spawnProcess: () => child, closeTimeoutMs: 30, onDiagnostic: d => diagnostics.push(d) })
  await assert.rejects(rpc.close(), /关闭超时/)
  assert.ok(diagnostics.some(d => d.event === 'close-timeout'))
  assert.ok(!diagnostics.some(d => d.event === 'close-complete'))
})
