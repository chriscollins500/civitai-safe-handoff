import type { BlockResourceInfo, BlockToParentMessage, ParentToBlockMessage } from '@civitai/app-sdk/blocks';
import { MAX_DEPENDENCIES, validateDependencies } from '../protocol/manifest.ts';
import type { Dependency } from '../protocol/manifest.ts';
import { catalogModelFiles } from './model-identities.ts';
import type { CatalogModelFile } from './model-identities.ts';
import { mountLivePickup } from './live-pickup.ts';

const sites = ['https://civitai.com', 'https://civitai.red'] as const;
type Site = typeof sites[number];
const checkpoint = document.querySelector<HTMLButtonElement>('#checkpoint')!;
const lora = document.querySelector<HTMLButtonElement>('#lora')!;
const copy = document.querySelector<HTMLButtonElement>('#copy')!;
const savePins = document.querySelector<HTMLButtonElement>('#save-pins')!;
const clear = document.querySelector<HTMLButtonElement>('#clear')!;
const list = document.querySelector<HTMLUListElement>('#picks')!;
const output = document.querySelector<HTMLTextAreaElement>('#manifest')!;
const feedback = document.querySelector<HTMLElement>('#status')!;
interface Selection {
  name: string;
  version: Dependency;
  files: Map<number, CatalogModelFile>;
  fileId?: number;
}
const selections = new Map<number, Selection>();
let origin: Site | undefined;
let pending: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function send(value: BlockToParentMessage, site = origin, transfer: Transferable[] = []) {
  if (site) window.parent.postMessage(value, site, transfer);
}

const live = mountLivePickup(document.querySelector<HTMLElement>('#live-pickup')!, (value, transfer) => send(value, origin, transfer));

function updatePins() {
  const dependencies = [...selections.values()].map(({ version, files, fileId }) => {
    const file = fileId === undefined ? undefined : files.get(fileId);
    return file ? { ...version, fileId: file.fileId, sha256: file.sha256, size: file.size } : version;
  });
  output.value = JSON.stringify({ version: 1, dependencies }, null, 2);
}

function render() {
  list.replaceChildren();
  for (const selection of selections.values()) {
    const { name, version, files, fileId } = selection;
    const item = document.createElement('li');
    const summary = `${name} · version ${version.versionId}`;
    if (files.size > 1) {
      const label = document.createElement('label');
      label.className = 'field';
      const select = document.createElement('select');
      select.setAttribute('aria-label', `File for ${name}, version ${version.versionId}`);
      select.append(new Option('Version only', ''));
      for (const file of files.values()) select.append(new Option(`${file.name} · file #${file.fileId}`, String(file.fileId)));
      select.value = fileId === undefined ? '' : String(fileId);
      select.onchange = () => {
        selection.fileId = select.value ? Number(select.value) : undefined;
        updatePins();
      };
      label.append(summary, select);
      item.append(label);
    } else {
      const file = fileId === undefined ? undefined : files.get(fileId);
      item.textContent = file ? `${summary} · ${file.name} · file #${file.fileId}` : `${summary} · version pin`;
    }
    list.append(item);
  }
  updatePins();
  copy.disabled = savePins.disabled = clear.disabled = !selections.size;
  checkpoint.disabled = lora.disabled = !origin || Boolean(pending);
}

function pick(resourceType: 'Checkpoint' | 'LORA') {
  if (!origin || pending) return;
  pending = crypto.randomUUID();
  render();
  feedback.textContent = 'Choose a resource in Civitai.';
  send({ type: 'OPEN_RESOURCE_PICKER', payload: {
    requestId: pending, resourceType, ...(resourceType === 'LORA' ? { multiple: { max: 5 } } : {}),
  } });
  timer = setTimeout(() => {
    pending = undefined;
    feedback.textContent = 'The Civitai picker did not respond. Try again.';
    render();
  }, 60000);
}

async function pin(resource: BlockResourceInfo, site: Site) {
  if (!resource || !Number.isSafeInteger(resource.versionId) || resource.versionId <= 0 || !Number.isSafeInteger(resource.modelId) || resource.modelId <= 0) {
    throw new Error('Civitai did not return a model and version.');
  }
  const response = await fetch(`${site}/api/v1/model-versions/${resource.versionId}`, {
    headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Version ${resource.versionId} could not be resolved on this Civitai domain.`);
  const details = await response.json();
  if (details.id !== resource.versionId || details.modelId !== resource.modelId) throw new Error('The public model identity did not match the picker.');
  const [version] = validateDependencies([{ air: details.air, modelId: details.modelId, versionId: details.id }]);
  const previous = selections.get(version.versionId);
  if (selections.size >= MAX_DEPENDENCIES && !previous) throw new Error(`Use up to ${MAX_DEPENDENCIES} dependencies.`);
  const files = catalogModelFiles(details.files);
  const fileId = files.size === 1 ? files.keys().next().value :
    previous?.fileId !== undefined && files.has(previous.fileId) ? previous.fileId : undefined;
  selections.set(version.versionId, {
    name: typeof resource.modelName === 'string' ? resource.modelName.slice(0, 160) : version.air, version, files, fileId,
  });
}

window.addEventListener('message', (event: MessageEvent<ParentToBlockMessage>) => {
  if (event.source !== window.parent || !sites.includes(event.origin as Site) || (origin && origin !== event.origin)) return;
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'BLOCK_INIT' && message.payload?.context?.slotId === 'app.page' && typeof message.payload.blockInstanceId === 'string') {
    origin = event.origin as Site;
    feedback.textContent = 'Ready to select resources.';
    render();
    live.hostReady(origin, message.payload.context);
    send({ type: 'BLOCK_READY', payload: { height: document.documentElement.scrollHeight } });
  } else if (message.type === 'SAVE_IMAGE_RESULT') {
    live.handleSave(message);
  } else if (message.type === 'SHARE_LINK_RESULT' && origin) {
    live.handleShare(message);
  } else if (message.type === 'ROUTE_CHANGED' && origin) {
    live.loadRouteHash(message.payload?.hash);
  } else if (message.type === 'RESOURCE_PICKER_RESULT' && origin && pending && pending === message.payload?.requestId) {
    clearTimeout(timer);
    const site = origin;
    const values = Array.isArray(message.payload.selectedResources) ? message.payload.selectedResources.slice(0, 5) :
      message.payload.selected ? [message.payload.selected] : [];
    const failed = message.payload.error;
    void (async () => {
      try {
        if (failed) throw new Error('The Civitai picker could not complete that request.');
        if (!values.length) feedback.textContent = 'Selection canceled.';
        else {
          feedback.textContent = 'Resolving exact model versions…';
          for (const item of values) await pin(item, site);
          feedback.textContent = 'Pins ready to copy.';
        }
      } catch (error) {
        feedback.textContent = error instanceof Error ? error.message : 'Could not resolve Civitai model versions.';
      } finally {
        pending = undefined;
        render();
      }
    })();
  }
});

checkpoint.onclick = () => pick('Checkpoint');
lora.onclick = () => pick('LORA');
clear.onclick = () => { selections.clear(); render(); feedback.textContent = 'Selection cleared.'; };
copy.onclick = () => { output.focus(); output.select(); feedback.textContent = 'Copy the selected pins with your browser’s copy command.'; };
savePins.onclick = () => {
  savePins.disabled = true;
  void live.saveFile('civitai-dependency-pins.json', new TextEncoder().encode(output.value).buffer).then(() => {
    feedback.textContent = 'Civitai started the JSON save.';
  }).catch((error: unknown) => {
    feedback.textContent = error instanceof Error ? error.message : 'Could not save the pins.';
  }).finally(() => { savePins.disabled = !selections.size; });
};
render();
if (window.parent !== window) for (const site of sites) send({ type: 'BLOCK_HELLO' }, site);
