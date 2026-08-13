import type { Change } from "@syncvault/shared";
import { SyncState, QueuedChange } from "../state/SyncState";

function sameChange(a: QueuedChange, b: Change): boolean {
  if (a.operation !== b.operation) return false;
  if (a.path !== b.path || (a.oldPath ?? undefined) !== (b.oldPath ?? undefined)) return false;
  if (a.content && b.content) {
    return (
      a.content.hash === b.content.hash &&
      a.content.byteLength === b.content.byteLength &&
      a.content.chunkCount === b.content.chunkCount
    );
  }
  if (!a.content && !b.content) return a.payload === b.payload;
  return false;
}

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
   * Ordered reducer: enqueueing a change for a path supersedes earlier
   * pending ops touching that path (except in-flight ones, which keep their
   * place in the causal chain) and records the surviving pending ops as
   * causal parents. Superseded ops are never committed, so their ids must
   * not appear in the parent set.
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

    const superseded: QueuedChange[] = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i];
      const touchesPath =
        touched.has(c.path) || (c.oldPath !== undefined && touched.has(c.oldPath));
      const preserved =
        preserveRename && c.operation === "rename" && c.path === change.path;
      if (touchesPath && !preserved && c.inFlight !== true) {
        superseded.push(c);
        pending.splice(i, 1);
      }
    }

    // Last surviving pending op touching each affected path becomes a causal
    // parent; superseded ops contribute their own parents transitively.
    const parents = new Set<string>();
    for (const c of pending) {
      for (const key of touched) {
        if (c.path === key || c.oldPath === key) parents.add(c.operationId);
      }
    }
    for (const c of superseded) {
      for (const p of c.causalParents ?? []) parents.add(p);
    }
    parents.delete(change.operationId);

    const already = pending.some((c) => sameChange(c, change));
    if (!already) {
      pending.push({ ...change, attempts: 0, causalParents: [...parents], inFlight: false });
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

  /**
   * Removes an op that was never committed (permanently rejected) and scrubs
   * its id from the causal parents of survivors.
   */
  async removeDropped(operationId: string): Promise<void> {
    const pending = this.state.pendingChanges;
    const index = pending.findIndex((c) => c.operationId === operationId);
    if (index >= 0) pending.splice(index, 1);
    let changed = index >= 0;
    for (const c of pending) {
      if (c.causalParents?.includes(operationId)) {
        c.causalParents = c.causalParents.filter((p) => p !== operationId);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async refreshContent(
    operationId: string,
    content: Change["content"],
  ): Promise<void> {
    const item = this.state.pendingChanges.find((c) => c.operationId === operationId);
    if (item) {
      item.content = content;
      item.payload = undefined;
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
