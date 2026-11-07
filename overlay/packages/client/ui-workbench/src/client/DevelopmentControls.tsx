/** Language identity and real run artifacts beside the resident source editor. */
import { useEffect, useState } from 'react'
import { Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JobSnapshot, WorkbenchActions } from './types.ts'
import type { WorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

export type DevelopmentLanguage = 'python' | 'cpp' | 'cuda' | 'matlab' | 'text'
export function developmentLanguage(path: string): DevelopmentLanguage {
  if (/\.(py|pyw|pyi)$/iu.test(path)) return 'python'
  if (/\.(cu|cuh)$/iu.test(path)) return 'cuda'
  if (/\.(c|cpp|cc|cxx|h|hpp)$/iu.test(path)) return 'cpp'
  if (/\.m$/iu.test(path)) return 'matlab'
  return 'text'
}
/** The editor's language can be changed without adding run controls to the writing surface. */
export function DevelopmentLanguageControl({ language, onLanguage, t }: {
  language: DevelopmentLanguage
  onLanguage(value: DevelopmentLanguage): void
  t(key: WorkbenchKey): string
}) {
  const [open, setOpen] = useState(false)
  const labels = {
    python: t('languagePython'), cpp: t('languageCpp'), cuda: t('languageCuda'), matlab: t('languageMatlab'), text: t('plainText'),
  }
  return <div className={css.languageControl} data-development-language={language}>
    <Menu open={open} onClose={() => setOpen(false)} selectedId={language} align="start" portal
      items={(['python', 'cpp', 'cuda', 'matlab', 'text'] as const).map(value => ({ id: value, label: labels[value] }))}
      onSelect={(value) => {
        if (value === 'python' || value === 'cpp' || value === 'cuda' || value === 'matlab' || value === 'text') onLanguage(value)
        setOpen(false)
      }} anchor={<button type="button" className={css.modeButton} aria-label={t('language')}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{labels[language]}</span>
        <IconChevronDownOutlineRegular className={css.modeChevron} />
      </button>} />
  </div>
}

/** Show only files associated by the Host with this finished job. */
export function RunArtifacts({ job, resolveAsset, open, t }: {
  job: JobSnapshot
  resolveAsset: WorkbenchActions['resolveAsset']
  open: WorkbenchActions['open']
  t(key: WorkbenchKey): string
}) {
  const [images, setImages] = useState<Record<string, { url: string; mimeType: string }>>({})
  useEffect(() => {
    let active = true
    setImages({})
    for (const artifact of job.artifacts ?? []) void resolveAsset(artifact.path, '.mrw-result', []).then((value) => {
      if (active) setImages(previous => ({ ...previous, [artifact.path]: value }))
    }).catch(() => { /* The file remains available through the standard preview action. */ })
    return () => { active = false }
  }, [job.id, job.artifacts, resolveAsset])
  if (job.kind === 'latex' || job.state === 'running') return null
  return <section className={css.runResults} aria-label={t('runResults')}>
    <strong>{t('runResults')}</strong>
    {(job.artifacts?.length ?? 0) === 0 ? <p className={css.hint}>{t('noRunResults')}</p> : <div className={css.resultGrid}>
      {job.artifacts?.map((artifact) => {
        const image = images[artifact.path]
        return <button key={artifact.path} type="button" className={css.resultCard} onClick={() => { void open(artifact.path) }}>
          {image?.mimeType.startsWith('image/') && <img src={image.url} alt={artifact.path} />}
          <span>{artifact.path}</span>
        </button>
      })}
    </div>}
  </section>
}
