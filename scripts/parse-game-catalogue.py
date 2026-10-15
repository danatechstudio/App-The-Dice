#!/usr/bin/env python3
"""Turn the café's enriched game catalogue (Markdown) into the importer's manifest.

    python3 scripts/parse-game-catalogue.py data/source/board_game_library_image_references.md

Writes data/game-library-master.json and data/game-library-review.json in the
`rtd-game-library/1` format (docs/GAME_LIBRARY_DEPLOYMENT.md#manifest-format-rtd-game-library1).

The catalogue marks every title "provisional": seen in shelf photos, not checked
on the shelf. So nothing goes in the master file (confirmed holdings, which need
ownership evidence). Every catalogued title goes in the review register with its
details, ready for an admin to confirm; the "Unconfirmed or obscured entries"
go in as uncertain, with no details. The output is deterministic: running it
again on the same file gives the same JSON.
"""

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORMAT = 'rtd-game-library/1'

# The app's audiences (src/games/model.ts AUDIENCES). Other catalogue labels
# ("Teen", "Fans", "Trivia"…) describe the game, not who it suits, and are kept
# on the entry as `source_audience` for reference.
AUDIENCE_MAP = {'Children': 'Children', 'Family': 'Family', 'Adult': 'Adults', 'Adults': 'Adults', 'Party': 'Party', 'Strategy': 'Strategy'}

# Uncertain entries that aren't a game to look for: recorded in the file's notes instead.
NOT_A_TITLE = {'Other partially obscured boxes'}


def source_key(title, edition=None):
    """The importer's matching key (src/games/model.ts sourceKey), to catch duplicates here."""

    def norm(s):
        s = re.sub(r'\s+', ' ', s.replace('‘', "'").replace('’', "'")).strip().lower()
        s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
        s = s.replace('&', ' and ')
        return re.sub(r'[^a-z0-9]+', ' ', s).strip()

    return f"{norm(title)}|{norm(edition) if edition else ''}"


def tidy(s):
    return re.sub(r'\s+', ' ', s.replace('‘', "'").replace('’', "'").replace('“', '"').replace('”', '"')).strip()


def span(text, field, suffix=''):
    """'2-6' -> (2, 6); '2' -> (2, 2); '1+' -> (1, None)."""
    m = re.fullmatch(r'(\d+)(?:-(\d+)|(\+))?' + re.escape(suffix), text)
    if not m:
        raise ValueError(f'{field}: unexpected value {text!r}')
    lo = int(m.group(1))
    if m.group(3):
        return lo, None
    return lo, int(m.group(2)) if m.group(2) else lo


def parse(md):
    lines = md.splitlines()
    games, uncertain, section, current, part = [], [], None, None, 'intro'
    counters = {}

    def finish():
        if current is not None:
            games.append(current)

    for n, line in enumerate(lines, 1):
        if line.startswith('## '):
            finish()
            current = None
            heading = line[3:].strip()
            part = {'Catalogue': 'catalogue', 'Unconfirmed or obscured entries': 'uncertain'}.get(heading, 'other')
            continue
        if part == 'catalogue' and line.startswith('### '):
            finish()
            current = None
            section = line[4:].strip()
            continue
        if part == 'catalogue' and line.startswith('#### '):
            finish()
            counters[section] = counters.get(section, 0) + 1
            current = {'_line': n, '_section': section, '_n': counters[section], 'title': tidy(line[5:])}
            continue
        if part == 'catalogue' and current is not None:
            m = re.fullmatch(r'- \*\*([^*]+):\*\* (.*)', line)
            if m:
                current[m.group(1)] = m.group(2).strip()
        if part == 'uncertain':
            m = re.fullmatch(r'- (.+?)(?: \(([^)]*)\))?', line)
            if m:
                uncertain.append({'title': tidy(m.group(1)), 'note': tidy(m.group(2) or ''), '_line': n})
    finish()
    return games, uncertain


def review_entry(g):
    title = g['title']
    if g['Category'] != g['_section']:
        raise ValueError(f"{title}: category {g['Category']!r} is under {g['_section']!r}")
    if g['Status'] != 'provisional':
        raise ValueError(f"{title}: status {g['Status']!r} (expected provisional)")
    min_age = int(re.fullmatch(r'(\d+)\+', g['Age']).group(1))
    min_players, max_players = span(g['Players'], 'Players')
    t_min, t_max = span(g['Play time'], 'Play time', ' minutes')
    labels = [tidy(a) for a in g['Audience'].split(',')]
    audiences = []
    for a in labels:
        if a in AUDIENCE_MAP and AUDIENCE_MAP[a] not in audiences:
            audiences.append(AUDIENCE_MAP[a])
    reasons = ['Catalogue status: provisional (from shelf photos, not yet checked on the shelf)']
    if not audiences:
        reasons.append(f"No audience from the app's list (the catalogue says \u201c{', '.join(labels)}\u201d)")
    if max_players is None:
        reasons.append(f"Players given as “{g['Players']}”: add the most players before confirming")
    entry = {
        'title': title,
        'edition': None,
        'kind': 'provisional',
        'reasons': reasons,
        'category': g['Category'],
        'audiences': audiences,
        'min_age': min_age,
        'min_players': min_players,
        'max_players': max_players,
        'play_time_min': t_min,
        'play_time_max': t_max,
        'synopsis': tidy(g['Synopsis']),
        'source_title': title,
        'source_evidence': f"Enriched catalogue (15 Oct 2026, from shelf photos): {g['_section']} #{g['_n']}",
        'source_audience': ', '.join(labels),
        'image_lookup': g.get('Image lookup') or None,
    }
    return entry


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = Path(sys.argv[1])
    raw = path.read_bytes()
    md = raw.decode('utf-8')
    games, uncertain = parse(md)

    entries, keys, problems = [], {}, []
    for g in games:
        try:
            e = review_entry(g)
        except (KeyError, ValueError, AttributeError) as err:
            problems.append(f"line {g['_line']} ({g['title']}): {err!r}")
            continue
        key = source_key(e['title'])
        if key in keys:
            problems.append(f"line {g['_line']} ({g['title']}): duplicates {keys[key]}")
            continue
        keys[key] = e['title']
        entries.append(e)

    notes = []
    for u in uncertain:
        if u['title'] in NOT_A_TITLE:
            notes.append(f"{u['title']}: needs a physical stocktake, not a single title.")
            continue
        edition = None
        if source_key(u['title']) in keys:
            # The same title is catalogued: this one is another copy or edition.
            edition = 'Another copy or edition'
        key = source_key(u['title'], edition)
        if key in keys:
            problems.append(f"line {u['_line']} ({u['title']}): duplicates {keys[key]}")
            continue
        keys[key] = u['title']
        entries.append({
            'title': u['title'],
            'edition': edition,
            'kind': 'uncertain',
            'reasons': [f"Uncertain in the catalogue: {u['note'] or 'not identified'}", 'No details recorded: identify the box and fill them in to confirm'],
            'source_title': f"{u['title']} ({u['note']})" if u['note'] else u['title'],
            'source_evidence': 'Enriched catalogue (15 Oct 2026): Unconfirmed or obscured entries',
        })

    if problems:
        sys.exit('Not written:\n' + '\n'.join(problems))

    source = [{'name': path.name, 'sha256': hashlib.sha256(raw).hexdigest(), 'title': md.splitlines()[0].lstrip('# ').strip()}]
    provisional = sum(e['kind'] == 'provisional' for e in entries)
    master = {
        'format': FORMAT,
        'status': 'ready',
        'note': 'Confirmed holdings only. The catalogue marks every title provisional (seen in shelf photos, not checked on the shelf), '
        'so none is confirmed yet: they are all in game-library-review.json for an admin to confirm.',
        'sources': source,
        'games': [],
    }
    review = {
        'format': FORMAT,
        'status': 'ready',
        'note': f'{provisional} provisional titles with details, and {len(entries) - provisional} uncertain entries. Never public until an admin confirms one.',
        'notes': notes,
        'sources': source,
        'entries': entries,
    }
    for name, data in (('game-library-master.json', master), ('game-library-review.json', review)):
        (ROOT / 'data' / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{len(games)} catalogued, {provisional} provisional and {len(entries) - provisional} uncertain review entries, {len(notes)} notes, 0 confirmed.')


if __name__ == '__main__':
    main()
