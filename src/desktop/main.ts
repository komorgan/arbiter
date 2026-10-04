// Electron main process: hosts the engine and the local API, and shows the UI in a locked-down window.
// The UI is the same web app `arbiter serve` uses; the desktop shell adds an OS-encrypted key store,
// native folder pickers, and a per-session API token.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, shell } from "electron";
import { arbiterHome, ensureHome, paths } from "../config.ts";
import { recoverInterrupted } from "../runner.ts";
import { installSecretBackend } from "../secrets.ts";
import { serve } from "../server.ts";
import { listEvaluations } from "../views.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Engine modules read this lazily, so setting it here (before any request) is enough.
process.env.ARBITER_RESOURCES ??= app.isPackaged ? process.resourcesPath : app.getAppPath();

const token = crypto.randomBytes(32).toString("hex");
let origin = "";
let win: BrowserWindow | null = null;

// ---------- logging: packaged apps have no console, so mirror output to a file ----------
function setupLogging(): void {
  const dir = path.join(arbiterHome(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.log");
  if (fs.existsSync(file) && fs.statSync(file).size > 5_000_000) fs.renameSync(file, `${file}.1`);
  const write = (level: string, args: unknown[]) =>
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try {
        write(level, args);
      } catch {
        // logging must never crash the app
      }
    };
  }
}

// ---------- API keys: encrypted with the OS (DPAPI on Windows, Keychain on macOS, libsecret on Linux) ----------
function installEncryptedSecrets(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("OS encryption unavailable; API keys can only come from environment variables");
    return;
  }
  const file = paths.secrets();
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  installSecretBackend({
    get(name) {
      const enc = read()[name];
      if (!enc) return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(enc, "base64"));
      } catch {
        console.warn(`could not decrypt stored key ${name}`);
        return undefined;
      }
    },
    set(name, value) {
      write({ ...read(), [name]: safeStorage.encryptString(value).toString("base64") });
    },
    delete(name) {
      const data = read();
      delete data[name];
      write(data);
    },
    names: () => Object.keys(read()),
  });
}

// ---------- IPC: only answer our own page ----------
function fromOurPage(frameUrl: string | undefined): boolean {
  return !!origin && !!frameUrl && frameUrl.startsWith(`${origin}/`);
}

function setupIpc(): void {
  ipcMain.on("arbiter:token", (e) => {
    e.returnValue = fromOurPage(e.senderFrame?.url) ? token : null;
  });
  ipcMain.handle("arbiter:pick-folder", async (e, title: unknown) => {
    if (!fromOurPage(e.senderFrame?.url) || !win) return null;
    const r = await dialog.showOpenDialog(win, { title: typeof title === "string" ? title : "Choose a folder", properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle("arbiter:open-managed", async (e, url: unknown) => {
    if (!fromOurPage(e.senderFrame?.url) || typeof url !== "string") return { ok: false, error: "not allowed" };
    return openManagedWindow(url);
  });
  ipcMain.handle("arbiter:open-path", async (e, p: unknown) => {
    if (!fromOurPage(e.senderFrame?.url) || typeof p !== "string") return false;
    // Only folders inside the data dir (runs, logs, tasks): never arbitrary paths from the page.
    const target = path.resolve(p);
    const home = arbiterHome();
    if (target !== home && !target.startsWith(home + path.sep)) return false;
    return (await shell.openPath(target)) === "";
  });
}

// ---------- Managed workspace window ----------

/**
 * Open a team's Arbiter server for reviewing, in a window built so review content doesn't stay with the annotator:
 * screen capture blocked, an in-memory session (no cookies, cache or storage on disk) wiped when the window closes,
 * no downloads, printing or devtools, and navigation pinned to that server. None of this stops a phone camera;
 * the point is that nothing is left behind by accident.
 */
function openManagedWindow(raw: string): { ok: boolean; error?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "That isn't a valid address" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { ok: false, error: "Workspaces must use https:// (plain http is only allowed for localhost testing)" };
  }
  const origin = u.origin;
  // No "persist:" prefix = the partition lives in memory only.
  const partition = `managed-${crypto.randomBytes(8).toString("hex")}`;
  const ses = session.fromPartition(partition, { cache: false });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.on("will-download", (ev) => ev.preventDefault());
  // Tell the server this is the protected desktop window, for projects that require it. Only sent to this
  // workspace's server, never to other sites.
  ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, "X-Arbiter-Client": `desktop/${app.getVersion()}` } });
  });

  const w = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: `Arbiter Review · ${u.host}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151514" : "#f7f7f5",
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged },
  });
  w.setContentProtection(true); // blank in screenshots, screen recordings and screen shares (Windows, macOS)
  w.setMenu(null);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(`${origin}/`)) e.preventDefault();
  });
  w.webContents.on("before-input-event", (e, input) => {
    const k = input.key.toLowerCase();
    if ((input.control || input.meta) && (k === "p" || k === "s")) e.preventDefault(); // print, save page
  });
  w.webContents.on("page-title-updated", (e) => e.preventDefault());
  w.on("closed", () => {
    void ses.clearStorageData();
    void ses.clearCache();
  });
  void w.loadURL(`${origin}/annotate`);
  return { ok: true };
}

// ---------- window ----------
function createWindow(port: number): void {
  origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Arbiter",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151514" : "#f7f7f5",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win?.show());

  // Links to anywhere else open in the user's browser; the app window never leaves our origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${origin}/`)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    const running = listEvaluations().filter((ev) => ev.status === "running");
    if (running.length === 0) return;
    const choice = dialog.showMessageBoxSync(win!, {
      type: "warning",
      buttons: ["Keep running", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Evaluations are running",
      message: `${running.length} evaluation${running.length === 1 ? " is" : "s are"} still running.`,
      detail: "Quitting stops them. Unfinished runs are marked as interrupted the next time Arbiter starts.",
    });
    if (choice === 0) e.preventDefault();
  });

  void win.loadURL(`${origin}/`);
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "Open data folder", click: () => void shell.openPath(arbiterHome()) },
        { label: "Open log file", click: () => void shell.openPath(path.join(arbiterHome(), "logs", "app.log")) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as const]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- startup ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      ensureHome();
      setupLogging();
      console.log(`Arbiter ${app.getVersion()} starting; data dir ${arbiterHome()}`);
      installEncryptedSecrets();
      setupIpc();
      buildMenu();
      // The UI needs no camera, mic, notifications, etc.
      session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

      const { port } = await serve({ port: 0, token, appInfo: { version: app.getVersion(), desktop: true } });
      createWindow(port);
      // Finish anything a previous session left half-done, in the background.
      recoverInterrupted((m) => console.log(m)).catch((err) => console.error("recovery failed", err));
    } catch (err) {
      console.error(err);
      dialog.showErrorBox("Arbiter could not start", err instanceof Error ? err.message : String(err));
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
}
