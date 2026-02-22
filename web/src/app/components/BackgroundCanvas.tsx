'use client';

import { useEffect, useRef } from 'react';

const rAF =
  typeof window !== 'undefined'
    ? window.requestAnimationFrame ||
      (window as unknown as { mozRequestAnimationFrame: typeof requestAnimationFrame }).mozRequestAnimationFrame ||
      (window as unknown as { webkitRequestAnimationFrame: typeof requestAnimationFrame }).webkitRequestAnimationFrame ||
      (window as unknown as { msRequestAnimationFrame: typeof requestAnimationFrame }).msRequestAnimationFrame ||
      ((cb: FrameRequestCallback) => window.setTimeout(cb, 1000 / 60))
    : null;

function buildTerrainPoints(
  width: number,
  height: number,
  mHeight: number,
  displacement: number
): number[] {
  const power = Math.pow(2, Math.ceil(Math.log(width) / Math.log(2)));
  const points: number[] = [];
  points[0] = mHeight;
  points[power] = mHeight;
  let disp = displacement;
  for (let i = 1; i < power; i *= 2) {
    for (let j = power / i / 2; j < power; j += power / i) {
      const prev = points[j - power / i / 2];
      const next = points[j + power / i / 2];
      points[j] =
        (prev + next) / 2 + Math.floor(Math.random() * (2 * disp) - disp);
    }
    disp *= 0.6;
  }
  return points;
}

function getTerrainY(
  points: number[],
  x: number,
  width: number
): number {
  const power = points.length - 1;
  if (power <= 0) return points[0] ?? 0;
  const t = (x * power) / width;
  const i0 = Math.max(0, Math.floor(t));
  const i1 = Math.min(i0 + 1, power);
  const frac = t - i0;
  return (points[i0] ?? 0) * (1 - frac) + (points[i1] ?? 0) * frac;
}

type FlameParticle = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number };
type Explosion = { x: number; y: number; startTime: number; particles: FlameParticle[] };
type TerrainHole = { worldX: number; radius: number; depth: number };

export function BackgroundCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !rAF) return;
    const requestAnim = rAF;

    let width = window.innerWidth;
    let height = Math.max(window.document.body.offsetHeight, 400);
    canvas.width = width;
    canvas.height = height;

    const ctxOrNull = canvas.getContext('2d');
    if (!ctxOrNull) return;
    const ctx: CanvasRenderingContext2D = ctxOrNull;

    // Terrain state: { points, scrollDelay, lastScroll, fillStyle, mHeight }
    const terrains: Array<{
      points: number[];
      scrollDelay: number;
      lastScroll: number;
      fillStyle: string;
      mHeight: number;
    }> = [
      {
        points: buildTerrainPoints(width, height, height / 2 - 120, 140),
        scrollDelay: 90,
        lastScroll: Date.now(),
        fillStyle: '#191D4C',
        mHeight: height / 2 - 120,
      },
      {
        points: buildTerrainPoints(width, height, height / 2 - 60, 120),
        scrollDelay: 50,
        lastScroll: Date.now(),
        fillStyle: 'rgb(17,20,40)',
        mHeight: height / 2 - 60,
      },
      {
        points: buildTerrainPoints(width, height, height / 2, 100),
        scrollDelay: 20,
        lastScroll: Date.now(),
        fillStyle: 'rgb(10,10,5)',
        mHeight: height / 2,
      },
    ];

    type Star = { x: number; y: number; size: number; speed: number };
    const stars: Star[] = [];
    for (let i = 0; i < height; i++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 2,
        speed: Math.random() * 0.05,
      });
    }

    type ShootingStar = {
      x: number;
      y: number;
      len: number;
      speed: number;
      size: number;
      waitTime: number;
      active: boolean;
    };
    const shootingStars: ShootingStar[] = [
      { x: 0, y: 0, len: 0, speed: 0, size: 0, waitTime: 0, active: false },
      { x: 0, y: 0, len: 0, speed: 0, size: 0, waitTime: 0, active: false },
    ];
    function resetShootingStar(s: ShootingStar) {
      s.x = Math.random() * width;
      s.y = 0;
      s.len = Math.random() * 120 + 40;
      s.speed = Math.random() * 8 + 5;
      s.size = Math.random() * 2.5 + 1;
      s.waitTime = Date.now() + Math.random() * 3000 + 500;
      s.active = false;
    }
    shootingStars.forEach(resetShootingStar);

    const explosions: Explosion[] = [];
    const EXPLOSION_DURATION_MS = 800;
    const FIRE_DURATION_MS = 1800;
    const FLAME_PARTICLE_COUNT = 32;

    const terrainHoles: TerrainHole[] = [];
    const HOLE_RADIUS = 28;
    const HOLE_DEPTH = 18;
    let frontTerrainScrollOffset = 0;

    function spawnExplosion(impactX: number, impactY: number) {
      const particles: FlameParticle[] = [];
      for (let i = 0; i < FLAME_PARTICLE_COUNT; i++) {
        // Emit upward with outward spread: cone pointing up
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
        const speed = 1.5 + Math.random() * 4;
        particles.push({
          x: impactX + (Math.random() - 0.5) * 8,
          y: impactY,
          vx: Math.cos(angle) * speed * 0.4 + (Math.random() - 0.5) * 1.2,
          vy: Math.sin(angle) * speed - 1.5,
          life: 1,
          maxLife: 0.6 + Math.random() * 0.4,
          size: 1.5 + Math.random() * 2.5,
        });
      }
      explosions.push({ x: impactX, y: impactY, startTime: Date.now(), particles });
      terrainHoles.push({
        worldX: frontTerrainScrollOffset + impactX,
        radius: HOLE_RADIUS,
        depth: HOLE_DEPTH,
      });
    }

    function craterOffsetAt(screenX: number): number {
      const worldX = frontTerrainScrollOffset + screenX;
      let offset = 0;
      for (const h of terrainHoles) {
        const dist = Math.abs(worldX - h.worldX);
        if (dist < h.radius) {
          const t = 1 - dist / h.radius;
          offset += h.depth * t * t;
        }
      }
      return offset;
    }

    let rafId: number;

    function applyResize() {
      if (!canvas) return;
      const w = window.innerWidth;
      const h = Math.max(window.document.body.offsetHeight, 400);
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = width;
      canvas.height = height;
      terrains[0].points = buildTerrainPoints(width, height, height / 2 - 120, 140);
      terrains[0].mHeight = height / 2 - 120;
      terrains[1].points = buildTerrainPoints(width, height, height / 2 - 60, 120);
      terrains[1].mHeight = height / 2 - 60;
      terrains[2].points = buildTerrainPoints(width, height, height / 2, 100);
      terrains[2].mHeight = height / 2;
      frontTerrainScrollOffset = 0;
      // Reseed stars for new dimensions (keep count proportional)
      while (stars.length < height) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: Math.random() * 2,
          speed: Math.random() * 0.05,
        });
      }
      while (stars.length > height) stars.pop();
    }

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const RESIZE_DEBOUNCE_MS = 400;

    function animate() {
      ctx.fillStyle = '#110E19';
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = '#ffffff';
      for (const star of stars) {
        star.x -= star.speed;
        if (star.x < 0) {
          star.x = width;
          star.y = Math.random() * height;
          star.size = Math.random() * 2;
          star.speed = Math.random() * 0.05;
        }
        ctx.fillRect(star.x, star.y, star.size, star.size);
      }

      const now = Date.now();
      for (let ti = 0; ti < terrains.length; ti++) {
        const t = terrains[ti];
        const isFrontTerrain = ti === 2;
        if (now > t.lastScroll + t.scrollDelay) {
          t.lastScroll = now;
          t.points.push(t.points.shift()!);
          if (isFrontTerrain) frontTerrainScrollOffset += 1;
        }
        ctx.fillStyle = t.fillStyle;
        ctx.beginPath();
        const y0 = t.points[0]! + (isFrontTerrain ? craterOffsetAt(0) : 0);
        ctx.moveTo(0, y0);
        for (let i = 1; i <= width; i++) {
          if (t.points[i] !== undefined) {
            const y = t.points[i]! + (isFrontTerrain ? craterOffsetAt(i) : 0);
            ctx.lineTo(i, y);
          }
        }
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fill();
      }

      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ffffff';

      const frontTerrain = terrains[2];

      for (const s of shootingStars) {
        if (s.active) {
          const nextX = s.x - s.speed;
          const nextY = s.y + s.speed;
          const terrainY = getTerrainY(frontTerrain.points, nextX, width);

          if (nextX < 0) {
            resetShootingStar(s);
          } else if (nextY >= terrainY) {
            spawnExplosion(nextX, terrainY);
            resetShootingStar(s);
          } else {
            s.x = nextX;
            s.y = nextY;
            const radius = s.size + 1.5;
            ctx.beginPath();
            ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (now >= s.waitTime) {
          s.active = true;
        }
      }

      const stillActive: Explosion[] = [];
      for (const ex of explosions) {
        const elapsed = now - ex.startTime;
        if (elapsed > FIRE_DURATION_MS) continue;

        if (elapsed < EXPLOSION_DURATION_MS) {
          for (const p of ex.particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vx += (Math.random() - 0.5) * 0.2;
            p.vy -= 0.02;
            p.life = Math.max(0, 1 - elapsed / (p.maxLife * EXPLOSION_DURATION_MS));

            if (p.life <= 0) continue;
            const radius = p.size * (0.5 + 0.5 * p.life);
            ctx.globalAlpha = p.life * p.life;
            const r = Math.floor(255);
            const g = Math.floor(100 + 155 * p.life);
            const b = Math.floor(30 * p.life);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }

        stillActive.push(ex);
      }
      explosions.length = 0;
      explosions.push(...stillActive);

      rafId = requestAnim(animate);
    }

    rafId = requestAnim(animate);

    const onResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        applyResize();
      }, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (typeof rafId === 'number') cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      id="bgCanvas"
      className="fixed inset-0 z-[-1] h-full w-full"
      style={{ display: 'block' }}
      aria-hidden
    />
  );
}
