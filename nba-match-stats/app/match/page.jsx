"use client";
import { useSearchParams } from "next/navigation";
import Statistics from "../../components/match/Statistics";
import StatisticsAdv from "@/components/match/StatisticsAdv";
import SmartStatistics from "@/components/match/SmartStatistics";
import StatisticsBounce from "@/components/match/StatisticsBounce";

export default function MatchDetailPage() {
  const search = useSearchParams();
  const home = search.get("home") || "";
  const away = search.get("away") || "";

  // decodifica (erano encodeURIComponent)
  const homeDecoded = decodeURIComponent(home);
  const awayDecoded = decodeURIComponent(away);

  // costruisci apiPath con query string
  const apiPath = `/api/stats?home=${encodeURIComponent(homeDecoded)}&away=${encodeURIComponent(awayDecoded)}`;

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-4">Match: {awayDecoded} @ {homeDecoded}</h1>
      <SmartStatistics apiPath={apiPath} home={homeDecoded} away={awayDecoded} />
    </main>
  );
}
