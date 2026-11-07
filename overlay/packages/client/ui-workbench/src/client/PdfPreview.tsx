/** Render the existing document-preview PDF engine through its public factory. */
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { PdfSnapshot, WorkbenchActions, WorkbenchSnapshot } from './types.ts'
import type { WorkbenchKey } from './locales.ts'

interface PdfPreviewProps extends PropsRenderFactories {
  pdf: PdfSnapshot
  target: WorkbenchSnapshot['pdfTarget']
  position: WorkbenchSnapshot['pdfPositions'][string] | undefined
  onPosition: WorkbenchActions['setPdfPosition']
  onSource: WorkbenchActions['locateSource']
  onSelection: WorkbenchActions['selectPdf']
  t: (key: WorkbenchKey) => string
}

export function PdfPreview({ pdf, target, position, onPosition, onSource, onSelection, t, renderFactorySlot }: PdfPreviewProps) {
  return renderFactorySlot('documentpreview.pdf', { data: pdf.data, version: pdf.version, target, position, onPosition, onSource, onSelection,
    labels: { loading: t('loading'), failed: t('pdfLoadFailed'), zoom: t('pdfZoom'), fitWidth: t('fitWidth'), page: t('page'), sourceHint: t('pdfToSource'), askSelection: t(/\.docx$/iu.test(pdf.sourcePath) ? 'assistSelection' : 'askSelection') },
  })
}
