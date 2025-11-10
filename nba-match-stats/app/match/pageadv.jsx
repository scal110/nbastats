"use client";
import { useSearchParams } from "next/navigation";
import SmartStatistics from "@/components/match/SmartStatistics";

export default function MatchPage() {
  const search = useSearchParams();
  const home = decodeURIComponent(search.get("home") || "");
  const away = decodeURIComponent(search.get("away") || "");

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-4">
        Match: {away} @ {home}
      </h1>
      <SmartStatistics apiBase="http://localhost:5000" home={home} away={away} />
    </main>
  );
}
