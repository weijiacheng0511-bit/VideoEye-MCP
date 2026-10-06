export interface AnalyzeRequest {
  videoId: string;
  videoPath: string;
  question: string;
  startTime?: number;
  endTime?: number;
  previousContext?: unknown;
  onProgress?: (stage: "provider_upload" | "provider_inference" | "finalize") => void | Promise<void>;
}

export interface ObserverDialogue {
  speaker: string;
  text: string;
  tone?: string;
  uncertain?: boolean;
}

export interface ObserverTimelineEvent {
  timestamp: string;
  event: string;
  evidence?: "audio" | "visual" | "both" | "unknown";
  people?: string[];
  dialogue?: ObserverDialogue[];
  actions?: string[];
  visuals?: string[];
  screen_text?: string[];
  audio_events?: string[];
  entities?: string[];
}

export interface ObserverPerson {
  person_id: string;
  identity: string;
  identity_confidence: "high" | "medium" | "low";
  identity_evidence: string[];
  appearance: string;
}

export interface ObserverEntity {
  type: "person" | "brand" | "product" | "vehicle" | "location" | "software_ui" | "film_tv" | "organization" | "other";
  name: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

export interface VideoObservation {
  answer: string;
  observations: string[];
  timestamps: number[];
  provider: string;
  summary?: string;
  important_events?: ObserverTimelineEvent[];
  timeline?: ObserverTimelineEvent[];
  visual_description?: string;
  spoken_content_summary?: string;
  screen_text?: string[];
  visual_only_information?: string[];
  people_actions?: string[];
  uncertain_points?: string[];
  objective_observation_summary?: string;
  people?: ObserverPerson[];
  recognized_entities?: ObserverEntity[];
  uncertain_observations?: string[];
  model?: string;
  file_state?: string | null;
  gemini_file_name?: string | null;
  raw_provider_result?: unknown;
  provider_parse_warnings?: string[];
}

export interface VideoWorker {
  analyze(request: AnalyzeRequest): Promise<VideoObservation>;
}

export class MockVideoWorker implements VideoWorker {
  calls: AnalyzeRequest[] = [];
  async analyze(request: AnalyzeRequest): Promise<VideoObservation> {
    this.calls.push(request);
    await request.onProgress?.("provider_upload");
    await request.onProgress?.("provider_inference");
    await request.onProgress?.("finalize");
    return {
      answer: "MockVideoWorker 测试数据；未实际观察视频。",
      observations: ["MockVideoWorker 已收到视频路径和问题；无视频事实观察。"],
      timestamps: [], provider: "mock",
    };
  }
}
