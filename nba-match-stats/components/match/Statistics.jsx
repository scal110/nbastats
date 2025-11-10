"use client";
import { useEffect, useMemo, useState } from "react";

/**
 * Statistics (Next.js client component)
 * - usa URL hardcoded: http://localhost:5000 + apiPath
 * - mostra position (ruolo) per ogni giocatore
 * - split home / away, mostra il nome squadra una sola volta nella header della colonna
 * - ricerca per giocatore
 * - ordinamento (player | pts | reb | ast) su last5_avg
 * - filtro rapido per ruolo (All / G / F / C / custom)
 * - Refresh manuale (no polling automatico)
 */

export default function Statistics({ apiPath = "/stats" }) {
  const baseUrl = "http://localhost:5000"; // hardcoded
  const apiUrl = baseUrl + apiPath;

  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // UI states
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("player"); // player | pts | reb | ast
  const [sortDir, setSortDir] = useState("desc"); // asc | desc
  const [roleFilter, setRoleFilter] = useState("All"); // All, G, F, C, etc.

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
    // fetch al mount (una volta)
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  // raccogli ruoli presenti per dropdown
  const roles = useMemo(() => {
    const setRoles = new Set();
    (data || []).forEach((p) => {
      const r = (p.position || p.POSITION || "").toString().trim();
      if (r) setRoles.add(r);
    });
    return ["All", ...Array.from(setRoles).sort()];
  }, [data]);

  // Split home / away (assume "side" presente; fallback: team name heuristic)
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

  // derive team names (show once per section)
  const homeTeamName = useMemo(() => {
    if (grouped.home.length === 0) return null;
    // prefer header name if provided at top-level (we expect p.team)
    return grouped.home[0].team || null;
  }, [grouped.home]);

  const awayTeamName = useMemo(() => {
    if (grouped.away.length === 0) return null;
    return grouped.away[0].team || null;
  }, [grouped.away]);

  // helper per ottenere valore di sorting (usa last5_avg)
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

  // Small presentational stat cell
  const StatCell = ({ stat }) => {
    const v = stat?.value ?? "N/A";
    const avg = stat?.last5_avg ?? "N/A";
    const under = !!stat?.under_avg;
    return (
      <div className="flex flex-col items-end">
        <div className={`text-sm font-medium ${under ? "text-red-600" : "text-slate-800"}`}>{v}</div>
        <div className="text-xs text-gray-400">({avg})</div>
        {under && <div className="mt-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">sotto</div>}
      </div>
    );
  };

  return (
    <div className="p-4">
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

      <div className="mb-3 text-sm text-gray-500 flex items-center gap-4">
        {error && <span className="text-red-600">Errore: {error}</span>}
        {!error && <span>{lastUpdated ? `Ultimo aggiornamento: ${lastUpdated}` : "Dati non ancora caricati"}</span>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* CASA */}
        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-slate-700">CASA</h3>
              <div className="text-xs text-gray-500">{homeTeamName ?? "Team casa"}</div>
            </div>
            <div className="text-sm text-gray-500">{homeList.length} giocatori</div>
          </div>

          <div className="space-y-3">
            {homeList.map((p) => (
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
                    <StatCell stat={p.stats?.PTS} />
                  </div>

                  <div className="flex gap-6 items-center">
                    <div className="text-xs text-gray-500">REB</div>
                    <StatCell stat={p.stats?.REB} />
                  </div>

                  <div className="flex gap-6 items-center">
                    <div className="text-xs text-gray-500">AST</div>
                    <StatCell stat={p.stats?.AST} />
                  </div>
                </div>
              </div>
            ))}

            {homeList.length === 0 && <div className="text-sm text-gray-500">Nessun giocatore (dati mancanti o filtrati)</div>}
          </div>
        </section>

        {/* TRASFERTA */}
        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-slate-700">TRASFERTA</h3>
              <div className="text-xs text-gray-500">{awayTeamName ?? "Team trasferta"}</div>
            </div>
            <div className="text-sm text-gray-500">{awayList.length} giocatori</div>
          </div>

          <div className="space-y-3">
            {awayList.map((p) => (
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
                    <StatCell stat={p.stats?.PTS} />
                  </div>

                  <div className="flex gap-6 items-center">
                    <div className="text-xs text-gray-500">REB</div>
                    <StatCell stat={p.stats?.REB} />
                  </div>

                  <div className="flex gap-6 items-center">
                    <div className="text-xs text-gray-500">AST</div>
                    <StatCell stat={p.stats?.AST} />
                  </div>
                </div>
              </div>
            ))}

            {awayList.length === 0 && <div className="text-sm text-gray-500">Nessun giocatore (dati mancanti o filtrati)</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
