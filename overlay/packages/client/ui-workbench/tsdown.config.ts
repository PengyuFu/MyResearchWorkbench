import { clientBundle } from '../tsdown.client.ts'

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'])

/** Keep the DOCX runtime and its optional image decoders inside this plugin factory. */
export default (config: Parameters<typeof bundle>[0]) => bundle(config).map(item =>
  item.name === '@deepseek-ai/dsh-client-ui-workbench/client'
    ? { ...item,
        // fflate exposes a dedicated browser entry; keep its Node worker loader out of the factory.
        alias: { ...item.alias, fflate: 'fflate/browser' },
        outputOptions: { ...item.outputOptions, codeSplitting: false } }
    : item)
