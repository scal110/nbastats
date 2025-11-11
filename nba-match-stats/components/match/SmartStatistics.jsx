"use client";
import { useEffect, useMemo, useState } from "react";

/**
 * SmartStatistics (frontend-only logic + team modal)
 * - GET {apiBase}/stats?home=&away=&season=
 * - GET {apiBase}/team-defense?team=<ABBR>&season=&last_n=
 * Calcoli in frontend: under_pct, ratio, bounce per PTS/REB/AST
 */
export default function SmartStatistics({
  home,
  away,
  season = "2025-26",
  apiBase = "http://localhost:5000",
  lastN = 10,
}) {
  const [rows, setRows] = useState([]);
  const [homeDef, setHomeDef] = useState(null); // concessioni del team di CASA
  const [awayDef, setAwayDef] = useState(null); // concessioni del team di TRASFERTA
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Modal stato
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTeamName, setModalTeamName] = useState(null);
  const [modalTeamAbbr, setModalTeamAbbr] = useState(null);
  const [modalData, setModalData] = useState(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalErr, setModalErr] = useState(null);

  // ordinamenti/filtri
  const [sortBy, setSortBy] = useState("bounce"); // bounce|player|pts|reb|ast
  const [sortDir, setSortDir] = useState("desc");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("All");

  // mappa nomi completi -> abbreviazioni
  const TEAM_NAME_TO_ABBR = {
    "Atlanta Hawks": "ATL","Boston Celtics": "BOS","Brooklyn Nets": "BKN","Charlotte Hornets": "CHA",
    "Chicago Bulls": "CHI","Cleveland Cavaliers": "CLE","Dallas Mavericks": "DAL","Denver Nuggets": "DEN",
    "Detroit Pistons": "DET","Golden State Warriors": "GSW","Houston Rockets": "HOU","Indiana Pacers": "IND",
    "LA Clippers": "LAC","Los Angeles Lakers": "LAL","Memphis Grizzlies": "MEM","Miami Heat": "MIA",
    "Milwaukee Bucks": "MIL","Minnesota Timberwolves": "MIN","New Orleans Pelicans": "NOP","New York Knicks": "NYK",
    "Oklahoma City Thunder": "OKC","Orlando Magic": "ORL","Philadelphia 76ers": "PHI","Phoenix Suns": "PHX",
    "Portland Trail Blazers": "POR","Sacramento Kings": "SAC","San Antonio Spurs": "SAS","Toronto Raptors": "TOR",
    "Utah Jazz": "UTA","Washington Wizards": "WAS",
  };

  // ---- helpers ----
  const toBucket = (pos) => {
    const s = (pos || "").toUpperCase().split("-")[0];
    if (["PG","SG","G"].includes(s)) return "G";
    if (["SF","PF","F"].includes(s)) return "F";
    if (s === "C") return "C";
    return "OTHER";
  };
  const safeDiv = (a, b) => a / (Math.abs(b) > 1e-6 ? b : 1e-6);

  const statUnderPct = (player, key) => {
    const last = Number(player?.stats?.[key]?.value ?? 0);
    const avg5 = Number(player?.stats?.[key]?.last5_avg ?? 0);
    return safeDiv(last - avg5, avg5); // negativo se sotto
  };

  const statRatio = (defObj, bucket, key) => {
    // key: "pts_per_game" | "reb_per_game" | "ast_per_game"
    if (!defObj || !defObj.by_position_per_game) return 1.0;
    const bypos = defObj.by_position_per_game;
    const val = Number(bypos?.[bucket]?.[key] ?? 0);
    const vals = ["G","F","C","OTHER"].map(b => Number(bypos?.[b]?.[key] ?? 0)).filter(v => Number.isFinite(v));
    const meanAll = vals.length ? (vals.reduce((s,x)=>s+x,0) / vals.length) : 1.0;
    return safeDiv(val, meanAll); // >1 = matchup più morbido di media
  };

  const bounce = (underPct, ratio) => Math.max(0, -underPct) * Math.max(0, ratio - 1);

  // ---- fetch dati principali ----
  useEffect(() => {
    let abort = false;
    async function run() {
      setLoading(true); setErr(null);
      try {

         // 2) difese team (concessioni per ruolo)
        const homeAbbr = TEAM_NAME_TO_ABBR[home] || null;
        const awayAbbr = TEAM_NAME_TO_ABBR[away] || null;

        let defHomeTeam = null, defAwayTeam = null;
        if (homeAbbr) {
          const u = `/api/team-defense?team=${encodeURIComponent(homeAbbr)}&season=${encodeURIComponent(season)}&last_n=${encodeURIComponent(lastN)}`;
          const d = await fetch(u, { cache: "no-store" });
          if (!d.ok) throw new Error(`team-defense(home) HTTP ${d.status}`);
          defHomeTeam = await d.json();
        }
        if (abort) return;

        if (awayAbbr) {
          const u2 = `/api/team-defense?team=${encodeURIComponent(awayAbbr)}&season=${encodeURIComponent(season)}&last_n=${encodeURIComponent(lastN)}`;
          const d2 = await fetch(u2, { cache: "no-store" });
          if (!d2.ok) throw new Error(`team-defense(away) HTTP ${d2.status}`);
          defAwayTeam = await d2.json();
        }
        if (abort) return;

        setHomeDef(defHomeTeam);
        setAwayDef(defAwayTeam);

        // 1) giocatori
        let urlStats = `/api/stats?home=${encodeURIComponent(home||"")}&away=${encodeURIComponent(away||"")}&season=${encodeURIComponent(season)}`;
        let res = await fetch(urlStats, { cache: "no-store" });
        if (!res.ok) {
          // fallback in caso il backend ignori i parametri
          res = await fetch(`${apiBase}/stats`, { cache: "no-store" });
        }
        if (!res.ok) throw new Error(`stats HTTP ${res.status}`);
        const players = await res.json();
        if (abort) return;

       

        // 3) arricchisci i giocatori con under/ratio/bounce (opp = difesa dell’AVVERSARIO)
        const enriched = (Array.isArray(players) ? players : []).map(p => {
          const bucket = toBucket(p.position);
          const oppDef = p.side === "away" ? homeDef /* casa è il suo avversario */ : awayDef;
          // sopra usiamo state prefetch? meglio usare quelle appena fetchate:
          const opp = p.side === "away" ? defHomeTeam : defAwayTeam;

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

        if (!abort) setRows(enriched);
      } catch (e) {
        if (!abort) setErr(e.message || String(e));
      } finally {
        if (!abort) setLoading(false);
      }
    }
    run();
    return () => { abort = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, home, away, season, lastN]);

  // ---- UI helpers ----
  const roles = useMemo(() => {
    const s = new Set();
    rows.forEach(r => { const p=(r.position||"").trim(); if(p) s.add(p); });
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  const bounceAvg = (r) => {
    const b = r?.bounce_score || {};
    return (Number(b.PTS||0)+Number(b.REB||0)+Number(b.AST||0))/3;
  };
  const sortKey = (r) => {
    if (sortBy === "bounce") return bounceAvg(r);
    if (sortBy === "pts") return r?.stats?.PTS?.last5_avg ?? -Infinity;
    if (sortBy === "reb") return r?.stats?.REB?.last5_avg ?? -Infinity;
    if (sortBy === "ast") return r?.stats?.AST?.last5_avg ?? -Infinity;
    return (r.player||"").toLowerCase();
  };

  const filtered = useMemo(() => {
    const qq = (q||"").toLowerCase();
    let lst = rows.filter(r => {
      const name = (r.player||"").toLowerCase();
      const pos = (r.position||"").toLowerCase();
      const okQ = !qq || name.includes(qq);
      const okRole = roleFilter==="All" || roleFilter==="" || pos===roleFilter.toLowerCase();
      return okQ && okRole;
    });
    lst.sort((a,b) => {
      const va = sortKey(a), vb = sortKey(b);
      if (typeof va === "string") return sortDir==="asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      const na = Number.isFinite(va)?va:-Infinity, nb = Number.isFinite(vb)?vb:-Infinity;
      return sortDir==="asc" ? na-nb : nb-na;
    });
    return lst;
  }, [rows, q, roleFilter, sortBy, sortDir]);

  const homeList = useMemo(()=>filtered.filter(r=>r.side!=="away"), [filtered]);
  const awayList = useMemo(()=>filtered.filter(r=>r.side==="away"), [filtered]);

  const Pill = ({children, color="gray"}) => {
    const cls = color==="green" ? "bg-green-100 text-green-700" :
                color==="red"   ? "bg-red-100 text-red-700" :
                color==="amber" ? "bg-amber-100 text-amber-700" :
                                  "bg-slate-100 text-slate-700";
    return <span className={`text-[11px] px-1.5 py-0.5 rounded ${cls}`}>{children}</span>;
  };

  const UnderCell = ({label, s, up}) => {
    const val = s?.value ?? "—";
    const avg = s?.last5_avg ?? "—";
    const upPct = (typeof up==="number") ? (up*100) : 0;
    const col = (typeof up==="number" && up<0) ? "red" : (up>0 ? "green" : "gray");
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="text-sm font-medium">
          {val} <span className="text-xs text-gray-400">(5prev {avg})</span>
        </div>
        <Pill color={col}>under% {label}: {upPct.toFixed(0)}%</Pill>
      </div>
    );
  };

  const MatchupCell = ({label, val, ratio}) => {
    const r = Number(ratio||0);
    const col = r>1.1 ? "green" : r>1.0 ? "amber" : r<0.9 ? "red" : "gray";
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="text-sm font-medium">{val ?? "—"} <span className="text-xs text-gray-400">/g</span></div>
        <Pill color={col}>ratio {label}: {r.toFixed(2)}</Pill>
      </div>
    );
  };

  const BounceCell = ({label, r}) => {
    const b = Number(r?.bounce_score?.[label] ?? 0);
    const col = b>=0.6 ? "green" : b>=0.25 ? "amber" : "gray";
    return <Pill color={col}>bounce {label}: {b.toFixed(2)}</Pill>;
  };

  const Row = ({r}) => {
    return (
      <div className="flex items-center justify-between gap-3 p-3 border rounded-md hover:shadow-sm">
        <div className="flex items-baseline gap-3">
          <div className="font-medium">{r.player}</div>
          {r.position && <div className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{r.position}</div>}
          <div className="text-xs text-gray-500">ruolo: {r.role_bucket}</div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <div className="text-xs text-gray-500">MIN</div>
            <div className="text-sm font-medium">
              {r.stats?.MIN?.value ?? "—"} <span className="text-xs text-gray-400">({r.stats?.MIN?.last5_avg ?? "—"})</span>
            </div>
          </div>

          <div className="w-px h-8 bg-gray-200"/>

          <div className="flex gap-6 items-center">
            <div className="text-xs text-gray-500">PTS</div>
            <div className="flex flex-col items-end gap-1">
              <UnderCell label="PTS" s={r.stats?.PTS} up={r.under_pct?.PTS}/>
              <MatchupCell label="PTS" val={r.opp_role_allow?.PTS} ratio={r.opp_ratio?.PTS}/>
              <BounceCell label="PTS" r={r}/>
            </div>
          </div>

          <div className="flex gap-6 items-center">
            <div className="text-xs text-gray-500">REB</div>
            <div className="flex flex-col items-end gap-1">
              <UnderCell label="REB" s={r.stats?.REB} up={r.under_pct?.REB}/>
              <MatchupCell label="REB" val={r.opp_role_allow?.REB} ratio={r.opp_ratio?.REB}/>
              <BounceCell label="REB" r={r}/>
            </div>
          </div>

          <div className="flex gap-6 items-center">
            <div className="text-xs text-gray-500">AST</div>
            <div className="flex flex-col items-end gap-1">
              <UnderCell label="AST" s={r.stats?.AST} up={r.under_pct?.AST}/>
              <MatchupCell label="AST" val={r.opp_role_allow?.AST} ratio={r.opp_ratio?.AST}/>
              <BounceCell label="AST" r={r}/>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // shortlist in alto
  const summaryTop = useMemo(() => {
    const best = (key) => [...rows].sort((a,b)=>(b?.bounce_score?.[key]||0)-(a?.bounce_score?.[key]||0)).slice(0,4);
    return { PTS: best("PTS"), REB: best("REB"), AST: best("AST") };
  }, [rows]);

  // ----- Modal helpers -----
  const openTeamModal = async (teamName) => {
    if (!teamName) return;
    const abbr = TEAM_NAME_TO_ABBR[teamName] || null;
    setModalTeamName(teamName);
    setModalTeamAbbr(abbr);
    setModalOpen(true);
    setModalErr(null);

    // prova a riusare ciò che abbiamo già
    if (abbr && home && abbr === TEAM_NAME_TO_ABBR[home] && homeDef) {
      setModalData(homeDef);
      return;
    }
    if (abbr && away && abbr === TEAM_NAME_TO_ABBR[away] && awayDef) {
      setModalData(awayDef);
      return;
    }

    // altrimenti fetch al volo
    if (abbr) {
      try {
        setModalLoading(true);
        const u = `${apiBase}/team-defense?team=${encodeURIComponent(abbr)}&season=${encodeURIComponent(season)}&last_n=${encodeURIComponent(lastN)}`;
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        setModalData(json);
      } catch (e) {
        setModalErr(e.message || String(e));
      } finally {
        setModalLoading(false);
      }
    }
  };
  const closeModal = () => {
    setModalOpen(false);
    setModalTeamName(null);
    setModalTeamAbbr(null);
    setModalData(null);
    setModalErr(null);
    setModalLoading(false);
  };

  return (
    <div className="p-4">
      <div className="mb-3 rounded-md border p-3 bg-slate-50 text-sm text-slate-700">
        <div className="font-semibold mb-1">Come leggere</div>
        <div>• <b>under%</b> = (Ultima − media delle <i>precedenti</i> 5) / media. Negativo ⇒ è andato sotto.</div>
        <div>• <b>ratio</b> = concessioni dell’avversario per il tuo <i>ruolo</i> / media concessioni tra i ruoli dello stesso avversario. &gt;1 ⇒ matchup morbido.</div>
        <div>• <b>bounce</b> = max(0, −under) × max(0, ratio − 1) — alto se è appena andato sotto e il matchup è favorevole.</div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Cerca giocatore..." className="px-3 py-2 border rounded-md w-64"/>
        <select value={roleFilter} onChange={(e)=>setRoleFilter(e.target.value)} className="px-2 py-2 border rounded-md bg-white">
          {roles.map(r=><option key={r} value={r}>{r}</option>)}
        </select>
        <select value={sortBy} onChange={(e)=>setSortBy(e.target.value)} className="px-2 py-2 border rounded-md bg-white">
          <option value="bounce">Ordina: Bounce medio</option>
          <option value="player">Ordina: Giocatore</option>
          <option value="pts">Ordina: PTS (avg5prev)</option>
          <option value="reb">Ordina: REB (avg5prev)</option>
          <option value="ast">Ordina: AST (avg5prev)</option>
        </select>
        <button onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")} className="px-3 py-2 border rounded-md bg-white">
          {sortDir==="asc"?"↑ Asc":"↓ Desc"}
        </button>
        <button onClick={()=>window.location.reload()} disabled={loading} className="px-3 py-2 bg-sky-600 text-white rounded-md">
          {loading ? "Carico..." : "Refresh"}
        </button>
        {err && <div className="text-sm text-red-600 ml-2">Errore: {err}</div>}
      </div>

      {/* TOP LIST */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {["PTS","REB","AST"].map(k=>(
          <div key={k} className="bg-white shadow rounded-lg p-3">
            <div className="text-sm font-semibold mb-2">Top bounce {k}</div>
            {(summaryTop[k]||[]).map(p=>(
              <div key={p.player} className="text-sm flex items-center justify-between py-1 border-b last:border-0">
                <span className="truncate mr-2">{p.player} <span className="text-xs text-gray-500">({p.role_bucket})</span></span>
                <span className="text-xs">→ {Number(p?.bounce_score?.[k]||0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* GRIGLIA CASA / TRASFERTA con NOME TEAM e MODAL */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex flex-col">
              <h3 className="font-semibold text-slate-700">
                CASA — {home || "Team casa"}
              </h3>
              <button
                className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80"
                onClick={() => home && openTeamModal(home)}
                title="Mostra stats concesse per ruolo del team di CASA"
              >
                Vedi concessioni {home || "team casa"}
              </button>
              {away && (
                <button
                  className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80 mt-1"
                  onClick={() => away && openTeamModal(away)}
                  title="Mostra stats concesse per ruolo del team AVVERSARIO"
                >
                  Vedi concessioni avversario: {away}
                </button>
              )}
            </div>
            <div className="text-sm text-gray-500">{homeList.length} giocatori</div>
          </div>
          <div className="space-y-3">
            {homeList.map(r => <Row key={r.player} r={r}/>)}
            {homeList.length===0 && <div className="text-sm text-gray-500">Nessun giocatore</div>}
          </div>
        </section>

        <section className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex flex-col">
              <h3 className="font-semibold text-slate-700">
                TRASFERTA — {away || "Team trasferta"}
              </h3>
              <button
                className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80"
                onClick={() => away && openTeamModal(away)}
                title="Mostra stats concesse per ruolo del team di TRASFERTA"
              >
                Vedi concessioni {away || "team trasferta"}
              </button>
              {home && (
                <button
                  className="text-xs text-sky-600 underline underline-offset-2 text-left hover:opacity-80 mt-1"
                  onClick={() => home && openTeamModal(home)}
                  title="Mostra stats concesse per ruolo del team AVVERSARIO"
                >
                  Vedi concessioni avversario: {home}
                </button>
              )}
            </div>
            <div className="text-sm text-gray-500">{awayList.length} giocatori</div>
          </div>
          <div className="space-y-3">
            {awayList.map(r => <Row key={r.player} r={r}/>)}
            {awayList.length===0 && <div className="text-sm text-gray-500">Nessun giocatore</div>}
          </div>
        </section>
      </div>

      {/* MODAL */}
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
                    {["G","F","C","OTHER"].map((bucket) => {
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
