import { useState, useEffect, useRef, useCallback } from "react";

// --- API ---
const API_BASE = "/api";
async function apiScan(region = "nationwide") {
  const res = await fetch(`${API_BASE}/scan?region=${region}`);
  if (res.status === 429) throw new Error("Scan already in progress");
  if (!res.ok) throw new Error(`Scan failed (${res.status})`);
  return res.json();
}

// --- Helpers ---
const stateFromGeo = (geo) => { if (!geo) return ""; const m = geo.match(/,\s*(\w{2})$/); return m ? m[1] : geo; };
const MW_STATES = ["MI", "OH", "IL", "IN", "WI", "MN", "IA", "MO"];
const STATE_COLORS = {
  MI: "#4f8fff", OH: "#ff5c5c", IL: "#ff9f43", IN: "#b07cff",
  WI: "#2ed573", MN: "#18dcff", IA: "#ffd32a", MO: "#ff6b9d",
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

// --- Animated Confidence Ring ---
function ConfidenceRing({ value, size = 50, delay = 0 }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => { const t = setTimeout(() => setAnimated(true), delay + 300); return () => clearTimeout(t); }, [delay]);
  const pct = Math.round(value * 100);
  const r = (size - 7) / 2;
  const circ = 2 * Math.PI * r;
  const offset = animated ? circ * (1 - value) : circ;
  const color = value >= 0.85 ? "#2ed573" : value >= 0.7 ? "#ffd32a" : "#778ca3";
  const glow = value >= 0.85 ? "0 0 12px rgba(46,213,115,0.4)" : value >= 0.7 ? "0 0 12px rgba(255,211,42,0.3)" : "none";
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0, filter: `drop-shadow(${glow})` }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="3.5"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.34,1.56,0.64,1)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 14, fontWeight: 800, color, fontFamily: "'Sora', sans-serif", lineHeight: 1 }}>{pct}</span>
      </div>
    </div>
  );
}

// --- Animated Counter ---
function Counter({ end, duration = 800, delay = 0 }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      let start = 0; const startTime = Date.now();
      const tick = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        setVal(Math.round(eased * end));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delay);
    return () => clearTimeout(t);
  }, [end, duration, delay]);
  return <>{val}</>;
}

// --- Topographic Background ---
function TopoBG() {
  return (
    <svg style={{ position: "fixed", inset: 0, width: "100%", height: "100%", opacity: 0.04, pointerEvents: "none" }}
      viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      {[...Array(12)].map((_, i) => (
        <ellipse key={i} cx={500 + Math.sin(i * 0.8) * 200} cy={300 + Math.cos(i * 0.6) * 150}
          rx={100 + i * 30} ry={60 + i * 20} fill="none" stroke="#4f8fff"
          strokeWidth={0.8} opacity={0.5 - i * 0.03} filter="url(#glow)">
          <animateTransform attributeName="transform" type="rotate"
            from={`${i * 30} 500 300`} to={`${i * 30 + 360} 500 300`}
            dur={`${60 + i * 10}s`} repeatCount="indefinite"/>
        </ellipse>
      ))}
    </svg>
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
  const [scanPhase, setScanPhase] = useState("");
  const [region, setRegion] = useState("nationwide");
  const [enrichments, setEnrichments] = useState({});
  const [enrichingId, setEnrichingId] = useState(null);

  // --- CSV Export ---
  const exportCSV = () => {
    const headers = ["Title", "Buyer", "Seller", "Deal Price", "Close Date", "Location", "Sector", "Deal Type", "Confidence", "Source", "Source URL", "Discovered"];
    const rows = filtered.map((d) => [
      `"${(d.title || "").replace(/"/g, '""')}"`,
      `"${(d.buyer || "Undisclosed").replace(/"/g, '""')}"`,
      `"${(d.seller || "Undisclosed").replace(/"/g, '""')}"`,
      d.deal_price || "Undisclosed",
      d.deal_date || "N/A",
      d.geo_match || "",
      d.software_match || "",
      dealTypeLabel(d.deal_match),
      `${Math.round(d.confidence * 100)}%`,
      d.source_name || "",
      d.source_url || "",
      d.discovered_at || "",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deal-monitor-${region}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- AI Deal Enrichment ---
  const enrichDeal = async (deal, e) => {
    e.stopPropagation();
    if (enrichments[deal.id]) return; // Already enriched
    setEnrichingId(deal.id);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Analyze this M&A deal announcement and extract structured intelligence. Be concise and factual. If information is not available, say "Not disclosed."

TITLE: ${deal.title}
SUMMARY: ${deal.summary}
SOURCE: ${deal.source_name}

Respond ONLY with a JSON object (no markdown, no backticks) with these fields:
{
  "buyer_name": "Full legal name of acquiring entity",
  "buyer_type": "PE firm / Strategic / Management / Other",
  "seller_name": "Full legal name of target company",
  "seller_description": "1-2 sentence description of what the target does",
  "deal_value": "Dollar amount if mentioned, otherwise Not disclosed",
  "deal_structure": "Asset purchase / Stock purchase / Recapitalization / Merger / Not disclosed",
  "deal_rationale": "1-2 sentence strategic rationale for the acquisition",
  "sector": "Specific software sub-sector (e.g. Vertical SaaS, Cybersecurity, MSP)",
  "estimated_revenue": "Target's estimated revenue if mentioned, otherwise Not disclosed",
  "employee_count": "Number if mentioned, otherwise Not disclosed",
  "key_insight": "One sentence that a buy-side M&A advisor would find most valuable about this deal"
}`
          }],
        }),
      });
      const data = await response.json();
      const text = data.content?.map((c) => c.text || "").join("") || "";
      const cleaned = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      setEnrichments((prev) => ({ ...prev, [deal.id]: parsed }));
    } catch (err) {
      setEnrichments((prev) => ({ ...prev, [deal.id]: { error: "Analysis failed — try again" } }));
    }
    setEnrichingId(null);
  };

  const phases = ["Connecting to sources...", "Scanning Google News...", "Checking PR Newswire...", "Querying GlobeNewsWire...", "Searching BizJournals...", "Scoring & deduplicating..."];

  const runScan = async () => {
    setLoading(true); setError(null); setExpandedId(null); setNewCount(0); setScanProgress(0);
    let phaseIdx = 0;
    setScanPhase(phases[0]);
    const phaseIv = setInterval(() => { phaseIdx = Math.min(phaseIdx + 1, phases.length - 1); setScanPhase(phases[phaseIdx]); }, 2500);
    const progressIv = setInterval(() => setScanProgress((p) => Math.min(p + Math.random() * 12, 92)), 500);
    try {
      const data = await apiScan(region);
      clearInterval(phaseIv); clearInterval(progressIv);
      setScanPhase("Complete"); setScanProgress(100);
      setTimeout(() => {
        setDeals(data.deals || []); setLastScan(data.scan_time);
        setNewCount(data.new_count || 0); setHasLoaded(true); setLoading(false); setScanProgress(0); setScanPhase("");
      }, 500);
    } catch (err) {
      clearInterval(phaseIv); clearInterval(progressIv);
      setError(err.message); setLoading(false); setScanProgress(0); setScanPhase("");
    }
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
      return 0;
    });

  const stateCounts = {};
  deals.forEach((d) => { const s = stateFromGeo(d.geo_match); stateCounts[s] = (stateCounts[s] || 0) + 1; });
  const totalWithPrice = deals.filter((d) => d.deal_price).length;
  const avgConf = deals.length ? deals.reduce((a, d) => a + d.confidence, 0) / deals.length : 0;

  return (
    <div style={{ minHeight: "100vh", background: "#070b14", color: "#e0e6ed", fontFamily: "'Sora', sans-serif", position: "relative", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #070b14; margin: 0; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(79,143,255,0.15); border-radius: 10px; }

        @keyframes fadeUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes borderGlow {
          0%, 100% { border-color: rgba(79,143,255,0.15); }
          50% { border-color: rgba(79,143,255,0.35); }
        }
        @keyframes scanPulse {
          0% { box-shadow: 0 0 0 0 rgba(79,143,255,0.3); }
          70% { box-shadow: 0 0 0 12px rgba(79,143,255,0); }
          100% { box-shadow: 0 0 0 0 rgba(79,143,255,0); }
        }
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes typewriter { from { width: 0; } to { width: 100%; } }

        .deal-card {
          background: linear-gradient(135deg, rgba(15,22,40,0.8) 0%, rgba(10,16,30,0.9) 100%);
          border: 1px solid rgba(79,143,255,0.08);
          border-radius: 12px;
          padding: 22px 26px;
          cursor: pointer;
          transition: all 0.35s cubic-bezier(0.25,0.46,0.45,0.94);
          position: relative;
          overflow: hidden;
          animation: fadeUp 0.6s ease forwards;
          opacity: 0;
        }
        .deal-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(79,143,255,0.2), transparent);
          opacity: 0;
          transition: opacity 0.35s ease;
        }
        .deal-card:hover {
          border-color: rgba(79,143,255,0.2);
          transform: translateY(-2px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(79,143,255,0.1);
        }
        .deal-card:hover::before { opacity: 1; }

        .scan-btn {
          background: linear-gradient(135deg, #4f8fff 0%, #3b6fd4 100%);
          border: none;
          color: #fff;
          padding: 14px 40px;
          font-family: 'Sora', sans-serif;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 2px;
          text-transform: uppercase;
          cursor: pointer;
          transition: all 0.3s ease;
          border-radius: 8px;
          position: relative;
          overflow: hidden;
          box-shadow: 0 4px 16px rgba(79,143,255,0.25);
        }
        .scan-btn::after {
          content: '';
          position: absolute;
          top: -50%; left: -50%;
          width: 200%; height: 200%;
          background: linear-gradient(transparent, rgba(255,255,255,0.1), transparent);
          transform: rotate(45deg);
          transition: transform 0.6s ease;
        }
        .scan-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 32px rgba(79,143,255,0.35);
        }
        .scan-btn:hover::after { transform: rotate(45deg) translateY(-100%); }
        .scan-btn:active { transform: translateY(0); }
        .scan-btn:disabled {
          background: rgba(79,143,255,0.15);
          color: rgba(255,255,255,0.4);
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }

        .chip {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.3px;
          padding: 4px 10px;
          border-radius: 6px;
          white-space: nowrap;
          transition: all 0.2s ease;
        }

        .filter-pill {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.5);
          padding: 7px 16px;
          font-family: 'Sora', sans-serif;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.25s ease;
          border-radius: 8px;
        }
        .filter-pill:hover { border-color: rgba(79,143,255,0.25); color: rgba(255,255,255,0.8); background: rgba(79,143,255,0.05); }
        .filter-pill.active {
          border-color: rgba(79,143,255,0.4);
          color: #4f8fff;
          background: rgba(79,143,255,0.08);
          box-shadow: 0 0 12px rgba(79,143,255,0.1);
        }

        .sort-tab {
          background: none; border: none;
          color: rgba(255,255,255,0.35);
          padding: 6px 14px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px; font-weight: 500;
          letter-spacing: 1px; cursor: pointer;
          transition: all 0.2s ease;
          text-transform: uppercase;
          border-radius: 6px;
        }
        .sort-tab:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.03); }
        .sort-tab.active { color: #4f8fff; background: rgba(79,143,255,0.08); }

        .stat-card {
          padding: 20px 24px;
          border-radius: 12px;
          background: linear-gradient(135deg, rgba(15,22,40,0.6) 0%, rgba(10,16,30,0.8) 100%);
          border: 1px solid rgba(79,143,255,0.08);
          transition: all 0.3s ease;
          position: relative;
          overflow: hidden;
        }
        .stat-card::after {
          content: '';
          position: absolute;
          bottom: 0; left: 20%; right: 20%;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(79,143,255,0.15), transparent);
        }
        .stat-card:hover { border-color: rgba(79,143,255,0.2); transform: translateY(-1px); }

        .skeleton {
          background: linear-gradient(90deg, rgba(79,143,255,0.03) 25%, rgba(79,143,255,0.08) 50%, rgba(79,143,255,0.03) 75%);
          background-size: 200% 100%;
          animation: shimmer 1.5s ease infinite;
          border-radius: 12px;
        }

        /* Responsive */
        @media (max-width: 768px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .deal-grid { grid-template-columns: 1fr !important; gap: 10px !important; }
          .deal-grid > div:nth-child(2),
          .deal-grid > div:nth-child(3),
          .deal-grid > div:nth-child(4) { display: none !important; }
          .deal-meta-mobile { display: flex !important; }
          .detail-grid { grid-template-columns: 1fr 1fr !important; }
          .enrich-grid { grid-template-columns: 1fr !important; }
          .toolbar-row { flex-direction: column !important; align-items: flex-start !important; }
          .hero-title { font-size: 30px !important; }
          .main-content { padding: 24px 16px 80px !important; }
          .nav-bar { margin-bottom: 32px !important; }
        }
      `}</style>

      {/* Animated topo background */}
      <TopoBG />

      {/* Gradient orbs */}
      <div style={{ position: "fixed", top: "-15%", right: "-5%", width: "45vw", height: "45vw",
        background: "radial-gradient(circle, rgba(79,143,255,0.06) 0%, transparent 65%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: "-20%", left: "-10%", width: "35vw", height: "35vw",
        background: "radial-gradient(circle, rgba(46,213,115,0.04) 0%, transparent 65%)", pointerEvents: "none" }} />

      {/* Deal Ticker */}
      {hasLoaded && deals.length > 0 && (
        <div style={{
          position: "relative", zIndex: 20, width: "100%", overflow: "hidden",
          background: "rgba(79,143,255,0.04)",
          borderBottom: "1px solid rgba(79,143,255,0.08)",
          padding: "8px 0",
        }}>
          <style>{`
            @keyframes tickerScroll {
              0% { transform: translateX(0); }
              100% { transform: translateX(-50%); }
            }
          `}</style>
          <div style={{
            display: "flex", gap: 48, whiteSpace: "nowrap",
            animation: `tickerScroll ${Math.max(deals.length * 8, 60)}s linear infinite`,
            width: "max-content",
          }}>
            {[...deals, ...deals].map((d, i) => {
              const sc = STATE_COLORS[stateFromGeo(d.geo_match)] || "#4f8fff";
              return (
                <span key={`${d.id}-${i}`} style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.45)",
                  display: "inline-flex", alignItems: "center", gap: 8,
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: "50%", background: sc, boxShadow: `0 0 6px ${sc}50`, flexShrink: 0 }} />
                  <span style={{ color: "rgba(255,255,255,0.7)", fontWeight: 600 }}>{d.title.length > 50 ? d.title.slice(0, 50) + "..." : d.title}</span>
                  {d.deal_price && <span style={{ color: "#2ed573", fontWeight: 700 }}>{d.deal_price}</span>}
                  <span style={{ color: "rgba(255,255,255,0.25)" }}>{d.geo_match}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="main-content" style={{ position: "relative", zIndex: 10, maxWidth: 1020, margin: "0 auto", padding: "52px 32px 100px" }}>

        {/* Nav bar */}
        <div className="nav-bar" style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 56, animation: "fadeIn 0.8s ease",
          padding: "12px 20px", borderRadius: 12,
          background: "rgba(10,16,30,0.5)", backdropFilter: "blur(20px)",
          border: "1px solid rgba(79,143,255,0.06)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: "linear-gradient(135deg, #4f8fff 0%, #2ed573 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 15, fontWeight: 800, color: "#070b14",
              boxShadow: "0 4px 12px rgba(79,143,255,0.3)",
            }}>D</div>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#fff", letterSpacing: 0.3 }}>DealMonitor</span>
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: 1.5,
              color: "#4f8fff", textTransform: "uppercase",
              padding: "2px 8px", borderRadius: 4,
              background: "rgba(79,143,255,0.1)", border: "1px solid rgba(79,143,255,0.15)",
            }}>Beta</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 7, height: 7, borderRadius: "50%",
              background: hasLoaded ? "#2ed573" : error ? "#ff5c5c" : "rgba(255,255,255,0.2)",
              boxShadow: hasLoaded ? "0 0 10px rgba(46,213,115,0.5)" : "none",
              animation: loading ? "scanPulse 1.5s ease infinite" : "none",
            }} />
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: 0.8, color: "rgba(255,255,255,0.5)", fontWeight: 500 }}>
              {loading ? "SCANNING" : hasLoaded ? "LIVE" : "READY"}
            </span>
          </div>
        </div>

        {/* Hero */}
        <div style={{ marginBottom: 52, animation: "fadeUp 0.8s ease 0.15s forwards", opacity: 0 }}>
          <div style={{
            display: "inline-block", marginBottom: 16,
            padding: "6px 16px", borderRadius: 100,
            background: "rgba(79,143,255,0.08)", border: "1px solid rgba(79,143,255,0.15)",
          }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: 2, color: "#4f8fff", textTransform: "uppercase", fontWeight: 500 }}>
              {region === "midwest" ? "Midwest" : "Nationwide"} Software M&A Intelligence
            </span>
          </div>
          <h1 className="hero-title" style={{ fontSize: 44, fontWeight: 800, color: "#fff", lineHeight: 1.12, letterSpacing: "-1px", marginBottom: 14 }}>
            Lower Middle Market<br />
            <span style={{ background: "linear-gradient(135deg, #4f8fff, #2ed573)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              Deal Scanner
            </span>
          </h1>
          <p style={{ fontSize: 16, color: "rgba(255,255,255,0.5)", lineHeight: 1.7, maxWidth: 540, fontWeight: 400 }}>
            Real-time monitoring across five public sources for majority-control
            software transactions {region === "midwest" ? "across eight Midwest states" : "across the United States"}.
          </p>
        </div>

        {/* Region toggle */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24, animation: "fadeUp 0.8s ease 0.25s forwards", opacity: 0 }}>
          <div style={{
            display: "inline-flex", padding: 3, borderRadius: 10,
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
          }}>
            {[
              { key: "nationwide", label: "Nationwide", icon: "🇺🇸" },
              { key: "midwest", label: "Midwest", icon: "🌾" },
            ].map((r) => (
              <button key={r.key} onClick={() => setRegion(r.key)} style={{
                background: region === r.key ? "rgba(79,143,255,0.12)" : "transparent",
                border: region === r.key ? "1px solid rgba(79,143,255,0.25)" : "1px solid transparent",
                color: region === r.key ? "#4f8fff" : "rgba(255,255,255,0.4)",
                padding: "8px 18px", borderRadius: 8,
                fontFamily: "'Sora', sans-serif", fontSize: 12, fontWeight: 600,
                cursor: "pointer", transition: "all 0.25s ease",
                display: "flex", alignItems: "center", gap: 6,
                boxShadow: region === r.key ? "0 0 12px rgba(79,143,255,0.08)" : "none",
              }}>
                <span style={{ fontSize: 13 }}>{r.icon}</span> {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* State chips — show all discovered states dynamically */}
        <div style={{ display: "flex", gap: 8, marginBottom: 40, flexWrap: "wrap", animation: "fadeUp 0.8s ease 0.3s forwards", opacity: 0 }}>
          {(Object.keys(stateCounts).length > 0 ? Object.keys(stateCounts).sort() : MW_STATES).map((st, i) => {
            const c = STATE_COLORS[st] || "#4f8fff"; const count = stateCounts[st] || 0;
            return (
              <div key={st} style={{
                display: "flex", alignItems: "center", gap: 7,
                padding: "6px 14px", borderRadius: 8,
                background: count > 0 ? `${c}12` : "rgba(255,255,255,0.02)",
                border: `1px solid ${count > 0 ? c + "30" : "rgba(255,255,255,0.06)"}`,
                transition: "all 0.4s ease",
                animation: hasLoaded && count > 0 ? `slideIn 0.4s ease ${i * 0.05}s forwards` : "none",
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: count > 0 ? c : "rgba(255,255,255,0.15)",
                  boxShadow: count > 0 ? `0 0 8px ${c}50` : "none",
                  transition: "all 0.4s ease",
                }} />
                <span style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600,
                  color: count > 0 ? c : "rgba(255,255,255,0.25)", letterSpacing: 0.5,
                }}>
                  {st}{count > 0 && <span style={{ opacity: 0.7, marginLeft: 4 }}>{count}</span>}
                </span>
              </div>
            );
          })}
        </div>

        {/* Scan button + status */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, animation: "fadeUp 0.8s ease 0.4s forwards", opacity: 0, flexWrap: "wrap" }}>
          <button className="scan-btn" onClick={runScan} disabled={loading}>
            {loading ? "Scanning..." : "Run Scan"}
          </button>
          {hasLoaded && !loading && filtered.length > 0 && (
            <button onClick={exportCSV} style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.6)", padding: "14px 24px",
              fontFamily: "'Sora', sans-serif", fontSize: 13, fontWeight: 600,
              letterSpacing: 1, cursor: "pointer", borderRadius: 8,
              transition: "all 0.25s ease", display: "flex", alignItems: "center", gap: 8,
            }}
            onMouseOver={(e) => { e.currentTarget.style.borderColor = "rgba(79,143,255,0.25)"; e.currentTarget.style.color = "#fff"; }}
            onMouseOut={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "rgba(255,255,255,0.6)"; }}>
              ↓ Export CSV
            </button>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {lastScan && !loading && (
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                {new Date(lastScan).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            {newCount > 0 && !loading && (
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#2ed573", fontWeight: 600 }}>
                +{newCount} new deal{newCount !== 1 ? "s" : ""} found
              </span>
            )}
          </div>
        </div>

        {/* Progress bar with phase text */}
        {loading && (
          <div style={{ marginBottom: 40, animation: "fadeIn 0.3s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#4f8fff", fontWeight: 500 }}>
                {scanPhase}
              </span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                {Math.round(scanProgress)}%
              </span>
            </div>
            <div style={{ height: 3, background: "rgba(79,143,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{
                height: "100%", width: `${scanProgress}%`, borderRadius: 2,
                background: "linear-gradient(90deg, #4f8fff, #2ed573)",
                boxShadow: "0 0 16px rgba(79,143,255,0.4)",
                transition: "width 0.5s ease",
              }} />
            </div>
          </div>
        )}
        {!loading && <div style={{ height: 3, marginBottom: 40 }} />}

        {error && (
          <div style={{
            marginBottom: 28, padding: "16px 22px", borderRadius: 12,
            background: "rgba(255,92,92,0.06)", border: "1px solid rgba(255,92,92,0.15)",
          }}>
            <span style={{ fontSize: 13, color: "#ff8a8a", fontWeight: 500 }}>⚠ {error}</span>
          </div>
        )}

        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 90, animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        )}

        {/* Stats */}
        {hasLoaded && !loading && deals.length > 0 && (
          <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 32, animation: "fadeUp 0.6s ease forwards" }}>
            {[
              { label: "Total Deals", value: deals.length, color: "#4f8fff" },
              { label: "Avg Score", value: `${Math.round(avgConf * 100)}%`, color: "#2ed573" },
              { label: "Price Disclosed", value: `${totalWithPrice}/${deals.length}`, color: "#ffd32a" },
              { label: "States Active", value: Object.keys(stateCounts).length, color: "#ff6b9d" },
            ].map((s, i) => (
              <div key={s.label} className="stat-card" style={{ animationDelay: `${i * 0.08}s` }}>
                <div style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: 1.8,
                  textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginBottom: 8, fontWeight: 500,
                }}>{s.label}</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: s.color, lineHeight: 1 }}>
                  {typeof s.value === "number" ? <Counter end={s.value} delay={i * 100} /> : s.value}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Toolbar */}
        {hasLoaded && !loading && (
          <div className="toolbar-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className={`filter-pill ${filterState === "ALL" ? "active" : ""}`} onClick={() => setFilterState("ALL")}>All</button>
              {Object.keys(stateCounts).sort().map((st) => (
                <button key={st} className={`filter-pill ${filterState === st ? "active" : ""}`} onClick={() => setFilterState(st)}>{st}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              {[{ key: "confidence", label: "Score" }, { key: "date", label: "Date" }, { key: "price", label: "Price" }].map((s) => (
                <button key={s.key} className={`sort-tab ${sortBy === s.key ? "active" : ""}`} onClick={() => setSortBy(s.key)}>{s.label}</button>
              ))}
            </div>
          </div>
        )}

        {/* Deal list */}
        {hasLoaded && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <p style={{ fontSize: 15, color: "rgba(255,255,255,0.3)" }}>
                  {filterState !== "ALL" ? `No deals in ${filterState}` : "No matching deals found"}
                </p>
              </div>
            )}

            {filtered.map((deal, idx) => {
              const stCode = stateFromGeo(deal.geo_match);
              const sc = STATE_COLORS[stCode] || "#778ca3";
              const isExpanded = expandedId === deal.id;
              const dtype = dealTypeLabel(deal.deal_match);
              return (
                <div key={deal.id} className="deal-card" style={{ animationDelay: `${idx * 0.07}s` }}
                  onClick={() => setExpandedId(isExpanded ? null : deal.id)}>

                  <div className="deal-grid" style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px 56px", gap: 20, alignItems: "center" }}>
                    {/* Deal info */}
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", lineHeight: 1.45, marginBottom: 10 }}>
                        {deal.title}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <span className="chip" style={{ color: sc, background: `${sc}15`, border: `1px solid ${sc}25` }}>{deal.geo_match}</span>
                        <span className="chip" style={{ color: "rgba(255,255,255,0.65)", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>{deal.software_match}</span>
                        <span className="chip" style={{ color: "#4f8fff", background: "rgba(79,143,255,0.08)", border: "1px solid rgba(79,143,255,0.15)" }}>{dtype}</span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.3)", marginLeft: 4 }}>
                          {deal.source_name} · {formatDiscovered(deal.discovered_at)}
                        </span>
                      </div>
                      {/* Mobile-only price/date/score row */}
                      <div className="deal-meta-mobile" style={{ display: "none", gap: 12, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: deal.deal_price ? "#2ed573" : "rgba(255,255,255,0.25)", fontWeight: 700 }}>
                          {deal.deal_price || "Undisclosed"}
                        </span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                          {formatDealDate(deal.deal_date) || "No date"}
                        </span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: deal.confidence >= 0.85 ? "#2ed573" : deal.confidence >= 0.7 ? "#ffd32a" : "#778ca3", fontWeight: 700 }}>
                          Score: {Math.round(deal.confidence * 100)}
                        </span>
                      </div>
                    </div>

                    {/* Price */}
                    <div>
                      {deal.deal_price
                        ? <span style={{ fontSize: 18, fontWeight: 800, color: "#fff", letterSpacing: "-0.3px" }}>{deal.deal_price}</span>
                        : <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.25)", fontStyle: "italic" }}>Undisclosed</span>}
                    </div>

                    {/* Date */}
                    <div>
                      {deal.deal_date
                        ? <span style={{ fontSize: 13, fontWeight: 500, color: "rgba(255,255,255,0.7)" }}>{formatDealDate(deal.deal_date)}</span>
                        : <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.25)", fontStyle: "italic" }}>Not available</span>}
                    </div>

                    {/* Score */}
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <ConfidenceRing value={deal.confidence} delay={idx * 70} />
                    </div>
                  </div>

                  {/* Expanded */}
                  {isExpanded && (
                    <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid rgba(79,143,255,0.08)", animation: "fadeUp 0.4s ease forwards" }}>
                      <p style={{ fontSize: 14, lineHeight: 1.8, color: "rgba(255,255,255,0.6)", marginBottom: 22, maxWidth: 700 }}>{deal.summary}</p>
                      <div className="detail-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14, marginBottom: 18 }}>
                        {[
                          { label: "Buyer", val: deal.buyer },
                          { label: "Target", val: deal.seller },
                          { label: "Deal Value", val: deal.deal_price },
                          { label: "Close Date", val: formatDealDate(deal.deal_date) },
                        ].map((f) => (
                          <div key={f.label} style={{
                            padding: "12px 16px", borderRadius: 8,
                            background: "rgba(79,143,255,0.03)", border: "1px solid rgba(79,143,255,0.06)",
                          }}>
                            <div style={{
                              fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: 1.5,
                              textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: 6,
                            }}>{f.label}</div>
                            <div style={{
                              fontSize: 13, fontWeight: f.val ? 600 : 400, color: f.val ? "#fff" : "rgba(255,255,255,0.25)",
                              fontStyle: f.val ? "normal" : "italic",
                            }}>{f.val || "Undisclosed"}</div>
                          </div>
                        ))}
                      </div>

                      {/* AI Enrichment Section */}
                      {!enrichments[deal.id] && enrichingId !== deal.id && (
                        <button onClick={(e) => enrichDeal(deal, e)} style={{
                          background: "linear-gradient(135deg, rgba(46,213,115,0.1) 0%, rgba(79,143,255,0.1) 100%)",
                          border: "1px solid rgba(46,213,115,0.2)",
                          color: "#2ed573", padding: "10px 20px", borderRadius: 8,
                          fontFamily: "'Sora', sans-serif", fontSize: 12, fontWeight: 600,
                          cursor: "pointer", transition: "all 0.25s ease",
                          display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
                        }}
                        onMouseOver={(e) => { e.currentTarget.style.borderColor = "rgba(46,213,115,0.4)"; e.currentTarget.style.boxShadow = "0 0 16px rgba(46,213,115,0.12)"; }}
                        onMouseOut={(e) => { e.currentTarget.style.borderColor = "rgba(46,213,115,0.2)"; e.currentTarget.style.boxShadow = "none"; }}>
                          <span style={{ fontSize: 14 }}>✦</span> Analyze with AI
                        </button>
                      )}

                      {enrichingId === deal.id && (
                        <div style={{
                          padding: "16px 20px", borderRadius: 10, marginBottom: 14,
                          background: "linear-gradient(135deg, rgba(46,213,115,0.04) 0%, rgba(79,143,255,0.04) 100%)",
                          border: "1px solid rgba(46,213,115,0.1)",
                          display: "flex", alignItems: "center", gap: 12,
                        }}>
                          <div style={{
                            width: 18, height: 18, borderRadius: "50%",
                            border: "2px solid rgba(46,213,115,0.3)",
                            borderTopColor: "#2ed573",
                            animation: "spin 0.8s linear infinite",
                          }} />
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#2ed573" }}>
                            Running AI analysis...
                          </span>
                          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                        </div>
                      )}

                      {enrichments[deal.id] && !enrichments[deal.id].error && (
                        <div style={{
                          borderRadius: 10, overflow: "hidden", marginBottom: 14,
                          border: "1px solid rgba(46,213,115,0.12)",
                          background: "linear-gradient(135deg, rgba(46,213,115,0.03) 0%, rgba(79,143,255,0.03) 100%)",
                        }}>
                          <div style={{
                            padding: "10px 18px",
                            background: "rgba(46,213,115,0.06)",
                            borderBottom: "1px solid rgba(46,213,115,0.08)",
                            display: "flex", alignItems: "center", gap: 8,
                          }}>
                            <span style={{ fontSize: 13 }}>✦</span>
                            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "#2ed573", fontWeight: 600 }}>
                              AI-Enhanced Intelligence
                            </span>
                          </div>
                          <div style={{ padding: "18px 18px 14px" }}>
                            <div className="enrich-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                              {[
                                { label: "Buyer", val: enrichments[deal.id].buyer_name },
                                { label: "Buyer Type", val: enrichments[deal.id].buyer_type },
                                { label: "Target", val: enrichments[deal.id].seller_name },
                                { label: "Sector", val: enrichments[deal.id].sector },
                                { label: "Deal Value", val: enrichments[deal.id].deal_value },
                                { label: "Structure", val: enrichments[deal.id].deal_structure },
                                { label: "Est. Revenue", val: enrichments[deal.id].estimated_revenue },
                                { label: "Employees", val: enrichments[deal.id].employee_count },
                              ].map((f) => (
                                <div key={f.label} style={{ padding: "8px 0" }}>
                                  <div style={{
                                    fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: 1.2,
                                    textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 4,
                                  }}>{f.label}</div>
                                  <div style={{
                                    fontSize: 13, fontWeight: 500,
                                    color: (f.val && !f.val.includes("Not disclosed")) ? "#fff" : "rgba(255,255,255,0.25)",
                                    fontStyle: (f.val && !f.val.includes("Not disclosed")) ? "normal" : "italic",
                                  }}>{f.val || "Not disclosed"}</div>
                                </div>
                              ))}
                            </div>

                            {enrichments[deal.id].seller_description && (
                              <div style={{ marginBottom: 12, padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 6 }}>Target Description</div>
                                <div style={{ fontSize: 13, lineHeight: 1.7, color: "rgba(255,255,255,0.7)" }}>{enrichments[deal.id].seller_description}</div>
                              </div>
                            )}

                            {enrichments[deal.id].deal_rationale && (
                              <div style={{ marginBottom: 12, padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 6 }}>Deal Rationale</div>
                                <div style={{ fontSize: 13, lineHeight: 1.7, color: "rgba(255,255,255,0.7)" }}>{enrichments[deal.id].deal_rationale}</div>
                              </div>
                            )}

                            {enrichments[deal.id].key_insight && (
                              <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(46,213,115,0.04)", border: "1px solid rgba(46,213,115,0.1)" }}>
                                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", color: "#2ed573", marginBottom: 6 }}>Key Insight</div>
                                <div style={{ fontSize: 13, lineHeight: 1.7, color: "rgba(255,255,255,0.8)", fontWeight: 500 }}>{enrichments[deal.id].key_insight}</div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {enrichments[deal.id]?.error && (
                        <div style={{
                          padding: "12px 18px", borderRadius: 8, marginBottom: 14,
                          background: "rgba(255,92,92,0.05)", border: "1px solid rgba(255,92,92,0.12)",
                          fontSize: 12, color: "#ff8a8a",
                        }}>
                          {enrichments[deal.id].error}
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 10 }}>
                        {deal.source_url && deal.source_url !== "#" && (
                          <a href={deal.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 6,
                              fontSize: 12, color: "#4f8fff", textDecoration: "none",
                              fontWeight: 600, transition: "all 0.2s ease",
                              padding: "6px 14px", borderRadius: 6,
                              background: "rgba(79,143,255,0.06)",
                              border: "1px solid rgba(79,143,255,0.12)",
                            }}
                            onMouseOver={(e) => { e.currentTarget.style.background = "rgba(79,143,255,0.12)"; e.currentTarget.style.borderColor = "rgba(79,143,255,0.25)"; }}
                            onMouseOut={(e) => { e.currentTarget.style.background = "rgba(79,143,255,0.06)"; e.currentTarget.style.borderColor = "rgba(79,143,255,0.12)"; }}>
                            View Source ↗
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
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "24px 0", marginTop: 12,
            borderTop: "1px solid rgba(79,143,255,0.06)",
          }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.25)" }}>
              {filtered.length} of {deals.length} deals · {region === "midwest" ? "MI OH IL IN WI MN IA MO" : "Nationwide"}
            </span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.15)" }}>
              DealMonitor v1.0
            </span>
          </div>
        )}

        {/* Empty state */}
        {!hasLoaded && !loading && (
          <div style={{ textAlign: "center", padding: "100px 20px", animation: "fadeIn 1s ease" }}>
            <div style={{
              width: 72, height: 72, borderRadius: 18, margin: "0 auto 28px",
              background: "linear-gradient(135deg, rgba(79,143,255,0.1) 0%, rgba(46,213,115,0.08) 100%)",
              border: "1px solid rgba(79,143,255,0.12)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28, animation: "borderGlow 3s ease infinite",
              boxShadow: "0 8px 32px rgba(79,143,255,0.1)",
            }}>◈</div>
            <p style={{ fontSize: 20, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 8 }}>Ready to scan</p>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.35)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
              Five sources. {region === "midwest" ? "Eight states." : "Fifty states."} Majority control. Hit the button.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
