#!/usr/bin/env python3
"""
team_defense_by_position_boxscore_pergame.py

Versione aggiornata (2025-11):
- Calcolo PER PARTITA delle concessioni aggregate per ruolo (G/F/C/OTHER) su PTS/REB/AST.
- Selezione GAME_ID più robusta: unione di TeamGameLog e LeagueGameFinder, su più season types.
- Cache dei game id aggiornata (merge incrementale) + opzionale refresh.
- Scelta della posizione per bucket configurabile: START_POSITION (se disponibile) o POSITION di roster.
- Parser posizioni più permissivo per ridurre gli "OTHER".

Uso:
    python team_defense_by_position_boxscore_pergame.py --season 2025-26 --team LAL --save

Opzioni principali:
    --exclude-dnp           Esclude righe con MIN null/0
    --refresh-games         Ignora la cache dei game id e li ricalcola (consigliato se noti poche partite)
    --role-mode             Sorgente per ruolo: roster|start|either  [default: either]
    --season-types          Lista separata da virgole fra: Regular Season,Pre Season,Playoffs [default: Regular Season]
    --debug                 Log dettagliati

Note sul calcolo:
- Per ciascuna partita si sommano i PTS/REB/AST dei soli AVVERSARI del team target,
  raggruppando per bucket (G/F/C/OTHER). Quindi si fa la media sulle partite scansionate.
- Metriche in output:
    * *_per_game                  → media per TUTTE le partite scansionate (0 se in una partita il bucket non si presenta)
    * *_per_game_when_present     → media solo sulle partite dove il bucket è presente
"""

import os
import time
import json
import argparse
from collections import defaultdict
from datetime import datetime, timedelta

import pandas as pd
from nba_api.stats.static import teams
from nba_api.stats.endpoints import commonteamroster, teamgamelog, boxscoretraditionalv2
from nba_api.stats.endpoints import leaguegamefinder

CACHE_DIR = "./cache"
os.makedirs(CACHE_DIR, exist_ok=True)

# -------------------- Cache helpers --------------------

def load_cache(name):
    path = os.path.join(CACHE_DIR, name)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None

def save_cache(name, data):
    path = os.path.join(CACHE_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _cache_suffix(exclude_dnp):
    return "exdnp" if exclude_dnp else "incldnp"


def _team_cache_name(team_abbr, season, exclude_dnp, role_mode, season_types_key):
    role_key = role_mode.lower()
    return f"def_by_pos_box_pergame_{team_abbr}_{season}_{_cache_suffix(exclude_dnp)}_{role_key}_{season_types_key}.json"


def _all_cache_name(season, exclude_dnp, role_mode, season_types_key):
    role_key = role_mode.lower()
    return f"def_by_pos_box_pergame_ALL_{season}_{_cache_suffix(exclude_dnp)}_{role_key}_{season_types_key}.json"


def _load_all_cache(season, exclude_dnp, role_mode, season_types_key):
    return load_cache(_all_cache_name(season, exclude_dnp, role_mode, season_types_key))


def _update_all_cache(season, exclude_dnp, role_mode, season_types_key, team_result, debug=False):
    team_abbr = (team_result.get("target_team_abbr") or "").upper()
    if not team_abbr:
        return
    cache_name = _all_cache_name(season, exclude_dnp, role_mode, season_types_key)
    cached = load_cache(cache_name) or {
        "season": season,
        "exclude_dnp": bool(exclude_dnp),
        "role_mode": role_mode,
        "season_types": season_types_key.split("|"),
        "teams": {},
    }
    teams_map = cached.setdefault("teams", {})
    teams_map[team_abbr] = team_result
    try:
        save_cache(cache_name, cached)
    except Exception as exc:
        if debug:
            print(f"[cache] unable to update ALL cache {cache_name}: {exc}")

# -------------------- Team maps --------------------

def build_team_maps():
    teams_list = teams.get_teams()
    id_to_full = {}
    abbr_to_full = {}
    id_to_abbr = {}
    full_to_abbr = {}
    for t in teams_list:
        tid = t.get("id")
        full = t.get("full_name")
        abbr = t.get("abbreviation")
        id_to_full[tid] = full
        if abbr:
            abbr_to_full[abbr] = full
            id_to_abbr[tid] = abbr
            full_to_abbr[full.lower()] = abbr
    return id_to_full, abbr_to_full, id_to_abbr, full_to_abbr

# -------------------- Player -> position map (roster) --------------------

def build_player_position_map(season, debug=False):
    cache_name = f"player_pos_map_{season}.json"
    cached = load_cache(cache_name)
    if cached:
        if debug:
            print(f"[cache] loaded player_pos_map {cache_name}")
        return {int(k): v for k, v in cached.items()}

    if debug:
        print("Costruisco player->position map (roster)...")

    id_to_full, abbr_to_full, id_to_abbr, full_to_abbr = build_team_maps()
    player_pos = {}
    for team_id in id_to_full.keys():
        try:
            roster_df = commonteamroster.CommonTeamRoster(team_id, season=season).get_data_frames()[0]
            for _, r in roster_df.iterrows():
                pid = r.get("PLAYER_ID")
                if pid is None:
                    continue
                pid = int(pid)
                pos = ""
                if "POSITION" in r.index:
                    pos = (r.get("POSITION") or "").strip()
                elif "POS" in r.index:
                    pos = (r.get("POS") or "").strip()
                player_pos[pid] = pos if pos else "UNK"
        except Exception as e:
            if debug:
                print(f"[roster] Warning team_id={team_id}: {e}")
            time.sleep(0.4)

    save_cache(cache_name, {str(k): v for k, v in player_pos.items()})
    return player_pos

# -------------------- Role helpers --------------------

def normalize_first_token(pos: str) -> str:
    raw = (pos or "").upper().strip()
    if not raw:
        return "UNK"
    first = raw.split(r"-")[0]
    # consenti separatori alternativi
    first = first.split("/")[0].split(",")[0].split(" ")[0]
    alias = {
        "GUARD": "G", "GUA": "G", "W": "F", "WING": "F", "FWD": "F",
        "FORWARD": "F", "CENTER": "C", "CTR": "C", "BIG": "C",
        "GF": "G", "FG": "F",
    }
    return alias.get(first, first)


def to_bucket_from_tokens(token: str) -> str:
    s = token
    if s in ("PG", "SG", "G"):
        return "G"
    if s in ("SF", "PF", "F"):
        return "F"
    if s == "C":
        return "C"
    return "OTHER"


def choose_bucket(pid, start_pos, roster_pos, role_mode="either") -> str:
    """Sceglie il bucket da START_POSITION o dal roster in base al role_mode.
       role_mode =
         - 'start'  → usa solo START_POSITION (bench → OTHER/UNK)
         - 'roster' → usa solo roster POSITION
         - 'either' → preferisci START_POSITION se presente, altrimenti roster
    """
    start_tok = normalize_first_token(start_pos)
    roster_tok = normalize_first_token(roster_pos)

    if role_mode == "start":
        return to_bucket_from_tokens(start_tok)
    if role_mode == "roster":
        return to_bucket_from_tokens(roster_tok)

    # either
    primary = start_tok if start_tok not in ("", "UNK") else roster_tok
    return to_bucket_from_tokens(primary)

# -------------------- Games discovery --------------------

def _games_cache_name(team_abbr, season, season_types_key):
    return f"team_games_{team_abbr}_{season}_{season_types_key}.json"


def _now_iso():
    return datetime.utcnow().isoformat()


def get_team_game_ids(team_abbr, season, season_types, refresh=False, debug=False):
    """
    Ritorna la lista di GAME_ID per squadra/stagione, unendo:
      - TeamGameLog per ciascun season type richiesto
      - LeagueGameFinder come fallback/integrazione
    
    La cache viene aggiornata "in crescita" (merge/union). Usa --refresh-games per ignorarla.
    """
    season_types_key = "|".join(season_types)
    cache_name = _games_cache_name(team_abbr, season, season_types_key)

    cached = None if refresh else load_cache(cache_name)
    if cached and isinstance(cached, dict):
        if debug:
            print(f"[cache] loaded games {cache_name} with {len(cached.get('game_ids', []))} ids")
    else:
        cached = {"season": season, "team": team_abbr, "season_types": season_types, "game_ids": [], "updated_at": _now_iso()}

    # resolve team_id
    id_to_full, abbr_to_full, id_to_abbr, full_to_abbr = build_team_maps()
    team_abbr_up = team_abbr.upper()
    team_id = None
    if team_abbr_up in abbr_to_full:
        for tid, ab in id_to_abbr.items():
            if ab == team_abbr_up:
                team_id = tid
                break
    else:
        for abbr, full in abbr_to_full.items():
            if team_abbr.lower() in full.lower():
                team_abbr_up = abbr
                for tid, ab in id_to_abbr.items():
                    if ab == abbr:
                        team_id = tid
                        break
                break
    if team_id is None:
        raise ValueError(f"Team {team_abbr} non trovato")

    found_ids = set(cached.get("game_ids", []))

    # --- TeamGameLog per ciascun season type richiesto ---
    for stype in season_types:
        tries = 3
        for attempt in range(tries):
            try:
                tgl = teamgamelog.TeamGameLog(team_id=team_id, season=season, season_type_all_star=stype, timeout=60)
                df = tgl.get_data_frames()[0]
                if df is not None and not df.empty:
                    gcol = None
                    for c in df.columns:
                        if "GAME_ID" in c:
                            gcol = c
                            break
                    if not gcol:
                        raise RuntimeError("GAME_ID column missing in TeamGameLog")
                    for gid in df[gcol].astype(str).tolist():
                        found_ids.add(gid)
                    if debug:
                        print(f"[TGL] {stype}: +{len(df)} rows (total ids {len(found_ids)})")
                break
            except Exception as e:
                if debug:
                    print(f"[TGL] attempt {attempt+1} season_type={stype} error: {e}")
                time.sleep(1.2)

    # --- LeagueGameFinder integrazione ---
    try:
        lgf = leaguegamefinder.LeagueGameFinder(team_id_nullable=team_id, season_nullable=season, timeout=60)
        df_lgf = lgf.get_data_frames()[0]
        if df_lgf is not None and not df_lgf.empty:
            gcol = "GAME_ID" if "GAME_ID" in df_lgf.columns else next((c for c in df_lgf.columns if "GAME_ID" in c), None)
            if not gcol:
                raise RuntimeError("GAME_ID column missing in LeagueGameFinder")
            for gid in df_lgf[gcol].astype(str).unique().tolist():
                found_ids.add(gid)
            if debug:
                print(f"[LGF] merged ids → {len(found_ids)}")
    except Exception as e:
        if debug:
            print("[LGF] errore:", e)

    # ordina i game id (stringhe) per cronologia approssimativa
    game_ids_sorted = sorted(found_ids)

    # aggiorna cache
    cached["game_ids"] = game_ids_sorted
    cached["updated_at"] = _now_iso()
    save_cache(cache_name, cached)

    return game_ids_sorted

# -------------------- Utility --------------------

def parse_min_to_float(min_val):
    try:
        if pd.isna(min_val):
            return None
        s = str(min_val)
        if ":" in s:
            mm, ss = s.split(":")
            return int(mm) + int(ss)/60.0
        return float(s)
    except Exception:
        return None

# -------------------- Core computation --------------------

def compute_defense_by_position_boxscore_per_game(
    target_team_abbr,
    season,
    exclude_dnp=False,
    role_mode="either",
    season_types=("Regular Season",),
    refresh_games=False,
    debug=False,
    use_all_cache=True,
):
    target_team_abbr = (target_team_abbr or "").upper()
    if not target_team_abbr:
        raise ValueError("target_team_abbr must be provided")

    season_types_key = "|".join(season_types)

    if use_all_cache:
        all_cached = _load_all_cache(season, exclude_dnp, role_mode, season_types_key)
        if all_cached:
            teams_cached = all_cached.get("teams", {})
            if target_team_abbr in teams_cached:
                if debug:
                    print(f"[cache] loaded {target_team_abbr} from ALL cache")
                return teams_cached[target_team_abbr]

    cache_name = _team_cache_name(target_team_abbr, season, exclude_dnp, role_mode, season_types_key)
    cached = load_cache(cache_name)
    if cached and not debug and not refresh_games:
        return cached

    player_pos_map = build_player_position_map(season, debug=debug)

    totals = defaultdict(lambda: {"PTS_sum": 0.0, "REB_sum": 0.0, "AST_sum": 0.0, "games_with_bucket": 0})
    games_scanned = 0

    game_ids = get_team_game_ids(target_team_abbr, season, list(season_types), refresh=refresh_games, debug=debug)
    if debug:
        print(f"Found {len(game_ids)} games for {target_team_abbr} in {season} [{', '.join(season_types)}]")

    for gi in game_ids:
        # boxscore cache (per partita)
        box_cache_name = f"box_{gi}.json"
        box_cached = load_cache(box_cache_name) if not debug else None
        df_players = None
        if box_cached:
            try:
                df_players = pd.DataFrame(box_cached)
            except Exception:
                df_players = None

        if df_players is None:
            tries = 3
            for attempt in range(tries):
                try:
                    bs = boxscoretraditionalv2.BoxScoreTraditionalV2(game_id=gi, timeout=60)
                    df_players = bs.get_data_frames()[0]
                    break
                except Exception as e:
                    if debug:
                        print(f"[Boxscore] attempt {attempt+1} for game {gi} failed: {e}")
                    time.sleep(1)
            if df_players is None:
                if debug:
                    print("[Boxscore] Skipping game", gi)
                continue
            try:
                save_cache(box_cache_name, df_players.to_dict(orient="records"))
            except Exception:
                pass

        # colonne
        team_abbr_col = next((c for c in df_players.columns if c.upper() in ("TEAM_ABBREVIATION","TEAMABBREVIATION","TEAM_ACRONYM")), None)
        start_pos_col = next((c for c in df_players.columns if c.upper() == "START_POSITION"), None)

        per_game_bucket = defaultdict(lambda: {"PTS": 0.0, "REB": 0.0, "AST": 0.0})
        targ = target_team_abbr.upper()

        for _, prow in df_players.iterrows():
            row_team_abbr = (prow.get(team_abbr_col) or "").upper() if team_abbr_col else None
            if row_team_abbr == targ:
                continue  # consideriamo solo gli AVVERSARI

            # DNP policy
            min_raw = prow.get("MIN")
            min_float = parse_min_to_float(min_raw)
            if exclude_dnp and (min_float is None or min_float == 0):
                continue

            # pid
            pid = prow.get("PLAYER_ID")
            if pid is None:
                continue
            try:
                pid = int(pid)
            except Exception:
                continue

            # stats
            def _flt(x):
                try:
                    return float(x) if pd.notnull(x) else 0.0
                except Exception:
                    return 0.0
            pts = _flt(prow.get("PTS"))
            reb = _flt(prow.get("REB"))
            ast = _flt(prow.get("AST"))

            start_pos = (prow.get(start_pos_col) or "") if start_pos_col else ""
            roster_pos = player_pos_map.get(pid, "UNK")
            bucket = choose_bucket(pid, start_pos, roster_pos, role_mode=role_mode)

            per_game_bucket[bucket]["PTS"] += pts
            per_game_bucket[bucket]["REB"] += reb
            per_game_bucket[bucket]["AST"] += ast

        if len(per_game_bucket) == 0:
            # nessun avversario? (non dovrebbe succedere) → skip
            continue

        games_scanned += 1
        for bucket, vals in per_game_bucket.items():
            totals[bucket]["PTS_sum"] += vals["PTS"]
            totals[bucket]["REB_sum"] += vals["REB"]
            totals[bucket]["AST_sum"] += vals["AST"]
            totals[bucket]["games_with_bucket"] += 1

    # medie
    result = {}
    for bucket, vals in totals.items():
        games_with = vals["games_with_bucket"]
        if games_scanned > 0:
            pts_per_game = round(vals["PTS_sum"] / games_scanned, 3)
            reb_per_game = round(vals["REB_sum"] / games_scanned, 3)
            ast_per_game = round(vals["AST_sum"] / games_scanned, 3)
        else:
            pts_per_game = reb_per_game = ast_per_game = 0.0

        if games_with > 0:
            pts_when = round(vals["PTS_sum"] / games_with, 3)
            reb_when = round(vals["REB_sum"] / games_with, 3)
            ast_when = round(vals["AST_sum"] / games_with, 3)
        else:
            pts_when = reb_when = ast_when = 0.0

        result[bucket] = {
            "total_pts_sum": round(vals["PTS_sum"], 2),
            "total_reb_sum": round(vals["REB_sum"], 2),
            "total_ast_sum": round(vals["AST_sum"], 2),
            "games_with_bucket": int(games_with),
            "games_scanned": int(games_scanned),
            "pts_per_game": pts_per_game,
            "reb_per_game": reb_per_game,
            "ast_per_game": ast_per_game,
            "pts_per_game_when_present": pts_when,
            "reb_per_game_when_present": reb_when,
            "ast_per_game_when_present": ast_when,
        }

    out = {
        "target_team_abbr": target_team_abbr,
        "season": season,
        "season_types": list(season_types),
        "role_mode": role_mode,
        "by_position_per_game": result,
        "meta": {
            "games_scanned": int(games_scanned),
            "exclude_dnp": bool(exclude_dnp),
        },
    }

    save_cache(cache_name, out)
    _update_all_cache(season, exclude_dnp, role_mode, season_types_key, out, debug=debug)
    return out

# -------------------- All teams --------------------

def compute_all_teams_defense_by_position_boxscore_per_game(season, exclude_dnp=False, role_mode="either", season_types=("Regular Season",), refresh_games=False, debug=False):
    season_types_key = "|".join(season_types)
    cache_name = _all_cache_name(season, exclude_dnp, role_mode, season_types_key)
    cached = load_cache(cache_name)
    if cached and not refresh_games:
        if debug:
            print(f"[cache] loaded all teams defense {cache_name}")
        return cached

    _, abbr_to_full, _, _ = build_team_maps()
    all_results = {
        "season": season,
        "exclude_dnp": bool(exclude_dnp),
        "role_mode": role_mode,
        "season_types": list(season_types),
        "teams": {},
    }

    for team_abbr in sorted(abbr_to_full.keys()):
        try:
            res = compute_defense_by_position_boxscore_per_game(
                team_abbr,
                season,
                exclude_dnp=exclude_dnp,
                role_mode=role_mode,
                season_types=season_types,
                refresh_games=refresh_games,
                debug=debug,
                use_all_cache=False,
            )
            all_results["teams"][team_abbr.upper()] = res
        except Exception as exc:
            if debug:
                print(f"[all-teams] Failed {team_abbr}: {exc}")
            time.sleep(0.4)

    save_cache(cache_name, all_results)
    return all_results


def is_all_team_cache_ready(season, exclude_dnp=False, role_mode="either", season_types=("Regular Season",)):
    season_types_key = "|".join(season_types)
    cached = _load_all_cache(season, exclude_dnp, role_mode, season_types_key)
    if not cached or not isinstance(cached, dict):
        return False
    teams_map = cached.get("teams")
    if not isinstance(teams_map, dict):
        return False
    expected = len({t.get("abbreviation") for t in teams.get_teams() if t.get("abbreviation")})
    return len(teams_map) >= expected


def warm_all_team_caches(season, exclude_dnp=False, role_mode="either", season_types=("Regular Season",), refresh_games=False, debug=False):
    return compute_all_teams_defense_by_position_boxscore_per_game(
        season,
        exclude_dnp=exclude_dnp,
        role_mode=role_mode,
        season_types=season_types,
        refresh_games=refresh_games,
        debug=debug,
    )


def get_team_defense_from_cache(target_team_abbr, season, exclude_dnp=False, role_mode="either", season_types=("Regular Season",), refresh_games=False, debug=False):
    target_team_abbr = (target_team_abbr or "").upper()
    if not target_team_abbr:
        raise ValueError("target_team_abbr must be provided")

    season_types_key = "|".join(season_types)
    all_cache = _load_all_cache(season, exclude_dnp, role_mode, season_types_key)
    if all_cache and isinstance(all_cache.get("teams"), dict):
        team_data = all_cache["teams"].get(target_team_abbr)
        if team_data:
            return team_data

    return compute_defense_by_position_boxscore_per_game(
        target_team_abbr,
        season,
        exclude_dnp=exclude_dnp,
        role_mode=role_mode,
        season_types=season_types,
        refresh_games=refresh_games,
        debug=debug,
        use_all_cache=True,
    )

# -------------------- CLI --------------------

def parse_season_types(s: str):
    if not s:
        return ("Regular Season",)
    # consenti alias brevi
    parts = [p.strip() for p in s.split(",") if p.strip()]
    normalized = []
    for p in parts:
        up = p.lower()
        if up in ("rs", "regular", "regular season"):
            normalized.append("Regular Season")
        elif up in ("ps", "pre", "pre season", "preseason"):
            normalized.append("Pre Season")
        elif up in ("po", "playoff", "playoffs"):
            normalized.append("Playoffs")
        else:
            normalized.append(p)
    return tuple(dict.fromkeys(normalized))  # dedupe preserving order


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=str, default="2025-26")
    parser.add_argument("--team", type=str, help="Team abbr (LAL) o parte del nome")
    parser.add_argument("--all-teams", action="store_true", help="Calcola la difesa per tutte le squadre")
    parser.add_argument("--save", action="store_true")
    parser.add_argument("--exclude-dnp", action="store_true", help="Esclude righe con MIN null/0")
    parser.add_argument("--refresh-games", action="store_true", help="Ignora la cache dei game id e ricalcola")
    parser.add_argument("--role-mode", type=str, default="either", choices=["roster","start","either"], help="Sorgente per ruolo")
    parser.add_argument("--season-types", type=str, default="Regular Season", help="Lista separata da virgole fra: Regular Season,Pre Season,Playoffs")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    season = args.season
    role_mode = args.role_mode
    season_types = parse_season_types(args.season_types)

    if args.all_teams:
        res_all = compute_all_teams_defense_by_position_boxscore_per_game(
            season,
            exclude_dnp=args.exclude_dnp,
            role_mode=role_mode,
            season_types=season_types,
            refresh_games=args.refresh_games,
            debug=args.debug,
        )
        print(json.dumps(res_all, indent=2, ensure_ascii=False))
        return

    if not args.team:
        parser.error("--team è obbligatorio se non si usa --all-teams")

    team_input = args.team
    _, abbr_to_full, id_to_abbr, full_to_abbr = build_team_maps()
    team_abbr = None
    if team_input.upper() in abbr_to_full:
        team_abbr = team_input.upper()
    else:
        for abbr, full in abbr_to_full.items():
            if team_input.lower() in full.lower():
                team_abbr = abbr
                break
    if not team_abbr:
        print("Team non trovato:", team_input)
        return

    res = compute_defense_by_position_boxscore_per_game(
        team_abbr,
        season,
        exclude_dnp=args.exclude_dnp,
        role_mode=role_mode,
        season_types=season_types,
        refresh_games=args.refresh_games,
        debug=args.debug,
    )

    print(json.dumps(res, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
