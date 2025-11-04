from nba_api.stats.static import players
from nba_api.stats.endpoints import playergamelog
import pandas as pd

# --- Scegli il giocatore ---
player_name = "Kyle Filipowski"  # esempio
player_dict = players.find_players_by_full_name(player_name)
if not player_dict:
    raise ValueError(f"Giocatore {player_name} non trovato.")
player_id = player_dict[0]['id']

# --- Recupera il game log della stagione corrente ---
season = '2025-26'  # aggiorna alla stagione corrente
gamelog = playergamelog.PlayerGameLog(player_id=player_id, season=season)
df = gamelog.get_data_frames()[0]

# --- Ordina per data per calcolare medie mobili ---
df['GAME_DATE'] = pd.to_datetime(df['GAME_DATE'])
df = df.sort_values('GAME_DATE')

# --- Calcola medie mobili ultime 5 partite ---
df['PTS_last5_avg'] = df['PTS'].shift().rolling(5, min_periods=1).mean()
df['REB_last5_avg'] = df['REB'].shift().rolling(5, min_periods=1).mean()
df['AST_last5_avg'] = df['AST'].shift().rolling(5, min_periods=1).mean()

# --- Mostra le ultime righe con medie mobili ---
print(df[['GAME_DATE', 'MATCHUP', 'PTS', 'PTS_last5_avg', 'REB', 'REB_last5_avg', 'AST', 'AST_last5_avg']].tail(10))
