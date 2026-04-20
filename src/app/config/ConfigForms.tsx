"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";
import { useActivity } from "@/components/ActivityContext";

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
};

const INPUT =
  "interactive bg-transparent border border-[#666666]/30 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/60 outline-none transition-colors";

const BTN_PATTERN_B =
  "interactive group relative w-full border border-[#666666]/30 bg-[#0D0D0D] py-3 px-5 overflow-hidden flex justify-between items-center text-left disabled:opacity-60";

const BTN_PATTERN_B_INNER =
  "relative font-mono text-xs tracking-widest text-white z-10 group-hover:text-black transition-colors duration-300";

const BTN_PATTERN_B_OVERLAY =
  "absolute inset-0 bg-[#FF3300] transform translate-y-full group-hover:translate-y-0 transition-transform duration-500 ease-out z-0";

function CardHeader({ icon, num }: { icon: string; num: string }) {
  return (
    <div className="absolute top-6 right-6 md:top-8 md:right-8 flex items-center gap-3">
      <span className="font-mono text-xs text-[#666666] tracking-widest">
        {num}
      </span>
      <iconify-icon icon={icon} width="22" height="22" className="text-[#666666]" />
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="brand font-display text-2xl uppercase tracking-tight text-white mt-12 mb-6">
      {children}
    </h3>
  );
}

export function ConfigForms({
  initialBulkmedyaSet,
  initialRapidApiSet,
  testAccounts,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { show: showLoading, hide: hideLoading } = useLoading();
  const { flash } = useActivity();

  const [bulkmedyaKey, setBulkmedyaKey] = useState("");
  const [rapidApiKey, setRapidApiKey] = useState("");
  const [keysMsg, setKeysMsg] = useState<string | null>(null);
  const [bulkmedyaSet, setBulkmedyaSet] = useState(initialBulkmedyaSet);
  const [rapidSet, setRapidSet] = useState(initialRapidApiSet);

  const [platform, setPlatform] = useState<"instagram" | "tiktok">("instagram");
  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState("");
  const [accountMsg, setAccountMsg] = useState<string | null>(null);

  const [trigger, setTrigger] = useState<{
    name: string;
    msg: string;
  } | null>(null);

  const [orderPlatform, setOrderPlatform] = useState("instagram");
  const [orderType, setOrderType] = useState("followers");
  const [orderQuantity, setOrderQuantity] = useState("100");
  const [orderTargetUrl, setOrderTargetUrl] = useState(
    "https://www.instagram.com/example/"
  );
  const [orderRunning, setOrderRunning] = useState(false);
  const [orderResult, setOrderResult] = useState<Record<string, unknown> | null>(
    null
  );

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
      setKeysMsg("CLÉS SAUVEGARDÉES.");
      flash();
    } else {
      setKeysMsg("ERREUR LORS DE LA SAUVEGARDE.");
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
      setAccountMsg("COMPTE AJOUTÉ.");
      flash();
      startTransition(() => router.refresh());
    } else {
      const data = await res.json().catch(() => ({}));
      setAccountMsg((data.error ?? "ERREUR.").toUpperCase());
    }
  }

  async function removeAccount(id: number) {
    await fetch(`/api/config/test-accounts?id=${id}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  async function runTrigger(
    name: string,
    endpoint: string,
    render: (data: Record<string, unknown>) => string
  ) {
    setTrigger({ name, msg: "EXÉCUTION..." });
    showLoading();
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setTrigger({ name, msg: render(data) });
        flash();
        startTransition(() => router.refresh());
      } else {
        setTrigger({ name, msg: `ERREUR : ${data.error ?? "INCONNUE"}` });
      }
    } catch {
      setTrigger({ name, msg: "ERREUR RÉSEAU" });
    } finally {
      setTimeout(() => hideLoading(), 600);
    }
  }

  async function submitTestOrder(e: React.FormEvent) {
    e.preventDefault();
    setOrderRunning(true);
    setOrderResult(null);
    showLoading();
    try {
      const res = await fetch("/api/config/test-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: orderPlatform,
          service_type: orderType,
          quantity: Number(orderQuantity),
          target_url: orderTargetUrl,
        }),
      });
      const data = await res.json();
      setOrderResult(data);
      if (data?.success) flash();
    } finally {
      setTimeout(() => hideLoading(), 600);
      setOrderRunning(false);
    }
  }

  return (
    <>
      {/* === Pattern D — 3 cards === */}
      <section className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
          [ MODULES DE CONFIGURATION ]
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 w-full border-b border-[#666666]/20">
          {/* Card 1 — API Keys */}
          <div className="relative p-6 md:p-12 bg-[#030303] md:border-r border-[#666666]/20">
            <CardHeader icon="solar:key-linear" num="01" />
            <CardTitle>Clés API</CardTitle>
            <form onSubmit={saveKeys} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                  BULKMEDYA{" "}
                  <span className="text-[#666666]/70">
                    [ {bulkmedyaSet ? "✓" : "✗"} ]
                  </span>
                </label>
                <input
                  type="password"
                  value={bulkmedyaKey}
                  onChange={(e) => setBulkmedyaKey(e.target.value)}
                  placeholder={
                    bulkmedyaSet ? "VIDE = NE CHANGE PAS" : "COLLER LA CLÉ"
                  }
                  className={INPUT}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                  RAPIDAPI{" "}
                  <span className="text-[#666666]/70">
                    [ {rapidSet ? "✓" : "✗"} ]
                  </span>
                </label>
                <input
                  type="password"
                  value={rapidApiKey}
                  onChange={(e) => setRapidApiKey(e.target.value)}
                  placeholder={
                    rapidSet ? "VIDE = NE CHANGE PAS" : "COLLER LA CLÉ"
                  }
                  className={INPUT}
                />
              </div>
              <button type="submit" className={BTN_PATTERN_B}>
                <div className={BTN_PATTERN_B_OVERLAY} />
                <span className={BTN_PATTERN_B_INNER}>ENREGISTRER</span>
                <iconify-icon
                  icon="solar:diskette-linear"
                  width="18"
                  height="18"
                  className="relative z-10 group-hover:text-black transition-colors duration-300"
                />
              </button>
              {keysMsg && (
                <p className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                  {keysMsg}
                </p>
              )}
            </form>
          </div>

          {/* Card 2 — Test Accounts */}
          <div className="relative p-6 md:p-12 bg-[#0D0D0D] md:border-r border-[#666666]/20">
            <CardHeader icon="solar:users-group-rounded-linear" num="02" />
            <CardTitle>Comptes test</CardTitle>
            <form onSubmit={addAccount} className="flex flex-col gap-3 mb-6">
              <select
                value={platform}
                onChange={(e) =>
                  setPlatform(e.target.value as "instagram" | "tiktok")
                }
                className={INPUT}
              >
                <option value="instagram">INSTAGRAM</option>
                <option value="tiktok">TIKTOK</option>
              </select>
              <input
                required
                placeholder="USERNAME"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={INPUT}
              />
              <input
                required
                placeholder="USER_ID NUMÉRIQUE"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className={INPUT}
              />
              <button type="submit" disabled={pending} className={BTN_PATTERN_B}>
                <div className={BTN_PATTERN_B_OVERLAY} />
                <span className={BTN_PATTERN_B_INNER}>AJOUTER</span>
                <iconify-icon
                  icon="solar:add-circle-linear"
                  width="18"
                  height="18"
                  className="relative z-10 group-hover:text-black transition-colors duration-300"
                />
              </button>
              {accountMsg && (
                <p className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                  {accountMsg}
                </p>
              )}
            </form>
            {testAccounts.length === 0 ? (
              <p className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                AUCUN COMPTE TEST.
              </p>
            ) : (
              <ul className="divide-y divide-[#666666]/20 border-t border-[#666666]/20">
                {testAccounts.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between py-3 font-mono text-xs tracking-widest uppercase gap-3"
                  >
                    <Link
                      href={`/pool/${a.id}`}
                      className="interactive flex-1 min-w-0 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] hover:pl-2 transition-all truncate block"
                    >
                      <span className="text-white">{a.platform}</span>
                      <span className="ml-2 text-[#666666]">@{a.username}</span>
                      <span className="ml-2 text-[#666666]/60">
                        ID:{a.userId}
                      </span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => removeAccount(a.id)}
                      className="interactive flex-shrink-0 text-[#FF3300] hover:text-white transition-colors"
                    >
                      [ SUPPRIMER ]
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Card 3 — Manual Triggers */}
          <div className="relative p-6 md:p-12 bg-[#030303]">
            <CardHeader icon="solar:play-linear" num="03" />
            <CardTitle>Déclenchement manuel</CardTitle>
            <p className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-6 leading-relaxed">
              EN PROD, UN CRON VERCEL DÉCLENCHE CES JOBS. UTILISEZ POUR UN
              TEST IMMÉDIAT.
            </p>
            <div className="flex flex-col gap-3">
              <TriggerButton
                onClick={() =>
                  runTrigger(
                    "test-bot",
                    "/api/config/run-test-bot",
                    (d) =>
                      `${d.placed}/${d.attempted} COMMANDES PLACÉES (${d.skipped} SKIP)`
                  )
                }
                running={trigger?.name === "test-bot"}
                label="LANCER LE BOT DE TEST"
                disabled={!bulkmedyaSet || !rapidSet}
              />
              <TriggerButton
                onClick={() =>
                  runTrigger(
                    "scraper",
                    "/api/config/run-scraper",
                    (d) =>
                      `${d.measurements} MEASUREMENTS / ${d.ordersScanned} ORDERS`
                  )
                }
                running={trigger?.name === "scraper"}
                label="LANCER LE SCRAPER"
                disabled={!rapidSet}
              />
              <TriggerButton
                onClick={() =>
                  runTrigger(
                    "scoring",
                    "/api/config/run-scoring",
                    (d) =>
                      `${d.servicesScored} SERVICES SCORÉS (${d.servicesSkipped} SKIP)`
                  )
                }
                running={trigger?.name === "scoring"}
                label="LANCER LE SCORING"
              />
            </div>
            {trigger && (
              <p className="font-mono text-xs text-[#666666] tracking-widest uppercase mt-4">
                {trigger.msg}
              </p>
            )}
            {(!bulkmedyaSet || !rapidSet) && (
              <p className="font-mono text-xs text-[#666666] tracking-widest uppercase mt-4">
                CONFIGUREZ LES CLÉS BULKMEDYA + RAPIDAPI D&apos;ABORD.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* === Pattern E — Test Router (full-width form) === */}
      <section className="px-4 md:px-8 py-16 md:py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 p-5 md:p-8 pb-20 md:pb-24">
          <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ASSET: TEST-ROUTEUR ]
            </span>
            <span className="font-mono text-xs text-white tracking-widest">
              SIMULATION_NODE_03
            </span>
          </div>

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
            <h2 className="brand font-display text-3xl md:text-4xl uppercase tracking-tight text-white">
              Tester le Routeur
            </h2>
            <p className="font-mono text-xs text-[#666666] tracking-widest uppercase max-w-md leading-relaxed">
              SIMULE UN APPEL DE MYBOOST. RESPECTE DRY_RUN — AUCUNE COMMANDE
              N&apos;EST RÉELLEMENT PLACÉE TANT QU&apos;ACTIF.
            </p>
          </div>

          <form
            onSubmit={submitTestOrder}
            className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4"
          >
            <select
              value={orderPlatform}
              onChange={(e) => setOrderPlatform(e.target.value)}
              className={INPUT}
            >
              <option value="instagram">INSTAGRAM</option>
              <option value="tiktok">TIKTOK</option>
              <option value="youtube">YOUTUBE</option>
              <option value="twitter">TWITTER</option>
              <option value="facebook">FACEBOOK</option>
            </select>
            <select
              value={orderType}
              onChange={(e) => setOrderType(e.target.value)}
              className={INPUT}
            >
              <option value="followers">FOLLOWERS</option>
              <option value="likes">LIKES</option>
              <option value="views">VIEWS</option>
              <option value="comments">COMMENTS</option>
              <option value="shares">SHARES</option>
              <option value="saves">SAVES</option>
            </select>
            <input
              type="number"
              value={orderQuantity}
              onChange={(e) => setOrderQuantity(e.target.value)}
              min={1}
              className={INPUT}
              placeholder="QUANTITÉ"
            />
            <input
              type="url"
              value={orderTargetUrl}
              onChange={(e) => setOrderTargetUrl(e.target.value)}
              className={`${INPUT} sm:col-span-3`}
              placeholder="URL CIBLE"
            />
            <button
              type="submit"
              disabled={orderRunning}
              className={`${BTN_PATTERN_B} sm:col-span-1`}
            >
              <div className={BTN_PATTERN_B_OVERLAY} />
              <span className={BTN_PATTERN_B_INNER}>
                {orderRunning ? "ROUTAGE..." : "ROUTER"}
              </span>
              <iconify-icon
                icon="solar:arrow-right-linear"
                width="18"
                height="18"
                className="relative z-10 group-hover:text-black transition-colors duration-300"
              />
            </button>
          </form>
          {orderResult && (
            <pre className="mt-4 font-mono text-xs bg-[#0D0D0D] border border-[#666666]/30 p-4 overflow-x-auto text-white">
              {JSON.stringify(orderResult, null, 2)}
            </pre>
          )}
        </div>
      </section>
    </>
  );
}

function TriggerButton({
  onClick,
  running,
  label,
  disabled,
}: {
  onClick: () => void;
  running: boolean;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running || disabled}
      className={BTN_PATTERN_B}
    >
      <div className={BTN_PATTERN_B_OVERLAY} />
      <span className={BTN_PATTERN_B_INNER}>{running ? "EXÉCUTION..." : label}</span>
      <iconify-icon
        icon="solar:play-linear"
        width="18"
        height="18"
        className="relative z-10 group-hover:text-black transition-colors duration-300"
      />
    </button>
  );
}
