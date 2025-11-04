#!/usr/bin/env python3
"""
team_defense_by_position_boxscore.py

Calcola quanto una squadra concede (PTS, REB, AST) per posizione avversaria
utilizzando i boxscore dei match della squadra (molto più efficiente).

Uso:
    python team_defense_by_position_boxscore.py --season 2024-25 --team "LAL" --save
    python team_defense_by_position_boxscore.py --season 2024-25 --team "Los Angeles Lakers" --save
    python team_defense_by_position_boxscore.py --season 2024-25 --team LAL --save --exclude-dnp

Opzioni principali:
  --season (default "2024-25")
  --team (abbreviazione o parte del nome)
  --save (salva output in ./cache/def_by_pos_<abbr>_<season>.json)
  --exclude-dnp (esclude righe con MIN null/0)
  --debug (stampa info aggiuntive)

Requisiti:
  pip install nba_api pandas python-dateutil
"""

import os
import time
import json
import argparse
from collections import defaultdict

import pandas as pd
from nba_api.stats.static import teams
from nba_api.stats.endpoints import commonteamroster, teamgamelog, boxscoretraditionalv2

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

# --- build player -> position map from rosters (cached) ---
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
                pid = int(r.get("PLAYER_ID"))
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

# --- get all game_ids for a team in season using TeamGameLog ---
def get_team_game_ids(team_abbr, season, debug=False):
    cache_name = f"team_games_{team_abbr}_{season}.json"
    cached = load_cache(cache_name)
    if cached:
        if debug:
            print(f"[cache] loaded team games {cache_name}")
        return cached

    # try to resolve team id from abbreviation
    _, abbr_to_full, id_to_abbr, full_to_abbr = build_team_maps()
    team_abbr_up = team_abbr.upper()
    team_id = None
    if team_abbr_up in abbr_to_full:
        # find id
        for tid, abbr in id_to_abbr.items():
            if abbr == team_abbr_up:
                team_id = tid
                break
    else:
        # try partial match on full name
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

    # fetch team game log
    tries = 3
    df = None
    for attempt in range(tries):
        try:
            tgl = teamgamelog.TeamGameLog(team_id=team_id, season=season)
            df = tgl.get_data_frames()[0]
            break
        except Exception as e:
            if debug:
                print("TeamGameLog attempt", attempt+1, "error:", e)
            time.sleep(1)
    if df is None or df.empty:
        raise RuntimeError("Impossibile ottenere team game log")

    # GAME_ID column name may vary; try find it
    game_id_col = None
    for c in df.columns:
        if "GAME_ID" in c:
            game_id_col = c
            break
    if game_id_col is None:
        raise RuntimeError("GAME_ID column not found in teamgamelog dataframe")

    game_ids = df[game_id_col].astype(str).tolist()
    save_cache(cache_name, game_ids)
    return game_ids

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

# --- compute defense by position using boxscore for each game ---
def compute_defense_by_position_boxscore(target_team_abbr, season, exclude_dnp=False, debug=False):
    cache_name = f"def_by_pos_box_{target_team_abbr}_{season}.json"
    cached = load_cache(cache_name)
    if cached and not debug:
        return cached

    player_pos_map = build_player_position_map(season, debug=debug)

    totals = defaultdict(lambda: {"PTS": 0.0, "REB": 0.0, "AST": 0.0, "games": 0})
    # games counted per position (a game may count multiple players of same pos)
    per_game_counts = defaultdict(int)

    game_ids = get_team_game_ids(target_team_abbr, season, debug=debug)
    if debug:
        print(f"Found {len(game_ids)} games for {target_team_abbr} in {season}")

    for gi in game_ids:
        if debug and int(len(game_ids)) > 50:
            # print occasional progress
            if int(game_ids.index(gi)) % 50 == 0:
                print(f"Processing game {game_ids.index(gi)+1}/{len(game_ids)}: {gi}")

        # cache boxscore per game
        box_cache_name = f"box_{gi}.json"
        box_cached = load_cache(box_cache_name) if not debug else None
        df_players = None
        if box_cached:
            # reconstruct dataframe
            try:
                df_players = pd.DataFrame(box_cached)
            except Exception:
                df_players = None

        if df_players is None:
            # fetch
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
            # cache minimal subset rows as dicts
            try:
                save_cache(box_cache_name, df_players.to_dict(orient="records"))
            except Exception:
                pass

        # determine who is opponent for each row: Boxscore has TEAM_ABBREVIATION or TEAM_ID columns
        # We'll check TEAM_ABBREVIATION or TEAM_ID to see if the row belongs to opponent team
        # Normalize target_team_abbr uppercase
        targ = target_team_abbr.upper()

        # We want to aggregate stats of players **opponent** to target team (i.e., players whose TEAM_ABBREVIATION != targ)
        # But boxscore returns both teams; to be safe, we check TEAM_ABBREVIATION or TEAM_ID mapping if needed
        # Prefer TEAM_ABBREVIATION column
        team_abbr_col = None
        for c in df_players.columns:
            if c.upper() in ("TEAM_ABBREVIATION","TEAMABBREVIATION","TEAM_ACRONYM"):
                team_abbr_col = c
                break

        team_id_col = None
        for c in df_players.columns:
            if c.upper() in ("TEAM_ID","TEAMID"):
                team_id_col = c
                break

        # iterate rows
        # We'll count the game once per (position bucket) per game, so we increment games count when first encountering that pos in that game.
        seen_pos_in_game = set()

        for _, prow in df_players.iterrows():
            row_team_abbr = None
            if team_abbr_col:
                row_team_abbr = (prow.get(team_abbr_col) or "").upper()
            elif team_id_col:
                row_team_abbr = None
                # map id to abbr via nba_api static teams if necessary
            # if row belongs to target team, skip (we want opponent players)
            if row_team_abbr == targ:
                continue

            # extract player id
            pid = prow.get("PLAYER_ID")
            if pid is None and "PLAYER" in prow.index:
                # fallback
                continue
            try:
                pid = int(pid)
            except Exception:
                continue

            # parse stats (handle NaN)
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

            # parse minutes and DNP handling
            min_raw = prow.get("MIN")
            min_float = parse_min_to_float(min_raw)
            if exclude_dnp:
                if (min_float is None) or (min_float == 0):
                    # skip players who didn't play
                    continue
            # get player position from map
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

            # accumulate totals
            totals[bucket]["PTS"] += pts
            totals[bucket]["REB"] += reb
            totals[bucket]["AST"] += ast

            # count that this bucket had one more player appearance in this game
            # We'll increment games count per player appearance; to compute per-game conceded
            # we want "per opponent-player-game", but if prefer "per matchup game" we can alter.
            totals[bucket]["games"] += 1
            seen_pos_in_game.add(bucket)

        # end of rows for game
        # optionally could increment a separate per-game bucket count (not used here, as games counts are per player appearance)

    # compute averages: pts_per_appearance and also normalize to per-game-per-position if desired
    result = {}
    for bucket, vals in totals.items():
        games = vals["games"]
        if games > 0:
            result[bucket] = {
                "total_pts": round(vals["PTS"], 2),
                "total_reb": round(vals["REB"], 2),
                "total_ast": round(vals["AST"], 2),
                "player_appearances": int(games),
                "pts_per_appearance": round(vals["PTS"] / games, 3),
                "reb_per_appearance": round(vals["REB"] / games, 3),
                "ast_per_appearance": round(vals["AST"] / games, 3)
            }
        else:
            result[bucket] = {
                "total_pts": 0.0,
                "total_reb": 0.0,
                "total_ast": 0.0,
                "player_appearances": 0,
                "pts_per_appearance": 0.0,
                "reb_per_appearance": 0.0,
                "ast_per_appearance": 0.0
            }

    out = {
        "target_team_abbr": target_team_abbr,
        "season": season,
        "by_position": result,
        "meta": {
            "games_scanned": len(game_ids),
            "exclude_dnp": bool(exclude_dnp)
        }
    }

    save_cache(cache_name, out)
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=str, default="2024-25")
    parser.add_argument("--team", type=str, required=True, help="Team abbr (LAL) or partial name")
    parser.add_argument("--save", action="store_true")
    parser.add_argument("--exclude-dnp", action="store_true", help="Esclude righe con MIN null/0")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    season = args.season
    team_input = args.team
    # resolve abbr
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

    res = compute_defense_by_position_boxscore(team_abbr, season, exclude_dnp=args.exclude_dnp, debug=args.debug)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    if args.save:
        save_cache(f"def_by_pos_box_{team_abbr}_{season}.json", res)

if __name__ == "__main__":
    main()
