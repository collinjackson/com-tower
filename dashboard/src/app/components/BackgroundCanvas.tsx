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

type InfantryGroup = {
  worldX: number;
  terrainLayer: number;
  count: number;
  stepPhase: number;
  dir: number;
  team: number;
  fightUntil: number;
  combatPartnerIndex: number;
  bazookaCount: number;
};
type Fighter = { x: number; y: number; vx: number; vy: number; angle: number; trail: number; targetIndex: number; propPhase: number; fireCooldown: number };
type CrashingPlane = { x: number; y: number; vx: number; vy: number; angle: number };
type Tracer = { x: number; y: number; vx: number; vy: number; life: number; shooterIndex: number };

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

    const infantryGroups: InfantryGroup[] = [];
    const power = Math.pow(2, Math.ceil(Math.log(Math.max(width, 1)) / Math.log(2)));
    const infantryWrap = width + 120;
    for (let g = 0; g < 12; g++) {
      infantryGroups.push({
        worldX: Math.floor((g / 12) * infantryWrap * 2.5) + Math.floor(Math.random() * 80),
        terrainLayer: 2,
        count: 4 + Math.floor(Math.random() * 3),
        stepPhase: Math.random() * Math.PI * 2,
        dir: g % 2 === 0 ? 1 : -1,
        team: g % 2,
        fightUntil: 0,
        combatPartnerIndex: -1,
        bazookaCount: 1 + (g % 2),
      });
    }

    const fighters: Fighter[] = [];
    for (let f = 0; f < 4; f++) {
      fighters.push({
        x: Math.random() * width,
        y: height * (0.15 + Math.random() * 0.35),
        vx: (Math.random() - 0.5) * 1.2,
        vy: (Math.random() - 0.5) * 0.8,
        angle: Math.random() * Math.PI * 2,
        trail: 0,
        targetIndex: (f + 2) % 4,
        propPhase: Math.random() * Math.PI * 2,
        fireCooldown: Math.floor(Math.random() * 40),
      });
    }
    const tracers: Tracer[] = [];
    const crashingPlanes: CrashingPlane[] = [];
    const respawnQueue: { spawnAt: number }[] = [];

    const terminalLines: string[][] = [[], [], [], [], []];
    const terminalLastAdd: number[] = [0, 0, 0, 0, 0];
    const TERMINAL_LINE_POOL: string[][] = [
      ['> LINK  OK', '> RX 0.2k', '> TX 1.1k', '> SYNC', '> ---', '> PING 12ms'],
      ['> SIGNAL ON', '> CARRIER', '> MODEM', '> ---', '> RSSI -45'],
      ['> AWBW POLL', '> TURN 4', '> ---', '> GAME 1578803'],
      ['> STATUS OK', '> MEM 42%', '> ---', '> UP 2d 4h'],
      ['> TAPE RDY', '> BLK 012', '> ---', '> EOF'],
    ];

    const explosions: Explosion[] = [];
    const EXPLOSION_DURATION_MS = 800;
    const FIRE_DURATION_MS = 1800;
    const FLAME_PARTICLE_COUNT = 32;

    const terrainHoles: TerrainHole[] = [];
    const HOLE_RADIUS = 28;
    const HOLE_DEPTH = 18;
    let frontTerrainScrollOffset = 0;

    function spawnExplosion(impactX: number, impactY: number, scale = 1, addHole = true) {
      const count = Math.max(6, Math.floor(FLAME_PARTICLE_COUNT * scale));
      const particles: FlameParticle[] = [];
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
        const speed = (1.5 + Math.random() * 4) * scale;
        particles.push({
          x: impactX + (Math.random() - 0.5) * 8 * scale,
          y: impactY,
          vx: (Math.cos(angle) * speed * 0.4 + (Math.random() - 0.5) * 1.2) * scale,
          vy: (Math.sin(angle) * speed - 1.5) * scale,
          life: 1,
          maxLife: 0.6 + Math.random() * 0.4,
          size: (1.5 + Math.random() * 2.5) * scale,
        });
      }
      explosions.push({ x: impactX, y: impactY, startTime: Date.now(), particles });
      if (addHole) {
        terrainHoles.push({
          worldX: frontTerrainScrollOffset + impactX,
          radius: HOLE_RADIUS * scale,
          depth: HOLE_DEPTH * scale,
        });
      }
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
      for (const f of fighters) {
        f.x = Math.min(width + 10, Math.max(-10, f.x));
        const horizonY = getTerrainY(terrains[2].points, f.x, width) + craterOffsetAt(f.x);
        f.y = Math.min(horizonY - 18, Math.max(20, f.y));
      }
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

      const frontTerrain = terrains[2];
      const nowInf = Date.now();
      const wrap = width + 120;
      const COMBAT_RANGE = 48;
      const COMBAT_DURATION_MS = 2600;

      const groupScreenPos: { x: number; y: number }[] = [];
      for (const group of infantryGroups) {
        let screenX = ((group.worldX - frontTerrainScrollOffset) % wrap + wrap) % wrap - 60;
        const terrainY = getTerrainY(frontTerrain.points, screenX, width) + craterOffsetAt(screenX);
        groupScreenPos.push({ x: screenX, y: terrainY });
      }

      for (let ga = 0; ga < infantryGroups.length; ga++) {
        for (let gb = ga + 1; gb < infantryGroups.length; gb++) {
          const a = infantryGroups[ga];
          const b = infantryGroups[gb];
          if (a.team === b.team || a.count <= 0 || b.count <= 0) continue;
          const pa = groupScreenPos[ga];
          const pb = groupScreenPos[gb];
          if (Math.abs(pa.x - pb.x) < COMBAT_RANGE && Math.abs(pa.y - pb.y) < 20) {
            if (a.fightUntil === 0 && b.fightUntil === 0) {
              a.fightUntil = nowInf + COMBAT_DURATION_MS;
              b.fightUntil = nowInf + COMBAT_DURATION_MS;
              a.combatPartnerIndex = gb;
              b.combatPartnerIndex = ga;
            }
          }
        }
      }

      const resolvedCombat = new Set<InfantryGroup>();
      for (const group of infantryGroups) {
        if (group.count <= 0) continue;
        if (group.fightUntil > 0 && nowInf >= group.fightUntil - 150 && !resolvedCombat.has(group)) {
          const other = group.combatPartnerIndex >= 0 ? infantryGroups[group.combatPartnerIndex] : null;
          if (other && other.count > 0 && !resolvedCombat.has(other)) {
            if (Math.random() < 0.5) group.count = Math.max(0, group.count - 1);
            else other.count = Math.max(0, other.count - 1);
            group.worldX += group.dir * 65;
            other.worldX -= other.dir * 65;
            resolvedCombat.add(group);
            resolvedCombat.add(other);
            group.combatPartnerIndex = -1;
            other.combatPartnerIndex = -1;
          }
          group.fightUntil = 0;
          if (other) other.fightUntil = 0;
        } else if (nowInf >= group.fightUntil) {
          group.fightUntil = 0;
          group.combatPartnerIndex = -1;
        }
        if (group.fightUntil === 0) {
          group.stepPhase += 0.032;
          group.worldX -= group.dir * 0.15;
        }
      }

      for (let gi = 0; gi < infantryGroups.length; gi++) {
        const group = infantryGroups[gi];
        if (group.count <= 0) continue;
        let screenX = ((group.worldX - frontTerrainScrollOffset) % wrap + wrap) % wrap - 60;
        if (screenX < -30 || screenX > width + 30) continue;
        const fighting = group.fightUntil > 0 && nowInf < group.fightUntil - 250;
        const frontCount = Math.max(2, Math.floor(group.count * 0.55));
        const dir = group.dir;
        const upperHeight = 4.2;

        const fillCamouflage = 'rgba(18,16,12,0.72)';
        ctx.fillStyle = fillCamouflage;
        ctx.lineWidth = 0;

        for (let i = 0; i < group.count; i++) {
          const inBack = i >= frontCount;
          const stagger = (i % 2) * 2 * dir;
          const step = group.stepPhase + i * 0.6;
          const phase = (group.stepPhase + i * 1.9) % (Math.PI * 2);
          const isMoving = phase < Math.PI;
          const moveShift = isMoving ? Math.sin(step) * 0.6 : 0;
          const px = screenX + (inBack ? (i - frontCount) * 5 * dir : i * 4 * dir) + stagger + moveShift * dir;
          let terrainYAtPx = 0;
          const smooth = 3;
          for (let s = -smooth; s <= smooth; s++) {
            terrainYAtPx += getTerrainY(frontTerrain.points, px + s * 2, width) + craterOffsetAt(px + s * 2);
          }
          terrainYAtPx /= (smooth * 2 + 1);
          const aboveRidge = 2;
          const py = terrainYAtPx - upperHeight - aboveRidge;
          const hasBazooka = i < group.bazookaCount;

          ctx.save();
          ctx.translate(px, py);
          if (dir < 0) ctx.scale(-1, 1);

          ctx.beginPath();
          ctx.ellipse(1.4, 1, 1, 1.1, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillRect(0.5, 1.8, 1.8, 2.4);
          if (hasBazooka) {
            ctx.fillRect(1.8, 1.6, 3.5, 1);
          } else {
            ctx.beginPath();
            ctx.moveTo(2, 2.8);
            ctx.lineTo(4.5, 2.5);
            ctx.lineTo(4.6, 2.7);
            ctx.lineTo(2.1, 3);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
          const flashPhase = (nowInf * 0.0022 + gi * 97 + i * 31) % 600;
          const occasionalFlash = !fighting && flashPhase < 220;
          const combatFlash = fighting && (hasBazooka ? Math.sin(nowInf * 0.035 + i) > 0.0 : Math.sin(nowInf * 0.028 + i * 2) > 0.15);
          const showFlash = occasionalFlash || combatFlash;
          const basePx = screenX + (inBack ? (i - frontCount) * 5 * dir : i * 4 * dir) + stagger;
          const ridgeTopAtBase = getTerrainY(frontTerrain.points, basePx, width) + craterOffsetAt(basePx);
          const flashWobble = Math.sin(nowInf * 0.0018 + gi * 0.9 + i * 0.5) * 0.35;
          if (showFlash) {
            const intensity = combatFlash ? 0.58 : 0.45;
            const size = combatFlash ? 0.6 : 0.45;
            const flashX = basePx + dir * (hasBazooka ? 6 : 5) + flashWobble;
            const ridgeTopY = ridgeTopAtBase;
            const flashY = ridgeTopY + 2.5;
            ctx.save();
            ctx.beginPath();
            ctx.rect(flashX - 12, ridgeTopY, 24, 28);
            ctx.clip();
            ctx.fillStyle = `rgba(255,230,180,${intensity})`;
            if (hasBazooka) {
              ctx.fillRect(flashX - (0.6 + size / 2), flashY - 0.7, 1.2 + size, 1.4);
            } else {
              ctx.beginPath();
              ctx.arc(flashX, flashY, 0.5 + size, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
            ctx.fillStyle = fillCamouflage;
          }
          if (fighting && combatFlash && hasBazooka && Math.sin(nowInf * 0.04 + i * 1.7) > 0.5) {
            const flashX2 = basePx + dir * 5.5 + flashWobble * 0.8;
            const ridgeTopY2 = ridgeTopAtBase;
            const flashY2 = ridgeTopY2 + 2;
            ctx.save();
            ctx.beginPath();
            ctx.rect(flashX2 - 8, ridgeTopY2, 16, 20);
            ctx.clip();
            ctx.fillStyle = 'rgba(255,240,200,0.5)';
            ctx.fillRect(flashX2 - 0.5, flashY2 - 0.4, 1, 0.8);
            ctx.restore();
            ctx.fillStyle = fillCamouflage;
          }
        }
      }

      for (let i = tracers.length - 1; i >= 0; i--) {
        const t = tracers[i];
        t.x += t.vx;
        t.y += t.vy;
        t.life -= 0.028;
        if (t.life <= 0 || t.x < -10 || t.x > width + 10 || t.y < -10 || t.y > height + 10) {
          tracers.splice(i, 1);
        }
      }

      const MAX_PITCH = 0.5;
      const MAX_PITCH_EVADE = 0.75;
      const MAX_SPEED_CRUISE = 2.0;
      const MAX_SPEED_CHASE = 2.9;
      const nowF = Date.now();
      for (let fi = 0; fi < fighters.length; fi++) {
        const f = fighters[fi];
        const target = fighters[f.targetIndex];
        const dx = target.x - f.x;
        const dy = target.y - f.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const weAreBehindTarget = dx * Math.cos(target.angle) + dy * Math.sin(target.angle) > 0;
        const isChaser = weAreBehindTarget && dist < 220;
        const CHASE_KEEP_DISTANCE = 72;
        const behindX = target.x - Math.cos(target.angle) * CHASE_KEEP_DISTANCE;
        const behindY = target.y - Math.sin(target.angle) * CHASE_KEEP_DISTANCE;
        const dxAim = isChaser ? behindX - f.x : dx;
        const dyAim = isChaser ? behindY - f.y : dy;
        const desiredAngle = Math.atan2(dyAim || dy, dxAim || dx);
        const targetAhead = dx * Math.cos(f.angle) + dy * Math.sin(f.angle) > dist * 0.25;
        let isEvader = false;
        for (let fj = 0; fj < fighters.length; fj++) {
          if (fj === fi) continue;
          const chaser = fighters[fj];
          if (chaser.targetIndex !== fi) continue;
          const cx = f.x - chaser.x;
          const cy = f.y - chaser.y;
          if (cx * Math.cos(f.angle) + cy * Math.sin(f.angle) > 20) {
            isEvader = true;
            break;
          }
        }
        const maxSpd = targetAhead ? MAX_SPEED_CHASE : MAX_SPEED_CRUISE;
        const pitchCap = isEvader ? MAX_PITCH_EVADE : MAX_PITCH;
        let targetAngle = desiredAngle;
        if (Math.cos(targetAngle) > 0) {
          targetAngle = Math.max(-pitchCap, Math.min(pitchCap, targetAngle));
        } else {
          const leftRef = targetAngle > 0 ? Math.PI : -Math.PI;
          targetAngle = leftRef + Math.max(-pitchCap, Math.min(pitchCap, targetAngle - leftRef));
        }
        if (isEvader) {
          const evadeBias = 0.08 * Math.sin(nowF * 0.002 + fi * 2.1);
          targetAngle = Math.max(-pitchCap, Math.min(pitchCap, targetAngle + evadeBias));
        }
        const maxTurn = 0.035;
        let da = targetAngle - f.angle;
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        f.angle += Math.max(-maxTurn, Math.min(maxTurn, da));
        let spd = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
        spd = Math.min(spd, maxSpd);
        if (spd < 0.5) spd = 0.55;
        f.vx = Math.cos(f.angle) * spd;
        f.vy = Math.sin(f.angle) * spd;
        f.x += f.vx;
        f.y += f.vy;
        if (f.x < -25) f.x = width + 25;
        if (f.x > width + 25) f.x = -25;
        if (f.y < 25) { f.y = 25; f.vy *= -0.5; }
        const horizonY = getTerrainY(frontTerrain.points, f.x, width) + craterOffsetAt(f.x);
        const minY = horizonY - 18;
        if (f.y > minY) { f.y = minY; f.vy *= -0.5; }
        f.propPhase += 0.55;
        f.trail = (f.trail + 0.2) % (Math.PI * 2);
        f.fireCooldown--;
        // Shoot when any enemy is close and in front (not only assigned target), and cooldown ready
        const SHOOT_RANGE = 260;
        const SHOOT_CONE = 0.2; // target in front: dot > dist * SHOOT_CONE
        let shootTarget: { index: number; dist: number } | null = null;
        for (let fj = 0; fj < fighters.length; fj++) {
          if (fj === fi) continue;
          const other = fighters[fj];
          const odx = other.x - f.x;
          const ody = other.y - f.y;
          const odist = Math.sqrt(odx * odx + ody * ody) || 1;
          if (odist > SHOOT_RANGE) continue;
          const ahead = odx * Math.cos(f.angle) + ody * Math.sin(f.angle);
          if (ahead < odist * SHOOT_CONE) continue;
          if (!shootTarget || odist < shootTarget.dist) shootTarget = { index: fj, dist: odist };
        }
        const canShoot = f.fireCooldown <= 0 && shootTarget !== null;
        if (canShoot) {
          const noseX = f.x + Math.cos(f.angle) * 7;
          const noseY = f.y + Math.sin(f.angle) * 7;
          const bulletSpd = 3.5;
          for (let b = 0; b < 4; b++) {
            tracers.push({
              x: noseX + (Math.random() - 0.5) * 2,
              y: noseY + (Math.random() - 0.5) * 2,
              vx: f.vx + Math.cos(f.angle) * bulletSpd + (Math.random() - 0.5) * 0.3,
              vy: f.vy + Math.sin(f.angle) * bulletSpd + (Math.random() - 0.5) * 0.3,
              life: 1,
              shooterIndex: fi,
            });
          }
          f.fireCooldown = 12 + Math.floor(Math.random() * 18);
        }
      }
      // Plane-vs-plane: if collided (too close), explode both and remove
      const PLANE_MIN_DIST = 26;
      const collisionRemove = new Set<number>();
      for (let i = 0; i < fighters.length; i++) {
        if (collisionRemove.has(i)) continue;
        for (let j = i + 1; j < fighters.length; j++) {
          if (collisionRemove.has(j)) continue;
          const a = fighters[i];
          const b = fighters[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
          if (d < PLANE_MIN_DIST) {
            collisionRemove.add(i);
            collisionRemove.add(j);
            crashingPlanes.push(
              { x: a.x, y: a.y, vx: a.vx * 0.92, vy: a.vy + 0.12, angle: a.angle },
              { x: b.x, y: b.y, vx: b.vx * 0.92, vy: b.vy + 0.12, angle: b.angle }
            );
          }
        }
      }
      if (collisionRemove.size > 0) {
        const oldToNew = new Map<number, number>();
        let newIdx = 0;
        for (let o = 0; o < fighters.length; o++) {
          if (!collisionRemove.has(o)) {
            oldToNew.set(o, newIdx);
            newIdx++;
          }
        }
        const newFighters = fighters.filter((_, o) => !collisionRemove.has(o));
        for (let ni = 0; ni < newFighters.length; ni++) {
          const f = newFighters[ni];
          if (collisionRemove.has(f.targetIndex)) {
            f.targetIndex = (ni + 1) % newFighters.length;
          } else {
            f.targetIndex = oldToNew.get(f.targetIndex) ?? 0;
          }
        }
        fighters.length = 0;
        fighters.push(...newFighters);
        for (let ti = tracers.length - 1; ti >= 0; ti--) {
          if (collisionRemove.has(tracers[ti].shooterIndex)) tracers.splice(ti, 1);
        }
      }
      if (fighters.length < 2) {
        while (fighters.length < 4) {
          const n = fighters.length;
          fighters.push({
            x: Math.random() * width,
            y: height * (0.15 + Math.random() * 0.35),
            vx: (Math.random() - 0.5) * 1.2,
            vy: (Math.random() - 0.5) * 0.8,
            angle: Math.random() * Math.PI * 2,
            trail: 0,
            targetIndex: n > 0 ? Math.floor(Math.random() * n) : 0,
            propPhase: Math.random() * Math.PI * 2,
            fireCooldown: Math.floor(Math.random() * 40),
          });
        }
      } else {
        // No collision: separation nudge so they don't overlap
        for (let i = 0; i < fighters.length; i++) {
          for (let j = i + 1; j < fighters.length; j++) {
            const a = fighters[i];
            const b = fighters[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
            if (d < PLANE_MIN_DIST) {
              const overlap = PLANE_MIN_DIST - d;
              const nx = dx / d;
              const ny = dy / d;
              a.x -= nx * overlap * 0.5;
              a.y -= ny * overlap * 0.5;
              b.x += nx * overlap * 0.5;
              b.y += ny * overlap * 0.5;
            }
          }
        }
      }

      const CRASH_GRAVITY = 0.028;
      const CRASH_PITCH_RATE = 0.012;
      const NOSE_DOWN = Math.PI / 2 + 0.15;
      for (let ci = crashingPlanes.length - 1; ci >= 0; ci--) {
        const cp = crashingPlanes[ci];
        cp.vy += CRASH_GRAVITY;
        cp.x += cp.vx;
        cp.y += cp.vy;
        let da = NOSE_DOWN - cp.angle;
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        cp.angle += Math.max(-CRASH_PITCH_RATE, Math.min(CRASH_PITCH_RATE, da));
        const terrainY = getTerrainY(frontTerrain.points, cp.x, width) + craterOffsetAt(cp.x);
        if (cp.y >= terrainY - 6) {
          spawnExplosion(cp.x, terrainY, 0.35, false);
          crashingPlanes.splice(ci, 1);
        }
      }

      for (const t of tracers) {
        ctx.strokeStyle = `rgba(255,${Math.floor(180 + 75 * t.life)},80,${t.life * t.life})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(t.x, t.y);
        ctx.lineTo(t.x - t.vx * 0.4, t.y - t.vy * 0.4);
        ctx.stroke();
      }

      for (const f of fighters) {
        const trailLen = 8 + Math.sin(f.trail) * 2;
        ctx.strokeStyle = 'rgba(100,110,130,0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(f.x, f.y);
        ctx.lineTo(f.x - Math.cos(f.angle) * trailLen, f.y - Math.sin(f.angle) * trailLen);
        ctx.stroke();
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.angle);
        ctx.fillStyle = 'rgba(75,82,95,0.95)';
        ctx.strokeStyle = 'rgba(55,60,72,0.98)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(-2.5, -2.2);
        ctx.lineTo(-1.5, -0.8);
        ctx.lineTo(-3.5, 0);
        ctx.lineTo(-1.5, 0.8);
        ctx.lineTo(-2.5, 2.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        const propBlades = 3;
        ctx.strokeStyle = 'rgba(45,48,55,0.9)';
        ctx.lineWidth = 0.7;
        for (let b = 0; b < propBlades; b++) {
          const a = f.propPhase + (b * Math.PI * 2) / propBlades;
          const r = 1.8;
          ctx.beginPath();
          ctx.moveTo(5.2, 0);
          ctx.lineTo(5.2 + Math.cos(a) * r, Math.sin(a) * r);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(50,52,58,0.95)';
        ctx.beginPath();
        ctx.arc(5.2, 0, 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      for (const cp of crashingPlanes) {
        ctx.save();
        ctx.translate(cp.x, cp.y);
        ctx.rotate(cp.angle);
        ctx.fillStyle = 'rgba(65,70,82,0.9)';
        ctx.strokeStyle = 'rgba(45,50,60,0.95)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(-2.5, -2.2);
        ctx.lineTo(-1.5, -0.8);
        ctx.lineTo(-3.5, 0);
        ctx.lineTo(-1.5, 0.8);
        ctx.lineTo(-2.5, 2.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ffffff';

      const frontTerrainForStars = terrains[2];

      for (const s of shootingStars) {
        if (s.active) {
          const nextX = s.x - s.speed;
          const nextY = s.y + s.speed;
          const terrainY = getTerrainY(frontTerrainForStars.points, nextX, width) + craterOffsetAt(nextX);

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

      const CONSOLE_H = 100;
      const FRAME_INSET_TOP = 28;
      const FRAME_INSET_BOT = 14;
      const FRAME_INSET_SIDE_TOP = 26;
      const FRAME_INSET_SIDE_BOT = 12;
      const nowMs = Date.now();

      function drawTrapezoid(
        x1: number, y1: number, x2: number, y2: number,
        x3: number, y3: number, x4: number, y4: number,
        fillStyle: string, highlightEdges?: boolean
      ) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
        ctx.lineTo(x4, y4);
        ctx.closePath();
        ctx.fillStyle = fillStyle;
        ctx.fill();
        if (highlightEdges) {
          ctx.strokeStyle = 'rgba(180,195,160,0.5)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      const viewTop = FRAME_INSET_TOP;
      const viewBottom = height - CONSOLE_H - FRAME_INSET_BOT;
      const viewLeftTop = FRAME_INSET_SIDE_TOP;
      const viewRightTop = width - FRAME_INSET_SIDE_TOP;
      const viewLeftBot = FRAME_INSET_SIDE_BOT;
      const viewRightBot = width - FRAME_INSET_SIDE_BOT;

      drawTrapezoid(0, 0, width, 0, viewRightTop, viewTop, viewLeftTop, viewTop, 'rgba(42,46,52,0.97)', true);
      drawTrapezoid(viewLeftBot, viewBottom, viewRightBot, viewBottom, width, height, 0, height, 'rgba(38,42,48,0.97)', true);
      drawTrapezoid(0, 0, viewLeftTop, viewTop, viewLeftBot, viewBottom, 0, height, 'rgba(35,38,44,0.97)', true);
      drawTrapezoid(viewRightTop, viewTop, width, 0, width, height, viewRightBot, viewBottom, 'rgba(35,38,44,0.97)', true);
      ctx.strokeStyle = 'rgba(220,235,200,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(viewLeftTop, viewTop);
      ctx.lineTo(viewRightTop, viewTop);
      ctx.lineTo(viewRightBot, viewBottom);
      ctx.lineTo(viewLeftBot, viewBottom);
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(viewLeftTop + 1, viewTop + 1);
      ctx.lineTo(viewRightTop - 1, viewTop + 1);
      ctx.stroke();

      const cTopY = height - CONSOLE_H;
      const cSlant = width * 0.06;
      const cLeftTop = cSlant;
      const cRightTop = width - cSlant;
      const cLeftBot = 0;
      const cRightBot = width;
      const isoDepth = 22;
      const isoX = 0.866;
      const isoY = 0.5;
      const lBackX = cLeftTop - isoDepth * isoX;
      const lBackY = cTopY - isoDepth * isoY;
      const rBackX = cRightTop - isoDepth * isoX;
      const rBackY = cTopY - isoDepth * isoY;
      const lbBackX = cLeftBot - isoDepth * isoX;
      const lbBackY = height - isoDepth * isoY;
      const rbBackX = cRightBot - isoDepth * isoX;
      const rbBackY = height - isoDepth * isoY;

      ctx.beginPath();
      ctx.moveTo(cLeftBot, height);
      ctx.lineTo(cLeftTop, cTopY);
      ctx.lineTo(lBackX, lBackY);
      ctx.lineTo(lbBackX, lbBackY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(14,16,20,0.98)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cRightBot, height);
      ctx.lineTo(cRightTop, cTopY);
      ctx.lineTo(rBackX, rBackY);
      ctx.lineTo(rbBackX, rbBackY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(18,20,24,0.98)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(lBackX, lBackY);
      ctx.lineTo(rBackX, rBackY);
      ctx.lineTo(cRightTop, cTopY);
      ctx.lineTo(cLeftTop, cTopY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(26,28,32,0.98)';
      ctx.fill();
      drawTrapezoid(cLeftTop, cTopY, cRightTop, cTopY, cRightBot, height, cLeftBot, height, 'rgba(22,24,28,0.98)');
      ctx.strokeStyle = 'rgba(70,75,68,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cLeftTop, cTopY);
      ctx.lineTo(cRightTop, cTopY);
      ctx.lineTo(cRightBot, height);
      ctx.lineTo(cLeftBot, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lBackX, lBackY);
      ctx.lineTo(rBackX, rBackY);
      ctx.lineTo(rbBackX, rbBackY);
      ctx.lineTo(lbBackX, lbBackY);
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(cLeftTop + 2, cTopY + 1);
      ctx.lineTo(cRightTop - 2, cTopY + 1);
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cLeftTop, cTopY);
      ctx.lineTo(cRightTop, cTopY);
      ctx.lineTo(cRightBot, height);
      ctx.lineTo(cLeftBot, height);
      ctx.closePath();
      ctx.clip();
      const gritCount = 280;
      for (let g = 0; g < gritCount; g++) {
        const seed = (g * 1277 + nowMs * 0.02) % 1e4;
        const px = cLeftTop + (seed * 13.7) % (width - cSlant * 2);
        const py = cTopY + ((seed * 31.1) % (CONSOLE_H - 4));
        const size = 0.8 + (seed * 0.7) % 1.2;
        const alpha = 0.06 + (seed * 0.12) % 0.14;
        ctx.fillStyle = `rgba(12,14,18,${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let g = 0; g < 120; g++) {
        const seed = (g * 331 + nowMs * 0.01) % 1e4;
        const px = cLeftTop + (seed * 17.3) % (width - cSlant * 2);
        const py = cTopY + ((seed * 41) % (CONSOLE_H - 4));
        ctx.strokeStyle = `rgba(8,10,12,${0.04 + (seed * 0.08) % 0.06})`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + (seed % 3) - 1, py + ((seed * 2) % 3) - 1);
        ctx.stroke();
      }
      ctx.restore();

      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      const screenLabels = ['LINK', 'SIGNAL', 'AWBW', 'STATUS', 'TAPE'];
      const numScreens = 5;
      const RED_HIGHLIGHT_INTERVAL_MS = 3200;
      const activeTerminalIndex = Math.floor(nowMs / RED_HIGHLIGHT_INTERVAL_MS) % numScreens;
      const screenH = 38;
      const screenTop = cTopY + 12;
      const screenSlant = 3;
      const TERMINAL_LINE_HEIGHT = 8;
      const TERMINAL_ADD_MS = 380;
      for (let i = 0; i < numScreens; i++) {
        if (nowMs - terminalLastAdd[i] >= TERMINAL_ADD_MS) {
          const pool = TERMINAL_LINE_POOL[i];
          terminalLines[i].push(pool[Math.floor((nowMs * 0.02 + i * 7) % pool.length)]);
          if (terminalLines[i].length > 6) terminalLines[i].shift();
          terminalLastAdd[i] = nowMs;
        }
      }
      for (let i = 0; i < numScreens; i++) {
        const left = lerp(cLeftTop + 18, cRightTop - 18, (i + 0.1) / numScreens);
        const right = lerp(cLeftTop + 18, cRightTop - 18, (i + 0.9) / numScreens);
        const w = (right - left) * 0.92;
        const cx = (left + right) / 2;
        const sl = cx - w / 2;
        const sr = cx + w / 2;
        const st = screenTop;
        const sb = screenTop + screenH;
        ctx.fillStyle = 'rgba(10,12,10,0.98)';
        ctx.beginPath();
        ctx.moveTo(sl, st);
        ctx.lineTo(sr, st);
        ctx.lineTo(sr + screenSlant, sb);
        ctx.lineTo(sl - screenSlant, sb);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(55,60,50,0.4)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(sl + 2, st + 2);
        ctx.lineTo(sr - 2, st + 2);
        ctx.lineTo(sr + screenSlant - 2, sb - 2);
        ctx.lineTo(sl - screenSlant + 2, sb - 2);
        ctx.closePath();
        ctx.clip();
        const scrollY = (nowMs / 90) % TERMINAL_LINE_HEIGHT;
        const lines = terminalLines[i];
        ctx.font = '7px monospace';
        ctx.textAlign = 'left';
        for (let L = lines.length - 1; L >= 0; L--) {
          const lineY = sb - 4 - scrollY - (lines.length - 1 - L) * TERMINAL_LINE_HEIGHT;
          if (lineY < st + 2) continue;
          const phosphor = 0.6 + 0.15 * Math.sin(nowMs * 0.003 + L);
          ctx.fillStyle = `rgba(72,${Math.floor(95 * phosphor)},62,${0.45 + 0.1 * phosphor})`;
          ctx.fillText(lines[L], sl + 4, lineY);
        }
        const cursorY = sb - 4 - scrollY;
        if (cursorY >= st + 2 && cursorY <= sb - 2 && Math.floor(nowMs / 400) % 2 === 0) {
          ctx.fillStyle = 'rgba(85,110,75,0.5)';
          ctx.fillRect(sl + 4, cursorY - 5, 4, 6);
        }
        ctx.restore();
        if (i === activeTerminalIndex) {
          ctx.strokeStyle = 'rgba(160,175,190,0.65)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(sl, st);
          ctx.lineTo(sr, st);
          ctx.lineTo(sr + screenSlant, sb);
          ctx.lineTo(sl - screenSlant, sb);
          ctx.closePath();
          ctx.stroke();
          const specX1 = sl + 6;
          const specY1 = st + 4;
          const specX2 = sr - 10;
          const specY2 = st + 5;
          const pulse = 0.5 + 0.3 * Math.sin(nowMs * 0.002);
          ctx.fillStyle = `rgba(255,255,255,${0.12 * pulse})`;
          ctx.beginPath();
          ctx.ellipse(specX1, specY1, 4, 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(255,255,255,${0.08 * pulse})`;
          ctx.beginPath();
          ctx.ellipse(specX2, specY2, 5, 2.5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `rgba(200,210,220,${0.25 * pulse})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(sl + 2, st + 1);
          ctx.lineTo(sr - 2, st + 1);
          ctx.stroke();
          ctx.fillStyle = 'rgba(180,195,210,0.7)';
          ctx.font = '7px monospace';
          ctx.textAlign = 'right';
          const labels = ['LINK', 'SYNC', 'ACT', 'RDY', 'ON'];
          ctx.fillText(`● ${labels[i % labels.length]}`, sr - 4, sb - 5);
        }
      }
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
