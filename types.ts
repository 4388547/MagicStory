
export interface StoryMetadata {
  title: string;
  summary: string;
  visualStyle: string;
  characterDescription: string;
  sources?: string[];
}

export interface SubtitleLine {
  textEn: string;
  textZh: string;
  startTime: number;
  endTime: number;
}

export interface Scene {
  id: number;
  textEn: string;
  textZh: string;
  visualPrompt: string;
  voiceMood: string; // 'happy', 'sad', 'excited', 'calm'
  
  // Generation Status
  status: 'pending' | 'generating' | 'completed' | 'error';
  
  // Assets
  videoUrl?: string;
  audioUrl?: string; // Blob URL
  audioDuration?: number;
  subtitles?: SubtitleLine[];
}

export type Resolution = '720p' | '1080p';
export type AspectRatio = '16:9' | '9:16';

export interface VideoSettings {
  resolution: Resolution;
  aspectRatio: AspectRatio;
}

export interface AppState {
  step: 'input' | 'story-gen' | 'ref-image-gen' | 'video-gen' | 'finished';
  bookName: string;
  storyMetadata: StoryMetadata | null;
  scenes: Scene[];
  referenceImageUrl: string | null;
  logs: string[];
  videoSettings: VideoSettings;
}

export interface VeoReferenceImage {
  image: {
    imageBytes: string;
    mimeType: string;
  };
  referenceType: 'ASSET' | 'STYLE'; // Using simplified string types for internal logic
}
