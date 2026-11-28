import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('built Civitai composer pins exact files on the .com and .red host contracts', { timeout: 30000 }, async (context) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const browser = await chromium.launch(process.env.SAFE_CIVITAI_LIVE_BROWSER === 'chromium' ? {} : { channel: 'chrome' });
  context.after(() => browser.close());
  const child = 'https://safe-composer-fixture.civit.ai/';
  const parent = `<!doctype html><meta charset="utf-8"><iframe title="Civitai composer" sandbox="allow-scripts" src="${child}"></iframe>
    <script>
      window.sent = [];
      const frame = document.querySelector('iframe');
      window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow) return;
        window.sent.push(event.data);
        if (event.data.type === 'BLOCK_HELLO') frame.contentWindow.postMessage({type: 'BLOCK_INIT', payload: {
          blockInstanceId: 'fixture-instance', context: {slotId: 'app.page'}, token: {raw: 'FIXTURE_HOST_TOKEN'}
        }}, '*');
        if (event.data.type === 'OPEN_RESOURCE_PICKER') frame.contentWindow.postMessage({type: 'RESOURCE_PICKER_RESULT', payload: {
          requestId: event.data.payload.requestId, selectedResources: event.data.payload.resourceType === 'LORA'
            ? [{modelId: 11, versionId: 22, modelName: 'Fixture LoRA'}]
            : [{modelId: 12, versionId: 23, modelName: 'Fixture checkpoint'}]
        }}, '*');
      });
    </script>`;

  for (const site of ['https://civitai.com', 'https://civitai.red']) {
    const instance = await browser.newContext();
    const page = await instance.newPage();
    await instance.route(`${site}/`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: parent }));
    await instance.route(child, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: block }));
    const seen: string[] = [];
    const lora = { air: 'urn:air:sdxl:lora:civitai:11@22', modelId: 11, versionId: 22 };
    const checkpoint = { air: 'urn:air:sdxl:checkpoint:civitai:12@23', modelId: 12, versionId: 23 };
    await instance.route(`${site}/api/v1/model-versions/*`, (route) => {
      const request = route.request();
      seen.push(request.url());
      assert.equal(request.headers()['authorization'], undefined);
      assert.equal(request.headers()['cookie'], undefined);
      const json = request.url().endsWith('/22') ? { id: 22, modelId: 11, air: lora.air, files: [
        { id: 101, name: 'fixture.safetensors', sizeKB: 31.4, hashes: { SHA256: 'A'.repeat(64) } },
        { id: 102, name: 'fixture.safetensors', sizeKB: 16.125, hashes: { SHA256: 'B'.repeat(64) } },
      ] } : { id: 23, modelId: 12, air: checkpoint.air, files: [
        { id: 103, name: 'checkpoint.safetensors', sizeKB: 64, hashes: { SHA256: 'C'.repeat(64) } },
      ] };
      return route.fulfill({ json, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.goto(site);
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: 'Choose LoRAs' }).click();
    await frame.getByText('Pins ready to copy.').waitFor();
    const pins = async () => JSON.parse(await frame.getByLabel('Dependency pins').inputValue()).dependencies;
    assert.deepEqual(await pins(), [lora]);
    const file = frame.getByRole('combobox', { name: 'File for Fixture LoRA, version 22' });
    await file.selectOption({ label: 'fixture.safetensors · file #101' });
    assert.deepEqual(await pins(), [{ ...lora, fileId: 101, sha256: 'a'.repeat(64) }]);
    await file.selectOption({ label: 'fixture.safetensors · file #102' });
    await frame.getByRole('button', { name: 'Choose checkpoint' }).click();
    await frame.getByText('Pins ready to copy.').waitFor();
    assert.deepEqual(await pins(), [
      { ...lora, fileId: 102, sha256: 'b'.repeat(64), size: 16512 },
      { ...checkpoint, fileId: 103, sha256: 'c'.repeat(64), size: 65536 },
    ]);
    assert.deepEqual(seen, [`${site}/api/v1/model-versions/22`, `${site}/api/v1/model-versions/23`]);
    const outbound = await page.evaluate(() => JSON.stringify((window as Window & { sent?: unknown[] }).sent));
    assert.match(outbound, /BLOCK_READY/);
    assert.doesNotMatch(outbound, /FIXTURE_HOST_TOKEN/);
    await instance.close();
  }
});
