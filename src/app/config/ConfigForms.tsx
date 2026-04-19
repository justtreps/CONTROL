"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type TestAccount = {
  id: number;
  platform: string;
  username: string;
  userId: string;
  active: boolean;
};

type Props = {
  initialBulkmedyaSet: boolean;
  initialRapidApiSet: boolean;
  testAccounts: TestAccount[];
  serviceCount: number;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-neutral-200 rounded-lg p-6">
      <h2 className="font-medium mb-4">{title}</h2>
      {children}
    </section>
  );
}

export function ConfigForms({
  initialBulkmedyaSet,
  initialRapidApiSet,
  testAccounts,
  serviceCount,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [bulkmedyaKey, setBulkmedyaKey] = useState("");
  const [rapidApiKey, setRapidApiKey] = useState("");
  const [keysMsg, setKeysMsg] = useState<string | null>(null);
  const [bulkmedyaSet, setBulkmedyaSet] = useState(initialBulkmedyaSet);
  const [rapidSet, setRapidSet] = useState(initialRapidApiSet);

  const [platform, setPlatform] = useState<"instagram" | "tiktok">("instagram");
  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState("");
  const [accountMsg, setAccountMsg] = useState<string | null>(null);

  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const [testBotResult, setTestBotResult] = useState<string | null>(null);
  const [testBotRunning, setTestBotRunning] = useState(false);
  const [scraperResult, setScraperResult] = useState<string | null>(null);
  const [scraperRunning, setScraperRunning] = useState(false);
  const [scoringResult, setScoringResult] = useState<string | null>(null);
  const [scoringRunning, setScoringRunning] = useState(false);

  async function saveKeys(e: React.FormEvent) {
    e.preventDefault();
    setKeysMsg(null);
    const res = await fetch("/api/config/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bulkmedyaKey: bulkmedyaKey || undefined,
        rapidApiKey: rapidApiKey || undefined,
      }),
    });
    if (res.ok) {
      if (bulkmedyaKey) setBulkmedyaSet(true);
      if (rapidApiKey) setRapidSet(true);
      setBulkmedyaKey("");
      setRapidApiKey("");
      setKeysMsg("Clés sauvegardées.");
    } else {
      setKeysMsg("Erreur lors de la sauvegarde.");
    }
  }

  async function addAccount(e: React.FormEvent) {
    e.preventDefault();
    setAccountMsg(null);
    const res = await fetch("/api/config/test-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, username, userId }),
    });
    if (res.ok) {
      setUsername("");
      setUserId("");
      setAccountMsg("Compte ajouté.");
      startTransition(() => router.refresh());
    } else {
      const data = await res.json().catch(() => ({}));
      setAccountMsg(data.error ?? "Erreur.");
    }
  }

  async function removeAccount(id: number) {
    await fetch(`/api/config/test-accounts?id=${id}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  async function syncServices() {
    setSyncing(true);
    setSyncResult(null);
    const res = await fetch("/api/config/sync-services", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      setSyncResult(
        `OK — ${data.total} services (${data.created} créés, ${data.updated} mis à jour, ${data.deactivated} désactivés).`
      );
      startTransition(() => router.refresh());
    } else {
      setSyncResult(`Erreur : ${data.error ?? "inconnue"}`);
    }
    setSyncing(false);
  }

  async function runTestBot() {
    setTestBotRunning(true);
    setTestBotResult(null);
    const res = await fetch("/api/config/run-test-bot", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      const errs = data.errors?.length ? ` — ${data.errors.length} erreurs` : "";
      setTestBotResult(
        `${data.placed}/${data.attempted} commandes placées (${data.skipped} skip)${errs}`
      );
      startTransition(() => router.refresh());
    } else {
      setTestBotResult(`Erreur : ${data.error ?? "inconnue"}`);
    }
    setTestBotRunning(false);
  }

  async function runScraper() {
    setScraperRunning(true);
    setScraperResult(null);
    const res = await fetch("/api/config/run-scraper", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      const errs = data.errors?.length ? ` — ${data.errors.length} erreurs` : "";
      setScraperResult(
        `${data.measurements} measurements sur ${data.ordersScanned}/${data.ordersSeen} orders${errs}`
      );
      startTransition(() => router.refresh());
    } else {
      setScraperResult(`Erreur : ${data.error ?? "inconnue"}`);
    }
    setScraperRunning(false);
  }

  async function runScoring() {
    setScoringRunning(true);
    setScoringResult(null);
    const res = await fetch("/api/config/run-scoring", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      setScoringResult(
        `${data.servicesScored} services scorés (${data.servicesSkipped} skip, aucune data)`
      );
      startTransition(() => router.refresh());
    } else {
      setScoringResult(`Erreur : ${data.error ?? "inconnue"}`);
    }
    setScoringRunning(false);
  }

  return (
    <>
      <Section title="Clés API">
        <form onSubmit={saveKeys} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700">
              BulkMedya API key{" "}
              <span className="text-neutral-400 font-normal">
                ({bulkmedyaSet ? "configurée" : "non configurée"})
              </span>
            </label>
            <input
              type="password"
              value={bulkmedyaKey}
              onChange={(e) => setBulkmedyaKey(e.target.value)}
              placeholder={bulkmedyaSet ? "Laisser vide pour ne pas changer" : "Coller la clé"}
              className="mt-1 block w-full rounded-md border-neutral-300 border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700">
              RapidAPI key{" "}
              <span className="text-neutral-400 font-normal">
                ({rapidSet ? "configurée" : "non configurée"})
              </span>
            </label>
            <input
              type="password"
              value={rapidApiKey}
              onChange={(e) => setRapidApiKey(e.target.value)}
              placeholder={rapidSet ? "Laisser vide pour ne pas changer" : "Coller la clé"}
              className="mt-1 block w-full rounded-md border-neutral-300 border px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            className="bg-neutral-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-neutral-800"
          >
            Enregistrer
          </button>
          {keysMsg && <p className="text-sm text-neutral-600">{keysMsg}</p>}
        </form>
      </Section>

      <Section title={`Sync services BulkMedya (${serviceCount} en DB)`}>
        <p className="text-sm text-neutral-600 mb-4">
          Récupère la liste complète des services BulkMedya et classe chaque
          service (platform + type) à partir de son nom. À relancer si BulkMedya
          ajoute/retire des services.
        </p>
        <button
          type="button"
          onClick={syncServices}
          disabled={syncing || !bulkmedyaSet}
          className="bg-neutral-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
        >
          {syncing ? "Synchronisation..." : "Sync services maintenant"}
        </button>
        {!bulkmedyaSet && (
          <p className="text-sm text-neutral-500 mt-2">
            Configure d&apos;abord la clé BulkMedya.
          </p>
        )}
        {syncResult && <p className="text-sm mt-3">{syncResult}</p>}
      </Section>

      <Section title="Lancer manuellement (debug / test end-to-end)">
        <p className="text-sm text-neutral-600 mb-4">
          En prod, un cron Vercel déclenche ces jobs automatiquement (hourly
          pour le test bot, every 5 min pour le scraper). Utilise ces boutons
          pour un test immédiat.
        </p>
        <div className="flex flex-wrap gap-3">
          <div>
            <button
              type="button"
              onClick={runTestBot}
              disabled={testBotRunning || !bulkmedyaSet || !rapidSet}
              className="bg-neutral-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
            >
              {testBotRunning ? "Test bot..." : "Run test bot"}
            </button>
            {testBotResult && (
              <p className="text-sm mt-2 text-neutral-700">{testBotResult}</p>
            )}
          </div>
          <div>
            <button
              type="button"
              onClick={runScraper}
              disabled={scraperRunning || !rapidSet}
              className="bg-neutral-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
            >
              {scraperRunning ? "Scraper..." : "Run scraper"}
            </button>
            {scraperResult && (
              <p className="text-sm mt-2 text-neutral-700">{scraperResult}</p>
            )}
          </div>
          <div>
            <button
              type="button"
              onClick={runScoring}
              disabled={scoringRunning}
              className="bg-neutral-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
            >
              {scoringRunning ? "Scoring..." : "Run scoring"}
            </button>
            {scoringResult && (
              <p className="text-sm mt-2 text-neutral-700">{scoringResult}</p>
            )}
          </div>
        </div>
        {(!bulkmedyaSet || !rapidSet) && (
          <p className="text-sm text-neutral-500 mt-3">
            Configure les clés BulkMedya + RapidAPI avant de lancer les jobs.
          </p>
        )}
      </Section>

      <Section title={`Comptes test (${testAccounts.length})`}>
        <form onSubmit={addAccount} className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-6">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as "instagram" | "tiktok")}
            className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
          >
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
          </select>
          <input
            required
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
          />
          <input
            required
            placeholder="user_id (numeric)"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={pending}
            className="bg-neutral-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
          >
            Ajouter
          </button>
        </form>
        {accountMsg && <p className="text-sm text-neutral-600 mb-3">{accountMsg}</p>}
        {testAccounts.length === 0 ? (
          <p className="text-sm text-neutral-500">Aucun compte test.</p>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {testAccounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <span className="font-medium">{a.platform}</span>
                  <span className="ml-3 text-neutral-700">@{a.username}</span>
                  <span className="ml-3 text-neutral-400">id:{a.userId}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeAccount(a.id)}
                  className="text-red-600 hover:text-red-700"
                >
                  Supprimer
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
