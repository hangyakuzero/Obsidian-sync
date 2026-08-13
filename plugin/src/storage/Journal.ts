import { SyncState } from "../state/SyncState";

export interface JournalEntry {
  operationId: string;
  revision: number;
  /** Every vault path the operation touched (new path, then old path for renames). */
  paths: string[];
}

const MAX_JOURNAL_ENTRIES = 500;

/**
 * Authority for "already applied" remote operations. The cursor can still be
 * behind the server (lost ACK, HTTP redelivery, reconnect mid-apply), so a
 * redelivered change must never be applied twice. Entries are capped and
 * ordered oldest→newest.
 */
export class Journal {
  constructor(private state: SyncState) {}

  proven(operationId: string): boolean {
    return this.state.journal.some((e) => e.operationId === operationId);
  }

  async record(entry: JournalEntry): Promise<void> {
    const journal = this.state.journal;
    const existing = journal.findIndex((e) => e.operationId === entry.operationId);
    if (existing >= 0) journal.splice(existing, 1);
    journal.push(entry);
    while (journal.length > MAX_JOURNAL_ENTRIES) journal.shift();
    await this.state.save({});
  }
}
