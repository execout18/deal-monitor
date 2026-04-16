"""
Vercel Serverless Function: /api/scan
Runs the full scraper pipeline on demand and returns JSON results.
Supports ?region=nationwide|midwest (default: nationwide)
"""

import json
import re
import hashlib
import logging
import calendar
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import feedparser
import requests
from bs4 import BeautifulSoup

log = logging.getLogger("deal_scan")

# ---------------------------------------------------------------------------
# Geographic data
# ---------------------------------------------------------------------------

US_STATES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
    "maine", "maryland", "massachusetts", "michigan", "minnesota",
    "mississippi", "missouri", "montana", "nebraska", "nevada",
    "new hampshire", "new jersey", "new mexico", "new york",
    "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
    "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington",
    "west virginia", "wisconsin", "wyoming",
}

US_ABBREVS = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
    "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
    "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
    "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
    "wi", "wy",
}

US_METROS = {
    # Northeast
    "new york", "boston", "philadelphia", "pittsburgh", "newark", "hartford",
    "providence", "stamford", "buffalo", "rochester", "albany", "baltimore",
    "washington d.c.", "washington dc",
    # Southeast
    "atlanta", "miami", "tampa", "orlando", "charlotte", "raleigh", "durham",
    "nashville", "memphis", "jacksonville", "richmond", "norfolk",
    "charleston", "savannah", "birmingham", "louisville", "knoxville",
    # Midwest
    "detroit", "grand rapids", "ann arbor", "cleveland", "columbus", "cincinnati",
    "chicago", "indianapolis", "milwaukee", "madison", "minneapolis", "st. paul",
    "st paul", "des moines", "cedar rapids", "st. louis", "st louis", "kansas city",
    "dayton", "akron", "toledo", "lansing", "kalamazoo", "fort wayne", "green bay",
    "rockford", "peoria", "springfield", "duluth", "bloomington",
    "sioux city", "quad cities", "champaign", "evansville", "south bend", "omaha",
    # Southwest
    "dallas", "houston", "san antonio", "austin", "fort worth", "phoenix",
    "scottsdale", "tucson", "albuquerque", "el paso", "oklahoma city", "tulsa",
    "las vegas", "denver", "colorado springs", "boulder", "salt lake city",
    # West Coast
    "los angeles", "san francisco", "san diego", "san jose", "seattle", "portland",
    "sacramento", "oakland", "irvine", "pasadena", "bellevue", "redmond",
    "palo alto", "mountain view", "sunnyvale", "santa monica", "venice beach",
}

MIDWEST_STATES = {"michigan", "ohio", "illinois", "indiana", "wisconsin", "minnesota", "iowa", "missouri"}
MIDWEST_ABBREVS = {"mi", "oh", "il", "in", "wi", "mn", "ia", "mo"}
MIDWEST_METROS = {
    "detroit", "grand rapids", "ann arbor", "cleveland", "columbus", "cincinnati",
    "chicago", "indianapolis", "milwaukee", "madison", "minneapolis", "st. paul",
    "st paul", "des moines", "cedar rapids", "st. louis", "st louis", "kansas city",
    "dayton", "akron", "toledo", "lansing", "kalamazoo", "fort wayne", "green bay",
    "rockford", "peoria", "springfield", "duluth", "bloomington",
    "sioux city", "quad cities", "champaign", "evansville", "south bend",
}

# ---------------------------------------------------------------------------
# Deal keywords
# ---------------------------------------------------------------------------

ACQUISITION_KEYWORDS = [
    "acquir", "acquisition", "acquired", "merger", "merged", "buyout",
    "bought", "purchase", "purchasing", "takes over", "takeover",
    "majority stake", "majority interest", "controlling interest",
    "controlling stake", "recapitalization", "recap", "platform acquisition",
    "add-on", "bolt-on", "tuck-in", "carve-out", "carveout",
    "management buyout", "mbo", "leveraged buyout", "lbo",
]

SOFTWARE_KEYWORDS = [
    "software", "saas", "cloud", "platform", "tech company", "technology company",
    "fintech", "healthtech", "edtech", "martech", "proptech", "insurtech",
    "cybersecurity", "data analytics", "machine learning", "ai company",
    "it services", "managed services", "msp", "erp", "crm",
    "digital transformation", "devops", "infrastructure software",
    "application", "b2b software", "enterprise software", "vertical software",
    "automation", "analytics", "cloud computing", "data platform",
]

EXCLUDE_KEYWORDS = [
    "minority investment", "minority stake", "series a", "series b", "series c",
    "series d", "seed round", "venture capital", "vc funding", "ipo",
    "initial public offering", "spac", "went public", "fundrais",
    "raised $", "raises $",
]

LMM_SIGNALS = [
    "lower middle market", "middle market", "lower-middle",
    r"\$[1-9]\d{0,2}\s*million", r"\$[1-9]\d{0,2}m\b",
    "small business", "founder-owned", "family-owned", "privately held",
    "private company", "bootstrap", "owner-operated",
]

HEADERS = {"User-Agent": "DealMonitor/1.0"}
REQUEST_TIMEOUT = 12


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Deal:
    title: str
    summary: str
    source_url: str
    source_name: str
    discovered_at: str = field(default_factory=lambda: datetime.now(tz=timezone.utc).isoformat())
    buyer: Optional[str] = None
    seller: Optional[str] = None
    geo_match: Optional[str] = None
    software_match: Optional[str] = None
    deal_match: Optional[str] = None
    confidence: float = 0.0
    deal_price: Optional[str] = None
    deal_date: Optional[str] = None
    fingerprint: str = ""

    def __post_init__(self):
        if not self.fingerprint:
            raw = f"{self.title.lower().strip()}{self.source_url.strip()}"
            self.fingerprint = hashlib.sha256(raw.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _kw_search(text, keywords):
    text_lower = text.lower()
    for kw in keywords:
        if kw.startswith("\\") or re.search(r"[\\(\[]", kw):
            if re.search(kw, text_lower): return kw
        elif kw in text_lower: return kw
    return None


def _extract_price(text):
    patterns = [
        r'\$\s*(\d+(?:\.\d+)?)\s*billion',
        r'\$\s*(\d+(?:\.\d+)?)\s*million',
        r'\$\s*(\d+(?:\.\d+)?)\s*[Bb]\b',
        r'\$\s*(\d+(?:\.\d+)?)\s*[Mm]\b',
        r'\$\s*(\d{1,3}(?:,\d{3}){2,})',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            raw = match.group(0).strip().lower()
            if 'billion' in raw or raw.rstrip().endswith('b'):
                return f"${re.search(r'[0-9.]+', raw).group()}B"
            elif 'million' in raw or raw.rstrip().endswith('m'):
                return f"${re.search(r'[0-9.]+', raw).group()}M"
            else:
                return match.group(0).strip()
    return None


def _extract_deal_date(text):
    month_names = {name.lower(): num for num, name in enumerate(calendar.month_name) if num}
    month_abbrs = {name.lower(): num for num, name in enumerate(calendar.month_abbr) if num}

    p1 = r'(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})'
    m = re.search(p1, text)
    if m:
        ms = re.match(r'[A-Za-z]+', m.group(0)).group().lower().rstrip('.')
        day, year = int(m.group(1)), int(m.group(2))
        mn = month_names.get(ms) or month_abbrs.get(ms)
        if mn and 1 <= day <= 31 and 2020 <= year <= 2030:
            return f"{year}-{mn:02d}-{day:02d}"

    p2 = r'\b(\d{1,2})/(\d{1,2})/(\d{4})\b'
    m = re.search(p2, text)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= d <= 31 and 2020 <= y <= 2030:
            return f"{y}-{mo:02d}-{d:02d}"

    p3 = r'\b[Qq]([1-4])\s+(\d{4})\b'
    m = re.search(p3, text)
    if m:
        q, y = int(m.group(1)), int(m.group(2))
        if 2020 <= y <= 2030:
            return f"{y}-{(q-1)*3+1:02d}-01"
    return None


def _find_geo(combined, states, abbrevs, metros):
    """Find geographic match in text. Returns match string or None."""
    for state in states:
        if state in combined: return state.title()
    for abbr in abbrevs:
        if re.search(rf"\b{abbr}\b", combined): return abbr.upper()
    for metro in metros:
        if metro in combined: return metro.title()
    return None


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_article(title, body, region="nationwide"):
    combined = f"{title} {body}".lower()
    combined_original = f"{title} {body}"

    for ex in EXCLUDE_KEYWORDS:
        if ex in combined: return None

    # Geographic match based on region
    if region == "midwest":
        geo_hit = _find_geo(combined, MIDWEST_STATES, MIDWEST_ABBREVS, MIDWEST_METROS)
    else:
        geo_hit = _find_geo(combined, US_STATES, US_ABBREVS, US_METROS)
        # Also try to match without geo for nationwide (software + deal type is enough)
        # but we still want geo if available for display

    sw_hit = _kw_search(combined, SOFTWARE_KEYWORDS)
    if not sw_hit: return None

    deal_hit = _kw_search(combined, ACQUISITION_KEYWORDS)
    if not deal_hit: return None

    # For nationwide: geo is nice-to-have, not required
    # For midwest: geo is required
    if region == "midwest" and not geo_hit:
        return None

    deal_price = _extract_price(combined_original)
    deal_date = _extract_deal_date(combined_original)

    # Score
    score = 0.5
    for sig in LMM_SIGNALS:
        if sig.startswith("\\") or re.search(r"[\\(\[]", sig):
            if re.search(sig, combined): score += 0.1; break
        elif sig in combined: score += 0.1; break
    score += min(sum(1 for kw in ACQUISITION_KEYWORDS if kw in combined) * 0.05, 0.2)
    if geo_hit: score += 0.05
    if deal_price: score += 0.05
    score = min(round(score, 2), 1.0)

    summary = body[:500].strip()
    if len(body) > 500: summary += "..."

    return Deal(
        title=title.strip(), summary=summary, source_url="", source_name="",
        geo_match=geo_hit or "United States",
        software_match=sw_hit, deal_match=deal_hit,
        confidence=score, deal_price=deal_price, deal_date=deal_date,
    )


# ---------------------------------------------------------------------------
# Scrapers
# ---------------------------------------------------------------------------

def scrape_google_news(region="nationwide"):
    deals = []
    # Broader queries that don't require geographic terms
    queries = [
        "software+company+acquired",
        "saas+acquisition+2026",
        "software+acquisition+majority",
        "technology+company+buyout",
        "managed+services+acquisition",
        "software+platform+acquired",
        "it+services+company+acquired",
        "cybersecurity+company+acquisition",
        "fintech+acquisition+2026",
        "erp+software+acquired",
        "vertical+saas+acquisition",
        "software+recapitalization",
    ]
    if region == "midwest":
        queries.extend([
            "software+acquisition+midwest",
            "saas+acquisition+ohio+michigan+illinois",
            "technology+acquisition+indiana+wisconsin+minnesota",
        ])

    seen = set()
    for q in queries:
        url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
        try:
            feed = feedparser.parse(url)
            for entry in feed.entries[:12]:
                link = entry.get("link", "")
                if link in seen: continue
                seen.add(link)
                title = entry.get("title", "")
                summary = entry.get("summary", "")
                body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
                deal = score_article(title, body, region)
                if deal:
                    deal.source_url = link
                    deal.source_name = "Google News"
                    deals.append(deal)
        except Exception:
            pass
    return deals


def scrape_prnewswire(region="nationwide"):
    deals = []
    try:
        feed = feedparser.parse("https://www.prnewswire.com/rss/news-releases-list.rss")
        for entry in feed.entries[:80]:
            title = entry.get("title", "")
            summary = entry.get("summary", "")
            body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
            deal = score_article(title, body, region)
            if deal:
                deal.source_url = entry.get("link", "")
                deal.source_name = "PR Newswire"
                deals.append(deal)
    except Exception:
        pass
    return deals


def scrape_globenewswire(region="nationwide"):
    deals = []
    try:
        feed = feedparser.parse("https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewsWire%20-%20News%20Releases")
        for entry in feed.entries[:80]:
            title = entry.get("title", "")
            summary = entry.get("summary", "")
            body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
            deal = score_article(title, body, region)
            if deal:
                deal.source_url = entry.get("link", "")
                deal.source_name = "GlobeNewsWire"
                deals.append(deal)
    except Exception:
        pass
    return deals


def scrape_bizjournals(region="nationwide"):
    deals = []
    if region == "midwest":
        cities = [
            "detroit", "cleveland", "columbus", "cincinnati", "chicago",
            "indianapolis", "milwaukee", "minneapolis", "stlouis", "desmoines",
            "kansascity", "dayton", "grandrapids",
        ]
    else:
        cities = [
            # Midwest
            "detroit", "cleveland", "columbus", "cincinnati", "chicago",
            "indianapolis", "milwaukee", "minneapolis", "stlouis", "desmoines",
            "kansascity", "dayton", "grandrapids",
            # East
            "newyork", "boston", "philadelphia", "pittsburgh", "washington",
            "baltimore", "charlotte", "raleigh", "atlanta",
            # South
            "nashville", "memphis", "orlando", "tampabay", "jacksonville",
            "miami", "birmingham", "louisville",
            # West
            "sanfrancisco", "sanjose", "losangeles", "sandiego", "seattle",
            "portland", "denver", "phoenix", "saltlakecity",
            # Texas
            "dallas", "houston", "sanantonio", "austin",
        ]
    for city in cities:
        try:
            feed = feedparser.parse(f"https://feeds.bizjournals.com/bizj_{city}")
            for entry in feed.entries[:8]:
                title = entry.get("title", "")
                summary = entry.get("summary", "")
                body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
                deal = score_article(title, body, region)
                if deal:
                    deal.source_url = entry.get("link", "")
                    deal.source_name = f"BizJournals ({city.title()})"
                    deals.append(deal)
        except Exception:
            pass
    return deals


def run_all_scrapers(region="nationwide"):
    all_deals = []
    for fn in [scrape_google_news, scrape_prnewswire, scrape_globenewswire, scrape_bizjournals]:
        try:
            all_deals.extend(fn(region))
        except Exception:
            pass
    return all_deals


def deduplicate(deals):
    seen_fps = set()
    unique = []
    for d in deals:
        if d.fingerprint not in seen_fps:
            seen_fps.add(d.fingerprint)
            unique.append(d)
    return unique


# ---------------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------------

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            # Parse region from query string
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            region = params.get("region", ["nationwide"])[0].lower()
            if region not in ("nationwide", "midwest"):
                region = "nationwide"

            raw = run_all_scrapers(region)
            unique = deduplicate(raw)
            unique.sort(key=lambda d: d.confidence, reverse=True)

            result = {
                "status": "ok",
                "region": region,
                "scan_time": datetime.now(tz=timezone.utc).isoformat(),
                "new_count": len(unique),
                "total_count": len(unique),
                "deals": [
                    {
                        "id": d.fingerprint,
                        "title": d.title,
                        "summary": d.summary,
                        "source_url": d.source_url,
                        "source_name": d.source_name,
                        "discovered_at": d.discovered_at,
                        "buyer": d.buyer,
                        "seller": d.seller,
                        "geo_match": d.geo_match,
                        "software_match": d.software_match,
                        "deal_match": d.deal_match,
                        "confidence": d.confidence,
                        "deal_price": d.deal_price,
                        "deal_date": d.deal_date,
                    }
                    for d in unique
                ],
                "stats": {},
            }

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode())
