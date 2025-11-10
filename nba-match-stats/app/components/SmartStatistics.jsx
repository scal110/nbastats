"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  "Los Angeles Clippers": "LAC",
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

const toBucket = (pos) => {
  const s = (pos || "").toUpperCase().split("-")[0];
  if (["PG", "SG", "G"].includes(s)) return "G";
  if (["SF", "PF", "F"].includes(s)) return "F";
  if (s === "C") return "C";
  return "OTHER";
};

const safeDiv = (a, b) => a / (Math.abs(b) > 1e-6 ? b : 1e-6);

const abortError = (message = "Aborted") => {
  if (typeof DOMException === "function") {
    try {
      return new DOMException(message, "AbortError");
    } catch (err) {
      const fallback = new Error(message);
      fallback.name = "AbortError";
      return fallback;
    }
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
};

const fetchWithTimeout = (url, { ms = 25000, signal } = {}) => {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => {
    ctrl.abort(abortError("Timeout"));
  }, ms);

  let abortHandler;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      const reason = signal.reason || abortError();
      return Promise.reject(reason);
    }
    abortHandler = () => {
      const reason = signal.reason || abortError();
      ctrl.abort(reason);
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  };

  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(cleanup);
};

const fetchJSON = async (url, { attempts = 3, ms = 25000, signal } = {}) => {
  let wait = 700;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetchWithTimeout(url, { ms, signal });
      if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
      return await response.json();
    } catch (e) {
      if (signal?.aborted || e.name === "AbortError") throw e;
      if (i === attempts - 1) throw e;
      await new Promise((res) => setTimeout(res, wait));
      wait *= 1.6;
    }
  }
};

export default function SmartStatistics({
  home,
  away,
  season = "2025-26",
  apiBase = "/api",
  lastN = 10,
}) {
  const [rows, setRows] = useState([]);
  const [homeDef, setHomeDef] = useState(null);
  const [awayDef, setAwayDef] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [retryToken, setRetryToken] = useState(0);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTeamName, setModalTeamName] = useState(null);
  const [modalTeamAbbr, setModalTeamAbbr] = useState(null);
  const [modalData, setModalData] = useState(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalErr, setModalErr] = useState(null);
  const modalAbortRef = useRef(null);

  const abortModalFetch = () => {
    if (modalAbortRef.current) {
      modalAbortRef.current.abort();
      modalAbortRef.current = null;
    }
  };

  // sort/filtri
  const [sortBy, setSortBy] = useState("bounce");
  const [sortDir, setSortDir] = useState("desc");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("All");

  const fetchKey = useMemo(
    () => JSON.stringify({ apiBase, home, away, season, lastN, retryToken }),
    [apiBase, home, away, season, lastN, retryToken]
  );

  const lastSuccessfulKeyRef = useRef(null);
  const isFetchingRef = useRef(false);

  const statUnderPct = (player, key) => {
    const last = Number(player?.stats?.[key]?.value ?? 0);
    const avg5 = Number(player?.stats?.[key]?.last5_avg ?? 0);
    return safeDiv(last - avg5, avg5);
  };

  const statRatio = (defObj, bucket, key) => {
    if (!defObj || !defObj.by_position_per_game) return 1.0;
    const bypos = defObj.by_position_per_game;
    const val = Number(bypos?.[bucket]?.[key] ?? 0);
    const vals = ["G", "F", "C", "OTHER"]
      .map((b) => Number(bypos?.[b]?.[key] ?? 0))
      .filter((v) => Number.isFinite(v));
    const meanAll = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 1.0;
    return safeDiv(val, meanAll);
  };

  const bounce = (underPct, ratio) => Math.max(0, -underPct) * Math.max(0, ratio - 1);

  useEffect(() => {
    if (!home || !away) {
      setRows([]);
      setHomeDef(null);
      setAwayDef(null);
      setErr(null);
      setLoading(false);
      isFetchingRef.current = false;
      lastSuccessfulKeyRef.current = null;
      return;
    }

    if (isFetchingRef.current) return;
    if (lastSuccessfulKeyRef.current === fetchKey) return;

    const abortCtrl = new AbortController();
    let active = true;

    isFetchingRef.current = true;
    setLoading(true);
    setErr(null);

    (async () => {
      try {
        const urlStats = `${apiBase}/stats?home=${encodeURIComponent(home)}&away=${encodeURIComponent(
          away
        )}&season=${encodeURIComponent(season)}`;
        const homeAbbr = TEAM_NAME_TO_ABBR[home] || null;
        const awayAbbr = TEAM_NAME_TO_ABBR[away] || null;

        const statsPromise = fetchJSON(urlStats, {
          attempts: 3,
          ms: 25000,
          signal: abortCtrl.signal,
        });
        const homeDefPromise = homeAbbr
          ? fetchJSON(
              `${apiBase}/team-defense?team=${encodeURIComponent(homeAbbr)}&season=${encodeURIComponent(
                season
              )}&last_n=${encodeURIComponent(lastN ?? "")}&ttl_hours=20`,
              { attempts: 2, ms: 25000, signal: abortCtrl.signal }
            )
          : Promise.resolve(null);
        const awayDefPromise = awayAbbr
          ? fetchJSON(
              `${apiBase}/team-defense?team=${encodeURIComponent(awayAbbr)}&season=${encodeURIComponent(
                season
              )}&last_n=${encodeURIComponent(lastN ?? "")}&ttl_hours=20`,
              { attempts: 2, ms: 25000, signal: abortCtrl.signal }
            )
          : Promise.resolve(null);

        const [statsRes, homeDefRes, awayDefRes] = await Promise.allSettled([
          statsPromise,
          homeDefPromise,
          awayDefPromise,
        ]);

        if (!active) return;

        if (statsRes.status !== "fulfilled") {
          throw statsRes.reason || new Error("stats failed");
        }

        const players = Array.isArray(statsRes.value) ? statsRes.value : [];
        const _homeDef = homeDefRes.status === "fulfilled" ? homeDefRes.value : null;
        const _awayDef = awayDefRes.status === "fulfilled" ? awayDefRes.value : null;

        const enriched = players.map((p) => {
          const bucket = toBucket(p.position);
          const opp = p.side === "away" ? _homeDef : _awayDef;

          const up_pts = statUnderPct(p, "PTS");
          const up_reb = statUnderPct(p, "REB");
          const up_ast = statUnderPct(p, "AST");

          const r_pts = statRatio(opp, bucket, "pts_per_game");
          const r_reb = statRatio(opp, bucket, "reb_per_game");
          const r_ast = statRatio(opp, bucket, "ast_per_game");

          const b_pts = bounce(up_pts, r_pts);
          const b_reb = bounce(up_reb, r_reb);
          const b_ast = bounce(up_ast, r_ast);

          const opp_bucket = opp?.by_position_per_game?.[bucket] || {};
          return {
            ...p,
            role_bucket: bucket,
            under_pct: { PTS: up_pts, REB: up_reb, AST: up_ast },
            opp_role_allow: {
              PTS: opp_bucket.pts_per_game ?? null,
              REB: opp_bucket.reb_per_game ?? null,
              AST: opp_bucket.ast_per_game ?? null,
            },
            opp_ratio: { PTS: r_pts, REB: r_reb, AST: r_ast },
            bounce_score: { PTS: b_pts, REB: b_reb, AST: b_ast },
          };
        });

        setRows(enriched);
        setHomeDef(_homeDef);
        setAwayDef(_awayDef);
        lastSuccessfulKeyRef.current = fetchKey;
      } catch (e) {
        if (!active) return;
        setErr(e?.message || String(e));
        setRows([]);
        setHomeDef(null);
        setAwayDef(null);
      } finally {
        if (!active) return;
        setLoading(false);
        isFetchingRef.current = false;
      }
    })();

    return () => {
      active = false;
      abortCtrl.abort();
      isFetchingRef.current = false;
    };
  }, [fetchKey, home, away]);

  const roles = useMemo(() => {
    const s = new Set();
    rows.forEach((r) => {
      const p = (r.position || "").trim();
      if (p) s.add(p);
    });
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  const bounceAvg = (r) => {
    const b = r?.bounce_score || {};
    return (Number(b.PTS || 0) + Number(b.REB || 0) + Number(b.AST || 0)) / 3;
  };

  const sortKey = (r) => {
    if (sortBy === "bounce") return bounceAvg(r);
    if (sortBy === "pts") return r?.stats?.PTS?.last5_avg ?? -Infinity;
    if (sortBy === "reb") return r?.stats?.REB?.last5_avg ?? -Infinity;
    if (sortBy === "ast") return r?.stats?.AST?.last5_avg ?? -Infinity;
    return (r.player || "").toLowerCase();
  };

  const filtered = useMemo(() => {
    const qq = (q || "").toLowerCase();
    const targetRole = (roleFilter || "").toLowerCase();
    let lst = rows.filter((r) => {
      const name = (r.player || "").toLowerCase();
      const pos = (r.position || "").toLowerCase();
      const okQ = !qq || name.includes(qq);
      const okRole = targetRole === "all" || targetRole === "" || pos === targetRole;
      return okQ && okRole;
    });
    lst.sort((a, b) => {
      const va = sortKey(a);
      const vb = sortKey(b);
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      const na = Number.isFinite(va) ? va : -Infinity;
      const nb = Number.isFinite(vb) ? vb : -Infinity;
      return sortDir === "asc" ? na - nb : nb - na;
    });
    return lst;
  }, [q, roleFilter, rows, sortBy, sortDir]);

  const homeList = useMemo(() => filtered.filter((r) => r.side !== "away"), [filtered]);
  const awayList = useMemo(() => filtered.filter((r) => r.side === "away"), [filtered]);

  const Pill = ({ children, color = "gray" }) => {
    const cls =
      color === "green"
        ? "bg-green-100 text-green-700"
        : color === "red"
        ? "bg-red-100 text-red-700"
        : color === "amber"
        ? "bg-amber-100 text-amber-700"
        : "bg-slate-100 text-slate-700";
    return <span className={`text-[11px] px-1.5 py-0.5 rounded ${cls}`}>{children}</span>;
  };

  const UnderCell = ({ label, s, up }) => {
    const val = s?.value ?? "—";
    const avg = s?.last5_avg ?? "—";
    const upPct = typeof up === "number" ? up * 100 : 0;
    const col = typeof up === "number" && up < 0 ? "red" : up > 0 ? "green" : "gray";
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="text-sm font-medium">
          {val} <span className="text-xs text-gray-400">(5prev {avg})</span>
        </div>
        <Pill color={col}>under% {label}: {upPct.toFixed(0)}%</Pill>
      </div>
    );
  };

  const MatchupCell = ({ label, val, ratio }) => {
    const r = Number(ratio || 0);
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
    const b = Number(r?.bounce_score?.[label] ?? 0);
    const col = b >= 0.6 ? "green" : b >= 0.25 ? "amber" : "gray";
    return <Pill color={col}>bounce {label}: {b.toFixed(2)}</Pill>;
  };

  const Row = ({ r }) => {
    return (
      <div className="flex items-center justify-between gap-3 p-3 border rounded-md hover:shadow-sm">
        <div className="flex items-baseline gap-3">
          <div className="font-medium">{r.player}</div>
          {r.position && (
            <div className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{r.position}</div>
          )}
          <div className="text-xs text-gray-500">ruolo: {r.role_bucket}</div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <div className="text-xs text-gray-500">MIN</div>
            <div className="text-sm font-medium">
              {r.stats?.MIN?.value ?? "—"}{" "}
              <span className="text-xs text-gray-400">({r.stats?.MIN?.last5_avg ?? "—"})</span>
            </div>
          </div>

          <div className="w-px h-8 bg-gray-200" />

          {["PTS", "REB", "AST"].map((label) => (
            <div key={label} className="flex gap-6 items-center">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="flex flex-col items-end gap-1">
                <UnderCell label={label} s={r.stats?.[label]} up={r.under_pct?.[label]} />
                <MatchupCell label={label} val={r.opp_role_allow?.[label]} ratio={r.opp_ratio?.[label]} />
                <BounceCell label={label} r={r} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const summaryTop = useMemo(() => {
    const best = (key) =>
      [...rows]
        .sort((a, b) => (b?.bounce_score?.[key] || 0) - (a?.bounce_score?.[key] || 0))
        .slice(0, 4);
    return { PTS: best("PTS"), REB: best("REB"), AST: best("AST") };
  }, [rows]);

  const openTeamModal = async (teamName) => {
    if (!teamName) return;
    const ABBR = TEAM_NAME_TO_ABBR[teamName] || null;
    setModalTeamName(teamName);
    setModalTeamAbbr(ABBR);
    setModalOpen(true);
    setModalErr(null);

    if (!ABBR) {
      setModalData(null);
      return;
    }

    try {
      setModalLoading(true);
      abortModalFetch();
      const ctrl = new AbortController();
      modalAbortRef.current = ctrl;
      const url = `${apiBase}/team-defense?team=${encodeURIComponent(ABBR)}&season=${encodeURIComponent(
        season
      )}&last_n=${encodeURIComponent(lastN ?? "")}&ttl_hours=20`;
      const json = await fetchJSON(url, { attempts: 2, ms: 25000, signal: ctrl.signal });
      setModalData(json);
    } catch (e) {
      if (e?.name !== "AbortError") {
        setModalErr(e?.message || String(e));
        setModalData(null);
      }
    } finally {
      setModalLoading(false);
      modalAbortRef.current = null;
    }
  };

  const closeModal = () => {
    abortModalFetch();
    setModalOpen(false);
    setModalTeamName(null);
    setModalTeamAbbr(null);
    setModalData(null);
    setModalErr(null);
    setModalLoading(false);
  };

  useEffect(() => () => abortModalFetch(), []);

  return (
    <div className="p-4">
      <div className="mb-3 rounded-md border p-3 bg-slate-50 text-sm text-slate-700">
        <div className="font-semibold mb-1">Come leggere</div>
        <div>
          • <b>under%</b> = (Ultima − media delle <i>precedenti</i> 5) / media. Negativo ⇒ è andato sotto.
        </div>
        <div>
          • <b>ratio</b> = concessioni dell’avversario per il tuo <i>ruolo</i> / media concessioni tra i ruoli dello
          stesso avversario. &gt;1 ⇒ matchup morbido.
        </div>
        <div>• <b>bounce</b> = max(0, −under) × max(0, ratio − 1).</div>
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
          onClick={() => {
            lastSuccessfulKeyRef.current = null;
            setRows([]);
            setHomeDef(null);
            setAwayDef(null);
            setErr(null);
            setRetryToken((t) => t + 1);
          }}
          disabled={loading}
          className="px-3 py-2 bg-sky-600 text-white rounded-md"
        >
          {loading ? "Carico..." : "Riprova"}
        </button>
        {err && <div className="text-sm text-red-600 ml-2">Errore: {err}</div>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {["PTS", "REB", "AST"].map((k) => (
          <div key={k} className="bg-white shadow rounded-lg p-3">
            <div className="text-sm font-semibold mb-2">Top bounce {k}</div>
            {(summaryTop[k] || []).map((p) => (
              <div key={p.player} className="text-sm flex items-center justify-between py-1 border-b last:border-0">
                <span className="truncate mr-2">
                  {p.player} <span className="text-xs text-gray-500">({p.role_bucket})</span>
                </span>
                <span className="text-xs">→ {Number(p?.bounce_score?.[k] || 0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex flex-col">
              <h3 className="font-semibold text-slate-700">CASA — {home || "Team casa"}</h3>
              <button
                className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80"
                onClick={() => home && openTeamModal(home)}
                title="Mostra concessioni per ruolo del team di CASA"
              >
                Vedi concessioni {home || "team casa"}
              </button>
              {away && (
                <button
                  className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80 mt-1"
                  onClick={() => away && openTeamModal(away)}
                  title="Mostra concessioni del team AVVERSARIO"
                >
                  Vedi concessioni avversario: {away}
                </button>
              )}
            </div>
            <div className="text-sm text-gray-500">{homeList.length} giocatori</div>
          </div>
          <div className="space-y-3">
            {homeList.map((r) => (
              <Row key={r.player} r={r} />
            ))}
            {homeList.length === 0 && <div className="text-sm text-gray-500">Nessun giocatore</div>}
          </div>
        </section>

        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex flex-col">
              <h3 className="font-semibold text-slate-700">TRASFERTA — {away || "Team trasferta"}</h3>
              <button
                className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80"
                onClick={() => away && openTeamModal(away)}
                title="Mostra concessioni per ruolo del team di TRASFERTA"
              >
                Vedi concessioni {away || "team trasferta"}
              </button>
              {home && (
                <button
                  className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80 mt-1"
                  onClick={() => home && openTeamModal(home)}
                  title="Mostra concessioni del team AVVERSARIO"
                >
                  Vedi concessioni avversario: {home}
                </button>
              )}
            </div>
            <div className="text-sm text-gray-500">{awayList.length} giocatori</div>
          </div>
          <div className="space-y-3">
            {awayList.map((r) => (
              <Row key={r.player} r={r} />
            ))}
            {awayList.length === 0 && <div className="text-sm text-gray-500">Nessun giocatore</div>}
          </div>
        </section>
      </div>

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
              <button onClick={closeModal} className="px-2 py-1 text-sm border rounded hover:bg-gray-50">
                Chiudi
              </button>
            </div>

            {modalLoading && <div className="text-sm text-gray-600">Caricamento…</div>}
            {modalErr && <div className="text-sm text-red-600">Errore: {modalErr}</div>}

            {!modalLoading && !modalErr && modalData?.by_position_per_game && (
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
                    {["G", "F", "C", "OTHER"].map((bucket) => {
                      const row = modalData.by_position_per_game[bucket];
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
