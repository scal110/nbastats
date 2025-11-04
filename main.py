from nba_api.stats.static import players
from nba_api.stats.endpoints import leagueleaders
import pandas as pd

# --- Parametri ---
season = '2025-26'  # stagione corrente (puoi aggiornare in base alla stagione)
stat_categories = ['PTS', 'REB', 'AST']  # punti, rimbalzi, assist

# --- Recupera statistiche dei leader della stagione ---
leaders = leagueleaders.LeagueLeaders(season=season, stat_category_abbreviation='PTS')  # Esempio Punti
leaders_df = leaders.get_data_frames()[0]  # Ottieni il dataframe pandas

# Mostra le prime 10 righe
print(leaders_df.head(10))

# --- Se vuoi ottenere più statistiche (PTS, REB, AST) ---
# Puoi ripetere il procedimento per ogni stat_category_abbreviation
dfs = []
for stat in stat_categories:
    data = leagueleaders.LeagueLeaders(season=season, stat_category_abbreviation=stat)
    df = data.get_data_frames()[0]
    df = df[['PLAYER', 'TEAM_ABBREVIATION', stat]]  # seleziona solo colonne principali
    dfs.append(df)

# Unisci le statistiche in un unico DataFrame
df_merged = dfs[0]
for i in range(1, len(dfs)):
    df_merged = pd.merge(df_merged, dfs[i], on=['PLAYER','TEAM_ABBREVIATION'])

print(df_merged.head(10))
