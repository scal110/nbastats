# nba_match_stats_cli.py
from nba_api.stats.endpoints import commonteamroster, playergamelog
from nba_api.stats.static import teams
import pandas as pd
import time




# --- Funzioni di utilità ---
def get_team_id(team_name):
    team_dict = [t for t in teams.get_teams() if t['full_name'] == team_name]
    if not team_dict:
        raise ValueError(f"Squadra {team_name} non trovata.")
    return team_dict[0]['id']


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
    df['GAME_DATE'] = pd.to_datetime(df['GAME_DATE'])
    df = df.sort_values('GAME_DATE')
    stats = ['PTS', 'REB', 'AST', 'MIN']
    result = {}

    for stat in stats:
        
        print(df[stat].shift())
        df[f'{stat}_last5_avg'] = df[stat].shift().rolling(5, min_periods=1).mean()

        if df.empty:
            continue

        last_game = df.iloc[-1]
        avg = last_game[f'{stat}_last5_avg']
        value = last_game[stat]

        # Converti in numeri e gestisci NaN
        try:
            value_num = float(value) if pd.notnull(value) else 0
            avg_num = float(avg) if pd.notnull(avg) else 0
        except Exception:
            value_num, avg_num = 0, 0

        result[stat] = {
            'value': int(value_num),
            'last5_avg': round(avg_num, 2),
            'under_avg': value_num < avg_num
        }

    return result

def sottomediapartita(home_team_name="Minnesota Timberwolves", away_team_name="Los Angeles Lakers", season='2025-26'):
    
    # --- Recupera roster delle squadre ---
    home_team_id = get_team_id(home_team_name)
    away_team_id = get_team_id(away_team_name)

    home_roster = commonteamroster.CommonTeamRoster(home_team_id, season=season).get_data_frames()[0]
    away_roster = commonteamroster.CommonTeamRoster(away_team_id, season=season).get_data_frames()[0]

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

        print(f"Elaboro: {player_name} (id={player_id}) ...")

        df_player = get_player_game_log_safe(player_id, season)
        
        if df_player is None or df_player.empty:
            print(f"  ❌ Nessun dato disponibile per {player_name}.")
            print("-" * 50)
            continue

        stats = compute_last5_stats(df_player)
        min_avg = stats.get('MIN', {}).get('last5_avg', 0) or 0

        # --- FILTRO: media minuti ultime 5 partite < 20 ---
        if min_avg < 20:
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

        print(f"✅ Giocatore: {player_name}")
        for stat, values in stats.items():
            avg = values['last5_avg']
            status = "⚠ sotto media" if values['under_avg'] else "OK"
            if stat == "MIN":
                print(f"  {stat}: {values['value']} min (media 5: {avg}) -> {status}")
            else:
                print(f"  {stat}: {values['value']} (media 5: {avg}) -> {status}")
        print("-" * 50)
        time.sleep(1)

    print(f"\nElaborazione completata ✅  Giocatori inclusi: {len(match_stats)}")
    return(match_stats)
