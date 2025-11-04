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

# --- Ordina per data ---
df['GAME_DATE'] = pd.to_datetime(df['GAME_DATE'])
df = df.sort_values('GAME_DATE')

# --- Calcola medie mobili ultime 5 partite (escluse quelle correnti) ---
stats = ['PTS', 'REB', 'AST']
for stat in stats:
    df[f'{stat}_last5_avg'] = df[stat].shift().rolling(5, min_periods=1).mean()

# --- Controlla l’ultima partita ---
ultima_partita = df.iloc[-1]
print(f"Ultima partita: {ultima_partita['GAME_DATE'].date()}, Matchup: {ultima_partita['MATCHUP']}")

for stat in stats:
    media = ultima_partita[f'{stat}_last5_avg']
    valore_ultimo = ultima_partita[stat]
    if valore_ultimo < media:
        print(f"⚠ {stat}: {valore_ultimo} (sotto media {media:.2f})")
    else:
        print(f"{stat}: {valore_ultimo} (sopra o in media {media:.2f})")
