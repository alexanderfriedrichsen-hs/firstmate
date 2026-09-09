import { useCallback, useState } from "react";
export function usePanelWidth(
  name: string,
  initial: number,
  min: number,
  max: number,
) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("panel-width:" + name));
    return saved >= min && saved <= max ? saved : initial;
  });
  const ref = useCallback(
    (panel: HTMLElement | null) => {
      if (!panel) return;
      const observer = new ResizeObserver(() => {
        if (window.innerWidth <= 800) return;
        const measured = Math.round(panel.getBoundingClientRect().width);
        if (measured >= min && measured <= max) {
          localStorage.setItem("panel-width:" + name, String(measured));
          setWidth(measured);
        }
      });
      observer.observe(panel);
      return () => observer.disconnect();
    },
    [name, min, max],
  );
  return {
    ref,
    style: window.innerWidth > 800 ? { width } : undefined,
    tabIndex: 0,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key))
        return;
      event.preventDefault();
      const next = Math.max(
        min,
        Math.min(max, width + (event.key === "ArrowRight" ? 16 : -16)),
      );
      localStorage.setItem("panel-width:" + name, String(next));
      setWidth(next);
    },
    "aria-description":
      "To resize this panel with the keyboard, press Alt and the left or right arrow key.",
  };
}
