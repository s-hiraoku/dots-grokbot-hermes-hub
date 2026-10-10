"""Render the two reviewed architecture SVGs using only Python's standard library.

SVGs are layout companions to the adjacent Mermaid sources; edit both together.
PNG previews are rendered with rsvg-convert outside this script. No network calls.
"""
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COLORS = {'confirmed': ('#ecfdf5', '#15803d'), 'planned': ('#fffbeb', '#b45309'), 'code': ('#eff6ff', '#1d4ed8'), 'neutral': ('#f8fafc', '#64748b')}

def text(x, y, value, size=22, weight='normal', anchor='start'):
    return f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{escape(value)}</text>'

def box(x, y, w, h, title, lines, kind='planned'):
    fill, stroke = COLORS[kind]
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
    out += text(x+18, y+34, title, 25, 'bold')
    for i, line in enumerate(lines):
        out += text(x+18, y+65+i*29, line, 21)
    return out

def arrow(points, confirmed=False, two_way=False):
    dash = '' if confirmed else ' stroke-dasharray="9 7"'
    start = ' marker-start="url(#arrow)"' if two_way else ''
    return f'<polyline points="{points}" fill="none" stroke="#475569" stroke-width="2.5"{dash} marker-end="url(#arrow)"{start}/>'

def svg(width, height, title, description, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title description">
<title id="title">{escape(title)}</title><desc id="description">{escape(description)}</desc>
<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto-start-reverse"><path d="M0 0 L9 4.5 L0 9Z" fill="#475569"/></marker></defs>
<rect width="100%" height="100%" fill="white"/>
<g font-family="Arial, Helvetica, sans-serif" fill="#0f172a">{body}</g></svg>\n'''

def overview():
    b = text(28, 40, 'HAB / current architecture', 30, 'bold') + text(28, 72, '2026-10-10 / existing MCP is separate from Hub', 20)
    b += box(28, 98, 278, 143, 'Dots / Stallone', ['Personal context', 'ChatGPT MCP: unverified', 'Owner login pending'])
    b += box(334, 98, 278, 143, 'Grok Bot', ['Cloud Worker', 'Existing MCP: owner report', 'Hub: not connected'], 'confirmed')
    b += arrow('473,241 473,288', True) + text(455, 271, 'HTTPS', 20, anchor='end')
    b += arrow('167,241 167,288') + text(149, 271, 'future MCP', 20, anchor='end')
    b += box(28, 290, 584, 130, 'Tailscale Funnel / public HTTPS', ['443 /mcp -> existing model MCP', 'Hub path / port: undecided (8443 candidate)'], 'confirmed')
    b += '<rect x="28" y="467" width="584" height="606" rx="16" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>'
    b += text(48, 501, 'Mac mini / local execution + storage', 25, 'bold')
    b += arrow('320,420 320,527', True) + text(340, 451, 'existing proxy [owner]', 20)
    b += box(80, 530, 480, 110, 'Existing model MCP / 8765', ['Grok connected; no-token rejected [owner]', 'Not HAB Hub'], 'confirmed')
    b += arrow('28,355 12,355 12,720 78,720')
    b += box(80, 686, 480, 137, 'HAB Hub / loopback 8787', ['SQLite / tasks / audit / outbox [code]', 'Hub validates JWT + client + scope', 'Auth0 production wiring: not live'], 'code')
    b += text(82, 671, 'Future Hub ingress; existing /mcp unchanged', 20)
    b += arrow('320,823 320,885', two_way=True) + text(341, 849, 'adapter -> Hub: claim / results', 19) + text(341, 876, 'Hub -> adapter: task response', 19)
    b += box(80, 891, 480, 151, 'Hermes / isolated Runs candidate', ['Profile + dependencies measured [owner]', 'Adapter / short-lived Bearer helper [code]', 'Real key / API / model / roundtrip: unrun'], 'code')
    b += box(28, 1117, 584, 121, 'Auth0 / planned identity provider', ['OAuth tokens to clients; Hub fetches JWKS', 'Not a request proxy; no live Hub setup'])
    b += arrow('562,752 630,752 630,1176 612,1176')
    b += arrow('80,1015 12,1015 12,1347 24,1347')
    b += box(28, 1273, 584, 146, 'Future development resources', ['Claude Code: channel mock / Codex: tooling', 'Cursor: owner expectation; Hub unverified', 'Cua: later local candidate / startup incomplete'])
    b += text(28, 1460, 'Solid: existing config / link [owner report]', 20)
    b += text(28, 1491, 'Dashed: planned / not live   Blue: implemented code', 20)
    b += text(28, 1522, 'Owner evidence does not prove HAB live integration.', 20)
    return svg(640, 1550, 'HAB current architecture overview', 'Owner-reported Grok and existing Funnel MCP are separate from the unconnected HAB Hub, Auth0 and isolated Hermes candidate.', b)

def detailed():
    b = text(32, 43, 'HAB / connections and authentication responsibilities', 29, 'bold') + text(32, 75, '2026-10-10 / no secrets, real hostnames or private paths', 21)
    b += box(32, 110, 284, 145, 'Grok / Cloud Worker', ['Existing MCP works [owner]', 'No-token denial [owner]', 'Hub calls / wake: not live'], 'confirmed')
    b += box(338, 110, 284, 145, 'Dots / Stallone', ['Personal context', 'ChatGPT MCP unverified', 'Owner login pending'])
    b += box(644, 110, 284, 145, 'Auth0 / identity', ['JWT issued to MCP clients', 'Hub checks JWKS; no proxy', 'Live registrations: unset'])
    b += arrow('174,255 174,367', True) + text(192, 302, 'HTTPS MCP [owner report]', 21) + text(192, 332, 'Existing service authenticates', 20)
    b += arrow('480,255 480,345 415,345 415,367') + text(480, 310, 'future HTTPS MCP', 20)
    b += box(32, 372, 470, 160, 'Tailscale Funnel / HTTPS ingress', ['Existing 443 /mcp route [owner]', 'Hub route not chosen / not approved', '8443 client support still unverified'], 'confirmed')
    b += text(536, 408, 'Hub authentication responsibility', 24, 'bold')
    b += text(536, 442, 'Issuer / audience / signature / expiry', 21)
    b += text(536, 473, 'Subject + client + minimal scope', 21)
    b += text(536, 504, 'Fail closed until explicitly wired', 21)
    b += '<rect x="32" y="652" width="896" height="478" rx="16" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>'
    b += text(52, 686, 'Mac mini / Hub and execution remain local', 25, 'bold')
    b += arrow('208,532 208,706', True) + text(50, 575, '/mcp proxy -> loopback', 21) + text(50, 605, 'Existing config / link [owner report]', 21)
    b += box(62, 710, 370, 130, 'Existing model MCP / 8765', ['Separate service / auth unknown', 'Grok works [owner]', 'Cursor: expectation only'], 'confirmed')
    b += arrow('470,532 470,578 712,578 712,706') + text(492, 560, 'Future Hub route; preserve 443 /mcp', 20)
    b += box(526, 710, 370, 170, 'HAB Hub / 8787', ['SQLite tasks / audit / outbox [code]', 'JWT + policy enforcement here', 'Default entrypoint denies all', 'Live Auth0 wiring incomplete'], 'code')
    b += arrow('898,785 946,785 946,255 786,255')
    b += text(644, 280, 'Pinned JWKS fetch / planned', 19)
    b += box(526, 953, 370, 145, 'Outbound Mac adapter', ['Claim / heartbeat / complete -> Hub', 'Task response <- Hub', 'One task / short-lived key [code]'], 'code')
    b += arrow('710,953 710,884', two_way=True) + text(725, 899, 'MCP + separate', 20) + text(725, 927, 'worker identity', 20)
    b += box(62, 953, 370, 145, 'Hermes Runs candidate', ['Inventory-only / memory off', 'Profile + bundle measured [owner]', 'Real API / model: not started'], 'code')
    b += arrow('526,989 472,989 472,930 248,930 248,949')
    b += text(61, 890, 'Adapter -> Runs / loopback-only Bearer', 20)
    b += text(61, 921, 'Separate from Auth0 and model account', 20)
    b += box(32, 1182, 896, 139, 'Future development resources / not Hub-connected', ['Claude Code: channel mock    |    Codex: repo tooling, not a Hub executor', 'Cursor: owner expects availability; API / scopes unverified', 'Cua: later local candidate; startup incomplete.  Workspace / tools / cost approval.'])
    b += arrow('248,1098 248,1178') + text(270, 1162, 'future bounded execution; no arbitrary shell today', 20)
    b += text(32, 1367, 'Solid = existing settings / connection [owner report]. Dashed = planned / not live.', 21)
    b += text(32, 1399, 'Blue = code verified with fixtures. Owner preflight hashes are not live process proof.', 21)
    b += text(32, 1431, 'No current inventory key / API / model / Hub roundtrip. No additional route deployed.', 21)
    return svg(960, 1460, 'HAB detailed connection architecture', 'Solid existing Grok to Funnel to separate model MCP connection is owner-reported. Dashed Hub, Auth0, Dots and Hermes paths are not live. Auth0 verification and loopback Hermes Bearer are distinct.', b)

if __name__ == '__main__':
    (ROOT/'hab-overview.svg').write_text(overview())
    (ROOT/'hab-connections.svg').write_text(detailed())
