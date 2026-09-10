import { useLayoutEffect, useRef, useState } from "react";
type Anchor = { id: string; offset: number };
const readers = new Map<string, () => void>();
// Explicit history links pause their own transcript, never another chat.
export function engagePanel(id: string) {
  readers.get(id)?.();
}
export function useReading(id: string, version: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [unread, setUnread] = useState(false);
  const initialized = useRef(false);
  const following = useRef(true);
  const saved = useRef<Anchor | null>(null);
  const lastTop = useRef(0);
  const frame = useRef(0);
  const anchor = () => {
    const el = ref.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    const first = [
      ...el.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((node) => node.getBoundingClientRect().bottom > top);
    return first
      ? {
          id: first.dataset.messageId!,
          offset: first.getBoundingClientRect().top - top,
        }
      : null;
  };
  const save = () => {
    saved.current = anchor();
    if (saved.current)
      sessionStorage.setItem("reading:" + id, JSON.stringify(saved.current));
  };
  const follow = () => {
    following.current = true;
    saved.current = null;
    sessionStorage.removeItem("reading:" + id);
    setUnread(false);
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
      lastTop.current = ref.current.scrollTop;
    }
  };
  const restore = () => {
    const el = ref.current;
    if (!el || !saved.current) return;
    const node = [
      ...el.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((node) => node.dataset.messageId === saved.current!.id);
    if (node)
      el.scrollTop +=
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        saved.current.offset;
    lastTop.current = el.scrollTop;
  };
  const update = () => {
    if (!initialized.current) return;
    if (following.current) follow();
    else restore();
  };
  useLayoutEffect(() => {
    initialized.current = false;
    try {
      saved.current = JSON.parse(
        sessionStorage.getItem("reading:" + id) ?? "null",
      );
    } catch {
      saved.current = null;
    }
    following.current = !saved.current;
    const pause = () => {
      following.current = false;
      save();
    };
    readers.set(id, pause);
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(update);
    });
    if (ref.current) resize.observe(ref.current);
    if (ref.current?.firstElementChild)
      resize.observe(ref.current.firstElementChild);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      if (!following.current) save();
      readers.delete(id);
      resize.disconnect();
      cancelAnimationFrame(frame.current);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [id]);
  useLayoutEffect(() => {
    if (!ref.current || version === undefined) return;
    if (!initialized.current) {
      initialized.current = true;
      if (following.current) follow();
      else restore();
      lastTop.current = ref.current.scrollTop;
      return;
    }
    if (following.current) follow();
    else {
      restore();
      setUnread(true);
    }
  }, [version, id]);
  return {
    ref,
    unread,
    jump: follow,
    handlers: {
      onWheel: (event: React.WheelEvent) => {
        if (event.deltaY < 0 && following.current) {
          following.current = false;
          saved.current = null;
        }
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (
          following.current &&
          ["ArrowUp", "PageUp", "Home"].includes(event.key)
        ) {
          following.current = false;
          saved.current = null;
        }
      },
      onScroll: () => {
        const el = ref.current;
        if (!el || !initialized.current) return;
        const bottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 3;
        if (bottom) {
          following.current = true;
          saved.current = null;
          sessionStorage.removeItem("reading:" + id);
          setUnread(false);
        } else if (el.scrollTop < lastTop.current - 1)
          following.current = false;
        lastTop.current = el.scrollTop;
        if (!following.current) save();
      },
    },
  };
}
