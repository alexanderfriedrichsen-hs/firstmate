import { useLayoutEffect, useRef, useState } from "react";
type Anchor = { id: string; offset: number };
let engaged: string | undefined;
let keyboardFocusAt = 0;
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Tab" && e.isTrusted) keyboardFocusAt = performance.now();
  },
  true,
);
const listeners = new Set<() => void>();
const captures = new Set<string>();
const change = (id: string) => {
  if (engaged !== id) {
    engaged = id;
    for (const listener of listeners) listener();
  }
};
export function engagePanel(id: string) {
  change(id);
}
export function useReading(id: string, version: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [unread, setUnread] = useState(false);
  const initialized = useRef(false);
  const saved = useRef<Anchor | null>(null);
  const anchor = () => {
    const el = ref.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const nodes = [...el.querySelectorAll<HTMLElement>("[data-message-id]")];
    const first = nodes.find(
      (n) => n.getBoundingClientRect().bottom > rect.top,
    );
    return first
      ? {
          id: first.dataset.messageId!,
          offset: first.getBoundingClientRect().top - rect.top,
        }
      : null;
  };
  const save = () => {
    saved.current = anchor();
    if (saved.current)
      sessionStorage.setItem("reading:" + id, JSON.stringify(saved.current));
  };
  const restore = () => {
    const el = ref.current;
    if (!el || !saved.current) return;
    const node = [
      ...el.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((n) => n.dataset.messageId === saved.current!.id);
    if (node)
      el.scrollTop +=
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        saved.current.offset;
  };
  const pinned = () => {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && !!ref.current?.contains(sel.anchorNode);
  };
  const canFollow = () =>
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    engaged !== id &&
    !pinned() &&
    !captures.has(id);
  const catchUp = () => {
    requestAnimationFrame(() => {
      if (canFollow() && ref.current)
        ref.current.scrollTop = ref.current.scrollHeight;
    });
  };
  useLayoutEffect(() => {
    initialized.current = false;
    saved.current = JSON.parse(
      sessionStorage.getItem("reading:" + id) ?? "null",
    );
    if (!engaged) engaged = id;
    const changed = () => {
      if (engaged !== id) catchUp();
    };
    listeners.add(changed);
    const visible = () => {
      if (engaged === id) restore();
      else catchUp();
    };
    const clear = () => {
      captures.delete(id);
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pointerup", clear);
    document.addEventListener("selectionchange", changed);
    const ro = new ResizeObserver(() => {
      if (engaged === id || pinned()) restore();
      else catchUp();
    });
    if (ref.current?.firstElementChild)
      ro.observe(ref.current.firstElementChild);
    return () => {
      if (engaged === id) save();
      listeners.delete(changed);
      ro.disconnect();
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pointerup", clear);
      document.removeEventListener("selectionchange", changed);
      captures.delete(id);
    };
  }, [id]);
  useLayoutEffect(() => {
    if (!ref.current || version === undefined) return;
    if (!initialized.current) {
      if (saved.current) restore();
      else ref.current.scrollTop = ref.current.scrollHeight;
      initialized.current = true;
      return;
    }
    if (engaged === id || pinned()) {
      setUnread(true);
      restore();
    } else catchUp();
  }, [version, id]);
  const engage = () => {
    change(id);
    save();
  };
  return {
    ref,
    unread,
    jump: () => {
      engage();
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      save();
      setUnread(false);
    },
    handlers: {
      onPointerDown: () => {
        engage();
        captures.add(id);
      },
      onWheel: engage,
      onTouchStart: engage,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(e.key)
        )
          engage();
      },
      onFocus: (e: React.FocusEvent) => {
        if (
          e.nativeEvent.isTrusted &&
          performance.now() - keyboardFocusAt < 500
        )
          engage();
      },
      onScroll: () => {
        if (engaged === id) save();
      },
    },
  };
}
