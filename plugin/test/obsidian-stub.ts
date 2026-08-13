// Minimal runtime stub for the "obsidian" module, which ships types only.
// Test files exercise SyncClient/engine logic without an Obsidian host.
export const requestUrl = async (): Promise<never> => {
  throw new Error("obsidian.requestUrl is not available in tests");
};
export class Notice {
  constructor(_message: string, _timeout?: number) {}
}
export class Modal {
  app: unknown;
  constructor(app: unknown) {
    this.app = app;
  }
}
export class Setting {
  constructor(_container: unknown) {}
}
export class Plugin {
  app: unknown;
  loadData = async (): Promise<unknown> => undefined;
  saveData = async (_data: unknown): Promise<void> => undefined;
  registerEvent = (_event: unknown): void => undefined;
  addCommand = (_command: unknown): void => undefined;
  addSettingTab = (_tab: unknown): void => undefined;
  addStatusBarItem = (): HTMLElement => document.createElement("div");
}
export class TFile {}
export class PluginSettingTab {
  app: unknown;
  constructor(app: unknown) {
    this.app = app;
  }
}
export class App {
  vault: unknown;
}
