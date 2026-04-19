"use client";

import { useEffect, useState } from "react";
import {
  BracketBox,
  BrutalistButton,
  ControlEye,
  ControlLogo,
  ControlRadar,
  CrosshairIcon,
  KBDKey,
  LoadingDots,
  LogLine,
  MetricDisplay,
  SectionDivider,
  SegmentedBar,
  SparkLine,
  StatusBadge,
  StatusDot,
  TerminalPrompt,
} from "@/components/control";

const SPARK_1 = [3, 5, 4, 8, 6, 9, 4, 7, 11, 6, 8, 12, 9, 11, 14, 8, 10, 13, 11, 15];
const SPARK_2 = [8, 7, 6, 5, 6, 4, 5, 3, 4, 2, 3, 4, 2, 3, 5, 3, 4, 2, 3, 2];
const SPARK_3 = [5, 6, 5, 7, 8, 7, 9, 8, 10, 9, 11, 10, 12, 11, 13, 12, 14, 13, 15, 14];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function LibraryShowcase() {
  const [metric, setMetric] = useState(1_247_329);
  const [clock, setClock] = useState("00:00:00");

  useEffect(() => {
    const id = setInterval(() => {
      setMetric((m) => m + Math.floor(Math.random() * 12) + 1);
      const d = new Date();
      setClock(
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
      );
    }, 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="lib-page">
      <header className="page-header">
        <div className="page-title">
          CONTROL <span className="slash">{"//"}</span> COMPONENT LIBRARY
        </div>
        <div className="page-meta">16 COMPONENTS // REACT + PURE CSS</div>
      </header>

      {/* ========== COMPOSED DASHBOARD DEMO ========== */}
      <div className="dash">
        <div className="dash-header">
          <ControlLogo size="sm" />
          <span className="sep">{"//"}</span>
          <span>ROUTER NODE 03</span>
          <div className="meta">
            <StatusDot variant="active" />
            <span>OPERATIONAL</span>
            <span className="sep">{"//"}</span>
            <span>{clock} UTC</span>
          </div>
        </div>
        <div className="dash-grid">
          <div className="dash-card">
            <MetricDisplay label="LIVE ROUTES" value={metric.toLocaleString("en-US")} />
            <SparkLine data={SPARK_1} width={200} height={32} />
            <StatusBadge label="NOMINAL" variant="active" />
          </div>
          <div className="dash-card">
            <MetricDisplay label="AVG LATENCY" value="42" unit="MS" />
            <SparkLine data={SPARK_2} width={200} height={32} color="#FFFFFF" />
            <SegmentedBar label="SATURATION" value={62} segments={20} />
          </div>
          <div className="dash-card">
            <MetricDisplay label="QUALITY" value="98.7" unit="%" />
            <SparkLine data={SPARK_3} width={200} height={32} />
            <SegmentedBar label="POOL HEALTH" value={87} segments={20} />
          </div>
        </div>
        <div className="dash-logs">
          <LogLine
            time="23:14:08"
            level="info"
            message="Mission M-4821 routed in 4.2s → creator #2914"
          />
          <LogLine
            time="23:14:06"
            level="warn"
            message="Quality score 79% on M-4819, requeuing"
          />
          <LogLine
            time="23:14:03"
            level="ok"
            message="Creator pool refreshed — 124 active"
          />
          <LogLine
            time="23:14:01"
            level="error"
            message="Timeout on route M-4817, marking inactive"
          />
        </div>
      </div>

      {/* ========== BRAND ========== */}
      <SectionDivider label="01 // BRAND & SIGNATURE" />
      <div className="showcase">
        <div className="showcase-item">
          <ControlEye size={80} />
          <span className="showcase-label">ControlEye size=80</span>
        </div>
        <div className="showcase-item">
          <ControlEye size={48} hDelay={-4.2} vDelay={-2.1} />
          <span className="showcase-label">size=48</span>
        </div>
        <div className="showcase-item">
          <ControlEye size={32} hDelay={-8.4} vDelay={-5.6} />
          <span className="showcase-label">size=32</span>
        </div>
        <div className="showcase-item">
          <ControlEye size={24} hDelay={-11.1} vDelay={-7.3} />
          <span className="showcase-label">size=24</span>
        </div>
        <div className="showcase-item">
          <ControlEye size={48} active hDelay={-2} />
          <span className="showcase-label">active=true</span>
        </div>
      </div>
      <div className="showcase">
        <div className="showcase-item">
          <ControlRadar size={80} />
          <span className="showcase-label">ControlRadar size=80</span>
        </div>
        <div className="showcase-item">
          <ControlRadar size={48} />
          <span className="showcase-label">size=48</span>
        </div>
        <div className="showcase-item">
          <ControlRadar size={32} />
          <span className="showcase-label">size=32</span>
        </div>
        <div className="showcase-item">
          <ControlRadar size={24} rings={1} />
          <span className="showcase-label">size=24 rings=1</span>
        </div>
        <div className="showcase-item">
          <ControlRadar size={48} active />
          <span className="showcase-label">active=true</span>
        </div>
      </div>
      <div className="showcase">
        <div className="showcase-item">
          <ControlLogo size="sm" />
          <span className="showcase-label">ControlLogo sm</span>
        </div>
        <div className="showcase-item">
          <ControlLogo size="md" />
          <span className="showcase-label">md</span>
        </div>
        <div className="showcase-item">
          <ControlLogo size="lg" />
          <span className="showcase-label">lg</span>
        </div>
        <div className="showcase-item">
          <ControlLogo size="md" variant="radar" />
          <span className="showcase-label">variant=&quot;radar&quot;</span>
        </div>
      </div>
      <div className="showcase">
        <div className="showcase-item">
          <CrosshairIcon size={48} />
          <span className="showcase-label">CrosshairIcon 48</span>
        </div>
        <div className="showcase-item">
          <CrosshairIcon size={32} />
          <span className="showcase-label">32</span>
        </div>
        <div className="showcase-item">
          <CrosshairIcon size={24} />
          <span className="showcase-label">24</span>
        </div>
        <div className="showcase-item">
          <CrosshairIcon size={16} />
          <span className="showcase-label">16</span>
        </div>
      </div>

      {/* ========== STATUS ========== */}
      <SectionDivider label="02 // STATUS INDICATORS" />
      <div className="showcase">
        <div className="showcase-item">
          <StatusDot variant="active" />
          <span className="showcase-label">active</span>
        </div>
        <div className="showcase-item">
          <StatusDot variant="idle" pulsing={false} />
          <span className="showcase-label">idle</span>
        </div>
        <div className="showcase-item">
          <StatusDot variant="error" />
          <span className="showcase-label">error (blink)</span>
        </div>
        <div className="showcase-item">
          <StatusDot variant="warn" />
          <span className="showcase-label">warn</span>
        </div>
      </div>
      <div className="showcase">
        <StatusBadge label="IDLE" />
        <StatusBadge label="ACTIVE" variant="active" />
        <StatusBadge label="ROUTING" variant="active" />
        <StatusBadge label="WARN" variant="warn" />
        <StatusBadge label="DANGER" variant="danger" />
        <StatusBadge label="OFFLINE" />
      </div>
      <div className="showcase">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontSize: 11,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--gray)",
            }}
          >
            PROCESSING
          </span>
          <LoadingDots />
        </div>
      </div>

      {/* ========== DATA ========== */}
      <SectionDivider label="03 // DATA DISPLAY" />
      <div className="showcase" style={{ gap: 48 }}>
        <MetricDisplay label="REQUESTS" value={metric.toLocaleString("en-US")} />
        <MetricDisplay label="LATENCY" value="42" unit="MS" />
        <MetricDisplay label="QUALITY" value="98.7" unit="%" />
        <MetricDisplay label="ERRORS" value="3" unit="/1M" />
      </div>
      <div className="showcase" style={{ gap: 32 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="showcase-label">THROUGHPUT 1H</span>
          <SparkLine data={SPARK_1} width={160} height={32} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="showcase-label">ERROR RATE 1H</span>
          <SparkLine data={SPARK_2} width={160} height={32} color="#FFFFFF" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="showcase-label">QUALITY TREND</span>
          <SparkLine data={SPARK_3} width={160} height={32} />
        </div>
      </div>
      <div
        className="showcase"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 14 }}
      >
        <SegmentedBar label="CPU" value={62} segments={24} />
        <SegmentedBar label="MEMORY" value={87} segments={24} />
        <SegmentedBar
          label="QUEUE DEPTH"
          value={23}
          segments={24}
          variant="warn"
        />
        <SegmentedBar label="POOL HEALTH" value={94} segments={24} />
      </div>

      {/* ========== TERMINAL ========== */}
      <SectionDivider label="04 // TERMINAL" />
      <div
        className="showcase"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 3 }}
      >
        <LogLine
          time="23:14:08"
          level="info"
          message="Connection established to router-node-03"
        />
        <LogLine
          time="23:14:09"
          level="info"
          message="Mission M-4821 accepted, routing to creator pool"
        />
        <LogLine
          time="23:14:10"
          level="ok"
          message="Match found: creator #2914 — quality 98.7%"
        />
        <LogLine
          time="23:14:11"
          level="warn"
          message="Quality score 82% below threshold, requeueing"
        />
        <LogLine
          time="23:14:12"
          level="error"
          message="Creator #29441 timeout, marking inactive"
        />
        <LogLine time="23:14:13" level="ok" message="Route complete in 4.2s" />
      </div>
      <div
        className="showcase"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}
      >
        <TerminalPrompt>control scan --all --quality=98</TerminalPrompt>
        <TerminalPrompt prompt="→" cursor={false}>
          waiting for operator input
        </TerminalPrompt>
        <TerminalPrompt prompt="✕">process killed by operator</TerminalPrompt>
      </div>

      {/* ========== INTERACTIVE ========== */}
      <SectionDivider label="05 // INTERACTIVE" />
      <div className="showcase">
        <BrutalistButton variant="primary">ACCEPT ROUTE</BrutalistButton>
        <BrutalistButton variant="default">REVIEW</BrutalistButton>
        <BrutalistButton variant="ghost">SKIP</BrutalistButton>
        <BrutalistButton variant="danger">KILL PROCESS</BrutalistButton>
        <BrutalistButton variant="primary" disabled>
          DISABLED
        </BrutalistButton>
      </div>
      <div
        className="showcase"
        style={{ gap: 16, fontSize: 12, color: "var(--gray)" }}
      >
        <span>
          Press <KBDKey>ESC</KBDKey> to abort
        </span>
        <span>
          <KBDKey>⌘</KBDKey>
          <KBDKey>K</KBDKey> command palette
        </span>
        <span>
          Navigate <KBDKey>↑</KBDKey> <KBDKey>↓</KBDKey>
        </span>
        <span>
          Confirm <KBDKey>⏎</KBDKey>
        </span>
      </div>

      {/* ========== LAYOUT ========== */}
      <SectionDivider label="06 // LAYOUT & TYPOGRAPHY" />
      <div
        className="showcase"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 0 }}
      >
        <SectionDivider label="OPERATIONS" />
        <SectionDivider label="DIAGNOSTICS" />
        <SectionDivider label="ADMIN" />
      </div>
      <div className="showcase" style={{ gap: 14 }}>
        <BracketBox>SYSTEM_READY</BracketBox>
        <BracketBox>4821 OPS</BracketBox>
        <BracketBox>v0.1.4</BracketBox>
        <BracketBox>98.7% QUALITY</BracketBox>
      </div>

      <footer
        style={{
          marginTop: 48,
          paddingTop: 16,
          borderTop: "1px solid var(--gray)",
          fontSize: 10,
          color: "var(--gray)",
          letterSpacing: 1.5,
          textTransform: "uppercase",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>CONTROL // COMPONENT LIBRARY // V1</span>
        <span style={{ color: "var(--white)" }}>
          → SOURCE = CODE
        </span>
      </footer>
    </div>
  );
}
