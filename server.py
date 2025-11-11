from flask import Flask, jsonify, request
from flask_cors import CORS
from nba_api.stats.endpoints import scoreboardv2
from nba_api.stats.static import teams
from datetime import datetime
import pytz
import time
from dateutil import parser
import sottomediapartita
import teamdefensestatsperrole

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

# Modifica /stats per accettare query params home & away...
@app.route("/stats", methods=["GET"])
def receive_stats():
    # leggi parametri query: /stats?home=Team+Name&away=Other+Team
    home = request.args.get("home")
    away = request.args.get("away")
    # se non forniti, puoi usare valori di default nel tuo sottomediapartita attuale
    try:
        if home and away:
            data = sottomediapartita.sottomediapartita(home_team_name=home, away_team_name=away)
        else:
            # fallback al comportamento precedente (se il tuo sottomediapartita non prende argomenti)
            data = sottomediapartita.sottomediapartita()
    except TypeError:
        # se sottomediapartita non accetta argomenti, puoi impostare variabili globali prima della chiamata:
        # (oppure aggiornare sottomediapartita come suggerito più sotto)
        data = sottomediapartita.sottomediapartita()
    return jsonify(data)

@app.route("/team-defense")
def team_defense():
    team = request.args.get("team")  # es: LAL
    season = request.args.get("season", "2025-26")
    out = teamdefensestatsperrole.compute_defense_by_position_boxscore_per_game(team, season, exclude_dnp=True, debug=False)
    return jsonify(out)

if __name__ == "__main__":
    app.run(debug=True)
