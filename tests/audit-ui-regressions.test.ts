import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, reactive } from 'vue';

type Node = { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node };
const makeNode = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({
  createElement: type => makeNode(type),
  createText: text => makeNode('#text', text),
  createComment: text => makeNode('#comment', text),
  setText: (n, text) => { n.text = text; },
  setElementText: (n, text) => { n.text = text; n.children = []; },
  patchProp: (n, key, _previous, value) => { n.props[key] = value; },
  insert: (child, parent, anchor) => {
    child.parent = parent;
    const i = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
  },
  remove: child => {
    const i = child.parent?.children.indexOf(child) ?? -1;
    if (i >= 0) child.parent!.children.splice(i, 1);
  },
  parentNode: n => n.parent || null,
  nextSibling: n => n.parent?.children[(n.parent?.children.indexOf(n) ?? -1) + 1] || null,
});

const moduleUrl = (source: string) =>
  'data:text/javascript;base64,' + Buffer.from(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText,
  ).toString('base64');

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };

function globals(values: Record<string, unknown>) {
  const saved = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function eventHub() {
  const listeners = new Map<string, Set<Function>>();
  return {
    addEventListener(name: string, fn: Function) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    removeEventListener(name: string, fn: Function) { listeners.get(name)?.delete(fn); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

let seq = 0;

test('#57 MarkdownPanel detects oversized transition from empty text and clears error back to empty', async () => {
  const fakeElement = () => ({
    id: '',
    textContent: '',
    innerHTML: '',
    scrollHeight: 120,
    children: [] as unknown[],
    append(...items: unknown[]) { this.children.push(...items); },
  });
  const shadow = { children: [] as unknown[], replaceChildren() { this.children = []; }, append(...items: unknown[]) { this.children.push(...items); } };
  const hostEl = { shadowRoot: shadow, attachShadow: () => shadow };
  let resolveExport!: (value: boolean) => void;
  const restore = globals({
    document: { createElement: () => fakeElement() },
    __mdMock: {
      api: { saveExport: () => new Promise<boolean>(resolve => { resolveExport = resolve; }) },
      toPng: async () => 'data:image/png;base64,AA==',
    },
  });
  const mockUrl = moduleUrl(`export const { api, toPng } = globalThis.__mdMock; // ${seq++}`);
  const rawUrl = moduleUrl(`export default ''; // ${seq++}`);
  const { descriptor } = parse(fs.readFileSync(new URL('../src/components/MarkdownPanel.vue', import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'md-panel-test' }).content
    .replace(/from (['"])vue\1/g, `from '${import.meta.resolve('vue')}'`)
    .replaceAll("'html-to-image'", `'${mockUrl}'`)
    .replaceAll("'../api'", `'${mockUrl}'`)
    .replaceAll("'../snippets'", `'${new URL('../src/snippets.ts', import.meta.url).href}'`)
    .replaceAll("'../i18n'", `'${new URL('../src/i18n/index.ts', import.meta.url).href}'`)
    .replaceAll("'../markdown-render'", `'${new URL('../src/markdown-render.ts', import.meta.url).href}'`)
    .replace(/['"]\.\.\/markdown-themes\/[^'"]+\?raw['"]/g, `'${rawUrl}'`);
  const component = (await import(moduleUrl(script))).default;
  const props = reactive({ text: '', title: '' });
  const busyEvents: boolean[] = [];
  let vm!: Record<string, any>;
  const Wrapper = {
    setup() {
      return () => h(component, {
        ...props,
        onBusy: (v: boolean) => busyEvents.push(v),
        ref: (inst: any) => { if (inst) vm = inst.$?.setupState ?? inst; },
      });
    },
  };
  const app = renderer.createApp({ render: () => h(Wrapper) });
  // Attach render stub so component setup executes cleanly.
  component.render = () => null;
  try {
    app.mount(makeNode('root'));
    await flush();
    vm.host = hostEl;
    vm.refresh();
    assert.equal(vm.error, '');

    props.text = 'x'.repeat(30001);
    await flush();
    assert.ok(vm.error.length > 0, 'empty -> oversized must trigger error immediately');

    props.text = '';
    await flush();
    assert.equal(vm.error, '', 'oversized -> empty must clear error instead of leaving it stuck');

    props.text = '# Hello';
    await flush();
    const exporting = vm.exportImage();
    await flush();
    assert.equal(busyEvents.at(-1), true);
    app.unmount();
    assert.equal(busyEvents.at(-1), false, 'unmount during busy export must emit busy(false)');
    resolveExport(true);
    await exporting;
  } finally {
    restore();
  }
});

test('#61 UiSelect rapid open-close before nextTick does not leak listeners or observers', async () => {
  const winEvents = eventHub(), docEvents = eventHub();
  let activeMutationObservers = 0, activeResizeObservers = 0;
  class FakeMutationObserver {
    observe() { activeMutationObservers++; }
    disconnect() { activeMutationObservers--; }
  }
  class FakeResizeObserver {
    observe() { activeResizeObservers++; }
    disconnect() { activeResizeObservers--; }
  }
  const restore = globals({
    window: { ...winEvents, innerWidth: 1200, innerHeight: 800 },
    document: { ...docEvents, documentElement: {} },
    HTMLElement: class { showPopover() {} hidePopover() {} },
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
  });
  const { descriptor } = parse(fs.readFileSync(new URL('../src/components/UiSelect.vue', import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'ui-select-test' }).content
    .replace(/from (['"])vue\1/g, `from '${import.meta.resolve('vue')}'`)
    .replaceAll("'../i18n'", `'${new URL('../src/i18n/index.ts', import.meta.url).href}'`);
  const component = (await import(moduleUrl(script))).default;
  component.render = () => null;
  const app = renderer.createApp(component, {
    modelValue: 'a',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    label: 'Test',
  });
  try {
    app.mount(makeNode('root'));
    await flush();
    const vm = app._instance!.setupState as Record<string, any>;
    vm.trigger = {
      isConnected: true,
      matches: () => false,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 30, width: 100, height: 20 }),
      closest: () => null,
      focus() {},
    };
    vm.popup = {
      isConnected: true,
      matches: () => false,
      showPopover() {},
      hidePopover() {},
      focus() {},
      querySelector: () => null,
      style: {},
    };
    vm.root = { contains: () => false };

    // Open and immediately close before nextTick completes.
    const opening = vm.open();
    vm.close(false);
    await opening;
    await flush();
    assert.equal(vm.opened, false);
    assert.equal(winEvents.count(), 0, 'window listeners must not leak');
    assert.equal(docEvents.count(), 0, 'document listeners must not leak');
    assert.equal(activeMutationObservers, 0, 'MutationObserver must not leak');
    assert.equal(activeResizeObservers, 0, 'ResizeObserver must not leak');
  } finally {
    app.unmount();
    restore();
  }
});

test('#61 UiColor falls back to dialog.showModal when showPopover throws', async () => {
  const winEvents = eventHub(), docEvents = eventHub();
  const restore = globals({
    window: { ...winEvents, innerWidth: 1200, innerHeight: 800 },
    document: { ...docEvents, documentElement: { clientWidth: 1200 } },
    HTMLElement: class { showPopover() {} hidePopover() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const stubUrl = moduleUrl(`export default { render() { return null; } }; // ${seq++}`);
  const { descriptor } = parse(fs.readFileSync(new URL('../src/components/UiColor.vue', import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'ui-color-test' }).content
    .replace(/from (['"])vue\1/g, `from '${import.meta.resolve('vue')}'`)
    .replaceAll("'../i18n'", `'${new URL('../src/i18n/index.ts', import.meta.url).href}'`)
    .replaceAll("'../color'", `'${new URL('../src/color.ts', import.meta.url).href}'`)
    .replaceAll("'./Icon.vue'", `'${stubUrl}'`);
  const component = (await import(moduleUrl(script))).default;
  component.render = () => null;
  const app = renderer.createApp(component, { modelValue: '#8b93d9', label: 'Color' });
  try {
    app.mount(makeNode('root'));
    await flush();
    const vm = app._instance!.setupState as Record<string, any>;
    let showModalCalled = 0;
    vm.trigger = {
      isConnected: true,
      matches: () => false,
      getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 30, width: 80, height: 20 }),
      closest: () => null,
      parentElement: null,
      focus() {},
    };
    vm.panel = {
      open: false,
      matches: () => false,
      getBoundingClientRect: () => ({ width: 220, height: 180 }),
      showPopover() { throw new Error('popover unsupported in this webview'); },
      showModal() { showModalCalled++; this.open = true; },
      close() { this.open = false; },
    };
    vm.input = { focus() {}, select() {} };

    assert.equal(vm.nativePopover, true);
    await vm.toggle();
    await flush();
    assert.equal(vm.nativePopover, false, 'failed showPopover must downgrade to dialog mode');
    assert.equal(showModalCalled, 1, 'fallback must open the dialog via showModal()');
    assert.equal(vm.opened, true);

    vm.close(false);
    assert.equal(vm.opened, false);
    assert.equal(winEvents.count(), 0);
    assert.equal(docEvents.count(), 0);
  } finally {
    app.unmount();
    restore();
  }
});

test('#60 HandwritingPanel emits busy and aborts font download if unmounted during progress subscription', async () => {
  let resolveProgress!: (unlisten: () => void) => void;
  let progressUnlistened = 0;
  let downloadCalled = 0;
  const restore = globals({
    __hwMock: {
      isDesktop: true,
      api: {
        async handwritingAssets() {
          return {
            available: true,
            path: '/tmp/hw',
            fonts: [{ id: 'demo-font', name: 'Demo', file: 'demo.ttf', path: null, downloaded: false, bundled: false, tags: ['手写体'] }],
            backgrounds: [],
            error: null,
          };
        },
        onHandwritingFontProgress() {
          return new Promise<() => void>(resolve => { resolveProgress = resolve; });
        },
        async downloadHandwritingFont() {
          downloadCalled++;
          return { available: true, path: '/tmp/hw', fonts: [], backgrounds: [], error: null };
        },
      },
    },
  });
  const mockUrl = moduleUrl(`export const { api, isDesktop } = globalThis.__hwMock; // ${seq++}`);
  const stubUrl = moduleUrl(`export default { render() { return null; } }; // ${seq++}`);
  const { descriptor } = parse(fs.readFileSync(new URL('../src/components/HandwritingPanel.vue', import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'hw-panel-test' }).content
    .replace(/from (['"])vue\1/g, `from '${import.meta.resolve('vue')}'`)
    .replaceAll("'../api'", `'${mockUrl}'`)
    .replaceAll("'../i18n'", `'${new URL('../src/i18n/index.ts', import.meta.url).href}'`)
    .replaceAll("'../snippets'", `'${new URL('../src/snippets.ts', import.meta.url).href}'`)
    .replaceAll("'../handwriting-preview'", `'${new URL('../src/handwriting-preview.ts', import.meta.url).href}'`)
    .replaceAll("'./UiColor.vue'", `'${stubUrl}'`);
  const component = (await import(moduleUrl(script))).default;
  component.render = () => null;
  const busyEvents: boolean[] = [];
  let vm!: Record<string, any>;
  const app = renderer.createApp({
    render: () => h(component, {
      text: '你好星笺',
      title: '测试',
      onBusy: (v: boolean) => busyEvents.push(v),
      ref: (inst: any) => { if (inst) vm = inst.$?.setupState ?? inst; },
    }),
  });
  try {
    app.mount(makeNode('root'));
    await flush();
    const pendingDownload = vm.selectFont('demo-font');
    await flush();
    assert.equal(busyEvents.at(-1), true, 'starting download must emit busy(true)');
    app.unmount();
    assert.equal(busyEvents.at(-1), false, 'unmount must emit busy(false)');
    resolveProgress(() => { progressUnlistened++; });
    await pendingDownload;
    assert.equal(progressUnlistened, 1, 'late progress subscription must be immediately cleaned up');
    assert.equal(downloadCalled, 0, 'unmounted panel must never start downloadHandwritingFont');
  } finally {
    restore();
  }
});

test('#60 ImageBatchBar emits busy(false) on unmount during an in-flight operation', async () => {
  let resolveCopy!: () => void;
  const restore = globals({
    __batchMock: {
      isDesktop: true,
      api: {
        async getClips(ids: number[]) { return ids.map(id => ({ id, kind: 'image', isPrivate: false })); },
        copyImageFiles() { return new Promise<void>(resolve => { resolveCopy = resolve; }); },
      },
    },
  });
  const mockUrl = moduleUrl(`export const { api, isDesktop } = globalThis.__batchMock; // ${seq++}`);
  const { descriptor } = parse(fs.readFileSync(new URL('../src/components/ImageBatchBar.vue', import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'batch-unmount-test' }).content
    .replace(/from (['"])vue\1/g, `from '${import.meta.resolve('vue')}'`)
    .replaceAll("'../api'", `'${mockUrl}'`)
    .replaceAll("'../privacy'", `'${new URL('../src/privacy.ts', import.meta.url).href}'`)
    .replaceAll("'../i18n'", `'${new URL('../src/i18n/index.ts', import.meta.url).href}'`);
  const component = (await import(moduleUrl(script))).default;
  component.render = () => null;
  const busyEvents: boolean[] = [];
  let vm!: Record<string, any>;
  const app = renderer.createApp({
    render: () => h(component, {
      ids: [1],
      pageIds: [1],
      disabled: false,
      onBusy: (v: boolean) => busyEvents.push(v),
      ref: (inst: any) => { if (inst) vm = inst.$?.setupState ?? inst; },
    }),
  });
  try {
    app.mount(makeNode('root'));
    await flush();
    const running = vm.act('copy');
    await flush();
    assert.equal(busyEvents.at(-1), true);
    app.unmount();
    assert.equal(busyEvents.at(-1), false, 'unmounting during in-flight action must release parent busy lock');
    resolveCopy();
    await running;
  } finally {
    restore();
  }
});

test('#56 & #63 App.vue card template supports Shift+Enter plain copy and unique file preview keys', () => {
  const source = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: 'App.vue', id: 'app-template-test' });
  assert.equal(compiled.errors.length, 0);

  // Extract the compiled keydown.enter handler expression via source check + AST-compiled code check
  assert.match(source, /@keydown\.enter="event => \{ if \(event\.target === event\.currentTarget && !event\.metaKey && !event\.ctrlKey && !event\.altKey\) \{ event\.stopPropagation\(\); event\.preventDefault\(\); !imageSelectMode && copy\(clip, true, event\.shiftKey\) \} \}"/);
  assert.match(source, /v-for="\(name, fileIndex\) in fileNames\(clip\)\.slice\(0, 4\)" :key="`\$\{fileIndex\}-\$\{name\}`"/);
});
