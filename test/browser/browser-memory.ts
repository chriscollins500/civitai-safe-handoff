import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser } from 'playwright';

export type BrowserMemory = { workingSetBytes: number; privateBytes: number; processes: number };

export async function chromiumProcessId(browser: Browser) {
  const connection = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await connection.send('SystemInfo.getProcessInfo');
    return processInfo.find(({ type }) => type === 'browser')?.id;
  } finally {
    await connection.detach();
  }
}

export async function sampleProcessTree(processId: number): Promise<BrowserMemory> {
  const { stdout } = await promisify(execFile)('pwsh', ['-NoLogo', '-NoProfile', '-File', 'benchmarks/windows-browser-memory.ps1',
    '-RootProcessId', String(processId)], { windowsHide: true, timeout: 8000 });
  return JSON.parse(stdout);
}
