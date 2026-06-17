// Com Tower — static "Field Orders" memo.
// The animated night-battle background lives in layout.tsx (BackgroundCanvas);
// this page is a static briefing pinned over it. No auth, no client state.

const BOT_NUMBER = '+1 (904) 878-1337';

const COMMANDS: Array<[string, string]> = [
  ['/game <link>', 'bind this group to an AWBW game (mod)'],
  ['/iam <awbw_name>', 'get an @ping on your turn (optional)'],
  ['/setplayer @x <name>', '@ping a member on their turn (mod, optional)'],
  ['/players', 'show the roster'],
  ['/addmod @x', 'make someone a mod (mod)'],
  ['/fun [on|off]', 'flavor text (mod)'],
  ['/status', 'current orders'],
  ['/stop', 'stand down (mod)'],
  ['/help', 'show the command roster'],
];

const STEPS: Array<[string, React.ReactNode]> = [
  ['1', 'Create a Signal group for your game.'],
  ['2', <>Open <span className="text-zinc-200">Group settings → Group link</span>, enable it, and copy the link.</>],
  ['3', <>Send that link to <span className="text-amber-300">Com Tower ({BOT_NUMBER})</span> in a Signal message — it joins automatically, and you become the group&rsquo;s <span className="text-zinc-200">mod</span>.</>],
  ['4', <>In the group, run <code className="text-emerald-300">/game &lt;AWBW link&gt;</code>. The bot posts there every turn.</>],
  ['5', <><span className="text-zinc-400">Optional:</span> a player runs <code className="text-emerald-300">/iam &lt;awbw_username&gt;</code> to get a personal @ping on their turn — otherwise just turn on notifications for the group.</>],
];

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 sm:px-8 py-10 text-zinc-100">
      <main className="w-full max-w-2xl backdrop-blur-xl bg-white/10 rounded-3xl border border-white/10 shadow-2xl overflow-hidden font-mono">
        {/* Memo header */}
        <header className="border-b border-white/10 px-6 sm:px-8 py-5 bg-black/20">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-zinc-400">
            <span>Com Tower</span>
            <span className="text-amber-400/80">Field Orders</span>
          </div>
          <h1 className="mt-2 text-xl sm:text-2xl font-semibold tracking-tight text-white">
            AWBW turn notifications, over Signal
          </h1>
          <p className="mt-1 text-xs text-zinc-400">
            RE: get @-mentioned in your game&rsquo;s group chat when it&rsquo;s your turn.
          </p>
        </header>

        {/* Deploy steps */}
        <section className="px-6 sm:px-8 py-6 space-y-4">
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Deploying the bot</h2>
          <ol className="space-y-3">
            {STEPS.map(([n, text]) => (
              <li key={n} className="flex gap-3 text-sm leading-relaxed text-zinc-300">
                <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[11px] flex items-center justify-center">
                  {n}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Command roster */}
        <section className="px-6 sm:px-8 py-6 border-t border-white/10 space-y-3">
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Command roster</h2>
          <div className="rounded-xl border border-white/10 bg-black/30 divide-y divide-white/5">
            {COMMANDS.map(([cmd, desc]) => (
              <div key={cmd} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 px-4 py-2.5">
                <code className="text-emerald-300 text-sm whitespace-nowrap">{cmd}</code>
                <span className="text-xs text-zinc-400">{desc}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            Mappings and turn pings all live in the group chat — no phone numbers to enter, no sign-in.
          </p>
        </section>
      </main>
    </div>
  );
}
