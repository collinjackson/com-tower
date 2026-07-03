'use client';

import { useEffect, useRef, useState } from 'react';

// A full-width typewriter rule: fills the line with a WHOLE number of hyphens (never a clipped
// partial dash), re-measuring on resize. Renders nothing until measured, then hydrates.
export function DashRule() {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.textContent = '--------------------'; // 20 dashes
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.letterSpacing = cs.letterSpacing;
      el.appendChild(probe);
      const charW = probe.getBoundingClientRect().width / 20;
      el.removeChild(probe);
      if (charW > 0) setCount(Math.max(0, Math.floor(el.clientWidth / charW)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="my-2.5 overflow-hidden whitespace-nowrap leading-none text-[#9c8043] select-none"
    >
      {'-'.repeat(count)}
    </div>
  );
}
