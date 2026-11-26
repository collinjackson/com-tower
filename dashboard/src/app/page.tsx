// Com Tower — static "Field Orders" memo: a typed WW2-era briefing on aged paper.
// The animated night-battle background lives in layout.tsx (BackgroundCanvas); this page is a
// static briefing pinned over it. No auth, no client state.

import { DashRule } from './components/DashRule';
import { FieldOrders } from './components/FieldOrders';

const SELF_HOST_GUIDE =
  'https://github.com/collinjackson/com-tower/blob/main/SELF_HOST.md';

// How people reach the bot: its Signal username, never its phone number. Overridable per
// deployment (self-hosters run their own bot account).
//
// TODO(owner): fill in the shared instance's Signal username (e.g. "comtower.01"), here or via
// NEXT_PUBLIC_SIGNAL_USERNAME on Vercel. Until then the page says the username is coming soon.
const SIGNAL_USERNAME = process.env.NEXT_PUBLIC_SIGNAL_USERNAME || '';
// The account's username link, copied from Signal (Profile > Username > QR code or link). It looks
// like https://signal.me/#eu/<opaque code>: Signal makes the code, so it can't be built from the
// username. Optional; without it the username is shown as plain text.
const SIGNAL_USERNAME_LINK = process.env.NEXT_PUBLIC_SIGNAL_USERNAME_LINK || '';

const BOT_CONTACT: React.ReactNode = !SIGNAL_USERNAME ? (
  <span className="text-[#7c2d12] font-semibold">Com Tower</span>
) : SIGNAL_USERNAME_LINK ? (
  <a
    href={SIGNAL_USERNAME_LINK}
    target="_blank"
    rel="noopener noreferrer"
    className="text-[#7c2d12] font-semibold no-underline hover:text-[#a8481a] transition-colors"
  >
    Com Tower ({SIGNAL_USERNAME})
  </a>
) : (
  <span className="text-[#7c2d12] font-semibold">Com Tower ({SIGNAL_USERNAME})</span>
);

// Short roster only — /help points to the rest.
const COMMANDS: Array<[string, string]> = [
  ['/game <link>', 'bind this chat to an AWBW game (mod)'],
  ['/iam <awbw_name>', 'get an @ping on your turn (optional)'],
  ['/setplayer @x <name>', '@ping a member on their turn (mod)'],
  ['/stop', 'stand down (mod)'],
  ['/help', 'see full list of commands'],
];

const STEPS: Array<[string, React.ReactNode]> = [
  ['1', <>Message {BOT_CONTACT} on Signal{SIGNAL_USERNAME ? '' : ' (username coming soon)'}, then add it to your game&rsquo;s Signal group chat — or just keep the one-on-one chat; that works too.</>],
  ['2', <>In that chat, run <code className="text-[#7c2d12] font-bold">/game &lt;AWBW link&gt;</code> to bind the game. Whoever runs it first becomes the <span className="text-[#2b2412] font-semibold">mod</span>.</>],
  ['3', 'Com Tower watches the game and posts to the chat on every turn.'],
  ['4', <><span className="text-[#6b5a35]">Optional:</span> a player runs <code className="text-[#7c2d12] font-bold">/iam &lt;awbw_username&gt;</code> for a personal @ping on their turn.</>],
];

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
    <div className="min-h-screen flex items-center justify-center px-4 sm:px-8 py-16 text-[#43371f]">
      {/* The memo — one typewriter size, uniform kerning; rules are whole runs of typed hyphens.
          Dismissible: filing it away clears the view down to the console gallery below. */}
      <FieldOrders>
      <main className="ct-paper relative w-full max-w-xl rounded-[2px] overflow-hidden font-mono text-[13px] leading-[1.65]">
        <div className="px-6 sm:px-9 py-7">
          {/* letterhead + memo header block */}
          <div className="uppercase text-[#6b5a35]">Com Tower — Field Orders</div>
          <DashRule />
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
          <DashRule />

          {/* deployment */}
          <div className="uppercase text-[#6b5a35]">Operation — Deploy the Bot</div>
          <ol className="mt-1 space-y-1.5">
            {STEPS.map(([n, text]) => (
              <li key={n} className="flex gap-2">
                <span className="shrink-0 font-bold text-[#7c2d12]">{n}.</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          <DashRule />

          {/* command roster */}
          <div className="uppercase text-[#6b5a35]">Command Roster</div>
          <div className="mt-1 space-y-1">
            {COMMANDS.map(([cmd, desc]) => (
              <div key={cmd} className="flex flex-col sm:flex-row sm:gap-2">
                <code className="shrink-0 font-bold text-[#7c2d12] whitespace-nowrap">{cmd}</code>
                <span className="text-[#5c4d30]">— {desc}</span>
              </div>
            ))}
          </div>
          <DashRule />

          <p className="text-[#5c4d30]">
            Running many games?{' '}
            <a
              href={SELF_HOST_GUIDE}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#8a3a12] font-bold no-underline hover:text-[#a8481a] transition-colors"
            >
              Host your own Com Tower
            </a>{' '}
            — fork the repo, set your env vars, and run your own Signal account.
          </p>
        </div>
      </main>
      </FieldOrders>
    </div>
  );
}
