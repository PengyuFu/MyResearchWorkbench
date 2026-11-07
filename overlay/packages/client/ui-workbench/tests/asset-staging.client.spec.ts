/** Byte/format/path boundaries independent of a browser's IndexedDB implementation. */
import { describe, expect, it } from 'vitest'
import { STAGED_ASSET_LIMITS, createStagedAssetPreview, inspectAssetBytes, stagedAssetPath, stagedAssetPayload } from '../src/client/asset-staging.ts'

const sha = '0123456789abcdef'.repeat(4)

describe('figure asset staging boundaries', () => {
  it('checks both declared type and file signature and keeps EPS preview explicitly unavailable', () => {
    expect(inspectAssetBytes('已有图.pdf', '', new TextEncoder().encode('%PDF-1.4\n'))).toEqual({ extension: 'pdf', mime: 'application/pdf', previewKind: 'pdf' })
    expect(inspectAssetBytes('figure.eps', 'application/postscript', new TextEncoder().encode('%!PS-Adobe-3.0 EPSF-3.0\n')).previewKind).toBe('unavailable')
    expect(() => inspectAssetBytes('x.png', 'application/pdf', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toThrow('MIME_MISMATCH')
    expect(() => inspectAssetBytes('x.pdf', 'application/pdf', new TextEncoder().encode('not a PDF'))).toThrow('SIGNATURE_MISMATCH')
    expect(() => inspectAssetBytes('x.svg', 'image/svg+xml', new TextEncoder().encode('<svg/>'))).toThrow('FILE_TYPE')
    expect(() => inspectAssetBytes('x.pdf', '', new Uint8Array(STAGED_ASSET_LIMITS.fileBytes + 1))).toThrow('SIZE')
  })

  it('generates a bounded LaTeX-safe destination without taking directories from the supplied filename', () => {
    expect(stagedAssetPath('../../My Figure (draft).PDF', sha)).toBe('figures/workbench/My-Figure-draft-01234567.pdf')
    expect(stagedAssetPath('C:\\papers\\测试图.pdf', sha)).toBe('figures/workbench/asset-01234567.pdf')
    expect(stagedAssetPath('a'.repeat(100) + '.png', sha).split('/').at(-1)!.length).toBe(77)
  })

  it('does not create a misleading preview for a staged EPS file', () => {
    const preview = createStagedAssetPreview({ id: sha, name: 'x.eps', path: stagedAssetPath('x.eps', sha), mime: 'application/postscript', sha256: sha,
      size: 20, createdAt: 0, blob: new Blob(['%!PS-Adobe EPSF-3.0']), previewKind: 'unavailable' })
    expect(preview.kind).toBe('unavailable')
    expect(preview.url).toBeUndefined()
    preview.dispose()
  })

  it('rejects changed staging bytes at the wire boundary', async () => {
    const blob = new Blob(['%PDF-1.4\n'], { type: 'application/pdf' })
    await expect(stagedAssetPayload({ id: sha, name: 'x.pdf', path: stagedAssetPath('x.pdf', sha), mime: 'application/pdf', sha256: sha,
      size: blob.size, createdAt: 0, blob, previewKind: 'pdf' })).rejects.toThrow('ASSET_STAGING_CORRUPT')
  })
})
