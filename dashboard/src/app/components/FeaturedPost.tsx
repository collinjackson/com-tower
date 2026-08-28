'use client';

import { useEffect, useState } from 'react';

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
// How long the front card spends lifted before it drops in behind the others.
const LIFT_MS = 460;
// How deep the visible pile goes. Beyond this the cards are hidden — the illusion only needs
// the few top edges.
const PILE_DEPTH = 5;

/** Dispatches on a field desk, paged through one at a time: the front card lifts toward the
 *  machine's slot, then drops in at the back of the pile and the next one is showing.
 *
 *  DOM rather than painted into the background canvas because the unit sprite AWBW serves is
 *  an animated GIF, and drawImage() paints only its first frame. The monochrome treatment is
 *  a CSS filter for the same reason — sharp would flatten the animation to a still. */
export function FeaturedPost() {
  const [posts, setPosts] = useState<Post[]>([]);
  // Post indices, front of the pile first. Rotated by one each time we page.
  const [order, setOrder] = useState<number[]>([]);
  const [lifting, setLifting] = useState(false);

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
    const timer = window.setInterval(() => {
      setLifting(true);
      // Rotate only once the card is clear of the pile: its z-index drops at the same moment,
      // so it is above the others on the way up and behind them on the way down.
      window.setTimeout(() => {
        setOrder((o) => [...o.slice(1), o[0]]);
        setLifting(false);
      }, LIFT_MS);
    }, HOLD_MS);
    return () => clearInterval(timer);
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
          const lifted = isFront && lifting;
          return (
            <article
              key={postIdx}
              className="ct-card absolute inset-x-0 top-0"
              style={{
                // Lifted: up toward the slot and a touch larger, as if picked up. Resting:
                // each card further down the pile, with a small alternating tilt so it does
                // not read as a stack of identical rectangles.
                transform: lifted
                  ? 'translateY(-54px) scale(1.035)'
                  : `translateY(${depth * 7}px) rotate(${isFront ? 0 : (depth % 2 ? -0.5 : 0.6) * depth}deg)`,
                // Under the slot's lip while lifted, but over the rest of the pile.
                zIndex: lifted ? 25 : 20 - depth,
                opacity: isFront ? 1 : Math.max(0, 0.55 - depth * 0.12),
                filter: isFront ? undefined : `brightness(${1 - depth * 0.06})`,
              }}
              aria-hidden={!isFront}
            >
              <div className="ct-card-head">
                <span>No. {String(postIdx + 1).padStart(3, '0')}</span>
                {post.day ? <span>DAY {post.day}</span> : <span />}
              </div>

              <div className="mt-1.5 flex items-start gap-2.5">
                {post.spriteUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- animated GIF; the
                  // Image optimizer would flatten it to a still frame.
                  <img src={post.spriteUrl} alt="" className="ct-print-img" />
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
