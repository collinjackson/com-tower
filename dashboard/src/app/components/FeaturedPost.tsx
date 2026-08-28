'use client';

import { useEffect, useState } from 'react';
import { ARMY_COLORS, DEFAULT_ARMY_COLOR } from '@/lib/armies';

type Post = {
  text: string;
  emojis: string[];
  day: number | null;
  speaker: string | null;
  army: string | null;
  armyName: string | null;
  spriteUrl: string | null;
};

const CYCLE_MS = 8000;
const FADE_MS = 450;

/** A heads-up display off to the side, carrying one real notification at a time.
 *
 *  Deliberately DOM rather than a panel painted into the background canvas: the unit sprite
 *  AWBW serves is an animated GIF, and drawImage() only ever paints a GIF's first frame. In
 *  an <img> it animates for free. */
export function FeaturedPost() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(true);
  const [spriteOk, setSpriteOk] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/showcase')
      .then((r) => (r.ok ? r.json() : { posts: [] }))
      .then((d) => {
        if (!cancelled) setPosts(Array.isArray(d?.posts) ? d.posts : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (posts.length < 2) return;
    const timer = window.setInterval(() => {
      // Fade out, swap, fade in — a HUD channel changing, not a hard cut.
      setShown(false);
      window.setTimeout(() => {
        setIdx((i) => (i + 1) % posts.length);
        setSpriteOk(true);
        setShown(true);
      }, FADE_MS);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [posts.length]);

  if (posts.length === 0) return null;

  const post = posts[idx];
  const color = (post.army && ARMY_COLORS[post.army]) || DEFAULT_ARMY_COLOR;
  const speaker = (post.speaker || 'COMMS').toUpperCase();
  const army = (post.armyName || '').toUpperCase();

  return (
    // xl only: below that the memo would collide with it, and a HUD that overlaps the
    // briefing is worse than no HUD.
    <aside
      className="ct-hud fixed right-5 top-1/2 z-10 hidden w-[292px] -translate-y-1/2 rounded-[3px] border bg-[#080c09]/85 p-3 font-mono text-[11px] leading-[1.5] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.9)] xl:block"
      style={{
        borderColor: `${color}55`,
        opacity: shown ? 1 : 0,
        transition: `opacity ${FADE_MS}ms ease`,
      }}
      aria-label="Featured transmission"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate uppercase tracking-wide" style={{ color }}>
          ▸ {speaker}
          {army ? ` · ${army}` : ''}
        </span>
        {post.day ? <span className="shrink-0 text-[#5d7a63]">DAY {post.day}</span> : null}
      </div>

      <div className="my-2 h-px w-full" style={{ backgroundColor: `${color}44` }} />

      <div className="flex items-start gap-3">
        {post.spriteUrl && spriteOk ? (
          // eslint-disable-next-line @next/next/no-img-element -- an animated GIF hotlinked
          // from AWBW; the Image optimizer would flatten it to a still frame.
          <img
            src={post.spriteUrl}
            alt=""
            onError={() => setSpriteOk(false)}
            className="mt-0.5 h-12 w-12 shrink-0 object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
        ) : null}
        <p className="min-w-0 flex-1 text-[#9fd4a8]">{post.text}</p>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[13px] leading-none">{post.emojis.slice(0, 8).join('')}</span>
        <span className="text-[9px] uppercase tracking-wider text-[#4d6b53]">
          intercepted · names redacted
        </span>
      </div>
    </aside>
  );
}
