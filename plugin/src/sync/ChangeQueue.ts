import type { Change } from "@syncvault/shared";
import { SyncState, QueuedChange } from "../state/SyncState";

export class ChangeQueue {
  constructor(private state: SyncState) {}

  get items(): QueuedChange[] {
    return this.state.pendingChanges;
  }

  has(operationId: string): boolean {
    return this.state.pendingChanges.some((c) => c.operationId === operationId);
  }

  hasPath(path: string): boolean {
    return this.state.pendingChanges.some(
      (c) => c.path === path || c.oldPath === path,
    );
  }

  /**
   * Coalesces pending changes for a path: a later write supersedes an earlier
   * pending write/delete for the same path; a rename supersedes pending ops on
   * either side of the move.
   */
  async enqueue(change: Change): Promise<void> {
    const pending = this.state.pendingChanges;
    const touched = new Set<string>([change.path]);
    if (change.oldPath) touched.add(change.oldPath);

    if (change.operation === "rename") {
      const priorCreate = pending.find(
        (c) => c.operation === "create" && c.path === change.oldPath,
      );
      if (priorCreate) {
        // A local create followed by a rename has no server-side old path.
        priorCreate.path = change.path;
        priorCreate.oldPath = undefined;
        await this.persist();
        return;
      }
      const priorRename = pending.find(
        (c) => c.operation === "rename" && c.path === change.oldPath,
      );
      if (priorRename) {
        priorRename.path = change.path;
        await this.persist();
        return;
      }
    }

    const preserveRename =
      change.operation !== "rename" &&
      pending.some((c) => c.operation === "rename" && c.path === change.path);
    for (const key of touched) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const c = pending[i];
        if (
          (c.path === key || c.oldPath === key) &&
          !(preserveRename && c.operation === "rename" && c.path === change.path)
        ) {
          pending.splice(i, 1);
        }
      }
    }
    const already = pending.some(
      (c) =>
        c.operation === change.operation &&
        c.path === change.path &&
        c.oldPath === change.oldPath &&
        c.payload === change.payload,
    );
    if (!already) {
      pending.push({ ...change, attempts: 0 });
    }
    await this.persist();
  }

  async remove(operationId: string): Promise<void> {
    const pending = this.state.pendingChanges;
    const index = pending.findIndex((c) => c.operationId === operationId);
    if (index >= 0) {
      pending.splice(index, 1);
      await this.persist();
    }
  }

  async clear(): Promise<void> {
    if (this.state.pendingChanges.length === 0) return;
    this.state.pendingChanges.splice(0, this.state.pendingChanges.length);
    await this.persist();
  }

  async markAttempted(operationId: string): Promise<void> {
    const item = this.state.pendingChanges.find((c) => c.operationId === operationId);
    if (item) {
      item.attempts += 1;
      await this.persist();
    }
  }

  get(operationId: string): QueuedChange | undefined {
    return this.state.pendingChanges.find((c) => c.operationId === operationId);
  }

  size(): number {
    return this.state.pendingChanges.length;
  }

  private async persist(): Promise<void> {
    await this.state.save({});
  }
}
