import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen w-full flex flex-col items-center justify-center px-6 relative">
      <div className="font-mono text-xs text-[#666666] tracking-widest border border-[#666666]/30 px-3 py-1 mb-8">
        [ NŒUD INCONNU | CODE 404 ]
      </div>
      <h1
        className="brand font-display uppercase tracking-tight leading-[0.85] text-white text-center m-0"
        style={{ fontSize: "clamp(4rem, 14vw, 12rem)" }}
      >
        Hors-Réseau.
      </h1>
      <p className="font-mono text-xs text-[#666666] tracking-widest uppercase mt-8 text-center max-w-md leading-relaxed">
        LA RESSOURCE DEMANDÉE N&apos;EXISTE PAS DANS LE SYSTÈME OU N&apos;EST
        PLUS ACCESSIBLE.
      </p>
      <div className="mt-12 flex gap-4">
        <Link
          href="/"
          className="interactive group relative border border-[#666666]/30 bg-[#0D0D0D] py-3 px-6 overflow-hidden flex items-center gap-3 text-left"
        >
          <div className="absolute inset-0 bg-[#FF3300] transform translate-y-full group-hover:translate-y-0 transition-transform duration-500 ease-out z-0" />
          <span className="relative font-mono text-xs tracking-widest text-white z-10 group-hover:text-black transition-colors duration-300">
            ← RETOUR ACCUEIL
          </span>
        </Link>
      </div>
      <div className="absolute bottom-8 font-mono text-xs text-[#666666] tracking-widest">
        [ SYS_VER: 1.0.0 | PAR MY HUB SOLUTIONS ]
      </div>
    </main>
  );
}
