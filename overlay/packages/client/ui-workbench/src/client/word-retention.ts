/** Serialized maintenance fed only by complete, committed scene snapshots. */
import type { WordRetention, WordRetentionResult } from '@deepseek-ai/dsh-workbench-word/types'
import type { WorkbenchRecord } from './buffer-persistence.ts'

export class WordSceneRetention {
  private pending: readonly WorkbenchRecord[] | undefined
  private flight: Promise<void> | undefined
  private sequence = -1
  constructor(
    private readonly retain: (sessionId: string, references: WordRetention) => Promise<WordRetentionResult>,
    private readonly report: (error: unknown) => void,
  ) {}

  /** No network/COM wait is allowed to hold the durable scene writer. */
  committed(records: readonly WorkbenchRecord[], sequence: number): void {
    if (sequence <= this.sequence) return
    this.sequence = sequence
    this.pending = records
    this.start()
  }

  private start(): void {
    if (this.flight !== undefined) return
    const flight = this.drain().finally(() => {
      if (this.flight === flight) this.flight = undefined
      if (this.pending !== undefined) this.start()
    })
    this.flight = flight
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const records = this.pending
      this.pending = undefined
      for (const record of records) {
        // Legacy scenes did not publish exact proof references: read them, never infer an empty retain set.
        if (record.version !== 2) continue
        const documents: WordRetention['documents'] = []
        for (const buffer of record.buffers) {
          if (buffer.word === undefined) continue
          const { snapshot, proof } = buffer.word
          documents.push({ id: snapshot.id,
            checkpoints: [{ id: snapshot.id, checkpoint: snapshot.checkpoint,
              checkpointHash: snapshot.checkpointHash, revision: snapshot.revision }],
            proofs: proof === undefined ? [] : [proof] })
        }
        try {
          const result = await this.retain(record.sessionId, { workspaceRoot: record.workspaceRoot, documents })
          if (result.failures.length > 0) this.report(new Error('Word storage retained uncertain records: ' + result.failures.length))
        } catch (error) { this.report(error) }
      }
    }
  }
}
