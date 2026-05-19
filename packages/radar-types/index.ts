export type RadarSource = "hn" | "arxiv" | "github" | "hf" | "reddit" | "rss";

export interface RadarMetrics {
  points?: number;
  stars?: number;
  forks?: number;
  likes?: number;
  downloads?: number;
  score?: number;
  comments?: number;
}

export interface RadarItem {
  id: string;
  source: RadarSource;
  source_id: string;
  title: string;
  url: string;
  canonical_url: string;
  summary?: string;
  author?: string;
  published_at: number;
  metrics?: RadarMetrics;
  tags?: string[];
}

export interface FetchResult {
  items: RadarItem[];
  fetched_at: number;
  source: string;
  error?: string;
}
