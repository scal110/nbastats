# nba_match_stats_cli.py
from nba_api.stats.endpoints import commonteamroster, playergamelog
from nba_api.stats.static import teams
import pandas as pd
import time


# Pre-carica l'elenco squadre una sola volta per evitare chiamate ripetute
_TEAMS = teams.get_teams()
_TEAM_ID_BY_FULL = {team["full_name"].lower(): team["id"] for team in _TEAMS}
_TEAM_ID_BY_ABBR = {team.get("abbreviation", "").lower(): team["id"] for team in _TEAMS if team.get("abbreviation")}
_ROSTER_CACHE = {}


# --- Funzioni di utilità ---
def get_team_id(team_name):
    """Restituisce l'ID squadra accettando nome completo, abbreviazione o match parziali."""
    if not team_name:
        raise ValueError("Nome squadra mancante")

    normalized = team_name.strip().lower()
    if not normalized:
        raise ValueError("Nome squadra mancante")

    if normalized in _TEAM_ID_BY_FULL:
        return _TEAM_ID_BY_FULL[normalized]

    if normalized in _TEAM_ID_BY_ABBR:
        return _TEAM_ID_BY_ABBR[normalized]

    # Cerca match parziali sul nome completo
    matches = [team_id for full_name, team_id in _TEAM_ID_BY_FULL.items() if normalized in full_name]
    if len(matches) == 1:
        return matches[0]

    # Permetti di passare direttamente l'ID numerico come stringa
    try:
        numeric_id = int(team_name)
        for team in _TEAMS:
            if team["id"] == numeric_id:
                return numeric_id
    except (TypeError, ValueError):
        pass

    raise ValueError(f"Squadra '{team_name}' non trovata")


def get_team_roster(team_id, season, attempts=3, timeout=60):
    """Recupera il roster di una squadra con caching in memoria."""
    cache_key = (team_id, season)
    if cache_key in _ROSTER_CACHE:
        return _ROSTER_CACHE[cache_key].copy()

    last_exception = None
    for attempt in range(attempts):
        try:
            roster_df = commonteamroster.CommonTeamRoster(team_id, season=season, timeout=timeout).get_data_frames()[0]
            _ROSTER_CACHE[cache_key] = roster_df
            return roster_df.copy()
        except Exception as exc:
            last_exception = exc
            time.sleep(2)

    raise RuntimeError(f"Impossibile recuperare il roster per team_id={team_id} season={season}: {last_exception}")


def get_player_game_log_safe(player_id, season, attempts=3, timeout=60):
    """Recupera il game log del giocatore con retry e timeout aumentato."""
    for i in range(attempts):
        try:
            gamelog = playergamelog.PlayerGameLog(player_id=player_id, season=season, timeout=timeout)
            df = gamelog.get_data_frames()[0]
            return df
        except Exception as e:
            print(f"Errore connessione per player_id {player_id}, tentativo {i+1}/{attempts}: {e}")
            time.sleep(5)
    return None


def compute_last5_stats(df):
    df = df.copy()
    df['GAME_DATE'] = pd.to_datetime(df['GAME_DATE'])
    df = df.sort_values('GAME_DATE')

    stats = ['PTS', 'REB', 'AST', 'MIN']
    result = {}

    # Prepara colonne numeriche una sola volta
    df['PTS_num'] = pd.to_numeric(df.get('PTS'), errors='coerce')
    df['REB_num'] = pd.to_numeric(df.get('REB'), errors='coerce')
    df['AST_num'] = pd.to_numeric(df.get('AST'), errors='coerce')

    # Converte i minuti "MM:SS" in minuti decimali
    minutes_timedelta = pd.to_timedelta(df.get('MIN'), errors='coerce')
    df['MIN_num'] = minutes_timedelta.dt.total_seconds() / 60

    for stat in stats:
        num_col = f'{stat}_num'
        avg_col = f'{stat}_last5_avg'
        df[avg_col] = df[num_col].shift().rolling(5, min_periods=1).mean()

        if df.empty:
            continue

        last_game = df.iloc[-1]
        value_num = last_game.get(num_col)
        avg_num = last_game.get(avg_col)

        value_num = float(value_num) if pd.notnull(value_num) else 0.0
        avg_num = float(avg_num) if pd.notnull(avg_num) else 0.0

        result[stat] = {
            'value': round(value_num, 2),
            'last5_avg': round(avg_num, 2),
            'under_avg': value_num < avg_num
        }

    return result

def sottomediapartita(home_team_name="Minnesota Timberwolves", away_team_name="Los Angeles Lakers", season='2025-26', debug=False):

    # --- Recupera roster delle squadre ---
    home_team_id = get_team_id(home_team_name)
    away_team_id = get_team_id(away_team_name)

    home_roster = get_team_roster(home_team_id, season)
    away_roster = get_team_roster(away_team_id, season)

    # 🔹 Aggiungiamo un campo 'side' a ciascun roster
    home_roster["side"] = "home"
    away_roster["side"] = "away"

    # Verifica il nome corretto della colonna nel roster
    position_col = "POSITION" if "POSITION" in home_roster.columns else "POS"

    all_players = pd.concat(
        [home_roster[["PLAYER_ID", "PLAYER", position_col, "side"]],
        away_roster[["PLAYER_ID", "PLAYER", position_col, "side"]]]
    ).reset_index(drop=True)

    # Rinominiamo la colonna per coerenza
    all_players = all_players.rename(columns={position_col: "POSITION"})



    # --- Calcola statistiche e stampa leggibile ---
    match_stats = []
    for _, row in all_players.iterrows():
        player_id = row['PLAYER_ID']
        player_name = row['PLAYER']

        if debug:
            print(f"Elaboro: {player_name} (id={player_id}) ...")

        df_player = get_player_game_log_safe(player_id, season)

        if df_player is None or df_player.empty:
            if debug:
                print(f"  ❌ Nessun dato disponibile per {player_name}.")
                print("-" * 50)
            continue

        stats = compute_last5_stats(df_player)
        min_avg = stats.get('MIN', {}).get('last5_avg', 0) or 0

        # --- FILTRO: media minuti ultime 5 partite < 20 ---
        if min_avg < 20:
            if debug:
                print(f"  ⏱️  Escluso: media minuti ultime 5 = {min_avg} (< 20)")
                print("-" * 50)
            continue

        # 🔹 Determiniamo nome squadra e lato
        side = row["side"]
        team_name = home_team_name if side == "home" else away_team_name

        # 🔹 Aggiungiamo 'team' e 'side' al dizionario che ritorna
        match_stats.append({
            "player": player_name,
            "team": team_name,
            "side": side,
            "position": row["POSITION"],
            "stats": stats
        })

        if debug:
            print(f"✅ Giocatore: {player_name}")
            for stat, values in stats.items():
                avg = values['last5_avg']
                status = "⚠ sotto media" if values['under_avg'] else "OK"
                if stat == "MIN":
                    print(f"  {stat}: {values['value']} min (media 5: {avg}) -> {status}")
                else:
                    print(f"  {stat}: {values['value']} (media 5: {avg}) -> {status}")
            print("-" * 50)

    if debug:
        print(f"\nElaborazione completata ✅  Giocatori inclusi: {len(match_stats)}")
    return(match_stats)
