/** Resolve images already admitted by the current Harness Session; never copy them into a project. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkbenchAttachmentAsset, WorkbenchAttachmentValue } from './types.ts'

export type ConversationAttachment = { readonly kind: 'image'; readonly ref: ImageAttachmentRef }
  | { readonly kind: 'file'; readonly ref: FileAttachmentRef }

const MAX_ASSET_BYTES = 16 * 1024 * 1024

/** Read recent distinct user attachments; a captured review can request its complete Session history. */
export function conversationAttachments(events: readonly SessionEvent[], limit = 8): ConversationAttachment[] {
  const found = new Map<string, ConversationAttachment>()
  for (let index = events.length - 1; index >= 0 && found.size < limit; index--) {
    const event = events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    for (const block of event.data.content) {
      if (block.type !== 'image' && block.type !== 'file') continue
      if (found.has(block.attachment.attachmentId)) continue
      found.set(block.attachment.attachmentId, block.type === 'image'
        ? { kind: 'image', ref: block.attachment } : { kind: 'file', ref: block.attachment })
      if (found.size === limit) break
    }
  }
  return [...found.values()]
}

/** A display name is usable only when it identifies exactly one actual Session attachment. */
export function findConversationAttachment(attachments: readonly ConversationAttachment[], name: string): ConversationAttachment {
  const matches = attachments.filter(item => item.ref.attachmentId === name || item.ref.name === name)
  const match = matches[0]
  if (match === undefined || matches.length !== 1) throw new Error(matches.length === 0
    ? 'No recent attachment in this Session has that name or id. Attach the image in this conversation or use its project path.'
    : 'Several conversation attachments have that name. Use the exact attachment id returned by workbench_read_context.')
  return match
}

/** Read verified durable bytes using the existing attachment provider and the figure import limits. */
export async function readConversationAttachment(
  ctx: Context, attachment: ConversationAttachment, signal: AbortSignal,
): Promise<WorkbenchAttachmentValue & { readonly asset: WorkbenchAttachmentAsset }> {
  const store = ctx.get('attachments')
  if (store === undefined) throw new Error('The current Harness has no attachment provider.')
  if (attachment.ref.bytes <= 0 || attachment.ref.bytes > MAX_ASSET_BYTES) throw new Error('Figure attachments must be at most 16 MiB.')
  let data: Uint8Array
  if (attachment.kind === 'image') data = (await store.readImage(attachment.ref, signal)).data
  else {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of store.readFileStream(attachment.ref, signal)) {
      size += chunk.byteLength
      if (size > MAX_ASSET_BYTES) throw new Error('Figure attachments must be at most 16 MiB.')
      chunks.push(chunk)
    }
    data = Buffer.concat(chunks)
  }
  signal.throwIfAborted()
  if (data.byteLength <= 0 || data.byteLength > MAX_ASSET_BYTES) throw new Error('Figure attachments must be at most 16 MiB.')
  const starts = (signature: number[]) => signature.every((value, index) => data[index] === value)
  const png = starts([137, 80, 78, 71, 13, 10, 26, 10])
  const jpeg = starts([255, 216, 255])
  const pdf = new TextDecoder('ascii').decode(data.subarray(0, 5)) === '%PDF-'
  if (!png && !jpeg && !pdf) throw new Error('Use a PNG, JPEG or PDF attachment for LaTeX figures. This attachment was not converted.')
  const extension = png ? 'png' : jpeg ? 'jpg' : 'pdf'
  const mimeType = png ? 'image/png' : jpeg ? 'image/jpeg' : 'application/pdf'
  const sha256 = createHash('sha256').update(data).digest('hex')
  const name = `attachment.${extension}`
  // The fixed name uses the existing browser staging path algorithm without copying its filename sanitizer.
  const path = `figures/workbench/attachment-${sha256.slice(0, 8)}.${extension}`
  const asset: WorkbenchAttachmentAsset = { attachmentId: attachment.ref.attachmentId, kind: attachment.kind, name, mimeType, path, sha256 }
  return { name, mimeType, path, sha256, data, asset }
}
