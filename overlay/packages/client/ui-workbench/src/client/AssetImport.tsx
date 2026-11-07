/** Visible recovery records for manuscript and figure-source transactions. */
import type { WorkbenchSnapshot } from './types.ts'
import type { WorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

type Translate = (key: WorkbenchKey) => string

export function AssetRecoveryDetails({ history, t }: { history: WorkbenchSnapshot['assetRecovery']; t: Translate }) {
  if (history === null) return null
  const phaseLabel = (phase: string) => {
    if (phase === 'document-committed') return t('assetCommitted')
    if (phase === 'rolled-back') return t('assetRolledBack')
    return t('assetNeedsReview')
  }
  return <details className={css.assetRecovery} open={history.activeLock !== undefined || history.issues.length > 0
    || history.records.some(record => record.phase === 'needs-recovery')}>
    <summary>{t('assetWriteHistory')}</summary>
    {history.activeLock !== undefined && <p role="alert">{t('assetLockPresent')}<code>{history.activeLock}</code></p>}
    {history.records.length === 0 && <p className={css.hint}>{t('assetHistoryEmpty')}</p>}
    {history.records.slice(0, 12).map(record => <details key={record.transactionId}>
      <summary>{record.sourcePath} · {phaseLabel(record.phase)} · {record.createdAt}</summary>
      <ul>{record.assets.map(asset => <li key={asset.path}><code>{asset.path}</code> · {asset.status}</li>)}</ul>
      {record.residualPaths.length > 0 && <p>{t('assetRetained')} {record.residualPaths.join(', ')}</p>}
    </details>)}
    {history.issues.map((issue, index) => <p key={index} role="alert">{issue}</p>)}
    {(history.truncated || history.records.length > 12) && <p className={css.hint}>{t('assetHistoryBounded')}</p>}
  </details>
}
