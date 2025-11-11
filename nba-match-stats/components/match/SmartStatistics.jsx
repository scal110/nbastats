"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  apiPath,
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
  const modalFetchController = useRef(null);

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

  const clamp01 = useCallback((value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)), []);

  const normalizedApiBase = useMemo(() => {
    if (!apiBase) return "";
    return apiBase.replace(/\/+$/, "");
  }, [apiBase]);

  const fetchJsonWithFallbacks = useCallback(async (candidates, init, label, signal) => {
    const seen = new Set();
    let lastErr = null;
    for (const raw of candidates) {
      if (!raw) continue;
      const url = raw.startsWith("http") || raw.startsWith("/") ? raw : `/${raw}`;
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const res = await fetch(url, { ...init, signal });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          lastErr = new Error(`${label} HTTP ${res.status}${detail ? ` – ${detail}` : ""}`);
          continue;
        }
        try {
          return await res.json();
        } catch (jsonErr) {
          lastErr = new Error(`${label} JSON error: ${jsonErr.message}`);
        }
      } catch (err) {
        if (err.name === "AbortError") throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error(`${label} nessuna risposta valida`);
  }, []);

  const defenseCandidatesFor = useCallback((abbr) => {
    if (!abbr) return [];
    const path = `team-defense?team=${encodeURIComponent(abbr)}&season=${encodeURIComponent(season)}&last_n=${encodeURIComponent(lastN)}`;
    const urls = [`/api/${path}`];
    if (normalizedApiBase) urls.push(`${normalizedApiBase}/${path}`);
    return urls;
  }, [normalizedApiBase, season, lastN]);

  // ---- fetch dati principali ----
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function run() {
      setLoading(true);
      setErr(null);
      try {
        const statsQuery = `stats?home=${encodeURIComponent(home || "")}&away=${encodeURIComponent(away || "")}&season=${encodeURIComponent(season)}`;
        const statsCandidates = [];
        if (apiPath) statsCandidates.push(apiPath);
        statsCandidates.push(`/api/${statsQuery}`);
        if (normalizedApiBase) statsCandidates.push(`${normalizedApiBase}/${statsQuery}`);

        // 2) difese team (concessioni per ruolo)
        const homeAbbr = TEAM_NAME_TO_ABBR[home] || null;
        const awayAbbr = TEAM_NAME_TO_ABBR[away] || null;

        let defHomeTeam = null, defAwayTeam = null;
        const [homeRes, awayRes] = await Promise.all([
          homeAbbr ? fetchJsonWithFallbacks(defenseCandidatesFor(homeAbbr), { cache: "no-store" }, `team-defense ${homeAbbr}`, controller.signal) : Promise.resolve(null),
          awayAbbr ? fetchJsonWithFallbacks(defenseCandidatesFor(awayAbbr), { cache: "no-store" }, `team-defense ${awayAbbr}`, controller.signal) : Promise.resolve(null),
        ]);

        if (!active) return;

        defHomeTeam = homeRes;
        defAwayTeam = awayRes;

        setHomeDef(defHomeTeam);
        setAwayDef(defAwayTeam);

        // 1) giocatori
        const players = await fetchJsonWithFallbacks(statsCandidates, { cache: "no-store" }, "stats", controller.signal);
        if (!active) return;

       

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

        if (active) setRows(enriched);
      } catch (e) {
        if (e.name === "AbortError") return;
        if (active) setErr(e.message || String(e));
      } finally {
        if (active) setLoading(false);
      }
    }
    run();
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, away, season, lastN, apiPath, normalizedApiBase, fetchJsonWithFallbacks, defenseCandidatesFor]);

  // ---- UI helpers ----
  const roles = useMemo(() => {
    const s = new Set();
    rows.forEach(r => { const p=(r.position||"").trim(); if(p) s.add(p); });
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  const rowsWithWeights = useMemo(() =>
    rows.map(row => ({
      ...row,
      weighted_bounce: weightedBounceScore(row),
    })),
  [rows, weightedBounceScore]);

  const weightedBounceScore = useCallback((r) => {
    const bounceScores = r?.bounce_score || {};
    const minutes = Number(r?.stats?.MIN?.last5_avg ?? 0);
    const minuteWeight = clamp01(minutes / 32);
    const labels = ["PTS", "REB", "AST"];

    let totalWeight = 0;
    let weightedSum = 0;

    labels.forEach((label) => {
      const bounceVal = Number(bounceScores?.[label] ?? 0);
      const recentAvg = Number(r?.stats?.[label]?.last5_avg ?? 0);
      const threshold = label === "PTS" ? 18 : label === "REB" ? 8 : 7;
      const productionWeight = clamp01(recentAvg / threshold);
      const componentWeight = 0.35 + 0.65 * ((minuteWeight + productionWeight) / 2);
      totalWeight += componentWeight;
      weightedSum += bounceVal * componentWeight;
    });

    const reliabilityBoost = 0.4 + 0.6 * minuteWeight;
    const base = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return base * reliabilityBoost;
  }, [clamp01]);
  const sortKey = useCallback((r) => {
    if (sortBy === "bounce") return r?.weighted_bounce ?? weightedBounceScore(r);
    if (sortBy === "pts") return r?.stats?.PTS?.last5_avg ?? -Infinity;
    if (sortBy === "reb") return r?.stats?.REB?.last5_avg ?? -Infinity;
    if (sortBy === "ast") return r?.stats?.AST?.last5_avg ?? -Infinity;
    return (r.player||"").toLowerCase();
  }, [sortBy, weightedBounceScore]);

  const filtered = useMemo(() => {
    const qq = (q||"").toLowerCase();
    let lst = rowsWithWeights.filter(r => {
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
  }, [rowsWithWeights, q, roleFilter, sortDir, sortKey]);

  const homeList = useMemo(()=>filtered.filter(r=>r.side!=="away"), [filtered]);
  const awayList = useMemo(()=>filtered.filter(r=>r.side==="away"), [filtered]);

  const Pill = ({children, color="gray"}) => {
    const cls = color==="green" ? "bg-green-100 text-green-700" :
                color==="red"   ? "bg-rose-100 text-rose-700" :
                color==="amber" ? "bg-amber-100 text-amber-700" :
                                  "bg-slate-100 text-slate-700";
    return <span className={`text-[11px] px-1.5 py-0.5 rounded ${cls}`}>{children}</span>;
  };

  const MetricGauge = ({intensity = 0, tone = "gray", className = ""}) => {
    const gradients = {
      green: "from-emerald-400 via-emerald-500 to-emerald-600",
      red: "from-rose-400 via-rose-500 to-rose-600",
      amber: "from-amber-300 via-amber-400 to-amber-500",
      gray: "from-slate-300 via-slate-400 to-slate-500",
    };
    const pct = clamp01(intensity) * 100;
    const gradient = gradients[tone] || gradients.gray;
    const widthClass = className && /w-/.test(className) ? className : `w-28 ${className}`.trim();
    return (
      <div className={`${widthClass} h-1.5 rounded-full bg-slate-200/70 overflow-hidden`}>
        <div
          className={`h-full bg-gradient-to-r ${gradient}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  };

  const UnderCell = ({label, s, up}) => {
    const val = s?.value ?? "—";
    const avg = s?.last5_avg ?? "—";
    const upPct = (typeof up==="number") ? (up*100) : 0;
    const col = (typeof up==="number" && up<0) ? "red" : (up>0 ? "green" : "gray");
    const gaugeIntensity = Math.min(1, Math.abs(upPct) / 40);
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="text-sm font-medium">
          {val} <span className="text-xs text-gray-400">(5prev {avg})</span>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <Pill color={col}>under% {label}: {upPct.toFixed(0)}%</Pill>
          <MetricGauge intensity={gaugeIntensity} tone={col} />
        </div>
      </div>
    );
  };

  const MatchupCell = ({label, val, ratio}) => {
    const r = Number(ratio||0);
    const col = r>1.1 ? "green" : r>1.0 ? "amber" : r<0.9 ? "red" : "gray";
    const gaugeIntensity = Math.min(1, Math.abs(r-1) / 0.35);
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="text-sm font-medium">{val ?? "—"} <span className="text-xs text-gray-400">/g</span></div>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <Pill color={col}>ratio {label}: {r.toFixed(2)}</Pill>
          <MetricGauge intensity={gaugeIntensity} tone={col} />
        </div>
      </div>
    );
  };

  const BounceCell = ({label, r}) => {
    const b = Number(r?.bounce_score?.[label] ?? 0);
    const col = b>=0.6 ? "green" : b>=0.25 ? "amber" : "gray";
    const gaugeIntensity = Math.min(1, b / 1.1);
    return (
      <div className="flex flex-col items-end gap-0.5 text-right">
        <Pill color={col}>bounce {label}: {b.toFixed(2)}</Pill>
        <MetricGauge intensity={gaugeIntensity} tone={col} />
      </div>
    );
  };

  const Row = ({r}) => {
    const weighted = r?.weighted_bounce ?? weightedBounceScore(r);
    const totalTone = weighted>=0.55 ? "green" : weighted>=0.25 ? "amber" : "gray";
    const totalIntensity = Math.min(1, weighted / 1.2);
    return (
      <div className="flex flex-col gap-3 p-3 border rounded-md hover:shadow-sm">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div className="font-medium">{r.player}</div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            {r.position && <div className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{r.position}</div>}
            <div>ruolo: {r.role_bucket}</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span className="uppercase tracking-wide">Bounce ponderato</span>
            <div className="flex flex-col items-end">
              <span className="text-sm font-semibold text-slate-800">{weighted.toFixed(2)}</span>
              <MetricGauge intensity={totalIntensity} tone={totalTone} className="w-32" />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6 overflow-x-auto">
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
    const best = (key) => {
      const sorted = [...rowsWithWeights];
      sorted.sort((a, b) => {
        const bounceDiff = Number(b?.bounce_score?.[key] ?? 0) - Number(a?.bounce_score?.[key] ?? 0);
        if (Math.abs(bounceDiff) > 1e-4) return bounceDiff;
        const wb = Number(b?.weighted_bounce ?? weightedBounceScore(b));
        const wa = Number(a?.weighted_bounce ?? weightedBounceScore(a));
        return wb - wa;
      });
      return sorted.slice(0, 4);
    };
    return { PTS: best("PTS"), REB: best("REB"), AST: best("AST") };
  }, [rowsWithWeights, weightedBounceScore]);

  // ----- Modal helpers -----
  const openTeamModal = async (teamName) => {
    if (!teamName) return;
    const abbr = TEAM_NAME_TO_ABBR[teamName] || null;
    modalFetchController.current?.abort();
    modalFetchController.current = null;
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
      const ctrl = new AbortController();
      try {
        modalFetchController.current = ctrl;
        setModalLoading(true);
        const json = await fetchJsonWithFallbacks(
          defenseCandidatesFor(abbr),
          { cache: "no-store" },
          `team-defense ${abbr}`,
          ctrl.signal
        );
        if (ctrl.signal.aborted) return;
        setModalData(json);
      } catch (e) {
        if (e.name === "AbortError") return;
        setModalErr(e.message || String(e));
      } finally {
        if (modalFetchController.current === ctrl) {
          modalFetchController.current = null;
          if (!ctrl.signal.aborted) {
            setModalLoading(false);
          }
        }
      }
    }
  };
  const closeModal = () => {
    modalFetchController.current?.abort();
    modalFetchController.current = null;
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
            {(summaryTop[k]||[]).map(p=>{
              const bounceVal = Number(p?.bounce_score?.[k] ?? 0);
              const tone = bounceVal>=0.6 ? "green" : bounceVal>=0.25 ? "amber" : "gray";
              const weighted = p?.weighted_bounce ?? weightedBounceScore(p);
              return (
                <div key={`${p.player}-${k}`} className="text-sm flex flex-col gap-1 py-2 border-b last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-slate-800">{p.player} <span className="text-xs text-gray-500">({p.role_bucket})</span></span>
                    <span className="text-xs uppercase text-slate-500">Bounce {k}: <strong className="text-slate-700">{bounceVal.toFixed(2)}</strong></span>
                  </div>
                  <MetricGauge intensity={Math.min(1, bounceVal / 1.1)} tone={tone} className="w-full" />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    <span>Ultima: {p?.stats?.[k]?.value ?? "—"}</span>
                    <span>Media 5: {p?.stats?.[k]?.last5_avg ?? "—"}</span>
                    <span>Min 5: {p?.stats?.MIN?.last5_avg ?? "—"}</span>
                    <span className="uppercase tracking-wide">Ponderato: {weighted.toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
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
