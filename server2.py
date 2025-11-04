from flask import Flask, jsonify, request
from flask_cors import CORS
from player_match_stats import get_match_players_stats
from team_defense_possession import team_defense_pos, attach_z_scores
from nba_api.stats.endpoints import scoreboardv2
from nba_api.stats.static import teams
from datetime import datetime
import pytz
import time
from dateutil import parser


app = Flask(__name__)
CORS(app)

teams_dict = {t['id']: t['full_name'] for t in teams.get_teams()}

# --- Usare la data "odierna" in US/Eastern (NBA uses Eastern time) ---
def today_nba_format():
    est = pytz.timezone("US/Eastern")
    now_est = datetime.now(est)
    # ScoreboardV2 expects MM/DD/YYYY
    return now_est.strftime("%m/%d/%Y")

@app.route("/matches", methods=["GET"])
def get_matches_today():
    game_date = today_nba_format()
    attempts = 3
    est = pytz.timezone("US/Eastern")
    rome = pytz.timezone("Europe/Rome")

    for attempt in range(attempts):
        try:
            sb = scoreboardv2.ScoreboardV2(game_date=game_date)
            df = sb.get_data_frames()[0]  # dataframe dei match
            matches = []

            for _, row in df.iterrows():
                # ID squadre
                home_id = row.get("HOME_TEAM_ID")
                away_id = row.get("VISITOR_TEAM_ID")

                # nome completo squadre (fallback abbreviazione)
                home_team_name = teams_dict.get(home_id, row.get("HOME_TEAM_ABBREVIATION", "Unknown"))
                away_team_name = teams_dict.get(away_id, row.get("VISITOR_TEAM_ABBREVIATION", "Unknown"))

                # --- parse data/orario match ---
                # preferiamo GAME_DATE_EST (spesso è stringa ISO), altrimenti GAME_DATE
                raw_dt = row.get("GAME_DATE_EST") or row.get("GAME_DATE") or row.get("GAME_DATE_TIME")
                start_time_est = None
                start_time_rome = None
                start_date_est = None
                start_date_rome = None
                iso_est = None

                if raw_dt:
                    try:
                        # parse string to datetime
                        parsed = parser.parse(str(raw_dt))

                        # se parsed è naive (nessun tzinfo), assumiamo sia EST (NBA)
                        if parsed.tzinfo is None:
                            parsed_est = est.localize(parsed)
                        else:
                            # se ha tzinfo ma non EST, convertiamo a EST per coerenza
                            parsed_est = parsed.astimezone(est)

                        # ora abbiamo il datetime in EST (aware)
                        iso_est = parsed_est.isoformat()
                        start_time_est = parsed_est.strftime("%H:%M")
                        start_date_est = parsed_est.strftime("%Y-%m-%d")

                        # converti in Europe/Rome
                        parsed_rome = parsed_est.astimezone(rome)
                        start_time_rome = parsed_rome.strftime("%H:%M")
                        start_date_rome = parsed_rome.strftime("%Y-%m-%d")

                    except Exception as ex:
                        # parsing fallito: lascia None ma continua
                        print(f"Warning: parsing date failed for row GAME_ID={row.get('GAME_ID')}: {ex}")
                        start_time_est = None
                        start_time_rome = None
                        start_date_est = None
                        start_date_rome = None

                matches.append({
                    "gameId": row.get("GAME_ID"),
                    "home_team": home_team_name,
                    "away_team": away_team_name,
                    "home_abbr": row.get("HOME_TEAM_ABBREVIATION"),
                    "away_abbr": row.get("VISITOR_TEAM_ABBREVIATION"),
                    # dettagli temporali (EST + Europe/Rome)
                    "start_time_est": start_time_est,        # "HH:MM" in EST
                    "start_date_est": start_date_est,        # "YYYY-MM-DD" in EST
                    "start_time_rome": start_time_rome,      # "HH:MM" in Europe/Rome
                    "start_date_rome": start_date_rome,      # "YYYY-MM-DD" in Europe/Rome
                    "start_iso_est": iso_est                 # ISO string in EST (se disponibile)
                })

            return jsonify(matches)

        except Exception as e:
            print(f"Errore Scoreboard attempt {attempt+1}: {e}")
            time.sleep(2)

    return jsonify({"error": "Impossibile recuperare match oggi"}), 500

# GET /stats?home=...&away=...&season=...
@app.route("/stats", methods=["GET"])
def stats():
    home = request.args.get("home")
    away = request.args.get("away")
    season = request.args.get("season", "2025-26")
    if not home or not away:
        return jsonify({"error":"missing home or away"}), 400
    data = get_match_players_stats(home, away, season)
    return jsonify(data)

# GET /team-defense-pos?team=LAL&season=2025-26
@app.route("/team-defense-pos", methods=["GET"])
def team_defense_pos_endpoint():
    team = request.args.get("team")
    season = request.args.get("season", "2025-26")
    if not team:
        return jsonify({"error":"missing team"}), 400
    base = team_defense_pos(team, season)
    with_z = attach_z_scores(base, season)
    return jsonify(with_z)

# --- NEW: utility per abbreviazioni e bucket ruolo ---
TEAM_NAME_TO_ABBR = {t['full_name']: t['abbreviation'] for t in teams.get_teams()}
def to_bucket(pos: str) -> str:
    s = (pos or "").upper().split("-")[0]
    if s in ("PG","SG","G"): return "G"
    if s in ("SF","PF","F"): return "F"
    if s == "C": return "C"
    return "OTHER"

# --- NEW: media stagionale per giocatore ---
from nba_api.stats.endpoints import playergamelog

def get_player_season_avg(player_id: int, season: str):
    """
    Ritorna media stagionale (PTS/REB/AST/MIN) calcolata su tutti i game log della stagione.
    """
    try:
        gl = playergamelog.PlayerGameLog(player_id=player_id, season=season, timeout=60)
        df = gl.get_data_frames()[0]
        if df is None or df.empty:
            return {"PTS": 0.0, "REB": 0.0, "AST": 0.0, "MIN": 0.0}
        # ATTENZIONE: il game log di solito arriva dal più recente al più vecchio.
        # La media non dipende dall’ordine.
        return {
            "PTS": float(df["PTS"].mean()),
            "REB": float(df["REB"].mean()),
            "AST": float(df["AST"].mean()),
            "MIN": float(df["MIN"].mean()),
        }
    except Exception:
        return {"PTS": 0.0, "REB": 0.0, "AST": 0.0, "MIN": 0.0}

def _safe_div(a, b, eps=1e-6):
    return a / (b if abs(b) > eps else eps)

def _clamp(x, lo, hi):
    return max(lo, min(hi, x))

# --- NEW: rotta avanzata che arricchisce i player con season_avg e advantage ---
@app.route("/stats-adv", methods=["GET"])
def stats_adv():
    """
    GET /stats-adv?home=...&away=...&season=2025-26
    Ritorna lo stesso array di /stats ma ogni giocatore ha:
      - stats[STAT].season_avg
      - stats[STAT].adv_score  (z difesa + delta_form)
      - opp_team_abbr, role_bucket
    """
    home = request.args.get("home")
    away = request.args.get("away")
    season = request.args.get("season", "2025-26")
    if not home or not away:
        return jsonify({"error": "missing home or away"}), 400

    # 1) Prendiamo la base giocatori (tuo endpoint interno)
    players = get_match_players_stats(home, away, season)  # lista di dict con: player, position, side, team, stats{PTS/REB/AST/MIN:{last5_avg,value,under_avg}}

    # 2) Abbreviazioni team e difese per ruolo (con z) — cache per ridurre chiamate
    home_abbr = TEAM_NAME_TO_ABBR.get(home, None)
    away_abbr = TEAM_NAME_TO_ABBR.get(away, None)
    # difesa dell’avversario dei giocatori di casa = away
    def_home_opp = attach_z_scores(team_defense_pos(away_abbr, season), season, allow_partial=True) if away_abbr else None
    # difesa dell’avversario dei giocatori in trasferta = home
    def_away_opp = attach_z_scores(team_defense_pos(home_abbr, season), season, allow_partial=True) if home_abbr else None

    out = []
    for p in players:
        pid = p.get("player_id") or p.get("PLAYER_ID")  # se nel tuo get_match_players_stats non c’è, aggiungilo (consigliato)
        pos = p.get("position") or p.get("POSITION") or ""
        bucket = to_bucket(pos)
        side = p.get("side")
        # scegli i dati difensivi dell’AVVERSARIO
        opp_def = def_home_opp if side == "home" else def_away_opp
        zrow = (opp_def or {}).get("by_position_per100_z", {}).get(bucket, {})  # pts_z, reb_z, ast_z
        z_pts = float(zrow.get("pts_z", 0.0))
        z_reb = float(zrow.get("reb_z", 0.0))
        z_ast = float(zrow.get("ast_z", 0.0))

        # medie stagionali
        season_avg = get_player_season_avg(pid, season) if pid else {"PTS":0.0,"REB":0.0,"AST":0.0,"MIN":0.0}

        # delta_form = quanto il giocatore è SOTTO la sua media stagionale (positivo = sotto)
        # formula: (season - last5) / season  〰 clamp[-1,+1]
        last5_pts = float(p["stats"].get("PTS",{}).get("last5_avg", 0.0))
        last5_reb = float(p["stats"].get("REB",{}).get("last5_avg", 0.0))
        last5_ast = float(p["stats"].get("AST",{}).get("last5_avg", 0.0))
        d_pts = _clamp(_safe_div(season_avg["PTS"] - last5_pts, max(season_avg["PTS"], 1e-6)), -1.0, 1.0)
        d_reb = _clamp(_safe_div(season_avg["REB"] - last5_reb, max(season_avg["REB"], 1e-6)), -1.0, 1.0)
        d_ast = _clamp(_safe_div(season_avg["AST"] - last5_ast, max(season_avg["AST"], 1e-6)), -1.0, 1.0)

        # advantage score semplice = z difesa + delta_form
        adv_pts = round(z_pts + d_pts, 3)
        adv_reb = round(z_reb + d_reb, 3)
        adv_ast = round(z_ast + d_ast, 3)

        # scrivi nei dati
        p.setdefault("stats", {})
        for stat, saz, adv in (("PTS", season_avg["PTS"], adv_pts),
                               ("REB", season_avg["REB"], adv_reb),
                               ("AST", season_avg["AST"], adv_ast)):
            blk = p["stats"].setdefault(stat, {})
            blk["season_avg"] = round(float(saz), 2)
            blk["adv_score"]  = adv

        p["role_bucket"]   = bucket
        p["opp_team_abbr"] = away_abbr if side == "home" else home_abbr
        out.append(p)

    return jsonify(out)


if __name__ == "__main__":
    # avvia su 5001 per non confliggere con il tuo progetto corrente
    app.run(port=5000, debug=True)
