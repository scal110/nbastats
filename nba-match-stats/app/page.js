"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function MatchesPage() {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const router = useRouter();

  const fetchMatches = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/matches");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setMatches(Array.isArray(json) ? json : []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMatches();
  }, []);

  const openMatch = (m) => {
    // per sicurezza encodeURIComponent per team names
    const home = encodeURIComponent(m.home_team);
    const away = encodeURIComponent(m.away_team);
    // url di destinazione (usa la pagina match che vedremo)
    router.push(`/match?home=${home}&away=${away}`);
  };

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-4">Match di oggi</h1>
      <div className="mb-4">
        <button onClick={fetchMatches} className="px-3 py-1 bg-sky-600 text-white rounded">
          Aggiorna lista
        </button>
      </div>

      {loading && <div>Caricamento match…</div>}
      {error && <div className="text-red-600">Errore: {error}</div>}

      {!loading && matches.length === 0 && <div>Nessun match trovato oggi.</div>}

      <div className="grid gap-3">
        {matches.map((m) => (
          <div key={m.gameId} className="p-3 border rounded hover:shadow cursor-pointer" onClick={() => openMatch(m)}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{m.away_team} @ {m.home_team}</div>
                <div className="text-sm text-gray-500">Start (EST): {m.start_time_est}</div>
              </div>
              <div className="text-sm text-sky-600">Apri →</div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
