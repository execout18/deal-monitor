import { useState, useRef } from "react";

// --- API layer ---
const API_BASE = "/api";
async function apiScan() {
  const res = await fetch(`${API_BASE}/scan`);
  if (res.status === 429) throw new Error("Scan already in progress");
  if (!res.ok) throw new Error(`Scan failed (${res.status})`);
  return res.json();
}
async function apiGetDeals() {
  const res = await fetch(`${API_BASE}/scan`);
  if (!res.ok) throw new Error(`Load failed (${res.status})`);
  return res.json();
}

// --- Mock data for local dev only (when running frontend without backend) ---
const USE_MOCK = typeof window !== "undefined" && window.location.hostname === "localhost" && window.location.port === "3000";
const MOCK_DEALS = [
  {
    id: "d001", title: "Apex Cloud Solutions Acquired by Great Lakes Capital Partners",
    summary: "Great Lakes Capital Partners has completed its acquisition of Apex Cloud Solutions, a Detroit-based SaaS provider specializing in manufacturing workflow automation. The transaction valued the company at approximately $45 million. Apex serves over 200 mid-market manufacturers across the Great Lakes region with its cloud-native production planning platform.",
    source_url: "#", source_name: "Crain's Detroit Business", discovered_at: "2026-04-16T08:30:00Z",
    buyer: "Great Lakes Capital Partners", seller: "Apex Cloud Solutions",
    geo_match: "Detroit, MI", software_match: "SaaS", deal_match: "acquisition",
    confidence: 0.92, deal_price: "$45M", deal_date: "2026-04-14",
  },
  {
    id: "d002", title: "Buckeye Software Group Announces Majority Recapitalization",
    summary: "Columbus-based Buckeye Software Group, a vertical SaaS platform for regional banking compliance, has completed a majority recapitalization with Midwest Growth Equity. The founder retains a significant minority stake and will continue as CEO. Revenue is estimated between $8M-$12M ARR.",
    source_url: "#", source_name: "BizJournals Columbus", discovered_at: "2026-04-15T14:20:00Z",
    buyer: "Midwest Growth Equity", seller: "Buckeye Software Group",
    geo_match: "Columbus, OH", software_match: "vertical SaaS", deal_match: "recapitalization",
    confidence: 0.88, deal_price: null, deal_date: "2026-04-12",
  },
  {
    id: "d003", title: "Prairie Logistics Tech Purchased by Strategic Acquirer",
    summary: "Prairie Logistics Tech, a Minneapolis-based provider of last-mile delivery optimization software, has been acquired by a publicly traded logistics company in an all-cash transaction. Terms were not disclosed. Prairie's 45-person team will be retained and operate as an independent division.",
    source_url: "#", source_name: "Minneapolis Star Tribune", discovered_at: "2026-04-15T09:45:00Z",
    buyer: "Undisclosed Strategic", seller: "Prairie Logistics Tech",
    geo_match: "Minneapolis, MN", software_match: "software", deal_match: "acquired",
    confidence: 0.81, deal_price: null, deal_date: null,
  },
  {
    id: "d004", title: "Heartland MSP Holdings Completes Third Add-On in 2026",
    summary: "Heartland MSP Holdings, a PE-backed managed services platform based in Indianapolis, has acquired SecureNet IT of Milwaukee for $18.5 million. This tuck-in acquisition expands Heartland's footprint into Wisconsin and adds approximately $3M in recurring revenue.",
    source_url: "#", source_name: "PR Newswire", discovered_at: "2026-04-14T16:10:00Z",
    buyer: "Heartland MSP Holdings", seller: "SecureNet IT",
    geo_match: "Milwaukee, WI", software_match: "managed services", deal_match: "add-on",
    confidence: 0.85, deal_price: "$18.5M", deal_date: "2026-04-10",
  },
  {
    id: "d005", title: "Chicago Fintech DataBridge Enters Definitive Agreement",
    summary: "DataBridge Financial Technologies has entered a definitive agreement to be acquired by a national banking technology provider for approximately $120 million. The Chicago-based fintech provides real-time payment reconciliation for mid-market financial institutions. The transaction is expected to close in Q3 2026.",
    source_url: "#", source_name: "GlobeNewsWire", discovered_at: "2026-04-14T11:30:00Z",
    buyer: "Undisclosed", seller: "DataBridge Financial Technologies",
    geo_match: "Chicago, IL", software_match: "fintech", deal_match: "acquisition",
    confidence: 0.77, deal_price: "$120M", deal_date: "2026-07-01",
  },
  {
    id: "d006", title: "Iowa AgTech Platform Acquired in Management Buyout",
    summary: "CropSync Analytics, a Des Moines-based precision agriculture software company, has completed a management buyout backed by regional mezzanine financing. The founder-CEO led the buyout after declining a competing strategic offer. The platform serves over 500 farms across Iowa, Missouri, and Minnesota.",
    source_url: "#", source_name: "BizJournals Des Moines", discovered_at: "2026-04-13T13:00:00Z",
    buyer: "Management Team (MBO)", seller: "CropSync Analytics",
    geo_match: "Des Moines, IA", software_match: "software", deal_match: "management buyout",
    confidence: 0.73, deal_price: null, deal_date: "2026-04-08",
  },
  {
    id: "d007", title: "Grand Rapids ERP Firm Joins National Platform",
    summary: "Lakeshore Systems, a Grand Rapids-based ERP implementation and customization firm, has been acquired as a platform investment by a newly formed holding company for $32 million. The deal includes earnout provisions tied to recurring revenue growth targets over 36 months.",
    source_url: "#", source_name: "Crain's Grand Rapids", discovered_at: "2026-04-12T10:15:00Z",
    buyer: "Undisclosed Holding Co.", seller: "Lakeshore Systems",
    geo_match: "Grand Rapids, MI", software_match: "ERP", deal_match: "platform acquisition",
    confidence: 0.86, deal_price: "$32M", deal_date: "2026-04-05",
  },
  {
    id: "d008", title: "Indiana Cybersecurity Startup Acquired by Palo Alto Networks",
    summary: "ThreatMesh, an Indianapolis-based cybersecurity startup focused on OT/IoT network monitoring for manufacturing, has been acquired by Palo Alto Networks. The deal reportedly valued the company between $65-75 million. ThreatMesh had raised $12M in prior funding.",
    source_url: "#", source_name: "SEC EDGAR (8-K)", discovered_at: "2026-04-11T08:00:00Z",
    buyer: "Palo Alto Networks", seller: "ThreatMesh",
    geo_match: "Indianapolis, IN", software_match: "cybersecurity", deal_match: "acquired",
    confidence: 0.94, deal_price: "$65-75M", deal_date: "2026-04-09",
  },
];
const mockFetch = () => new Promise((r) => setTimeout(() => r({ deals: MOCK_DEALS, new_count: MOCK_DEALS.length, scan_time: new Date().toISOString(), total_count: MOCK_DEALS.length, stats: {} }), 1800));

// --- Helpers ---
const stateFromGeo = (geo) => { if (!geo) return ""; const m = geo.match(/,\s*(\w{2})$/); return m ? m[1] : geo; };
const ALL_STATES = ["MI", "OH", "IL", "IN", "WI", "MN", "IA", "MO"];
const STATE_COLORS = {
  MI: "#3b82f6", OH: "#ef4444", IL: "#f97316", IN: "#a78bfa",
  WI: "#22c55e", MN: "#06b6d4", IA: "#eab308", MO: "#ec4899",
};
const dealTypeLabel = (m) => {
  const s = (m || "").toLowerCase();
  if (s.includes("add-on") || s.includes("bolt") || s.includes("tuck")) return "Add-On";
  if (s.includes("recap")) return "Recap";
  if (s.includes("mbo") || s.includes("management buyout")) return "MBO";
  if (s.includes("lbo") || s.includes("leveraged")) return "LBO";
  if (s.includes("platform")) return "Platform";
  if (s.includes("carve")) return "Carve-Out";
  if (s.includes("merger") || s.includes("merged")) return "Merger";
  return "Acquisition";
};
const formatDealDate = (d) => {
  if (!d) return null;
  try { return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return d; }
};
const formatDiscovered = (iso) => {
  if (!iso) return "";
  const d = new Date(iso); const now = new Date();
  const h = Math.floor((now - d) / 36e5);
  if (h < 1) return "Just now"; if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "Yesterday"; if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// --- Confidence Ring ---
function ConfidenceRing({ value, size = 46 }) {
  const pct = Math.round(value * 100);
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - value);
  const color = value >= 0.85 ? "#10b981" : value >= 0.7 ? "#f59e0b" : "#64748b";
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="3" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.4,0,0.2,1)" }} />
      </svg>
      <div style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color, fontFamily: "'DM Sans', sans-serif", lineHeight: 1 }}>{pct}</span>
      </div>
    </div>
  );
}

// --- Main ---
export default function App() {
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [filterState, setFilterState] = useState("ALL");
  const [sortBy, setSortBy] = useState("confidence");
  const [lastScan, setLastScan] = useState(null);
  const [newCount, setNewCount] = useState(0);
  const [scanProgress, setScanProgress] = useState(0);

  const runScan = async () => {
    setLoading(true); setError(null); setExpandedId(null); setNewCount(0); setScanProgress(0);
    const iv = setInterval(() => setScanProgress((p) => Math.min(p + Math.random() * 15, 90)), 400);
    try {
      const data = USE_MOCK ? await mockFetch() : await apiScan();
      setScanProgress(100);
      setTimeout(() => {
        setDeals(data.deals || []); setLastScan(data.scan_time);
        setNewCount(data.new_count || 0); setHasLoaded(true); setLoading(false); setScanProgress(0);
      }, 300);
    } catch (err) {
      setError(err.message); setLoading(false); setScanProgress(0);
      if (!USE_MOCK) try { const d = await apiGetDeals(); if (d.deals?.length) { setDeals(d.deals); setHasLoaded(true); } } catch {}
    } finally { clearInterval(iv); }
  };

  const filtered = deals
    .filter((d) => filterState === "ALL" || stateFromGeo(d.geo_match) === filterState)
    .sort((a, b) => {
      if (sortBy === "confidence") return b.confidence - a.confidence;
      if (sortBy === "date") return new Date(b.discovered_at) - new Date(a.discovered_at);
      if (sortBy === "price") {
        const pa = a.deal_price ? parseFloat(a.deal_price.replace(/[^0-9.]/g, "")) : -1;
        const pb = b.deal_price ? parseFloat(b.deal_price.replace(/[^0-9.]/g, "")) : -1;
        return pb - pa;
      }
      return a.title.localeCompare(b.title);
    });

  const stateCounts = {};
  deals.forEach((d) => { const s = stateFromGeo(d.geo_match); stateCounts[s] = (stateCounts[s] || 0) + 1; });
  const totalWithPrice = deals.filter((d) => d.deal_price).length;
  const avgConf = deals.length ? (deals.reduce((a, d) => a + d.confidence, 0) / deals.length) : 0;

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(165deg, #06080f 0%, #0c1220 40%, #0a0f1a 100%)",
      color: "#c8cdd6", fontFamily: "'DM Sans', 'Satoshi', sans-serif", position: "relative",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 10px; }
        body { background: #06080f; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes progressGlow { 0%, 100% { box-shadow: 0 0 8px rgba(99,220,190,0.3); } 50% { box-shadow: 0 0 20px rgba(99,220,190,0.6); } }
        .glass { background: rgba(255,255,255,0.02); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.04); }
        .deal-row { cursor: pointer; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); position: relative; animation: fadeUp 0.5s ease forwards; opacity: 0; }
        .deal-row:hover { background: rgba(255,255,255,0.035) !important; }
        .deal-row::after { content: ''; position: absolute; bottom: 0; left: 24px; right: 24px; height: 1px; background: rgba(255,255,255,0.04); }
        .deal-row:last-child::after { display: none; }
        .scan-btn { background: linear-gradient(135deg, rgba(99,220,190,0.12) 0%, rgba(99,220,190,0.06) 100%); border: 1px solid rgba(99,220,190,0.25); color: #63dcbe; padding: 12px 32px; font-family: 'DM Mono', monospace; font-size: 12px; font-weight: 500; letter-spacing: 2.5px; text-transform: uppercase; cursor: pointer; transition: all 0.3s ease; border-radius: 6px; }
        .scan-btn:hover { background: linear-gradient(135deg, rgba(99,220,190,0.18) 0%, rgba(99,220,190,0.1) 100%); border-color: rgba(99,220,190,0.4); box-shadow: 0 4px 24px rgba(99,220,190,0.12); transform: translateY(-1px); }
        .scan-btn:disabled { border-color: rgba(255,255,255,0.06); color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.02); cursor: not-allowed; transform: none; box-shadow: none; }
        .chip { font-family: 'DM Mono', monospace; font-size: 10px; font-weight: 400; letter-spacing: 0.5px; padding: 3px 10px; border-radius: 4px; white-space: nowrap; }
        .filter-pill { background: transparent; border: 1px solid rgba(255,255,255,0.06); color: rgba(255,255,255,0.3); padding: 6px 14px; font-family: 'DM Mono', monospace; font-size: 10px; font-weight: 400; letter-spacing: 0.8px; cursor: pointer; transition: all 0.2s ease; border-radius: 100px; }
        .filter-pill:hover { border-color: rgba(255,255,255,0.12); color: rgba(255,255,255,0.5); }
        .filter-pill.active { border-color: rgba(99,220,190,0.3); color: #63dcbe; background: rgba(99,220,190,0.06); }
        .sort-tab { background: none; border: none; color: rgba(255,255,255,0.2); padding: 6px 12px; font-family: 'DM Mono', monospace; font-size: 10px; font-weight: 400; letter-spacing: 0.8px; cursor: pointer; transition: color 0.2s ease; text-transform: uppercase; }
        .sort-tab:hover { color: rgba(255,255,255,0.5); } .sort-tab.active { color: #63dcbe; }
        .data-label { font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; color: rgba(255,255,255,0.15); margin-bottom: 4px; }
        .data-value { font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.85); }
        .data-value.muted { color: rgba(255,255,255,0.18); font-style: italic; font-weight: 400; }
        .skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.02) 25%, rgba(255,255,255,0.05) 50%, rgba(255,255,255,0.02) 75%); background-size: 200% 100%; animation: shimmer 1.8s ease infinite; border-radius: 6px; }
        .stat-card { padding: 16px 20px; border-radius: 8px; background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.03); }
      `}</style>

      {/* Ambient glows */}
      <div style={{ position: "fixed", top: "-20%", right: "-10%", width: "50vw", height: "50vw", background: "radial-gradient(circle, rgba(99,220,190,0.03) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: "-20%", left: "-10%", width: "40vw", height: "40vw", background: "radial-gradient(circle, rgba(59,130,246,0.02) 0%, transparent 70%)", pointerEvents: "none" }} />

      <div style={{ position: "relative", zIndex: 10, maxWidth: 1000, margin: "0 auto", padding: "48px 28px 80px" }}>

        {/* Top bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 48, animation: "fadeIn 0.6s ease" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 6, background: "linear-gradient(135deg, #63dcbe 0%, #3b82f6 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#06080f" }}>D</div>
            <span style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.7)", letterSpacing: 0.5 }}>DealMonitor</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, letterSpacing: 1.5, color: "rgba(255,255,255,0.12)", textTransform: "uppercase", marginLeft: 4 }}>Beta</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: hasLoaded ? "#63dcbe" : error ? "#ef4444" : "rgba(255,255,255,0.15)", boxShadow: hasLoaded ? "0 0 8px rgba(99,220,190,0.4)" : "none", animation: loading ? "pulse 1.2s ease infinite" : "none" }} />
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, letterSpacing: 1, color: "rgba(255,255,255,0.2)" }}>
              {loading ? "SCANNING" : hasLoaded ? "CONNECTED" : "STANDBY"}
            </span>
          </div>
        </div>

        {/* Hero */}
        <div style={{ marginBottom: 48, animation: "fadeUp 0.6s ease 0.1s forwards", opacity: 0 }}>
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, letterSpacing: 2, color: "#63dcbe", textTransform: "uppercase", marginBottom: 12, fontWeight: 400 }}>Midwest Software M&A Intelligence</p>
          <h1 style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 38, fontWeight: 700, color: "rgba(255,255,255,0.92)", lineHeight: 1.15, letterSpacing: "-0.5px", marginBottom: 10, maxWidth: 600 }}>
            Lower Middle Market<br />Deal Scanner
          </h1>
          <p style={{ fontSize: 15, color: "rgba(255,255,255,0.3)", lineHeight: 1.6, maxWidth: 520 }}>
            Real-time monitoring across 5 public sources for majority-control transactions in software and technology across eight Midwest states.
          </p>
        </div>

        {/* State coverage */}
        <div style={{ display: "flex", gap: 6, marginBottom: 36, flexWrap: "wrap", animation: "fadeUp 0.6s ease 0.2s forwards", opacity: 0 }}>
          {ALL_STATES.map((st) => {
            const c = STATE_COLORS[st]; const count = stateCounts[st] || 0;
            return (
              <div key={st} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 100, background: count > 0 ? `${c}10` : "rgba(255,255,255,0.015)", border: `1px solid ${count > 0 ? c + "25" : "rgba(255,255,255,0.03)"}`, transition: "all 0.4s ease" }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: count > 0 ? c : "rgba(255,255,255,0.1)", transition: "all 0.4s ease" }} />
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, fontWeight: 500, color: count > 0 ? c : "rgba(255,255,255,0.15)", letterSpacing: 0.5 }}>
                  {st}{count > 0 && <span style={{ opacity: 0.6, marginLeft: 3 }}>{count}</span>}
                </span>
              </div>
            );
          })}
        </div>

        {/* Scan button */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12, animation: "fadeUp 0.6s ease 0.3s forwards", opacity: 0 }}>
          <button className="scan-btn" onClick={runScan} disabled={loading}>
            {loading ? "Scanning..." : "Run Scan"}
          </button>
          {lastScan && !loading && (
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.15)", letterSpacing: 0.5 }}>
              {new Date(lastScan).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              {newCount > 0 && <span style={{ color: "#63dcbe", marginLeft: 8 }}>+{newCount} new</span>}
            </span>
          )}
        </div>

        {/* Progress */}
        {loading && (
          <div style={{ height: 2, background: "rgba(255,255,255,0.03)", borderRadius: 1, marginBottom: 36, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${scanProgress}%`, background: "linear-gradient(90deg, #63dcbe, #3b82f6)", borderRadius: 1, transition: "width 0.4s ease", animation: "progressGlow 2s ease infinite" }} />
          </div>
        )}
        {!loading && <div style={{ height: 2, marginBottom: 36 }} />}

        {error && (
          <div className="glass" style={{ marginBottom: 24, padding: "14px 20px", borderRadius: 8, borderColor: "rgba(239,68,68,0.15)", background: "rgba(239,68,68,0.04)" }}>
            <span style={{ fontSize: 13, color: "#fca5a5" }}>⚠ {error}</span>
          </div>
        )}

        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[0, 1, 2, 3, 4].map((i) => (<div key={i} className="skeleton" style={{ height: 82, animationDelay: `${i * 0.2}s` }} />))}
          </div>
        )}

        {/* Stats */}
        {hasLoaded && !loading && deals.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28, animation: "fadeUp 0.5s ease forwards" }}>
            {[
              { label: "Total Deals", value: deals.length },
              { label: "Avg Score", value: `${Math.round(avgConf * 100)}%` },
              { label: "Price Disclosed", value: `${totalWithPrice} of ${deals.length}` },
              { label: "States Active", value: Object.keys(stateCounts).length },
            ].map((s) => (
              <div key={s.label} className="stat-card">
                <div className="data-label">{s.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "rgba(255,255,255,0.85)", marginTop: 2 }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Toolbar */}
        {hasLoaded && !loading && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              <button className={`filter-pill ${filterState === "ALL" ? "active" : ""}`} onClick={() => setFilterState("ALL")}>All</button>
              {Object.keys(stateCounts).sort().map((st) => (
                <button key={st} className={`filter-pill ${filterState === st ? "active" : ""}`} onClick={() => setFilterState(st)}>{st}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 0 }}>
              {[{ key: "confidence", label: "Score" }, { key: "date", label: "Date" }, { key: "price", label: "Price" }].map((s) => (
                <button key={s.key} className={`sort-tab ${sortBy === s.key ? "active" : ""}`} onClick={() => setSortBy(s.key)}>{s.label}</button>
              ))}
            </div>
          </div>
        )}

        {/* Deal list */}
        {hasLoaded && !loading && (
          <div className="glass" style={{ borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 56px", padding: "12px 24px", borderBottom: "1px solid rgba(255,255,255,0.04)", gap: 16 }}>
              {["Deal", "Price", "Close Date", "Score"].map((h) => (
                <span key={h} style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "rgba(255,255,255,0.12)", fontWeight: 400, textAlign: h === "Score" ? "center" : "left" }}>{h}</span>
              ))}
            </div>

            {filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <p style={{ fontSize: 14, color: "rgba(255,255,255,0.15)" }}>
                  {filterState !== "ALL" ? `No deals in ${filterState}` : "No deals matched the criteria"}
                </p>
              </div>
            )}

            {filtered.map((deal, idx) => {
              const stCode = stateFromGeo(deal.geo_match);
              const sc = STATE_COLORS[stCode] || "#64748b";
              const isExpanded = expandedId === deal.id;
              const dtype = dealTypeLabel(deal.deal_match);
              return (
                <div key={deal.id} className="deal-row" style={{ animationDelay: `${idx * 0.05}s` }}
                  onClick={() => setExpandedId(isExpanded ? null : deal.id)}>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 56px", padding: "18px 24px", gap: 16, alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.88)", lineHeight: 1.4, marginBottom: 7 }}>{deal.title}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <span className="chip" style={{ color: sc, background: `${sc}10`, border: `1px solid ${sc}20` }}>{deal.geo_match}</span>
                        <span className="chip" style={{ color: "rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>{deal.software_match}</span>
                        <span className="chip" style={{ color: "rgba(99,220,190,0.6)", background: "rgba(99,220,190,0.04)", border: "1px solid rgba(99,220,190,0.1)" }}>{dtype}</span>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.12)", marginLeft: 4 }}>{deal.source_name} · {formatDiscovered(deal.discovered_at)}</span>
                      </div>
                    </div>
                    <div>
                      {deal.deal_price
                        ? <span style={{ fontSize: 16, fontWeight: 700, color: "rgba(255,255,255,0.88)" }}>{deal.deal_price}</span>
                        : <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.12)", fontStyle: "italic" }}>Undisclosed</span>}
                    </div>
                    <div>
                      {deal.deal_date
                        ? <span style={{ fontSize: 13, fontWeight: 500, color: "rgba(255,255,255,0.6)" }}>{formatDealDate(deal.deal_date)}</span>
                        : <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.12)", fontStyle: "italic" }}>Not available</span>}
                    </div>
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <ConfidenceRing value={deal.confidence} />
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{ padding: "0 24px 24px", animation: "fadeUp 0.3s ease forwards" }}>
                      <div style={{ background: "rgba(255,255,255,0.015)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.03)", padding: 20 }}>
                        <p style={{ fontSize: 13.5, lineHeight: 1.75, color: "rgba(255,255,255,0.5)", marginBottom: 20 }}>{deal.summary}</p>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
                          {[
                            { label: "Buyer", val: deal.buyer },
                            { label: "Target", val: deal.seller },
                            { label: "Deal Value", val: deal.deal_price },
                            { label: "Close Date", val: formatDealDate(deal.deal_date) },
                          ].map((f) => (
                            <div key={f.label}>
                              <div className="data-label">{f.label}</div>
                              <div className={`data-value ${!f.val ? "muted" : ""}`}>{f.val || "Undisclosed"}</div>
                            </div>
                          ))}
                        </div>
                        {deal.source_url && deal.source_url !== "#" && (
                          <a href={deal.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#63dcbe", textDecoration: "none", fontFamily: "'DM Mono', monospace", letterSpacing: 0.5, opacity: 0.7, transition: "opacity 0.2s" }}
                            onMouseOver={(e) => e.currentTarget.style.opacity = 1} onMouseOut={(e) => e.currentTarget.style.opacity = 0.7}>
                            View source ↗
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        {hasLoaded && !loading && filtered.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 0", marginTop: 8, flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.1)", letterSpacing: 0.5 }}>
              {filtered.length} of {deals.length} deals · MI OH IL IN WI MN IA MO
            </span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.06)", letterSpacing: 0.5 }}>
              DealMonitor v1.0
            </span>
          </div>
        )}

        {/* Empty state */}
        {!hasLoaded && !loading && (
          <div style={{ textAlign: "center", padding: "100px 20px", animation: "fadeIn 0.8s ease" }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, margin: "0 auto 24px", background: "linear-gradient(135deg, rgba(99,220,190,0.08) 0%, rgba(59,130,246,0.06) 100%)", border: "1px solid rgba(99,220,190,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>◈</div>
            <p style={{ fontSize: 17, fontWeight: 500, color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>Ready to scan</p>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.12)", maxWidth: 340, margin: "0 auto" }}>
              Monitors Google News, PR Newswire, GlobeNewsWire, SEC EDGAR, and BizJournals for deal activity.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
