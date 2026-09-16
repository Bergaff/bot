/**
 * Мини-DOM для тестов extension/dom.cjs: те же duck-typed интерфейсы,
 * что использует код (querySelector/querySelectorAll/attributes/textContent),
 * но без браузера. Поддерживаются селекторы, которые реально встречаются
 * в списках домена: '.class', 'tag', 'tag[attr]', 'tag[attr*="v"]', '.a .b'.
 */

export type AttrOp = '=' | '*=' | '';

export interface AttrSel { name: string; op: AttrOp; value: string; }
export interface StepSel { tag: string | null; classes: string[]; ids: string[]; attrs: AttrSel[]; }

export class FakeNode {
  tagName: string;
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  private ownText = '';
  style: Record<string, string> = {};
  /** обработчики, чтобы тесты могли «кликнуть» по кнопке панели */
  handlers: Record<string, Array<(ev: any) => void>> = {};

  constructor(tagName = 'div', opts: { className?: string; attrs?: Record<string, string>; text?: string } = {}) {
    this.tagName = tagName.toUpperCase();
    if (opts.className !== undefined) this.attrs.class = opts.className;
    if (opts.attrs) Object.assign(this.attrs, opts.attrs);
    if (opts.text !== undefined) this.text = opts.text;
  }

  /** Как Element.append: строки превращаются в текст, null/undefined пропускаются. */
  append(...nodes: Array<FakeNode | string | null | undefined>): this {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      const child = typeof n === 'string' ? new FakeNode('#text', { text: n }) : n;
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  get className(): string { return this.attrs.class || ''; }
  set className(v: string) { this.attrs.class = v; }

  get classList() {
    const node = this;
    const value = () => (node.attrs.class || '').split(/\s+/).filter(Boolean);
    return {
      get value() { return value(); },
      contains: (c: string) => value().includes(c),
      add: (c: string) => { if (!value().includes(c)) node.attrs.class = [...value(), c].join(' '); },
      remove: (c: string) => { node.attrs.class = value().filter((x) => x !== c).join(' '); },
      toggle: (c: string) => (value().includes(c) ? node.classList.remove(c) : node.classList.add(c)),
    };
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name === 'className' ? 'class' : name] = String(value);
  }

  appendChild(node: FakeNode): FakeNode { return this.append(node); }

  /** Как Element.replaceChildren: очистить и вложить новое. */
  replaceChildren(...nodes: Array<FakeNode | string | null | undefined>): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type: string, fn: (ev: any) => void): void {
    (this.handlers[type] ||= []).push(fn);
  }

  /** Вызвать обработчики события (клик по кнопке в тестах). */
  dispatch(type: string): void {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of this.handlers[type] || []) fn(event);
  }

  /** input.value / select.value в тестах. */
  get value(): string { return this.ownText; }
  set value(v: string) { this.ownText = String(v ?? ''); }

  getAttribute(name: string): string | null {
    const key = name === 'className' ? 'class' : name;
    const value = this.attrs[key];
    return value === undefined ? null : value;
  }

  /** Собственный текст узла (без потомков). */
  get text(): string { return this.ownText; }
  set text(value: string) { this.ownText = String(value ?? ''); }

  /** Текст узла вместе с потомками. Присваивание — как в DOM:очищает потомков. */
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.ownText = String(value ?? '');
  }

  get innerText(): string { return this.textContent; }
  set innerText(value: string) { this.textContent = value; }

  querySelector(selector: string): FakeNode | null { return queryAll(this, selector)[0] ?? null; }
  querySelectorAll(selector: string): FakeNode[] { return queryAll(this, selector); }
}

function walk(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
  for (const child of node.children) { out.push(child); walk(child, out); }
  return out;
}

function parseStep(step: string): StepSel {
  const sel: StepSel = { tag: null, classes: [], ids: [], attrs: [] };
  const attrRe = /\[([^\]=*]+)(\*?=)?"?([^\]"]*)"?\]/g;
  let rest = step;
  for (const m of step.matchAll(attrRe)) {
    sel.attrs.push({ name: m[1]!.trim(), op: (m[2] || '') as AttrOp, value: m[3] || '' });
    rest = rest.replace(m[0], '');
  }
  // токены: tag, .class, #id
  for (const m of rest.matchAll(/([#.]?)([A-Za-z_][\w-]*)/g)) {
    if (m[1] === '#') sel.ids.push(m[2]!);
    else if (m[1] === '.') sel.classes.push(m[2]!);
    else sel.tag = m[2]!.toUpperCase();
  }
  return sel;
}

function parseSelector(selector: string): StepSel[] {
  return selector.trim().split(/\s+/).map(parseStep);
}

function matchesStep(node: FakeNode, step: StepSel): boolean {
  if (step.tag && node.tagName !== step.tag) return false;
  const classes = node.classList.value;
  for (const c of step.classes) if (!classes.includes(c)) return false;
  for (const id of step.ids) if (node.getAttribute('id') !== id) return false;
  for (const a of step.attrs) {
    const v = node.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
  }
  return true;
}

/** Все потомки node, подходящие под селектор (в порядке документа). */
export function queryAll(node: FakeNode, selector: string): FakeNode[] {
  const steps = parseSelector(selector);
  const last = steps[steps.length - 1]!;
  const ancestors = steps.slice(0, -1).reverse();

  return walk(node).filter((candidate) => {
    if (!matchesStep(candidate, last)) return false;
    let cur: FakeNode | null = candidate.parent;
    for (const step of ancestors) {
      while (cur && !matchesStep(cur, step)) cur = cur.parent;
      if (!cur) return false;
      cur = cur.parent;
    }
    return true;
  });
}

/** Готовый «документ» с локацией — как аргументы harvest()/readChatInfo(). */
export function fakeDocument(root: FakeNode, url = 'https://web.telegram.org/k/#@username'): { doc: any; location: any } {
  const doc = {
    querySelector: (sel: string) => root.querySelector(sel),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    body: root,
  };
  const u = new URL(url);
  return { doc, location: { href: u.href, hash: u.hash } };
}

/**
 * Один «пузырь» сообщения в ленте (классы — как в Telegram Web K:
 * .bubble[data-mid] → .peer-title, .text-content, time[datetime]).
 *
 * `idFormat` — как клиент отдаёт id: 'attr' (data-mid="123"), 'compound'
 * (data-mid="123_456"), 'link' (нет атрибута, но есть t.me/<chat>/<id>),
 * 'none' (ничего нет — core синтезирует id).
 */
export function bubble(opts: {
  text: string;
  author?: string;
  /** подпись времени, например «14:32» или «вчера» */
  date?: string;
  /** ISO-дата в атрибут time[datetime] */
  datetime?: string;
  /** числовой id (или «123_456») */
  id?: string;
  /** ссылка на сообщение, если id живёт только в ней */
  permalink?: string;
  /** сервисное сообщение (вошёл в группу, закрепил…) — сборщик его пропускает */
  service?: boolean;
}): FakeNode {
  const msg = new FakeNode('div', {
    className: opts.service ? 'bubble service-message' : 'bubble',
    attrs: opts.id !== undefined ? { 'data-mid': opts.id } : {},
  });
  if (opts.author) msg.append(new FakeNode('div', { className: 'peer-title', text: opts.author }));
  msg.append(new FakeNode('div', { className: 'text-content', text: opts.text }));
  if (opts.datetime || opts.date) {
    msg.append(new FakeNode('time', {
      className: 'date-text',
      attrs: opts.datetime ? { datetime: opts.datetime } : {},
      text: opts.date || opts.datetime || '',
    }));
  }
  if (opts.permalink) {
    msg.append(new FakeNode('a', { attrs: { href: opts.permalink }, text: opts.date || '12:00' }));
  }
  return msg;
}

/** Лента чата: div.bubbles > div.bubble* (основная стратегия harvest). */
export function bubblesList(messages: FakeNode[]): FakeNode {
  const root = new FakeNode('div', { className: 'bubbles' });
  return root.append(...messages);
}

/**
 * Подобие `document`: body + documentElement, createElement, getElementById,
 * querySelector(All). Хватает и для чтения ленты (dom.cjs), и для панели/админки.
 */
export class FakeDocument {
  readonly documentElement = new FakeNode('html');
  readonly body: FakeNode;
  title = '';

  constructor(page: FakeNode = new FakeNode('div')) {
    this.body = new FakeNode('body');
    this.body.append(page);
  }

  createElement(tag: string): FakeNode { return new FakeNode(tag); }
  createTextNode(text: string): FakeNode { return new FakeNode('#text', { text }); }

  getElementById(id: string): FakeNode | null {
    return queryAll(this.documentElement, `#${id}`)[0] ?? queryAll(this.body, `#${id}`)[0] ?? null;
  }

  querySelector(selector: string): FakeNode | null { return this.body.querySelector(selector); }
  querySelectorAll(selector: string): FakeNode[] { return this.body.querySelectorAll(selector); }
}
