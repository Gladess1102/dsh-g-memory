#!/usr/bin/env python3
"""Mine real question/answer pairs out of the session logs.

The previous case set was written by hand, which makes it a test of the author's
imagination rather than of the system. This takes the queries from the logs
verbatim — what was actually asked — and takes the expected answer from the
assistant turn that followed it in that same session, reduced to tokens a
program can check: numbers, ports, version strings, paths, identifiers.

A pair is only a candidate if the user turn reads as a question and the answer
carries at least one such token. Whether the corpus can actually answer it is
decided separately, by retrieving and looking, so a case is never kept on the
assumption that it should be findable.

Usage: mine-real-cases.py <out.json> [sessions] [per-session]
"""
import json, re, subprocess, sys, pathlib, collections

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/mined.json'
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 120
PER = int(sys.argv[3]) if len(sys.argv) > 3 else 3

QUESTION = re.compile(r'[？?]|怎么|如何|为什么|为何|多少|哪些|哪个|哪里|是不是|能不能|有没有|多久|多大|什么时候')
# Things worth checking a memory system against: exact values, not prose.
TOKEN = re.compile(r'\b\d+(?:\.\d+)?(?:\s?(?:MB|GB|KB|s|ms|%|维|倍|个|条))?\b|\b\d{4,5}\b|v?\d+\.\d+\.\d+')
STOP = {'1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '10', '12', '24', '100'}

def tokens(text):
    out = []
    for m in TOKEN.findall(text):
        t = m.strip()
        if t and t not in STOP and len(t) > 1 and t not in out:
            out.append(t)
    return out

def text_of(msg, kind='text'):
    return '\n'.join(b.get('text', '') for b in (msg.get('content') or []) if b.get('type') == kind).strip()

logs = sorted((pathlib.Path.home() / '.dsh/sessions').rglob('session.jsonl.zstd'),
              key=lambda p: p.stat().st_mtime, reverse=True)[:LIMIT]

seen, cases = set(), []
for log in logs:
    try:
        raw = subprocess.run(['zstd', '-d', '-c', '--no-progress', str(log)],
                             capture_output=True, timeout=40).stdout.decode('utf-8', 'replace')
    except Exception:
        continue
    pending, answers = None, []
    for line in raw.split('\n'):
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        kind = e.get('type')
        if kind == 'user/message':
            d = e.get('data', {})
            if (d.get('source') or {}).get('kind') != 'user':
                continue
            text = text_of(d)
            # A question only; a paste or a URL is not a recall probe.
            if not (8 <= len(text) <= 200) or not QUESTION.search(text) or '://' in text:
                continue
            pending = text.replace('\n', ' ').strip()
            answers = []
        elif kind == 'assistant/message' and pending:
            answers.append(text_of(e.get('data', {}).get('message', {})))
            if len(answers) >= 2:
                key = pending[:60]
                if key not in seen:
                    toks = tokens(' '.join(answers))
                    if toks:
                        seen.add(key)
                        cases.append({'query': pending, 'expect': toks[:3], 'session': log.parent.name[:8]})
                pending = None

# Longest questions first would bias toward pastes; keep file order, cap per session.
by_session = collections.Counter()
kept = []
for c in cases:
    if by_session[c['session']] < PER:
        by_session[c['session']] += 1
        kept.append(c)

pathlib.Path(OUT).write_text(json.dumps(kept, ensure_ascii=False, indent=1), encoding='utf-8')
print(f'  扫描 {len(logs)} 个会话日志 → 候选真实用例 {len(cases)} 条，按每会话上限取 {len(kept)} 条')
for c in kept[:6]:
    print(f"    · {c['query'][:44]}  期望 {c['expect']}")
