/** Tiny DOM helpers. The UI is hand-rolled - no framework, no virtual DOM. */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('data-') || key === 'role' || key.startsWith('aria-')) {
      node.setAttribute(key, String(value));
    } else if (key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Binds a tap handler that works the same for touch and mouse.
 *
 * Uses pointerup with a movement guard rather than click, because on iPadOS a
 * click can lag ~300ms behind the finger, which makes a game UI feel broken.
 */
export function onTap(node: HTMLElement, handler: (event: PointerEvent) => void): () => void {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  const down = (event: PointerEvent) => {
    tracking = true;
    startX = event.clientX;
    startY = event.clientY;
    node.classList.add('is-pressed');
  };
  const up = (event: PointerEvent) => {
    node.classList.remove('is-pressed');
    if (!tracking) return;
    tracking = false;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 16) return;
    if (node.hasAttribute('disabled')) return;
    event.preventDefault();
    event.stopPropagation();
    handler(event);
  };
  const cancel = () => {
    tracking = false;
    node.classList.remove('is-pressed');
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', cancel);

  return () => {
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', cancel);
    node.removeEventListener('pointerleave', cancel);
  };
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function toggleClass(node: HTMLElement, name: string, on: boolean): void {
  node.classList.toggle(name, on);
}
