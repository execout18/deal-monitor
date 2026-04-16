"""
Vercel Serverless Function: /api/scan
Runs the full scraper pipeline on demand and returns JSON results.
No database persistence — fresh scrape each time (POC mode).
"""

import json
import re
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, asdict, field
from typing import Optional
from http.server import BaseHTTPRequestHandler

import feedparser
import requests
from bs4 import BeautifulSoup

log = logging.getLogger("deal_scan")

# ---------------------------------------------------------------------------
# Configuration (copied from deal_monitor.py — self-contained for Vercel)
# ---------------------------------------------------------------------------

MIDWEST_STATES = {"michigan", "ohio", "illinois", "indiana", "wisconsin", "minnesota", "iowa", "missouri"}
MIDWEST_ABBREVS = {"mi", "oh", "il", "in", "wi", "mn", "ia", "mo"}
MIDWEST_METROS = {
    "detroit", "grand rapids", "ann arbor", "cleveland", "columbus", "cincinnati",
    "chicago", "indianapolis", "milwaukee", "madison", "minneapolis", "st. paul",
    "st paul", "des moines", "cedar rapids", "st. louis", "st louis", "kansas city",
    "dayton", "akron", "toledo", "lansing", "kalamazoo", "fort wayne", "green bay",
    "rockford", "peoria", "springfield", "duluth", "rochester", "bloomington",
    "sioux city", "quad cities", "champaign", "evansville", "south bend",
}

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
# Extraction helpers
# ---------------------------------------------------------------------------

def _kw_search(text, keywords):
    text_lower = text.lower()
    for kw in keywords:
        if kw.startswith("\\") or re.search(r"[\\(\[]", kw):
            if re.search(kw, text_lower):
                return kw
        elif kw in text_lower:
            return kw
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
            raw = match.group(0).strip()
            lower = raw.lower()
            if 'billion' in lower or lower.rstrip().endswith('b'):
                num = re.search(r'[\d.]+', raw).group()
                return f"${num}B"
            elif 'million' in lower or lower.rstrip().endswith('m'):
                num = re.search(r'[\d.]+', raw).group()
                return f"${num}M"
            else:
                return raw
    return None


def _extract_deal_date(text):
    import calendar
    month_names = {name.lower(): num for num, name in enumerate(calendar.month_name) if num}
    month_abbrs = {name.lower(): num for num, name in enumerate(calendar.month_abbr) if num}

    pattern1 = r'(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})'
    match = re.search(pattern1, text)
    if match:
        full = match.group(0)
        month_str = re.match(r'[A-Za-z]+', full).group().lower().rstrip('.')
        day, year = int(match.group(1)), int(match.group(2))
        month_num = month_names.get(month_str) or month_abbrs.get(month_str)
        if month_num and 1 <= day <= 31 and 2020 <= year <= 2030:
            return f"{year}-{month_num:02d}-{day:02d}"

    pattern2 = r'\b(\d{1,2})/(\d{1,2})/(\d{4})\b'
    match = re.search(pattern2, text)
    if match:
        m, d, y = int(match.group(1)), int(match.group(2)), int(match.group(3))
        if 1 <= m <= 12 and 1 <= d <= 31 and 2020 <= y <= 2030:
            return f"{y}-{m:02d}-{d:02d}"

    pattern3 = r'\b[Qq]([1-4])\s+(\d{4})\b'
    match = re.search(pattern3, text)
    if match:
        q, y = int(match.group(1)), int(match.group(2))
        if 2020 <= y <= 2030:
            return f"{y}-{(q-1)*3+1:02d}-01"

    return None


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_article(title, body):
    combined = f"{title} {body}".lower()
    combined_original = f"{title} {body}"

    for ex in EXCLUDE_KEYWORDS:
        if ex in combined:
            return None

    geo_hit = None
    for state in MIDWEST_STATES:
        if state in combined:
            geo_hit = state; break
    if not geo_hit:
        for abbr in MIDWEST_ABBREVS:
            if re.search(rf"\b{abbr}\b", combined):
                geo_hit = abbr.upper(); break
    if not geo_hit:
        for metro in MIDWEST_METROS:
            if metro in combined:
                geo_hit = metro.title(); break
    if not geo_hit:
        return None

    sw_hit = _kw_search(combined, SOFTWARE_KEYWORDS)
    if not sw_hit:
        return None

    deal_hit = _kw_search(combined, ACQUISITION_KEYWORDS)
    if not deal_hit:
        return None

    deal_price = _extract_price(combined_original)
    deal_date = _extract_deal_date(combined_original)

    score = 0.5
    for sig in LMM_SIGNALS:
        if sig.startswith("\\") or re.search(r"[\\(\[]", sig):
            if re.search(sig, combined): score += 0.1; break
        elif sig in combined: score += 0.1; break
    score += min(sum(1 for kw in ACQUISITION_KEYWORDS if kw in combined) * 0.05, 0.2)
    geo_count = sum(1 for m in MIDWEST_METROS if m in combined) + sum(1 for s in MIDWEST_STATES if s in combined)
    score += min(geo_count * 0.03, 0.1)
    if deal_price: score += 0.05
    score = min(round(score, 2), 1.0)

    summary = body[:500].strip()
    if len(body) > 500: summary += "..."

    return Deal(
        title=title.strip(), summary=summary, source_url="", source_name="",
        geo_match=geo_hit, software_match=sw_hit, deal_match=deal_hit,
        confidence=score, deal_price=deal_price, deal_date=deal_date,
    )


# ---------------------------------------------------------------------------
# Scrapers
# ---------------------------------------------------------------------------

def scrape_google_news():
    deals = []
    queries = [
        "software+acquisition+midwest",
        "saas+acquisition+ohio+michigan+illinois",
        "software+company+acquired+indiana+wisconsin+minnesota",
        "technology+acquisition+iowa+missouri+midwest",
        "software+buyout+lower+middle+market+midwest",
        "managed+services+acquisition+great+lakes",
    ]
    seen = set()
    for q in queries:
        url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
        try:
            feed = feedparser.parse(url)
            for entry in feed.entries[:15]:
                link = entry.get("link", "")
                if link in seen: continue
                seen.add(link)
                title = entry.get("title", "")
                summary = entry.get("summary", "")
                body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
                deal = score_article(title, body)
                if deal:
                    deal.source_url = link
                    deal.source_name = "Google News"
                    deals.append(deal)
        except Exception:
            pass
    return deals


def scrape_prnewswire():
    deals = []
    try:
        feed = feedparser.parse("https://www.prnewswire.com/rss/news-releases-list.rss")
        for entry in feed.entries[:50]:
            title = entry.get("title", "")
            summary = entry.get("summary", "")
            body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
            deal = score_article(title, body)
            if deal:
                deal.source_url = entry.get("link", "")
                deal.source_name = "PR Newswire"
                deals.append(deal)
    except Exception:
        pass
    return deals


def scrape_globenewswire():
    deals = []
    try:
        feed = feedparser.parse("https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewsWire%20-%20News%20Releases")
        for entry in feed.entries[:50]:
            title = entry.get("title", "")
            summary = entry.get("summary", "")
            body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
            deal = score_article(title, body)
            if deal:
                deal.source_url = entry.get("link", "")
                deal.source_name = "GlobeNewsWire"
                deals.append(deal)
    except Exception:
        pass
    return deals


def scrape_bizjournals():
    deals = []
    cities = [
        "detroit", "cleveland", "columbus", "cincinnati", "chicago",
        "indianapolis", "milwaukee", "minneapolis", "stlouis", "desmoines",
        "kansascity", "dayton", "grandrapids",
    ]
    for city in cities:
        try:
            feed = feedparser.parse(f"https://feeds.bizjournals.com/bizj_{city}")
            for entry in feed.entries[:10]:
                title = entry.get("title", "")
                summary = entry.get("summary", "")
                body = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
                deal = score_article(title, body)
                if deal:
                    deal.source_url = entry.get("link", "")
                    deal.source_name = f"BizJournals ({city.title()})"
                    deals.append(deal)
        except Exception:
            pass
    return deals


def run_all_scrapers():
    all_deals = []
    for fn in [scrape_google_news, scrape_prnewswire, scrape_globenewswire, scrape_bizjournals]:
        try:
            all_deals.extend(fn())
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
            raw = run_all_scrapers()
            unique = deduplicate(raw)
            unique.sort(key=lambda d: d.confidence, reverse=True)

            result = {
                "status": "ok",
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
            self.send_header("Cache-Control", "s-maxage=300, stale-while-revalidate=600")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode())
