/** Stage local-branded DSH packages for unsigned Desktop builds without a publication record. */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../scripts/release/pack.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { runConcurrent } from '../../../scripts/release/process.ts'

const LOCAL_WORKBENCH_PACKAGES = [
  'packages/client/ui-personal-plan',
  'packages/plan/personal-plan',
  'packages/context/workbench-assistant',
] as const

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.out === undefined) throw new Error('desktop local pack: --out must name the package staging directory')
  const concurrency = parsePackConcurrency(values.concurrency)
  const root = process.cwd()
  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), 'local')
  readClientBuildRecord(root, environment)
  const destination = resolve(root, values.out)
  const packed = await packFamilyMembers(root, releaseFamily('dsh'), destination, concurrency)
  for (const directory of LOCAL_WORKBENCH_PACKAGES) {
    const invocation = pnpmInvocation(['--dir', resolve(root, directory), 'pack', '--pack-destination', destination])
    await runConcurrent(invocation.command, invocation.args)
  }
  console.log(`desktop local pack: ${String(packed.length + LOCAL_WORKBENCH_PACKAGES.length)} tarball(s) in ${destination}`)
}

await main()
