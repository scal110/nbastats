"use client";
import { useEffect, useMemo, useState } from "react";

/**
 * StatisticsBounce
 * GET {apiBase}/stats-bounce?home=&away=&season=&last_n=10
 * Mostra:
 *  - Ultima vs Media(5 prev) per PTS/REB/AST + under%
 *  - Concessioni avv. per ruolo (ultimi last_n RS) e ratio
 *  - Bounce score per stat -> ordinabile
 */
export default function StatisticsBounce({
  home,
  away,
  season = "2025-26",
  apiBase = "http://localhost:5000",
  lastN = 10,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [sortBy, setSortBy] = useState("bounce"); // bounce|player|pts|reb|ast
  const [sortDir, setSortDir] = useState("desc");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("All");
  const [lastUpdated, setLastUpdated] = useState(null);

  const url = useMemo(() => {
    const qs = new URLSearchParams({
      home: home || "",
      away: away || "",
      season: season || "2025-26",
      last_n: String(lastN || 10),
    });
    return `${apiBase.replace(/\/$/, "")}/stats-bounce?${qs.toString()}`;
  }, [home, away, season, apiBase, lastN]);

  const fetchData = async () => {
    setLoading(true);
    setErr(null);
    const ctrl = new AbortController();
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRows(Array.isArray(json) ? json : []);
      setLastUpdated(new Date().toLocaleString());
    } catch (e) {
      if (e.name !== "AbortError") setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
    return () => ctrl.abort();
  };

  useEffect(() => {
    if (!home || !away) {
      setRows([]);
      return;
    }
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const roles = useMemo(() => {
    const s = new Set();
    rows.forEach((r) => {
      const p = (r.position || "").trim();
      if (p) s.add(p);
    });
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  const safeNum = (v, def = -Infinity) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  const bounceAvg = (r) => {
    const b = r && r.bounce_score ? r.bounce_score : {};
    const pts = safeNum(b.PTS, 0);
    const reb = safeNum(b.REB, 0);
    const ast = safeNum(b.AST, 0);
    return (pts + reb + ast) / 3;
  };

  const sortKey = (r) => {
    if (sortBy === "bounce") return bounceAvg(r);
    if (sortBy === "pts") return safeNum(r?.stats?.PTS?.last5_avg);
    if (sortBy === "reb") return safeNum(r?.stats?.REB?.last5_avg);
    if (sortBy === "ast") return safeNum(r?.stats?.AST?.last5_avg);
    return (r.player || "").toLowerCase();
  };

  const filtered = useMemo(() => {
    const qq = (q || "").toLowerCase();
    let lst = rows.filter((r) => {
      const name = (r.player || "").toLowerCase();
      const pos = (r.position || "").toLowerCase();
      const okQ = !qq || name.includes(qq);
      const okRole =
        roleFilter === "All" ||
        roleFilter === "" ||
        pos === roleFilter.toLowerCase();
      return okQ && okRole;
    });
    lst.sort((a, b) => {
      const va = sortKey(a);
      const vb = sortKey(b);
      if (typeof va === "string") {
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      const na = safeNum(va);
      const nb = safeNum(vb);
      return sortDir === "asc" ? na - nb : nb - na;
    });
    return lst;
  }, [rows, q, roleFilter, sortBy, sortDir]);

  const Pill = ({ children, color = "gray" }) => {
    const cls =
      color === "green"
        ? "bg-green-100 text-green-700"
        : color === "red"
        ? "bg-red-100 text-red-700"
        : color === "amber"
        ? "bg-amber-100 text-amber-700"
        : "bg-slate-100 text-slate-700";
    return (
      <span className={`text-[11px] px-1.5 py-0.5 rounded ${cls}`}>{children}</span>
    );
  };

  const UnderCell = ({ label, s, up }) => {
    const val = s?.value ?? "—";
    const avg = s?.last5_avg ?? "—";
    const under = !!s?.under_avg;
    const upPct = typeof up === "number" ? up * 100 : 0;
    const col = typeof up === "number" && up < 0 ? "red" : up > 0 ? "green" : "gray";
    return (
      <div className="flex flex-col items-end gap-1">
        <div className={`text-sm font-medium ${under ? "text-red-600" : "text-slate-800"}`}>
          {val} <span className="text-xs text-gray-400">(5prev {avg})</span>
        </div>
        <Pill color={col}>under% {label}: {upPct.toFixed(0)}%</Pill>
      </div>
    );
  };

  const MatchupCell = ({ label, val, ratio }) => {
    const r = safeNum(ratio, 1);
    const col = r > 1.1 ? "green" : r > 1.0 ? "amber" : r < 0.9 ? "red" : "gray";
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="text-sm font-medium">
          {val ?? "—"} <span className="text-xs text-gray-400">/g</span>
        </div>
        <Pill color={col}>ratio {label}: {r.toFixed(2)}</Pill>
      </div>
    );
  };

  const BounceCell = ({ label, r }) => {
    const b = safeNum(r?.bounce_score?.[label], 0);
    const col = b >= 0.6 ? "green" : b >= 0.25 ? "amber" : "gray";
    return <Pill color={col}>bounce {label}: {b.toFixed(2)}</Pill>;
  };

  const Row = ({ r }) => {
    const key = `${r.player || "?"}-${r.team || "?"}-${r.side || "?"}`;
    return (
      <div key={key} className="flex items-center justify-between gap-3 p-3 border rounded-md hover:shadow-sm">
        <div className="flex items-baseline gap-3">
          <div className="font-medium">{r.player}</div>
          {r.position && (
            <div className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
              {r.position}
            </div>
          )}
          {r.role_bucket && (
            <div className="text-xs text-gray-500">ruolo: {r.role_bucket}</div>
          )}
        </div>

        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <div className="text-xs text-gray-500">MIN</div>
            <div className="text-sm font-medium">
              {r.stats?.MIN?.value ?? "—"}{" "}
              <span className="text-xs text-gray-400">
                ({r.stats?.MIN?.last5_avg ?? "—"})
              </span>
            </div>
          </div>

          <div className="w-px h-8 bg-gray-200" />

          <div className="flex gap-6 items-center">
            <div className="text-xs text-gray-500">PTS</div>
            <div className="flex flex-col items-end gap-1">
              <UnderCell label="PTS" s={r.stats?.PTS} up={r.under_pct?.PTS} />
              <MatchupCell
                label="PTS"
                val={r.opp_role_allow?.PTS}
                ratio={r.opp_ratio?.PTS}
              />
              <BounceCell label="PTS" r={r} />
            </div>
          </div>

          <div className="flex gap-6 items-center">
            <div className="text-xs text-gray-500">REB</div>
            <div className="flex flex-col items-end gap-1">
              <UnderCell label="REB" s={r.stats?.REB} up={r.under_pct?.REB} />
              <MatchupCell
                label="REB"
                val={r.opp_role_allow?.REB}
                ratio={r.opp_ratio?.REB}
              />
              <BounceCell label="REB" r={r} />
            </div>
          </div>

          <div className="flex gap-6 items-center">
            <div className="text-xs text-gray-500">AST</div>
            <div className="flex flex-col items-end gap-1">
              <UnderCell label="AST" s={r.stats?.AST} up={r.under_pct?.AST} />
              <MatchupCell
                label="AST"
                val={r.opp_role_allow?.AST}
                ratio={r.opp_ratio?.AST}
              />
              <BounceCell label="AST" r={r} />
            </div>
          </div>
        </div>
      </div>
    );
  };

  const homeList = useMemo(() => filtered.filter((r) => r.side !== "away"), [filtered]);
  const awayList = useMemo(() => filtered.filter((r) => r.side === "away"), [filtered]);

  return (
    <div className="p-4">
      <div className="mb-3 rounded-md border p-3 bg-slate-50 text-sm text-slate-700">
        <div className="font-semibold mb-1">Come leggere</div>
        <div>
          • <b>under%</b> = (Ultima − media delle <i>precedenti</i> 5) / media. Negativo ⇒ è andato sotto.
        </div>
        <div>
          • <b>ratio</b> = concessioni dell’avversario per il <i>tuo ruolo</i> divise per la loro media tra i ruoli (stessa stat). &gt; 1 ⇒ matchup più morbido.
        </div>
        <div>
          • <b>bounce</b> = max(0, −under) × max(0, ratio − 1): alto se è appena andato sotto e il matchup è favorevole su quella stat.
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Cerca giocatore..."
          className="px-3 py-2 border rounded-md w-64"
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
          <option value="bounce">Ordina: Bounce medio</option>
          <option value="player">Ordina: Giocatore</option>
          <option value="pts">Ordina: PTS (avg5prev)</option>
          <option value="reb">Ordina: REB (avg5prev)</option>
          <option value="ast">Ordina: AST (avg5prev)</option>
        </select>
        <button
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          className="px-3 py-2 border rounded-md bg-white"
        >
          {sortDir === "asc" ? "↑ Asc" : "↓ Desc"}
        </button>
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-3 py-2 bg-sky-600 text-white rounded-md"
        >
          {loading ? "Carico..." : "Refresh"}
        </button>
        {lastUpdated && (
          <div className="text-sm text-gray-500 ml-2">Aggiornato: {lastUpdated}</div>
        )}
        {err && <div className="text-sm text-red-600 ml-2">Errore: {err}</div>}
      </div>

      {loading && rows.length === 0 ? (
        <div className="text-sm text-gray-500">Sto caricando i dati…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <section className="bg-white shadow rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-semibold text-slate-700">CASA</h3>
              </div>
              <div className="text-sm text-gray-500">{homeList.length} giocatori</div>
            </div>
            <div className="space-y-3">
              {homeList.map((r) => (
                <Row key={`${r.player}-${r.team}-home`} r={r} />
              ))}
              {homeList.length === 0 && (
                <div className="text-sm text-gray-500">Nessun giocatore</div>
              )}
            </div>
          </section>

          <section className="bg-white shadow rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-semibold text-slate-700">TRASFERTA</h3>
              </div>
              <div className="text-sm text-gray-500">{awayList.length} giocatori</div>
            </div>
            <div className="space-y-3">
              {awayList.map((r) => (
                <Row key={`${r.player}-${r.team}-away`} r={r} />
              ))}
              {awayList.length === 0 && (
                <div className="text-sm text-gray-500">Nessun giocatore</div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
