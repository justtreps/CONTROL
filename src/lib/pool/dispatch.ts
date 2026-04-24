// Shared worker-dispatch helper used by every manual trigger endpoint
// that creates a PoolJob row and fires the execute + runner workers.
//
// Why this exists (Bug #58 context):
//   The original `void fetch(url, { keepalive: true }).catch(...)`
//   pattern was unreliable on Vercel function-to-function calls.
//   Observation: a scrape manual trigger at 05:45:37 saw 0 progress
//   for ~5 minutes until the every-5-min runner cron noticed. The
//   engagement-fill dispatcher used the exact same code and worked
//   — probably a cold-lambda / keepalive-eviction race that only
//   hit scrape in practice. Instead of hoping, we now explicitly
//   AWAIT a short grace window so Vercel keeps the caller alive
//   long enough for the TCP handshakes to fully flush into the
//   target function instances.
//
//   graceMs defaults to 1500ms. Real handshakes land in ~200ms, so
//   1.5s is 7× the expected wall-time and adds less than 2s to the
//   outer endpoint latency (still well inside the maxDuration=10
//   budget of every dispatcher endpoint).

const DEFAULT_GRACE_MS = 1500;

export type DispatchWorkerPairOpts = {
  executeUrl: string;
  runnerUrl: string;
  cronSecret: string | undefined;
  jobLabel: string;
  graceMs?: number;
};

export async function dispatchWorkerPair(
  opts: DispatchWorkerPairOpts
): Promise<void> {
  const auth = { Authorization: `Bearer ${opts.cronSecret ?? ""}` };

  const fire = (url: string, role: "execute" | "runner") =>
    fetch(url, {
      method: "POST",
      headers: auth,
      // keepalive is still requested for the edge case where our
      // grace timeout fires before the target function accepts —
      // Vercel should keep the socket open until flushed.
      keepalive: true,
    })
      .then(() => {
        /* target runs for ~280s; we don't care about its response */
      })
      .catch((e) => {
        console.error(
          `[${opts.jobLabel}] ${role} dispatch error:`,
          (e as Error).message
        );
      });

  const dispatches = Promise.all([
    fire(opts.executeUrl, "execute"),
    fire(opts.runnerUrl, "runner"),
  ]);

  // Race the actual dispatches against a short grace timer. We
  // win as soon as EITHER:
  //   • the targets both returned (unlikely — they run 280s), or
  //   • the grace window elapsed (expected).
  // Hitting the timeout is the normal flow: by then the request
  // headers have been written, the target function is alive, and
  // we can safely return to the caller.
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  await Promise.race([
    dispatches,
    new Promise<void>((r) => setTimeout(r, grace)),
  ]);
}
