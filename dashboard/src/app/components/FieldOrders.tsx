'use client';

import { useEffect, useState } from 'react';

// Whether the reader has filed the memo away. Per-browser, remembered across visits — a
// returning visitor who dismissed it should land straight on the console gallery.
const STORAGE_KEY = 'ct.fieldOrders.dismissed';

export function FieldOrders({ children }: { children: React.ReactNode }) {
  // null until localStorage has been read: rendering either state before then would flash
  // the memo at people who dismissed it, or the tab at people who didn't.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      // Private mode, or site data blocked. Show the memo — the briefing is the point.
      setDismissed(false);
    }
  }, []);

  const persist = (value: boolean) => {
    setDismissed(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* the dismissal still holds for this visit */
    }
  };

  if (dismissed === null) {
    // Holds the memo's layout so nothing jumps once we know which way to render.
    return <div className="invisible">{children}</div>;
  }

  if (dismissed) {
    return (
      <button
        type="button"
        onClick={() => persist(false)}
        className="fixed top-3 right-3 z-20 rounded-[3px] border border-[#8a7647]/50 bg-[#e8dcc0]/90 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-[#5c4d30] shadow-md transition-colors hover:bg-[#efe5cd] hover:text-[#2b2412]"
      >
        ▸ Field Orders
      </button>
    );
  }

  return (
    <div className="relative w-full max-w-xl">
      <button
        type="button"
        onClick={() => persist(true)}
        aria-label="Dismiss field orders"
        title="Dismiss — brings back from the top-right"
        className="absolute right-2 top-2 z-10 h-6 w-6 rounded-[3px] font-mono text-[13px] leading-none text-[#8a7647] transition-colors hover:bg-[#00000010] hover:text-[#7c2d12]"
      >
        ✕
      </button>
      {children}
    </div>
  );
}
