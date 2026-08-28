'use client';

import { useEffect, useRef, useState } from 'react';

type Post = {
  text: string;
  emojis: string[];
  day: number | null;
  speaker: string | null;
  army: string | null;
  armyName: string | null;
  spriteUrl: string | null;
};

const HOLD_MS = 8000;
// Must match the transform transition in globals.css: the z-index only flips once the card
// has finished rising, so these cannot drift apart.
const MOVE_MS = 440;
// Clearance above the top of the pile once raised. The lift itself is the card's own measured
// height plus this, so the raised card is entirely above the pile before anything else moves.
const LIFT_CLEARANCE = 18;
// How deep the visible pile goes. Beyond this the cards are hidden — the illusion only needs
// the few top edges.
const PILE_DEPTH = 5;

/** Dispatches on a field desk, paged through one at a time: the front card lifts toward the
 *  machine's slot, then drops in at the back of the pile and the next one is showing.
 *
 *  The unit is a still: AWBW serves an animated GIF, and a looping sprite fights the paper —
 *  a printed card does not move. /api/sprite pulls the first frame and prints it in one ink,
 *  which is a truer press look than CSS filters could manage anyway. */
export function FeaturedPost() {
  const [posts, setPosts] = useState<Post[]>([]);
  // Post indices, front of the pile first. Rotated by one each time we page.
  const [order, setOrder] = useState<number[]>([]);
  // 'lifting' = rising clear of the pile; 'settling' = descending into the back of it.
  const [phase, setPhase] = useState<'idle' | 'lifting' | 'settling'>('idle');
  // How far up to raise the front card. Measured, not assumed: cards differ in height with
  // the length of the dispatch, and a lift shorter than the card leaves it overlapping the
  // pile when its z-index drops — which is exactly what makes the swap visible.
  const [lift, setLift] = useState(280);
  const frontRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/showcase')
      .then((r) => (r.ok ? r.json() : { posts: [] }))
      .then((d) => {
        const list: Post[] = Array.isArray(d?.posts) ? d.posts : [];
        if (cancelled || list.length === 0) return;
        setPosts(list);
        setOrder(list.map((_, i) => i));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (posts.length < 2) return;
    const timers: number[] = [];
    const timer = window.setInterval(() => {
      // Measure the card actually on top right now, so the lift always clears it.
      const h = frontRef.current?.offsetHeight;
      if (h) setLift(h + LIFT_CLEARANCE);
      setPhase('lifting');

      // Only once it is fully raised — and therefore no longer overlapping anything — is it
      // safe to send it to the back. The rotation drops its z-index in the same frame, but
      // the card is clear of the pile by then, so nothing is seen popping behind.
      timers.push(
        window.setTimeout(() => {
          setOrder((o) => [...o.slice(1), o[0]]);
          setPhase('settling');
        }, MOVE_MS)
      );
      timers.push(window.setTimeout(() => setPhase('idle'), MOVE_MS * 2));
    }, HOLD_MS);
    return () => {
      clearInterval(timer);
      timers.forEach(clearTimeout);
    };
  }, [posts.length]);

  if (posts.length === 0 || order.length === 0) return null;

  return (
    <aside
      className="fixed right-6 top-1/2 z-10 hidden w-[310px] -translate-y-1/2 xl:block"
      aria-label="Field dispatches"
    >
      {/* The machine's aperture. Above every card, so a lifting dispatch tucks up under the
          lip instead of floating over it. */}
      <div className="ct-slot relative z-30">
        <span className="ct-slot-label">COM TOWER · FIELD DISPATCH</span>
      </div>

      {/* Fixed height because the cards are absolutely positioned to overlap. Sized for the
          240-character ceiling the caption generator enforces, so the longest possible
          dispatch still fits rather than spilling past the pile. */}
      <div className="relative mt-[-2px] h-[268px]">
        {order.map((postIdx, depth) => {
          if (depth >= PILE_DEPTH) return null;
          const post = posts[postIdx];
          const isFront = depth === 0;
          const lifted = isFront && phase === 'lifting';
          // The card that just went to the back is still descending; it keeps the front card's
          // full opacity until it lands, so it does not dim mid-air.
          const descending = phase === 'settling' && depth === order.length - 1;
          return (
            <article
              key={postIdx}
              ref={isFront ? (frontRef as React.Ref<HTMLElement>) : undefined}
              className="ct-card absolute inset-x-0 top-0"
              style={{
                // Raised clear of the pile by its own height, so what is underneath is fully
                // revealed before it goes anywhere. Resting: each card further down the pile,
                // with a small alternating tilt so it does not read as identical rectangles.
                transform: lifted
                  ? `translateY(-${lift}px) scale(1.035)`
                  : `translateY(${depth * 7}px) rotate(${isFront ? 0 : (depth % 2 ? -0.5 : 0.6) * depth}deg)`,
                // Above everything while raised — including the machine's lip, so the card
                // stays readable — then straight to the back of the pile as it descends.
                zIndex: lifted ? 40 : 20 - depth,
                opacity: isFront || descending ? 1 : Math.max(0, 0.55 - depth * 0.12),
                filter: isFront || descending ? undefined : `brightness(${1 - depth * 0.06})`,
              }}
              aria-hidden={!isFront}
            >
              <div className="ct-card-head">
                <span>No. {String(postIdx + 1).padStart(3, '0')}</span>
                {post.day ? <span>DAY {post.day}</span> : <span />}
              </div>

              <div className="mt-1.5 flex items-start gap-2.5">
                {post.spriteUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- already rasterised
                  // and sized by /api/sprite; the Image optimizer would only re-encode it.
                  <img
                    src={`/api/sprite?u=${encodeURIComponent(post.spriteUrl)}`}
                    alt=""
                    className="ct-print-img"
                  />
                ) : null}
                <div className="min-w-0">
                  <div className="ct-stencil">{(post.speaker || 'COMMS').toUpperCase()}</div>
                  {post.armyName ? (
                    <div className="ct-stencil-sub">{post.armyName.toUpperCase()}</div>
                  ) : null}
                </div>
              </div>

              <div className="ct-rule" />
              <p className="ct-body">{post.text}</p>
              <div className="ct-rule" />

              <div className="ct-card-foot">
                <span className="ct-emoji">{post.emojis.slice(0, 8).join('')}</span>
                <span>NAMES REDACTED</span>
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}
