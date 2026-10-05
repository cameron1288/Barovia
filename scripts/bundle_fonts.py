"""Download the Google Fonts the sheet uses and inline them, so the app looks right offline."""
import base64, re, sys, urllib.request
src, dst = sys.argv[1], sys.argv[2]
html = open(src, encoding="utf-8").read()
m = re.search(r'<link rel="stylesheet" href="(https://fonts\.googleapis\.com/[^"]+)">', html)
try:
    if not m: raise RuntimeError("no font link")
    ua = {"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}
    css = urllib.request.urlopen(urllib.request.Request(m.group(1).replace("&amp;", "&"), headers=ua)).read().decode()
    def inline(mm):
        data = urllib.request.urlopen(urllib.request.Request(mm.group(1), headers=ua)).read()
        return "url(data:font/woff2;base64," + base64.b64encode(data).decode() + ")"
    css = re.sub(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", inline, css)
    html = html.replace(m.group(0), "<style>" + css + "</style>")
    html = html.replace('<link rel="preconnect" href="https://fonts.googleapis.com">', "")
    print("fonts inlined:", len(css), "bytes")
except Exception as e:
    print("font bundling skipped:", e)
open(dst, "w", encoding="utf-8").write(html)
