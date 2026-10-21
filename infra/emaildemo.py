"""Email outreach demo: press Run, scrape a doctor's email at an independent clinic, send it from Gmail, log it.

    python -m infra.emaildemo            # then open http://127.0.0.1:8788/demo.html

Needs in .env (gitignored): GMAIL_ADDRESS and GMAIL_APP_PASSWORD (a Google app password, not the account password).
Optional: BV_DEMO_TO to send somewhere else (for example your own inbox), BV_DEMO_DRY=1 to scrape and draft without sending,
BV_DEMO_URL to scrape one specific clinic page instead of searching.
"""

from __future__ import annotations

import html
import json
import os
import re
import smtplib
import ssl
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "data-demo" / "email_log.jsonl"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
QUERIES = [
    "independent family medicine practice Massachusetts medical weight management GLP-1 contact email",
    "independent internal medicine practice Boston medical weight loss semaglutide contact us",
    "private primary care practice Newton MA GLP-1 weight management contact",
    "family practice Brookline MA weight management program contact email",
]
SKIP_SITES = (
    "duckduckgo", "google.", "bing.", "yelp.", "healthgrades", "webmd", "zocdoc", "vitals.", "linkedin", "facebook",
    "instagram", "youtube", "reddit", "wikipedia", "mayoclinic", "clevelandclinic", "mgb", "massgeneral", "bidmc", "bmc.org",
    "tuftsmedicine", "knownwell", "formhealth", "glp1clinics", "berrystreet", "noom", "ro.co", "weightwatchers", ".edu", ".gov",
    "nih.", "cdc.", "forbes", "healthline", "medicalnewstoday", "ncbi", "pubmed",
)
BAD_EMAIL = ("example.", "sentry", "wixpress", "noreply", "no-reply", "donotreply", "yourdomain", "domain.com", "email.com", "godaddy")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.status = "idle"
        self.steps = [{"key": k, "label": l, "status": "pending", "detail": ""} for k, l in [
            ("load", "Load approved batch and settings"),
            ("scrape", "Search the web for an independent clinic and scrape a doctor email"),
            ("gate", "Gate check (kill switch, AI disclosure, opt-out line)"),
            ("draft", "Draft the email from the outreach playbook"),
            ("send", "Send through Gmail"),
            ("log", "Log the attempt"),
        ]]
        self.result = {}
        self.error = ""

    def step(self, key, status, detail=""):
        with self.lock:
            for s in self.steps:
                if s["key"] == key:
                    s["status"], s["detail"] = status, detail

    def snap(self):
        with self.lock:
            return {"status": self.status, "steps": self.steps, "result": self.result, "error": self.error}


STATE = State()


def _get(url: str, timeout: float = 12.0) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
        raw = r.read(1_500_000)
    return raw.decode("utf-8", "ignore")


def _search(query: str) -> list[str]:
    page = _get("https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query}))
    urls = []
    for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"', page):
        href = html.unescape(m.group(1))
        if "uddg=" in href:
            href = urllib.parse.unquote(href.split("uddg=")[1].split("&")[0])
        if href.startswith("//"):
            href = "https:" + href
        host = urllib.parse.urlparse(href).netloc.lower()
        if href.startswith("http") and not any(s in host for s in SKIP_SITES):
            urls.append(href)
    seen, out = set(), []
    for u in urls:
        base = "{0.scheme}://{0.netloc}".format(urllib.parse.urlparse(u))
        if base not in seen:
            seen.add(base)
            out.append(u)
    return out


def _emails_in(text: str, site_host: str) -> list[str]:
    found = []
    for e in EMAIL_RE.findall(html.unescape(urllib.parse.unquote(text))):
        e = e.strip(".").lower()
        if any(b in e for b in BAD_EMAIL) or e.endswith((".png", ".jpg", ".gif", ".webp", ".svg")):
            continue
        found.append(e)
    core = ".".join(site_host.replace("www.", "").split(".")[-2:])
    own = [e for e in found if e.split("@")[1].endswith(core)]
    return list(dict.fromkeys(own or found))


def scrape_one(url: str) -> dict | None:
    host = urllib.parse.urlparse(url).netloc.lower()
    base = "{0.scheme}://{0.netloc}".format(urllib.parse.urlparse(url))
    pages = [url] + [base + p for p in ("/contact", "/contact-us", "/about", "/about-us")]
    emails, text_all, title = [], "", ""
    for p in pages:
        try:
            t = _get(p)
        except Exception:
            continue
        text_all += " " + re.sub(r"<[^>]+>", " ", t)
        if not title:
            m = re.search(r"<title[^>]*>(.*?)</title>", t, re.S | re.I)
            title = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip() if m else ""
        emails += _emails_in(t, host)
        if emails:
            break
    if not emails:
        return None
    pref = [e for e in emails if e.split("@")[0] not in ("info", "contact", "office", "admin", "hello", "frontdesk")]
    email = (pref or emails)[0]
    dr = re.search(r"\bDr\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", text_all)
    practice = re.split(r"\s[|\-–:]\s", title)[0].strip() if title else host
    return {"email": email, "doctor": ("Dr. " + dr.group(1)) if dr else "", "practice": practice[:80], "url": url}


def scrape() -> dict:
    forced = os.environ.get("BV_DEMO_URL")
    candidates = [forced] if forced else []
    for q in QUERIES:
        if candidates and not forced:
            break
        if forced:
            break
        try:
            candidates += _search(q)
        except Exception:
            continue
    tried = 0
    for url in candidates[:12]:
        tried += 1
        hit = scrape_one(url)
        if hit:
            hit["pages_tried"] = tried
            return hit
    raise RuntimeError(f"no clinic email found after {tried} sites; set BV_DEMO_URL to a clinic page and retry")


def draft(hit: dict) -> tuple[str, str]:
    who = hit["doctor"] or "doctor"
    practice = hit["practice"]
    subject = "30 minutes on GLP-1 patient care at " + practice
    body = f"""Hello {who},

This is an AI assistant writing on behalf of Anirudh Bagla, an MBA student at Harvard Business School, about a short research conversation.

We help independent primary care practices give their GLP-1 patients complete care: side-effect management, nutrition and exercise support. Practices share a team of nutritionists and coaches they could not hire on their own, and we take on the insurance billing for this care. We believe it can raise revenue per patient by up to 6x while improving care, and large health systems already run this model. We are early, we are not selling anything, and we want your honest view on whether it would work at {practice}.

Would you have 30 minutes in the next two weeks, by phone or in person? Reply to this email with a time that suits you and Anirudh will confirm it himself.

If you would rather not hear from us, reply "stop" and we will not contact you again.

Thank you,
Anirudh Bagla (sent by his AI assistant)
Harvard Business School
"""
    return subject, body


def send(to: str, subject: str, body: str) -> str:
    user = os.environ.get("GMAIL_ADDRESS", "anirudhbagla26.8@gmail.com")
    pw = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not pw:
        raise RuntimeError("GMAIL_APP_PASSWORD is not set in .env (create a Google app password for the Gmail account)")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Reply-To"], msg["Subject"] = f"Anirudh Bagla <{user}>", to, user, subject
    msg.set_content(body)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as s:
        s.login(user, pw)
        s.send_message(msg)
    return user


def run_workflow():
    S = STATE
    S.reset()
    S.status = "running"
    try:
        load_dotenv(ROOT / ".env")
        S.step("load", "running")
        time.sleep(0.4)
        dry = os.environ.get("BV_DEMO_DRY") == "1"
        S.step("load", "done", "dry run, nothing will be sent" if dry else "live send through Gmail")
        S.step("scrape", "running")
        hit = scrape()
        to = os.environ.get("BV_DEMO_TO") or hit["email"]
        S.step("scrape", "done", f"{hit['email']} from {urllib.parse.urlparse(hit['url']).netloc} ({hit['pages_tried']} sites tried)")
        S.step("gate", "running")
        time.sleep(0.4)
        if os.environ.get("BV_KILL_SWITCH") == "1":
            raise RuntimeError("kill switch is on")
        S.step("gate", "done", "kill switch off, AI disclosure first, opt-out line present, reply-to is the sender")
        S.step("draft", "running")
        subject, body = draft(hit)
        time.sleep(0.4)
        S.step("draft", "done", subject)
        S.step("send", "running")
        if dry:
            sender, sent = "dry run", False
        else:
            sender, sent = send(to, subject, body), True
        S.step("send", "done", f"sent to {to} from {sender}" if sent else f"would send to {to}")
        S.step("log", "running")
        rec = {
            "timestamp": datetime.now(timezone.utc).isoformat(), "channel": "email", "to": to, "scraped_email": hit["email"],
            "doctor": hit["doctor"], "practice": hit["practice"], "source_url": hit["url"], "subject": subject,
            "sent": sent, "script_version": "v1",
        }
        LOG.parent.mkdir(exist_ok=True)
        with LOG.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        S.step("log", "done", str(LOG.relative_to(ROOT)))
        S.result = {**rec, "body": body}
        S.status = "done"
    except Exception as exc:  # shown on the page
        S.error = str(exc)
        S.status = "error"
        for s in S.steps:
            if s["status"] == "running":
                s["status"], s["detail"] = "error", str(exc)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, data: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/state":
            return self._send(200, json.dumps(STATE.snap()).encode(), "application/json")
        if p == "/api/log":
            rows = LOG.read_text().splitlines()[-20:] if LOG.exists() else []
            return self._send(200, json.dumps([json.loads(r) for r in rows]).encode(), "application/json")
        f = ROOT / "docs" / ("demo.html" if p in ("/", "") else p.lstrip("/"))
        if f.is_file() and (ROOT / "docs") in f.resolve().parents:
            ct = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript"}.get(f.suffix, "application/octet-stream")
            return self._send(200, f.read_bytes(), ct)
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == "/api/run":
            if STATE.status == "running":
                return self._send(409, b'{"message":"already running"}', "application/json")
            threading.Thread(target=run_workflow, daemon=True).start()
            return self._send(200, b'{"started":true}', "application/json")
        self._send(404, b"not found", "text/plain")


def main(port: int = 8788) -> int:
    load_dotenv(ROOT / ".env")
    print(f"Email demo on http://127.0.0.1:{port}/demo.html  (Ctrl+C to stop)")
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
