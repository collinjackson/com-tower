'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Whether the reader has filed the memo away. Per-browser, remembered across visits — a
// returning visitor who dismissed it should land straight on the console.
const STORAGE_KEY = 'ct.fieldOrders.dismissed';

// Long enough to read as the sheet folding and being filed, short enough not to be in the way.
const FLIGHT_MS = 460;

/** Where the restore tab sits, in viewport coordinates — the memo flies to (and from) it.
 *  Approximate on purpose: it only needs to land in the tab's neighbourhood, and reading the
 *  tab's real box would mean rendering it before the flight to measure it. */
function tabCenter() {
  return { x: window.innerWidth - 12 - 58, y: 12 + 13 };
}

// 'pre-in' is mounted but not yet animating: it exists so the flight transform can be measured
// and written to the CSS variable before the inbound animation class is applied.
type Flight = null | 'out' | 'pre-in' | 'in';

export function FieldOrders({ children }: { children: React.ReactNode }) {
  // null until localStorage has been read: rendering either state before then would flash
  // the memo at people who dismissed it, or the tab at people who didn't.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [flight, setFlight] = useState<Flight>(null);
  const [flightTransform, setFlightTransform] = useState('none');
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

  /** The transform that takes the memo from where it sits down into the tab in the corner.
   *
   *  Deliberately 2D. An earlier version led with perspective(1100px), which meant the
   *  translate that follows was interpreted in projected space and magnified — the memo swung
   *  well outside the viewport on its way, which is also what briefly summoned a scrollbar.
   *  The fold now comes from squashing the vertical axis as it shrinks, which needs no 3D. */
  const measureFlight = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const target = tabCenter();
    const dx = target.x - (r.left + r.width / 2);
    const dy = target.y - (r.top + r.height / 2);
    const scale = Math.max(0.04, 116 / Math.max(r.width, 1));
    return `translate(${dx}px, ${dy}px) scale(${scale}) scaleY(0.55) rotate(-3deg)`;
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
    setFlightTransform(measureFlight(el));
    setFlight('out');
  };

  const restore = () => {
    if (reducedMotion()) {
      persist(false);
      return;
    }
    // Mount it first; the inbound flight is measured in the layout effect below, before paint.
    persist(false);
    setFlight('pre-in');
  };

  // A flight moves the memo across the viewport, and any overshoot would extend the page and
  // flash a scrollbar. Nothing on this page scrolls anyway, so clip for the duration.
  useEffect(() => {
    if (!flight) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [flight]);

  // Measure once the memo is mounted but before the browser paints, then hand over to the
  // inbound animation now that the CSS variable it reads is set.
  useLayoutEffect(() => {
    if (flight !== 'pre-in') return;
    const el = paperRef.current;
    if (!el) {
      setFlight(null);
      return;
    }
    setFlightTransform(measureFlight(el));
    setFlight('in');
  }, [flight]);

  // One place where a finished flight is committed, for either direction. Driven by the
  // animation actually ending rather than a timer that can drift out of step with it.
  const finishFlight = useCallback(() => {
    setFlight((f) => {
      if (f === 'out') persist(true);
      return f === 'out' || f === 'in' ? null : f;
    });
  }, [persist]);

  // animationend bubbles, so an animated child would otherwise end the flight early.
  const onFlightEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    finishFlight();
  };

  // Backstop: if the animation never runs — a display:none ancestor, a browser that drops the
  // event — the memo must not be left mid-flight and unclickable.
  useEffect(() => {
    if (flight !== 'out' && flight !== 'in') return;
    const timer = window.setTimeout(finishFlight, FLIGHT_MS + 220);
    return () => clearTimeout(timer);
  }, [flight, finishFlight]);

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
          onAnimationEnd={onFlightEnd}
          className={`relative w-full max-w-xl${flight === 'out' ? ' ct-file-out' : ''}${
            flight === 'in' ? ' ct-file-in' : ''
          }`}
          style={{
            // Read by the keyframes. Keeping the whole animation in CSS avoids mutating
            // inline styles behind React's back — doing that stripped the transition and left
            // every flight after the first with nothing to animate.
            ['--ct-flight' as string]: flightTransform,
            pointerEvents: flight ? 'none' : undefined,
          }}
        >
          {/* The envelope the orders arrived in, sitting behind and slightly askew so only its
              edges show. Inside the animated wrapper, so it folds away with the memo rather
              than being left behind on the desk. */}
          <div
            aria-hidden
            className="ct-envelope pointer-events-none absolute -left-3 -right-5 -top-2.5 -bottom-7 -rotate-1 rounded-[2px]"
          />

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

      {(flight === 'out' || (dismissed && flight !== 'in')) && (
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
