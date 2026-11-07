/** Test-only deterministic model boundary; Session, Agent, tools and attachment services remain production. */
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.env.MRW_TEST_SOURCE_ROOT
const evidence = process.env.MRW_TEST_EVIDENCE_ROOT
const python = process.env.MRW_TEST_PYTHON
const workspace = process.env.MRW_TEST_WORKSPACE ?? path.join(evidence ?? '', 'synthetic-project')
const aclPowerShell = process.env.MRW_TEST_ACL_POWERSHELL
const aclOutput = process.env.MRW_TEST_ACL_OUTPUT ?? path.join(evidence ?? '', 'acl-repair')
if (!root || !evidence || !python) throw new Error('The ordinary conversation fixture requires explicit source/evidence roots.')
const built = createRequire(path.join(root, 'apps/cli/package.json'))
const { LlmAdapter, ToolCallId } = built('@deepseek-ai/dsh-llm')
const provider = 'mrw-scripted', model = 'mrw-protocol-only'
const record = value => appendFileSync(path.join(evidence, 'provider-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
const textResponse = text => [
  { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } },
]
const toolResponse = (id, name, args) => {
  const callId = ToolCallId('r13-' + id), text = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: text },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: text } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function requestFrom(options) {
  for (const message of [...options.messages].reverse().filter(value => value.role === 'user')) {
    for (const part of message.content ?? []) {
      if (part.type !== 'text') continue
      const found = /(?:^|\n)(R13_[A-Z_]+)\b/.exec(part.text)
      if (found) return { key: found[1], text: part.text }
    }
  }
  throw new Error('Unexpected model request without an actual ordinary conversation fixture prompt.')
}
function resultFrom(options, predicate) {
  for (const message of [...options.messages].reverse()) {
    if (message.role !== 'tool') continue
    for (const part of [...message.content ?? []].reverse()) {
      if (part.type !== 'text') continue
      try { const value = JSON.parse(part.text); if (predicate(value)) return value } catch {}
    }
  }
  throw new Error('The actual model input did not contain the required successful tool output.')
}
const code = '# Synthetic conversation example, not research data.\nvalue = 6 * 7\nprint("R13_PYTHON_RESULT=" + str(value))\n'
const scenarios = {
  R13_PROJECT: { anchor: 'Insert project figure here.', assetPath: 'figures/synthetic.png', label: 'fig:conversation-project', caption: 'Existing project figure.' },
  R13_IMAGE: { anchor: 'Insert chat image here.', attachment: 'chat-image.png', label: 'fig:conversation-image', caption: 'Chat image figure.' },
  R13_FILE: { anchor: 'Insert exact file here.', attachment: 'original-figure.png', label: 'fig:conversation-file', caption: 'Exact original file figure.' },
  R13_REJECT: { anchor: 'Insert rejected image here.', attachment: 'rejected-figure.png', label: 'fig:conversation-rejected', caption: 'Rejected figure.' },
  R13_TABLE: { anchor: 'Insert supplied table here.', table: true },
}
class ScriptedAdapter extends LlmAdapter {
  stages = new Map()
  providerInfo(id) { return { id, name: 'MRW scripted protocol verification' } }
  async listModels(id) { return [{ provider: id, id: model, name: 'Scripted protocol verification', inputModalities: ['text', 'image'] }] }
  async resolveModel(id, name) { return { provider: id, id: name, name: 'Scripted protocol verification', contextWindow: 262144, inputModalities: ['text', 'image'] } }
  async *stream(options) {
    const request = requestFrom(options), identity = options.sessionId + ':' + request.key
    const step = this.stages.get(identity) ?? 0, names = (options.tools ?? []).map(tool => tool.name)
    record({ event: 'model/request', sessionId: options.sessionId, provider: options.provider, model: options.model,
      toolNames: names, request: request.key, step })
    const call = (name, args) => {
      if (!names.includes(name)) throw new Error(`Ordinary production tool is absent from the model catalog: ${name}`)
      this.stages.set(identity, step + 1)
      return toolResponse(request.key + '-' + step, name, args)
    }
    if (['R13_OPEN', 'R13_REOPEN', 'R13_MAIN_RETURN', 'R13_CHILD_OPEN', 'R13_CHILD_REOPEN'].includes(request.key)) {
      const target = request.key.startsWith('R13_CHILD_') ? 'parts/child.tex' : 'main.tex'
      if (step === 0) { yield* call('workbench_open_file', { path: target }); return }
      resultFrom(options, value => value.kind === 'workbench-open-file' && value.path === target)
      yield* textResponse(request.key + '_DONE: manuscript opened in this Session.'); return
    }
    if (request.key === 'R13_CODE' || request.key === 'R13_CODE_RETRY') {
      const resume = request.key === 'R13_CODE_RETRY'
      if (!resume && step === 0) { yield* call('write', { file_path: 'conversation_sample.py', content: code }); return }
      if (!resume && step === 1) { yield* call('workbench_open_file', { path: 'conversation_sample.py' }); return }
      if (!resume && step === 2) {
        resultFrom(options, value => value.kind === 'workbench-open-file' && value.path === 'conversation_sample.py')
        yield* call('pwsh', { description: 'Run the newly created synthetic Python example', command: "& '" + python.replaceAll("'", "''") + "' ./conversation_sample.py", timeoutMs: 30000 })
        return
      }
      const toolMessages = options.messages.filter(message => message.role === 'tool')
      const lastText = toolMessages.at(-1)?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
      if ((resume && step === 0) || (!resume && step === 3 && lastText.includes('SetNamedSecurityInfoW failed (Win32 5): grantWrite('))) {
        if (!aclPowerShell) throw new Error('Confined Python was blocked; scoped diagnostic requires an explicit --acl-powershell authorization: ' + lastText)
        yield* call('skill', { name: 'diagnose-windows-sandbox-acl' }); return
      }
      if (step === (resume ? 1 : 4)) {
        const base = /Base directory for this skill: ([^\r\n]+)/.exec(lastText)?.[1]
        if (!base || !lastText.includes('<skill_content name="diagnose-windows-sandbox-acl">')) {
          throw new Error('The actual available diagnostic skill was not loaded.')
        }
        const quote = value => "'" + value.replaceAll("'", "''") + "'"
        if (!aclPowerShell) throw new Error('A scoped diagnostic executable was not explicitly authorized.')
        const command = '& ' + quote(aclPowerShell) + ' -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File '
          + quote(path.join(base, 'scripts/diagnose-windows-sandbox-acl.ps1'))
          + ' -Path ' + quote(workspace) + ' -AllowRoot ' + quote(workspace)
          + ' -Out ' + quote(aclOutput) + '; exit $LASTEXITCODE'
        yield* call('pwsh', { description: '检查并修复本轮唯一合成测试目录的 Windows 文件权限', command,
          timeoutMs: 120000, sandbox_permissions: 'danger-full-access',
          justification: '仅为修复测试目录 ' + workspace + ' 的 Windows 文件权限，这条命令会在缺权限处添加当前登录用户的完全控制并清除冲突的软件包授权，文件内容和所有者保持不变，报告会列出逐项恢复命令。仅本次 PowerShell 进程允许运行已核对的本地脚本，不改变系统或用户的脚本策略。' })
        return
      }
      if (step === (resume ? 2 : 5)) {
        if (!lastText.includes('verify_original_confined_operation')) {
          throw new Error('The existing diagnostic skill did not verify a confined retry; stop without widening access.')
        }
        yield* call('pwsh', { description: '在原工作区权限下重新运行 Python 示例',
          command: "& '" + python.replaceAll("'", "''") + "' ./conversation_sample.py", timeoutMs: 30000 })
        return
      }
      if (!lastText.includes('R13_PYTHON_RESULT=42')) throw new Error('The real Python tool result did not contain its expected output.')
      yield* textResponse('R13_CODE_DONE: actual Python tool returned R13_PYTHON_RESULT=42.'); return
    }
    if (request.key === 'R13_NORMAL') { yield* textResponse('R13_NORMAL_DONE: ordinary conversation retained this Session and model.'); return }
    const scenario = scenarios[request.key]
    if (!scenario) throw new Error('Unknown ordinary conversation scenario: ' + request.key)
    if (step === 0) { yield* call('workbench_read_context', { query: scenario.anchor }); return }
    if (step === 1) {
      const context = resultFrom(options, value => value.path === 'main.tex' && Array.isArray(value.attachments))
      if (!context.text.includes(scenario.anchor)) throw new Error('The actual manuscript context lost the exact body marker.')
      const args = { kind: scenario.table ? 'table' : 'figure', anchor: scenario.anchor, placement: 'replace' }
      if (scenario.assetPath) args.assetPath = scenario.assetPath
      if (scenario.attachment) {
        const matches = context.attachments.filter(item => item.name === scenario.attachment)
        if (matches.length !== 1) throw new Error('The actual current Session must contain exactly one named attachment.')
        args.attachment = matches[0].id
      }
      yield* call('workbench_prepare_edit', args); return
    }
    if (step === 2) {
      const prepared = resultFrom(options, value => value.kind === 'workbench-conversation-prepared')
      if (prepared.request.instruction !== request.text) throw new Error('Prepared instruction must be the original ordinary user message.')
      if (names.some(name => !['subagent', 'workbench_propose_edit'].includes(name))) throw new Error('A prepared review turn retained a write capability.')
      const structured = scenario.table
        ? { kind: 'table', headers: ['Group', 'Value', 'Unit'], rows: [['A', '12', 'm'], ['B', '24', 's']], caption: 'Supplied synthetic values.', label: 'tab:conversation', alignment: ['l', 'c', 'r'] }
        : { kind: 'figure', assetPath: prepared.request.assetPaths?.[0], caption: scenario.caption, label: scenario.label }
      yield* call('workbench_propose_edit', { structured, explanation: 'Review the exact requested object before accepting and saving.' }); return
    }
    yield* textResponse(request.key + '_DONE: proposal is ready for human review; source has not been written.')
  }
}
export const name = 'mrw-scripted-ordinary-conversation-browser-fixture'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter([provider], new ScriptedAdapter())
  ctx.on('session/event', (session, event) => {
    if (['tool/call', 'tool/result', 'tool/ptc-dispatch', 'turn/end', 'agent/inbox/spliced'].includes(event.type)) {
      record({ event: 'session/event', sessionId: session.id, type: event.type, data: event.data })
    }
    if (event.type === 'user/message') record({ event: 'session/user', sessionId: session.id, source: event.data.source, content: event.data.content })
  })
  record({ event: 'provider/ready', provider, model, pid: process.pid })
}
