// Renders the app icon (build/icon.png, 512x512) from SVG using Electron itself: `npm run icon`.
import fs from "node:fs";
import { app, BrowserWindow } from "electron";

const SIZE = 512;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b67e0"/><stop offset="1" stop-color="#3b44b0"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <path d="M148 372 256 132l108 240" stroke="#fff" stroke-width="44" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M188 292h136" stroke="#fff" stroke-width="40" stroke-linecap="round"/>
  <circle cx="256" cy="372" r="22" fill="#fff" opacity=".9"/>
</svg>`;
const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.mkdirSync("build", { recursive: true });
  fs.writeFileSync("build/icon.png", img.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log("wrote build/icon.png");
  app.quit();
});
