'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Whether the reader has filed the memo away. Per-browser, remembered across visits — a
// returning visitor who dismissed it should land straight on the console gallery.
const STORAGE_KEY = 'ct.fieldOrders.dismissed';

// Long enough to read as the sheet folding and being filed, short enough not to be in the way.
const FLIGHT_MS = 460;

/** Where the restore tab sits, in viewport coordinates — the memo flies to (and from) it.
 *  Approximate on purpose: it only needs to land in the tab's neighbourhood, and reading the
 *  tab's real box would mean rendering it before the flight to measure it. */
function tabCenter() {
  return { x: window.innerWidth - 12 - 58, y: 12 + 13 };
}

export function FieldOrders({ children }: { children: React.ReactNode }) {
  // null until localStorage has been read: rendering either state before then would flash
  // the memo at people who dismissed it, or the tab at people who didn't.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  // 'out' keeps the memo mounted while it flies away; 'in' plays the flight in reverse.
  const [flight, setFlight] = useState<'out' | 'in' | null>(null);
  const [outStyle, setOutStyle] = useState<React.CSSProperties>({});
  const paperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      // Private mode, or site data blocked. Show the memo — the briefing is the point.
      setDismissed(false);
    }
  }, []);

  const persist = useCallback((value: boolean) => {
    setDismissed(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* the dismissal still holds for this visit */
    }
  }, []);

  /** The transform that takes the memo from where it sits to the tab in the corner: fly,
   *  shrink, and tip away on the X axis so the paper reads as folding rather than scaling. */
  const flightTransform = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const target = tabCenter();
    const dx = target.x - (r.left + r.width / 2);
    const dy = target.y - (r.top + r.height / 2);
    const scale = Math.max(0.05, 116 / Math.max(r.width, 1));
    // perspective() must be the first function in the transform: the `perspective` CSS
    // property applies to an element's CHILDREN, so it would leave this element's own
    // rotateX as a flat vertical squash instead of a fold in depth.
    return `perspective(1100px) translate(${dx}px, ${dy}px) scale(${scale}) rotateX(-72deg) rotate(-4deg)`;
  };

  const reducedMotion = () =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const dismiss = () => {
    const el = paperRef.current;
    if (!el || reducedMotion()) {
      persist(true);
      return;
    }
    setOutStyle({ transform: flightTransform(el), opacity: 0 });
    setFlight('out');
    window.setTimeout(() => {
      setFlight(null);
      setOutStyle({});
      persist(true);
    }, FLIGHT_MS);
  };

  const restore = () => {
    persist(false);
    if (!reducedMotion()) setFlight('in');
  };

  // Coming back: mount the memo already folded into the corner, then release it on the next
  // frame so the browser has a start state to transition from.
  useLayoutEffect(() => {
    if (flight !== 'in') return;
    const el = paperRef.current;
    if (!el) {
      setFlight(null);
      return;
    }
    el.style.transition = 'none';
    el.style.transform = flightTransform(el);
    el.style.opacity = '0';
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.style.transform = '';
        el.style.opacity = '';
      })
    );
    const timer = window.setTimeout(() => setFlight(null), FLIGHT_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [flight]);

  if (dismissed === null) {
    // Holds the memo's layout so nothing jumps once we know which way to render.
    return <div className="invisible">{children}</div>;
  }

  // The memo stays mounted through the outbound flight, then hands over to the tab.
  const showPaper = !dismissed || flight === 'out';

  return (
    <>
      {showPaper && (
        <div
          ref={paperRef}
          className="relative w-full max-w-xl"
          style={{
            transformOrigin: 'center',
            transition: `transform ${FLIGHT_MS}ms cubic-bezier(0.4, 0.02, 0.3, 1), opacity ${FLIGHT_MS}ms ease-in`,
            willChange: 'transform, opacity',
            pointerEvents: flight ? 'none' : undefined,
            ...(flight === 'out' ? outStyle : null),
          }}
        >
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss field orders"
            title="File away — brings back from the top-right"
            className="absolute right-2 top-2 z-10 h-6 w-6 rounded-[3px] font-mono text-[13px] leading-none text-[#8a7647] transition-colors hover:bg-[#00000010] hover:text-[#7c2d12]"
          >
            ✕
          </button>
          {children}
        </div>
      )}

      {dismissed && flight !== 'out' && (
        <button
          type="button"
          onClick={restore}
          className="ct-tab-in fixed top-3 right-3 z-20 rounded-[3px] border border-[#8a7647]/50 bg-[#e8dcc0]/90 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-[#5c4d30] shadow-md transition-colors hover:bg-[#efe5cd] hover:text-[#2b2412]"
        >
          ▸ Field Orders
        </button>
      )}
    </>
  );
}
