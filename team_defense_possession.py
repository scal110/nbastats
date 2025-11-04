import time
import pandas as pd
from collections import defaultdict
from nba_api.stats.static import teams
from nba_api.stats.endpoints import commonteamroster, teamgamelog, boxscoretraditionalv2, boxscoreadvancedv2, leaguegamefinder
from utils import load_cache, save_cache
import math

def _team_maps():
    tl = teams.get_teams()
    id_to_full, abbr_to_full, id_to_abbr, full_to_abbr = {}, {}, {}, {}
    for t in tl:
        tid, full, abbr = t["id"], t["full_name"], t["abbreviation"]
        id_to_full[tid] = full
        abbr_to_full[abbr] = full
        id_to_abbr[tid] = abbr
        full_to_abbr[full.lower()] = abbr
    return id_to_full, abbr_to_full, id_to_abbr, full_to_abbr

def _pos_bucket(pos):
    s = (pos or "").upper().split("-")[0]
    if s in ("PG","SG","G"): return "G"
    if s in ("SF","PF","F"): return "F"
    if s == "C": return "C"
    return "OTHER"

def _player_pos_map(season):
    ck = f"player_pos_map_{season}.json"
    c = load_cache(ck)
    if c: return {int(k): v for k,v in c.items()}
    id_to_full, _, id_to_abbr, _ = _team_maps()
    m = {}
    for tid in id_to_full.keys():
        try:
            df = commonteamroster.CommonTeamRoster(tid, season=season).get_data_frames()[0]
            col = "POSITION" if "POSITION" in df.columns else ("POS" if "POS" in df.columns else None)
            if col is None:
                continue
            for _, r in df.iterrows():
                m[int(r["PLAYER_ID"])] = (r[col] or "").strip() or "UNK"
        except Exception:
            time.sleep(0.2)
    save_cache(ck, {str(k):v for k,v in m.items()})
    return m

def _team_game_ids(team_abbr, season):
    ck = f"team_games_{team_abbr}_{season}.json"
    c = load_cache(ck)
    if c: return c
    id_to_full, abbr_to_full, id_to_abbr, full_to_abbr = _team_maps()
    team_abbr = team_abbr.upper()
    team_id = None
    for tid, ab in id_to_abbr.items():
        if ab == team_abbr:
            team_id = tid; break
    if team_id is None: raise ValueError("Team non trovato: "+team_abbr)
    # primo tentativo: TeamGameLog
    for stype in ["Regular Season","Pre Season","Playoffs"]:
        for attempt in range(3):
            try:
                tgl = teamgamelog.TeamGameLog(team_id=team_id, season=season, season_type_all_star=stype, timeout=60)
                df = tgl.get_data_frames()[0]
                if df is not None and not df.empty:
                    gidcol = [c for c in df.columns if "GAME_ID" in c][0]
                    gids = df[gidcol].astype(str).tolist()
                    save_cache(ck, gids)
                    return gids
            except Exception:
                time.sleep(1)
    # fallback: LeagueGameFinder
    lgf = leaguegamefinder.LeagueGameFinder(team_id_nullable=team_id, season_nullable=season, timeout=60)
    dfg = lgf.get_data_frames()[0]
    gids = dfg["GAME_ID"].astype(str).unique().tolist()
    save_cache(ck, gids)
    return gids

def _find_teamstats_df_from_advanced(adv_endpoint):
    """
    Ritorna il DataFrame TeamStats dall'endpoint Advanced, indipendentemente dall'ordine.
    """
    dfs = adv_endpoint.get_data_frames()
    # Preferisci quello che contiene TEAM_ABBREVIATION e POSS
    for df in dfs:
        cols = {c.upper() for c in df.columns}
        if "TEAM_ABBREVIATION" in cols and ("POSS" in cols or "PACE" in cols):
            return df
    # fallback: se non trovi nulla, prova il secondo/terzo se esistono
    return dfs[1] if len(dfs) > 1 else (dfs[0] if dfs else None)

def team_defense_pos(session_team_abbr, season, exclude_dnp=True):
    """
    Calcola concessioni per ruolo:
      - per partita (media su partite scansionate)
      - per 100 possessi (sommando PTS/REB/AST avversari e dividendo per poss avversari * 100)
    """
    ck = f"def_teampos_{session_team_abbr}_{season}.json"
    cached = load_cache(ck)
    if cached:
        return cached

    session_team_abbr = session_team_abbr.upper()
    gids = _team_game_ids(session_team_abbr, season)

    totals_per_game = defaultdict(lambda: {"PTS": 0.0, "REB": 0.0, "AST": 0.0})
    totals_per_poss = defaultdict(lambda: {"PTS": 0.0, "REB": 0.0, "AST": 0.0, "POSS": 0.0})
    games_scanned = 0

    for gi in gids:
        # --- Traditional (player rows avversari) ---
        dfp = None
        for _ in range(3):
            try:
                bs = boxscoretraditionalv2.BoxScoreTraditionalV2(game_id=gi, timeout=60)
                dfs = bs.get_data_frames()
                dfp = dfs[0] if dfs else None
                break
            except Exception:
                time.sleep(0.5)
        if dfp is None or dfp.empty:
            # non riesco a leggere il boxscore, salto la partita
            continue

        # --- Advanced (team poss) ---
        dft = None
        for _ in range(3):
            try:
                adv = boxscoreadvancedv2.BoxScoreAdvancedV2(game_id=gi, timeout=60)
                dft = _find_teamstats_df_from_advanced(adv)
                break
            except Exception:
                time.sleep(0.5)
        if dft is None or dft.empty:
            # se non abbiamo team poss, non possiamo calcolare per100 → saltiamo per100 ma possiamo fare per-game
            pass

        # individua colonna team_abbr nel traditional
        abbr_col = None
        for c in dfp.columns:
            cu = c.upper()
            if cu in ("TEAM_ABBREVIATION", "TEAMABBREVIATION", "TEAM_ACRONYM"):
                abbr_col = c
                break
        if not abbr_col:
            # se proprio manca, non possiamo distinguere home/away → salta
            continue

        # righe avversario
        # (nel traditional, ogni riga è un giocatore; filtriamo chi NON appartiene a session_team_abbr)
        dfp["__TEAM_ABBR_UP__"] = dfp[abbr_col].astype(str).str.upper()
        opp_players = dfp[dfp["__TEAM_ABBR_UP__"] != session_team_abbr]
        if opp_players.empty:
            # partita forse non valida / preseason? salta
            continue

        # calcolo per-game (somma bucket dei giocatori avversari)
        per_game_bucket = defaultdict(lambda: {"PTS": 0.0, "REB": 0.0, "AST": 0.0})
        # calcolo per possesso (stesso accumulo, divideremo dopo)
        per_poss_bucket = defaultdict(lambda: {"PTS": 0.0, "REB": 0.0, "AST": 0.0})

        # mappa posizione giocatori
        # per performance, puoi portarla fuori dal loop e cache’arla per stagione se vuoi.
        try:
            # opzionale: se hai già una pos_map generale, usala qui
            pass
        except Exception:
            pass

        # estrai POSS avversario se disponibile
        opp_poss_val = None
        if dft is not None and not dft.empty:
            # cerca riga dell’avversario: nel TeamStats ci sono due righe, una per ciascun team
            dft["__TEAM_ABBR_UP__"] = dft["TEAM_ABBREVIATION"].astype(str).str.upper()
            # la riga del nostro team:
            my_row = dft[dft["__TEAM_ABBR_UP__"] == session_team_abbr]
            opp_row = dft[dft["__TEAM_ABBR_UP__"] != session_team_abbr]
            if not opp_row.empty:
                # se c'è POSS usalo, altrimenti prova PACE (fallback rozzo)
                if "POSS" in opp_row.columns:
                    try:
                        opp_poss_val = float(opp_row.iloc[0]["POSS"] or 0.0)
                    except Exception:
                        opp_poss_val = None
                # fallback: nessun POSS – usa 0 per indicare “non calcolabile”
                if opp_poss_val is None:
                    opp_poss_val = 0.0

        # accumula sui bucket ruolo
        for _, r in opp_players.iterrows():
            # escludi DNP (0 minuti)
            min_raw = r.get("MIN")
            played = False
            if min_raw is not None:
                s = str(min_raw)
                if ":" in s:
                    try:
                        mm, ss = s.split(":")
                        played = (int(mm) + int(ss) / 60.0) > 0
                    except Exception:
                        played = False
                else:
                    try:
                        played = float(s) > 0
                    except Exception:
                        played = False
            if exclude_dnp and not played:
                continue

            pos_raw = str(r.get("START_POSITION") or r.get("POSITION") or r.get("POS") or "").strip().upper()
            # se non c’è, prova a ricavarlo da Roster/pos_map esterno (non obbligatorio qui)
            bucket = "OTHER"
            base = pos_raw.split("-")[0]
            if base in ("PG", "SG", "G"):
                bucket = "G"
            elif base in ("SF", "PF", "F"):
                bucket = "F"
            elif base == "C":
                bucket = "C"

            pts = float(r.get("PTS") or 0)
            reb = float(r.get("REB") or 0)
            ast = float(r.get("AST") or 0)

            per_game_bucket[bucket]["PTS"] += pts
            per_game_bucket[bucket]["REB"] += reb
            per_game_bucket[bucket]["AST"] += ast

            per_poss_bucket[bucket]["PTS"] += pts
            per_poss_bucket[bucket]["REB"] += reb
            per_poss_bucket[bucket]["AST"] += ast

        # commit accumuli di questa partita
        games_scanned += 1
        for b, vals in per_game_bucket.items():
            totals_per_game[b]["PTS"] += vals["PTS"]
            totals_per_game[b]["REB"] += vals["REB"]
            totals_per_game[b]["AST"] += vals["AST"]

        # per100: accumula anche i possessi avversari (se noti)
        if opp_poss_val is None:
            opp_poss_val = 0.0
        for b, vals in per_poss_bucket.items():
            totals_per_poss[b]["PTS"] += vals["PTS"]
            totals_per_poss[b]["REB"] += vals["REB"]
            totals_per_poss[b]["AST"] += vals["AST"]
            totals_per_poss[b]["POSS"] += max(float(opp_poss_val), 0.0001)  # evita 0

    # output aggregato
    out_game = {}
    out_poss = {}
    for b in ["G", "F", "C", "OTHER"]:
        # per game
        if games_scanned > 0:
            out_game[b] = {
                "pts_per_game": round(totals_per_game[b]["PTS"] / games_scanned, 3),
                "reb_per_game": round(totals_per_game[b]["REB"] / games_scanned, 3),
                "ast_per_game": round(totals_per_game[b]["AST"] / games_scanned, 3),
                "games_scanned": games_scanned,
            }
        else:
            out_game[b] = {"pts_per_game": 0.0, "reb_per_game": 0.0, "ast_per_game": 0.0, "games_scanned": 0}

        # per 100 possessi
        poss = totals_per_poss[b]["POSS"]
        if poss > 0:
            out_poss[b] = {
                "pts_per100": round((totals_per_poss[b]["PTS"] / poss) * 100.0, 3),
                "reb_per100": round((totals_per_poss[b]["REB"] / poss) * 100.0, 3),
                "ast_per100": round((totals_per_poss[b]["AST"] / poss) * 100.0, 3),
                "poss_agg": round(poss, 1),
            }
        else:
            out_poss[b] = {"pts_per100": 0.0, "reb_per100": 0.0, "ast_per100": 0.0, "poss_agg": 0.0}

    result = {
        "team": session_team_abbr,
        "season": season,
        "by_position_per_game": out_game,
        "by_position_per100": out_poss,
    }
    save_cache(ck, result)
    return result


def league_baseline_z(season):
    """
    Calcola media e stdev LEGA per ruolo (per100), poi z-score per ogni team on-demand.
    """
    ck = f"league_baseline_{season}.json"
    c = load_cache(ck)
    if c: return c

    _, abbr_to_full, _, _ = _team_maps()
    agg = defaultdict(lambda: {"PTS": [], "REB": [], "AST": []})
    # per ciascun team → ottieni per100 e accumula nei bucket
    for abbr in abbr_to_full.keys():
        data = team_defense_pos(abbr, season)
        per100 = data["by_position_per100"]
        for b in ["G","F","C","OTHER"]:
            if b in per100:
                agg[b]["PTS"].append(per100[b]["pts_per100"])
                agg[b]["REB"].append(per100[b]["reb_per100"])
                agg[b]["AST"].append(per100[b]["ast_per100"])

    # calcola media/stdev
    import statistics as stats
    baseline = {}
    for b in ["G","F","C","OTHER"]:
        if len(agg[b]["PTS"]) == 0:
            baseline[b] = {
                "mean_pts":0,"std_pts":1,
                "mean_reb":0,"std_reb":1,
                "mean_ast":0,"std_ast":1
            }
        else:
            def _m(v): return float(stats.mean(v)) if len(v)>0 else 0.0
            def _s(v): 
                try: return float(stats.pstdev(v)) if len(v)>1 else 1.0
                except: return 1.0
            baseline[b] = {
                "mean_pts": _m(agg[b]["PTS"]),
                "std_pts":  _s(agg[b]["PTS"]),
                "mean_reb": _m(agg[b]["REB"]),
                "std_reb":  _s(agg[b]["REB"]),
                "mean_ast": _m(agg[b]["AST"]),
                "std_ast":  _s(agg[b]["AST"]),
            }

    save_cache(ck, baseline)
    return baseline

# se non l'hai già nel file, includi questa versione cache-ata:
def league_baseline_z_cached(season, force=False):
    """
    Calcola (o carica da cache) la baseline di lega per z-score per ruolo.
    Deve restituire un dict:
    {
      "season": "...",
      "by_position": {
        "G": {"mean": {"PTS":..., "REB":..., "AST":...}, "std": {...}, "n": int},
        "F": {...}, "C": {...}, "OTHER": {...}
      }
    }
    }
    """
    # Se l'hai già implementata, tieni la tua.
    # Altrimenti usa la variante che ti ho passato prima (con save_cache / load_cache)
    # ...
    raise NotImplementedError("Assicurati di avere league_baseline_z_cached definita come da patch precedente.")

def attach_z_scores(base_dict, season, allow_partial=False):
    """
    Ritorna base_dict arricchito con by_position_per100_z.
    Se la baseline non è disponibile e allow_partial=True, usa z=0 (invece di crashare).
    """
    # prova a caricare la baseline (cache → nessuna chiamata extra se già calcolata)
    try:
        baseline = league_baseline_z_cached(season)
    except Exception:
        if not allow_partial:
            raise
        baseline = None  # fallback: z=0

    result = dict(base_dict)
    bypos = base_dict.get("by_position_per100", {}) or {}
    outz = {}

    for bucket, row in bypos.items():
        pts = float(row.get("pts_per100") or 0.0)
        reb = float(row.get("reb_per100") or 0.0)
        ast = float(row.get("ast_per100") or 0.0)

        if baseline and baseline.get("by_position", {}).get(bucket):
            mu = baseline["by_position"][bucket]["mean"]
            sd = baseline["by_position"][bucket]["std"]
            z_pts = (pts - mu["PTS"]) / (sd["PTS"] or 1e-6)
            z_reb = (reb - mu["REB"]) / (sd["REB"] or 1e-6)
            z_ast = (ast - mu["AST"]) / (sd["AST"] or 1e-6)
        else:
            z_pts = z_reb = z_ast = 0.0

        outz[bucket] = {
            "pts_per100": row.get("pts_per100", 0.0),
            "reb_per100": row.get("reb_per100", 0.0),
            "ast_per100": row.get("ast_per100", 0.0),
            "poss_agg": row.get("poss_agg", 0.0),
            "pts_z": round(z_pts, 3),
            "reb_z": round(z_reb, 3),
            "ast_z": round(z_ast, 3),
        }

    result["by_position_per100_z"] = outz
    return result
