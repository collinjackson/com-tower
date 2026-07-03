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

// A typed hyphen rule — clipped to the paper width so it reads like a line of typewriter dashes.
function Rule() {
  return (
    <div aria-hidden className="my-2.5 overflow-hidden whitespace-nowrap leading-none text-[#9c8043] select-none">
      {'-'.repeat(240)}
    </div>
  );
}

// A memo header field with an aligned label column (typewriter tab stop).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex">
      <span className="w-24 shrink-0 text-[#6b5a35]">{label}</span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 sm:px-8 py-16 text-[#37301d]">
      <div className="relative w-full max-w-xl">
        {/* The manila envelope it came in — about letter-sized; the memo overlaps it so only the
            edges peek out. */}
        <div
          aria-hidden
          className="ct-envelope absolute -inset-2 sm:-inset-3 rounded-[9px] rotate-[1.4deg]"
        />

        {/* The memo — one typewriter size throughout; every rule is a line of typed hyphens. */}
        <main className="ct-paper relative rounded-[8px] overflow-hidden font-mono rotate-[-0.5deg] text-[13px] leading-[1.65] text-[#43371f]">
          {/* classification stamp, tucked in the corner (clear of the letterhead) */}
          <div className="ct-rubber absolute top-3 right-3 sm:right-5 px-2 py-1 font-bold uppercase tracking-[0.18em] rotate-[6deg] select-none">
            Eyes Only
          </div>

          <div className="px-6 sm:px-9 py-7">
            {/* letterhead + memo header block */}
            <div className="uppercase tracking-[0.18em] text-[#6b5a35]">Com Tower — Field Orders</div>
            <Rule />
            <Field label="FROM">Com Tower, Signal Corps</Field>
            <Field label="TO">All Field Commanders</Field>
            <Field label="RE">
              <a
                href="https://awbw.amarriner.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#8a3a12] font-bold no-underline hover:text-[#a8481a] transition-colors"
              >
                AWBW
              </a>{' '}
              turn notifications, over Signal
            </Field>
            <Field label="PRIORITY">Urgent</Field>
            <Rule />

            {/* deployment */}
            <div className="uppercase tracking-[0.18em] text-[#6b5a35]">Operation — Deploy the Bot</div>
            <ol className="mt-1 space-y-1.5">
              {STEPS.map(([n, text]) => (
                <li key={n} className="flex gap-2">
                  <span className="shrink-0 font-bold text-[#7c2d12]">{n}.</span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
            <Rule />

            {/* command roster */}
            <div className="uppercase tracking-[0.18em] text-[#6b5a35]">Command Roster</div>
            <div className="mt-1 space-y-1">
              {COMMANDS.map(([cmd, desc]) => (
                <div key={cmd} className="flex flex-col sm:flex-row sm:gap-2">
                  <code className="shrink-0 font-bold text-[#7c2d12] whitespace-nowrap">{cmd}</code>
                  <span className="text-[#5c4d30]">— {desc}</span>
                </div>
              ))}
            </div>
            <Rule />

            <p className="text-[#6b5a35]">
              Mappings and turn pings all live in the group chat — no phone numbers to enter, no sign-in.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
