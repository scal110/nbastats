#!/usr/bin/env python3
"""
team_defense_by_position_boxscore_pergame.py

Versione aggiornata: media PER PARTITA (non per apparizione).

Uso:
    python team_defense_by_position_boxscore_pergame.py --season 2024-25 --team LAL --save
Opzioni:
    --exclude-dnp: esclude giocatori con MIN null/0 (non considerati nel sommarizzo per partita)
    --debug: stampa info aggiuntive
"""

import os
import time
import json
import argparse
from collections import defaultdict

import pandas as pd
from nba_api.stats.static import teams
from nba_api.stats.endpoints import commonteamroster, teamgamelog, boxscoretraditionalv2
from nba_api.stats.endpoints import leaguegamefinder

CACHE_DIR = "./cache"
os.makedirs(CACHE_DIR, exist_ok=True)

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

# --- build team maps ---
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

# --- build player -> position map from rosters (cached) ---...
def build_player_position_map(season, debug=False):
    cache_name = f"player_pos_map_{season}.json"
    cached = load_cache(cache_name)
    if cached:
        if debug:
            print(f"[cache] loaded player_pos_map {cache_name}")
        return {int(k): v for k, v in cached.items()}

    if debug:
        print("Costruisco player->position map... (scarico roster per squadra)")

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
                print(f"Warning roster team_id={team_id}: {e}")
            time.sleep(0.5)

    save_cache(cache_name, {str(k): v for k, v in player_pos.items()})
    return player_pos


def get_team_game_ids(team_abbr, season, debug=False):
    """
    Ritorna una lista di GAME_ID per la squadra e stagione richieste.
    Strategia:
      1) TeamGameLog con retry, timeout alto e vari season_type_all_star
      2) Fallback: LeagueGameFinder (team_id + season) -> GAME_ID
    """
    cache_name = f"team_games_{team_abbr}_{season}.json"
    cached = load_cache(cache_name)
    if cached:
        if debug:
            print(f"[cache] loaded team games {cache_name}")
        return cached

    id_to_full, abbr_to_full, id_to_abbr, full_to_abbr = build_team_maps()

    # resolve team_id
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

    if debug:
        print(f"Resolved {team_abbr_up} -> team_id {team_id}")

    # --- 1) Tentativo con TeamGameLog (diversi season_type) ---
    season_types = ["Regular Season", "Pre Season", "Playoffs"]
    for stype in season_types:
        tries = 3
        df = None
        for attempt in range(tries):
            try:
                tgl = teamgamelog.TeamGameLog(
                    team_id=team_id,
                    season=season,
                    season_type_all_star=stype,
                    timeout=60  # timeout più alto
                )
                df = tgl.get_data_frames()[0]
                if df is not None and not df.empty:
                    if debug:
                        print(f"[TeamGameLog] OK season_type={stype}, rows={len(df)}")
                    # trova colonna GAME_ID
                    game_id_col = None
                    for c in df.columns:
                        if "GAME_ID" in c:
                            game_id_col = c
                            break
                    if not game_id_col:
                        raise RuntimeError("GAME_ID column missing in TeamGameLog")
                    game_ids = df[game_id_col].astype(str).tolist()
                    save_cache(cache_name, game_ids)
                    return game_ids
                else:
                    if debug:
                        print(f"[TeamGameLog] Vuoto season_type={stype} (tentativo {attempt+1})")
            except Exception as e:
                if debug:
                    print(f"[TeamGameLog] attempt {attempt+1} season_type={stype} error: {e}")
                time.sleep(1.5)

    # --- 2) Fallback con LeagueGameFinder ---
    if debug:
        print("[Fallback] Provo LeagueGameFinder...")
    try:
        lgf = leaguegamefinder.LeagueGameFinder(
            team_id_nullable=team_id,
            season_nullable=season,
            timeout=60
        )
        df_lgf = lgf.get_data_frames()[0]
        if df_lgf is not None and not df_lgf.empty:
            # In LGF la colonna GAME_ID è tipicamente 'GAME_ID'
            if "GAME_ID" not in df_lgf.columns:
                # trova un nome compatibile
                gcol = None
                for c in df_lgf.columns:
                    if "GAME_ID" in c:
                        gcol = c
                        break
                if not gcol:
                    raise RuntimeError("GAME_ID column missing in LeagueGameFinder")
            else:
                gcol = "GAME_ID"
            # LGF spesso ritorna anche preseason/playoff: tienili tutti oppure filtra se vuoi
            game_ids = df_lgf[gcol].astype(str).unique().tolist()
            if debug:
                print(f"[LeagueGameFinder] OK rows={len(df_lgf)} games={len(game_ids)}")
            save_cache(cache_name, game_ids)
            return game_ids
        else:
            if debug:
                print("[LeagueGameFinder] Nessun risultato")
    except Exception as e:
        if debug:
            print("[LeagueGameFinder] errore:", e)

    # Se siamo qui, niente ha funzionato
    raise RuntimeError("Impossibile ottenere team game log (TeamGameLog e LeagueGameFinder falliti)")


# --- parse minutes field (supporta "MM:SS" or float/int) ---
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

# --- compute defense by position using boxscore for each game (PER-PARTITA) ---
def compute_defense_by_position_boxscore_per_game(target_team_abbr, season, exclude_dnp=False, debug=False):
    cache_name = f"def_by_pos_box_pergame_{target_team_abbr}_{season}.json"
    cached = load_cache(cache_name)
    if cached and not debug:
        return cached

    player_pos_map = build_player_position_map(season, debug=debug)

    # totals across games (sum of per-game sums)
    totals = defaultdict(lambda: {"PTS_sum": 0.0, "REB_sum": 0.0, "AST_sum": 0.0, "games_with_bucket": 0})
    games_scanned = 0
    game_ids = get_team_game_ids(target_team_abbr, season, debug=debug)
    if debug:
        print(f"Found {len(game_ids)} games for {target_team_abbr} in {season}")

    for gi in game_ids:
        # fetch boxscore (cached)
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
                    bs = boxscoretraditionalv2.BoxScoreTraditionalV2(game_id=gi)
                    df_players = bs.get_data_frames()[0]
                    break
                except Exception as e:
                    if debug:
                        print(f"Boxscore attempt {attempt+1} for game {gi} failed: {e}")
                    time.sleep(1)
            if df_players is None:
                if debug:
                    print("Skipping game", gi)
                continue
            try:
                save_cache(box_cache_name, df_players.to_dict(orient="records"))
            except Exception:
                pass

        # determine team abbrev column name
        team_abbr_col = None
        for c in df_players.columns:
            if c.upper() in ("TEAM_ABBREVIATION","TEAMABBREVIATION","TEAM_ACRONYM"):
                team_abbr_col = c
                break

        # per-game sums by bucket
        per_game_bucket = defaultdict(lambda: {"PTS": 0.0, "REB": 0.0, "AST": 0.0})

        targ = target_team_abbr.upper()

        # iterate rows and sum opponent players' stats grouped by bucket for this game
        for _, prow in df_players.iterrows():
            row_team_abbr = None
            if team_abbr_col:
                row_team_abbr = (prow.get(team_abbr_col) or "").upper()

            # skip players of the target team (noi vogliamo i giocatori avversari)
            if row_team_abbr == targ:
                continue

            # parse minutes and DNP policy
            min_raw = prow.get("MIN")
            min_float = parse_min_to_float(min_raw)
            if exclude_dnp:
                if (min_float is None) or (min_float == 0):
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
            try:
                pts = float(prow.get("PTS")) if pd.notnull(prow.get("PTS")) else 0.0
            except Exception:
                pts = 0.0
            try:
                reb = float(prow.get("REB")) if pd.notnull(prow.get("REB")) else 0.0
            except Exception:
                reb = 0.0
            try:
                ast = float(prow.get("AST")) if pd.notnull(prow.get("AST")) else 0.0
            except Exception:
                ast = 0.0

            pos = player_pos_map.get(pid, "UNK")
            pos_simple = pos.split("-")[0].upper() if pos else "UNK"
            if pos_simple in ("PG","SG","G"):
                bucket = "G"
            elif pos_simple in ("SF","PF","F"):
                bucket = "F"
            elif pos_simple == "C":
                bucket = "C"
            else:
                bucket = "OTHER"

            per_game_bucket[bucket]["PTS"] += pts
            per_game_bucket[bucket]["REB"] += reb
            per_game_bucket[bucket]["AST"] += ast

        # after iterating rows for this game
        # increment global totals: sum per bucket across games
        if len(per_game_bucket) == 0:
            # no opponent rows? skip
            continue

        games_scanned += 1
        for bucket, vals in per_game_bucket.items():
            totals[bucket]["PTS_sum"] += vals["PTS"]
            totals[bucket]["REB_sum"] += vals["REB"]
            totals[bucket]["AST_sum"] += vals["AST"]
            totals[bucket]["games_with_bucket"] += 1

    # compute averages per game (divide by games_scanned) and per-game when present (divide by games_with_bucket)
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
            "pts_per_game": pts_per_game,               # media su tutte le partite
            "reb_per_game": reb_per_game,
            "ast_per_game": ast_per_game,
            "pts_per_game_when_present": pts_when,      # media solo sulle partite dove il bucket era presente
            "reb_per_game_when_present": reb_when,
            "ast_per_game_when_present": ast_when
        }

    out = {
        "target_team_abbr": target_team_abbr,
        "season": season,
        "by_position_per_game": result,
        "meta": {
            "games_scanned": int(games_scanned),
            "exclude_dnp": bool(exclude_dnp)
        }
    }

    save_cache(cache_name, out)
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=str, default="2025-26")
    parser.add_argument("--team", type=str, required=True, help="Team abbr (LAL) o parte del nome")
    parser.add_argument("--save", action="store_true")
    parser.add_argument("--exclude-dnp", action="store_true", help="Esclude righe con MIN null/0")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    season = args.season
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

    res = compute_defense_by_position_boxscore_per_game(team_abbr, season, exclude_dnp=args.exclude_dnp, debug=args.debug)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    if args.save:
        save_cache(f"def_by_pos_box_pergame_{team_abbr}_{season}.json", res)

if __name__ == "__main__":
    main()
