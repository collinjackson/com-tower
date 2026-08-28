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

const CYCLE_MS = 9000;
// How deep the visible pile goes. Beyond this the cards are hidden rather than stacked
// forever — the illusion only needs the few top edges.
const PILE_DEPTH = 5;

/** Dispatches coming off a teletype: each notification prints out of the slot and lands on
 *  the pile, pushing the previous one down.
 *
 *  DOM rather than painted into the background canvas because the unit sprite AWBW serves is
 *  an animated GIF, and drawImage() paints only its first frame. The monochrome treatment is
 *  a CSS filter for the same reason — running it through sharp server-side would flatten the
 *  animation to a still. */
export function FeaturedPost() {
  const [posts, setPosts] = useState<Post[]>([]);
  // Newest first. Grows as each one prints, so the pile deepens while you watch.
  const [pile, setPile] = useState<{ post: Post; serial: number }[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/showcase')
      .then((r) => (r.ok ? r.json() : { posts: [] }))
      .then((d) => {
        const list: Post[] = Array.isArray(d?.posts) ? d.posts : [];
        if (cancelled || list.length === 0) return;
        setPosts(list);
        setPile([{ post: list[0], serial: 0 }]);
        setCursor(1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (posts.length === 0) return;
    const timer = window.setInterval(() => {
      setCursor((c) => {
        setPile((p) => [{ post: posts[c % posts.length], serial: c }, ...p].slice(0, PILE_DEPTH));
        return c + 1;
      });
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [posts]);

  if (pile.length === 0) return null;

  return (
    <aside
      className="fixed right-6 top-1/2 z-10 hidden w-[310px] -translate-y-1/2 xl:block"
      aria-label="Field dispatches"
    >
      {/* The aperture. Sits above the cards so a printing dispatch appears to slide out
          from behind the lip rather than fading in over it. */}
      <div className="ct-slot relative z-30">
        <span className="ct-slot-label">COM TOWER · FIELD DISPATCH</span>
      </div>

      {/* Fixed height because the cards are absolutely positioned to overlap. Sized for the
          240-character ceiling the caption generator enforces, so the longest possible
          dispatch still fits rather than spilling past the pile. */}
      <div className="relative mt-[-2px] h-[268px]">
        {pile.map(({ post, serial }, i) => (
          <article
            key={serial}
            className={`ct-card absolute inset-x-0 top-0${i === 0 ? ' ct-card-printing' : ''}`}
            style={{
              // Each older card sinks a little further down the pile and dims. The tiny
              // alternating rotation stops it reading as a stack of identical rectangles.
              transform: `translateY(${i * 7}px) rotate(${i === 0 ? 0 : (i % 2 ? -0.5 : 0.6) * i}deg)`,
              zIndex: 20 - i,
              opacity: i === 0 ? 1 : Math.max(0, 0.55 - i * 0.12),
              filter: i === 0 ? undefined : `brightness(${1 - i * 0.06})`,
            }}
            aria-hidden={i !== 0}
          >
            <div className="ct-card-head">
              <span>No. {String(serial + 1).padStart(3, '0')}</span>
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
        ))}
      </div>
    </aside>
  );
}
