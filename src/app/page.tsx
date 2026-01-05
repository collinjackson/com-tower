export default function Home() {
  return (
    <div className="min-h-screen bg-black text-zinc-100 flex items-center justify-center">
      <main className="w-full max-w-3xl px-6 py-16 flex flex-col gap-10">
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Com Tower</p>
          <h1 className="text-3xl font-semibold">AWBW turn notifications</h1>
          <p className="text-sm text-zinc-400">
            Patch a game, link your Signal channel, and get turn alerts. One-click, no strategy UI.
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">
          <p className="text-zinc-200 font-semibold mb-1">Placeholder</p>
          <p>This home page will route to the Com Tower flow once wired.</p>
        </div>

        <footer className="pt-4 border-t border-zinc-900 text-xs text-zinc-500 flex items-center gap-3">
          <a
            href="https://github.com/your-github/com-tower"
            target="_blank"
            rel="noreferrer"
            className="hover:text-zinc-200"
          >
            GitHub
          </a>
          <span>•</span>
          <span>MIT/GPL TBD</span>
        </footer>
      </main>
    </div>
  );
}
