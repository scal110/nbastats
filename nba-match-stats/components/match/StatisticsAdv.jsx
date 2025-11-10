"use client";
import { useEffect, useMemo, useState } from "react";

/**
 * Requirements:
 * - Backend Flask deve esporre:
 *   GET /team-defense?team=<ABBR>&season=<YYYY-YY>
 *   -> { by_position_per_game: { G|F|C|OTHER: { pts_per_game, reb_per_game, ast_per_game, ... } }, ... }
 *
 * - Questo componente:
 *   - Chiama /stats (già esistente) per i dati giocatori di una specifica partita
 *   - Team header è cliccabile: apre una modal con le stats difensive per ruolo dell'avversario
 *   - Evidenzia il giocatore (stat cell) dove l'avversario concede di più, per il suo ruolo
 */

export default function StatisticsAdv({ apiPath = "/stats", season = "2025-26" }) {
  const baseUrl = "http://localhost:5000"; // hardcoded
  const apiUrl = baseUrl + apiPath;

  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // popup / modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTeamAbbr, setModalTeamAbbr] = useState(null);
  const [modalTeamName, setModalTeamName] = useState(null);
  const [defenseLoading, setDefenseLoading] = useState(false);
  const [defenseError, setDefenseError] = useState(null);
  const [defenseData, setDefenseData] = useState(null);

  // cache locale di difese per team abbr
  const [defenseCache, setDefenseCache] = useState({}); // { LAL: { by_position_per_game: {...} }, ... }

  // UI filters
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("player"); // player | pts | reb | ast
  const [sortDir, setSortDir] = useState("desc"); // asc | desc
  const [roleFilter, setRoleFilter] = useState("All"); // All, G, F, C, etc.

  // --- mappa team FullName -> Abbrev (per fetch difese)
  const TEAM_NAME_TO_ABBR = {
    "Atlanta Hawks": "ATL",
    "Boston Celtics": "BOS",
    "Brooklyn Nets": "BKN",
    "Charlotte Hornets": "CHA",
    "Chicago Bulls": "CHI",
    "Cleveland Cavaliers": "CLE",
    "Dallas Mavericks": "DAL",
    "Denver Nuggets": "DEN",
    "Detroit Pistons": "DET",
    "Golden State Warriors": "GSW",
    "Houston Rockets": "HOU",
    "Indiana Pacers": "IND",
    "LA Clippers": "LAC",
    "Los Angeles Lakers": "LAL",
    "Memphis Grizzlies": "MEM",
    "Miami Heat": "MIA",
    "Milwaukee Bucks": "MIL",
    "Minnesota Timberwolves": "MIN",
    "New Orleans Pelicans": "NOP",
    "New York Knicks": "NYK",
    "Oklahoma City Thunder": "OKC",
    "Orlando Magic": "ORL",
    "Philadelphia 76ers": "PHI",
    "Phoenix Suns": "PHX",
    "Portland Trail Blazers": "POR",
    "Sacramento Kings": "SAC",
    "San Antonio Spurs": "SAS",
    "Toronto Raptors": "TOR",
    "Utah Jazz": "UTA",
    "Washington Wizards": "WAS",
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(Array.isArray(json) ? json : []);
      setLastUpdated(new Date().toLocaleString());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  // ruoli disponibili
  const roles = useMemo(() => {
    const setRoles = new Set();
    (data || []).forEach((p) => {
      const r = (p.position || p.POSITION || "").toString().trim();
      if (r) setRoles.add(r);
    });
    return ["All", ...Array.from(setRoles).sort()];
  }, [data]);

  // Split per side
  const grouped = useMemo(() => {
    const home = [];
    const away = [];
    (data || []).forEach((p) => {
      const side = p.side || (p.team && typeof p.team === "string" && p.team.toLowerCase().includes("at") ? "away" : "home");
      if (side === "away") away.push(p);
      else home.push(p);
    });
    return { home, away };
  }, [data]);

  // Team names
  const homeTeamName = useMemo(() => (grouped.home[0]?.team ?? null), [grouped.home]);
  const awayTeamName = useMemo(() => (grouped.away[0]?.team ?? null), [grouped.away]);

  // Abbrev
  const homeAbbr = useMemo(() => (homeTeamName ? TEAM_NAME_TO_ABBR[homeTeamName] : null), [homeTeamName]);
  const awayAbbr = useMemo(() => (awayTeamName ? TEAM_NAME_TO_ABBR[awayTeamName] : null), [awayTeamName]);

  // sort helper
  const sortKey = (p) => {
    if (sortBy === "pts") return p.stats?.PTS?.last5_avg ?? -Infinity;
    if (sortBy === "reb") return p.stats?.REB?.last5_avg ?? -Infinity;
    if (sortBy === "ast") return p.stats?.AST?.last5_avg ?? -Infinity;
    return (p.player || "").toLowerCase();
  };

  const filterAndSort = (list) => {
    const q = (query || "").trim().toLowerCase();
    let out = list.filter((p) => {
      if (!q && (roleFilter === "All" || !roleFilter)) return true;
      const name = (p.player || "").toLowerCase();
      const pos = (p.position || p.POSITION || "").toString().toLowerCase();
      const matchesQ = !q || name.includes(q);
      const matchesRole = roleFilter === "All" || roleFilter === "" ? true : pos === roleFilter.toLowerCase();
      return matchesQ && matchesRole;
    });

    out.sort((a, b) => {
      const va = sortKey(a);
      const vb = sortKey(b);
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      const na = Number.isFinite(va) ? va : -Infinity;
      const nb = Number.isFinite(vb) ? vb : -Infinity;
      return sortDir === "asc" ? na - nb : nb - na;
    });
    return out;
  };

  const homeList = filterAndSort(grouped.home);
  const awayList = filterAndSort(grouped.away);

  // --- helpers ruolo bucket ---
  const toBucket = (pos) => {
    const s = (pos || "").toUpperCase();
    const first = s.split("-")[0];
    if (["PG", "SG", "G"].includes(first)) return "G";
    if (["SF", "PF", "F"].includes(first)) return "F";
    if (first === "C") return "C";
    return "OTHER";
  };

  // --- fetch difesa team ---
  const fetchDefenseForTeam = async (teamAbbr) => {
    if (!teamAbbr) return null;
    // cache hit
    if (defenseCache[teamAbbr]) return defenseCache[teamAbbr];

    try {
      setDefenseLoading(true);
      setDefenseError(null);
      setDefenseData(null);

      const url = `${baseUrl}/team-defense?team=${encodeURIComponent(teamAbbr)}&season=${encodeURIComponent(season)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      setDefenseCache((prev) => ({ ...prev, [teamAbbr]: json }));
      setDefenseData(json);
      return json;
    } catch (e) {
      setDefenseError(e.message || String(e));
      return null;
    } finally {
      setDefenseLoading(false);
    }
  };

  // --- open modal helper ---
  const openTeamModal = async (teamName) => {
    const abbr = TEAM_NAME_TO_ABBR[teamName] || null;
    setModalTeamName(teamName);
    setModalTeamAbbr(abbr);
    setModalOpen(true);
    if (abbr) {
      const cached = defenseCache[abbr];
      if (cached) {
        setDefenseData(cached);
        setDefenseError(null);
      } else {
        await fetchDefenseForTeam(abbr);
      }
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setDefenseData(null);
    setDefenseError(null);
    setDefenseLoading(false);
  };

  // --- calcolo "vantaggio" per giocatore: quale stat (PTS/REB/AST) è più favorevole in base alla difesa avversaria per il suo ruolo ---
  // ritorna: "PTS" | "REB" | "AST" | null
  const getAdvantageStat = (player, opponentAbbr) => {
    if (!player?.position || !opponentAbbr) return null;
    const bucket = toBucket(player.position);
    const def = defenseCache[opponentAbbr]?.by_position_per_game?.[bucket];
    if (!def) return null;

    const pts = Number(def.pts_per_game ?? 0);
    const reb = Number(def.reb_per_game ?? 0);
    const ast = Number(def.ast_per_game ?? 0);

    // scegli la stat massima come "più favorevole"
    let best = "PTS";
    let bestVal = pts;
    if (reb > bestVal) { best = "REB"; bestVal = reb; }
    if (ast > bestVal) { best = "AST"; bestVal = ast; }
    return best;
  };

  // cella con highlighting se "advantage"
  const StatCell = ({ stat, highlight }) => {
    const v = stat?.value ?? "N/A";
    const avg = stat?.last5_avg ?? "N/A";
    const under = !!stat?.under_avg;
    const highlightClass = highlight ? "" : "";
    return (
      <div className={`flex flex-col items-end ${highlightClass}`}>
        <div className={`text-sm font-medium ${under ? "text-red-600" : "text-slate-800"}`}>{v}</div>
        <div className="text-xs text-gray-400">({avg})</div>
        {under && <div className="mt-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">sotto</div>}
      </div>
    );
  };

  // prefetch difese per avere highlighting senza aprire popup
  useEffect(() => {
    // quando abbiamo i team abbr, facciamo un prefetch soft (senza bloccare UI)
    const prefetch = async () => {
      if (homeAbbr && !defenseCache[homeAbbr]) {
        fetchDefenseForTeam(homeAbbr);
      }
      if (awayAbbr && !defenseCache[awayAbbr]) {
        fetchDefenseForTeam(awayAbbr);
      }
    };
    prefetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeAbbr, awayAbbr]);

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold">Match stats</h2>
          <div className="text-sm text-gray-500">Visualizza i giocatori divisi per Casa / Trasferta</div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca giocatore..."
            className="px-3 py-2 border rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-sky-300"
          />

          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-2 py-2 border rounded-md bg-white"
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="px-2 py-2 border rounded-md bg-white"
          >
            <option value="player">Ordina: Giocatore</option>
            <option value="pts">Ordina: PTS (media 5)</option>
            <option value="reb">Ordina: REB (media 5)</option>
            <option value="ast">Ordina: AST (media 5)</option>
          </select>

          <button
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            className="px-3 py-2 border rounded-md bg-white"
            title="Inverti direzione ordinamento"
          >
            {sortDir === "asc" ? "↑ Asc" : "↓ Desc"}
          </button>

          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3 py-2 bg-sky-600 text-white rounded-md ml-2"
          >
            {loading ? "Caricamento..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Subheader status */}
      <div className="mb-3 text-sm text-gray-500 flex items-center gap-4">
        {error && <span className="text-red-600">Errore: {error}</span>}
        {!error && <span>{lastUpdated ? `Ultimo aggiornamento: ${lastUpdated}` : "Dati non ancora caricati"}</span>}
      </div>

      {/* Griglia Casa / Trasferta */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* CASA */}
        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-slate-700">CASA</h3>
              <button
                className="text-xs text-sky-600 underline underline-offset-2 hover:opacity-80"
                onClick={() => homeTeamName && openTeamModal(homeTeamName)}
                title="Mostra stats concesse per ruolo"
              >
                {homeTeamName ?? "Team casa"}
              </button>
            </div>
            <div className="text-sm text-gray-500">{homeList.length} giocatori</div>
          </div>

          <div className="space-y-3">
            {homeList.map((p) => {
              const opponentAbbr = awayAbbr; // gli avversari dei giocatori di casa
              const adv = getAdvantageStat(p, opponentAbbr);
              return (
                <div
                  key={p.player}
                  className="flex items-center justify-between gap-3 p-3 border rounded-md hover:shadow-sm"
                >
                  <div>
                    <div className="flex items-baseline gap-3">
                      <div className="font-medium">{p.player}</div>
                      {p.position && (
                        <div className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{p.position}</div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="text-xs text-gray-500">MIN</div>
                    <div className="text-sm font-medium">
                      {p.stats?.MIN?.value ?? "N/A"}{" "}
                      <span className="text-xs text-gray-400">({p.stats?.MIN?.last5_avg ?? "N/A"})</span>
                    </div>

                    <div className="w-px h-8 bg-gray-200" />

                    <div className="flex gap-6 items-center">
                      <div className="text-xs text-gray-500">PTS</div>
                      <StatCell stat={p.stats?.PTS} highlight={adv === "PTS"} />
                    </div>

                    <div className="flex gap-6 items-center">
                      <div className="text-xs text-gray-500">REB</div>
                      <StatCell stat={p.stats?.REB} highlight={adv === "REB"} />
                    </div>

                    <div className="flex gap-6 items-center">
                      <div className="text-xs text-gray-500">AST</div>
                      <StatCell stat={p.stats?.AST} highlight={adv === "AST"} />
                    </div>
                  </div>
                </div>
              );
            })}

            {homeList.length === 0 && <div className="text-sm text-gray-500">Nessun giocatore (dati mancanti o filtrati)</div>}
          </div>
        </section>

        {/* TRASFERTA */}
        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-slate-700">TRASFERTA</h3>
              <button
                className="text-xs text-sky-600 underline underline-offset-2 hover:opacity-80"
                onClick={() => awayTeamName && openTeamModal(awayTeamName)}
                title="Mostra stats concesse per ruolo"
              >
                {awayTeamName ?? "Team trasferta"}
              </button>
            </div>
            <div className="text-sm text-gray-500">{awayList.length} giocatori</div>
          </div>

          <div className="space-y-3">
            {awayList.map((p) => {
              const opponentAbbr = homeAbbr; // gli avversari dei giocatori in trasferta
              const adv = getAdvantageStat(p, opponentAbbr);
              return (
                <div
                  key={p.player}
                  className="flex items-center justify-between gap-3 p-3 border rounded-md hover:shadow-sm"
                >
                  <div>
                    <div className="flex items-baseline gap-3">
                      <div className="font-medium">{p.player}</div>
                      {p.position && (
                        <div className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{p.position}</div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="text-xs text-gray-500">MIN</div>
                    <div className="text-sm font-medium">
                      {p.stats?.MIN?.value ?? "N/A"}{" "}
                      <span className="text-xs text-gray-400">({p.stats?.MIN?.last5_avg ?? "N/A"})</span>
                    </div>

                    <div className="w-px h-8 bg-gray-200" />

                    <div className="flex gap-6 items-center">
                      <div className="text-xs text-gray-500">PTS</div>
                      <StatCell stat={p.stats?.PTS} highlight={adv === "PTS"} />
                    </div>

                    <div className="flex gap-6 items-center">
                      <div className="text-xs text-gray-500">REB</div>
                      <StatCell stat={p.stats?.REB} highlight={adv === "REB"} />
                    </div>

                    <div className="flex gap-6 items-center">
                      <div className="text-xs text-gray-500">AST</div>
                      <StatCell stat={p.stats?.AST} highlight={adv === "AST"} />
                    </div>
                  </div>
                </div>
              );
            })}

            {awayList.length === 0 && <div className="text-sm text-gray-500">Nessun giocatore (dati mancanti o filtrati)</div>}
          </div>
        </section>
      </div>

      {/* MODAL: Team Defense per ruolo */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={closeModal} />
          <div className="relative bg-white w-full max-w-xl rounded-lg shadow-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-sm text-gray-500">Statistiche concesse per ruolo</div>
                <h4 className="text-lg font-semibold">
                  {modalTeamName} {modalTeamAbbr ? `(${modalTeamAbbr})` : ""}
                </h4>
              </div>
              <button onClick={closeModal} className="px-2 py-1 text-sm border rounded hover:bg-gray-50">Chiudi</button>
            </div>

            {defenseLoading && <div className="text-sm text-gray-600">Caricamento…</div>}
            {defenseError && <div className="text-sm text-red-600">Errore: {defenseError}</div>}

            {!defenseLoading && !defenseError && defenseData?.by_position_per_game && (
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="px-3 py-2">Ruolo</th>
                      <th className="px-3 py-2">PTS/gara</th>
                      <th className="px-3 py-2">REB/gara</th>
                      <th className="px-3 py-2">AST/gara</th>
                      <th className="px-3 py-2 text-xs text-gray-500">Partite</th>
                    </tr>
                  </thead>
                  <tbody>
                    {["G","F","C","OTHER"].map((bucket) => {
                      const row = defenseData.by_position_per_game[bucket];
                      if (!row) return null;
                      return (
                        <tr key={bucket} className="border-b">
                          <td className="px-3 py-2 font-medium">{bucket}</td>
                          <td className="px-3 py-2">{row.pts_per_game}</td>
                          <td className="px-3 py-2">{row.reb_per_game}</td>
                          <td className="px-3 py-2">{row.ast_per_game}</td>
                          <td className="px-3 py-2 text-xs text-gray-500">{row.games_scanned}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="mt-3 text-xs text-gray-500">
                  * Media per partita aggregata per ruolo degli avversari; fonte: boxscore NBA ({season})
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
