// Com Tower — static "Field Orders" memo: a typed WW2-era briefing on aged paper, resting on the
// airmail envelope it arrived in. The animated night-battle background lives in layout.tsx
// (BackgroundCanvas); this page is a static briefing pinned over it. No auth, no client state.

const BOT_NUMBER = '+1 (904) 878-1337';

// Short roster only — /help points to the rest.
const COMMANDS: Array<[string, string]> = [
  ['/game <link>', 'bind this group to an AWBW game (mod)'],
  ['/iam <awbw_name>', 'get an @ping on your turn (optional)'],
  ['/setplayer @x <name>', '@ping a member on their turn (mod)'],
  ['/stop', 'stand down (mod)'],
  ['/help', 'see full list of commands'],
];

const STEPS: Array<[string, React.ReactNode]> = [
  ['1', 'Create a Signal group for your game.'],
  ['2', <>Invite <span className="text-[#7c2d12] font-semibold">Com Tower ({BOT_NUMBER})</span> into the group, along with the other players.</>],
  ['3', <>In the group, run <code className="text-[#7c2d12] font-bold">/game &lt;AWBW link&gt;</code>. Whoever runs it first becomes the group&rsquo;s <span className="text-[#2b2412] font-semibold">mod</span>, and the bot posts there every turn.</>],
  ['4', <><span className="text-[#6b5a35]">Optional:</span> a player runs <code className="text-[#7c2d12] font-bold">/iam &lt;awbw_username&gt;</code> for a personal @ping on their turn — otherwise just turn on notifications for the group.</>],
];

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 sm:px-8 py-16 text-[#37301d]">
      <div className="relative w-full max-w-xl">
        {/* The airmail envelope it came in — slightly larger, tucked behind the memo. */}
        <div
          aria-hidden
          className="ct-envelope absolute -left-3 -right-3 -top-[4.25rem] -bottom-5 sm:-left-6 sm:-right-6 sm:-top-[4.75rem] sm:-bottom-7 rotate-[1.4deg]"
        >
          {/* return address */}
          <div className="absolute top-3 left-3 sm:left-5 font-mono uppercase text-[9px] sm:text-[10px] leading-[1.55] tracking-[0.12em] text-[#4b3a1c]">
            Com Tower<br />Signal Corps · A.P.O. 1945
          </div>
          {/* postmark + stamp, top-right */}
          <div className="absolute top-2 right-2.5 sm:right-4 flex items-start gap-1">
            <div className="ct-postmark relative mt-1.5 w-11 h-11 sm:w-12 sm:h-12 flex flex-col items-center justify-center text-center font-mono text-[6px] sm:text-[7px] uppercase tracking-wider leading-[1.35] -rotate-[9deg]">
              <span>Com·Tower</span>
              <span className="font-bold text-[8px] leading-none my-px">1945</span>
              <span>Signal</span>
            </div>
            <div className="ct-stamp w-9 h-11 sm:w-10 sm:h-12 rounded-[2px] rotate-[3deg] flex flex-col items-center justify-center leading-none">
              <span className="text-[6px] uppercase tracking-wide">Air Mail</span>
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 my-0.5">
                <path d="M2 12l19-7-7 19-2.8-7.4L2 12z" />
              </svg>
              <span className="text-[6px]">1¢</span>
            </div>
          </div>
        </div>

        {/* The memo — aged typed paper. */}
        <main className="ct-paper relative rounded-[8px] overflow-hidden font-mono rotate-[-0.5deg]">
          <header className="relative px-6 sm:px-8 pt-6 pb-4 border-b-2 border-double border-[#a5906180]">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.22em] text-[#6b5a35]">
              <span>Com Tower</span>
              <span>Field Orders</span>
            </div>
            <h1 className="mt-2 text-xl sm:text-2xl font-bold tracking-tight text-[#2b2412]">
              AWBW turn notifications, over Signal
            </h1>
            <p className="mt-1 text-xs text-[#5c4d30]">
              RE: get @-mentioned in your game&rsquo;s group chat when it&rsquo;s your turn.
            </p>
            {/* rubber ink stamp */}
            <div className="ct-rubber absolute top-4 right-4 sm:right-7 px-2 py-1 text-[10px] sm:text-xs font-bold uppercase tracking-[0.18em] rotate-[7deg] select-none">
              Confidential
            </div>
          </header>

          {/* Deploy steps */}
          <section className="px-6 sm:px-8 py-5 space-y-3">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#6b5a35]">Deploying the bot</h2>
            <ol className="space-y-2.5">
              {STEPS.map(([n, text]) => (
                <li key={n} className="flex gap-3 text-sm leading-relaxed text-[#43371f]">
                  <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full border border-[#8a7038] bg-[#f0e7cf] text-[#7c2d12] text-[11px] font-bold flex items-center justify-center">
                    {n}
                  </span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
          </section>

          {/* Command roster */}
          <section className="px-6 sm:px-8 pb-6 pt-4 border-t-2 border-double border-[#a5906180] space-y-2.5">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#6b5a35]">Command roster</h2>
            <div className="rounded-[4px] border border-[#b09a6a] bg-[#efe6cd99] divide-y divide-[#b09a6a80]">
              {COMMANDS.map(([cmd, desc]) => (
                <div key={cmd} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 px-4 py-2">
                  <code className="text-[#7c2d12] font-bold text-sm whitespace-nowrap">{cmd}</code>
                  <span className="text-xs text-[#5c4d30]">{desc}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-[#6b5a35]">
              Mappings and turn pings all live in the group chat — no phone numbers to enter, no sign-in.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
