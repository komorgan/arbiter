// Runs in the sandboxed renderer before the page. Exposes a tiny, fixed API; no Node access reaches the page.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("arbiterDesktop", {
  token: ipcRenderer.sendSync("arbiter:token") as string | null,
  pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke("arbiter:pick-folder", title),
  openPath: (p: string): Promise<boolean> => ipcRenderer.invoke("arbiter:open-path", p),
  openManaged: (url: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("arbiter:open-managed", url),
});
