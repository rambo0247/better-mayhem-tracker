"""Writes the cells a migrated matches.db holds, typed and bit-exact, as the
JSON fixture tests/db_compat.rs compares the Rust migration against. TEXT and
BLOB are hex, REAL is its f64 bits, and raw_gz is its gunzipped text in hex.
Usage: python3 -I capture-cells.py <matches.db> <out.json>"""
import gzip, json, os, sqlite3, struct, sys

QUERIES = [
    "SELECT game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid, game_version, favorite, raw_gz FROM games ORDER BY game_id",
    "SELECT * FROM match_participants ORDER BY game_id, participant_id",
    "SELECT * FROM match_participant_augments ORDER BY game_id, participant_id, slot",
    "SELECT game_id, champion_id, win, kills, deaths, assists, double_kills, triple_kills, quadra_kills, penta_kills, total_damage_dealt, total_damage_taken, gold_earned, total_heal, largest_killing_spree, item0, item1, item2, item3, item4, item5, item6, spell1, spell2 FROM player_stats ORDER BY game_id",
    "SELECT game_id, slot, augment_id FROM game_augments ORDER BY game_id, slot",
    "SELECT puuid, game_name, tag_line, summoner_id, account_id, profile_icon, updated_at FROM summoner ORDER BY puuid",
    "SELECT key, value FROM settings WHERE key IN ('hidden_queues', 'augment_slots') ORDER BY key",
]

class Text(bytes):
    """A TEXT cell's bytes as stored, which may not be valid UTF-8."""


def cell(name, v):
    if v is None:
        return None
    if isinstance(v, int):
        return {"int": str(v)}
    if isinstance(v, float):
        return {"real": struct.pack(">d", v).hex()}
    if isinstance(v, Text):
        return {"text": v.hex()}
    if name == "raw_gz":
        return {"gunzipped": gzip.decompress(v).hex()}
    return {"blob": bytes(v).hex()}

path = sys.argv[1]
mode = "mode=ro" if os.path.exists(path + "-wal") else "immutable=1"
conn = sqlite3.connect(f"file:{path}?{mode}", uri=True)
conn.text_factory = Text
out = []
for sql in QUERIES:
    cur = conn.execute(sql)
    names = [d[0] for d in cur.description]
    out.append({"sql": sql, "rows": [[cell(n, v) for n, v in zip(names, row)] for row in cur]})
json.dump({"user_version": conn.execute("PRAGMA user_version").fetchone()[0], "queries": out}, open(sys.argv[2], "w"), indent=1)
print("wrote", sys.argv[2], {q["sql"].split(" FROM ")[1].split()[0]: len(q["rows"]) for q in out})
