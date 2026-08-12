import type { AccountDO } from "./durable-objects/AccountDO";
import type { VaultSyncDO } from "./durable-objects/VaultSyncDO";

export interface Env {
  ACCOUNT_DO: DurableObjectNamespace<AccountDO>;
  VAULT_DO: DurableObjectNamespace<VaultSyncDO>;
}